// Helpers shared by scripts/{verify,dump}.mjs and the renderers in
// scripts/_visual.mjs. Everything in here is Node-only glue around the
// browser modules under js/ — no game logic should live here; if you
// find yourself reimplementing something from js/, import it instead.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
// Telescope js/ is reached through the bridge so the source dir is swappable
// per git ref (TELESCOPE_DIR); see scripts/lib/telescope.mjs.
import { loadPNG, generateBiomeData, BIOME_CONFIG, GENERATOR_CONFIG } from './lib/telescope.mjs';

// Run the same biome-map pipeline the browser does: sanitize+decode the
// PNG via js/png_sanitizer (UPNG under Node), then feed the RGBA buffer
// through generateBiomeData to produce {pixels, heaven, hell} the way
// js/utils.js::getBiomeAtWorldCoordinates expects.
export async function loadBiomeData(path, { seed = 0, ng = 0, gameMode = 'normal' } = {}) {
    // png_sanitizer resolves URLs relative to its own file (js/), so prepend ../.
    const base = await loadPNG('../' + path);
    const isAlt = ng > 0 || gameMode === 'nightmare';
    const w = isAlt ? BIOME_CONFIG.W_NGP : BIOME_CONFIG.W_NG0;
    const h = isAlt ? BIOME_CONFIG.H_NGP : BIOME_CONFIG.H_NG0;
    const data = generateBiomeData(seed, ng, gameMode, base.data, w, h);
    data.width = w;
    data.height = h;
    return data;
}

// Gunzip-aware NDJSON reader so the gzipped fixtures in data/dumps/ can
// be passed in directly.
export function readDump(path) {
    const buf = readFileSync(path);
    return path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

// Fold a biome's noita XML name to its primary GENERATOR_CONFIG key, so
// telescope's color-table key (always the primary) can be compared
// against noita's per-chunk xmlName (which may be any aliasXMLs entry).
const ALIAS_TO_PRIMARY = (() => {
    const out = Object.create(null);
    for (const [primary, conf] of Object.entries(GENERATOR_CONFIG)) {
        if (Array.isArray(conf.aliasXMLs)) {
            for (const xml of conf.aliasXMLs) out[xml] = primary;
        }
    }
    return out;
})();

export function canonicalBiome(name) {
    if (name == null) return null;
    return ALIAS_TO_PRIMARY[name] || name;
}
