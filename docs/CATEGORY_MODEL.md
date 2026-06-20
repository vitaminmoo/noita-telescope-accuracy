# The accuracy model: dump categories → canonical kinds → exceptions → real mismatches

This is the map of how the harness decides whether telescope is right. The
harness scores along **two independent axes**:

1. the **entity diff** (`verify_entities.mjs`) — the four-layer model documented
   below, which folds both sides into one `(kind, x, y)` space and set-diffs them;
2. the **pixel-scene placement diff** (`compare_scenes.mjs`) — does telescope
   place the same gameplay *scenes* at the same positions? (its own section near
   the end).

`report.mjs` runs both. For the entity diff, anything that survives all four
layers is a **real mismatch** that should be fixed in noita-telescope; everything
else is either matched or deliberately ignored with a documented reason.

```
  game sweep dump ─┐                          ┌─ exceptions / ignore layer ─┐
                   ├─►  canonical kind space  ─┤   (everything excluded here │  surviving
  telescope POIs ──┘    + (kind,x,y) join     │    is NOT a bug)             ├─► missing / extra
                                              └─────────────────────────────┘   = REAL mismatch
```

Source of truth for everything below: `src/lib/entity_identity.mjs` (canon),
`src/lib/exceptions.mjs` (the ignore rules — both entity and scene), and
`src/verify_entities.mjs` (matching + scoring). The scene axis is scored by
`src/compare_scenes.mjs`.

---

## Layer 1 — the two inputs

The two sides speak different languages and must be folded into one shape.

### Game ground truth (the `sweep` dump)
Three NDJSON files per region, one row per observed entity:

| file | sweep `category` | what it is |
|---|---|---|
| `pixel_scenes.ndjson` | `pixel_scene` | a placed pixel scene (PNG / biome_impl) |
| `items.ndjson` | `item` | a pickup/item entity |
| `mobs.ndjson` | `mob` | an animal/enemy entity |

Each row: `{ x, y, cx, cy, category, file, frame, entity_id, native_stack }`,
plus `{ chest_x, chest_y, chest_eid }` on reward rows when the dump was captured
with force-open-chests. `file` is the XML path it spawned from (e.g.
`data/entities/items/pickup/heart.xml`) — the game's identity is its **file**.
`cx,cy = floor(coord/512)` is the chunk grid the coverage mask uses.
`tile_done.ndjson` records which chunks the sweep actually generated (the mask).

### Telescope prediction (`emitPoi` rows)
Telescope emits semantic rows `{ category, x, y, biome, origin, detail?, subtype?,
parentX?, parentY? }` with categories `wand | chest | chest_great | potion |
heart | item | shop_slot | enemy | other`. It emits **no XML path**; its identity
is the semantic `category` + `detail`. Pixel scenes are flattened into their inner
spawns (a scene is not emitted as a row — its wand/chest/item contents are).

---

## Layer 2 — the canonical kind space (the join target)

Both sides fold into one `CanonRecord` (`canonGame` / `canonTelescope`) keyed on
**(kind, rounded x, rounded y)**. `kind` is the normalized identity; `detail` is a
secondary discriminator.

**Scored kinds** (`TELESCOPE_KINDS`) — telescope is expected to predict these, so
they count toward recall/precision:
`wand`, `chest`, `chest_great`, `potion`, `heart`, `item`, `shop_slot`, `enemy`.
(`chest_content` is a derived score — see Layer 3.)

### Game file → kind (`classifyGameFile`)
`classifyGameFile(file, category)` runs these tests **in order** and returns the
first match as `{ kind, detail, covered }`. `detail` is always the file's
basename (`heart.xml` → `heart`). The `covered:false` early-outs are the Layer-4A
exceptions; they fire *before* the positive item rules:

1. `category==='pixel_scene'` or path matches `*.png` / `biome_impl/` → **`pixel_scene`** (covered)
2. boss victory-room rewards (`BOSS_REWARDS_RE`) → `other` *(covered:false — Layer 4A)*
3. `wand_ghost.xml` → **`wand`** (covered) — the Magical Temple "wand ghost" is an
   *enemy* (`category=mob`) that carries `wand_level_03` and drops it on death.
   Telescope deliberately models the placement as the held wand (one `wand` POI),
   so the game's mob and telescope's wand are the same placement; classifying the
   ghost as `wand` lets them match instead of double-counting a wand-extra + an
   enemy-miss.
