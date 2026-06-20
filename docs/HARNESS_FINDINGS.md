# Entity-harness findings & open questions

Living log of everything the telescope-vs-`sweep` entity diff has surfaced:
fixed bugs, characterized-but-unfixed bugs, things we don't fully understand or
don't yet trust, and things we deliberately exclude from scoring (with the
reason). Companion to `ENTITY_HARNESS.md` (design) — this file is the backlog.

Coordinate/term reminders:
- `sweep` = `~/reverse/noita/noita-map/cmd/sweep`, camera-pans a bbox, hooks
  `Entity_CreateFromFile` / `PixelScene_FindOrAdd`, emits per-category NDJSON +
  `tile_done` coverage. Drives `noitad`.
- Harness: `scripts/verify_entities.mjs` (+ `lib/entity_identity.mjs`,
  `lib/telescope_entities.mjs`), `scripts/capture_entities.mjs`.
- Fixtures (gitignored): `data/dumps/entities/1_ng0` (quick, 20 tiles),
  `data/dumps/entities/1_ng0_broad` (full main + pw+1 + pw-1, 891 tiles/region).
- Diff key is `(kind, round(x), round(y))`; detail/material is secondary.

**See `RUNBOOK.md` for how to run every tool referenced below.**

Current accuracy (`npm run report`, seed-1 `full_i`, 3685 chunks; after all §A
fixes + the gitignored §B harness-classification fixes):
wand R99.1/P96.6 · potion R98.8/P99.4 · chest R97.9/P97.9 · heart R100/P95.9 ·
item R94.2/P97.0 · chest_content R94.3/P84.5 · enemy R85.0/P83.0 ·
**TOTAL R86.2/P84.2 · NON-ENEMY R98.0/P95.8**.
(Older `1_ng0_broad` 3-PW numbers, pre-PR/pre-classification — re-run to refresh:
chest R99.2/P92.6 · wand R96.2/P91.0 · potion R95.4/P91.8 · heart R90.7/P96.0 ·
item R47.9/P73.0 · enemy R74/P63.)

PR #7 (`worldgen-accuracy-fixes` → Lymm37/main = the §A fixes) moved non-enemy
worldgen R 70.2→98.0 / P 68.8→95.8 (+222 matched, −222 missed, −221 invented).

## Remaining issues (assumed causes) — telescope-side only

1. **Enemy positions off** (the bulk of remaining error) — `spawnWithRandomOffset`
   derives x and y from ONE shared PRNG draw; the game does two independent
   sequential draws.
2. **Invented wand/heart/chest at chunk edges** — telescope omits the engine's
   random path/cave carving (`WangTile_ProcessAndPaintToWorld`), so magic pixels
   the game carves away survive and spawn. (full porting spec: §D5)
3. **4 tower altars missing (`solid_wall_tower_1`)** — the Mines-entrance coalmine
   overlay is stamped at the tower buffer's (0,0) and erases its altar pixels. (§D4)
4. **`ukkoskivi` invented / `egg_worm` missed (biome flips)** — the per-mechanism
   wobble dispatch checks only the wobbled biome's colour MAP, not its actual spawn
   IMAGE at that pixel. (§A4b)
5. **`runestone_light` invented (rainforest)** — a missing per-biome spawn-
   eligibility gate (`0x50a000`).
6. **`egg_worm` ×2 / `experimental_wand_3` missed** — item types not modelled. (§E)
7. **`wand_unshuffle_03 (-9030,516)` missed** — single uncharacterized vault_frozen
   wand.
8. **2 holy-mountain temple chests missed** — player-conditional spawns not modelled.

---

## A. Fixed (telescope) — shipped as PR #7

These all landed in **PR #7** (`worldgen-accuracy-fixes` → `Lymm37/noita-telescope`
main): the 8 accuracy commits cherry-picked clean off main (no headless-infra, no
`package.json`). The SHAs cited below (`a500e5c`, `3ed2a4a`, …) are the originals on
the dev branch `potion-y-offset-test`; PR #7 carries cherry-picked equivalents.

### A1. Potion Y clobbered by spawnItem — FIXED (`a500e5c`)
`js/potion_generation.js` `spawnItem` did `item['x']=x; item['y']=y;` after
`generateItem`, discarding the `y-2` that `createPotion` had applied. Guard now
only fills missing coords. Game ref: spawn path `spawn_potions` →
`spawn_from_list("potion_spawnlist", ...)`. Fix took potion 0%→100% on the quick
fixture.

### A2. potion_spawnlist offsets on all item branches — FIXED (`3ed2a4a`)
The game's `data/scripts/item_spawnlists.lua` `potion_spawnlist` applies a
per-entry `offset_y` at `EntityLoad(x, y+offset)`: potion/pouch/eggs/brimstone/
thunderstone/broken_wand/gold_orb = `-2`, runestone = `-10`, die = `-12`,
mimic_potion = `0`. `spawn_from_list` seeds `SetRandomSeed(x+425, y-243)`, which
`js/potion_generation.js` `generateItem`/`generateItemLiquidcave` already mirror.
The port had applied the offset ONLY inside `createPotion`/`createPowderPouch`;
every other branch returned raw `y`. Added the per-branch offsets. Item
precision 33→100% (egg false-extras gone), recall 14→43% on the quick fixture.

### A3. Altar pixel scenes dropped at biome chunk boundaries — FIXED
Wand/potion altars whose pixel-scene **top-left corner** lands a few px across a
chunk boundary into a different biome were silently dropped. Two bugs in series:
1. **Scene-load corner check** (`js/spawn_functions.js`, the
   `spawn_wand_altar`/`spawn_potion_altar` branches): they called
   `loadPixelScene(..., checkBounds=true)`, so `loadPixelScene` rejected the
   scene when `getBiomeAtWorldCoordinates(corner).biome !== spawningBiome`. But
   the game loads EVERY altar with `skip_biome_checks=true` — confirmed in all
   biome `.lua` (`LoadPixelScene(..., "", true)`). Flipped the four altar calls
   to `checkBounds=false`.
