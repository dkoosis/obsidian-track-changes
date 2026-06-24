import { browser, expect } from "@wdio/globals";
// describe/it/before are mocha globals provided by @wdio/mocha-framework.

const PLUGIN_ID = "track-changes";

// Open a note and force Live Preview (mode:source, source:false) so the CM6
// decoration extension runs. executeObsidian serializes the callback, so the
// path is passed as an argument, not captured.
async function openInLivePreview(path: string): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, p: string) => {
    const file = app.vault.getAbstractFileByPath(p);
    if (!(file instanceof obsidian.TFile)) throw new Error(`no such note: ${p}`);
    const leaf = app.workspace.getLeaf();
    await leaf.openFile(file, { active: true });
    await leaf.setViewState({
      type: "markdown",
      state: { mode: "source", source: false },
      active: true,
    });
  }, path);
}

describe("track-changes: inline decorations", function () {
  before(async function () {
    await openInLivePreview("Fixtures.md");
  });

  it("loads the plugin", async function () {
    const loaded = await browser.executeObsidian(
      ({ app }, id: string) => Boolean((app as any).plugins?.plugins?.[id]),
      PLUGIN_ID,
    );
    expect(loaded).toBe(true);
  });

  it("decorates an insertion ({++…++}) with .tc-addition", async function () {
    await expect(browser.$(".cm-editor .tc-addition")).toExist();
  });

  it("decorates a deletion ({--…--}) with .tc-deletion", async function () {
    await expect(browser.$(".cm-editor .tc-deletion")).toExist();
  });

  it("registers the suggest-mode toggle command", async function () {
    const has = await browser.executeObsidian(({ app }, id: string) =>
      Boolean((app as any).commands?.commands?.[`${id}:toggle-suggesting-mode`]),
      PLUGIN_ID,
    );
    expect(has).toBe(true);
  });

  it("leaves CriticMarkup inside code undecorated", async function () {
    // "Code Samples.md" holds markup ONLY inside fenced/indented/inline code.
    // Hard contract: none of it parses, so no decoration class should appear.
    await openInLivePreview("Code Samples.md");
    for (const cls of ["tc-addition", "tc-deletion", "tc-sub-old", "tc-sub-new"]) {
      await expect(browser.$(`.cm-editor .${cls}`)).not.toExist();
    }
  });
});
