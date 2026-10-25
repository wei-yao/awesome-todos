import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import { createServer } from "node:http";
import * as client from "openid-client";
import { PGlite } from "@electric-sql/pglite";
import { createApp, validState } from "./server.mjs";
import { createPostgresStore } from "./store.mjs";

const state = () => ({
  tasks: [{ id: "task", text: "Task", done: false, notes: "Task notes",
    steps: [{ id: "step", text: "Step", done: false, notes: "Step details" }] }],
  history: [], mode: "task", label: "", selectedTask: "task", selectedStep: "step",
  duration: 25, timer: null
});

async function database()
{
  const db = new PGlite();
  const pool = {
    on() {},
    async query(sql, params)
    {
      if (sql.includes("CREATE TABLE"))
      {
        await db.exec(sql);
        return { rows: [], rowCount: 0 };
      }
      const result = await db.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    end: () => db.close()
  };
  return createPostgresStore("", pool);
}

async function provider()
{
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const wrongKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const publicKey = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "ES256", use: "sig" };
  const codes = new Map();
  const clientId = "local-test-client";
  const secret = "only-for-local-oidc-tests";
  let issuer;
  let nextMode = "owner";
  let tokenRequests = 0;
  let lastChecks;
  const app = createServer(async (request, response) =>
  {
    const url = new URL(request.url, issuer);
    if (url.pathname === "/authorize")
    {
      const code = randomUUID();
      codes.set(code, {
        mode: nextMode,
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        redirect: url.searchParams.get("redirect_uri")
      });
      nextMode = "owner";
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", code);
      callback.searchParams.set("iss", issuer);
      response.writeHead(302, { Location: callback.href });
      response.end();
    }
    else if (url.pathname === "/jwks")
    {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ keys: [publicKey] }));
    }
    else if (url.pathname === "/token")
    {
      tokenRequests++;
      const chunks = [];
      for await (const chunk of request)
      {
        chunks.push(chunk);
      }
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      const flow = codes.get(params.get("code"));
      codes.delete(params.get("code"));
      const challenge = createHash("sha256").update(params.get("code_verifier") || "").digest("base64url");
      const basic = Buffer.from(request.headers.authorization?.split(" ")[1] || "", "base64").toString()
        .split(":").map((part) => decodeURIComponent(part.replaceAll("+", " ")));
      const clientAuthenticated = request.headers.authorization?.startsWith("Basic ") && basic[0] === clientId && basic[1] === secret;
      lastChecks = {
        codeFound: Boolean(flow),
        clientAuthenticated,
        redirectMatches: params.get("redirect_uri") === flow?.redirect,
        grantMatches: params.get("grant_type") === "authorization_code",
        pkceMatches: flow?.challenge === challenge,
        clientName: basic[0],
        secretMatches: basic[1] === secret
      };
      if (!flow || !clientAuthenticated
        || params.get("redirect_uri") !== flow.redirect || params.get("grant_type") !== "authorization_code"
        || flow.challenge !== challenge || flow.mode === "bad-pkce")
      {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: flow.mode === "bad-issuer" ? issuer + "/other" : issuer,
        sub: flow.mode === "other-user" ? "another-user" : "owner-user",
        aud: flow.mode === "bad-audience" ? "another-client" : clientId,
        iat: now,
        exp: flow.mode === "expired" ? now - 600 : now + 300,
        nonce: flow.mode === "bad-nonce" ? "another-nonce" : flow.nonce
      };
      const input = [
        Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-key", typ: "JWT" })).toString("base64url"),
        Buffer.from(JSON.stringify(claims)).toString("base64url")
      ].join(".");
      const signature = sign("sha256", Buffer.from(input), {
        key: flow.mode === "bad-signature" ? wrongKey : keys.privateKey,
        dsaEncoding: "ieee-p1363"
      }).toString("base64url");
      const tokens = { access_token: "local-test-access-token", token_type: "Bearer", expires_in: 300 };
      if (flow.mode !== "missing-id-token")
      {
        tokens.id_token = input + "." + signature;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(tokens));
    }
    else
    {
      response.writeHead(404);
      response.end();
    }
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  issuer = `http://127.0.0.1:${app.address().port}`;
  const config = new client.Configuration({
    issuer,
    authorization_endpoint: issuer + "/authorize",
    token_endpoint: issuer + "/token",
    jwks_uri: issuer + "/jwks",
    authorization_response_iss_parameter_supported: true,
    id_token_signing_alg_values_supported: ["ES256"]
  }, clientId, { client_secret: secret, id_token_signed_response_alg: "ES256" }, client.ClientSecretBasic(secret));
  client.allowInsecureRequests(config);
  return {
    config, secret,
    setMode: (mode) => { nextMode = mode; },
    getTokenRequests: () => tokenRequests,
    getLastChecks: () => lastChecks,
    async close()
    {
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    }
  };
}

