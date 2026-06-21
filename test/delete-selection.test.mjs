// cm-3: delete-selection builder + overlap guard. Run with:
//   node test/delete-selection.test.mjs
//
// Covers the pure layer behind the "Mark selection deleted" command:
//   - deleteSelection() edit shape + round-trip (wrap -> apply -> parse = 1 deletion)
//   - selectionOverlapsNodes() — the E3 refuse-on-intersect predicate
//   - E1 (empty selection) is command-level (from===to guard); the builder
//     itself is offset-agnostic, so only the predicate's boundary semantics
//     are unit-testable here.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function load(rel) {
  const out = await build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    target: "es2018",
    write: false,
    platform: "neutral",
  });
  const code = out.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { parse } = await load("../src/parser.ts");
const { deleteSelection, selectionOverlapsNodes, applyEdits } = await load("../src/operations.ts");

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

console.log("delete-selection:");

// --- builder shape ---
test("deleteSelection wraps the selection and anchors with expected", () => {
  const src = "alpha bravo charlie";
  const from = 6, to = 11; // "bravo"
  const edit = deleteSelection(from, to, src.slice(from, to));
  assert.deepEqual(edit, {
    from: 6,
    to: 11,
    insert: "{--bravo--}",
    expected: "bravo",
  });
});

// --- round-trip: wrap -> apply -> parse yields ONE deletion node ---
test("apply -> parse yields a single deletion node with the selected text", () => {
  const src = "alpha bravo charlie";
  const from = 6, to = 11;
  const out = applyEdits(src, [deleteSelection(from, to, src.slice(from, to))]);
  assert.equal(out, "alpha {--bravo--} charlie");
  const r = parse(out);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "bravo");
});

test("round-trip preserves a multi-word / multi-line selection as one node", () => {
  const src = "keep this\nand that too\ndone";
  const from = src.indexOf("this"), to = src.indexOf("too") + 3;
  const out = applyEdits(src, [deleteSelection(from, to, src.slice(from, to))]);
  const r = parse(out);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].kind, "deletion");
  assert.equal(r.nodes[0].text, "this\nand that too");
});

// --- E3: refuse when the selection intersects an existing mark ---
function overlaps(src, s, e) {
  return selectionOverlapsNodes(parse(src).nodes, s, e);
}

test("E3: selection inside an existing node body intersects", () => {
  const src = "x {--gone--} y"; // node spans [2,12)
  assert.equal(overlaps(src, 5, 8), true); // inside "gone"
});

test("E3: selection straddling a node's opening delimiter intersects", () => {
  const src = "x {--gone--} y";
  assert.equal(overlaps(src, 0, 4), true); // "x {-"
});

test("E3: selection fully containing a node intersects", () => {
  const src = "x {--gone--} y";
  assert.equal(overlaps(src, 0, 14), true);
});

// --- clean prose: no intersection ---
test("selection clear of every node does not intersect", () => {
  const src = "x {--gone--} clean tail";
  const s = src.indexOf("clean"), e = src.indexOf("tail") + 4;
  assert.equal(overlaps(src, s, e), false);
});

test("selection with no nodes in the doc never intersects", () => {
  assert.equal(overlaps("just plain prose here", 0, 4), false);
});

// --- half-open boundary: a selection touching a node edge is NOT an overlap ---
test("selection ending exactly at a node's from is not an overlap", () => {
  const src = "ab{--x--}cd"; // node at [2,9)
  assert.equal(overlaps(src, 0, 2), false); // [0,2) ends where node begins
});

test("selection starting exactly at a node's to is not an overlap", () => {
  const src = "ab{--x--}cd"; // node at [2,9)
  assert.equal(overlaps(src, 9, 11), false); // [9,11) begins where node ends
});