4. `category==='mob'` or path under `entities/animals/` → **`enemy`** (covered)
5. path *outside* `items/pickup`, `items`, `animals` (`!COVERED_DIR_RE`) → `other`
   *(covered:false — misc/particles/projectiles/props/traps; Layer 4A)*
6. unmodeled item dir/name (`UNMODELED_ITEM_DIR_RE`/`UNMODELED_ITEM_NAME_RE`) →
   `item` *(covered:false — Layer 4A)*
7. Holy-Mountain temple heart (`HM_TEMPLE_HEART_RE`) → `heart` *(covered:false — Layer 4A)*
8. within `items/`, first **`ITEM_KIND_RULES`** match wins (covered):

   | basename matches | kind |
   |---|---|
   | `^chest_random_super` | `chest_great` |
   | `^chest(_\|$)` · `^chest_leggy` | `chest` |
   | `^wand` · `^starting_wand` · `^starting_bomb_wand` · `^broken_wand` · `^shop_wand` · `^flute` · `^kantele` · `^leukaluu_kantele` | `wand` |
   | `^potion` | `potion` |
   | `^heart` | `heart` |
   | `^goldnugget` · `^bloodmoney` · `^physics_gold_orb` | `gold` |
   | `^perk` · `^give_all_perks` · `^perk_reroll` | `perk` |
   | `^egg_` · `^essence_` | `item` *(detail keeps the variant)* |
   | `^shop_item$` · `^shop_potion$` · `^shop_cape$` | `shop_item` |

9. no rule matched → **`item`** (covered) — the catch-all for pickups telescope models.

### Telescope category → kind (`TELESCOPE_CATEGORY_TO_KIND` + alignment remaps)
Near-identity, plus these remaps so the two sides name the same thing the same
way (each prevents a double-counted miss+extra):

| telescope emits | remapped to | because the game files it as |
|---|---|---|
| item · `broken_wand` | `wand` | `broken_wand.xml` |
| item · `shiny_orb` / `greed_orb` | `gold` | `physics_gold_orb.xml` |
| item · `full_heal` | `heart` | `heart_fullhp.xml` |
| item · `mimic` | `enemy` | `chest_mimic.xml` (animals/) |
| item · `mimic_potion` | `potion` | `potion_mimic.xml` |
| item · `chest_leggy` | `chest` | `chest_leggy.xml` |

### Two coordinate normalizations (not exclusions — they make true matches match)
- **gourd snap** (`snapGourd`, both sides): the cavern scene's 3 gourds collapse
  to their chunk centre so they match telescope's single display gourd.
- **good-wand snap** (`GOOD_WAND_SNAP`, telescope side): the 3 wand-tower "good
  wands" are spread ±100px in telescope for clickability; snapped back onto the
  game's ±20px positions. Same placements, cosmetic spacing.

### Coordinate space (the join is in global world pixels)
Both sides key on **global world pixel** `(x,y)`, rounded. Each `CanonRecord` also
carries the chunk index (`cx,cy = floor(coord/512)`, matching the sweep) and the
parallel-world indices `pw`/`pwv` derived from `x,y`. The main world is centred on
`x=0` (`CHUNK=512`, `MAP_W=70` chunks NG0 / 64 NG+, `MAP_H=48`); a horizontal PW is
one map-width over (`pw·70·512`), heaven is `pwv=-1`, hell `pwv=+1`. The good-wand
snap is keyed on **pw-local** coordinates so it holds in every parallel world.

---

## Layer 3 — the match

`verify_entities.mjs` per region: build the coverage mask from `tile_done`,
generate telescope for that parallel world, then on each side keep only rows that
are **in-mask**, **covered**, and of a **scored kind**, dedupe by `(kind,x,y)`,
and set-diff:
- **matched** — same key on both sides.
- **missing** — game has it, telescope doesn't (under-prediction).
- **extra** — telescope invented it (over-prediction).

`Recall = matched/(matched+missing)`, `Precision = matched/(matched+extra)`.

**Chest contents** are scored separately as `chest_content` (loot *kind* per parent
chest, paired within 24px), not in the position diff — a reward spawns at a scratch
coord, teleports onto the chest, and can upwarp through terrain, so its exact
position is meaningless. Only meaningful on a force-open dump.

