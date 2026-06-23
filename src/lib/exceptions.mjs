// The ignore layer of the accuracy model — every rule that deliberately drops a
// row from scoring, in one declarative place, each with the reason it is NOT a
// telescope bug. A row that survives ALL of these (and is in-mask, covered, and a
// scored kind) is a real mismatch. See docs/CATEGORY_MODEL.md for the prose.
//
// Pure data + pure functions; consumed by src/lib/entity_identity.mjs (entity
// rules) and src/compare_scenes.mjs (the scene rules below).

// ── Game-side coverage exclusions (yield covered:false in classifyGameFile) ──

// Boss victory-room rewards (animals/<boss>/rewards/, e.g. boss_centipede): RNG
// drops spawned by boss_victoryroom.lua, not worldgen — type/count genuinely
// nondeterministic, and telescope doesn't model them.
export const BOSS_REWARDS_RE = /(^|\/)entities\/animals\/[^/]+\/rewards\//;

// Lore books and spell orbs (by directory): telescope deliberately doesn't model
// these item types.
export const UNMODELED_ITEM_DIR_RE = /(^|\/)entities\/items\/(books|orbs)\//;

// More unmodeled item types, by basename: essences, Holy-Mountain spell-refresh
// pickups, musicstone, the greed curse, surface critter eggs. Extend as more are
// confirmed.
//  - egg_worm : a surface critter-egg pickup placed by overground spawn pixels;
//      telescope doesn't model these (3 in a full seed-1 sweep, all map-load with
//      no spawn script). Minor and not worth predicting.
export const UNMODELED_ITEM_NAME_RE = /^essence_|^spell_refresh|^musicstone$|^greed_curse$|^egg_worm$/;

// Holy-Mountain temple full-HP hearts render in telescope as map PIXELS (part of
// the altar pixel-scene), never as discrete POI entities, so the entity diff can
// never match them. Captured in the dump but not scored.
export const HM_TEMPLE_HEART_RE = /^heart_fullhp_temple/;

// ── Game-side mechanism exclusions (driven by the dump's lua_stack) ──────────
//
// The sweep records the Lua call-stack that spawned each entity. Some stacks are
// the signature of a NON-worldgen, player-conditional spawn that telescope can't
// (and shouldn't) predict — the camera-only sweep happens to trigger them. A row
// whose lua_stack matches here is dropped on the game side, the same way the
// telescope side already drops its own copy.
//  - workshop_trigger_check : the pacifist Workshop reward (chest_random renamed
//      $item_chest_treasure_pacifist), spawned ONLY if enemies_killed==0 in the
//      biome. Telescope DOES predict it but the harness excludes its side as
//      origin 'pacifist_chest' (see isContainerContent), so exclude the game side
//      symmetrically. Without this it's a pure game-has / telescope-lacks miss.
export const GAME_LUA_EXCLUDE_RE = /workshop_trigger_check/;

// the_end biome mid-region Holy-Mountain SHOP spell cards (the side-room shops
// placed by the_end.lua:426 via generate_shop_item.lua, seed-1 at LEFT x −2405..
// −1315 / RIGHT x 2355..3175, y ≈ 19327..20267). Telescope models the HM
// central-column temple shops and the static heaven/hell end-shops, but NOT
// these the_end in-biome side-room shops yet, so it emits no spell card there and
// every one reads as a `spell` miss. Excluded for now; faithfully modeling them
// needs a live the_end game dump. The signature is the COMBINATION of
// generate_shop_item.lua AND the_end.lua in the same stack — the_end.lua appears
// on NO matched spell row, and the 149 matched HM-temple/end-shop cards use
// generate_shop_item.lua with a DIFFERENT biome script (temple_altar, vault,
// excavationsite, …) or a pixel-scene placement, so this drops only these 50.
export function isTheEndShopSpell(raw) {
    const stack = raw?.lua_stack;
    if (!Array.isArray(stack)) return false;
    return stack.some((frame) => /generate_shop_item\.lua/.test(frame))
        && stack.some((frame) => /biomes\/the_end\.lua/.test(frame));
}

export function gameRowExcludedByLua(raw) {
    const stack = raw?.lua_stack;
    if (!Array.isArray(stack)) return false;
    if (isTheEndShopSpell(raw)) return true;
    return stack.some((frame) => GAME_LUA_EXCLUDE_RE.test(frame));
}

// NB: wizard-held wands are NOT excluded. Wizards carry a wand (ItemChestComponent)
// that the sweep dumps coincident with the mob, but telescope already models these
// AS wands and matches them (e.g. wand_unshuffle_06 under wizard_tele/dark). The
// one that misses — wand_unshuffle_03 under wizard_weaken @(-9030,516) — is a real
// telescope gap (it emits the wizard enemy but not its wand), so it stays a real
// mismatch rather than being excluded.

