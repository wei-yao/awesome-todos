import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validState as serverValidState } from "./server.mjs";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const STORAGE = "little-focus-v1";
const LEGACY = STORAGE + "-pending";
const PREFIX = LEGACY + "-";
const MAX_BYTES = 2 * 1024 * 1024;
const task = (id = "task") => ({ id, text: "Task", done: false, notes: "", steps: [] });
const entry = (id = "entry") => ({ id, label: "Focus", elapsed: 900000, endedAt: 1000, completed: true });
const state = () => ({
  tasks: [task()], history: [], mode: "free", label: "", selectedTask: "", selectedStep: "", duration: 15, timer: null
});
const timerState = () => ({
  ...state(),
  timer: { id: "timer", label: "Focus", taskId: "", stepId: "", status: "running",
    total: 900000, remaining: 900000, endAt: 1000 }
});
const pending = (value, revision = 0) => ({ revision, mutationId: randomUUID(), state: value });
const clone = (value) => JSON.parse(JSON.stringify(value));

class Element
{
  constructor(tag = "div")
  {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.className = "";
    this.hidden = false;
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, force) =>
      {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (force ?? !names.has(name)) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      }
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children)
  {
    this.children = children;
    if (this.tagName === "select") this.value = children[0]?.value || "";
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  async emit(name)
  {
    for (const fn of this.listeners[name] || []) await fn({ preventDefault() {} });
  }
  click() { return this.emit("click"); }
  focus() {}
  scrollIntoView() {}
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() {}
  insertAdjacentHTML() {}
  querySelectorAll(selector)
  {
    const matches = (element) => selector.startsWith(".")
      ? element.classList.contains(selector.slice(1)) : element.tagName === selector;
    return this.children.flatMap((element) =>
      [matches(element) ? element : null, ...element.querySelectorAll(selector)].filter(Boolean));
  }
  querySelector(selector)
  {
    const parts = selector.split(" ");
    let node = this;
    for (const part of parts) node = node?.querySelectorAll(part)[0];
    return node;
  }
}

function storage()
{
  const values = {};
  return new Proxy(values, {
    get(target, key)
    {
      if (key === "getItem") return (name) => target[name] ?? null;
      if (key === "setItem") return (name, value) => { target[name] = String(value); };
      if (key === "removeItem") return (name) => { delete target[name]; };
      return target[key];
    }
  });
}

function remote(initial = state())
{
  let current = clone(initial);
  let revision = 0;
  let lastId;
  const requests = [];
  return {
    requests,
    snapshot: () => ({ revision, state: clone(current) }),
    fetch: async (_path, options = {}) =>
    {
      if (options.method !== "POST") return Response.json({ revision, state: current });
      const body = JSON.parse(options.body);
      requests.push(body);
      if (revision === body.revision && lastId !== body.mutationId)
      {
        assert.equal(serverValidState(body.state), true);
        assert.ok(Buffer.byteLength(options.body) <= MAX_BYTES);
        current = body.state;
        revision++;
        lastId = body.mutationId;
      }
      else if (lastId !== body.mutationId || !isDeepStrictEqual(current, body.state))
      {
        return Response.json({ error: "另一台设备已修改数据。" }, { status: 409 });
      }
      return Response.json({ revision });
    }
  };
}