2. **Inner-spawn biome re-derivation** (`js/poi_scanner.js`, the newPixelScenes
   loop): once a scene loads, its inner spawns (the wand/potion pixel) were
   resolved against the biome at the scene's CORNER. A corner in `solid_wall`
   (no spawn map) dropped the inner item. Now prefers the owner biome
   (`pixelScene.biome`), falling back to the corner for nested scenes.
Seed-1 main: recovered the two `wand_level_05_better` + one more (wand R 98.1→
99.1%) and one potion (R 98.1→98.8%). Ground-truth via Ghidra + Lua: the engine
path generator (`BiomeGen_GenerateProceduralContent`) only ever places the two
hardcoded defaults `spawn_small_enemies`/`spawn_items`; everything else is the
per-pixel `BiomeSpawnScripts_LookupSpawnFunctionByColor` dispatch over each
biome's `RegisterSpawnFunction` map. `spawn_potion_altar` (`0x50a000`) is the
shared default from `biome_scripts.lua` (`ProceduralRandom(x,y) > 0.65`); it is
broadly correct (disabling it collapses potion recall 158→3), so it stays.

KNOWN RESIDUAL (1 false extra) — original wobble hypothesis DISPROVEN:
at the rainforest/rainforest_open seam telescope emits a `potion_altar` at
`(390,7672)` → `runestone_light` `(400,7673)` that the game lacks. Confirmed
against the LIVE game (tp seed 1 to the seam + noita-mcp): the running world has
exactly TWO `potion_altar.png` scenes total — `(1330,822)` and `(280,752)` —
neither near here, so this is genuinely spurious (not a sweep-capture miss).
This was originally blamed on edge-noise wobble, but a precise live re-probe
(2026-06) refutes that: the cy28(`rainforest`)/cy29(`rainforest_open`) chunk
boundary is at **y=7680**, so BOTH the altar `(390,7672)` and the runestone
`(400,7673)` sit in cy28 and `biome_at` resolves them to `rainforest` with **no
wobble flip** — and telescope (`getBiomeAtWorldCoordinates`, wobble on or off)
agrees, returning `rainforest` too. Wobble only flips pixels at y≥7680
(e.g. `(395,7687)` cy29→cy28), which is NOT where the altar lands. So telescope
and the engine agree on the biome here; the spurious altar is a **rainforest
`potion_altar` spawn-eligibility discrepancy**, not an edge-noise symptom — still
unfixed, now correctly reclassified (needs a separate look at the `0x50a000`
spawn gate / spawn pixel, NOT the wobble math). See A4 for the wobble work that
DID land (a different set of 3 boundary altar extras).

### A4. Biome edge-wobble wired into pixel-scene resolution — FIXED (2026-06)

The engine's "wavy edge" wobble (`js/edge_noise.js`, already 100%-verified vs the
84k-sample fixture and the live game) was computed in `getBiomeAtWorldCoordinates`
but discarded (`appSettings.enableEdgeNoise=false`). It's now opt-in via a per-call
`useWobble` arg (default = the old flag, so render/UI callers are unchanged) and
enabled at the **pixel-scene biome-resolution** sites only:
`poi_scanner.js` 286 (new pixel scenes) + 309 (detected spawns), and the
`pixel_scene_generation.js:248` recolor lookup.

**Scope was the whole story.** Enabling wobble everywhere (incl. `spawnSwitch` and
the pixel-scene placement corner-checks) was a net wash — it fixed boundary altars
but broke chest/heart/egg spawns and shuffled ~34 enemies. Live adjudication
(tp seed 1 + `biome_at_many` on every changed spawn) showed telescope's wobble is
**13/13 correct vs the engine**, so the breakage wasn't a resolver bug: direct
per-pixel spawns use the chunk's **ORIGINAL** biome in the engine (proof: a chest
at `(-10765,517)` sits where the wobbled biome `winter` has no chest spawn, so the
engine used original `vault_frozen`), and the placement corner-checks added 3 phantom
enemy extras. Restricting wobble to pixel-scene resolution gives a **pure** result:
−3 spurious boundary altar extras (`potion` `(-9089,3041)`, `potion` `(15851,8351)`,
`runestone_magma` `(-2145,1541)`), **zero regressions** across every category
(enemy counts bit-identical to baseline). Scorecard: potion precision 98.1→**99.4 %**,
item 89.0→**90.3 %**, TOTAL extras 1433→1430. Rollback is one-line per site.

Two follow-ups: (a) the harness `⚠wobble` tag in `mismatch_report.mjs` was firing on
chunk-edge *proximity* (≤12px), not actual flips — re-probing all 21 tagged rows live
showed 18 resolve to the same biome both ways. Retagged to fire only when telescope's
biome actually flips (wobbled vs un-wobbled): now 3 true flips, of which 2
(`ukkoskivi (-2065,1949)`, `wand (15355,2068)`) are per-pixel spawns where the *game*
uses the wobbled biome (excavationsite/desert) but telescope uses original — the OPPOSITE
of the chest/heart cases. So which biome a direct spawn uses depends on its mechanism
(per-pixel biome-script → wobbled; structure/scene → original); NOT yet fully reverse-
engineered, left as the next wobble question. (b) The `useWobble` default was changed from
`appSettings.enableEdgeNoise` to literal `false`, and the cosmetic map-render/hover calls
now pass `appSettings.enableEdgeNoise` explicitly. This decouples the "Enable Edge Noise"
checkbox to control ONLY the visual wavy-edge render — previously ticking it would also
re-enable the rejected broad spawn wobble (a footgun). Spawn correctness no longer depends
on the checkbox.

### A4b. Per-mechanism wobble dispatch — PARTIAL FIX (2026-06-04)

The "next wobble question" above is now answered and the resolver re-validated at full
density (6.38M seed-1 boundary pixels, `wrong biome: 0` — see
`EDGE_NOISE_VERIFICATION.md`). The per-mechanism rule is **live-confirmed**: per-pixel
biome-SCRIPT spawns (`spawn_potions`/`spawn_wands`/`spawn_wand`) dispatch on the WOBBLED
biome; structure/scene spawns (chest/heart/`*_altar`/pixel scenes) on the ORIGINAL.

