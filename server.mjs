import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as client from "openid-client";

const digest = (text) => createHash("sha256").update(text).digest();
const text = (value, max) => typeof value === "string" && value.length <= max;
const optionalText = (value, max) => value === undefined || text(value, max);
const validDueDate = (value) => value === undefined || value === ""
  || (typeof value === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + "T00:00:00Z"))
    && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value);
const finite = (value) => Number.isFinite(value) && value >= 0;
const unique = (items) => new Set(items.map((item) => item?.id)).size === items.length;
const item = (value) => value && text(value.id, 128) && value.id.length > 0
  && text(value.text, 200) && value.text.trim().length > 0
  && typeof value.done === "boolean" && optionalText(value.notes, 4000) && validDueDate(value.dueDate);

export function validState(value)
{
  return Boolean(value && Array.isArray(value.tasks) && value.tasks.length <= 1000 && unique(value.tasks)
    && value.tasks.every((task) => item(task) && (task.steps === undefined
      || (Array.isArray(task.steps) && task.steps.length <= 500 && task.steps.every(item) && unique(task.steps))))
    && Array.isArray(value.history) && value.history.length <= 20000
    && value.history.every((entry) => entry && text(entry.id, 128) && text(entry.label, 405)
      && optionalText(entry.taskId, 128) && optionalText(entry.stepId, 128)
      && finite(entry.elapsed) && finite(entry.endedAt) && typeof entry.completed === "boolean")
    && unique(value.history) && ["free", "task"].includes(value.mode) && text(value.label, 200)
    && text(value.selectedTask, 128) && optionalText(value.selectedStep, 128) && [15, 25, 50].includes(value.duration)
    && (value.breakPrompt === undefined || ["offer", "finished"].includes(value.breakPrompt))
    && !(value.timer && value.breakPrompt !== undefined)
    && (value.timer === null || (value.timer && text(value.timer.id, 128) && value.timer.id.length > 0
      && text(value.timer.label, 405) && text(value.timer.taskId, 128) && optionalText(value.timer.stepId, 128)
      && ["running", "paused"].includes(value.timer.status)
      && (value.timer.kind === "break"
        ? value.timer.total === 300000 && value.timer.taskId === "" && (value.timer.stepId === undefined || value.timer.stepId === "")
        : (value.timer.kind === undefined || value.timer.kind === "focus") && [900000, 1500000, 3000000].includes(value.timer.total))
      && finite(value.timer.remaining) && value.timer.remaining <= value.timer.total && finite(value.timer.endAt))));
}

class RequestError extends Error
{
  constructor(status, message)
  {
    super(message);
    this.status = status;
  }
}

async function readJson(request)
{
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json")
  {
    throw new RequestError(415, "请求必须使用 JSON。");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request)
  {
    length += chunk.length;
    if (length > 2 * 1024 * 1024)
    {
      throw new RequestError(413, "数据超过 2 MB，请先导出历史记录。");
    }
    chunks.push(chunk);
  }
  try
  {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
    {
      throw new Error("Object required");
    }
    return value;
  }
  catch
  {
    throw new RequestError(400, "JSON 数据无效。");
  }
}