test("validation rejects malformed and duplicate data without throwing", () =>
{
  assert.equal(validState(state()), true);
  for (const value of [null, {}, { ...state(), tasks: [null] }, { ...state(), history: [null] },
    { ...state(), tasks: [state().tasks[0], state().tasks[0]] },
    { ...state(), duration: -1 }, { ...state(), timer: {} }])
  {
    assert.equal(validState(value), false);
  }
  const duplicateSteps = state();
  duplicateSteps.tasks[0].steps.push(duplicateSteps.tasks[0].steps[0]);
  assert.equal(validState(duplicateSteps), false);
  const legacy = state();
  delete legacy.selectedStep;
  delete legacy.tasks[0].notes;
  delete legacy.tasks[0].steps;
  assert.equal(validState(legacy), true);
});

test("PostgreSQL stores data, rejects stale versions, and makes retries idempotent", async () =>
{
  const store = await database();
  try
  {
    assert.deepEqual(await store.read(), { revision: 0, state: null, last_write: null });
    const id = randomUUID();
    assert.deepEqual(await store.write(0, id, state()), { revision: 1 });
    assert.equal(await store.write(0, id, { ...state(), label: "Different payload" }), null);
    assert.equal(await store.write(1, id, { ...state(), label: "Different payload" }), null);
    assert.deepEqual((await store.read()).state, state());
    assert.deepEqual(await store.write(0, id, state()), { revision: 1 });
    assert.equal(await store.write(0, randomUUID(), state()), null);
    const changed = state();
    changed.tasks[0].steps[0].notes = "Updated";
    const results = await Promise.all([
      store.write(1, randomUUID(), changed),
      store.write(1, randomUUID(), state())
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await store.read()).revision, 2);
    await store.health();
  }
  finally
  {
    await store.close();
  }
});

