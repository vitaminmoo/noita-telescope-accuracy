// Triage tool: dump every telescope-vs-game miss and extra, grouped so
// classification artifacts (quest chests, special items, label mismatches)
// are obvious. For each miss (game has, telescope lacks) we show what telescope
// DOES emit nearby; for each extra (telescope invented) we show what the game
// actually has nearby. Writes markdown to --out (default scripts/mismatches.md).
//
// Usage: node scripts/mismatch_report.mjs --set=DIR [--kind=K] [--out=FILE] [--tol=32]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK, canonGame, canonTelescope, TELESCOPE_KINDS, isContainerContent } from './lib/entity_identity.mjs';
import { setupTelescope, generateForPW } from './lib/telescope_entities.mjs';
import { getBiomeAtWorldCoordinates } from './lib/telescope.mjs';

const o = { set: null, kind: null, out: 'scripts/mismatches.md', tol: 32, includeEnemies: false };
for (const a of process.argv.slice(2)) {
    if (a.startsWith('--set=')) o.set = a.slice(6);
    else if (a.startsWith('--kind=')) o.kind = a.slice(7);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--tol=')) o.tol = +a.slice(6);
    else if (a === '--include-enemies') o.includeEnemies = true;
}
if (!o.set) { console.error('--set=DIR required'); process.exit(1); }

