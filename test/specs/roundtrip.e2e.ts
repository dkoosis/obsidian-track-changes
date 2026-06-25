import { browser, expect } from "@wdio/globals";
import { seed, openInLivePreview, openPanel, clickPanelAction, flushNote, readNote } from "./helpers.js";

// Proof spec for the round-trip helper (otc-8h5): seed -> open live editor ->
// mount panel -> click a real action button -> read file bytes -> assert.
// This is the un-fakeable path — the accept runs through the live CM6 dispatch,
// not a Node re-implementation of operations.ts.
describe("track-changes: accept-addition round-trip", function () {
  const NOTE = "Roundtrip.md";
  // `{` sits at index 11 of "Accept me: " — the addition node's `from`, which
  // becomes the card's data-tc-card-offset.
  const SEEDED = "Accept me: {++hello ++}world.\n";
  const OFFSET = 11;

  before(async function () {
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await openPanel();
  });

  it("renders one suggestion card for the addition", async function () {
    await expect(browser.$(`.tc-panel [data-tc-card-offset="${OFFSET}"]`)).toExist();
  });

  it("accepting the addition rewrites the file to the inserted text", async function () {
    const ACCEPTED = "Accept me: hello world.\n";
    await clickPanelAction(`[data-tc-card-offset="${OFFSET}"] .tc-btn-accept`);
    // The accept dispatches into the live CM6 doc, not to disk; poll while
    // forcing a flush each round so a slow autosave debounce can't time us out.
    let actual = "";
    await browser
      .waitUntil(
        async () => {
          await flushNote(NOTE);
          actual = await readNote(NOTE);
          return actual === ACCEPTED;
        },
        { timeout: 10000 },
      )
      // Swallow the timeout so the assertion below surfaces the real bytes as a
      // diff instead of an opaque "condition timed out" with no file contents.
      .catch(() => undefined);
    expect(actual).toBe(ACCEPTED);
  });
});
