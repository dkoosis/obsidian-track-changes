// Tests for SuggestModeState (cm-1.2). Run with: node test/suggest-mode.test.mjs

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadTs(rel) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  const code = out.outputFiles[0].text;
  return await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { SuggestModeState } = await loadTs("../src/suggest-mode.ts");

function test(name, fn) {
  try {
    fn();
    console.log("  ok  -", name);
  } catch (err) {
    console.error("  FAIL -", name);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log("SuggestModeState:");

test("starts inactive with no baseline", () => {
  const s = new SuggestModeState();
  assert.equal(s.isActive("a.md"), false);
  assert.equal(s.baselineFor("a.md"), null);
});

test("enter snapshots baseline and activates", () => {
  const s = new SuggestModeState();
  s.enter("a.md", "hello world");
  assert.equal(s.isActive("a.md"), true);
  assert.equal(s.baselineFor("a.md"), "hello world");
});

test("exit clears state and returns the baseline", () => {
  const s = new SuggestModeState();
  s.enter("a.md", "base");
  assert.equal(s.exit("a.md"), "base");
  assert.equal(s.isActive("a.md"), false);
  assert.equal(s.baselineFor("a.md"), null);
});

test("exit on an inactive file returns null", () => {
  const s = new SuggestModeState();
  assert.equal(s.exit("nope.md"), null);
});

test("toggle enters then exits, returning the new state", () => {
  const s = new SuggestModeState();
  assert.equal(s.toggle("a.md", "snap1"), true);
  assert.equal(s.baselineFor("a.md"), "snap1");
  assert.equal(s.toggle("a.md", "snap2"), false);
  assert.equal(s.isActive("a.md"), false);
});

test("per-file state is independent", () => {
  const s = new SuggestModeState();
  s.enter("a.md", "A");
  s.enter("b.md", "B");
  assert.equal(s.baselineFor("a.md"), "A");
  assert.equal(s.baselineFor("b.md"), "B");
  s.exit("a.md");
  assert.equal(s.isActive("a.md"), false);
  assert.equal(s.isActive("b.md"), true);
  assert.equal(s.baselineFor("b.md"), "B");
});

test("re-entering refreshes the baseline (snapshot at entry)", () => {
  const s = new SuggestModeState();
  s.enter("a.md", "first");
  s.enter("a.md", "second");
  assert.equal(s.baselineFor("a.md"), "second");
});

test("empty-string baseline is distinct from absent", () => {
  const s = new SuggestModeState();
  s.enter("a.md", "");
  assert.equal(s.isActive("a.md"), true);
  assert.equal(s.baselineFor("a.md"), "");
});

test("clear drops all state", () => {
  const s = new SuggestModeState();
  s.enter("a.md", "A");
  s.enter("b.md", "B");
  s.clear();
  assert.equal(s.isActive("a.md"), false);
  assert.equal(s.isActive("b.md"), false);
});

console.log("done.");
