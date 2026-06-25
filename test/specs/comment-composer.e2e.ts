import { browser, expect } from "@wdio/globals";
import {
  seed,
  openInLivePreview,
  openPanel,
  setSelection,
  runCommand,
  clickPanelAction,
  flushNote,
  readNote,
} from "./helpers.js";

// cm-1.5 composer acceptance — the document-outcome items (cm-1.5.1). These
// drive the real path: set a live selection, fire the `comment-on-selection`
// command (the same flow the right-click "Comment" item calls), type into the
// live panel composer, submit, then read the file bytes back and assert. This
// is the un-fakeable half of the cm-1.5 checklist; the UX-feel items (autofocus,
// draft-survives-repaint, anchor preview) stay a manual eyeball pass.
//
// A fresh test vault has localAuthorName = "", so plugin-written marks carry no
// author= prefix: a clean wrap is exactly {==sel==}{>>body<<}, a point comment
// exactly {>>body<<}.

const COMPOSER = ".tc-card-composer";

/** Wait for the resulting file bytes to settle, flushing the autosave debounce
 * each round (mirrors roundtrip.e2e.ts). Returns the last-read bytes. */
async function waitForBytes(path: string, expected: string): Promise<string> {
  let actual = "";
  await browser
    .waitUntil(
      async () => {
        await flushNote(path);
        actual = await readNote(path);
        return actual === expected;
      },
      { timeout: 10000 },
    )
    .catch(() => undefined);
  return actual;
}

/** Put a body into the live composer and click its Comment button. We set the
 * value in a single DOM op + one input event rather than wdio setValue: real
 * keystrokes race the composer (a re-render can detach the textarea mid-type,
 * leaving pendingComment holding only the first char). One input event drives
 * the same listener deterministically — this test asserts the composer->edit
 * pipeline, not keystroke handling. */
async function typeAndSubmit(body: string): Promise<void> {
  const sel = `.tc-panel ${COMPOSER} .tc-reply-input`;
  await browser.$(sel).waitForExist();
  await browser.execute(
    (s: string, v: string) => {
      const el = document.querySelector(s) as HTMLTextAreaElement | null;
      if (!el) throw new Error(`composer textarea not found: ${s}`);
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    sel,
    body,
  );
  await clickPanelAction(`${COMPOSER} .tc-btn-primary`);
}

describe("track-changes: cm-1.5 comment composer", function () {
  before(async function () {
    await openPanel();
  });

  it("clean selection wraps as {==sel==}{>>body<<} (item 1)", async function () {
    const NOTE = "ComposerClean.md";
    // "target" spans offsets 12..18 of "Comment me: target word.\n".
    await seed(NOTE, "Comment me: target word.\n");
    await openInLivePreview(NOTE);
    await setSelection(12, 18);
    await runCommand("comment-on-selection");
    await typeAndSubmit("a note");

    const EXPECT = "Comment me: {==target==}{>>a note<<} word.\n";
    expect(await waitForBytes(NOTE, EXPECT)).toBe(EXPECT);
  });

  it("collapsed cursor degrades to a bare {>>body<<}, no {== ==} (item 2a)", async function () {
    const NOTE = "ComposerCursor.md";
    // Cursor parks at offset 5, right after "Point".
    await seed(NOTE, "Point here.\n");
    await openInLivePreview(NOTE);
    await setSelection(5, 5);
    await runCommand("comment-on-selection");
    await typeAndSubmit("note");

    const EXPECT = "Point{>>note<<} here.\n";
    const actual = await waitForBytes(NOTE, EXPECT);
    expect(actual).toBe(EXPECT);
    expect(actual).not.toContain("{=="); // never a degenerate highlight
  });

  it("whitespace-only selection degrades to a bare {>>body<<}, no {== ==} (item 2b)", async function () {
    const NOTE = "ComposerWhitespace.md";
    // Select the three spaces (offsets 1..4) between A and B — trims to empty,
    // so it must NOT wrap to a contentless {==   ==}.
    await seed(NOTE, "A   B\n");
    await openInLivePreview(NOTE);
    await setSelection(1, 4);
    await runCommand("comment-on-selection");
    await typeAndSubmit("note");

    // The point insertion lands at the selection start; assert the invariants
    // that matter (a bare point comment, never a highlight) rather than over-
    // pinning the exact column.
    const actual = await waitForBytes(NOTE, "A{>>note<<}   B\n");
    expect(actual).toContain("{>>note<<}");
    expect(actual).not.toContain("{==");
  });

  it("selection overlapping a mark is refused: no composer, doc unchanged (item 3)", async function () {
    const NOTE = "ComposerOverlap.md";
    // {++ins++} occupies offsets 4..13; select 6..16, straddling it.
    const SEEDED = "Pre {++ins++} post.\n";
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await setSelection(6, 16);
    await runCommand("comment-on-selection");

    // The flow refuses (Notice) and returns before it opens a composer.
    await browser.pause(400);
    await expect(browser.$(`.tc-panel ${COMPOSER}`)).not.toBeExisting();
    expect(await readNote(NOTE)).toBe(SEEDED); // untouched
  });

  it("selection inside a code block is refused: no composer, doc unchanged (item 4)", async function () {
    const NOTE = "ComposerCode.md";
    // "const" spans offsets 6..11 inside the fenced block.
    const SEEDED = "```js\nconst x = 1;\n```\n";
    await seed(NOTE, SEEDED);
    await openInLivePreview(NOTE);
    await setSelection(6, 11);
    await runCommand("comment-on-selection");

    // selectionInCode short-circuits with a Notice before any composer opens.
    await browser.pause(400);
    await expect(browser.$(`.tc-panel ${COMPOSER}`)).not.toBeExisting();
    expect(await readNote(NOTE)).toBe(SEEDED); // untouched
  });

  it("Resolve on a span comment strips {==..==} and deletes the thread (item 14)", async function () {
    const NOTE = "ComposerResolve.md";
    await seed(NOTE, "Pre {==target==}{>>note<<} post.\n");
    await openInLivePreview(NOTE);
    await openPanel();

    // Text selector must be chained off the panel element — concatenating it
    // into a descendant string (".tc-panel button=Resolve") is invalid CSS.
    const resolveBtn = browser.$(".tc-panel").$("button=Resolve");
    await resolveBtn.waitForClickable();
    await resolveBtn.click();

    const EXPECT = "Pre target post.\n";
    expect(await waitForBytes(NOTE, EXPECT)).toBe(EXPECT);
  });
});
