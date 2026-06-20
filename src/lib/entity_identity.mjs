// Canonical entity record + identity mapping shared by both sides of the
// entity-accuracy harness.
//
// The two sources speak different languages:
//
//   sweep (game ground truth)  keys on the XML *file* it spawned, e.g.
//                              "data/entities/items/pickup/heart.xml", with a
//                              coarse category of item|mob|pixel_scene.
//   telescope (emitPoi)        keys on a *semantic* category (wand, chest,
//                              potion, heart, enemy, ...) + a detail string,
//                              and emits no XML path at all.
//
// To diff them we fold both into one `CanonRecord` whose join key is
// (kind, rounded position). `kind` is the normalized identity below; `detail`
// is the sub-identity (material / spell / enemy name / scene basename) used as
// a secondary discriminator when present on both sides.
//
// Everything here is pure data + pure functions — no game logic, no I/O.
//
// The deliberate-ignore rules (what is NOT scored, and why) live in one place:
// scripts/lib/exceptions.mjs. This file owns the category MAPPING; that file owns
// the EXCEPTION layer. See scripts/CATEGORY_MODEL.md.

import {
    BOSS_REWARDS_RE, UNMODELED_ITEM_DIR_RE, UNMODELED_ITEM_NAME_RE, HM_TEMPLE_HEART_RE,
    TELESCOPE_UNMODELED_DETAILS, CONTAINER_ORIGINS, SHOP_ORIGINS, isContainerContent,
    gameRowExcludedByLua, TELESCOPE_BOSS_DROP_WAND_POS,
} from './exceptions.mjs';

// Re-export the ignore-layer surface so existing importers (verify_entities.mjs,
// mismatch_report.mjs) keep importing it from here unchanged.
export { CONTAINER_ORIGINS, SHOP_ORIGINS, isContainerContent };

// ── Parallel-world geometry (NG0; see js/constants.js + js/static_spawns.js) ──
// Horizontal PW offset = pwIndex * mapWidth * 512  (70 chunks → 35840 px).
// Vertical   PW offset = pwVertical * 48 * 512      (48 chunks → 24576 px).
// Main world is centered on x=0: biome chunk cx maps to world x = cx*512 - 17920.
// Vertically, biome chunk cy maps to world y = cy*512 - 7168 (center chunk 14).
export const CHUNK = 512;
export const MAP_W_NG0 = 70;
export const MAP_W_NGP = 64;
export const MAP_H = 48;
export const PW_WIDTH_NG0 = MAP_W_NG0 * CHUNK; // 35840
export const PW_WIDTH_NGP = MAP_W_NGP * CHUNK; // 32768
export const PW_HEIGHT = MAP_H * CHUNK;        // 24576
const WORLD_X0 = -(MAP_W_NG0 / 2) * CHUNK;     // -17920  (main-world left edge)
const WORLD_Y0 = -14 * CHUNK;                  // -7168   (main-world top edge)

export function pwWidth(isNGP = false) {
    return isNGP ? PW_WIDTH_NGP : PW_WIDTH_NG0;
}

// Which parallel world a global world-x belongs to. Main world (centered on 0)
// is pw 0; +1 is one world-width to the right, -1 to the left.
export function pwIndexOf(worldX, isNGP = false) {
    const w = pwWidth(isNGP);
    return Math.floor((worldX - WORLD_X0) / w);
}

// Vertical PW: heaven is up (-1), hell is down (+1).
export function pwVerticalOf(worldY) {
    return Math.floor((worldY - WORLD_Y0) / PW_HEIGHT);
}

// Global chunk index — the unit the coverage mask is expressed in. Matches
// sweep's `cx,cy = floor(coord/512)`.
export function chunkOf(worldX, worldY) {
    return { cx: Math.floor(worldX / CHUNK), cy: Math.floor(worldY / CHUNK) };
}

