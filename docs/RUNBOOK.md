# Harness runbook — how to run every tool

All of `scripts/` and `data/dumps/` are **gitignored** (dev-only; not shipped).
Companion docs: `ENTITY_HARNESS.md` (design), `HARNESS_FINDINGS.md` (backlog),
`HARNESS_ROADMAP.md` (plan), `data/dumps/README.md` (dump schemas).

Paths used below:
- telescope repo: `~/repos/noita-telescope`
- sweep/tp/noitad: `~/reverse/noita/noita-map`
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
# a) noitad daemon (once; check if already up)
curl -s http://127.0.0.1:8080/workers          # [] or {"workers":[...]}
cd ~/reverse/noita/noita-map && go run ./cmd/noitad   # if not running

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

## 5. Capture an entity fixture (live game + sweep)

```sh
cd ~/reverse/noita/noita-map && go run ./cmd/noitad   # daemon
cd ~/repos/noita-telescope
node scripts/capture_entities.mjs --seed=1 --quick                       # 20-tile smoke test
node scripts/capture_entities.mjs --seed=1 --regions=main,pw+1,pw-1 \
    --out=data/dumps/entities/1_ng0_broad --tile=1024                    # broad fixture
```
Force-open-chests is on by default (`forceOpen=true`). Output:
`data/dumps/entities/<seed>_ng<ng>/<region>/{tile_done,items,mobs,pixel_scenes}.ndjson`
+ `set.json`. `--dry-run` prints the sweep bboxes.

---

## Typical loops
- **Adjudicate a mismatch:** `npm run report` → read `scripts/mismatches.md` → launch
  live game (§2) → `biome-at-many` / `cell` (§3) to see what the game actually does
  at the coord → compare to the game Lua in the unpack.
- **Wobble change:** edit `js/`, `node scripts/verify.mjs --only=wobble`, then
  `npm run report` for the entity-scorecard delta.
- **Before/after a code change:** `npm run report` (after), then
  `git checkout <base> -- js/ && npm run report` (before), then `git checkout HEAD -- js/`.
