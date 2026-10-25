import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("./index.html", import.meta.url), "utf8");
const server = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
const login = server.match(/const loginPage = `([\s\S]*?)`;/)[1];
const styles = (html) => html.match(/<style>([\s\S]*?)<\/style>/)[1];
const themes = (css) => [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((match) =>
  Object.fromEntries([...match[1].matchAll(/(--[\w-]+):\s*(#[a-fA-F0-9]{6})\s*(?=;|$)/g)]
    .map((value) => [value[1], value[2]])));
function luminance(hex)
{
  const rgb = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b)
{
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("app and login share warm light and neutral dark themes with accessible contrast", () =>
{
  const [appLight, appDark] = themes(styles(app));
  const [loginLight, loginDark] = themes(styles(login));
  for (const [key, value] of Object.entries({
    "--background": "#f7f7f2", "--surface": "#fffefa", "--ink": "#30312e",
    "--line": "#e9eae2", "--accent": "#586b48", "--accent-soft": "#eef2e7",
    "--timer": "#f0ede5", "--primary": "#586b48"
  })) assert.equal(appLight[key], value, `Original light palette ${key}`);
  for (const [index, theme] of [appLight, appDark].entries())
  {
    for (const key of Object.keys(index ? loginDark : loginLight))
      assert.equal(theme[key], (index ? loginDark : loginLight)[key], `Shared ${key}`);
    for (const key of index ? ["--background", "--surface", "--ink", "--muted", "--timer", "--primary"] : [])
    {
      const parts = theme[key].slice(1).match(/../g);
      assert.ok(parts.every((part) => part === parts[0]), `Neutral ${key}`);
    }
    for (const bg of ["--background", "--surface", "--timer"])
      for (const fg of ["--ink", "--muted", "--accent", "--danger"])
        assert.ok(contrast(theme[fg], theme[bg]) >= 4.5, `${fg} on ${bg}`);
    for (const bg of ["--primary", "--primary-hover"])
      assert.ok(contrast(theme["--on-primary"], theme[bg]) >= 4.5, `Primary text on ${bg}`);
    assert.ok(contrast(theme["--danger"], theme["--danger-soft"]) >= 4.5);
    for (const bg of ["--surface", "--background", "--timer"])
    {
      assert.ok(contrast(theme["--control-line"], theme[bg]) >= 3, `Control boundary on ${bg}`);
      assert.ok(contrast(theme["--accent"], theme[bg]) >= 3, `Focus outline on ${bg}`);
    }
  }
  for (const css of [styles(app), styles(login)])
  {
    assert.match(css, /color-scheme:\s*light/);
    assert.match(css, /prefers-color-scheme:\s*dark/);
    assert.match(css, /color-scheme:\s*dark/);
    assert.match(css, /:focus-visible/);
  }
});
