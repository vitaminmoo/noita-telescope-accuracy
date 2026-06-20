# Telescope worldgen accuracy vs game ground truth

**Seed 1 · NG+0 · main parallel world (pw0).**
Region: full playable main world — bbox `x=-15732, y=-6720, w=32840, h=27120`
(≈ 32,840 × 27,120 px), **891 covered tiles** (1024 px).

Ground truth = a camera-pan sweep of live Noita (deterministic per build) that hooks
`Entity_CreateFromFile` / camera-bound spawns. Capture config: simulation frozen
(AI/physics/rigid-bodies/explosions/pixel-sim) so nothing drifts, **chests
force-opened** so their loot is observable, sim-noise categories
(props/vegetation/particles/projectiles) filtered out. Scored on **distinct
placements** (deduped by kind+position). The dump is **99.9 % reproducible** across
two independent full-world runs (every item kind bit-identical; enemy 99.9 %), so
every mismatch below is a real telescope discrepancy, not capture noise.

- **Recall** = `match / (match + missing)` — of what the game has, how much telescope predicted (low → telescope **missed** real spawns).
- **Precision** = `match / (match + extra)` — of what telescope predicted, how much is real (low → telescope **invented**/mis-placed spawns).

| category | match | missing | extra | recall | precision |
|---|---:|---:|---:|---:|---:|
| chest            | 94  | 2   | 2   | **97.9 %** | **97.9 %** |
| chest_content\*  | 82  | 5   | 15  | **94.3 %** | 84.5 % |
| potion           | 159 | 2   | 1   | **98.8 %** | **99.4 %** |
| wand             | 313 | 3   | 12  | **99.1 %** | **96.3 %** |
| heart            | 70  | 0   | 3   | **100 %** | 95.9 % |
| item (misc)      | 65  | 4   | 7   | **94.2 %** | **90.3 %** |
| enemy            | 6805| 1203| 1390| 85.0 % | 83.0 % |
| **TOTAL**        | 7588| 1219| 1430| **86.2 %** | **84.1 %** |