**Placement vs. contents/stats.** For `CONTENTS_UNVERIFIABLE_KINDS`
(`chest`, `chest_great`, `shop_slot`) a passive sweep can confirm the *placement*
(the entity exists at this coordinate) but **not** the *contents/stats* (loot isn't
rolled until opened; a wand's predicted spells/stats aren't on the dumped record).
So position is scored; predicted contents/stats are quarantined as
"unverifiable-by-sweep", never counted as a mismatch (this is the kind-level
companion to the per-origin container rule in Layer 4D).

---

## Layer 4 — the exceptions / ignore layer (the whole point)

Everything here is **deliberately not scored**, each with a reason. If a real
mismatch is actually one of these, the fix is to add/adjust a rule here — not to
change telescope.

### A. Game rows marked `covered: false` (not worldgen telescope models)
| rule | excluded | why |
|---|---|---|
| `COVERED_DIR_RE` miss | anything outside `items/pickup`, `items`, `animals` | misc/particles/projectiles/props/traps — simulation artifacts a sweep stirs up, not placements (electricity alone was 4220/7777 item rows in one seed-1 sweep) |
| `animals/*/rewards/` | boss victory-room drops | RNG boss drops, not worldgen; genuinely nondeterministic |
| `items/(books\|orbs)/` + `essence_*\|spell_refresh\|musicstone\|greed_curse` | lore books, spell orbs, essences, HM refresh, musicstone, greed-curse | telescope deliberately doesn't model these |
| `heart_fullhp_temple*` | Holy-Mountain temple hearts | telescope renders them as altar pixel-scene PIXELS, never as discrete POIs, so the entity diff can't match them |

### A2. Game rows excluded by their spawn mechanism (`lua_stack`)
The sweep records the Lua call-stack that spawned each entity, so a *non-worldgen,
player-conditional* spawn can be dropped on the game side by the stack signature
that produced it (`gameRowExcludedByLua`, `GAME_LUA_EXCLUDE_RE`). This is the
game-side mirror of a telescope-side exclusion — without it the row is a pure
game-has / telescope-lacks miss.

| lua-stack frame matches | excluded | why |
|---|---|---|
| `workshop_trigger_check` | the pacifist Workshop reward (`chest_random` renamed `$item_chest_treasure_pacifist`) | spawned ONLY if `enemies_killed==0` in the biome; telescope *does* predict it but the harness drops its side as origin `pacifist_chest` (Layer 4D), so the game side is dropped symmetrically |

Note the deliberate *non*-exclusion: **wizard-held wands are not dropped here**.
Wizards carry a wand the sweep dumps coincident with the mob; telescope already
models most of these as wands and matches them. The one that misses —
`wand_unshuffle_03` under `wizard_weaken` @(-9030,516) — is a real telescope gap
(it emits the wizard but not its wand), so it stays a real mismatch.

### B. Game kinds not in `TELESCOPE_KINDS` → `unmodeled` bucket (not a "miss")
`gold`, `perk`, `shop_item`, `pixel_scene`, `other`. A game entity of these kinds
can never be a telescope miss because telescope doesn't model them. (`pixel_scene`
placement is validated separately by the scene axis — `compare_scenes.mjs`, see
below; a mis-fired scene gate shows up *here* as missing/extra *item* rows
instead, since a scene's worldgen spawns land or don't land regardless.)

### C. Telescope item details remapped to `unmodeled` (not a false `extra`)
Real worldgen entities the camera sweep never dumps as items, so telescope's copy
can never match — excluded rather than counted as invented:
`chaos_die`, `greed_die` (potion_spawnlist physics pickups), `paha_silma`
(snowy_ruins eye — game emits ONLY as a pixel_scene), `treasure` (greed/sin
treasure — ONLY a pixel_scene), `portal` (rainforest portal — never dumped as an
item, confirmed by the maintainer).

### D. Container contents (`isContainerContent`) — placement scored, contents not
A passive camera sweep never opens containers, so their unwrapped contents would
all be false extras. The container PLACEMENT (kind `chest`/`chest_great`) stays
scored; only the contents drop.
- any `shop_slot`, or any `detail === 'spell'` → spells are never dumped as
  discrete pickups anywhere (shop, utility-box, or boss drop).
