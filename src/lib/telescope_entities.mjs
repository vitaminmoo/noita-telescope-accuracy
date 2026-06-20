// Headless telescope entity generation, factored for reuse across the harness.
//
// Heavy, PW-independent setup (biome map → wang tiles → pixel-scene data →
// tile-spawn prescan) runs ONCE via setupTelescope(); generating a given
// parallel world is then a cheap scanSpawnFunctions/getSpecialPoIs pass via
// generateForPW(). Coordinates come out already shifted into that PW's global
// frame (scanSpawnFunctions adds pwIndex*worldSize*512), so they line up
// directly with sweep's world-pixel coordinates.
//
// emitPoi/emitInner mirror scripts/dump.mjs (the `entities` subcommand). Kept in
// sync by hand for now; if they drift, dump.mjs is the reference.

// Canvas stubs — the tile/pixel-scene generators allocate offscreen canvases
// for browser rendering, but the spawn-scan paths only read the raw RGB buffers
// those canvases wrap. Install minimal stubs at module-eval time, before any
// canvas-touching js/ module is *dynamically* imported inside setupTelescope().
function makeFakeCanvas(w, h) {
    const ctx = {
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
        putImageData() {}, drawImage() {},
        getImageData: (x, y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    };
    return { width: w, height: h, getContext: () => ctx };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement: (tag) => tag === 'canvas' ? makeFakeCanvas(0, 0) : {},
        getElementById: () => null,
    };
}
if (typeof globalThis.OffscreenCanvas === 'undefined') {
    globalThis.OffscreenCanvas = class { constructor(w, h) { Object.assign(this, makeFakeCanvas(w, h)); } };
}

import { loadBiomeData } from '../_common.mjs';
// Telescope js/ via the bridge (swappable per git ref); see lib/telescope.mjs.
import { GENERATOR_CONFIG, loadPNG, loadGeneration } from './telescope.mjs';

// Build the PW-independent generation context once.
export async function setupTelescope({
    seed, ng = 0, gameMode = 'normal',
    biomeMap = 'data/biome_maps/biome_map.png', showEnemies = false, quiet = true,
} = {}) {
    // loadGeneration() pulls the heavy canvas-touching generators on demand —
    // after the canvas stubs above are installed. loadPNG comes from the bridge.
    const {
        generateBiomeTiles, loadPixelSceneData,
        prescanSpawnFunctions, scanSpawnFunctions, getSpecialPoIs,
        addStaticPixelScenes, updateSettings,
    } = await loadGeneration();
    updateSettings({ showEnemies });

    const origLog = console.log, origWarn = console.warn;
    if (quiet) { console.log = () => {}; console.warn = () => {}; }
    try {
        const biomeData = await loadBiomeData(biomeMap, { seed, ng, gameMode });
        const { width: w, height: h } = biomeData;
        for (const k of Object.keys(GENERATOR_CONFIG)) {
            const conf = GENERATOR_CONFIG[k];
            if (conf.enabled && !conf.wangData && conf.wangFile) conf.wangData = await loadPNG(conf.wangFile);
        }
        const tileLayers = await generateBiomeTiles(biomeData.pixels, w, h, GENERATOR_CONFIG, seed, ng, 0, gameMode);
        await loadPixelSceneData();
        const tileSpawns = prescanSpawnFunctions(tileLayers, ng > 0, gameMode);
        return { biomeData, tileSpawns, seed, ng, gameMode, fns: { scanSpawnFunctions, getSpecialPoIs, addStaticPixelScenes } };
    } finally {
        if (quiet) { console.log = origLog; console.warn = origWarn; }
    }
}

// Generate one parallel world's flattened entity rows (global coords).
export function generateForPW(ctx, pwIndex = 0, pwIndexVertical = 0) {
    const { biomeData, tileSpawns, seed, ng, gameMode, fns } = ctx;
    const origLog = console.log, origWarn = console.warn;
    console.log = () => {}; console.warn = () => {};
    let pois = [];
    try {
        const { generatedSpawns } = fns.scanSpawnFunctions(
            biomeData, tileSpawns, seed, ng, pwIndex, pwIndexVertical, true, {}, gameMode);
        pois.push(...fns.getSpecialPoIs(biomeData, seed, ng, pwIndex, pwIndexVertical, {}, gameMode));
        const statics = fns.addStaticPixelScenes(seed, ng, pwIndex, pwIndexVertical, biomeData, true, {}, false, gameMode);
        pois.push(...statics.pois.filter((p) => p.type !== 'pixel_scene'));
        pois.push(...generatedSpawns);
    } finally {
        console.log = origLog; console.warn = origWarn;
    }
    const rows = [];
    for (const poi of pois) emitPoi(poi, rows);
    return rows;
}

