# Entity-accuracy harness

Compares telescope's predicted worldgen spawns against ground truth dumped from
a live Noita via the `sweep` tool (sibling repo `~/reverse/noita/noita-map`).
Noita worldgen is fully deterministic for a fixed game version, so this is an
**exact oracle**: the target is 100%, and every in-coverage mismatch is a real
telescope bug (or a mapping-table gap), never noise.

## Pieces

| File | Role |
| --- | --- |
| `lib/entity_identity.mjs` | Canonical record + `file ↔ (kind, detail)` identity map + PW geometry. The keystone both sides join on. |
| `capture_entities.mjs` | Drives `sweep` once per parallel-world region into a fixture *set*. |
| `verify.mjs entities` *(TODO)* | Loads a fixture set, generates telescope for the covered PWs, diffs, reports. |

## Canonical record

Both sources fold into one shape (`canonGame` / `canonTelescope`):

```
{ source:'game'|'telescope', kind, detail, x, y, cx, cy, pw, pwv, covered, raw }
```

- **kind** — normalized identity, the join key: `wand chest chest_great potion
  heart item gold perk enemy pixel_scene shop_slot other`.
- **detail** — sub-identity (material / spell / enemy basename / scene basename).
- **x,y** — global world pixel of the spawn point. **cx,cy** — `floor(coord/512)`,
  the coverage-mask unit (matches sweep's `cx,cy`).
- **pw,pwv** — parallel-world indices derived from x,y (one global frame; no PW
  tags needed in the dump — coordinates carry it).
- **covered** — is this a worldgen placement telescope models? Simulation junk
  (electricity, particles, projectiles, props, traps, enemy-dropped loot) is
  `covered:false` and excluded from scoring.

## Coverage & scoring model

The metric is only valid *inside what was actually swept*. `sweep` emits the
mask for free: `tile_done.ndjson` lists each completed tile and the chunks it
generated. **Coverage mask = ∪ tile_done.chunks across the fixture set**, in the
global chunk frame.

- **Recall** (does telescope reproduce real spawns): every game entity is
  in-mask by construction, so recall = `matched / (game entities whose kind ∈
  TELESCOPE_KINDS)`. Game kinds telescope doesn't model (`gold`, `perk`,
  `shop_item`) → `unmodeled` bucket, not a miss.
- **Precision** (are telescope's predictions real): **clip telescope to the mask
  first.** In-mask + no game match = a real false positive. Out-of-mask =
  "unobserved", excluded entirely — never penalized.
- **Per-PW coverage %** is a first-class output: it says *what fraction of the
  deterministic truth we've verified*, e.g. full main + PW±1 + heaven/hell, thin
  random swaths far out. Low coverage = "not checked yet", not "low confidence".

`CONTENTS_UNVERIFIABLE_KINDS` (chest, chest_great, shop_slot): a non-opening
camera sweep confirms the container's *placement* but not its rolled *contents*.
Telescope's predicted contents/stats for these are quarantined as
"unverifiable-by-sweep" until `sweep` is extended (below).

## The diff itself is the bug detector

Spawn coordinates + identity are enough — no zone pre-classification needed. The
risky telescope code (biome-edge wobble) doesn't need its own report axis,
because its failures *are* plain missing/extra rows:

- **Wobble** resolves a chunk to the wrong biome → the wrong spawn set there →
  shows up directly as missing (game had it, telescope didn't) or extra
  (telescope invented it). The `missing`/`extra` lists are the wobble bug report.
- **Pixel scenes** are a unit — the scene placement *and* the items it spawns.
  A scene also has bonus checks that sometimes suppress it entirely. So a
  mis-fired gate surfaces in the item diff: telescope emits a suppressed scene's
  items → extras; telescope suppresses one the game placed → missing. No special
  handling; the entity rows reveal it.

So the report's spine is just **matched / missing / extra**, bucketed by kind and
PW. Spatial clustering of mismatches does the triage for free — a cluster along a
biome boundary is a wobble bug; a cluster sharing a scene origin is a scene-gate
bug.

*(Optional, cheap triage later: annotate each mismatch with whether its chunk is
a wobble edge-strip, via the `wobble` section's `biomeEdgeNoiseFlag` machinery —
a column to sort by, not a prerequisite.)*

Region sampling still wants biome boundaries to exercise wobble, but that's about
*where you point sweep*, not about the diff. The `--quick` spawn box is a
workflow smoke-test (mostly one biome), not an accuracy run.

## Capturing fixtures

`sweep` is slow (camera-pans the whole bbox). Start small:

```sh
# in another terminal, from the noita-map repo:
go run ./cmd/noitad

# quick end-to-end smoke test — one small box near spawn:
node scripts/capture_entities.mjs --seed=1 --quick

# a real set once the workflow is trusted:
node scripts/capture_entities.mjs --seed=1 \
  --regions=main,pw-1,pw+1,heaven,hell,pw+7,pw-12
```

Output: `data/dumps/entities/<seed>_ng<ng>/<region>/{manifest,tile_done,*.ndjson}`
plus a `set.json` describing the regions captured (so the comparison side knows
its coverage). `--dry-run` prints the sweep commands + computed bboxes.

## `sweep` enhancement wishlist

Worldgen is deterministic and the game is fully introspectable, so coverage can
grow well past "placement of free items". Ranked by value:

1. **Freeze physics + AI right after spawn (ideal noise kill).** If nothing
   simulates post-spawn, the dump *is* the worldgen placement set — no traps
   firing, no enemies dropping loot, no entities drifting from their spawn
   point. `sweep` already exposes the hooks (`-disable-subsystems`, and
   `-headless` NOPs phase-6 subsystems); the in-game facilities for this exist
   but reportedly misbehave, so making them stable is the real work. **Fallback
   if they stay flaky:** a worldgen-vs-runtime provenance tag — the
   `lua_stack`/`native_stack` already record whether a spawn fired during
   chunk-load worldgen vs entity update, so the dump can be filtered to
   placements at the source instead.
2. **Container content resolution.** Chest loot isn't created until opened. If
   `sweep` can roll a chest's contents without opening (call the content fn, or
   open in a throwaway sim), the largest unverifiable bucket becomes scorable.
3. **Component dump for placed wands/potions** (lower priority — the wand/potion
   *rolls* aren't the risky code). Reading the configured wand spells/mana/stats
   and potion material would let the harness verify content/stats too, useful as
   a regression net but secondary to getting edge-zone *placement* right.

## Notes / TODO

- `TELESCOPE_KINDS` and the `ITEM_KIND_RULES` are a v1 seeded from a real seed-1
  sweep + the Noita entity XML tree. The first comparison run will surface
  mismatches (e.g. does telescope emit `gold`? does its `chest_great` align with
  `chest_random_super`?) — refine the map against those, don't guess ahead.
- Fixtures assume one Noita version (years-stable). If a game update moves
  worldgen, the harness lights up with mismatches → re-dump.