Landed (`spawn_functions.js` `spawnSwitch`, gated by `WOBBLE_DISPATCH_FUNCS`): when one of
those script funcs sits on a biome-name flip, re-derive the function through the wobbled
biome's colour map and drop when that biome has no entry for the pixel's colour. This drops
`wand (15355,2068)` (fungiforest→desert; desert lacks the wand colour) with **zero
regression** (scorecard match 7588 / miss 1219 unchanged, wand extra 12→11, P84.1→84.2).

NOT yet fixed (both need real biome-image sampling, deferred):
- `ukkoskivi (-2065,1949)` extra — fungicave→excavationsite, but BOTH define `spawn_potions`
  @0xbca0f0, so the colour-map check keeps it; excavationsite's image has no such pixel there.
  Dropping unconditionally on any flip over-corrects (regressed a real wand + potion match
  that legitimately spawn at their flips), so the clean fix requires sampling the wobbled
  biome's spawn PNG at the world coord.
- `egg_worm (-1047,-477)` miss — mountain_tree→hills ADD direction (a flip exposing a NEW
  pixel telescope never scanned); also needs image sampling.

---

## B. Harness-side classification fixes (`scripts/lib/`, gitignored — not telescope bugs)

These were disagreements between how the game-side classifier and telescope label
the same entity; surfaced only at broad scale. All in `entity_identity.mjs`.

- **broken_wand**: game `broken_wand.xml` → `wand` (ITEM_KIND_RULES `^broken_wand`),
  telescope emits it from `generateItem` as `item`. `canonTelescope` now maps
  `item`+detail `broken_wand` → `wand`. Recovered 22 wand-miss + ~22 item-extra.
- **spell**: NO generic spell-card pickup is ever dumped (shop / utility_box /
  boss spells are not discrete worldgen entities — a broad seed-1 sweep had
  zero). `isContainerContent` now excludes any `detail==='spell'`. Killed 74
  false item-extras (73 from `utility_box`).
- **gold orb**: telescope `shiny_orb`/`greed_orb` == game `physics_gold_orb.xml`
  which classifies as `gold` (unmodeled, excluded). `canonTelescope` maps them →
  `gold`. Killed ~15 false item-extras.
- **shops are NOT container content**: shop physical stock (HM wand row) is placed
  as real dumped entities; only spell *purchases* aren't. Removed
  shop/laboratory/holy_mountain_shop/hourglass_shop from `CONTAINER_ORIGINS`;
  kept spell-slot exclusion. Took wand 75→100% on the quick fixture (telescope
  was generating the HM wand row correctly all along; the harness was hiding it).
- **physics dies + scene-modeled features (2026-06-04)**: telescope emits these as
  `item` rows, but the camera sweep never dumps any of them as items (confirmed: 0
  occurrences across every fixture), so they can only ever be false extras.
  `canonTelescope` now maps `item`+detail ∈ {`chaos_die`,`greed_die`,`paha_silma`,
  `treasure`,`portal`} → `unmodeled` (not in `TELESCOPE_KINDS`, excluded).
  Rationale: `chaos_die`/`greed_die` are potion_spawnlist physics pickups (like gold
  orbs); `paha_silma` is the unique `snowy_ruins_eye_pillar.png` pixel-scene;
  `treasure` is the `greed_treasure.png` pixel-scene (both verified by verify.mjs's
  pixel-scene section, never as dumped items); `portal` (`misc_generation.js:146`)
  the game never dumps as an item entity (confirmed by the maintainer). Result:
  item extras 7→2, **item P 90.3→97.0%**, zero regression (match 65 / miss 4
  unchanged). The only 2 remaining item extras are real spawn issues, not
  classification: `runestone_light (400,7673)` (0x50a000 eligibility gate) and
  `ukkoskivi (-2065,1949)` (wobble image-sampling, finding A4b).

---

## C. Understood but NOT fully trusted / not fully bottomed-out

### C1. Chest content & the "+510,683" — best understanding, NEEDS independent confirmation
**Status: user does not fully trust this yet. Treat as a hypothesis with strong
but incomplete evidence.**