const loginPage = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Little Focus</title>
<style> :root{font:15px/1.6 system-ui,sans-serif;color-scheme:light dark;color:#30312e;background:#f7f7f2}
*{box-sizing:border-box}main{max-width:360px;margin:15vh auto;padding:28px}h1{font-size:28px;letter-spacing:-1px}
p{color:#798271;font-size:14px}.login{display:block;font:inherit;text-align:center;border-radius:10px;padding:12px;margin-top:24px;background:#586b48;color:white;text-decoration:none}
.login:focus-visible{outline:2px solid #586b48;outline-offset:4px}#error{color:#b24d43;min-height:24px}
@media(prefers-color-scheme:dark){:root{color:#e1e5da;background:#1d211c}p{color:#a5bc8d}}
</style></head><body><main><p>LITTLE FOCUS</p><h1>给自己一点专注。</h1><p>私人空间，仅允许你的账号登录。</p>
<a id="login" class="login" href="/auth/login">使用 Railway 登录</a>
<p>仅验证身份，不申请项目管理权限。</p><p id="error" role="alert">{{ERROR}}</p></main></body></html>`;

export function railwayOIDC(clientId, clientSecret)
{
  if (!text(clientId, 256) || !clientId || !text(clientSecret, 1024) || !clientSecret)
  {
    throw new Error("RAILWAY_OAUTH_CLIENT_ID and RAILWAY_OAUTH_CLIENT_SECRET are required");
  }
  const configuration = new client.Configuration({
    issuer: "https://backboard.railway.com",
    authorization_endpoint: "https://backboard.railway.com/oauth/auth",
    token_endpoint: "https://backboard.railway.com/oauth/token",
    jwks_uri: "https://backboard.railway.com/oauth/jwks",
    id_token_signing_alg_values_supported: ["ES256"],
    authorization_response_iss_parameter_supported: true
  }, clientId, {
    client_secret: clientSecret,
    id_token_signed_response_alg: "ES256"
  }, client.ClientSecretBasic(clientSecret));
  configuration.timeout = 15;
  return configuration;
}

export async function createApp({ store, origin, ownerId, oidc, logger = console.error })
{
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  {
    throw new Error("APP_ORIGIN must be an HTTPS origin, or HTTP localhost for development");
  }
  if (!text(ownerId, 128) || !ownerId.trim() || !(oidc instanceof client.Configuration))
  {
    throw new Error("OWNER_RAILWAY_ID and Railway OIDC configuration are required");
  }
  client.enableNonRepudiationChecks(oidc);
  const secure = url.protocol === "https:";
  const cookieName = secure ? "__Host-littlefocus" : "littlefocus";
  const flowCookieName = cookieName + "-oauth";
  const cookieOptions = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const sessions = new Map();
  const flows = new Map();
  const attempts = new Map();
  const sessionTTL = 12 * 60 * 60 * 1000;
  const flowTTL = 10 * 60 * 1000;
  const rateWindow = 15 * 60 * 1000;
  const appPage = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const supportScript = await readFile(new URL("./support-content.js", import.meta.url), "utf8");
  function cookie(request, name)
  {
    return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
  }
  function authorized(request)
  {
    const token = cookie(request, cookieName);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
    {
      return null;
    }
    const key = digest(token).toString("hex");
    const expiry = sessions.get(key);
    if (!expiry || expiry < Date.now())
    {
      sessions.delete(key);
      return null;
    }
    return key;
  }
  function rateLimit(request)
  {
    const now = Date.now();
    for (const [key, value] of attempts)
    {
      if (value.expires <= now)
      {
        attempts.delete(key);
      }
    }
    const ip = request.socket.remoteAddress || "unknown";
    for (const [key, limit] of [[ip, 20], ["global", 80]])
    {
      const current = attempts.get(key) || { count: 0, expires: now + rateWindow };
      if (current.count >= limit || attempts.size > 1000)
      {
        throw new RequestError(429, "尝试次数过多，请 15 分钟后再试。");
      }
      current.count++;
      attempts.set(key, current);
    }
  }
  return createServer(async (request, response) =>
  {
    const nonce = randomBytes(18).toString("base64");
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    if (secure)
    {
      response.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    const json = (status, value) =>
    {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try
    {
      const currentUrl = new URL(request.url, origin);
      const path = currentUrl.pathname;
      const session = authorized(request);
      if (!["GET", "POST"].includes(request.method))
      {
        response.setHeader("Allow", "GET, POST");
        throw new RequestError(405, "不支持此请求方法。");
      }
      if (request.method === "POST" && request.headers.origin !== origin)
      {
        throw new RequestError(403, "请求来源不匹配。");
      }
      if (path === "/health" && request.method === "GET")
      {
        await store.health();
        json(200, { ok: true });
      }
      else if (path === "/" && request.method === "GET")
      {
        const html = (session ? appPage.replace('"use strict";', '"use strict"; window.LITTLE_FOCUS_CLOUD = true;') : loginPage.replace("{{ERROR}}", ""))
          .replace('<script src="./support-content.js"></script>', () => `<script>${supportScript.replaceAll("</script", "<\\/script")}</script>`)
          .replaceAll("<script>", `<script nonce="${nonce}">`).replaceAll("<style>", `<style nonce="${nonce}">`);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
      }
      else if (path === "/auth/login" && request.method === "GET")
      {
        rateLimit(request);
        for (const [key, flow] of flows)
        {
          if (flow.expires <= Date.now())
          {
            flows.delete(key);
          }
        }
        if (flows.size >= 200)
        {
          throw new RequestError(429, "登录请求过多，请稍后再试。");
        }
        const flowToken = randomBytes(32).toString("hex");
        const flow = {
          state: randomBytes(32).toString("base64url"),
          nonce: randomBytes(32).toString("base64url"),
          verifier: randomBytes(32).toString("base64url"),
          expires: Date.now() + flowTTL
        };
        const authorization = client.buildAuthorizationUrl(oidc, {
          redirect_uri: origin + "/auth/callback",
          response_mode: "query",
          scope: "openid",
          state: flow.state,
          nonce: flow.nonce,
          code_challenge: digest(flow.verifier).toString("base64url"),
          code_challenge_method: "S256"
        });
        const previous = cookie(request, flowCookieName);
        if (previous)
        {
          flows.delete(digest(previous).toString("hex"));
        }
        flows.set(digest(flowToken).toString("hex"), flow);
        response.setHeader("Set-Cookie", `${flowCookieName}=${flowToken}; ${cookieOptions}; Max-Age=${flowTTL / 1000}`);
        response.writeHead(302, { Location: authorization.href });
        response.end();
      }
      else if (path === "/auth/callback" && request.method === "GET")
      {
        const flowToken = cookie(request, flowCookieName);
        const key = flowToken && /^[a-f0-9]{64}$/.test(flowToken) ? digest(flowToken).toString("hex") : "";
        const flow = flows.get(key);
        if (!flow || flow.expires <= Date.now() || currentUrl.searchParams.getAll("state").length !== 1
          || currentUrl.searchParams.get("state") !== flow.state)
        {
          throw new RequestError(400, "登录请求已失效，请重新开始 Railway 登录。");
        }
        flows.delete(key);
        const clearFlow = `${flowCookieName}=; ${cookieOptions}; Max-Age=0`;
        response.setHeader("Set-Cookie", clearFlow);
        if (currentUrl.searchParams.has("error"))
        {
          throw new RequestError(400, "Railway 登录已取消，请重新开始。");
        }
        let claims;
        try
        {
          const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
            pkceCodeVerifier: flow.verifier,
            expectedState: flow.state,
            expectedNonce: flow.nonce,
            idTokenExpected: true
          });
          claims = tokens.claims();
        }
        catch (error)
        {
          logger("Railway OIDC verification failed:", error.code || error.name);
          throw new RequestError(401, "Railway 登录验证失败，请重新开始。");
        }
        if (!claims || claims.sub !== ownerId)
        {
          throw new RequestError(403, "此 Railway 账号没有访问权限，请使用应用所有者的账号登录。");
        }
        for (const [key, expiry] of sessions)
        {
          if (expiry < Date.now())
          {
            sessions.delete(key);
          }
        }
        if (sessions.size >= 50)
        {
          sessions.delete(sessions.keys().next().value);
        }
        const token = randomBytes(32).toString("hex");
        sessions.set(digest(token).toString("hex"), Date.now() + sessionTTL);
        response.setHeader("Set-Cookie", [clearFlow, `${cookieName}=${token}; ${cookieOptions}; Max-Age=${sessionTTL / 1000}`]);
        response.writeHead(302, { Location: "/" });
        response.end();
      }
      else if (path === "/api/login")
      {
        throw new RequestError(404, "密码登录已停用，请使用 Railway 登录。");
      }
      else if (path.startsWith("/api/"))
      {
        if (!session)
        {
          throw new RequestError(401, "登录已过期，请重新登录。");
        }
        if (path === "/api/logout" && request.method === "POST")
        {
          sessions.delete(session);
          response.setHeader("Set-Cookie", `${cookieName}=; ${cookieOptions}; Max-Age=0`);
          json(200, { ok: true });
        }
        else if (path === "/api/state" && request.method === "GET")
        {
          const { revision, state } = await store.read();
          json(200, { revision, state, serverTime: Date.now() });
        }
        else if (path === "/api/state" && request.method === "POST")
        {
          const body = await readJson(request);
          if (!Number.isSafeInteger(body.revision) || body.revision < 0
            || !text(body.mutationId, 128) || !body.mutationId || !validState(body.state))
          {
            throw new RequestError(400, "任务数据无效，未保存。");
          }
          const result = await store.write(body.revision, body.mutationId, body.state);
          if (!result)
          {
            throw new RequestError(409, "另一台设备已修改数据。请先导出本机备份，再加载云端版本。");
          }
          json(200, { revision: result.revision, serverTime: Date.now() });
        }
        else
        {
          throw new RequestError(404, "找不到此接口。");
        }
      }
      else
      {
        throw new RequestError(404, "找不到此页面。");
      }
    }
    catch (error)
    {
      if (!(error instanceof RequestError))
      {
        logger("Request failed:", error.message);
      }
      if (!response.headersSent)
      {
        const message = error instanceof RequestError ? error.message : "服务暂不可用，未确认保存。请稍后重试。";
        if (request.url?.startsWith("/auth/"))
        {
          const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
          const html = loginPage.replace("{{ERROR}}", escaped).replaceAll("<style>", `<style nonce="${nonce}">`);
          response.writeHead(error.status || 503, { "Content-Type": "text/html; charset=utf-8" });
          response.end(html);
        }
        else
        {
          json(error.status || 503, { error: message });
        }
      }
      else
      {
        response.end();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
  let store;
  try
  {
    if (!process.env.DATABASE_URL || !process.env.APP_ORIGIN || !process.env.OWNER_RAILWAY_ID)
    {
      throw new Error("DATABASE_URL, APP_ORIGIN and OWNER_RAILWAY_ID are required");
    }
    const oidc = railwayOIDC(process.env.RAILWAY_OAUTH_CLIENT_ID, process.env.RAILWAY_OAUTH_CLIENT_SECRET);
    const { createPostgresStore } = await import("./store.mjs");
    store = await createPostgresStore(process.env.DATABASE_URL);
    const server = await createApp({
      store, origin: process.env.APP_ORIGIN, ownerId: process.env.OWNER_RAILWAY_ID, oidc
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("Little Focus is ready"));
    const shutdown = () =>
    {
      server.close(async () =>
      {
        await store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }
  catch (error)
  {
    console.error("Startup failed:", error.message);
    await store?.close();
    process.exitCode = 1;
  }
}
