# Chunk gaps and procedural spawn suppression

How Noita's per-chunk procedural content generator reserves an
un-spawned border on every 512x512 biome chunk, producing a 10-pixel
"seam" of empty space between adjacent chunks.

Ghidra symbols cited here are in `noita.exe` (Jan 25 2025 build).

## Executive summary

- Each chunk's `BiomeGen_GenerateProceduralContent` (`0x00868f70`)
  carves caves into a float density grid (initial value >= 0.5 = solid)
  and then walks serpentine paths that enqueue item/enemy spawns.
- **Structure painters** clamp their center positions to `[5, w-5]`
  in both x and y, so the outer 5-pixel ring of every chunk keeps its
  default density value (solid).
- **Spawn candidates** themselves are NOT position-clamped — but the
  spawn-enqueue helper only enqueues a spawn where
  `density[x, y] < 0.5`. Since the outer 5-pixel ring is never
  carved, spawns are effectively suppressed there.
- Two adjacent chunks each leaving their outer 5 px alone produces a
  **10-pixel seam** with no procedurally-placed items or enemies.
- This layer composes with (but is independent of) the
  `<CaveStructure aabb_min_x="5" aabb_max_x="507" ...>` constraint
  declared in biome XMLs (pixel-scene side).

## Call graph

```
Biome_InitializeFromConfig                 @ 0x0086b9f0
  └─ BiomeGen_GenerateProceduralContent    @ 0x00868f70
       ├─ BiomeGen_helper_00868400         @ 0x00868400 (structure trunk/branch)
       ├─ BiomeGen_PaintDensityDisk_Lerp   @ 0x00868190 (structure features)
       ├─ BiomeGen_PaintDensityDisk_Min    @ 0x00868020 (path carving)
       └─ BiomeGen_TrySpawnAtPathStep      @ 0x008682b0
            └─ BiomeGen_EnqueueSpawnAction @ 0x00871440
                 (pushes {x, y, fn_idx} onto the per-chunk spawn queue)

(later, per-chunk)
BiomeSpawnScripts_CallSpawnFunction        @ 0x0078c270
  └─ lua_pcall → Lua fn "spawn_small_enemies" or "spawn_items"
```

`BiomeSpawnScripts::GameLuaManager` owns the index → Lua-function-name
map; scripts register with `RegisterSpawnFunction(color, fn_name)`
(`LuaImpl_RegisterSpawnFunction @ 0x007a3410`).

## The density grid

`BiomeGen_GenerateProceduralContent`'s third argument (`param_3`,
local `local_10c`) points to a per-chunk struct that carries, among
other things, a `float[width * height]` density grid at offset `+0x18`
(indexed as `grid[y * width + x]`). The grid starts filled with a
"solid" default (≥ 1.0); all painting operations push values *down*
toward 0, which represents "open space / cave".

The magic number `0.5` (`DAT_0105361c`) is the threshold used by
`BiomeGen_TrySpawnAtPathStep`: a pixel is spawn-eligible only if
`density[x, y] < 0.5`.

## Phase 1 — Structure painting (clamped)

The main per-feature loop picks random column centers and clamps them
to `[5, width - 5]` before painting. Two representative clamp sites
in the decompilation:

```c
// Column center x (and similar for y), offset 0–200 in decomp
piVar3 = (int *)((int)local_f8 + -5);
if ((int)piVar15 < (int)local_f8 + -5) piVar3 = piVar15;
local_128 = (int *)&DAT_00000005;
if (5 < (int)piVar3) local_128 = piVar3;

// Horizontal-feature x, offset ~450
local_128 = (int *)(5 - (int)((double)((int)local_f8 + -9) * rng * DAT_01054058));
// DAT_01054058 = -1/INT_MAX, so this evaluates to [5, width - 4]
```

Where `local_f8 = *param_3 = width`. The clamped (x, y) then goes to:

- `BiomeGen_helper_00868400` — builds a trunk+branches structure.
- `BiomeGen_PaintDensityDisk_Lerp @ 0x00868190` — blends a disk of
  values toward a target via `lerp(grid, target, w²)`.

Because every structure's center is ≥ 5 pixels from any chunk edge,
and these disks have bounded radius, **the outer 5-pixel ring of the
chunk is never touched by any structure painter.** Its density stays
at the initial (≥ 1.0) value.

## Phase 2 — Path walker + spawn enqueue (not clamped)

After structures, the function runs up to two "path walker" passes
(gated on `BiomeConfig[+0x30]` and `+0x31`). Each walker takes ~120
steps; at each step:

