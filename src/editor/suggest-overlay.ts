// Live suggesting-mode diff overlay (TA-OVERLAY/CARET, spec §9 / R-SUG-3).
//
// While a file is in suggesting mode (cm-1.2) this renders diff(baseline,
// current) as a READ-ONLY decoration layer: inserted spans styled in place,
// deleted spans shown as phantom widgets carrying the removed baseline text.
// It NEVER mutates the buffer — materialize is cm-1.4's job. This is a second,
// independent StateField, deliberately not entangled with the CriticMarkup
// decorations (those render committed marks; this renders pending plain-text
// edits not yet in the document).
//
// Baseline-into-per-view-state: the extension is registered once but CM6
// instantiates the field per EditorView, which can't see the file path from
// `create`. So `main` owns the truth (SuggestModeState) and pushes the baseline
// into each view via StateEffects (setSuggestBaseline / clearSuggestBaseline),
// re-syncing on toggle and on active-leaf / file-open. The field here is a
// passive per-view mirror.

import { EditorView, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";

import { diffToOverlay } from "../diff";

/** Push the suggesting-mode baseline for this view; turns the overlay on. */
export const setSuggestBaseline = StateEffect.define<string>();

/** Clear the baseline for this view; turns the overlay off. */
export const clearSuggestBaseline = StateEffect.define<null>();

/** Per-view mirror of the suggesting-mode baseline (null → overlay off). */
const suggestBaselineField = StateField.define<string | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestBaseline)) return e.value;
      if (e.is(clearSuggestBaseline)) return null;
    }
    return value;
  },
});

/**
 * Phantom rendering of deleted text: a zero-document-length widget showing the
 * removed baseline run struck through. Not interactive and not part of the
 * buffer — `ignoreEvent` + `pointer-events: none` (CSS) keep the caret and
 * clicks landing on the real adjacent character, not inside the phantom.
 */
class PhantomDeletionWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: PhantomDeletionWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = activeDocument.createElement("span");
    span.className = "tc-suggest-del";
    span.setText(this.text);
    span.setAttr("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildOverlay(state: EditorState): DecorationSet {
  const baseline = state.field(suggestBaselineField);
  if (baseline === null) return Decoration.none;
  const ops = diffToOverlay(baseline, state.doc.toString());
  if (ops.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  for (const op of ops) {
    if (op.kind === "ins") {
      ranges.push(Decoration.mark({ class: "tc-suggest-ins" }).range(op.from, op.to));
    } else {
      // side: -1 → the phantom renders just before the position, where the
      // deleted text used to sit (for a substitution, immediately before the
      // inserted span at the same offset).
      ranges.push(
        Decoration.widget({ widget: new PhantomDeletionWidget(op.text), side: -1 }).range(op.from),
      );
    }
  }
  // sort=true: a `del` point and an `ins` mark can share an offset; let CM6
  // order them by side rather than relying on emission order.
  return Decoration.set(ranges, true);
}

export function suggestOverlayExtension(): Extension {
  const overlayField = StateField.define<DecorationSet>({
    create(state) {
      return buildOverlay(state);
    },
    update(deco, tr) {
      const baseline = tr.state.field(suggestBaselineField);
      const baselineChanged = tr.startState.field(suggestBaselineField) !== baseline;
      // Recompute on any doc edit (word-level re-segmentation is the §9
      // accepted fidelity caveat: WYSIWYG-per-pause, not per-keystroke) or when
      // the baseline is pushed/cleared. Otherwise the cached set still maps 1:1.
      if (tr.docChanged || baselineChanged) return buildOverlay(tr.state);
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // baselineField must be ordered before overlayField so the overlay reads the
  // updated baseline within the same transaction.
  return [suggestBaselineField, overlayField];
}
