import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [resolve(__dirname, "../src/authors.ts")],
  bundle: false,
  format: "esm",
  target: "es2018",
  write: false,
  platform: "neutral",
});
const code = out.outputFiles[0].text;
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const { AUTHOR_RE, authorHueIndex, isValidAuthorName } = mod;

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

console.log("authors:");

test("AUTHOR_RE matches Claude:", () => {
  const m = "Claude: hello".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "Claude");
});

test("AUTHOR_RE matches GPT-4:", () => {
  const m = "GPT-4: hi".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "GPT-4");
});

test("AUTHOR_RE matches a human author prefix dk: (cm-7)", () => {
  // The myAuthorName setting writes `{>>dk: hi<<}`; the same prefix grammar that
  // names an AI reviewer must treat `dk` as a named author (not "You"), so a
  // human's marks carry a stable identity. Asserts existing behavior — no
  // parser change.
  const m = "dk: hi".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "dk");
});

test("AUTHOR_RE matches lowercased gpt:", () => {
  const m = "gpt: hi".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "gpt");
});

test("AUTHOR_RE allows leading whitespace", () => {
  const m = "  Claude: hello".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "Claude");
});

test("AUTHOR_RE tolerates whitespace before the colon", () => {
  // Intentional: `\s*:\s*` is permissive. "Claude : hi" is still a single-token
  // name and should match. Multi-word names are still rejected (covered above).
  const m = "Claude : hi".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "Claude");
});

test("AUTHOR_RE rejects multi-word strings", () => {
  assert.equal("asdjak adakjds : oops".match(AUTHOR_RE), null);
  assert.equal("see line 4 : bad".match(AUTHOR_RE), null);
});

test("AUTHOR_RE rejects empty name", () => {
  assert.equal(": oops".match(AUTHOR_RE), null);
});

test("AUTHOR_RE rejects digit-leading name", () => {
  assert.equal("4chan: hi".match(AUTHOR_RE), null);
});

test("AUTHOR_RE ignores a leading @Name: addressing token (cm-8)", () => {
  // `@Claude:` at the start of a comment body addresses an agent (docs/SKILL.md).
  // The `@` is non-alpha, so AUTHOR_RE must not read it as an author prefix —
  // otherwise the addressing token would be mistaken for authorship.
  assert.equal("@Claude: rewrite this".match(AUTHOR_RE), null);
});

test("AUTHOR_RE accepts TODO: as a false positive (documented)", () => {
  const m = "TODO: fix".match(AUTHOR_RE);
  assert.ok(m);
  assert.equal(m[1], "TODO");
});

test("isValidAuthorName accepts what AUTHOR_RE reads back (cm-7)", () => {
  // Names that round-trip through the `<Name>:` prefix grammar. main.ts only
  // prefixes a name this accepts, so an accepted name must also match AUTHOR_RE.
  for (const name of ["dk", "Claude", "GPT-4", "gpt-4o", "a.b-c"]) {
    assert.ok(isValidAuthorName(name), name);
    assert.ok(`${name}: hi`.match(AUTHOR_RE), name);
  }
});

test("isValidAuthorName rejects unparseable names (cm-7)", () => {
  // Spaces, leading digit, empty, >30 chars: prefixing these would leak into
  // the body and render as "You", so the call site drops them.
  for (const name of ["John Doe", "4chan", "", "x".repeat(31)]) {
    assert.equal(isValidAuthorName(name), false, JSON.stringify(name));
  }
});

test("authorHueIndex pins Claude to 7 (red)", () => {
  assert.equal(authorHueIndex("Claude"), 7);
  assert.equal(authorHueIndex("claude"), 7);
  assert.equal(authorHueIndex("CLAUDE"), 7);
});

test("authorHueIndex pins GPT variants to 2 (green)", () => {
  assert.equal(authorHueIndex("gpt"), 2);
  assert.equal(authorHueIndex("GPT"), 2);
  assert.equal(authorHueIndex("gpt-4"), 2);
  assert.equal(authorHueIndex("gpt-4o"), 2);
  assert.equal(authorHueIndex("ChatGPT"), 2);
});

test("authorHueIndex pins Gemini to 0 (blue)", () => {
  assert.equal(authorHueIndex("Gemini"), 0);
  assert.equal(authorHueIndex("gemini-pro"), 0);
});

test("authorHueIndex hashes unknown names deterministically into 0..7", () => {
  const a = authorHueIndex("Phil");
  const b = authorHueIndex("Phil");
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 8);
  assert.ok(authorHueIndex("SomeNewModel") >= 0);
  assert.ok(authorHueIndex("SomeNewModel") < 8);
});

console.log("done.");
