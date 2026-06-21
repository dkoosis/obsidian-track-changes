// Text-capture modal for author-initiated marks (comment / substitute).
// Mirrors FinalizeModal: centered, snapshots the source at open so the caller
// can dispatch with `expectedSource` and abort on drift (E6 / R-APPLY-2). The
// command wiring (offset bridge, edit build, applyEditsToFile) lands in cm-5;
// this owns capture + validation only.

import { App, Modal, Notice, TFile } from "obsidian";
import { validateReplyText, validateSubstitution } from "./operations";

export type CaptureMode = "comment" | "substitute";

export interface CaptureResult {
  /** Comment body, or the replacement (new) text for a substitution. */
  text: string;
  /** Source snapshot taken at modal-open; pass as `expectedSource`. */
  source: string;
}

const HINTS: Record<CaptureMode, string> = {
  comment: "Inserted as a CriticMarkup note; your author prefix is added automatically.",
  substitute: "Replaces the selected text as a tracked {~~old~>new~~} substitution.",
};

export class AuthorCaptureModal extends Modal {
  private readonly source: string;
  private readonly mode: CaptureMode;
  private readonly selected: string;
  private readonly onSubmit: (result: CaptureResult) => Promise<void>;
  private value = "";

  constructor(
    app: App,
    file: TFile,
    source: string,
    mode: CaptureMode,
    selected: string,
    onSubmit: (result: CaptureResult) => Promise<void>,
  ) {
    super(app);
    this.source = source;
    this.mode = mode;
    this.selected = selected;
    this.onSubmit = onSubmit;
    this.titleEl.setText(
      mode === "comment" ? `Comment on "${file.basename}"` : `Replace in "${file.basename}"`,
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tc-capture-modal");

    contentEl.createEl("p", { text: HINTS[this.mode], cls: "tc-capture-hint" });

    if (this.mode === "substitute") {
      const orig = contentEl.createEl("p", { cls: "tc-capture-original" });
      orig.createSpan({ text: "Replacing: " });
      orig.createEl("code", { text: this.selected });
    }

    const input = contentEl.createEl("textarea", {
      cls: "tc-capture-input",
      attr: {
        rows: this.mode === "comment" ? "4" : "2",
        placeholder: this.mode === "comment" ? "Your comment…" : "Replacement text…",
      },
    });
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    // Enter submits (Shift+Enter for a newline in the comment body).
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);

    const buttons = contentEl.createDiv({ cls: "tc-capture-buttons" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = buttons.createEl("button", {
      cls: "mod-cta",
      text: this.mode === "comment" ? "Comment" : "Replace",
    });
    submit.addEventListener("click", () => this.submit());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const text = this.value;
    const error =
      this.mode === "comment"
        ? validateReplyText(text)
        : validateSubstitution(this.selected, text);
    if (error) {
      new Notice(error);
      return;
    }
    this.close();
    void this.onSubmit({ text, source: this.source }).catch((err) => {
      console.error("Capture apply failed", err);
      new Notice("Could not apply; see console.");
    });
  }
}