test("Railway OIDC, owner-only access, CSRF, persistence, conflicts and logout", async (t) =>
{
  const store = await database();
  const identity = await provider();
  const errors = [];
  const origin = "https://focus.example";
  const app = await createApp({
    store, origin, ownerId: "owner-user", oidc: identity.config, logger: (...args) => errors.push(args)
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, options = {}) => fetch(base + path, options);
  const post = (path, body, cookie = "", requestOrigin = origin) => request(path, {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body)
  });
  async function beginLogin(mode = "owner")
  {
    identity.setMode(mode);
    const start = await request("/auth/login", { redirect: "manual" });
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get("location"));
    assert.equal(authorization.searchParams.get("scope"), "openid");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorization.searchParams.get("nonce"));
    assert.ok(authorization.searchParams.get("state"));
    assert.ok(!authorization.searchParams.has("client_secret"));
    const redirect = await fetch(authorization, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    const callback = new URL(redirect.headers.get("location"));
    return {
      callback,
      flowCookie: start.headers.get("set-cookie").split(";")[0]
    };
  }
  const callback = (flow, includeCookie = true) => request(flow.callback.pathname + flow.callback.search, {
    headers: includeCookie ? { Cookie: flow.flowCookie } : {},
    redirect: "manual"
  });
  let cookie;
  try
  {
    await t.test("unauthorized users cannot read or modify state", async () =>
    {
      assert.equal((await request("/api/state")).status, 401);
      assert.equal((await post("/api/state", {})).status, 401);
      const html = await request("/");
      assert.match(await html.text(), /id="login"/);
      assert.equal(html.headers.get("cache-control"), "no-store");
      assert.match(html.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.equal((await post("/api/register", {})).status, 401);
    });
    await t.test("password login is removed and cross-origin writes remain refused", async () =>
    {
      assert.equal((await post("/api/login", { username: "yao", password: "obsolete" })).status, 404);
      assert.equal((await post("/api/state", {}, "", "https://attacker.example")).status, 403);
    });
    await t.test("owner logs in through signed OIDC tokens and S256 PKCE", async () =>
    {
      const flow = await beginLogin();
      const result = await callback(flow);
      assert.equal(result.status, 302, JSON.stringify({ errors, checks: identity.getLastChecks() }));
      assert.equal(result.headers.get("location"), "/");
      const header = result.headers.getSetCookie().find((value) => value.startsWith("__Host-littlefocus="));
      assert.match(header, /__Host-littlefocus=/);
      assert.match(header, /HttpOnly/);
      assert.match(header, /Secure/);
      assert.match(header, /SameSite=Lax/);
      cookie = header.split(";")[0];
      assert.equal((await callback(flow)).status, 400);
    });
    await t.test("state is bound to the initiating browser and cannot be omitted or duplicated", async () =>
    {
      const flow = await beginLogin();
      const tokenRequests = identity.getTokenRequests();
      assert.equal((await callback(flow, false)).status, 400);
      const expected = flow.callback.searchParams.get("state");
      flow.callback.searchParams.set("state", "forged-state");
      assert.equal((await callback(flow)).status, 400);
      flow.callback.searchParams.set("state", expected);
      flow.callback.searchParams.append("state", expected);
      assert.equal((await callback(flow)).status, 400);
      assert.equal(identity.getTokenRequests(), tokenRequests);
      flow.callback.searchParams.delete("state");
      flow.callback.searchParams.set("state", expected);
      assert.equal((await callback(flow)).status, 302);
    });
    await t.test("cancelled authorization issues no app session", async () =>
    {
      const flow = await beginLogin();
      flow.callback.searchParams.delete("code");
      flow.callback.searchParams.set("error", "access_denied");
      const result = await callback(flow);
      assert.equal(result.status, 400);
      assert.match(await result.text(), /登录已取消/);
      assert.ok(!result.headers.getSetCookie().some((value) => value.startsWith("__Host-littlefocus=")));
    });
    await t.test("expired browser authorization cannot redeem a code", async () =>
    {
      const flow = await beginLogin();
      const tokenRequests = identity.getTokenRequests();
      const originalNow = Date.now;
      try
      {
        const future = originalNow() + 11 * 60 * 1000;
        Date.now = () => future;
        assert.equal((await callback(flow)).status, 400);
        assert.equal(identity.getTokenRequests(), tokenRequests);
      }
      finally
      {
        Date.now = originalNow;
      }
    });
    await t.test("other Railway users cannot obtain a session", async () =>
    {
      const flow = await beginLogin("other-user");
      const result = await callback(flow);
      assert.equal(result.status, 403);
      assert.ok(!result.headers.getSetCookie().some((value) => value.startsWith("__Host-littlefocus=")));
    });
    for (const mode of ["bad-signature", "bad-nonce", "bad-issuer", "bad-audience", "expired", "missing-id-token", "bad-pkce"])
    {
      await t.test(`${mode} cannot authenticate`, async () =>
      {
        const flow = await beginLogin(mode);
        const result = await callback(flow);
        assert.equal(result.status, 401);
        assert.ok(!result.headers.getSetCookie().some((value) => value.startsWith("__Host-littlefocus=")));
      });
    }
    await t.test("provider validation logs contain no codes or tokens", () =>
    {
      assert.equal(errors.length, 7);
      const log = JSON.stringify(errors);
      assert.ok(!log.includes("local-test-access-token"));
      assert.ok(!log.includes(identity.secret));
    });
    await t.test("authenticated HTML contains cloud mode and matching CSP nonce", async () =>
    {
      const result = await request("/", { headers: { Cookie: cookie } });
      const html = await result.text();
      assert.match(html, /window.LITTLE_FOCUS_CLOUD = true/);
      const nonce = html.match(/<script nonce="([^"]+)"/)[1];
      assert.ok(result.headers.get("content-security-policy").includes(`'nonce-${nonce}'`));
      assert.ok(!html.includes(identity.secret));
    });
    await t.test("cloud state survives requests and stale-device writes are refused", async () =>
    {
      const initial = await request("/api/state", { headers: { Cookie: cookie } });
      assert.equal((await initial.json()).state, null);
      const mutationId = randomUUID();
      const body = { revision: 0, mutationId, state: state() };
      const result = await post("/api/state", body, cookie);
      assert.equal(result.status, 200);
      assert.equal((await result.json()).revision, 1);
      const retry = await post("/api/state", body, cookie);
      assert.equal((await retry.json()).revision, 1);
      assert.equal((await post("/api/state", { ...body, mutationId: randomUUID() }, cookie)).status, 409);
      const remote = await (await request("/api/state", { headers: { Cookie: cookie } })).json();
      assert.deepEqual(remote.state, state());
      assert.equal(remote.revision, 1);
      assert.ok(Number.isFinite(remote.serverTime));
      assert.equal((await post("/api/state", { ...body, state: { ...state(), tasks: [null] } }, cookie)).status, 400);
      assert.equal((await post("/api/state", body, cookie, "https://attacker.example")).status, 403);
    });
    await t.test("task and step deadlines persist while invalid calendar dates cannot alter stored state", async () =>
    {
      const before = await store.read();
      const value = state();
      value.tasks[0].dueDate = "2028-02-29";
      value.tasks[0].steps[0].dueDate = "2028-03-01";
      const body = { revision: before.revision, mutationId: randomUUID(), state: value };
      assert.equal((await post("/api/state", body, cookie)).status, 200);
      const saved = await (await request("/api/state", { headers: { Cookie: cookie } })).json();
      assert.deepEqual(saved.state, value);
      const stored = await store.read();
      for (const step of [false, true])
      {
        const invalid = structuredClone(value);
        (step ? invalid.tasks[0].steps[0] : invalid.tasks[0]).dueDate = "2026-02-30";
        assert.equal((await post("/api/state", {
          revision: saved.revision, mutationId: randomUUID(), state: invalid
        }, cookie)).status, 400);
        assert.deepEqual(await store.read(), stored);
      }
    });
    await t.test("focus and break lifecycle states persist with strict validation and unchanged history", async () =>
    {
      const value = state();
      const timer = { id: "rest", kind: "break", label: "休息", taskId: "", stepId: "",
        status: "running", total: 300000, remaining: 300000, endAt: Date.now() + 300000 };
      for (const stage of [
        { ...value, breakPrompt: "offer" },
        { ...value, timer },
        { ...value, timer: { ...timer, status: "paused", remaining: 120000 } },
        { ...value, breakPrompt: "finished" },
        value
      ])
      {
        const before = await store.read();
        assert.equal((await post("/api/state", {
          revision: before.revision, mutationId: randomUUID(), state: stage
        }, cookie)).status, 200);
        const stored = await store.read();
        assert.deepEqual(stored.state, stage);
        for (const invalid of [
          { ...value, breakPrompt: "invalid" }, { ...value, timer, breakPrompt: "offer" },
          { ...value, timer: { ...timer, total: 900000 } },
          { ...value, timer: { ...timer, taskId: "task" } }
        ])
        {
          assert.equal((await post("/api/state", {
            revision: stored.revision, mutationId: randomUUID(), state: invalid
          }, cookie)).status, 400);
          assert.deepEqual(await store.read(), stored);
        }
      }
    });
    await t.test("request size includes the entire UTF-8 envelope at the exact 2 MiB boundary", async () =>
    {
      const before = await store.read();
      const body = { revision: before.revision, mutationId: randomUUID(), state: state(), padding: "中" };
      body.padding += "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(body)));
      assert.equal(Buffer.byteLength(JSON.stringify(body)), 2 * 1024 * 1024);
      const accepted = await post("/api/state", body, cookie);
      assert.equal(accepted.status, 200);
      const revision = (await accepted.json()).revision;
      const oversized = { ...body, padding: body.padding + "x" };
      assert.equal((await post("/api/state", oversized, cookie)).status, 413);
      assert.equal((await store.read()).revision, revision);
      assert.deepEqual((await store.read()).state, state());
      const different = { ...body, padding: "", state: { ...state(), label: "different" } };
      assert.equal((await post("/api/state", different, cookie)).status, 409);
      assert.equal((await store.read()).revision, revision);
    });
    await t.test("logout revokes the previous cookie", async () =>
    {
      assert.equal((await post("/api/logout", {}, cookie)).status, 200);
      assert.equal((await request("/api/state", { headers: { Cookie: cookie } })).status, 401);
    });
    await t.test("authorization starts are rate limited", async () =>
    {
      let result;
      for (let i = 0; i < 25; i++)
      {
        result = await request("/auth/login", { redirect: "manual" });
      }
      assert.equal(result.status, 429);
    });
    await t.test("database failures are explicit and do not leak connection details", async () =>
    {
      const before = errors.length;
      store.health = async () => { throw new Error("private connection details"); };
      const result = await request("/health");
      assert.equal(result.status, 503);
      assert.ok(!(await result.text()).includes("private connection details"));
      assert.equal(errors.length, before + 1);
    });
  }
  finally
  {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await store.close();
    await identity.close();
  }
});