// ── emitPoi / emitInner (mirror of scripts/dump.mjs) ─────────────────────────
function emitPoi(poi, rows, originOverride) {
    const origin = originOverride || poi.type;
    const baseBiome = poi.biome || null;
    switch (poi.type) {
        case 'shop':
        case 'laboratory': {
            for (const it of poi.items || []) {
                rows.push({
                    category: 'shop_slot', x: it.x ?? poi.x, y: it.y ?? poi.y, biome: baseBiome, origin,
                    subtype: poi.type === 'laboratory' ? 'laboratory_item' : 'shop_spell',
                    detail: it.spell || it.item || null,
                });
            }
            return;
        }
        case 'pacifist_chest':
        case 'chest':
            rows.push({ category: 'chest', x: poi.x, y: poi.y, biome: baseBiome, origin });
            for (const it of poi.items || []) emitInner(it, rows, origin, baseBiome, poi.x, poi.y, { x: poi.x, y: poi.y });
            return;
        case 'great_chest':
            rows.push({ category: 'chest_great', x: poi.x, y: poi.y, biome: baseBiome, origin });
            for (const it of poi.items || []) emitInner(it, rows, origin, baseBiome, poi.x, poi.y, { x: poi.x, y: poi.y });
            return;
        case 'wand':
            rows.push({ category: 'wand', x: poi.x, y: poi.y, biome: baseBiome, origin });
            return;
        case 'utility_box':
            // A utility box is a container, like a chest: the game places the
            // utility_box.xml entity at worldgen but doesn't spawn its dispensed
            // items until it's shot open, and the camera sweep never opens it. So
            // emit the box itself as the scorable placement (item · utility_box)
            // and tag its contents with origin 'utility_box' so they're excluded
            // as unobservable container-content (see isContainerContent).
            rows.push({ category: 'item', x: poi.x, y: poi.y, biome: baseBiome, origin: 'utility_box', detail: 'utility_box' });
            for (const it of poi.items || []) emitInner(it, rows, 'utility_box', baseBiome, poi.x, poi.y);
            return;
        case 'item':
            emitInner(poi, rows, origin, baseBiome, poi.x, poi.y);
            return;
        case 'entity':
            rows.push({ category: 'enemy', x: poi.x, y: poi.y, biome: baseBiome, origin, detail: poi.entity });
            return;
        case 'puzzle':
        case 'eye_room':
        case 'tiny':
        case 'starting_loadout':
        case 'holy_mountain_shop':
        case 'pyramid_boss':
        case 'alchemist_boss':
        case 'triangle_boss':
        case 'dragon':
            for (const it of poi.items || []) emitInner(it, rows, origin, baseBiome, poi.x, poi.y);
            return;
        default:
            if (Array.isArray(poi.items) && poi.items.length > 0) {
                for (const it of poi.items) emitInner(it, rows, origin, baseBiome, poi.x, poi.y);
                return;
            }
            rows.push({ category: 'other', x: poi.x, y: poi.y, biome: baseBiome, origin, subtype: poi.type });
            return;
    }
}

// `parent` (when set, for chest content) is the chest's anchor {x,y}; it is
// stamped onto each emitted content row as parentX/parentY so the harness can
// group a chest's loot by its chest — the reward's own position is unreliable
// (it spawns at a scratch coord then teleports onto the chest, and in-game can
// upwarp through terrain).
function emitInner(it, rows, origin, biome, fallbackX, fallbackY, parent) {
    const x = it.x ?? fallbackX, y = it.y ?? fallbackY;
    const p = parent ? { parentX: parent.x, parentY: parent.y } : {};
    if (it.type === 'wand' || it.item === 'wand') { rows.push({ category: 'wand', x, y, biome, origin, ...p }); return; }
    if (it.type === 'chest') { rows.push({ category: 'chest', x, y, biome, origin, ...p }); return; }
    if (it.type === 'great_chest') { rows.push({ category: 'chest_great', x, y, biome, origin, ...p }); return; }
    if (it.type === 'item' || it.item) {
        const name = it.item || it.type;
        let category = 'item';
        if (typeof name === 'string' && name.startsWith('potion')) category = 'potion';
        else if (typeof name === 'string' && name.startsWith('heart')) category = 'heart';
        rows.push({ category, x, y, biome, origin, detail: name, ...p });
        return;
    }
    if (it.type === 'spell' || it.spell) {
        rows.push({ category: 'shop_slot', x, y, biome, origin, subtype: 'shop_spell', detail: it.spell, ...p });
        return;
    }
    if (it.type === 'entity') { rows.push({ category: 'enemy', x, y, biome, origin, detail: it.entity, ...p }); return; }
    rows.push({ category: 'other', x, y, biome, origin, subtype: it.type || 'unknown', ...p });
}