// The friend "cavern" scene places three gourds (fixed spawn_fruit pixels), but
// telescope shows a single one for display. All three sit in the scene's one
// chunk, so snapping every gourd to its chunk centre collapses the trio onto the
// single display gourd — they match instead of scoring 2 misses + a 1-vs-3 count
// mismatch. Applied to BOTH sides (see canonGame/canonTelescope).
function snapGourd(x, y) {
    return {
        x: Math.floor(x / CHUNK) * CHUNK + CHUNK / 2,
        y: Math.floor(y / CHUNK) * CHUNK + CHUNK / 2,
    };
}

// ── Identity classification (game side: XML file → kind/detail/covered) ──────
//
// `covered` answers "does telescope even try to place this?". Simulation
// artifacts a camera-sweep stirs up (electricity, particles, projectiles,
// props, traps firing, enemy-dropped loot) are covered:false — they are *not*
// worldgen placements and must be excluded from scoring, not counted as
// telescope misses. Real data from a seed-1 sweep had electricity_medium.xml
// alone account for 4220/7777 "item" rows; directory-gating removes that whole
// class at the door.

// Top-level entity dirs telescope models. Anything outside these is noise.
const COVERED_DIR_RE = /(^|\/)entities\/(items\/pickup|items|animals)\//;
const PIXEL_SCENE_RE = /\.png$|(^|\/)biome_impl\//;

// Within items/, filename → kind. Order matters; first match wins.
const ITEM_KIND_RULES = [
    [/^chest_random_super/, 'chest_great'],
    [/^chest(_|$)|^chest_leggy/, 'chest'],
    [/^wand|^starting_wand|^starting_bomb_wand|^broken_wand|^shop_wand|^flute$|^kantele$|^leukaluu_kantele$/, 'wand'],
    [/^potion/, 'potion'],
    [/^heart/, 'heart'],
    [/^goldnugget|^bloodmoney|^physics_gold_orb/, 'gold'],
    [/^perk|^give_all_perks|^perk_reroll/, 'perk'],
    [/^egg_/, 'item'],          // detail keeps the egg variant
    [/^essence_/, 'item'],
    [/^shop_item$|^shop_potion$|^shop_cape$/, 'shop_item'],
];

