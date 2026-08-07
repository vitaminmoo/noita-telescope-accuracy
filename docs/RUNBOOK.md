# Harness runbook — how to run every tool

All of `scripts/` and `data/dumps/` are **gitignored** (dev-only; not shipped).
Companion docs: `ENTITY_HARNESS.md` (design), `HARNESS_FINDINGS.md` (backlog),
`HARNESS_ROADMAP.md` (plan), `data/dumps/README.md` (dump schemas).

Paths used below:
- this harness repo: `~/repos/noita-telescope-accuracy` (producers, src, fixtures)
- telescope submodule: `~/repos/noita-telescope-accuracy/telescope` (or standalone `~/repos/noita-telescope`)
- sweep/tp/noitad: `~/repos/noita-puppeteer` (symlinked at `~/reverse/noita/noita-map`); noitad on **:8088**
- noitrainer (live memory reader): `~/repos/noitrainer`
- game unpack (authoritative Lua/PNGs): `~/reverse/noita/noita_Jan_25_2025_15:55:41/data/data.wak.unpacked`

---

## 1. Entity accuracy report (the scorecard) — no live game needed

```sh
cd ~/repos/noita-telescope
npm run report                  # default fixture data/dumps/full_i (seed 1, main region)
npm run report -- path/to/dump  # a specific captured dump dir
```
Prints the per-kind scorecard (matched/missed/extra, R/P) and writes
`scripts/mismatches.md` (one row per miss/extra, with chunk-edge + ⚠wobble tags).
`report.mjs` runs `verify_entities.mjs` then spawns `mismatch_report.mjs`.

**Requires** `package.json` to have `"type": "module"` + a `report` script
(`node scripts/report.mjs`). That edit lives in the `potion-y-offset-test` working
tree and is deliberately NOT in PR #7 (it references gitignored files).

Wobble-resolver validation (no live game):
```sh
node scripts/verify.mjs --only=wobble                                  # default fixture
node scripts/verify.mjs --only=wobble --resolutions=data/dumps/biome_at_seed1.ndjson.gz
```

---

## 2. Launch a live seed-1 game (for ground-truth queries)

```sh
# a) noitad daemon on :8088 (once; check if already up)
curl -s http://127.0.0.1:8088/workers          # [] or {"workers":[...]}
cd ~/reverse/noita/noita-map && go run ./cmd/noitad   # if not running (symlink -> noita-puppeteer)

# b) spawn + teleport a seed-1 world; HOLDS the worker alive (Ctrl+C to quit)
/tmp/noita-tp -seed 1 -x <wx> -y <wy>          # binary built from cmd/tp
#   biome grid loads at world init, so any -x/-y works for biome queries;
#   teleport near a coord when you need that chunk's CELLS loaded.
#   run in background and poll the log for "Press Ctrl+C to quit".

# teardown (matches only tp, not this shell)
ps -eo pid,args | grep noita-tp | grep -v grep | awk '{print $1}' | xargs -r kill -INT
```

## 3. noitrainer-cli (reads the live game's memory)

```sh
cd ~/repos/noitrainer && go build -o /tmp/noitrainer-cli ./cmd/cli
/tmp/noitrainer-cli <cmd>      # auto-finds the running noita.exe
```
Useful commands:
- `biome-flags` — per-chunk `{cx,cy,name,xmlName,wobbleEligible,…}`
- `biome-at-many` — reads `wx wy` lines on stdin → resolved biome per coord
  (`original`/`resolved`/`wobbled`/`wobbleType`/`neighborDir`)
- `biome-at <wx> <wy>` — single coord
- `cell <wx> <wy>` — the **terrain oracle**: material at a pixel (e.g. `0 (air)` vs
  solid). Used to check whether the engine carved a path through a spawn pixel.
