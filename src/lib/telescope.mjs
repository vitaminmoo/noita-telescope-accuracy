// Bridge to the telescope `js/` source-under-test.
//
// Every harness access to telescope code goes through this module so the
// directory it reads from can be swapped per git ref via the TELESCOPE_DIR
// env var (that's how scripts/compare.mjs scores two refs against the same
// fixtures). With TELESCOPE_DIR unset it points at this repo's own js/, so
// running in-place (npm run report) behaves exactly as before.
//
// Modules are loaded with dynamic import() of a file:// URL under
// $TELESCOPE_DIR/js/, NOT static `../js/` specifiers, which is what makes the
// path swappable. Telescope's own intra-js relative imports and bare deps
// (upng-js) still resolve relative to that checkout, so a worktree placed
// inside this repo finds the shared node_modules by the usual upward walk.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));    // <harness>/(scripts|src)/lib
const harnessRoot = resolve(here, '..', '..');
// Two layouts: in-place (harness lives inside the telescope repo → js/ is at the
// root) and standalone (telescope is a git submodule at telescope/). Auto-detect
// so the same bridge works in both. TELESCOPE_DIR always wins (compare.mjs sets
// it to a per-ref worktree).
const defaultDir = existsSync(join(harnessRoot, 'js'))
    ? harnessRoot
    : join(harnessRoot, 'telescope');

export const TELESCOPE_DIR = process.env.TELESCOPE_DIR
    ? resolve(process.env.TELESCOPE_DIR)
    : defaultDir;

const mod = (rel) => import(pathToFileURL(join(TELESCOPE_DIR, 'js', rel)).href);

// Eagerly loaded, light, no-canvas-at-eval modules — the exact set that
// _common.mjs needs synchronously in its top-level body (GENERATOR_CONFIG
// drives an alias table built at module-eval). These are the same modules that
// loaded eagerly before, via _common's old static `../js/` imports.
const [pngS, biomeGen, genCfg, utils] = await Promise.all([
    mod('png_sanitizer.js'),
    mod('biome_generator.js'),
    mod('generator_config.js'),
    mod('utils.js'),
]);

export const loadPNG = pngS.loadPNG;
export const generateBiomeData = biomeGen.generateBiomeData;
export const BIOME_CONFIG = biomeGen.BIOME_CONFIG;
export const GENERATOR_CONFIG = genCfg.GENERATOR_CONFIG;
export const getBiomeAtWorldCoordinates = utils.getBiomeAtWorldCoordinates;

// Heavier generation modules, loaded on demand. setupTelescope() installs its
// canvas stubs before calling this, so these (which allocate canvases at eval)
// must NOT be eager-loaded above.
export async function loadGeneration() {
    const [tile, pscene, poi, statics, settings] = await Promise.all([
        mod('tile_generator.js'),
        mod('pixel_scene_generation.js'),
        mod('poi_scanner.js'),
        mod('static_spawns.js'),
        mod('settings.js'),
    ]);
    return {
        generateBiomeTiles: tile.generateBiomeTiles,
        loadPixelSceneData: pscene.loadPixelSceneData,
        prescanSpawnFunctions: poi.prescanSpawnFunctions,
        scanSpawnFunctions: poi.scanSpawnFunctions,
        getSpecialPoIs: poi.getSpecialPoIs,
        addStaticPixelScenes: statics.addStaticPixelScenes,
        updateSettings: settings.updateSettings,
    };
}
