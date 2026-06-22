// Tests for diffToOverlay (TA-OVERLAY / cm-1.3). Run: node test/overlay.test.mjs
//
// diffToOverlay is the pure, render-shaped half of the diff engine — it feeds
// the live CM6 overlay (insert spans + phantom-deletion widgets). The overlay's
// CM6 render/caret behavior is verified manually in Obsidian (cannot be
// unit-tested); this asserts the op stream the field builds from:
//   - offsets in-bounds against `current`, ordered by `from`,
//   - `del` ops are zero-width points; `ins` ops are real [from,to) spans,
//   - `ins` spans don't overlap each other (the CM6 mark-set contract),
//   - and the stream agrees with diffToEdits on WHERE the changes are (shared
//     segmentation — overlay never shows a split the commit wouldn't make).

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

const { diffToOverlay, diffToEdits } = await loadTs("../src/diff.ts");

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

/** Assert the structural invariants every op stream must hold for `current`. */
function assertWellFormed(ops, current) {
  let prevFrom = -1;
  const insSpans = [];
  for (const op of ops) {
    assert.ok(op.kind === "ins" || op.kind === "del", `kind: ${op.kind}`);
    assert.ok(op.from >= 0 && op.to <= current.length, "offsets in-bounds");
    assert.ok(op.from <= op.to, "from <= to");
    assert.ok(op.from >= prevFrom, "ordered by from");
    prevFrom = op.from;
    if (op.kind === "del") {
      assert.equal(op.to, op.from, "del is zero-width");
      assert.ok(op.text.length > 0, "del carries removed text");
    } else {
      assert.equal(current.slice(op.from, op.to), op.text, "ins span matches current");
      insSpans.push(op);
    }
  }
  // ins spans never overlap one another (CM6 mark-set contract).
  for (let i = 1; i < insSpans.length; i++) {
    assert.ok(insSpans[i].from >= insSpans[i - 1].to, "ins spans non-overlapping");
  }
}

console.log("overlay:");

test("identical baseline/current -> no ops", () => {
  assert.deepEqual(diffToOverlay("the cat sat", "the cat sat"), []);
});

test("pure insertion -> one ins span over the new text", () => {
  const baseline = "the cat sat";
  const current = "the big cat sat";
  const ops = diffToOverlay(baseline, current);
  assertWellFormed(ops, current);
  const ins = ops.filter((o) => o.kind === "ins");
  assert.equal(ins.length, 1);
  assert.ok(ins[0].text.includes("big"));
  assert.equal(ops.filter((o) => o.kind === "del").length, 0);
});

test("pure deletion -> one zero-width del phantom carrying removed text", () => {
  const baseline = "the big cat sat";
  const current = "the cat sat";
  const ops = diffToOverlay(baseline, current);
  assertWellFormed(ops, current);
  const del = ops.filter((o) => o.kind === "del");
  assert.equal(del.length, 1);
  assert.ok(del[0].text.includes("big"));
  assert.equal(ops.filter((o) => o.kind === "ins").length, 0);
});

test("substitution -> a del point at the new span's start plus the ins span", () => {
  const baseline = "the cat sat";
  const current = "the dog sat";
  const ops = diffToOverlay(baseline, current);
  assertWellFormed(ops, current);
  const del = ops.find((o) => o.kind === "del");
  const ins = ops.find((o) => o.kind === "ins");
  assert.ok(del && ins, "both ops present");
  assert.equal(del.from, ins.from, "del shares the ins span's start");
  assert.ok(del.text.includes("cat"), "del shows old text");
  assert.ok(ins.text.includes("dog"), "ins shows new text");
});

test("multi-region edit stays ordered and well-formed", () => {
  const baseline = "alpha beta gamma delta";
  const current = "alpha BETA gamma DELTA epsilon";
  assertWellFormed(diffToOverlay(baseline, current), current);
});

test("overlay del points sit where diffToEdits puts its marks", () => {
  // Shared segmentation: every overlay block's start offset matches an edit's
  // `from` (the commit and the render can't disagree on change location).
  const baseline = "one two three four";
  const current = "one TWO three FOUR five";
  const ops = diffToOverlay(baseline, current);
  const editFroms = new Set(diffToEdits(baseline, current).map((e) => e.from));
  for (const op of ops) {
    assert.ok(editFroms.has(op.from), `op@${op.from} aligns with an edit`);
  }
});

console.log("done.");