- `pixel-scenes` — queued pixel scenes in the BiomeGrid
- `entities-dump` — all loaded entities (near the player's loaded chunks)

## 4. Biome wobble dumps (live game + generate.mjs)

```sh
cd ~/repos/noita-telescope
/tmp/noitrainer-cli biome-flags | gzip > data/dumps/biome_flags_seed1.ndjson.gz
node scripts/generate.mjs sample-coords --mode=dense-diff --step=2 \
    --input=data/dumps/biome_flags_seed1.ndjson.gz > /tmp/coords.txt
/tmp/noitrainer-cli biome-at-many < /tmp/coords.txt | gzip > data/dumps/biome_at_seed1.ndjson.gz
```
`--mode`: `edges` (committed 16px sub-grid), `dense` (full edge zones),
`dense-diff` (only chunk edges facing a different-biome neighbour — the
wobble-flip-relevant set). See `data/dumps/README.md` for schemas, and
`EDGE_NOISE_VERIFICATION.md` for the 6.38M-coord full-density validation.

## 5. Re-dump entity ground-truth fixtures (live game + sweep) — physics off, rendering on

This is the canonical way to (re)capture the live-game ground truth the
scorecard (§1) scores telescope against. It drives the `sweep` tool through
noitad, panning the camera to force worldgen and logging every spawn.

```sh
# a) noitad daemon on :8088 (once). The sweep/noitad code lives in
#    noita-puppeteer; ~/reverse/noita/noita-map is a symlink to it.
curl -s http://127.0.0.1:8088/workers                 # [] or {"workers":[...]}
cd ~/repos/noita-puppeteer && go build -o noitad ./cmd/noitad && ./noitad   # if not up
#   (noitad default port is :8088; override with NOITAD_ADDR / -addr.)

# b) run the producer from THIS repo (it shells out to `go run ./cmd/sweep`)
cd ~/repos/noita-telescope-accuracy
node producers/capture_entities.mjs --seed=1 --quick                        # 20-tile smoke test
node producers/capture_entities.mjs --seed=1 --regions=main,pw+1,pw-1 \
    --out=data/dumps/entities/1_ng0_broad --tile=1024                       # broad fixture
```

**Physics off, rendering ON — the default, and what you want here.** The
producer spawns each worker with a built-in `disableSubs` freeze list
(velocity, ai, character, box2d, joints, particles, cellsim, simfreeze,
rigidbody, …) so entities settle deterministically instead of wandering /
ragdolling off-screen. It does **NOT** pass `-headless`, so the renderer stays
on and you can watch the window pan through the world. Passing `--headless`
turns rendering off (faster, for unattended runs); `--no-freeze` disables the
subsystem freeze entirely.

> **Pixel-sim (sand/water/lava) during a sweep — two freeze knobs, do not
> confuse them:**
> - `cellsim` NOPs `GridWorld_StepSimulation` (the single-threaded entry). The
>   threaded "Falling Everything" cell dispatch bypasses it, so `cellsim` **alone
>   barely dampens** liquid motion. This is the origin of the old "material
>   doesn't freeze" lore. Kept in the list — it's a different function, no
>   conflict.
> - `simfreeze` gates all four per-cell-class step methods (fire / gas / liquid /
>   solid) behind a flag while leaving the render raster live, so it stops the
>   gravity-driven cell motion **regardless of caller** and the world still
>   **draws and captures** under a moving camera. Sweep-safe; installed race-free
>   at DllMain via the disable-subsystems env token. Confirm it took by grepping
>   the worker's `noita_hook.log` for `simfreeze -> cell sim frozen`.
>   (It supersedes the older fire-only `material` NOP of the same step entry —
>   the two **cannot** coexist, they patch the same bytes, so the list carries
>   `simfreeze` *instead of* `material`, never both.)
>
> Either way the entity fixtures match on entity **spawns**, not cells, and the
> producer's `--quiet-frames`/`--max-settle` settle absorbs residual churn.
>
> Do **not** reach for `GRIDFREEZE` (noita-puppeteer `inject/`, the only *proven*
> total pixel-sim pause): it halts `GridWorld_MainUpdate`, which also stops chunk
> streaming, so it **cannot** be used during a camera-panning sweep — it is
> static "pause and look" inspection only, never a re-dump.

Other flags: `--host=127.0.0.1:8088` (default; matches noitad),
`--tile=N` (smaller = thorough+slower), `--ng=N` for NG+, `--all-unlocks`
(on by default; pins the canonical fully-unlocked flag set), `--dry-run` prints
the sweep bboxes without running. Force-open-chests is on by default
(`--no-force-open` opts out). Output:
`data/dumps/entities/<seed>_ng<ng>/<region>/{tile_done,items,mobs,pixel_scenes,chest_opens}.ndjson`
+ `set.json`. Full-main-world sweeps take ~15–20 min per region.

> **`chest_open` MUST stay in `--types` (it is, by default — do not drop it).**
> With force-open on, the sweep emits one `chest_open` marker per force-opened
> container into `chest_opens.ndjson`, recording `open_status` +
> `converted_to`. This is what lets a chest that opened but dispensed **nothing
> an entity hook can see** — ~7% roll `bomb_small` (under `entities/projectiles/`,
> dropped by the noise filter) and ~3% `EntityConvertToMaterial(chest,"gold")`
> (turns to gold *pixels*, no entity) — **pair** in `scoreChestContents` instead
> of scoring as an unpairable extra. `cmd/sweep`'s own `-types` default is all
> four categories, but the producer passes `--types` explicitly and thus
> overrides it, so its default list here **must** include `chest_open`. A fixture
> with no `chest_opens.ndjson` will show phantom bomb/gold `chest_content`
> extras — if you see that, you captured with a stale/narrowed `--types`.
> (The committed `full_24`/`full_786433191`/`full_i` fixtures all carry it.)
>
> **If `chest_opens.ndjson` exists but is EMPTY (0 lines) while `items.ndjson`
> has `chest_eid` rewards: stale hook DLL, not a `--types` problem.** The
> `chest_open` marker is emitted by `noita-puppeteer`'s hook; an
> `inject/noita_hook.dll` built before commit `1b98017` opens chests and
> dispenses loot but never emits the marker. Confirm with `strings
> ~/repos/noita-puppeteer/inject/noita_hook.dll | grep 'category":"chest_open'`
> (empty ⇒ stale). Fix: `make -C ~/repos/noita-puppeteer/inject`, then recapture
> — noitad copies the DLL into each worker at spawn, so **no noitad restart is
> needed**, just a fresh sweep. (Diagnostic ladder: worker `noita_hook.log` shows
> `force-open: opened chest` > 0 → force-open works; capture log
> `grep '"category":"chest_open"'` == 0 → markers never reached the sweep → the
> DLL lacks the emit code.)

---

## Typical loops
- **Adjudicate a mismatch:** `npm run report` → read `scripts/mismatches.md` → launch
  live game (§2) → `biome-at-many` / `cell` (§3) to see what the game actually does
  at the coord → compare to the game Lua in the unpack.
- **Wobble change:** edit `js/`, `node scripts/verify.mjs --only=wobble`, then
  `npm run report` for the entity-scorecard delta.
- **Before/after a code change:** `npm run report` (after), then
  `git checkout <base> -- js/ && npm run report` (before), then `git checkout HEAD -- js/`.
