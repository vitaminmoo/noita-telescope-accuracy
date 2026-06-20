// The ignore layer of the accuracy model — every rule that deliberately drops a
// row from scoring, in one declarative place, each with the reason it is NOT a
// telescope bug. A row that survives ALL of these (and is in-mask, covered, and a
// scored kind) is a real mismatch. See scripts/CATEGORY_MODEL.md for the prose.
//
// Pure data + pure functions; consumed by scripts/lib/entity_identity.mjs.

// ── Game-side coverage exclusions (yield covered:false in classifyGameFile) ──

// Boss victory-room rewards (animals/<boss>/rewards/, e.g. boss_centipede): RNG
// drops spawned by boss_victoryroom.lua, not worldgen — type/count genuinely
// nondeterministic, and telescope doesn't model them.
export const BOSS_REWARDS_RE = /(^|\/)entities\/animals\/[^/]+\/rewards\//;

// Lore books and spell orbs (by directory): telescope deliberately doesn't model
// these item types.
export const UNMODELED_ITEM_DIR_RE = /(^|\/)entities\/items\/(books|orbs)\//;

// More unmodeled item types, by basename: essences, Holy-Mountain spell-refresh
// pickups, musicstone, the greed curse. Extend as more are confirmed.
export const UNMODELED_ITEM_NAME_RE = /^essence_|^spell_refresh|^musicstone$|^greed_curse$/;

// Holy-Mountain temple full-HP hearts render in telescope as map PIXELS (part of
// the altar pixel-scene), never as discrete POI entities, so the entity diff can
// never match them. Captured in the dump but not scored.
export const HM_TEMPLE_HEART_RE = /^heart_fullhp_temple/;

// ── Telescope-side exclusions ────────────────────────────────────────────────

// Telescope item `detail`s that are real worldgen entities the camera sweep never
// dumps as items, so telescope's copy can never match — bucket as `unmodeled`
// (not a scored kind) instead of counting a false `item` extra:
//  - chaos_die / greed_die : potion_spawnlist physics pickups (generateItem ~1/91);
//      no die file appears in ANY fixture dump.
//  - paha_silma : the unique snowy_ruins eye pillar — the game emits it ONLY as a
//      pixel_scene (overworld/snowy_ruins_eye_pillar.png), never as a dumped item.
//  - treasure   : the greed/sin treasure — emitted ONLY as a greed_treasure.png
//      pixel_scene, never as a dumped item.
//  - portal     : the rainforest portal — never dumped as an item entity either
//      (confirmed by the maintainer).
// Scene-vs-placement for the pixel_scene ones is validated by verify.mjs's
// pixel-scenes section, not the entity diff.
export const TELESCOPE_UNMODELED_DETAILS = new Set([
    'chaos_die', 'greed_die', 'paha_silma', 'treasure', 'portal',
]);

// ── Container-content exclusions (placement scored, unwrapped contents not) ──
//
// A passive camera sweep never opens containers, so their contents are never
// instantiated and telescope's predicted contents would all be false extras. The
// container PLACEMENT (kind chest/chest_great) stays scored; only contents drop.
// Chest contents are instead scored separately by loot-KIND per parent chest
// (see scoreChestContents in verify_entities.mjs).
export const CONTAINER_ORIGINS = new Set([
    'chest', 'pacifist_chest', 'great_chest', 'tiny', 'starting_loadout',
    'eye_room', 'puzzle', 'pyramid_boss', 'alchemist_boss', 'triangle_boss',
    'dragon', 'meditation_cube', 'robot_egg', 'utility_box',
]);

// Shop origins place real item entities at worldgen — but only PHYSICAL stock
// (wands) is dumped as a discrete pickup the sweep observes; a spell purchase is
// not (a seed-1 HM spell-shop dump held only shop_hitbox + sale_indicator, never
// a card). So shop *wands* are kept and scored; shop *spells* are excluded below.
export const SHOP_ORIGINS = new Set(['shop', 'laboratory', 'holy_mountain_shop', 'hourglass_shop']);

// Is this telescope canon-row a container's content (vs a real placement)?
export function isContainerContent(row) {
    const origin = row.raw?.origin;
    // Spells are never dumped as discrete worldgen pickup entities anywhere — not
    // shop stock, not utility-box dispensed, not boss drops (a seed-1 broad sweep
    // had ZERO generic spell-card pickups). So any spell row is unverifiable.
    if (row.kind === 'shop_slot' || row.detail === 'spell') return true;
    if (SHOP_ORIGINS.has(origin) && row.detail === 'spell') return true;
    // The Holy Mountain pacifist chest is player-conditional (only appears if the
    // player doesn't attack) — a passive sweep never triggers it, so telescope's
    // pacifist_chest placement + contents are always false extras. Exclude both.
    if (origin === 'pacifist_chest') return true;
    if (!CONTAINER_ORIGINS.has(origin)) return false;
    // The utility-box placement marker (item · utility_box) is the scorable entity;
    // its dispensed contents are unobservable until shot open, so drop only those.
    if (origin === 'utility_box') return row.detail !== 'utility_box';
    if (row.kind === 'chest' || row.kind === 'chest_great') return false; // the container itself
    return true;
}
