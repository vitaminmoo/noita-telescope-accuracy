# noita-telescope-accuracy

An accuracy harness for [Noita Telescope](https://github.com/Lymm37/noita-telescope).
It scores telescope's predicted worldgen spawns against **ground truth captured from
the live game**, and — the headline feature — **diffs two git refs** so a change can
be stated as *"fixes N placements, regresses M"* instead of "trust me."

It lives in its own repo so it never touches the telescope source tree: telescope is
pulled in as a git submodule, and each ref under test is checked out into a throwaway
worktree. The only thing telescope itself needs is to be importable under Node
(headless), which is [PR #5](https://github.com/Lymm37/noita-telescope/pull/5).

## Quick start

```sh
git clone --recurse-submodules <this repo>
cd noita-telescope-accuracy
npm ci

npm run report                                  # score the pinned submodule ref
npm run compare -- <refA> <refB>                # diff two telescope git refs
```

`compare` checks out each ref in the `telescope/` submodule (detached worktree under
`.compare-wt/`, so its `js/` resolves this repo's `node_modules`), scores both against
the same fixtures, and prints a per-kind delta plus the exact placements each ref
**fixes** and **regresses**. It exits non-zero if the change introduces a non-enemy
regression — ready for CI.

```sh
# example: what PR #7 (accuracy fixes) does, over a headless baseline
npm run compare -- headless-import-support accuracy-headless
```

Both refs must be headless-importable; if one isn't, `compare` says so and points at
PR #5. The `accuracy-headless` branch on the fork is PR #5 + PR #7 combined, the
default the submodule is pinned to.

## What it measures

Telescope's `emitPoi` predictions vs the game's `sweep` dump, folded into one canonical
kind space and matched on `(kind, x, y)`:

- **recall** — % of the game's real spawns telescope predicts
- **precision** — % of telescope's predictions that are real

The full model — what categories the game dumps, how each maps to a telescope category,
and the **exceptions layer** (everything deliberately not scored, with the reason) — is
in [`docs/CATEGORY_MODEL.md`](docs/CATEGORY_MODEL.md). The invariant: anything that
survives canonicalization **and** every exception is a real mismatch to fix in telescope.

The ignore rules are declared in one place, `src/lib/exceptions.mjs`.

## Layout

```
telescope/            git submodule — the code under test (any ref via compare)
fixtures/             committed game ground truth (the oracle); see fixtures/README.md
src/                  the harness
  report.mjs          score one ref → scorecard + mismatch triage
  compare.mjs         score two refs → fixed/regressed delta
  verify_entities.mjs the scorer (--json for machine output)
  mismatch_report.mjs per-placement triage
  lib/telescope.mjs   bridge: imports telescope js/ from $TELESCOPE_DIR (swappable per ref)
  lib/entity_identity.mjs   category mapping (game file ↔ telescope category)
  lib/exceptions.mjs        the ignore layer (what's not scored, and why)
producers/            scripts that need the LIVE game to (re)generate fixtures
docs/                 the model, findings, runbook
```

## Regenerating fixtures (needs the live game)

The committed fixtures are enough to run `report`/`compare`. Re-capturing them needs a
running seed-1 Noita plus the `sweep`/`noitrainer` tooling — see `producers/` and
`docs/RUNBOOK.md`. Fixtures are committed directly (git, ~28 MB); move to git-LFS if they
grow.

## Roadmap

CI (a GitHub Action that runs `compare <base> <pr-head>` and comments the delta on
telescope PRs) is designed for but not yet wired — `compare`'s `--json`-backed output and
non-zero-on-regression exit are built for it. See `docs/HARNESS_ROADMAP.md`.