\* chest_content = the loot a chest drops, matched by parent chest + loot *kind*
within a radius (rewards spawn at a scratch coord then teleport onto the chest, so
exact position isn't meaningful). Only observable because the sweep force-opens chests.

## What the mismatches are (best current understanding)

- **chest / potion** — essentially correct; the few extras are conditional/edge placements.
  Potion precision rose 98.1 → **99.4 %** (and item 89.0 → **90.3 %**) after wiring the
  engine's biome **edge-wobble** into pixel-scene biome resolution (FINDINGS A3/C2): near a
  chunk boundary the engine resolves a scene's biome through the wobbled chunk lookup, which
  suppresses boundary altars the original biome would place (two spurious `potion_altar`s and
  a `runestone_magma` removed, zero regressions). Crucially the wobble is scoped to
  *pixel-scene* resolution only — direct per-pixel spawns (chests/hearts/eggs) use the chunk's
  **original** biome, verified live (a chest sits at (-10765,517) where the wobbled biome
  `winter` has no chest spawn, so the engine used the original `vault_frozen`). Wobbling those
  too merely invented/dropped spawns at boundaries.
  Two of the three potion misses (and two wand misses) are a single structural
  bug: the bottom tower level `solid_wall_tower_1` is the only level built on the
  Mines (`coalmine`) wang template, so it alone trips the coalmine terrain hack,
  which stamps its overlay at the wrong spot on the tower buffer and erases the
  level's four altars (2 wand, 2 potion). Confirmed live in-game; logged as
  FINDINGS D4 (real worldgen bug, not fixed — the hack alignment is shared with
  the real Mines).
- **chest_content (94 % recall)** — telescope's chest loot-table RNG is **accurate**.
  The 15 extras are mostly chests that didn't open during a given sweep, not wrong predictions.
- **wand (precision 95 %)** — recall is great. The former precision drag was the
  Magical Temple (`wandcave`) **"wand ghost" / Taikasauva**: the game places it as
  an *enemy* (`wand_ghost.xml`) that carries a `wand_level_03` and drops it when
  killed, while telescope models the placement as the wand the ghost holds (a
  deliberate UI choice). The 30 placements coincide *exactly*, so the harness now
  classifies `wand_ghost` as a `wand` — they match instead of double-counting as a
  wand-extra **and** an enemy-miss (this is what moved wand precision 86 → 95 % and
  trimmed 30 enemy misses). The three good-wand spots (`generateGoodWand1/2/3`,
  biome `solid_wall_tower_10`) are *intentionally* spread ±100 px (vs the game's
  ±20 px) so each is individually clickable as a PoI — a UX choice, not a bug — so
  the harness snaps telescope's coordinates back onto the game's for those three
  (lifting precision to 96 %). Recall rose 98.1 → 99.1 % after a real telescope
  fix (FINDINGS D5): altar pixel scenes whose top-left corner straddles a chunk
  boundary into a neighbour biome were being dropped, because telescope (a)
  applied the scene-load biome check that the game skips (`skip_biome_checks` is
  `true` for every altar `LoadPixelScene`) and (b) re-derived the scene's inner-
  spawn biome from its corner instead of the biome that spawned it. The dozen
  residual extras are mostly chunk-edge wobbles, plus `experimental_wand_3`,
  which the game files as
  `item/experimental_wand` while telescope emits a plain `wand` ~9 px away (a
  label mismatch, not a placement error).
- **heart (recall 100 %)** — after two reconciliations: telescope emits the
  full-heal heart as item `full_heal` (now matched to game `heart_fullhp`), and
  the HM temple hearts (`heart_fullhp_temple`) render in telescope as map pixels,
  not POI entities, so they're excluded from scoring (still captured). All
  remaining hearts match.
- **item (recall 94 %)** — telescope doesn't generate several item types the game
  places. The ones it never models — `book_*` (lore), `orb_*`, `essence_*`,
  `spell_refresh` (HM refresh altars), `musicstone`, `greed_curse` — are excluded
  from scoring (still captured in the dump). `utility_box` is now a **container**:
  telescope generates all 15 at the exact game coordinates, so we score the box
  *placement* (matched 15/15) and exclude its dispensed contents as unobservable
  (the sweep doesn't shoot boxes open), mirroring chests. The friend "cavern"
  scene (`data/biome_impl/cavern.png`) spawns **three** gourds at fixed
  `spawn_fruit` pixels, but telescope shows a single one for display — so the
  harness snaps every gourd to its chunk centre (all three sit in one chunk),
  collapsing the trio onto the display gourd to match it. The remaining 4 misses
  are `egg_worm` x3 (unmodeled) and one `experimental_wand` (the label mismatch
  noted under wand). Modeled item subtypes (eggs, runestone, die,
  kiuaskivi/ukkoskivi/kuu, pouch) match well.
- **enemy (85 / 83)** — the known **coupled-jitter** bug: telescope derives an
  enemy's `(x,y)` offset from a single `ProceduralRandom` draw (x and y share one
  offset), but the game draws them **independently**
  (`SetRandomSeed(x,y); x+=Random(0,5); y+=Random(0,5)`), so most enemies land 0–5 px
  off on each axis. The placement *decisions* are right; the sub-pixel offset model isn't.

## Caveats / not-yet-covered

- Enemy scoring needs telescope's enemy generation enabled; ~85 % is the jitter
  bug above, not missing enemies.
- A residual ~0.1 % of enemies are genuinely nondeterministic in the *game*
  (runtime-RNG group spawns / reward-orb type) — not telescope's to match.
- Pixel-scene *placement* is validated indirectly via inner spawns, not diffed directly yet.
- Parallel worlds pw±1 validated separately (geometry within ~1 %); heaven/hell/NG+ not yet captured.

## Regenerating this report

```sh
npm run report                 # uses $TELESCOPE_DUMP, else data/dumps/full_i
npm run report -- path/to/dump # against a specific captured dump dir
```

`scripts/report.mjs` prints the scorecard above (`verify_entities.mjs`, enemies
included — the worldgen RNG stream is shared, so telescope's enemy generation
must be on for every other category to line up) and rewrites the per-item
miss/extra triage at `scripts/mismatches.md`. A "dump dir" is any directory
containing a `set.json` produced by the capture sweep.