- `origin === 'pacifist_chest'` → player-conditional (only if you don't attack);
  a passive sweep never triggers it, so chest + contents are always false extras.
- `origin ∈ CONTAINER_ORIGINS` (chest, great_chest, tiny, starting_loadout,
  eye_room, puzzle, *_boss, dragon, meditation_cube, robot_egg, utility_box) →
  contents dropped; the container itself kept.
- `utility_box` → the box marker (`item · utility_box`) is kept and scored; only
  its dispensed contents drop.
- **Shop wands are NOT excluded** — physical shop stock (regular shops,
  laboratories, HM wand rows) IS placed at worldgen and observed by the sweep;
  scoring them confirmed telescope generates the HM wand row at the exact
  coordinate. Only shop *spells* are excluded (Layer 4D, unverifiable).

---

## The second axis — pixel-scene placement (`compare_scenes.mjs`)

The entity diff above asks *"are the right things spawned at the right spots?"*.
The scene axis asks the complementary question: *"does telescope place the same
gameplay **pixel scenes** at the same positions as the game?"* — the altars, orb
rooms, essence rooms, tele rooms, and so on. It is a separate scorecard with its
own recall/precision, run by `report.mjs` after the entity diff.

### What each side emits
- **Game**: every row of `pixel_scenes.ndjson`, identified by the PNG basename of
  its `file` (`.../wand_altar.png` → `wand_altar`).
- **Telescope**: only the scenes it can deterministically emit — **static** scenes
  (`STATIC_PIXEL_SCENES`) plus **biome-colour** scenes (`PIXEL_SCENE_BIOMES`,
  placed by reading the biome map pixel). PRNG-rolled *splice* scenes (e.g.
  `wand_altar`/`potion_altar` rolled per-chunk) are **not** emitted here — their
  contents are scored by the entity diff instead, so they don't double-count.

### The match
Both basenames are run through `SCENE_NAME_ALIAS` (Layer-4 §E) to a canonical
name; the comparison is restricted to the **intersection of names telescope can
emit** (a game scene whose name telescope never produces isn't a telescope bug,
it's out of scope), then matched on `(sceneName, position ± tol)` (default
`tol=64px`), clipped to the same coverage mask the entity diff uses.
`Recall = matched/(matched+missing)`, `Precision = matched/(matched+extra)`,
reported per scene name and as a total.

### E. Scene-placement exceptions (`src/lib/exceptions.mjs`)
The scene axis has its own ignore layer, the analogue of Layer 4 for scenes:

| rule | applies to | why |
|---|---|---|
| `SCENE_NAME_ALIAS` (both sides) | `secret_lab→orbroom`, `essenceroom_submerged→essenceroom`, `scale_old→scale`, `teleroom→teleportroom` | telescope and the game use different basenames for the **same** scene; normalize so they pair instead of scoring a miss+extra |
| `SCENE_CUSTOM_ART` (drop, both sides) | the HM/temple altars (`altar*`), `cauldron`, and the lava-lake structure (`lavalake*`) | telescope draws its own **custom art** here (its `surfaceOverlayScenes`) instead of emitting the underlying scene, so the game's scene would read as a telescope miss — but it isn't a bug. Curated by hand (telescope's custom-art set isn't an importable table); extend as more collisions are confirmed |
| `SCENE_NONDETERMINISTIC_RE` (drop) | `desert_ruins_*` | the desert surface ruins depend on seed **and** coordinates **and** runtime entity ids — telescope can't and shouldn't predict them |

> Scene invariant: a scene that is in-mask, of a telescope-emittable name,
> survives every §E rule, and has no twin within `tol` on the other side is a
> real scene-placement mismatch — telescope places a scene the game doesn't
> (extra) or misses one the game places (missing).

---

## The invariant

> A row that is in-mask, covered, of a scored kind, survives every Layer-4
> exception, and still has no twin on the other side **is a real mismatch** —
> a `missing` (telescope under-predicts) or `extra` (telescope over-predicts)
> that should be fixed in noita-telescope. The scene axis has its own analogous
> invariant (above).

`compare.mjs <refA> <refB>` runs exactly this for two git refs and reports which
of these real mismatches a change **fixes** vs **regresses**.

> Maintenance note: this document is hand-kept in sync with the rule tables in
> `src/lib/entity_identity.mjs` (the MAPPING) and `src/lib/exceptions.mjs` (the
> EXCEPTIONS — both the entity rules and the scene rules in §E). Scene scoring
> lives in `src/compare_scenes.mjs`. Ideally this doc would be generated from
> those tables so it cannot drift; until then, any rule change should update this
> file in the same commit.
