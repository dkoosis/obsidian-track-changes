// Tests for the commit-materialize contract (TA-COMMIT / cm-1.4).
// Run with: node test/commit-materialize.test.mjs
//
// cm-1.1 (diff-to-edits.test.mjs) already fuzzes the diff round-trip. This file
// covers the *commit* seam that main.commitSuggestions relies on:
//   - a non-empty baseline->current diff materializes into PARSEABLE marks
//     (acceptance: "commit yields marks that round-trip"), and
//   - the no-op cases (identical text) yield zero edits, so the commit path
//     exits the mode cleanly without writing.
// The Obsidian-bound wiring (Notice, findEditorForFile, applyEditsToFile) is
// verified manually in-app; this asserts the pure assembly it delegates to.

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

const { diffToEdits } = await loadTs("../src/diff.ts");
const { applyEdits } = await loadTs("../src/operations.ts");
const { parse } = await loadTs("../src/parser.ts");

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

// Mirror of main.commitSuggestions' pure core: diff the baseline against the
// current editor text and apply the edits to `current`. Returns the edits plus
// the materialized (marked) source.
function commit(baseline, current) {
  const edits = diffToEdits(baseline, current);
  return { edits, marked: edits.length === 0 ? current : applyEdits(current, edits) };
}

console.log("commit-materialize:");

test("identical baseline/current -> no edits, clean exit (no write)", () => {
  const { edits, marked } = commit("hello world", "hello world");
  assert.deepEqual(edits, []);
  assert.equal(marked, "hello world");
});

test("substitution materializes into a parseable substitution node", () => {
  const { edits, marked } = commit("the cat sat", "the dog sat");
  assert.ok(edits.length >= 1, "expected at least one edit");
  const nodes = parse(marked).nodes;
  assert.ok(
    nodes.some((n) => n.kind === "substitution"),
    `expected a substitution node, parsed: ${JSON.stringify(nodes.map((n) => n.kind))}`,
  );
});

test("insertion materializes into a parseable addition node", () => {
  const { marked } = commit("the cat sat", "the big cat sat");
  const nodes = parse(marked).nodes;
  assert.ok(
    nodes.some((n) => n.kind === "addition" || n.kind === "substitution"),
    `expected an addition, parsed: ${JSON.stringify(nodes.map((n) => n.kind))}`,
  );
});

test("deletion materializes into a parseable deletion node", () => {
  const { marked } = commit("the big cat sat", "the cat sat");
  const nodes = parse(marked).nodes;
  assert.ok(
    nodes.some((n) => n.kind === "deletion" || n.kind === "substitution"),
    `expected a deletion, parsed: ${JSON.stringify(nodes.map((n) => n.kind))}`,
  );
});

test("committed marks are non-overlapping (applyEdits contract holds)", () => {
  // Multi-region edit; applyEdits throws on overlap, so a clean return is the
  // assertion. Parse must then see more than zero marks.
  const { marked } = commit("the cat sat on the mat", "the dog sat on the rug");
  assert.ok(parse(marked).nodes.length >= 1);
});

console.log("done.");