1. Carve a small disk via
   `BiomeGen_PaintDensityDisk_Min @ 0x00868020` (min-merge towards a
   low target).
2. Advance (x, y) by a randomized offset (with direction flips via
   XOR against `0x80000000 = DAT_010546e0`).
3. With probability ~`5/101`, call
   `BiomeGen_TrySpawnAtPathStep @ 0x008682b0` — inside that helper:

   ```c
   // extract from 0x008682b0
   if (0 <= x && x < grid.width && 0 <= y && y < grid.height &&
       grid.density[y*width + x] < 0.5) {
       BiomeGen_EnqueueSpawnAction(grid_ctx, x, y, spawn_fn_idx);
   }
   ```

   `spawn_fn_idx` is chosen as 95% `spawn_small_enemies`, 5%
   `spawn_items` — string indices looked up once via
   `StringArray_FindIndex` on the `BiomeSpawnScripts` list. If either
   lookup fails (index <= 0), the spawn call is skipped entirely.

The walker's (x, y) **is not clamped**, but if it drifts into the
outer 5-pixel border (never carved by Phase 1), the density gate
rejects the spawn. Items do still get enqueued on path-carved pixels
that reach within 1–4 px of the edge *if* the walker's own disk pushed
that edge pixel below 0.5 — so the gap is approximately 5 px, not
exactly 5 px, and depends on walker parameters.

## Phase 3 — Execution

`BiomeGen_EnqueueSpawnAction @ 0x00871440` both stamps
`ctx.spawn_flags[y*w + x] = fn_idx + 1` (so `0` means "no spawn") AND
appends a `{x, y, fn_idx}` entry to the chunk's spawn-queue vector
(`ctx + 0x80..+0x84`). If the same (x, y) already has a queued entry
the fn_idx is overwritten in place — so only one spawn per pixel.

Later, the BiomeSpawnScripts system iterates that queue and calls
`BiomeSpawnScripts_CallSpawnFunction @ 0x0078c270` for each entry:

```c
lua_getfield(L, registry, fn_name);
// push int x, int y, int ?, int ?, bool ?
lua_pcall(L, 5, 0);
```

The Lua function is free to place whatever entity/item it wants,
typically via `EntityLoad(filename, x, y)`.

## Composition with `CaveStructure` AABBs

On the pixel-scene side, 102 `<CaveStructure>` elements across the
biome XMLs (`data.wak` unpack) set
`aabb_min_x="5" aabb_max_x="507"`. That's a separate, XML-driven
exclusion zone enforced by `PixelScene_PlaceEntryIfValid
@ 0x0087d7e0` (see `EDGE_NOISE_NOTES.md`). Both layers independently
exclude the outer 5-px border, so the chunk-seam gap is enforced twice
over.

## Implications for `noita-telescope`

Telescope already models pixel-scene placement and biome-map wobble.
If it ever wants to predict *where within a chunk* a procedural spawn
could land, the relevant rule is:

- **Zone:** `x ∈ [5, 506]`, `y ∈ [5, 506]` (inclusive, approximate —
  walker can drift 1–4 px inside from there).
- **Gate:** pixel must have been carved as cave (density < 0.5) by
  either a structure disk or the walker's own per-step disk.
- **Seed:** the per-chunk LCG state drives every decision, same seed
  that drives wobble offsets.

Without reproducing the density grid, telescope can't predict exact
spawn pixels, but a chunk bitmask with the outer 5-px ring masked
off is a conservative upper bound.

## Ghidra disassembly improvements

Applied in this session (`noita.exe`):

| Addr         | Was                           | Now                                   |
|--------------|-------------------------------|---------------------------------------|
| `0x00868020` | `BiomeGen_helper_00868020`    | `BiomeGen_PaintDensityDisk_Min`       |
| `0x00868190` | `BiomeGen_helper_00868190`    | `BiomeGen_PaintDensityDisk_Lerp`      |
| `0x008682b0` | `BiomeGen_helper_008682b0`    | `BiomeGen_TrySpawnAtPathStep`         |
| `0x00871440` | `BiomeGen_helper_00871440`    | `BiomeGen_EnqueueSpawnAction`         |
| `0x0078c270` | `Chunk_helper_0078c270`       | `BiomeSpawnScripts_CallSpawnFunction` |

Plate comments added to each of the above and to
`BiomeGen_GenerateProceduralContent @ 0x00868f70` describing the
phase structure, constants, and the structure-clamp / density-gate
composition that produces the chunk seam.