const readNd = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : [];
const baseName = (f) => (f || '').replace(/^data\//, '').replace(/\.(xml|png)$/i, '').split('/').pop();
const fullPath = (f) => (f || '').replace(/^data\/entities\//, '').replace(/\.(xml|png)$/i, '');

const set = JSON.parse(readFileSync(join(o.set, 'set.json'), 'utf8'));
const isNGP = (set.ng || 0) > 0;
const ctx = await setupTelescope({ seed: set.seed, ng: set.ng || 0, gameMode: set.gameMode || 'normal', showEnemies: true });

let out = `# Telescope vs game mismatches — ${o.set}\n\nseed ${set.seed} · ng ${set.ng || 0}. Misses = game has / telescope lacks. Extras = telescope invented.\nEach group shows count + sample positions; "→ tele:" / "→ game:" is what the OTHER side has within ${o.tol}px.\n`;

for (const region of set.regions) {
    const dir = join(o.set, region.dir || region.name);
    if (!existsSync(join(dir, 'tile_done.ndjson'))) continue;
    const mask = new Set();
    for (const t of readNd(join(dir, 'tile_done.ndjson'))) {
        if (typeof t.x === 'number' && typeof t.size === 'number') {
            for (let cy = Math.floor(t.y / CHUNK); cy <= Math.floor((t.y + t.size - 1) / CHUNK); cy++)
                for (let cx = Math.floor(t.x / CHUNK); cx <= Math.floor((t.x + t.size - 1) / CHUNK); cx++) mask.add(`${cx},${cy}`);
        }
    }
    const inMask = (r) => mask.has(`${Math.floor(r.x / CHUNK)},${Math.floor(r.y / CHUNK)}`);
    const gameRaw = [...readNd(join(dir, 'pixel_scenes.ndjson')), ...readNd(join(dir, 'items.ndjson')), ...readNd(join(dir, 'mobs.ndjson'))];
    const gameCanon = gameRaw.map((r) => canonGame(r, isNGP));
    const game = gameCanon.filter((r) => r.raw.chest_eid == null && r.covered && TELESCOPE_KINDS.has(r.kind) && inMask(r));
    const teleAll = generateForPW(ctx, region.pw, region.pwv).map((r) => canonTelescope(r, isNGP)).filter((r) => TELESCOPE_KINDS.has(r.kind) && inMask(r));
    const tele = teleAll.filter((r) => !isContainerContent(r));

    const key = (r) => `${r.kind}|${Math.round(r.x)}|${Math.round(r.y)}`;
    const g = new Map(), t = new Map();
    for (const r of game) if (!g.has(key(r))) g.set(key(r), r);
    for (const r of tele) if (!t.has(key(r))) t.set(key(r), r);
    const missing = [...g].filter(([k]) => !t.has(k)).map(([, r]) => r);
    const extra = [...t].filter(([k]) => !g.has(k)).map(([, r]) => r);

    const near = (r, rows) => rows.filter((x) => x.x !== undefined && (x.x !== r.x || x.y !== r.y) && Math.abs(x.x - r.x) <= o.tol && Math.abs(x.y - r.y) <= o.tol);
    const teleLabel = (r) => `${r.kind}${r.detail ? ':' + r.detail : ''}`;
    const gameLabel = (r) => baseName(r.raw?.file);
    const filt = (r) => (o.includeEnemies || r.kind !== 'enemy') && (!o.kind || r.kind === o.kind);
    // top-2 most-common "other side" labels across a group's rows
    const topNearby = (rows, pool, label) => {
        const tally = {};
        for (const r of rows) for (const x of near(r, pool)) tally[label(x)] = (tally[label(x)] || 0) + 1;
        const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
        return top.length ? top.join(', ') : '∅';
    };
    // distance to the nearest SAME-KIND entity on the other side. Small Δ = a
    // position OFFSET (telescope placed the right kind, a few px off — a real
    // placement bug); ∅ = the other side has no such kind nearby at all.
    const nearestSameKind = (r, pool) => {
        let best = Infinity;
        for (const x of pool) {
            if (x.kind !== r.kind || (x.x === r.x && x.y === r.y)) continue;
            const d = Math.hypot(x.x - r.x, x.y - r.y);
            if (d < best) best = d;
        }
        return best;
    };
    const offsetCol = (rows, pool) => {
        const ds = rows.map((r) => nearestSameKind(r, pool)).filter((d) => d <= 256).sort((a, b) => a - b);
        if (!ds.length) return '∅';
        const lo = Math.round(ds[0]), hi = Math.round(ds[ds.length - 1]);
        return `${lo === hi ? lo : lo + '–' + hi}px${ds.length < rows.length ? ` (${ds.length}/${rows.length})` : ''}`;
    };
    // distance to the nearest CHUNK-grid edge (512px). A miss/extra hugging a
    // chunk boundary is a WOBBLE suspect — the biome edge wobbles across the grid
    // so a near-edge spawn can flip present/absent between telescope and game.
    const chunkEdgeDist = (r) => {
        const ex = ((Math.round(r.x) % CHUNK) + CHUNK) % CHUNK, ey = ((Math.round(r.y) % CHUNK) + CHUNK) % CHUNK;
        return Math.min(Math.min(ex, CHUNK - ex), Math.min(ey, CHUNK - ey));
    };
    const edgeCol = (rows) => {
        const ds = rows.map(chunkEdgeDist).sort((a, b) => a - b);
        const near = ds.filter((d) => d <= 12).length;
        return `${ds[0]}px${near ? ` (${near}/${rows.length}≤12)` : ''}`;
    };

    const gameSameKind = gameCanon.filter((r) => r.covered);
    // A spawn is a genuine WOBBLE suspect only when telescope's biome actually FLIPS
    // between the un-wobbled and wobbled resolution at that exact pixel — being merely
    // <12px from a chunk edge does NOT mean the edge wobble crosses it (verified live:
    // 18/19 near-edge mismatches resolve to the same biome both ways). Tag the real flips.
    const gm = set.gameMode || 'normal';
    const wobbleFlips = (r) => {
        try {
            const w = getBiomeAtWorldCoordinates(ctx.biomeData, Math.round(r.x), Math.round(r.y), isNGP, gm, true);
            const nw = getBiomeAtWorldCoordinates(ctx.biomeData, Math.round(r.x), Math.round(r.y), isNGP, gm, false);
            return w.pos.x !== nw.pos.x || w.pos.y !== nw.pos.y;
        } catch { return false; }
    };
    // per-row notes (specific to that one item)
    const edge1 = (r) => { const d = chunkEdgeDist(r); return `${d}px${wobbleFlips(r) ? ' ⚠wobble' : ''}`; };
    const off1 = (r, pool) => { const d = nearestSameKind(r, pool); return d <= 256 ? Math.round(d) + 'px' : '∅'; };
    const nb3 = (r, pool, label) => [...new Set(near(r, pool).map(label))].slice(0, 3).join(', ') || '∅';

    const missRows = missing.filter(filt).sort((a, b) => a.kind.localeCompare(b.kind) || fullPath(a.raw?.file).localeCompare(fullPath(b.raw?.file)) || a.x - b.x || a.y - b.y);
    const extraRows = extra.filter(filt).sort((a, b) => a.kind.localeCompare(b.kind) || (a.detail || '').localeCompare(b.detail || '') || a.x - b.x || a.y - b.y);

    out += `\n## region ${region.name} — ${missRows.length} misses, ${extraRows.length} extras (enemy ${o.includeEnemies ? 'included' : 'excluded'})\n`;

    out += `\n### MISSES — game has, telescope lacks (one row per item)\n\n| kind | game entity | pos | chunk-edge | tele-offset | telescope nearby |\n|---|---|---|---|---|---|\n`;
    for (const r of missRows) {
        out += `| ${r.kind} | \`${fullPath(r.raw?.file)}\` | (${r.x},${r.y}) | ${edge1(r)} | ${off1(r, teleAll)} | ${nb3(r, teleAll, teleLabel)} |\n`;
    }

    out += `\n### EXTRAS — telescope invented (game lacks) (one row per item)\n\n| kind | telescope origin · detail | pos | chunk-edge | game-offset | game nearby |\n|---|---|---|---|---|---|\n`;
    for (const r of extraRows) {
        out += `| ${r.kind} | ${r.raw?.origin || '?'}${r.detail ? ' · ' + r.detail : ''} | (${Math.round(r.x)},${Math.round(r.y)}) | ${edge1(r)} | ${off1(r, gameSameKind)} | ${nb3(r, gameCanon, gameLabel)} |\n`;
    }
}

writeFileSync(o.out, out);
console.log(`wrote ${o.out} (${out.split('\n').length} lines)`);
