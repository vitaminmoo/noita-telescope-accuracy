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
(velocity, ai, character, box2d, joints, particles, cellsim, material,
rigidbody, …) so entities settle deterministically instead of wandering /
ragdolling off-screen. It does **NOT** pass `-headless`, so the renderer stays
on and you can watch the window pan through the world. Passing `--headless`
turns rendering off (faster, for unattended runs); `--no-freeze` disables the
subsystem freeze entirely.

> The pixel sim (sand/water/lava) is only **partially** stilled during a sweep,
> not fully paused: a sweep must keep `GridWorld_MainUpdate` running to stream
> chunks, and the threaded "Falling Everything" cell dispatch lives inside it —
> `cellsim`/`material` in the freeze list only damp it. That's fine for the
> entity fixtures (they match on entity spawns, not cells), and the producer's
> `--quiet-frames`/`--max-settle` settle absorbs the residual churn. The full
> pixel-world pause (`GRIDFREEZE`, see noita-puppeteer `inject/PROTOCOL.md`)
> stops streaming, so it **cannot** be used during a camera-panning sweep — it's
> only for static "pause and look" inspection, never for a re-dump.

Other flags: `--host=127.0.0.1:8088` (default; matches noitad),
`--tile=N` (smaller = thorough+slower), `--ng=N` for NG+, `--all-unlocks`
(on by default; pins the canonical fully-unlocked flag set), `--dry-run` prints
the sweep bboxes without running. Force-open-chests is on by default
(`--no-force-open` opts out). Output:
`data/dumps/entities/<seed>_ng<ng>/<region>/{tile_done,items,mobs,pixel_scenes}.ndjson`
+ `set.json`. Full-main-world sweeps take ~15–20 min per region.

---

## Typical loops
- **Adjudicate a mismatch:** `npm run report` → read `scripts/mismatches.md` → launch
  live game (§2) → `biome-at-many` / `cell` (§3) to see what the game actually does
  at the coord → compare to the game Lua in the unpack.
- **Wobble change:** edit `js/`, `node scripts/verify.mjs --only=wobble`, then
  `npm run report` for the entity-scorecard delta.
- **Before/after a code change:** `npm run report` (after), then
  `git checkout <base> -- js/ && npm run report` (before), then `git checkout HEAD -- js/`.
