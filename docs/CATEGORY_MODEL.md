# The accuracy model: dump categories → canonical kinds → exceptions → real mismatches

This is the map of how the harness decides whether telescope is right. It has
four layers. Anything that survives all four is a **real mismatch** that should
be fixed in noita-telescope; everything else is either matched or deliberately
ignored with a documented reason.

```
  game sweep dump ─┐                          ┌─ exceptions / ignore layer ─┐
                   ├─►  canonical kind space  ─┤   (everything excluded here │  surviving
  telescope POIs ──┘    + (kind,x,y) join     │    is NOT a bug)             ├─► missing / extra
                                              └─────────────────────────────┘   = REAL mismatch
```

Source of truth for everything below: `scripts/lib/entity_identity.mjs`
(canon + exceptions) and `scripts/verify_entities.mjs` (matching + scoring).

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

### Game file → kind (`classifyGameFile` + `ITEM_KIND_RULES`)
- `pixel_scene` / `*.png` / `biome_impl/` → `pixel_scene`
- `entities/animals/…` or `category=mob` → `enemy`
- within `items/`, first matching rule wins: `chest_random_super*`→`chest_great`;
  `chest*`→`chest`; `wand*|flute|kantele|…`→`wand`; `potion*`→`potion`;
  `heart*`→`heart`; `goldnugget|bloodmoney|physics_gold_orb`→`gold`;
  `perk*`→`perk`; `egg_*`/`essence_*`→`item`; `shop_item|shop_potion|shop_cape`
  →`shop_item`; otherwise →`item`.

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

### B. Game kinds not in `TELESCOPE_KINDS` → `unmodeled` bucket (not a "miss")
`gold`, `perk`, `shop_item`, `pixel_scene`, `other`. A game entity of these kinds
can never be a telescope miss because telescope doesn't model them. (`pixel_scene`
placement is validated separately by `verify.mjs`'s pixel-scenes section; a
mis-fired scene gate shows up here as missing/extra *item* rows instead.)

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

## The invariant

> A row that is in-mask, covered, of a scored kind, survives every Layer-4
> exception, and still has no twin on the other side **is a real mismatch** —
> a `missing` (telescope under-predicts) or `extra` (telescope over-predicts)
> that should be fixed in noita-telescope.

`compare.mjs <refA> <refB>` runs exactly this for two git refs and reports which
of these real mismatches a change **fixes** vs **regresses**.

> Maintenance note: this document is hand-kept in sync with
> `scripts/lib/entity_identity.mjs`. When the standalone repo is built it should be
> generated from the rule tables so it cannot drift.