function baseName(file) {
    const f = file.replace(/^data\//, '').replace(/\.(xml|png)$/i, '');
    const slash = f.lastIndexOf('/');
    return slash >= 0 ? f.slice(slash + 1) : f;
}

// Classify a game spawn (sweep `file` + its coarse `category`) into the shared
// identity space. Returns { kind, detail, covered }.
export function classifyGameFile(file, category) {
    const detail = baseName(file);

    if (category === 'pixel_scene' || PIXEL_SCENE_RE.test(file)) {
        return { kind: 'pixel_scene', detail, covered: true };
    }
    // Boss victory-room rewards — see exceptions.BOSS_REWARDS_RE.
    if (BOSS_REWARDS_RE.test(file)) {
        return { kind: 'other', detail, covered: false };
    }
    // The Magical Temple (wandcave) "wand ghost" is an ENEMY that carries a wand
    // (wand_level_03, "Taikasauva") and drops it when killed. Telescope models the
    // placement as the wand the ghost holds — a deliberate UI choice, see the
    // spawn_small_enemies wandcave case in js/spawn_functions.js — emitting a `wand`
    // POI, not an enemy. So the game's wand_ghost.xml mob and telescope's wand are
    // the SAME placement (positions coincide exactly). Classify the ghost as `wand`
    // so the two match, instead of double-counting it as a wand-extra AND an
    // enemy-miss.
    if (/^wand_ghost$/.test(detail)) return { kind: 'wand', detail, covered: true };
    if (category === 'mob' || /(^|\/)entities\/animals\//.test(file)) {
        return { kind: 'enemy', detail, covered: true };
    }
    if (!COVERED_DIR_RE.test(file)) {
        // misc/, particles/, projectiles/, props/, buildings/, effect_* … —
        // simulation/cosmetic, telescope doesn't model it.
        return { kind: 'other', detail, covered: false };
    }
    // Item types telescope deliberately does NOT model — see exceptions
    // UNMODELED_ITEM_DIR_RE (books/orbs) + UNMODELED_ITEM_NAME_RE (essences, HM
    // spell-refresh, musicstone, greed-curse). Still captured in the dump.
    if (UNMODELED_ITEM_DIR_RE.test(file) || UNMODELED_ITEM_NAME_RE.test(detail)) {
        return { kind: 'item', detail, covered: false };
    }
    // Holy-Mountain temple full-HP hearts — see exceptions.HM_TEMPLE_HEART_RE.
    if (HM_TEMPLE_HEART_RE.test(detail)) return { kind: 'heart', detail, covered: false };
    for (const [re, kind] of ITEM_KIND_RULES) {
        if (re.test(detail)) return { kind, detail, covered: true };
    }
    return { kind: 'item', detail, covered: true };
}

// The three "good wands" in the wand tower (generateGoodWand1/2/3, all tagged
// biome 'solid_wall_tower_10') are INTENTIONALLY spread ±100 px apart in telescope
// so each is individually clickable as a PoI; the game places them ±20 px apart
// (and 4 px lower). Same three placements, a cosmetic spacing choice — not a bug.
// Snap telescope's PW-LOCAL coordinates back onto the game's so the two sides
// match, instead of scoring 3 wand-misses + 3 wand-extras every world. Keyed on
// pw-local (x,y) so it holds in parallel worlds too; order is preserved
// (leftmost→leftmost), so each snaps to the correct wand_good_N.
const GOOD_WAND_BIOME = 'solid_wall_tower_10';
const GOOD_WAND_SNAP = {
    '9884,4360': [9964, 4364],
    '9984,4360': [9984, 4364],
    '10084,4360': [10004, 4364],
};

// ── Telescope side (emitPoi row → CanonRecord) ──────────────────────────────
// emitPoi categories: wand | chest | chest_great | potion | heart | item |
// shop_slot | enemy | other. These already line up with the game-side kinds
// above, so the mapping is near-identity; we just normalize a couple of names.
const TELESCOPE_CATEGORY_TO_KIND = {
    wand: 'wand',
    chest: 'chest',
    chest_great: 'chest_great',
    potion: 'potion',
    heart: 'heart',
    item: 'item',
    shop_slot: 'shop_slot',
    enemy: 'enemy',
    other: 'other',
};

// Kinds telescope is actually capable of emitting. A *game* entity whose kind
// is NOT in here can never be a telescope "miss" — it's simply unmodeled (e.g.
// gold, perk pickups, shop_item). Such rows go in the `unmodeled` bucket, not
// the recall denominator. Trim/extend this as telescope's coverage changes.
// NB: pixel_scene is intentionally absent — telescope's entity flattening emits
// a scene's *inner* spawns (wand/chest/item rows), not the scene placement
// itself; scene placement is validated by verify.mjs's `pixel-scenes` section.
// A mis-fired scene gate therefore surfaces here as missing/extra *item* rows.
export const TELESCOPE_KINDS = new Set([
    'wand', 'chest', 'chest_great', 'potion', 'heart', 'item', 'shop_slot', 'enemy',
]);

// Kinds whose *presence/placement* a non-opening camera sweep can confirm but
// whose *contents/stats* it cannot (the chest is placed, but its loot isn't
// rolled until opened; the wand entity exists, but telescope's predicted spells
// /stats aren't on the dumped record). Flagged so the report can quarantine
// content/stat predictions as "unverifiable-by-sweep" rather than scoring them.
export const CONTENTS_UNVERIFIABLE_KINDS = new Set(['chest', 'chest_great', 'shop_slot']);

// Container-content exclusion (CONTAINER_ORIGINS / SHOP_ORIGINS / isContainerContent)
// lives in exceptions.mjs and is re-exported above.

// ── Canonical record ────────────────────────────────────────────────────────
// The single shape both sides are folded into before diffing.
//   source : 'game' | 'telescope'
//   kind   : normalized identity (join key)
//   detail : sub-identity (secondary discriminator; may be null)
//   x,y    : global world pixel (spawn point)
//   cx,cy  : global chunk indices
//   pw,pwv : parallel-world indices derived from x,y
//   covered: is this a kind telescope models? (game side; always true telescope side)
//   raw    : the original record, for debugging / drill-down
export function canonGame(rec, isNGP = false) {
    const { kind, detail, covered } = classifyGameFile(rec.file, rec.category);
    let x = rec.x, y = rec.y;
    if (detail === 'gourd') ({ x, y } = snapGourd(x, y));
    const { cx, cy } = chunkOf(x, y);
    // A non-worldgen, player-conditional spawn (identified by its lua_stack) is
    // not something telescope predicts — drop it on the game side too.
    const covered2 = covered && !gameRowExcludedByLua(rec);
    return {
        source: 'game', kind, detail,
        x, y, cx, cy,
        pw: pwIndexOf(x, isNGP), pwv: pwVerticalOf(y),
        covered: covered2, raw: rec,
    };
}

export function canonTelescope(rec, isNGP = false) {
    let kind = TELESCOPE_CATEGORY_TO_KIND[rec.category] || rec.category || 'other';
    // broken_wand is emitted by generateItem as an `item` (detail broken_wand),
    // but the game-side classifier maps broken_wand.xml to `wand` (ITEM_KIND_RULES
    // ^broken_wand). Align telescope to that so the two sides can match instead of
    // double-counting every broken_wand as a wand-miss AND an item-extra.
    if (kind === 'item' && rec.detail === 'broken_wand') kind = 'wand';
    // The potion_spawnlist gold-orb slot: telescope names it shiny_orb/greed_orb,
    // the game loads physics_gold_orb.xml which the game-side classifier buckets as
    // `gold` (an unmodeled kind, excluded from scoring). Match that so telescope's
    // copy is excluded too instead of being a false `item` extra.
    if (kind === 'item' && (rec.detail === 'shiny_orb' || rec.detail === 'greed_orb')) kind = 'gold';
    // The full-heal heart: game classifies heart_fullhp.xml as 'heart'; telescope
    // emits it as an item detailed 'full_heal'. Align so the two match.
    if (kind === 'item' && rec.detail === 'full_heal') kind = 'heart';
    // Mimics: telescope labels them as items; the game files classify elsewhere —
    // chest_mimic.xml (animals/) → enemy, potion_mimic.xml → potion. Align.
    if (kind === 'item' && rec.detail === 'mimic') kind = 'enemy';
    if (kind === 'item' && rec.detail === 'mimic_potion') kind = 'potion';
    // Leggy chest: telescope emits it as an item; game chest_leggy.xml → chest.
    if (kind === 'item' && rec.detail === 'chest_leggy') kind = 'chest';
    // Real worldgen entities the camera sweep never dumps as items, so telescope's
    // copies can never match — bucket as the unmodeled kind (not in TELESCOPE_KINDS)
    // so they're excluded rather than counted as false `item` extras. The set and
    // its per-detail rationale live in exceptions.TELESCOPE_UNMODELED_DETAILS.
    if (kind === 'item' && TELESCOPE_UNMODELED_DETAILS.has(rec.detail)) kind = 'unmodeled';
    let x = rec.x, y = rec.y;
    if (rec.detail === 'gourd') ({ x, y } = snapGourd(x, y));
    if (kind === 'wand' && rec.biome === GOOD_WAND_BIOME) {
        const pw = pwIndexOf(x, isNGP), off = pw * pwWidth(isNGP);
        const snap = GOOD_WAND_SNAP[`${Math.round(x - off)},${Math.round(y)}`];
        if (snap) { x = snap[0] + off; y = snap[1]; }
    }
    // Boss-drop wands (e.g. the Saha) only appear after the boss dies; a passive
    // sweep never sees them, so telescope's copy is always a false extra. Keyed on
    // PW-local position. Bucket as `unmodeled` so it leaves the scored set.
    if (kind === 'wand') {
        const off = pwIndexOf(x, isNGP) * pwWidth(isNGP);
        if (TELESCOPE_BOSS_DROP_WAND_POS.has(`${Math.round(x - off)},${Math.round(y)}`)) kind = 'unmodeled';
    }
    const { cx, cy } = chunkOf(x, y);
    return {
        source: 'telescope', kind, detail: rec.detail ?? null,
        x, y, cx, cy,
        pw: pwIndexOf(x, isNGP), pwv: pwVerticalOf(y),
        covered: true, raw: rec,
    };
}