Claim: the `+510,683` is NOT a placement offset. It's the chest's
`PositionSeedComponent` scratch coordinate where rewards are *born* (so
`potion.xml`'s position-seeded material RNG is deterministic), then immediately
teleported onto the chest.

Evidence:
- Game: `data/scripts/items/chest_random.lua` `drop_random_reward()` —
  `eid = EntityLoad(item, rand_x, rand_y); EntityApplyTransform(eid, x+rnd, y-4+rnd)`
  (born at scratch, moved to chest). `rand_x,rand_y` read from the chest's
  `PositionSeedComponent` in `on_open()`. Gold loads directly at `(x,y)` (no
  scratch), which is why gold never showed the offset.
- Telescope: `js/chest_generation.js:280` seeds at `x+509.7, y+683.1`; content at
  `x+510, y+683` (lines 353/356/361/364). Faithfully reproduces the scratch coord.
- `sweep` hooks `Entity_CreateFromFile`, so it records the **birth** position
  (scratch, e.g. `1235,10580`) before the teleport. Telescope and sweep therefore
  agree at the scratch coord; the rendered item ends up on the chest.
- In-game check (seed 1, live tp to `(725,9897)`): a pouch sits on the chest;
  `(1235,10580)` is solid `templebrick_static`, nothing there. Live entity dump:
  pouch entity 305 @ `(740,9912)` (≈ chest), and NO `ItemChestComponent` non-enemy
  entity present (chest already opened). Matches the "instant-open" reading.

**What's still unconfirmed / why not to trust it blindly:**
1. The `on_open` trigger during a passive sweep. We never open chests, yet content
   was dumped → the chest opened itself. Suspected cause: spawned into bad terrain
   / "doesn't fit" instant-open. NOT verified. To confirm: watch the chest entity's
   `on_open`/collision logic, or use the ghidra debugger
   (`debugger_set_breakpoint` on the chest Lua call / `EntityApplyTransform`) on a
   fresh worldgen of this chunk.
2. Whether the scratch offset is a constant `+510,683` or varies per chest. The
   `509.7/683.1` is one reverse-engineered value; we've only spot-checked a handful.
   `PositionSeedComponent.pos_x/pos_y` should be readable per-chest via
   `mcp__noita-mcp__components` to see if it's truly fixed.
3. Why only ~13/81 telescope chest-content rows match the sweep (the rest are
   false-extras). Hypotheses: (a) only some chests open during the sweep; (b)
   content *type* RNG mispredicted (telescope's loot table vs the game's). Not
   separated yet.

Harness consequence (decided): keep excluding chest content (`isContainerContent`)
— but the reason is "telescope's content-RNG is imperfect so scoring it adds more
false-extras than true-matches" (tried it: +13 matches, +68 extras, P drops ~4pts),
NOT "contents aren't dumped." Chest-content prediction is a real, separate, low
(~16%) accuracy axis if we ever want to chase it.

**RESOLVED (2026-06-04) — telescope chest content is actually ACCURATE.** Built a
`sweep -force-open-chests` mode that opens every chest the instant it's created
(in `hook_Entity_CreateFromFile`, while the entity is alive — a camera-only sweep
culls chests within ~1-2s, so post-load enumeration finds nothing; see noita_hook.c
`forceopen_chest_eid` + `g_sweep_force_open`). On a seed-1 force-open spot-dump,
`scripts/compare_chest_content.mjs` found **9/9 force-opened chests match telescope's
predicted loot KIND** (wands, potions, heart, bomb). The old "~16% / 13-of-81" was
NOT telescope mispredicting — it was that only ~7% of chests open during a passive
sweep, so 93% had no ground truth. With force-open supplying it, telescope's chest
loot-table RNG is correct. Force-open is RNG-safe: its perturbation of non-chest
worldgen (symdiff 160) is BELOW the sweep's own run-to-run capture nondeterminism
(baseline-vs-baseline symdiff 362). Remaining gap is minor: content POSITION — some
reward types (bomb, heart, misc via `drop_random_reward`'s explicit `{opt,x,y-10}`
branch) sit at chest-pos `y-10`, not the `+510,683` scratch coord; telescope should
mirror that per-type (same class as the potion offset fixes in A2). NEXT: un-exclude
chest content in the harness (score it against force-open dumps) + fix per-type
content offsets.

⚠ Capture nondeterminism — LARGELY a SETTLE problem (diagnosed 2026-06-04).
`scripts/dump_stability.mjs` diffs two identical sweeps over modeled+covered kinds
only. At the old default `-quiet-frames 20 -max-settle-ms 600`: TOTAL 226 vs 292
rows, only ~64% stable (potion 16↔25, wand 25↔35) — the 600ms cap cut tiles off
before worldgen/cascades finished, capturing ~HALF the entities. At
`-quiet-frames 30 -max-settle-ms 4000`: 521 vs 506, ~93% stable — chest/heart/item
100%, potion 95%, wand 97%, enemy 91.5%. So the existing broad fixture (captured at
600ms) is materially INCOMPLETE and its precision dings include dump gaps, not just
telescope errors — recapture it before trusting it. Canonical defaults now 30/4000
(`capture_entities.mjs`). Residual ~5-8% is mostly enemy (sim AI spawn variance) +
a few cascade items; push settle higher / freeze AI to chase it, or accept the
frozen-dump's count as truth. Two complementary levers landed: (a) long settle for
completeness; (b) dump-side noise filter (`sweep -filter-noise`, on by default in
capture) dropping props/verlet_chains/buildings/misc/particles/projectiles — a
strict subset of covered:false, so it can't hide a scored row; cut the dump ~59%
(1594→658 modeled rows on the 6-tile probe, 0 noise remaining).

THIRD lever — FREEZE SIM (2026-06-04, the big determinism win). Sweep with
`-disable-subsystems lighting,guns,velocity,ai,character,worms,pathfinding,box2d,
joints,particles,cellsim,explosions,explosions_queue,vphysics` (now the
capture_entities default). Worldgen spawns are unaffected (they fire at chunk gen,
not sim), but AI wandering, physics settling, off-screen explosions (bombs from
force-opened chests + shattering potions) and the pixel sim all stop → much less
nondeterministic churn AND less CPU so tiles settle faster (~22-25s/6 tiles).
Result on two frozen runs: ~98% run-to-run stable overall; clipped to the swept
bbox: items 98.2% (the residual is gold-PILE nugget COUNTS, which the set-based
chest scorer ignores), enemies 98.6%. Adding explosions specifically took potion
96.9→100% and wand 98.4→99.2%. `cellsim` IS applied (verified: GridWorld_Step-
Simulation @0x00718d50, hook line ~2927) — the small visible material settle is
the one-time deterministic chunk-gen settle, not ongoing sim, and doesn't move
scored entities. TUNED (2026-06-04): re-found the timing now that sim is frozen. Add `verlet`
(Lukki legs) + `game_effects` (fire) to the freeze set; quiet-detection then wins
at p50~740ms / p90~1430ms, so `-quiet-frames 20 -max-settle-ms 3000` gives 100%
run-to-run stability on a 36-tile multi-biome slice (every kind, two runs byte-
identical) at ~1.2s/tile (~43s/36 tiles → full 891-tile main world ≈18 min, NOT
hours). The cap is a BACKSTOP only (1/36 tiles touched 3000) — keep it generous,
it costs nothing on fast tiles; 1500 was too tight (6 heavy tiles, load up to
1.77s, cut off → 98.9%). NOTE Lukki/Hämähäkki spiders + occasional potion-break
fire are still visibly moving (non-alias movement path) but provably DON'T perturb
captured entities (100% identical) — cosmetic, not worth hunting. SCALE RESULT + THE REAL FIX = DEDUP (2026-06-04). At full main-world scale (891
tiles, two runs) the raw multiset stability was only ~91-96% with a systematic
run B > run A asymmetry — looked like the sim freezing wasn't enough. It was a RED
HERRING: the variance was DUPLICATE captures, not nondeterminism. The sweep
captures the same camera-bound spawn multiple times (its bucket re-drains as
overlapping tiles revisit the area), and how many times is timing-dependent.
Deduping by (kind, rounded position) — comparing DISTINCT placements, which is
exactly what telescope predicts (one row per spawn) — gives the true number:
full main world chest/heart/item/potion/wand = 100%, enemy 99.8%, TOTAL 99.8%
across two independent runs. So worldgen capture IS deterministic; you just must
count each placement once. Fix baked into `diff()` (verify_entities) and
`dump_stability.mjs` (both now set-dedup, not multiset). The `creatures` freeze
WAS still needed (boss acid shots are genuinely runtime-CREATED at distinct
positions, which dedup can't collapse); `material`/`simplephysics` freezes turned
out NOT load-bearing for the deduped/intent metric, BUT see the rigidbody update
below — the entity DRIFT did matter for the real-eid captures.

RIGIDBODY = the last movement source (2026-06-04, owner-diagnosed). The residual
real-eid (eid>0) enemy variance (~97% deduped) was NOT spawn RNG — owner's
hypothesis: entities spawn deterministically, then DRIFT (fixed-rate fall), get
SAVED at the moved position when the sweep's tile-walk unloads their chunk, and
RELOADED there → run-to-run position variance (also the duplicate captures). The
fix was finding the drift source: the Box2D rigid-body integrators
`PhysicsBodySystem_Update` (0x00c62970) + `PhysicsBody2System_Update` (0x00c92ba0)
— NOT covered by `vphysics` (which only NOPs VPhysicsBodySystem's BeginUpdate
framing). Added as group alias `rigidbody`. With it frozen, a 36-tile slice shows
real-eid enemies G=18/H=18 and ALL enemies 1022/1022 = 100.00% stable (was ~97%).
So freezing movement at the source makes even real-instantiation captures
deterministic — the intent-only stability hack (a brief dump_stability filter) was
reverted as no longer needed. Canonical disable set now includes `rigidbody`.
(The threaded pixel-sim material-fall is still unfrozen and still doesn't matter —
it doesn't move captured ENTITIES, only cells.) NOTE the
threaded pixel sim was never successfully frozen (StepSimulation + MaterialReaction
both NOP'd, material still falls via the threaded path) — and it doesn't matter.
CONCLUSION: canonical capture = frozen sim (creatures load-bearing; rest margin) +
20/3000 settle + force-open + noise filter, SCORED WITH POSITION-DEDUP → 99.8%
reproducible at full-world scale, ready to dump big. /tmp/full_g is a real
canonical corpus (full main world, seed 1). `scripts/dump_stability.mjs <dirA> <dirB>` re-checks stability;
`capture_entities.mjs` now defaults to all of this. (Add `-headless`/render-off for
the final unattended dump — even faster.)

**Update — manually confirmed in-game (seed 1, tp to 725,9897):** the pouch sits
right next to the spot telescope marks the chest; `(1235,10580)` agrees in BOTH
game and telescope as empty brick below the holy temple, down-and-right, nothing
there. So telescope is *effectively* right **assuming the chest doesn't fit on
spawn and auto-opens** (the unconfirmed trigger above). Owner call: LOW PRIORITY.
The correct path if/when we chase it: dig into the game's chest spawn/auto-open
behavior (disassembly + the chest entity's collision/`on_open` Lua) and compile
the exact spawning behavior, to decide whether we can improve the `sweep` HOOKS
(e.g. record the post-`EntityApplyTransform` position, or tag deferred-load
entities) rather than chasing it telescope-side. Not "fix telescope" — "make the
ground-truth capture report the resting position."

### C2. Enemy spawn jitter — coupled x/y offset (characterized, not fixed)
`js/spawn_functions.js` `spawnWithRandomOffset` (lines ~141-142, 149-150,
161-162) computes `px` and `py` from the SAME `ProceduralRandom(...)` call with
identical args → x and y share one offset (signature: extras with identical
fractional parts, e.g. `(176.57, 38.57)`). The game draws them INDEPENDENTLY:
`data/scripts/biomes/default.lua` `spawn_small_enemies` does
`SetRandomSeed(x,y); x=x+Random(0,5); y=y+Random(0,5)` (two sequential draws,
range `[0,5]`, seeded on `(x,y)` WITHOUT `ws+ng`); mines/coalmine route enemies
through the `spawn(g_...)` group helper with per-group offsets. Enemy is
R74/P63 with `--show-enemies`. A correct fix = replicate Noita's stateful
per-spawn-fn RNG; risky (could regress the 322 exact matches), biome-specific,
and exactly the biome-edge-wobble the project owner flagged as the trickiest
code. **Deprioritized by owner** (items/pixelscenes first).

### C3. Vertical PW constant 24570 vs 24576 (untested)
`entity_identity.mjs` uses `PW_HEIGHT = 48*512 = 24576`. Telescope's
`scanSpawnFunctions` reportedly uses `24570` vertically. This only matters at
heaven/hell (pwv ±1), which we have NOT captured yet — the diff would surface it
there as a uniform vertical mismatch. Confirm when heaven/hell fixtures exist.

---

## D. Small telescope position bugs (low volume, characterized, unfixed)

### D1. Cloud/sky special potions
`js/spawn_functions.js` ~300-304 and ~462-470 (the early `spawn_potion`/
`spawn_props3` branch with the `x+5` offset, plus the `alcohol`/`milk`/`beer`
literals). In the broad fixture these show as telescope generic `potion` at
`y+5` where the game has `potion_milk`/`potion_beer` at exact `y` — wrong
position (+5) AND wrong material. Cloud biome, low volume.

### D2. Static special wands off by tens of px
- Good wands: `js/static_spawns.js` ~415-417 `generateGoodWand1/2/3` at
  `(9884/9984/10084, 4360)` vs game `wand_good_1/2/3` at `(9964/9984/10004,4364)`
  (x off ~80, y off 4).
- Kantele: telescope `(-1634,-792)` vs game `(-1633,-783)` (dx -1, dy -9);
  `js/static_spawns.js` ~393 `generateWandKantele`.
- Flute: similarly slightly off.
Few each; cosmetic-ish but real coordinate divergences.

### D3. Temple full-HP hearts (recall gap)
`heart_fullhp_temple` at HM heart altars (e.g. `(-497,1357)/(-497,2893)`) — the
~22 heart misses. Telescope doesn't model this temple pickup. Real, small.

### D4. Tower bottom level (`solid_wall_tower_1`) altars clobbered by coalmine hack
The tower's deepest level mirrors the Mines: each tower level borrows a different
biome's wang tiles (tower_2→excavationsite, tower_3→snowcave, …) and **only
`solid_wall_tower_1` uses the `coalmine` wang template** ("Tower (Mines)",
`js/generator_config.js:27`; game `data/biome/tower/solid_wall_tower_1.xml`
declares `wang_template_file="data/wang_tiles/coalmine.png"`). Because of that it's
the *only* tower level that trips the coalmine terrain hack
(`js/tile_generator.js:117` / undo at `:358`, both special-casing
`solid_wall_tower_1` alongside `coalmine`), and the only one whose altars
telescope misses — levels 2–6 match.

`applyCoalmineHack` (`js/biome_hacks.js:48`) stamps the overlay
`data/wang_tiles/extra_layers/coalmine.png` at the biome buffer's **local (0,0)**
(with a `y+4` offset), overwriting pixels to solid `(1,1,1)` / air `(0,0,0)`. That
origin-stamp is a Mines-specific special case (it aligns with the hand-authored
Mines *entrance* near spawn); applied to the tower buffer it lands in the wrong
place and erases the tower_1 altar spawn pixels before the spawn scan runs.

Ground truth: seed 1 has **4 altars** in this level — `wand_altar` at
`(10120,9015)` and `(10340,8955)`, `potion_altar` at `(10530,8942)` and
`(10600,8992)` — all confirmed live in-game (tp to the cluster). Telescope emits
none. These are exactly 4 of the current main-region misses: potion
`(10540,8951)`+`(10610,9001)` and wand `wand_002 (10350,8963)`+
`wand_007 (10130,9023)`.

Experiment (disable the hack for `solid_wall_tower_1` at both `:117`/`:358`):
the hack IS implicated — disabling it un-suppressed 2 previously-missing spawns —
but it's **not** a clean toggle: the result was 2 plain `wand`/`potion` spawns at
the wrong positions, not the 4 `*_altar` pixel scenes. So there's residual
misalignment beyond the on/off switch (overlay footprint vs the tower's actual
spawn-pixel layout). A proper fix means getting the coalmine extra-layer
alignment right on the tower buffer — shared terrain code the real Mines depends
on — plus live re-verification. Logged, not fixed.

### D5. Near-edge over-spawns = spawn-image downscale misalignment at chunk seams (Ghidra-traced)

The ~18 non-enemy EXTRAS that are NOT wobble (wand-tail ~10, heart ×3, chest ×2,
portal/treasure/potion) all sit on the **negative chunk edge** (world offset
≥500, i.e. 1–12px from the chunk's far side), yet real matches coexist there — so
it is not a hard edge-block (blocking offset≥500 regressed 13 real matches). Ruled
out wobble too: the resolver works in CHUNK units (`edgeOffset` picks a biome-map
cell, not sub-pixels), and none of these coords flip chunk or biome.

Ghidra trace (noita.exe Jan-25-2025): the biome spawn image is downscaled **10×**.
`Chunk_RenderPixelScene @ 0x73c440` queues each biome spawn-function entry via
`SpawnQueue_AddFunction(..., entryX * 10, entryY * 10, ...)` — coords are
image-space × 10. `BiomeGen_GenerateProceduralContent @ 0x868f70` (prior-RE plate
comment) documents the **5px outer-border no-spawn zone** + `CaveStructure
aabb_min_x=5 / aabb_max_x=507`. So a 512px chunk = **51.2** spawn-image px; the
engine absorbs the 0.2 with per-chunk extra pixels.

**The coordinate hypothesis was REFUTED by the Ghidra trace (this is the useful
result).** `WangTile_ProcessAndPaintToWorld @ 0x8771a0` maps image↔world as a
plain continuous `image = world/10` (e.g. `(g_biomePathFindWorldPosMaxX -
g_biomePathFindWorldPosMinX) / 10`). So the engine's chunk-N image origin is
`floor(N×51.2)×10`. Telescope's `tileToWorldCoordinates` (`js/utils.js:42-45`,
`worldBaseX = 2560·floor(M/5) + (M%5)·510`, `M = chunkBaseX - center`) is
**provably identical** to `floor(M×51.2)×10` for all M (algebra: both equal
`M·510 + 10·floor(M/5)`; verified numerically M∈[-50,50], 0 mismatches). The
`div5/mod5` scheme exactly reproduces the engine's per-chunk 51/51/51/51/52
column cadence, and `findBiomeRegions` (tile_generator.js:30) adds the matching
extra pixel on the `x%5==-1` (≡ N%5==4) chunk. **Telescope's spawn coordinates are
bit-exact. The negative-edge over-spawns are NOT a coordinate/downscale bug.**

REAL CAUSE (next hypothesis, strongly supported by the same trace, not yet
fixed): the over-spawns are magic-pixel spawns the engine ERASES or REJECTS near
chunk edges via terrain/path processing that telescope doesn't fully replicate.
Evidence in `WangTile_ProcessAndPaintToWorld`: it stamps `0xff000000` (solid)
over path-clear regions and the coalmine entrance band (cols 0x8c–0x9e), and
`BiomeGen_GenerateProceduralContent`'s plate comment documents the 5px outer
border staying density≥0.5 (solid) + `aabb_min_x=5/aabb_max_x=507`. A magic pixel
that lands in solid border / cleared path produces no entity in-game (the Lua
spawn finds no valid cell), but telescope — which doesn't model terrain density —
emits it anyway. This predicts exactly the observed pattern: negative-edge
clustering (the high-side border), with matches coexisting wherever the terrain at
that pixel happens to be carved open. Confirming + fixing this means modeling the
engine's edge terrain/path-clear (contained to the wang/biome_hacks path, NOT the
core coordinate mapping) — much lower risk than the refuted D5a, but needs the
per-pixel terrain-density check telescope currently lacks.

REFINEMENT (live check 2026-06-04): tp'd to the extra `wand (-3585,8448)`
(`x%512=511`, last column of chunk 248) — the engine cell there is **0 (air)**,
NOT solid. So it is *not* a solid-terrain rejection; the spot is open yet the game
spawns nothing. That points the cause at the **biome-image reconstruction**:
telescope's wang-assembled spawn image carries a `spawn_wand` magic pixel at that
seam column where the engine's assembled image does not (the engine's
`WangTile_ProcessAndPaintToWorld` path-clear / herringbone differs from telescope's
`generateBiomeTiles`+`biome_hacks` at chunk edges). Matches at `x%512=511` exist
elsewhere (e.g. potion (12571,8191)), so it is content-divergence per seam, not a
blanket last-column skip. Verifying needs a per-chunk diff of telescope's assembled
biome image vs the engine's (large, contained to the wang subsystem). Coordinates
are NOT involved — that is settled.

CONFIRMED via wang-image diff (2026-06-04): dumped telescope's assembled spawn
image at the `wand (-3585,8448)` extra. Source is a `spawn_items` magic pixel
(0xff00) at buffer (154,236) → world (-3585,8457) that rolls a wand. The engine
cell there is **air (carved)** and the game dump has **nothing** within 30px. So
the engine carved a path through that region and ERASED the magic pixel before its
spawn scan; telescope keeps it and spawns. ROOT CAUSE: telescope's
`generateRawTileBuffer` (tile_generator.js) does the herringbone wang assembly +
`applyMainBiomeHack` (the single CENTRAL path) + coalmine hack, but NOT the
engine's full path/cave carving — `WangTile_ProcessAndPaintToWorld @0x8771a0` runs
`WangTile_FindEdgeConnections` (top+bottom edge connection points),
`WangTile_FindPathBetweenPoints`, `WangTile_GenerateRandomPath`, and
`WangTile_FloodFillColor` that carve many paths, erasing magic pixels on them. The
negative-edge clustering = the inter-chunk EDGE-connection paths carve near chunk
boundaries, so edge magic pixels are the ones most often erased — which telescope
(no edge-connection carving) leaves in place.

FIX = port the engine's wang path/cave generation into telescope's tile generator
so the same magic pixels get erased. LARGE self-contained worldgen-replication that
touches terrain for ALL chunks (must match the engine's path RNG + pathfinding
exactly), so it can both remove the ~18 edge extras AND perturb existing matches —
needs careful staged validation. It is the correct fix for the entire near-edge
over-spawn class, but a project, not a patch.

#### D5 — porting spec (for whoever picks this up)

**Goal:** after telescope's herringbone assembly, carve the same paths the engine
carves so magic pixels on those paths are erased (set to air/0x000000) BEFORE
`prescanSpawnFunctions` reads the buffer. The herringbone itself is already ported
(`stbhw_generate_image` == engine `WangTile_StbHerringboneGenerate`); the missing
stage is everything `WangTile_ProcessAndPaintToWorld` does AFTER herringbone.

**Engine call chain (noita.exe Jan-25-2025):**
`BiomeChunk_GenerateWangTiles @0x9a6300` → `WangTile_CreateHerringboneMap @0x879bf0`
→ herringbone gen + `WangTile_ProcessAndPaintToWorld @0x8771a0` (the orchestrator to
mirror). It takes `param_1`=image buffer (`width *local_190`, pixels at `+6`),
`param_2`=template-path string (e.g. "data/wang_tiles/coalmine.png"), `param_3`=
world origin, `param_4`=optional overlay (the coalmine extra-layer). RNG seed =
`g_worldSeed` (`local_18c`), advanced by the Park-Miller LCG (`*0x41a7`, mod
0x7fffffff).

**Engine functions to port, in order they run inside ProcessAndPaintToWorld:**
1. `WangTile_FindEdgeConnections @0x876980` — twice: once for the TOP edge
   (`y=0`) and once for the BOTTOM edge (`y=height-1`). Returns the list of
   connection points where paths must reach the chunk edge. *These edge paths are
   what carve near seams → the negative-edge erasures.*
2. Coalmine special case: if template == "data/wang_tiles/coalmine.png", stamp the
   entrance band (overlay `0xff420000`→`0x000000`) — telescope already approximates
   this via `applyCoalmineHack`/`applyMainBiomeHack`; reconcile, don't double-apply.
   Else clear the central start path-find area (`g_biomePathFindWorldPosMinX..MaxX`
   /10, 7 rows) — telescope's `applyMainBiomeHack` is the partial equivalent.
3. `WangTile_FindPathBetweenPoints @0x876680` — flood/A* pathfind through the
   density grid between connection points; marks the path cells.
4. `WangTile_GenerateRandomPath @0x876ce0` — fallback/extra random walk path
   (called when no path found, and to add cave variety). Uses the LCG.
5. `WangTile_FloodFillColor @0x876aa0` — flood-fill carved regions to `0x000000`
   (air). `WangTile_AddPathSegment @0x8ac540` appends segments.
The herringbone `WangTile_StbHerringboneGenerate @0x866b90` is already mirrored.
(Helpers: `WangTile_ClearSpawnAreaPixels @0x876eb0`,
`WangTile_FindPixelSceneSpawnAreas @0x876fb0`,
`WangTile_MarkSpawnAreaVisited @0x876e50`,
`WangTile_MeasureSpawnAreaExtent @0x876f50` — used for pixel-scene room reservation,
telescope's partial equivalent is `blockOutRooms`.)

**Telescope insertion point:** `js/tile_generator.js` `generateRawTileBuffer`
(~line 99, right after `stbhw_generate_image` fills `rawBuffer`, before the
`applyMainBiomeHack`/`applyCoalmineHack` calls). The new carving must run on
`rawBuffer` (mapW × outH, RGB) so the subsequent `prescanSpawnFunctions` sees the
carved (erased) magic pixels. The existing `js/biome_hacks.js` (`clearPath`,
`applyCoffeeHack`, `applyMainBiomeHack`) is the partial port — extend/replace it.

**RNG is the hard part:** the carve paths are seeded on `g_worldSeed` via the
Park-Miller LCG (`iVar = state*0x41a7 + (state/0x1f31d)*-0x7fffffff; if(<1)+=0x7fffffff`).
Telescope's `NollaPrng` already implements this LCG; the porting risk is getting the
exact call SEQUENCE and seed-advance order to match, or the carved paths land in
different places and perturb the 7588 matches. Decompile ProcessAndPaintToWorld's
RNG calls (`*0x41a7` sites) and mirror them call-for-call.

**Staged validation:** (a) port edge-connection + central path carving first, gate
on `npm run report` showing the ~13 negative-edge extras dropping with ≤ the same
match count; (b) add random-path carving, re-check; (c) the oracle for "did I carve
the right cells" is the live game `noitrainer-cli cell <wx> <wy>` (air vs solid) —
diff telescope's carved buffer against engine cells along a chunk's paths. Build a
small harness that, for a chunk, compares telescope's `rawBuffer` air/solid mask to
the engine's cell grid (via `cell`/`biome-at-many`), so each carve change is
measured, not guessed.

**Risk:** terrain-wide change; can regress matches if RNG/path order is off. Keep it
behind a flag until the report shows net-positive with zero match regressions.

---

## E. Unmodeled item types (item recall is scope-bound, not buggy)

Modeled `item` subtypes (eggs, runestone, die, kiuaskivi/ukkoskivi/kuu/moon,
pouch) have ~6 total misses on the broad fixture, and those are biome-edge-wobble
(telescope emits nothing at the spawn pixel — same gate-divergence class as C2),
NOT offset bugs. The rest of the item recall gap is types telescope simply does
not generate:
- `orb_00..orb_10` (orb rooms), `book_*` (lore), `essence_*` (essence room),
  `spell_refresh` (HM pickup), `gourd`, `musicstone`, `utility_box` (the box
  entity), `egg_worm`, `experimental_wand_*`.
These inflate item-miss but are future modeling scope. Consider an explicit
"unmodeled item detail" set so item recall reflects only modeled types (with a
logged dropped-count — no silent caps).

### E1. mimic classification (29 false-extras, unreconciled)
Telescope emits `mimic`/`mimic_potion` as `item`; game `potion_mimic.xml` →
`potion`, `chest_mimic.xml` (animals/) → `enemy`. They never match. Low volume,
not yet aligned. Decide a canonical mapping (probably telescope `mimic_potion` →
`potion`).

---

## F. Deliberately ignored (excluded from scoring, with reason)

- **Simulation noise** (`covered:false` in `classifyGameFile`): electricity,
  particles, projectiles, props, traps, enemy-dropped loot. Directory-gated
  (`COVERED_DIR_RE`). A seed-1 sweep had `electricity_medium.xml` alone = 4220
  rows. These are not worldgen placements.
- **Spells** (`detail==='spell'`): never dumped as pickups anywhere. See B.
- **Gold / perk / shop_item kinds**: not in `TELESCOPE_KINDS` (telescope doesn't
  model them). physics_gold_orb → `gold`.
- **Chest / boss-drop contents** (`CONTAINER_ORIGINS` + `isContainerContent`):
  excluded pragmatically (see C1) — note this is now known to be imperfect, not
  principled.
- **pixel_scene placements**: excluded from the entity diff (`TELESCOPE_KINDS`
  has no pixel_scene); entity-bearing scenes are validated indirectly via their
  inner spawns. See G1.
- **pacifist_chest extras** (chest P): the HM pacifist chest is player-conditional
  (`js/temple_generation.js` `generateHolyMountainShops`), never triggered by a
  passive sweep → shows as telescope extras with no game entity. Could add back to
  `CONTAINER_ORIGINS` / a conditional-entity exclude if it bothers the metric.

---

## G. Not built yet

### G1. Pixel-scene placement diff
`sweep` dumps 418 real `PixelScene_LoadAndSpawn` rows (seed-1; 158 in the quick
mask). A direct diff scored 0/158 because (a) telescope *consumes* spawn-rolled
scenes for their inner spawns and only surfaces ~4 placements via the spawn scan;
`node scripts/dump.mjs pixel-scenes` emits only static + biome-color (11 in-mask)
— `dump.mjs` literally says "prng-rolled scenes not yet implemented"; (b) folder
naming differs — telescope emits the biome NAME as folder (`temple_altar/altar.png`,
`mountain_hall/hall.png`) but the game path is `temple/altar.png`,
`mountain/hall.png` (see `js/pixel_scene_generation.js` `getPixelSceneKey` and
`dump.mjs` `materialsFilePath`); (c) static coords differ too. Building it =
instrument telescope to emit ALL scene placements + a biome→`biome_impl` folder
map + coord alignment. Lower ROI than coverage expansion because entity-bearing
scenes are already covered indirectly; the unique value is cosmetic/structural
scenes (`solid`, `mountain/hall`, `snowperson`, `icicles`).

### G2. Coverage gaps (capture)
Have: main + pw+1 + pw-1 (NG0, seed 1). Missing: heaven/hell (vertical PWs —
needed to test C3), far PWs (pw+7, pw-12 — owner noted worldgen "gets weird" far
out), NG+, other seeds (worldgen is deterministic per version, so one seed is a
strong oracle, but a second would catch seed-specific harness assumptions).

---

## H. General caveat: sweep coords are CREATION coords, not final positions

The chest case (C1) generalizes: `sweep` records the position passed to
`Entity_CreateFromFile`, which for deferred-loaded entities is a scratch/seed
position, not where the entity ends up after `EntityApplyTransform` / physics.
Telescope mirrors the creation/seed coordinate too, so the harness comparison
stays internally consistent — but never assume a dumped coordinate is where the
thing visually rests in a live game. Native-stack symbols seen in dumps:
`PixelScene_LoadAndSpawn`, `LuaImpl_LoadPixelScene`, `Entity_CreateFromFile`,
`ProceduralTerrain_Init`, `WorldState_InitNewRun`. To verify a specific
creation→move sequence, the ghidra MCP debugger (`debugger_set_breakpoint`,
`debugger_trace_function`) on `EntityApplyTransform` is the direct tool.
