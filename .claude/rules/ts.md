# TS Rules — obsidian-track-changes

*Operational gates for this codebase. Architecture/conventions live in `CLAUDE.md` — don't duplicate, read it first.*

## Stack

TypeScript strict · ES2018 · CJS bundle (Obsidian req) · esbuild · plain-Node `.mjs` tests (no framework).

## Gates — run before "done"

```sh
npm run typecheck    # tsc --noEmit -skipLibCheck — must pass
npm test             # all test files sequentially — must pass
npm run build        # tsc + production bundle — for release
```

‡ Code changed → typecheck + test green before handing off. ✗ claim done on red.
‡ New mutation/edit logic → add a `.mjs` test under `test/` (copy an existing one's shape).

## Invariants (hard contracts)

‡ ✗ bundle `obsidian` or `@codemirror/*` — they're externals in `esbuild.config.mjs`.
‡ Every `SourceEdit` sets `expected` (+ `before` for insertions) → survives `rebaseEdits`. ✗ raw stale offsets.
‡ Source edits non-overlapping — `applyEdits` throws otherwise.
‡ Rename a settings key → write a migration in `loadSettings()`.
‡ Thread/prefix semantics changed → update CLAUDE.md *and* `docs/SKILL.md` together.

## Tools

`rg`/`fd`/`bat` not grep/find/cat. `gh` for PR/issue. `bd` for tasks (✗ TodoWrite).
Remotes: `origin`=dkoosis (yours), `upstream`=philphilphil.
