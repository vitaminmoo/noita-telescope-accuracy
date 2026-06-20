// Prototype: pixel-scene PLACEMENT comparison — does telescope place the same
// gameplay scenes at the same positions as the game's sweep dump?
//
// Telescope's scene output covers STATIC + biome-color scenes only (prng-rolled
// splice scenes are not emitted), so we score the intersection: scene names
// telescope can emit, matched against the game's pixel_scenes.ndjson on
// (sceneName, position±tol), clipped to the covered mask.
//
//   node scripts/compare_scenes.mjs [--set=DIR] [--tol=64]
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTelescope } from './lib/telescope_entities.mjs';
import { loadGeneration } from './lib/telescope.mjs';
import { SCENE_CUSTOM_ART, SCENE_NAME_ALIAS, SCENE_NONDETERMINISTIC_RE } from './lib/exceptions.mjs';

const CHUNK = 512, Y_SHIFT_CHUNKS = 14;
const tol = +(process.argv.find((a) => a.startsWith('--tol='))?.slice(6) || 64);
// Default fixture path is layout-agnostic: fixtures/ (standalone repo) or
// data/dumps/ (in-place inside the telescope repo).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = existsSync(join(repoRoot, 'fixtures')) ? join(repoRoot, 'fixtures') : join(repoRoot, 'data/dumps');
const SET = process.argv.find((a) => a.startsWith('--set='))?.slice(6) || join(fixturesRoot, 'full_i');
const set = JSON.parse(readFileSync(join(SET, 'set.json'), 'utf8'));
const region = set.regions[0];
const dir = join(SET, region.dir);
const readNd = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];

// Coverage mask (chunk keys).
const mask = new Set();
for (const t of readNd(join(dir, 'tile_done.ndjson'))) {
  if (typeof t.x === 'number' && typeof t.size === 'number')
    for (let cy = Math.floor(t.y / CHUNK); cy <= Math.floor((t.y + t.size - 1) / CHUNK); cy++)
      for (let cx = Math.floor(t.x / CHUNK); cx <= Math.floor((t.x + t.size - 1) / CHUNK); cx++) mask.add(`${cx},${cy}`);
}
const inMask = (x, y) => mask.has(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);

const ctx = await setupTelescope({ seed: set.seed, ng: set.ng || 0, gameMode: set.gameMode || 'normal' });
const gen = await loadGeneration();
const { STATIC_PIXEL_SCENES, PIXEL_SCENE_BIOMES } = gen;
const biomeData = ctx.biomeData;
const mapWidth = biomeData.width;

// Canonical scene name: collapse the telescope/game naming differences (applied to
// BOTH sides — telescope itself uses e.g. both 'orbroom' and 'secret_lab').
const canon = (n) => SCENE_NAME_ALIAS[n] || n;

// ── Telescope scenes: static + biome-color (mirrors dump.mjs runPixelScenes) ──
const teleScenes = [];
for (const scene of STATIC_PIXEL_SCENES) {
  if (!scene.inNGP && (set.ng || 0) > 0) continue;
  teleScenes.push({ sceneName: canon(scene.name.split('/').pop()), x: scene.x, y: scene.y, source: 'static' });
}
for (let y = 0; y < biomeData.height; y++) {
  for (let x = 0; x < mapWidth; x++) {
    const info = PIXEL_SCENE_BIOMES[biomeData.pixels[y * mapWidth + x]];
    if (!info) continue;
    const adjX = x * CHUNK - mapWidth * (CHUNK / 2) + (info.offsetX || 0);
    const adjY = y * CHUNK - Y_SHIFT_CHUNKS * CHUNK + (info.offsetY || 0);
    teleScenes.push({ sceneName: canon(info.name), x: adjX, y: adjY, source: 'biome-color' });
  }
}
// Drop custom-art scenes telescope deliberately doesn't emit (it overlays its own
// art) — they'd otherwise read as telescope misses but aren't bugs.
const scored = (name) => !SCENE_CUSTOM_ART.has(name) && !SCENE_NONDETERMINISTIC_RE.test(name);
const teleNames = new Set(teleScenes.map((s) => s.sceneName).filter(scored));

// ── Game scenes: basename of file (alias→telescope name); restrict to emittable ──
const baseName = (f) => (f || '').replace(/\.png$/i, '').split('/').pop();
const gameScenes = readNd(join(dir, 'pixel_scenes.ndjson'))
  .map((r) => ({ sceneName: canon(baseName(r.file)), x: r.x, y: r.y, file: r.file }))
  .filter((s) => teleNames.has(s.sceneName));

// ── Match on (sceneName, position±tol), in-mask ──
const tInMask = teleScenes.filter((s) => inMask(s.x, s.y) && scored(s.sceneName));
const gInMask = gameScenes.filter((s) => inMask(s.x, s.y));
const used = new Set();
const matchOne = (a, pool) => {
  for (let i = 0; i < pool.length; i++) {
    if (used.has(pool === gInMask ? 'g' + i : 't' + i)) continue;
    const b = pool[i];
    if (b.sceneName === a.sceneName && Math.abs(b.x - a.x) <= tol && Math.abs(b.y - a.y) <= tol) {
      used.add(pool === gInMask ? 'g' + i : 't' + i); return b;
    }
  }
  return null;
};
const per = {};
const tally = (name, f) => { (per[name] ||= { matched: 0, missing: 0, extra: 0 })[f]++; };
const missing = [], extra = [];
// game → telescope (recall)
for (const g of gInMask) {
  const hit = matchOne(g, tInMask);
  if (hit) tally(g.sceneName, 'matched');
  else { tally(g.sceneName, 'missing'); missing.push(g); }
}
used.clear();
// telescope → game (extras)
for (const t of tInMask) {
  const hit = matchOne(t, gInMask);
  if (!hit) { tally(t.sceneName, 'extra'); extra.push(t); }
}

const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : 'n/a');
console.log(`\n=== pixel-scene placement (telescope-emittable names, tol=${tol}px, in-mask) ===`);
console.log(`telescope scenes in-mask: ${tInMask.length} | game scenes (matched names) in-mask: ${gInMask.length}\n`);
console.log('  ' + 'scene'.padEnd(26) + 'match'.padEnd(8) + 'miss'.padEnd(7) + 'extra'.padEnd(7) + 'recall'.padEnd(9) + 'prec');
let M = 0, Mi = 0, E = 0;
for (const [name, s] of Object.entries(per).sort((a, b) => (b[1].matched + b[1].missing) - (a[1].matched + a[1].missing))) {
  M += s.matched; Mi += s.missing; E += s.extra;
  console.log('  ' + name.padEnd(26) + String(s.matched).padEnd(8) + String(s.missing).padEnd(7) + String(s.extra).padEnd(7) + (pct(s.matched, s.matched + s.missing) + '%').padEnd(9) + pct(s.matched, s.matched + s.extra) + '%');
}
console.log('  ' + 'TOTAL'.padEnd(26) + String(M).padEnd(8) + String(Mi).padEnd(7) + String(E).padEnd(7) + (pct(M, M + Mi) + '%').padEnd(9) + pct(M, M + E) + '%');

console.log(`\n-- sample MISSING (game has, telescope lacks) --`);
for (const s of missing.slice(0, 12)) console.log(`  ${s.sceneName.padEnd(22)} (${s.x},${s.y})`);
console.log(`\n-- sample EXTRA (telescope invented) --`);
for (const s of extra.slice(0, 12)) console.log(`  ${s.sceneName.padEnd(22)} (${s.x},${s.y}) [${s.source}]`);