// ── Telescope-side exclusions ────────────────────────────────────────────────

// Telescope wand PoIs that are actually BOSS DROPS, not worldgen placements: the
// game only spawns them after the boss dies, so a passive sweep never sees them
// and telescope's copy is always a false extra. Keyed on PW-LOCAL (x,y) so it
// holds across parallel worlds.
//  - 6912,8448 : the Saha (generateExperimentalWand4, static_spawns.js) — the
//      meat-realm boss drop; telescope's own comment calls it "a boss drop but
//      I'm just treating it as a wand".
export const TELESCOPE_BOSS_DROP_WAND_POS = new Set(['6912,8448']);

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
// Scene-vs-placement for the pixel_scene ones is validated by the scene axis
// (src/compare_scenes.mjs), not the entity diff.
export const TELESCOPE_UNMODELED_DETAILS = new Set([
    'chaos_die', 'greed_die', 'paha_silma', 'treasure', 'portal',
]);

// ── Pixel-scene placement exceptions (scripts/compare_scenes.mjs) ────────────
//
// Scenes telescope DELIBERATELY does not emit/render because it draws its own
// custom art at that location (the Holy Mountains, the mountain altar, and more).
// The game still places the underlying scene, so without this they read as
// telescope "misses" — but they are not bugs. Excluded from the scene-placement
// score on BOTH sides. Telescope's custom-art set lives in its frontend rendering
// (no importable data table), so this list is curated by hand; extend it as more
// custom-art scenes are confirmed.
// The canonical custom-art set is telescope's `surfaceOverlayScenes` (app.js, gated
// by the "Display Custom Art" checkbox): hiisi_hourglass, orb_room, cursed_orb_room,
// echoing_spire, cauldron_room(_broken), moon, darkmoon — plus the baked
// `surfaceOverlay` over the whole surface. We list only the ones that actually
// collide in the scene diff (telescope emits a scene the game doesn't dump, or vice
// versa) so the score isn't polluted.
//  - Holy Mountain altar structure: the temple_altar* biome tiles
//    (generator_config.js) are rendered as custom art, not the altar pixel scenes.
//  - cauldron: the cauldron_room overlay is drawn as custom art; the game dumps no
//    matching scene at that fixed spot, so telescope's `cauldron` is a custom-art
//    extra, not a real over-prediction.
//  - lava lake: the whole lava-lake structure (lavalake2 body + the lavalake_pit
//    shaft tiles + racing track) is drawn as custom art, so telescope tiling the
//    pit shaft is neither required nor scored. (user-confirmed)
export const SCENE_CUSTOM_ART = new Set([
    'altar', 'altar_left', 'altar_right', 'altar_right_snowcastle', 'altar_right_snowcave',
    'cauldron',
    'lavalake_pit', 'lavalake_pit_cracked', 'lavalake_racing', 'lavalake2', 'lavalake_pit_bottom',
]);

// Scenes the game places NON-DETERMINISTICALLY (depend on seed AND coordinates AND
// runtime entity ids), so telescope can't and shouldn't predict them — a purposeful
// miss, not a bug. Excluded from the scene-placement score.
//  - desert_ruins_* : the desert surface ruins (base/block/etc.).
export const SCENE_NONDETERMINISTIC_RE = /^desert_ruins_/;

// Scene-name aliases: telescope and the game use different basenames for the SAME
// scene. Normalize the GAME basename to telescope's name before matching so they
// pair up instead of scoring a miss+extra. (Confirmed by exact-position coincidence
// in the seed-1 dump.)
export const SCENE_NAME_ALIAS = {
    secret_lab: 'orbroom',                // the orb room is dumped as secret_lab
    essenceroom_submerged: 'essenceroom', // submerged variant of the essence room
    scale_old: 'scale',                   // the surface scale (kiuas) scene
    teleroom: 'teleportroom',             // the teleport room
};

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

// Shop origins place real item entities at worldgen. Physical stock (wands) dumps
// as a discrete pickup; spell stock is captured too now (the CreateItemActionEntity
// hook), but as `spell`-kind cards scored by PLACEMENT (scoreSpells), not here.
export const SHOP_ORIGINS = new Set(['shop', 'laboratory', 'holy_mountain_shop', 'hourglass_shop']);

// Is this telescope canon-row a container's content (vs a real placement)?
export function isContainerContent(row) {
    const origin = row.raw?.origin;
    // Spell predictions are folded to the `spell` kind in canonTelescope and scored
    // by placement (scoreSpells) — they never reach here (not in TELESCOPE_KINDS). A
    // remaining shop_slot row is non-spell shop stock (e.g. a laboratory item) the
    // sweep can't observe unrolled, so it stays excluded.
    if (row.kind === 'shop_slot') return true;
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