async function browser({ local = storage(), cloud = false, fetch = remote().fetch, initial = state(), now } = {})
{
  let testNow = now;
  class TestDate extends Date
  {
    constructor(...args) { super(...(args.length ? args : [testNow])); }
    static now() { return testNow; }
  }
  if (local.getItem(STORAGE) === null) local.setItem(STORAGE, JSON.stringify(initial));
  const elements = new Map();
  for (const [, tag, id] of html.matchAll(/<([a-z-]+)[^>]*\bid="([^"]+)"/g))
  {
    elements.set(id, new Element(tag));
  }
  const tasksCard = new Element();
  const focusCard = new Element();
  const document = {
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => selector === ".tasks-card" ? tasksCard : focusCard,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const windowListeners = {};
  const logs = [];
  const downloads = [];
  const context = createContext({
    document, localStorage: local, crypto: { randomUUID }, structuredClone, TextEncoder, Blob,
    Date: now === undefined ? Date : TestDate,
    URL: { createObjectURL: (blob) => { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    AbortSignal, fetch, console: { error: (...args) => logs.push(args) },
    confirm: () => true, matchMedia: () => ({ matches: true }), location: { replace() {} },
    window: { LITTLE_FOCUS_CLOUD: cloud, addEventListener: (name, fn) => { windowListeners[name] = fn; } },
    Option: class extends Element
    {
      constructor(label, value) { super("option"); this.textContent = label; this.value = value; }
    },
    setInterval() {}, setTimeout() {}
  });
  runInContext(script, context);
  const run = (code) => runInContext(code, context);
  const settle = async () =>
  {
    for (let i = 0; i < 100; i++)
    {
      await new Promise((resolve) => setImmediate(resolve));
      if (!run("cloudBusy || cloudReading")) return;
    }
    throw new Error("Client did not settle");
  };
  await settle();
  return {
    run, settle, context, local, elements, logs, downloads, tasksCard,
    setNow: (value) => { testNow = value; },
    get: () => clone(run("state")),
    value: (name, value) => { context[name] = structuredClone(value); },
    emit: (id, event = "click") => elements.get(id).emit(event),
    storageEvent: (key) => windowListeners.storage({ key }),
    async import(value)
    {
      const raw = JSON.stringify(value);
      elements.get("backup-file").files = [{ size: Buffer.byteLength(raw), text: async () => raw }];
      await elements.get("backup-file").emit("change");
    },
    quietRender: () => run("render = renderTimer = renderTasks = renderTaskOptions = renderHistory = renderTaskCount = () => {}")
  };
}

test("task views filter parents without changing stored data or triggering cloud saves", async () =>
{
  const initial = state();
  initial.tasks[0].steps = [{ ...task("done-step"), done: true }];
  initial.tasks.push({ ...task("completed"), done: true, notes: "Keep these notes",
    steps: [task("unfinished-step")] });
  const server = remote(initial);
  const page = await browser({ cloud: true, fetch: server.fetch });
  const visible = () => page.elements.get("task-list").children.map((li) => li.dataset.taskId);
  const cached = page.local.getItem(STORAGE);
  assert.deepEqual(visible(), ["task", "completed"]);
  await page.emit("tasks-completed");
  assert.deepEqual(visible(), ["completed"]);
  assert.equal(page.elements.get("tasks-completed")["aria-pressed"], "true");
  assert.equal(page.elements.get("tasks-all")["aria-pressed"], "false");
  await page.elements.get("task-list").querySelector(".task-title").click();
  assert.equal(page.elements.get("task-list").querySelector(".task-panel").hidden, false);
  assert.equal(page.elements.get("task-list").querySelectorAll(".notes-input").at(-1).value, "Keep these notes");
  assert.equal(page.elements.get("task-list").querySelectorAll(".step").length, 1);
  await page.emit("tasks-active");
  assert.deepEqual(visible(), ["task"]);
  await page.emit("tasks-all");
  assert.deepEqual(visible(), ["task", "completed"]);
  assert.deepEqual(page.get(), initial);
  assert.equal(page.local.getItem(STORAGE), cached);
  assert.equal(server.requests.length, 0);
});

test("completing and reopening tasks updates filtered views and preserves their details", async () =>
{
  const initial = state();
  initial.tasks[0].notes = "Task notes";
  initial.tasks[0].steps = [task("step")];
  const page = await browser({ initial });
  await page.emit("tasks-completed");
  assert.equal(page.elements.get("task-list").children.length, 0);
  assert.equal(page.elements.get("tasks-empty").hidden, false);
  assert.match(page.elements.get("tasks-empty").textContent, /还没有已完成/);
  await page.emit("tasks-active");
  let checkbox = page.elements.get("task-list").querySelector(".completion input");
  checkbox.checked = true;
  await checkbox.emit("change");
  assert.equal(page.elements.get("task-list").children.length, 0);
  assert.match(page.elements.get("tasks-empty").textContent, /待办都完成了/);
  assert.equal(page.elements.get("task-count").textContent, "1 / 1 已完成");
  await page.emit("tasks-completed");
  checkbox = page.elements.get("task-list").querySelector(".completion input");
  assert.equal(checkbox.checked, true);
  checkbox.checked = false;
  await checkbox.emit("change");
  assert.equal(page.elements.get("task-list").children.length, 0);
  await page.emit("tasks-active");
  assert.equal(page.elements.get("task-list").children.length, 1);
  assert.deepEqual(page.get(), initial);
  const reopened = await browser({ local: page.local });
  assert.equal(reopened.run("taskView"), "all");
  assert.deepEqual(reopened.get(), initial);
});

test("adding from Completed reveals the new active task without removing completed tasks", async () =>
{
  const initial = state();
  initial.tasks[0].done = true;
  const page = await browser({ initial });
  await page.emit("tasks-completed");
  page.elements.get("new-task").value = "New task";
  await page.emit("add-form", "submit");
  assert.equal(page.run("taskView"), "active");
  assert.equal(page.elements.get("task-list").children.length, 1);
  assert.equal(page.elements.get("task-list").querySelector(".task-text").textContent, "New task");
  await page.emit("tasks-completed");
  assert.equal(page.elements.get("task-list").children.length, 1);
  assert.equal(page.get().tasks.length, 2);
  await page.elements.get("task-list").querySelector(".delete-btn").click();
  assert.equal(page.elements.get("task-list").children.length, 0);
  assert.equal(page.elements.get("tasks-empty").hidden, false);
  assert.equal(page.get().tasks[0].text, "New task");
});

test("main task deadlines can be set, changed, cleared, and persisted through the real controls", async () =>
{
  const initial = state();
  initial.tasks[0].steps = [{ ...task("step"), dueDate: "2028-03-01", notes: "Legacy details" }];
  const server = remote(initial);
  const page = await browser({ cloud: true, fetch: server.fetch });
  const list = page.elements.get("task-list");
  const fields = list.querySelectorAll(".deadline-field");
  assert.equal(fields.length, 1);
  assert.equal(list.querySelectorAll(".notes-input").length, 1);
  const step = list.querySelector(".step");
  assert.equal(step.querySelector(".deadline-input"), undefined);
  assert.equal(step.querySelector(".deadline-status"), undefined);
  assert.equal(step.querySelector(".notes-input"), undefined);
  const taskDate = fields[0].querySelector("input");
  taskDate.value = "2028-02-29";
  await taskDate.emit("change");
  await page.settle();
  assert.equal(page.get().tasks[0].dueDate, "2028-02-29");
  assert.equal(page.get().tasks[0].steps[0].dueDate, "2028-03-01");
  taskDate.value = "2028-03-02";
  await taskDate.emit("change");
  await page.settle();
  assert.equal(server.snapshot().state.tasks[0].dueDate, "2028-03-02");
  const reopened = await browser({ local: page.local, cloud: true, fetch: server.fetch });
  assert.equal(reopened.get().tasks[0].steps[0].dueDate, "2028-03-01");
  assert.equal(reopened.elements.get("task-list").querySelector(".deadline-input").value, "2028-03-02");
  await fields[0].querySelector("button").click();
  await page.settle();
  assert.equal(taskDate.value, "");
  assert.equal(fields[0].querySelector("button").disabled, true);
  assert.equal(page.get().tasks[0].dueDate, undefined);
  assert.deepEqual(page.get().tasks[0].steps[0], initial.tasks[0].steps[0]);
  assert.deepEqual(server.snapshot().state, initial);
});

test("deadline badges use local calendar dates, refresh at midnight, and suppress completed warnings", async () =>
{
  const initial = state();
  initial.tasks[0].dueDate = "2000-01-01";
  initial.tasks[0].steps = [{ ...task("step"), dueDate: "2000-01-02" }];
  const page = await browser({ initial });
  assert.equal(page.run('localDate(new Date(2026, 9, 24, 23, 59))'), "2026-10-24");
  assert.equal(page.run('localDate(new Date(2026, 9, 25, 0, 1))'), "2026-10-25");
  page.value("datedItem", { ...task(), dueDate: "2026-10-24" });
  assert.equal(page.run('deadlineStatus(datedItem, "2026-10-23").urgency'), "");
  assert.equal(page.run('deadlineStatus(datedItem, "2026-10-24").urgency'), "today");
  assert.equal(page.run('deadlineStatus(datedItem, "2026-10-25").urgency'), "overdue");
  assert.equal(page.run('deadlineStatus({ ...datedItem, done: true }, "2026-10-25").urgency'), "");
  const list = page.elements.get("task-list");
  const taskBadge = list.querySelector(".deadline-status");
  assert.equal(list.querySelectorAll(".deadline-status").length, 1);
  assert.match(taskBadge.textContent, /2000-01-01 · 已逾期/);
  const checkbox = list.querySelector(".completion input");
  checkbox.checked = true;
  await checkbox.emit("change");
  assert.equal(taskBadge.classList.contains("is-overdue"), false);
  checkbox.checked = false;
  await checkbox.emit("change");
  const stepCheckbox = list.querySelector(".step").querySelector(".completion input");
  stepCheckbox.checked = true;
  await stepCheckbox.emit("change");
  assert.equal(taskBadge.classList.contains("is-overdue"), true);
  page.run('state.tasks[0].dueDate = localDate(); deadlineDay = "2000-01-01"; tick()');
  assert.match(taskBadge.textContent, /今天到期/);
  assert.equal(taskBadge.classList.contains("is-today"), true);
});

test("deadline validation matches on both sides and rejects malformed edits and imports atomically", async () =>
{
  const page = await browser();
  for (const [dueDate, expected] of [
    [undefined, true], ["", true], ["0001-01-01", true], ["9999-12-31", true],
    ["2028-02-29", true], ["2000-02-29", true], ["2026-02-29", false],
    ["1900-02-29", false], ["2026-04-31", false], ["2026-13-01", false],
    ["0000-01-01", false], ["10000-01-01", false], ["2026-1-01", false],
    ["2026-01-01T00:00:00Z", false], [null, false], [1, false], [{}, false]
  ])
  {
    for (const step of [false, true])
    {
      const candidate = state();
      if (step) candidate.tasks[0].steps = [{ ...task("step"), dueDate }];
      else candidate.tasks[0].dueDate = dueDate;
      page.value("candidate", candidate);
      assert.equal(page.run("validState(candidate)"), expected, JSON.stringify(dueDate));
      assert.equal(serverValidState(candidate), expected, JSON.stringify(dueDate));
    }
  }
  const before = page.get();
  const cached = page.local.getItem(STORAGE);
  const input = page.elements.get("task-list").querySelector(".deadline-input");
  input.value = "2026-02-30";
  await input.emit("change");
  assert.deepEqual(page.get(), before);
  assert.equal(input.value, "");
  assert.match(page.elements.get("notice").textContent, /有效的截止日期/);
  const bad = state();
  bad.tasks = [{ ...task("new"), dueDate: "2026-02-30" }];
  await page.import(bad);
  assert.deepEqual(page.get(), before);
  assert.equal(page.local.getItem(STORAGE), cached);
});

test("backups preserve deadlines and existing IDs retain their own dates during merges", async () =>
{
  const initial = state();
  initial.tasks[0].dueDate = "2026-12-01";
  initial.tasks[0].steps = [{ ...task("old"), dueDate: "2026-12-02" }];
  const page = await browser({ initial });
  const backup = state();
  backup.tasks[0].dueDate = "2027-01-01";
  backup.tasks[0].steps = [{ ...task("old"), dueDate: "2027-01-02" },
    { ...task("new"), dueDate: "2027-01-03" }];
  backup.tasks.push({ ...task("new-parent"), dueDate: "2027-01-04" });
  await page.import(backup);
  assert.equal(page.get().tasks[0].dueDate, "2026-12-01");
  assert.equal(page.get().tasks[0].steps[0].dueDate, "2026-12-02");
  assert.equal(page.get().tasks[0].steps[1].dueDate, "2027-01-03");
  assert.equal(page.get().tasks[1].dueDate, "2027-01-04");
  await page.emit("export-backup");
  const exported = JSON.parse(await page.downloads[0].text());
  assert.deepEqual(exported, page.get());
  const restored = await browser({ initial: { ...state(), tasks: [] } });
  await restored.import(exported);
  assert.deepEqual(restored.get().tasks, exported.tasks);
});

test("quotes switch at the exact 12-hour boundary, stay stable on refresh, and never write cloud state", async () =>
{
  const window = 43200000;
  const now = window * 40000 + window - 1;
  const local = storage();
  const server = remote();
  const page = await browser({ now, local, cloud: true, fetch: server.fetch });
  assert.equal(page.run("quoteGroups.length"), 3);
  assert.equal(page.run("quotePools.focus.length + quotePools.rest.length"), 24);
  const quote = () => page.elements.get("support-quote").textContent;
  const before = quote();
  page.run("tick()");
  assert.equal(quote(), before);
  page.setNow(now + 1);
  page.run("tick()");
  assert.notEqual(quote(), before);
  const after = quote();
  const reopened = await browser({ now: now + 1, local, cloud: true, fetch: server.fetch });
  assert.equal(reopened.elements.get("support-quote").textContent, after);
  await page.emit("quote-next");
  const manual = quote();
  assert.notEqual(manual, after);
  page.run("tick()");
  assert.equal(quote(), manual);
  const manualReload = await browser({ now: now + 2, local, cloud: true, fetch: server.fetch });
  assert.equal(manualReload.elements.get("support-quote").textContent, manual);
  assert.equal(server.requests.length, 0);
});

test("hidden quotes and opt-out persist, all-hidden pools stay quiet, and focus defers automatic rotation", async () =>
{
  const window = 43200000;
  const now = window * 40000 + window - 1;
  const page = await browser({ now });
  const quote = () => page.elements.get("support-quote").textContent;
  const first = quote();
  await page.emit("quote-hide");
  assert.notEqual(quote(), first);
  const hidden = page.run("support.hidden[0]");
  await page.emit("quote-toggle");
  assert.equal(page.elements.get("quote-content").hidden, true);
  const reopened = await browser({ now, local: page.local });
  assert.equal(reopened.elements.get("quote-content").hidden, true);
  assert.equal(reopened.run("support.hidden[0]"), hidden);
  await page.emit("quote-toggle");
  const selected = quote();
  await page.emit("start");
  await page.emit("start");
  page.setNow(now + 1);
  page.run("tick()");
  assert.equal(quote(), selected);
  const focusedReload = await browser({ now: now + 1, local: page.local });
  assert.equal(focusedReload.elements.get("support-quote").textContent, selected);
  await page.emit("finish");
  assert.equal(page.run("support.focus.window"), 40001);
  assert.notEqual(quote(), first);
  for (let i = 0; i < 18; i++) await page.emit("quote-hide");
  assert.equal(page.elements.get("quote-next").disabled, true);
  assert.match(quote(), /全部隐藏/);
  const allHiddenReload = await browser({ now: now + 2, local: page.local });
  assert.equal(allHiddenReload.elements.get("quote-hide").disabled, true);
  await page.emit("quote-restore");
  assert.equal(page.elements.get("quote-hide").disabled, false);
  page.run("startBreak()");
  const restQuote = page.elements.get("support-quote").textContent;
  for (let i = 0; i < 6; i++) await page.emit("quote-hide");
  assert.equal(page.elements.get("quote-hide").disabled, true);
  await page.emit("quote-restore");
  assert.notEqual(page.elements.get("support-quote").textContent, "");
  assert.ok(page.run("quotePools.rest").includes(restQuote));
});

test("focus completion offers an optional break; pause, resume, expiry, extension and next focus are explicit", async () =>
{
  const now = 1800000000000;
  const page = await browser({ now });
  await page.emit("start");
  assert.equal(page.get().timer.kind, "focus");
  page.setNow(now + 900000);
  page.run("tick()");
  assert.equal(page.get().timer, null);
  assert.equal(page.get().breakPrompt, "offer");
  assert.equal(page.get().history.length, 1);
  assert.equal(page.elements.get("rest-prompt").hidden, false);
  assert.equal(page.elements.get("take-break").textContent, "休息 5 分钟");
  assert.equal(page.elements.get("start").hidden, true);
  await page.emit("take-break");
  const breakId = page.get().timer.id;
  assert.equal(page.get().timer.kind, "break");
  assert.equal(page.get().timer.total, 300000);
  assert.equal(page.get().breakPrompt, undefined);
  assert.equal(page.elements.get("start-text").textContent, "暂停休息");
  assert.equal(page.elements.get("finish").textContent, "结束休息");
  page.setNow(now + 960000);
  await page.emit("start");
  assert.equal(page.get().timer.status, "paused");
  assert.equal(page.get().timer.remaining, 240000);
  page.setNow(now + 2000000);
  page.run("tick()");
  assert.equal(page.get().timer.status, "paused");
  const reopened = await browser({ now: now + 2000000, local: page.local });
  assert.equal(reopened.get().timer.id, breakId);
  assert.equal(reopened.get().timer.remaining, 240000);
  await page.emit("start");
  assert.equal(page.get().timer.endAt, now + 2240000);
  page.setNow(now + 2240000);
  page.run("tick()");
  assert.equal(page.get().breakPrompt, "finished");
  assert.equal(page.get().history.length, 1);
  assert.equal(page.get().timer, null);
  assert.equal(page.elements.get("time").textContent, "00:00");
  assert.match(page.elements.get("rest-message").textContent, /休息时间到了。你可以继续，也可以再歇一会儿。/);
  assert.equal(page.elements.get("take-break").textContent, "再休息 5 分钟");
  await page.emit("take-break");
  assert.notEqual(page.get().timer.id, breakId);
  page.setNow(now + 2540000);
  page.run("tick()");
  await page.emit("next-focus");
  assert.equal(page.get().timer.kind, "focus");
  assert.equal(page.get().breakPrompt, undefined);
  assert.equal(page.get().history.length, 1);
});

test("rest suggestions and rest quotes are independent, optional and persistent without history pressure", async () =>
{
  const page = await browser({ now: 1800000000000 });
  page.run("startBreak()");
  const first = page.elements.get("rest-suggestion-text").textContent;
  assert.equal(page.run("supportPool()"), "rest");
  assert.equal(page.elements.get("rest-suggestion").hidden, false);
  await page.emit("suggestion-next");
  assert.notEqual(page.elements.get("rest-suggestion-text").textContent, first);
  await page.emit("suggestion-next");
  assert.match(page.elements.get("rest-suggestion-text").textContent, /自然呼吸，可以睁眼/);
  await page.emit("suggestion-skip");
  const reopened = await browser({ now: 1800000000000, local: page.local });
  assert.equal(reopened.elements.get("rest-suggestion").hidden, true);
  await page.emit("finish");
  assert.equal(page.get().history.length, 0);
  assert.equal(page.get().breakPrompt, undefined);
  page.run("startBreak()");
  assert.equal(page.elements.get("rest-suggestion").hidden, false);
  page.run('state.history = Array.from({ length: 20000 }, (_, i) => ({ id: String(i), label: "Focus", elapsed: 1, endedAt: 1, completed: true }))');
  page.setNow(1800000300000);
  page.run("tick()");
  assert.equal(page.get().breakPrompt, "finished");
  assert.equal(page.get().history.length, 20000);
  await page.emit("stop-today");
  assert.equal(page.get().breakPrompt, undefined);
  assert.equal(page.get().timer, null);
});

test("late return never catches up stages, skip is optional, and early finishes use factual feedback", async () =>
{
  const now = 1800000000000;
  const page = await browser({ now });
  await page.emit("start");
  const late = await browser({ now: now + 86400000, local: page.local });
  assert.equal(late.get().history.length, 1);
  assert.equal(late.get().timer, null);
  assert.equal(late.get().breakPrompt, "offer");
  late.run("tick(); tick()");
  assert.equal(late.get().history.length, 1);
  await late.emit("skip-break");
  assert.equal(late.get().breakPrompt, undefined);
  await late.emit("start");
  late.setNow(now + 86400000 + 120000);
  await late.emit("finish");
  assert.match(late.elements.get("notice").textContent, /已记录 2 分钟/);
  assert.equal(late.get().history.at(-1).completed, false);
  assert.equal(late.get().breakPrompt, undefined);
  late.run("startBreak()");
  const breakLate = await browser({ now: now + 172800000, local: late.local });
  assert.equal(breakLate.get().breakPrompt, "finished");
  assert.equal(breakLate.get().timer, null);
  assert.equal(breakLate.get().history.length, 2);
});

test("old timers, new break states and backups share strict client/server contracts", async () =>
{
  const page = await browser();
  const check = (candidate, expected) =>
  {
    page.value("candidate", candidate);
    assert.equal(page.run("validState(candidate)"), expected);
    assert.equal(serverValidState(candidate), expected);
  };
  check(timerState(), true);
  const rest = { ...timerState(), timer: { ...timerState().timer, kind: "break", total: 300000, remaining: 300000 } };
  check(rest, true);
  check({ ...state(), breakPrompt: "offer" }, true);
  check({ ...state(), breakPrompt: "finished" }, true);
  for (const invalid of [
    { ...rest, breakPrompt: "offer" }, { ...state(), breakPrompt: null },
    { ...state(), breakPrompt: "auto" }, { ...rest, timer: { ...rest.timer, kind: "other" } },
    { ...rest, timer: { ...rest.timer, total: 900000 } },
    { ...rest, timer: { ...rest.timer, taskId: "task" } },
    { ...rest, timer: { ...rest.timer, stepId: "step" } },
    { ...rest, timer: { ...rest.timer, remaining: 300001 } },
    { ...rest, timer: { ...rest.timer, status: "finished" } }
  ]) check(invalid, false);
  page.run("startBreak()");
  await page.emit("export-backup");
  const backup = JSON.parse(await page.downloads[0].text());
  assert.equal(backup.timer.kind, "break");
  const imported = await browser();
  await imported.import(backup);
  assert.equal(imported.get().timer, null);
  assert.equal(imported.get().breakPrompt, undefined);
  await imported.import({ ...state(), breakPrompt: "finished" });
  assert.equal(imported.get().breakPrompt, undefined);
});

test("shared local tabs see break pause, completion and quote preferences without losing data", async () =>
{
  const now = 1800000000000;
  const local = storage();
  const a = await browser({ now, local });
  const b = await browser({ now, local });
  a.run("startBreak()");
  b.storageEvent(STORAGE);
  assert.equal(b.get().timer.kind, "break");
  await a.emit("start");
  b.storageEvent(STORAGE);
  assert.equal(b.get().timer.status, "paused");
  await a.emit("quote-toggle");
  b.storageEvent(STORAGE + "-support");
  assert.equal(b.elements.get("quote-content").hidden, true);
  await a.emit("start");
  b.storageEvent(STORAGE);
  a.setNow(now + 300000);
  b.setNow(now + 300000);
  a.run("tick()");
  b.run("tick()");
  assert.deepEqual(a.get(), b.get());
  assert.equal(a.get().breakPrompt, "finished");
});

test("two cloud clients completing the same break converge, but real concurrent edits remain conflicts", async () =>
{
  const now = 1800000000000;
  const seed = await browser({ now });
  seed.run("startBreak()");
  for (const different of [false, true])
  {
    const server = remote(seed.get());
    const a = await browser({ now, cloud: true, fetch: server.fetch });
    const b = await browser({ now, cloud: true, fetch: server.fetch });
    a.setNow(now + 300000);
    b.setNow(now + 300000);
    if (different) a.run('state.tasks[0].notes = "remote note"');
    a.run("tick()");
    b.run("tick()");
    await a.settle();
    await b.settle();
    assert.equal(server.snapshot().state.breakPrompt, "finished");
    assert.equal(server.snapshot().state.history.length, 0);
    if (different)
    {
      assert.ok(b.run("cloudFailure"));
      assert.equal(server.snapshot().state.tasks[0].notes, "remote note");
      assert.ok(Object.keys(b.local).some((key) => key.startsWith(PREFIX)));
    }
    else
    {
      assert.equal(b.run("cloudFailure"), "");
      assert.equal(b.tasksCard.inert, false);
    }
  }
});

test("network failures preserve break drafts across reopen and encouragement never conceals data errors", async () =>
{
  const now = 1800000000000;
  const server = remote();
  const local = storage();
  const a = await browser({ now, local, cloud: true, fetch: async (url, options) =>
  {
    if (options?.method === "POST") throw new Error("offline");
    return server.fetch(url, options);
  } });
  a.run("startBreak()");
  await a.settle();
  const draft = Object.keys(local).find((key) => key.startsWith(PREFIX));
  const raw = local.getItem(draft);
  const b = await browser({ now, local, cloud: true, fetch: server.fetch });
  assert.equal(b.get().timer.kind, "break");
  a.run('notify("保留此错误", true); renderSupport(); renderTimer()');
  await a.emit("quote-next");
  assert.equal(a.elements.get("notice").textContent, "保留此错误");
  assert.equal(local.getItem(draft), raw);
  await b.emit("cloud-retry");
  await b.settle();
  assert.equal(server.snapshot().state.timer.kind, "break");
  assert.equal(local.getItem(draft), null);
});

test("support storage failures remain visible without obscuring task errors or replacing corrupt preferences", async () =>
{
  const local = storage();
  local.setItem(STORAGE + "-support", "{broken");
  const page = await browser({ local });
  assert.equal(local.getItem(STORAGE + "-support"), "{broken");
  assert.equal(page.elements.get("support-error").hidden, false);
  page.run('notify("请立即导出草稿，不要关闭页面。", true)');
  await page.emit("quote-next");
  assert.equal(page.elements.get("notice").textContent, "请立即导出草稿，不要关闭页面。");
  assert.equal(page.elements.get("notice").classList.contains("error"), true);
  assert.equal(page.elements.get("support-error").hidden, false);
  assert.equal(local.getItem(STORAGE + "-support"), "{broken");
  const normal = await browser();
  normal.context.localStorage = new Proxy(normal.local, {
    get(target, key) { return key === "setItem" ? () => { throw new Error("quota"); } : target[key]; }
  });
  await normal.emit("quote-toggle");
  assert.match(normal.elements.get("support-error").textContent, /仅在本页生效/);
});

test("queued notes after identical break completion persist on the acknowledged revision", async () =>
{
  const now = 1800000000000;
  const seed = await browser({ now });
  seed.run("startBreak()");
  const server = remote(seed.get());
  const a = await browser({ now, cloud: true, fetch: server.fetch });
  let release;
  const b = await browser({ now, cloud: true, fetch: async (url, options) =>
  {
    if (options?.method === "POST" && !release)
    {
      await new Promise((resolve) => { release = resolve; });
    }
    return server.fetch(url, options);
  } });
  a.setNow(now + 300000);
  b.setNow(now + 300000);
  a.run("tick()");
  await a.settle();
  b.run('tick(); edit((next) => { next.tasks[0].notes = "after break"; })');
  release();
  await b.settle();
  assert.equal(b.run("cloudFailure"), "");
  assert.equal(server.snapshot().state.tasks[0].notes, "after break");
  assert.equal(server.snapshot().state.breakPrompt, "finished");
});

test("cross-tab saves cannot erase an unacknowledged draft; reopening recovers it", async () =>
{
  const local = storage();
  const server = remote();
  const a = await browser({ local, cloud: true, fetch: async (path, options) =>
  {
    if (options?.method === "POST") throw new Error("offline");
    return server.fetch(path, options);
  } });
  const b = await browser({ local, cloud: true, fetch: server.fetch });
  a.run('edit((next) => { next.tasks[0].notes = "A offline"; })');
  await a.settle();
  const key = Object.keys(local).find((name) => name.startsWith(PREFIX));
  const draft = local.getItem(key);
  b.run('edit((next) => { next.label = "B online"; })');
  await b.settle();
  assert.equal(local.getItem(key), draft);
  assert.equal(JSON.parse(local.getItem(STORAGE)).label, "B online");
  const reopened = await browser({ local, cloud: true, fetch: server.fetch });
  assert.equal(reopened.get().tasks[0].notes, "A offline");
  assert.equal(reopened.tasksCard.inert, true);
  await reopened.emit("cloud-retry");
  await reopened.settle();
  assert.match(reopened.run("cloudFailure"), /另一台设备/);
  assert.equal(local.getItem(key), draft);
  assert.equal(server.snapshot().state.label, "B online");
});

test("in-flight and queued snapshots survive other tabs and only acknowledged keys are removed", async () =>
{
  const local = storage();
  const server = remote();
  let release;
  let block = true;
  const a = await browser({ local, cloud: true, fetch: async (path, options) =>
  {
    if (block && options?.method === "POST")
    {
      block = false;
      await new Promise((resolve) => { release = resolve; });
    }
    return server.fetch(path, options);
  } });
  a.run('edit((next) => { next.label = "first"; })');
  a.run('edit((next) => { next.label = "latest"; })');
  const keys = Object.keys(local).filter((key) => key.startsWith(PREFIX));
  assert.equal(keys.length, 2);
  const other = pending({ ...state(), label: "other tab" });
  local.setItem(PREFIX + other.mutationId, JSON.stringify(other));
  await a.emit("cloud-reload");
  assert.equal(a.run("cloudBusy"), true);
  assert.equal(a.get().label, "latest");
  release();
  await a.settle();
  assert.equal(server.snapshot().state.label, "latest");
  assert.equal(server.snapshot().revision, 2);
  assert.equal(server.requests[1].revision, 1);
  assert.notEqual(server.requests[0].mutationId, server.requests[1].mutationId);
  for (const key of keys) assert.equal(local.getItem(key), null);
  assert.equal(local.getItem(PREFIX + other.mutationId), JSON.stringify(other));
});

test("multiple drafts can be selected, exported, and explicitly discarded independently", async () =>
{
  const local = storage();
  const server = remote();
  const first = pending({ ...state(), label: "first" });
  const second = pending({ ...state(), label: "second" });
  for (const draft of [first, second]) local.setItem(PREFIX + draft.mutationId, JSON.stringify(draft));
  const page = await browser({ local, cloud: true, fetch: server.fetch });
  page.elements.get("draft-select").value = PREFIX + first.mutationId;
  await page.emit("draft-open");
  assert.equal(page.get().label, "first");
  page.elements.get("draft-select").value = PREFIX + second.mutationId;
  await page.emit("draft-export");
  assert.deepEqual(JSON.parse(await page.downloads[0].text()), second);
  await page.emit("draft-open");
  assert.equal(page.get().label, "second");
  await page.emit("cloud-reload");
  await page.settle();
  assert.equal(local.getItem(PREFIX + second.mutationId), null);
  assert.ok(local.getItem(PREFIX + first.mutationId));
  assert.equal(page.get().label, "");
  assert.equal(page.tasksCard.inert, false);
  const importer = await browser();
  await importer.import(JSON.parse(await page.downloads[0].text()));
  assert.equal(importer.get().label, "");
  assert.ok(!importer.elements.get("notice").classList.contains("error"));
});

test("legacy drafts retry their exact payload and are only removed after acknowledgement", async () =>
{
  const local = storage();
  const old = state();
  delete old.selectedStep;
  delete old.tasks[0].notes;
  delete old.tasks[0].steps;
  const draft = pending(old);
  local.setItem(LEGACY, JSON.stringify(draft));
  const server = remote();
  const page = await browser({ local, cloud: true, fetch: server.fetch });
  assert.equal(page.get().selectedStep, "");
  assert.equal(local.getItem(LEGACY), JSON.stringify(draft));
  await page.emit("cloud-retry");
  await page.settle();
  assert.deepEqual(server.requests[0], draft);
  assert.equal(local.getItem(LEGACY), null);
});

test("failed reload preserves drafts; unreadable drafts remain exportable and independently discardable", async () =>
{
  const local = storage();
  const draft = pending({ ...state(), label: "unsynced" });
  local.setItem(PREFIX + draft.mutationId, JSON.stringify(draft));
  const server = remote();
  const page = await browser({ local, cloud: true, fetch: server.fetch });
  page.context.fetch = async () => { throw new Error("offline"); };
  await page.emit("cloud-reload");
  assert.equal(page.get().label, "unsynced");
  assert.equal(local.getItem(PREFIX + draft.mutationId), JSON.stringify(draft));
  assert.ok(page.run("cloudFlight"));
  local.setItem(LEGACY, "{broken");
  page.storageEvent(LEGACY);
  page.elements.get("draft-select").value = LEGACY;
  await page.emit("draft-open");
  assert.equal(page.get().label, "unsynced");
  await page.emit("draft-export");
  assert.equal(await page.downloads[0].text(), "{broken");
  await page.emit("draft-discard");
  assert.equal(local.getItem(LEGACY), null);
  assert.ok(local.getItem(PREFIX + draft.mutationId));
  page.context.fetch = server.fetch;
  await page.emit("cloud-retry");
  await page.settle();
  assert.equal(server.snapshot().state.label, "unsynced");
  assert.equal(local.getItem(PREFIX + draft.mutationId), null);
});

test("backup import merges new steps into existing parents without replacing IDs, notes, or timers", async () =>
{
  const initial = state();
  initial.tasks[0].notes = "current notes";
  initial.tasks[0].steps.push({ ...task("old-step"), notes: "current step" });
  initial.history.push(entry());
  const page = await browser({ initial });
  const backup = state();
  backup.tasks[0].text = "backup title";
  backup.tasks[0].notes = "backup notes";
  backup.tasks[0].steps.push({ ...task("old-step"), notes: "backup step" }, { ...task("new-step"), notes: "restore me" });
  backup.tasks.push(task("new-task"));
  backup.history.push({ ...entry(), label: "duplicate" }, entry("new-entry"));
  backup.timer = timerState().timer;
  await page.import(backup);
  const result = page.get();
  assert.equal(result.tasks[0].text, "Task");
  assert.equal(result.tasks[0].notes, "current notes");
  assert.equal(result.tasks[0].steps[0].notes, "current step");
  assert.equal(result.tasks[0].steps[1].notes, "restore me");
  assert.equal(result.tasks.length, 2);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].label, "Focus");
  assert.equal(result.timer, null);
  await page.import(backup);
  assert.deepEqual(page.get(), result);
});

test("client and server validators agree on exact limits, optional legacy fields, and malformed values", async () =>
{
  const page = await browser();
  const check = (value, expected) =>
  {
    page.value("candidate", value);
    assert.equal(page.run("validState(candidate)"), expected);
    assert.equal(serverValidState(value), expected);
  };
  check(state(), true);
  for (const value of [null, {}, { ...state(), tasks: [null] }, { ...state(), history: [null] },
    { ...state(), tasks: [task(), task()] }, { ...state(), history: [entry(), entry()] }]) check(value, false);
  for (const [count, valid] of [[1000, true], [1001, false]])
    check({ ...state(), tasks: Array.from({ length: count }, (_, i) => task(String(i))) }, valid);
  for (const [count, valid] of [[500, true], [501, false]])
    check({ ...state(), tasks: [{ ...task(), steps: Array.from({ length: count }, (_, i) => task(String(i))) }] }, valid);
  for (const [count, valid] of [[20000, true], [20001, false]])
    check({ ...state(), history: Array.from({ length: count }, (_, i) => entry(String(i))) }, valid);
  for (const [field, limit] of [["id", 128], ["text", 200], ["notes", 4000]])
  {
    check({ ...state(), tasks: [{ ...task(), [field]: "x".repeat(limit) }] }, true);
    check({ ...state(), tasks: [{ ...task(), [field]: "x".repeat(limit + 1) }] }, false);
  }
  for (const value of [
    { ...state(), tasks: [{ ...task(), id: "" }] },
    { ...state(), tasks: [{ ...task(), text: " " }] },
    { ...state(), tasks: [{ ...task(), steps: [task("s"), task("s")] }] },
    { ...state(), history: [{ ...entry(), taskId: 1 }] },
    { ...state(), history: [{ ...entry(), endedAt: -1 }] },
    { ...state(), selectedTask: "x".repeat(129) },
    { ...state(), selectedStep: "x".repeat(129) },
    { ...state(), label: "x".repeat(201) },
    { ...state(), duration: 5 },
    { ...timerState(), timer: { ...timerState().timer, total: 1 } },
    { ...timerState(), timer: { ...timerState().timer, remaining: 900001 } },
    { ...timerState(), timer: { ...timerState().timer, endAt: -1 } }
  ]) check(value, false);
  const legacy = state();
  delete legacy.selectedStep;
  delete legacy.tasks[0].notes;
  delete legacy.tasks[0].steps;
  check(legacy, true);
  for (const [make, fields] of [
    [(field, value) => ({ ...state(), tasks: [{ ...task(), steps: [{ ...task("step"), [field]: value }] }] }),
      [["id", 128], ["text", 200], ["notes", 4000]]],
    [(field, value) => ({ ...state(), history: [{ ...entry(), [field]: value }] }),
      [["id", 128], ["label", 405], ["taskId", 128], ["stepId", 128]]],
    [(field, value) => ({ ...timerState(), timer: { ...timerState().timer, [field]: value } }),
      [["id", 128], ["label", 405], ["taskId", 128], ["stepId", 128]]],
    [(field, value) => ({ ...state(), [field]: value }),
      [["label", 200], ["selectedTask", 128], ["selectedStep", 128]]]
  ])
  {
    for (const [field, limit] of fields)
    {
      check(make(field, "x".repeat(limit)), true);
      check(make(field, "x".repeat(limit + 1)), false);
      check(make(field, 0), false);
    }
  }
  for (const total of [900000, 1500000, 3000000])
    check({ ...timerState(), timer: { ...timerState().timer, total, remaining: total } }, true);
  check({ ...state(), tasks: "invalid" }, false);
  check({ ...state(), tasks: [{ ...task(), steps: {} }] }, false);
  check({ ...state(), timer: false }, false);
});

test("UI additions and notes reject invalid candidates without changing state, cache, or cloud queue", async () =>
{
  const initial = state();
  initial.tasks[0].steps = Array.from({ length: 499 }, (_, i) => task(String(i)));
  const server = remote(initial);
  const page = await browser({ cloud: true, fetch: server.fetch });
  const allowed = page.elements.get("task-list").querySelector(".step-form");
  allowed.querySelector("input").value = "step 500";
  await allowed.emit("submit");
  await page.settle();
  assert.equal(page.get().tasks[0].steps.length, 500);
  const before = page.get();
  const cache = page.local.getItem(STORAGE);
  const form = page.elements.get("task-list").querySelector(".step-form");
  form.querySelector("input").value = "one too many";
  await form.emit("submit");
  assert.deepEqual(page.get(), before);
  assert.equal(page.local.getItem(STORAGE), cache);
  assert.equal(server.requests.length, 1);
  assert.equal(page.run("cloudPending || cloudFlight"), null);
  assert.equal(page.tasksCard.inert, false);
  assert.match(page.elements.get("notice").textContent, /500/);
  const textarea = page.elements.get("task-list").querySelector(".notes-input");
  textarea.value = "x".repeat(4001);
  await textarea.emit("input");
  assert.deepEqual(page.get(), before);
  assert.equal(textarea.value, "");
  page.quietRender();
  page.value("full", { ...state(), tasks: Array.from({ length: 999 }, (_, i) => task(String(i))) });
  page.run("state = full; cacheState()");
  page.elements.get("new-task").value = "task 1000";
  await page.emit("add-form", "submit");
  await page.settle();
  assert.equal(page.get().tasks.length, 1000);
  const fullCache = page.local.getItem(STORAGE);
  page.elements.get("new-task").value = "overflow";
  await page.emit("add-form", "submit");
  assert.equal(page.get().tasks.length, 1000);
  assert.equal(page.local.getItem(STORAGE), fullCache);
  assert.equal(server.requests.length, 2);
});

test("repeated input events and step additions use current state, not stale renderer objects", async () =>
{
  const page = await browser();
  const textarea = page.elements.get("task-list").querySelector(".notes-input");
  textarea.value = "first";
  await textarea.emit("input");
  textarea.value = "second";
  await textarea.emit("input");
  assert.equal(page.get().tasks[0].notes, "second");
  const form = page.elements.get("task-list").querySelector(".step-form");
  form.querySelector("input").value = "new step";
  await form.emit("submit");
  assert.equal(page.get().tasks[0].notes, "second");
  assert.equal(page.get().tasks[0].steps.length, 1);
  const checkbox = page.elements.get("task-list").querySelector(".completion").querySelector("input");
  checkbox.checked = true;
  await checkbox.emit("change");
  assert.equal(page.get().tasks[0].done, true);
  assert.equal(page.get().tasks[0].steps.length, 1);
});

test("merged task/step/history and byte limits reject imports atomically", async () =>
{
  const page = await browser();
  page.quietRender();
  const cases = [];
  cases.push([
    { ...state(), tasks: Array.from({ length: 1000 }, (_, i) => task(String(i))) },
    { ...state(), tasks: [task("new")] }
  ]);
  cases.push([
    { ...state(), tasks: [{ ...task(), steps: Array.from({ length: 500 }, (_, i) => task(String(i))) }] },
    { ...state(), tasks: [{ ...task(), steps: [task("new")] }] }
  ]);
  cases.push([
    { ...state(), history: Array.from({ length: 20000 }, (_, i) => entry(String(i))) },
    { ...state(), history: [entry("new")] }
  ]);
  const bulkyTasks = (prefix) => Array.from({ length: 150 }, (_, i) => ({ ...task(prefix + i), notes: "中".repeat(3000) }));
  cases.push([{ ...state(), tasks: bulkyTasks("a") }, { ...state(), tasks: bulkyTasks("b") }]);
  for (const [initial, imported] of cases)
  {
    page.value("candidate", initial);
    page.run("state = candidate; cacheState()");
    const cache = page.local.getItem(STORAGE);
    assert.ok(Buffer.byteLength(JSON.stringify(imported)) < MAX_BYTES);
    await page.import(imported);
    assert.deepEqual(page.get(), initial);
    assert.equal(page.local.getItem(STORAGE), cache);
    assert.ok(page.elements.get("notice").classList.contains("error"));
  }
  await page.import({ ...state(), tasks: [task(), task()] });
  assert.ok(page.elements.get("notice").classList.contains("error"));
});

test("UTF-8 limit includes the full request envelope and reserves revision growth", async () =>
{
  const page = await browser();
  page.quietRender();
  const candidate = state();
  candidate.tasks = Array.from({ length: 174 }, (_, i) => ({ ...task(String(i)), notes: "中".repeat(4000) }));
  const size = () => Buffer.byteLength(JSON.stringify({
    revision: Number.MAX_SAFE_INTEGER, mutationId: "0".repeat(36), state: candidate
  }));
  while (size() > MAX_BYTES) candidate.tasks.pop();
  candidate.tasks.push({ ...task("padding"), notes: "" });
  while (size() < MAX_BYTES)
  {
    const target = candidate.tasks.at(-1);
    const count = Math.min(4000 - target.notes.length, MAX_BYTES - size());
    target.notes += "x".repeat(count);
    if (target.notes.length === 4000 && size() < MAX_BYTES) candidate.tasks.push(task("pad" + candidate.tasks.length));
  }
  assert.equal(size(), MAX_BYTES);
  page.value("candidate", candidate);
  assert.equal(page.run("stateError(candidate)"), "");
  assert.equal(page.run("save(candidate)"), true);
  await page.emit("export-backup");
  assert.ok(page.downloads[0].size <= MAX_BYTES);
  assert.deepEqual(JSON.parse(await page.downloads[0].text()), candidate);
  const before = page.get();
  candidate.label = "x";
  page.value("candidate", candidate);
  assert.match(page.run("stateError(candidate)"), /2 MiB/);
  assert.equal(page.run("save(candidate)"), false);
  assert.deepEqual(page.get(), before);
});

test("history capacity blocks auto-completion without losing the timer; clearing history allows recovery", async () =>
{
  const page = await browser();
  page.quietRender();
  const initial = timerState();
  initial.history = Array.from({ length: 19999 }, (_, i) => entry(String(i)));
  page.value("candidate", initial);
  page.run("state = candidate; tick()");
  assert.equal(page.get().history.length, 20000);
  assert.equal(page.get().timer, null);
  initial.history = Array.from({ length: 20000 }, (_, i) => entry(String(i)));
  page.value("candidate", initial);
  page.run("state = candidate; cacheState(); tick()");
  assert.deepEqual(page.get(), initial);
  assert.equal(page.run("blockedTimer"), "timer");
  assert.match(page.elements.get("notice").textContent, /20000/);
  page.run("tick()");
  assert.deepEqual(page.get(), initial);
  await page.emit("clear-history");
  page.run("tick()");
  assert.equal(page.get().timer, null);
  assert.equal(page.get().history.length, 1);
  assert.equal(page.get().history[0].id, "timer");
  assert.equal(page.elements.get("notice").classList.contains("error"), false);
});

test("400/413 responses allow corrective edits rather than trapping the client read-only", async () =>
{
  for (const status of [400, 413])
  {
    const server = remote();
    let reject = true;
    const page = await browser({ cloud: true, fetch: async (path, options) =>
    {
      if (reject && options?.method === "POST") return Response.json({ error: "数据无效" }, { status });
      return server.fetch(path, options);
    } });
    page.run('edit((next) => { next.label = "rejected"; })');
    await page.settle();
    assert.equal(page.tasksCard.inert, false);
    assert.equal(page.run("cloudRejected"), true);
    reject = false;
    page.run('edit((next) => { next.label = "corrected"; })');
    await page.settle();
    assert.equal(server.snapshot().state.label, "corrected");
    assert.equal(page.run("cloudFailure"), "");
    assert.equal(Object.keys(page.local).filter((key) => key.startsWith(PREFIX)).length, 0);
  }
});

test("failed draft persistence retains earlier snapshots and explicitly warns against closing the page", async () =>
{
  const local = storage();
  const server = remote();
  let release;
  const page = await browser({ local, cloud: true, fetch: async (path, options) =>
  {
    if (options?.method === "POST")
    {
      await new Promise((resolve) => { release = resolve; });
      throw new Error("offline");
    }
    return server.fetch(path, options);
  } });
  page.run('edit((next) => { next.label = "in flight"; }); edit((next) => { next.label = "queued"; })');
  const older = Object.keys(local).filter((key) => key.startsWith(PREFIX));
  page.context.localStorage = new Proxy(local, {
    get(target, key)
    {
      if (key === "setItem") return (name, value) =>
      {
        if (name.startsWith(PREFIX)) throw new Error("QuotaExceededError");
        target.setItem(name, value);
      };
      return target[key];
    }
  });
  page.run('edit((next) => { next.label = "latest in memory"; })');
  for (const key of older) assert.ok(local.getItem(key));
  release();
  await page.settle();
  assert.equal(page.get().label, "latest in memory");
  assert.match(page.run("cloudFailure"), /仅在本页/);
  assert.match(page.elements.get("notice").textContent, /不要关闭页面/);
});

test("an import success message cannot hide a failed local backup", async () =>
{
  const page = await browser();
  page.context.localStorage = {
    getItem: (key) => page.local.getItem(key),
    setItem: () => { throw new Error("QuotaExceededError"); }
  };
  await page.import({ ...state(), tasks: [task("new")] });
  assert.equal(page.get().tasks.length, 2);
  assert.equal(page.elements.get("notice").classList.contains("error"), true);
  assert.match(page.elements.get("notice").textContent, /本地保存失败/);
  assert.equal(JSON.parse(page.local.getItem(STORAGE)).tasks.length, 1);
});

test("two clients automatically completing the same timer converge without a read-only conflict", async () =>
{
  const initial = timerState();
  initial.timer.endAt = Date.now() + 60000;
  const server = remote(initial);
  const a = await browser({ cloud: true, fetch: server.fetch });
  const b = await browser({ cloud: true, fetch: server.fetch });
  // Both clients observe the same deadline before either POST has been acknowledged.
  a.run("serverOffset = 120000; tick()");
  b.run("serverOffset = 120000; tick()");
  await Promise.all([a.settle(), b.settle()]);
  assert.equal(server.snapshot().revision, 1);
  assert.equal(server.snapshot().state.history.length, 1);
  assert.equal(server.snapshot().state.timer, null);
  assert.notEqual(server.requests[0].mutationId, server.requests[1].mutationId);
  for (const page of [a, b])
  {
    assert.equal(page.run("cloudFailure"), "");
    assert.equal(page.tasksCard.inert, false);
    assert.equal(page.run("cloudRevision"), 1);
    assert.equal(Object.keys(page.local).filter((key) => key.startsWith(PREFIX)).length, 0);
  }
});

test("same-timer completion never hides a different concurrent task or note edit", async () =>
{
  const initial = timerState();
  initial.timer.endAt = Date.now() + 60000;
  const server = remote(initial);
  const a = await browser({ cloud: true, fetch: server.fetch });
  const b = await browser({ cloud: true, fetch: server.fetch });
  a.run('state.tasks[0].notes = "remote note"; serverOffset = 120000; tick()');
  b.run('state.tasks[0].steps.push({ id: "local-step", text: "Keep me", done: false, notes: "" }); serverOffset = 120000; tick()');
  await Promise.all([a.settle(), b.settle()]);
  assert.match(b.run("cloudFailure"), /另一台设备/);
  assert.equal(b.tasksCard.inert, true);
  assert.equal(server.snapshot().state.tasks[0].notes, "remote note");
  assert.equal(server.snapshot().state.tasks[0].steps.length, 0);
  const draft = JSON.parse(b.local.getItem(PREFIX + b.run("cloudFlight.mutationId")));
  assert.equal(draft.state.tasks[0].steps[0].text, "Keep me");
});

test("queued edits after an identical completion acknowledgement are saved on the new revision", async () =>
{
  const initial = timerState();
  initial.timer.endAt = Date.now() + 60000;
  const server = remote(initial);
  let release;
  let hold = true;
  const a = await browser({ cloud: true, fetch: server.fetch });
  const b = await browser({ cloud: true, fetch: async (path, options) =>
  {
    if (hold && options?.method === "POST")
    {
      hold = false;
      await new Promise((resolve) => { release = resolve; });
    }
    return server.fetch(path, options);
  } });
  a.run("serverOffset = 120000; tick()");
  b.run('serverOffset = 120000; tick(); edit((next) => { next.tasks[0].notes = "queued note"; })');
  await a.settle();
  release();
  await b.settle();
  assert.equal(b.run("cloudFailure"), "");
  assert.equal(server.snapshot().revision, 2);
  assert.equal(server.snapshot().state.tasks[0].notes, "queued note");
  assert.equal(server.snapshot().state.history.length, 1);
});
