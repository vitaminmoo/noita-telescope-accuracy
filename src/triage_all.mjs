// One-off triage: annotate every current non-enemy miss/extra with its likely
// mechanism, using the fixture (oracle) + telescope generation + lua_stack.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK, canonGame, canonTelescope, TELESCOPE_KINDS, isContainerContent } from './lib/entity_identity.mjs';
import { setupTelescope, generateForPW } from './lib/telescope_entities.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = existsSync(join(repoRoot, 'fixtures')) ? join(repoRoot, 'fixtures') : join(repoRoot, 'data/dumps');
const SET = process.argv.find((a) => a.startsWith('--set='))?.slice(6) || join(fixturesRoot, 'full_i');
const set = JSON.parse(readFileSync(join(SET, 'set.json'), 'utf8'));
const isNGP = (set.ng || 0) > 0;
const ctx = await setupTelescope({ seed: set.seed, ng: set.ng || 0, gameMode: set.gameMode || 'normal', showEnemies: true });
const readNd = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];

const region = set.regions[0];
const dir = join(SET, region.dir);
const mask = new Set();
for (const t of readNd(join(dir, 'tile_done.ndjson'))) {
  if (typeof t.x === 'number' && typeof t.size === 'number')
    for (let cy = Math.floor(t.y / CHUNK); cy <= Math.floor((t.y + t.size - 1) / CHUNK); cy++)
      for (let cx = Math.floor(t.x / CHUNK); cx <= Math.floor((t.x + t.size - 1) / CHUNK); cx++) mask.add(`${cx},${cy}`);
}
const inMask = (r) => mask.has(`${Math.floor(r.x / CHUNK)},${Math.floor(r.y / CHUNK)}`);

const rawItems = readNd(join(dir, 'items.ndjson'));
const rawMobs = readNd(join(dir, 'mobs.ndjson'));
const gameRaw = [...readNd(join(dir, 'pixel_scenes.ndjson')), ...rawItems, ...rawMobs];
const gameCanon = gameRaw.map((r) => canonGame(r, isNGP));
const game = gameCanon.filter((r) => r.raw.chest_eid == null && r.covered && TELESCOPE_KINDS.has(r.kind) && inMask(r));
const teleAll = generateForPW(ctx, region.pw, region.pwv).map((r) => canonTelescope(r, isNGP)).filter((r) => TELESCOPE_KINDS.has(r.kind) && inMask(r));
const tele = teleAll.filter((r) => !isContainerContent(r));

const key = (r) => `${r.kind}|${Math.round(r.x)}|${Math.round(r.y)}`;
const g = new Map(), t = new Map();
for (const r of game) if (!g.has(key(r))) g.set(key(r), r);
for (const r of tele) if (!t.has(key(r))) t.set(key(r), r);
const missing = [...g].filter(([k]) => !t.has(k)).map(([, r]) => r).filter((r) => r.kind !== 'enemy');
const extra = [...t].filter(([k]) => !g.has(k)).map(([, r]) => r).filter((r) => r.kind !== 'enemy');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const nearestMob = (r) => { let best = null, bd = 1e9; for (const m of rawMobs) { const d = Math.hypot(m.x - r.x, m.y - r.y); if (d < bd) { bd = d; best = m; } } return { d: Math.round(bd), f: best && best.file.split('/').pop() }; };
const nearestGame = (r, sameKind) => { let best = null, bd = 1e9; for (const o of gameCanon) { if (o === r) continue; if (sameKind && o.kind !== r.kind) continue; const d = dist(o, r); if (d < bd) { bd = d; best = o; } } return { d: Math.round(bd), f: best && (best.raw.file || '').split('/').pop(), kind: best && best.kind }; };
const nearestTele = (r) => { let best = null, bd = 1e9; for (const o of teleAll) { if (o === r) continue; const d = dist(o, r); if (d < bd) { bd = d; best = o; } } return { d: Math.round(bd), k: best && best.kind, det: best && best.detail, o: best && best.raw?.origin }; };

console.log('=== MISSES (game has, telescope lacks) ===');
for (const r of missing.sort((a, b) => a.kind.localeCompare(b.kind))) {
  const mob = nearestMob(r);
  const lua = r.raw.lua_stack ? r.raw.lua_stack.find(s => /scripts\//.test(s)) : null;
  console.log(`${r.kind.padEnd(7)} (${r.x},${r.y}) ${(r.raw.file||'').replace('data/entities/','')}`);
  console.log(`   nearestMob ${mob.d}px ${mob.f||''} | nearestTele ${JSON.stringify(nearestTele(r))} | lua:${lua||'(none)'}`);
}
console.log('\n=== EXTRAS (telescope invented) ===');
for (const r of extra.sort((a, b) => a.kind.localeCompare(b.kind))) {
  console.log(`${r.kind.padEnd(7)} (${Math.round(r.x)},${Math.round(r.y)}) origin=${r.raw?.origin||'?'} detail=${r.detail||''} biome=${r.raw?.biome||''}`);
  console.log(`   nearestGameSameKind ${JSON.stringify(nearestGame(r, true))} | nearestGameAny ${JSON.stringify(nearestGame(r, false))}`);
}
