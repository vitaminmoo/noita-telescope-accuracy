// Compare telescope's predicted worldgen spawns against a `sweep` fixture set.
//
// Deterministic exact-diff: for every region in the set, build the coverage
// mask from tile_done, generate telescope for that parallel world, clip both
// sides to the mask, and match on (kind, x, y). Output is matched / missing
// (game has, telescope doesn't) / extra (telescope invented it), per kind and
// per region. missing/extra ARE the bug list — a cluster along a biome edge is
// a wobble bug; a cluster sharing a scene origin is a pixel-scene gate bug.
//
// Usage:
//   node scripts/verify_entities.mjs --set=data/dumps/entities/1_ng0
//   node scripts/verify_entities.mjs --set=DIR --dump=20        # show N sample mismatches
//   node scripts/verify_entities.mjs --set=DIR --kind=wand      # filter --dump to one kind
//   node scripts/verify_entities.mjs --set=DIR --show-enemies   # include enemy spawns
//
// See scripts/ENTITY_HARNESS.md.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHUNK, canonGame, canonTelescope, TELESCOPE_KINDS, isContainerContent } from './lib/entity_identity.mjs';
import { setupTelescope, generateForPW } from './lib/telescope_entities.mjs';

function parseArgs(argv) {
    const o = { set: null, dump: 0, kind: null, showEnemies: false, json: false, biomeMap: 'data/biome_maps/biome_map.png' };
    for (const a of argv) {
        if (a.startsWith('--set=')) o.set = a.slice(6);
        else if (a.startsWith('--dump=')) o.dump = +a.slice(7);
        else if (a.startsWith('--kind=')) o.kind = a.slice(7);
        else if (a === '--show-enemies') o.showEnemies = true;
        else if (a === '--json') o.json = true;
        else if (a.startsWith('--biome-map=')) o.biomeMap = a.slice(12);
        else { console.error(`unknown arg: ${a}`); process.exit(1); }
    }
    if (!o.set) { console.error('--set=DIR is required (a fixture-set dir with set.json)'); process.exit(1); }
    return o;
}

function readNdjson(path) {
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.startsWith('{')) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    return out;
}

// Coverage mask = set of covered chunk keys "cx,cy". Built from tile_done: union
// the explicit `chunks` each tile actually generated, plus the tile's geometric
// footprint as a floor (so a missing/odd chunks field never under-covers).
function buildMask(regionDir) {
    const mask = new Set();
    for (const t of readNdjson(join(regionDir, 'tile_done.ndjson'))) {
        if (typeof t.x === 'number' && typeof t.size === 'number') {
            const cx0 = Math.floor(t.x / CHUNK), cx1 = Math.floor((t.x + t.size - 1) / CHUNK);
            const cy0 = Math.floor(t.y / CHUNK), cy1 = Math.floor((t.y + t.size - 1) / CHUNK);
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) mask.add(`${cx},${cy}`);
        }
        if (typeof t.chunks === 'string') {
            for (const m of t.chunks.matchAll(/(-?\d+)\s*,\s*(-?\d+)/g)) mask.add(`${+m[1]},${+m[2]}`);
        }
    }
    return mask;
}

const inMask = (mask, r) => mask.has(`${r.cx},${r.cy}`);
const key = (r) => `${r.kind}|${Math.round(r.x)}|${Math.round(r.y)}`;

// Set diff on (kind, x, y) — DEDUPED by position. A worldgen placement is
// present-or-absent at a coordinate; telescope emits one row per placement,
// while the sweep can capture the same camera-bound spawn multiple times (its
// bucket re-drains as overlapping tiles revisit the area). Counting multiplicity
// made the dump look ~86% reproducible run-to-run; deduping by (kind, position)
// shows the true ~99% (the distinct placements ARE deterministic). So we compare
// distinct placements, which is what telescope actually predicts.
function diff(gameRows, teleRows) {
    const g = new Map(), t = new Map();
    for (const r of gameRows) if (!g.has(key(r))) g.set(key(r), r);
    for (const r of teleRows) if (!t.has(key(r))) t.set(key(r), r);
    const matched = [], missing = [], extra = [];
    for (const [k, r] of g) (t.has(k) ? matched : missing).push(r);
    for (const [k, r] of t) if (!g.has(k)) extra.push(r);
    return { matched, missing, extra };
}

function tally(acc, kind, field, n = 1) {
    acc[kind] = acc[kind] || { matched: 0, missing: 0, extra: 0 };
    acc[kind][field] += n;
}

// Coarse loot KIND for chest-content comparison: a chest's reward is matched
// by what KIND of thing dropped (wand / potion / heart / gold / ...), not its
// exact file or position — the reward spawns at a scratch coord, teleports onto
// the chest, and can upwarp through terrain. Returns null for non-loot (the
// chest_effect particle, etc.) so it's ignored.
function lootKind(s0) {
    const s = String(s0 || '').toLowerCase();
    if (/chest_effect|particle|image_emitter/.test(s)) return null;
    if (/wand/.test(s)) return 'wand';
    if (/gold_orb|shiny_orb|greed_orb/.test(s)) return 'gold_orb';
    if (/goldnugget|bloodmoney|^gold$|moneyamount/.test(s)) return 'gold';
    if (/potion/.test(s)) return 'potion';
    if (/powder_stash|powder/.test(s)) return 'powder_stash';
    if (/heart/.test(s)) return 'heart';
    if (/runestone/.test(s)) return 'runestone';
    if (/die/.test(s)) return 'die';
    if (/bomb/.test(s)) return 'bomb';
    if (/spell_refresh/.test(s)) return 'spell_refresh';
    if (/moon|kuu/.test(s)) return 'moon';
    if (/brimstone/.test(s)) return 'brimstone';
    if (/thunderstone|kiuaskivi/.test(s)) return 'thunderstone';
    if (/safe_haven/.test(s)) return 'safe_haven';
    if (/evil_eye/.test(s)) return 'evil_eye';
    if (/random_card|spell_/.test(s)) return 'card';
    if (/^chest|mimic/.test(s)) return null; // nested chest / mimic — skip
    return null; // unknown / non-loot → ignore rather than invent a kind
}

// Score chest CONTENTS by parent chest: group each side's reward rows under the
// chest they came from (dump: chest_x/chest_y tags from force-open; telescope:
// parentX/parentY), pair chests whose anchors coincide, and compare the SET of
// loot kinds. Only meaningful on a force-open dump (otherwise the game side is
// near-empty). Returns { matched, missing, extra, chestsPaired, chestsGameOnly,
// chestsTeleOnly, sampleMiss, sampleExtra }.
function scoreChestContents(gameContent, teleContent, anchorTol = 24) {
    const groupBy = (rows, ax, ay, src) => {
        const m = new Map();
        for (const r of rows) {
            const px = r.raw[ax], py = r.raw[ay];
            if (px == null || py == null) continue;
            const lk = lootKind(r.detail || r.raw.file || r.kind);
            if (!lk) continue;
            const k = `${Math.round(px)},${Math.round(py)}`;
            if (!m.has(k)) m.set(k, { x: px, y: py, kinds: new Set() });
            m.get(k).kinds.add(lk);
        }
        return m;
    };
    const G = groupBy(gameContent, 'chest_x', 'chest_y');
    const T = groupBy(teleContent, 'parentX', 'parentY');

    let matched = 0, missing = 0, extra = 0, chestsPaired = 0;
    const sampleMiss = [], sampleExtra = [];
    const teleUsed = new Set();
    for (const [, g] of G) {
        // pair with nearest telescope chest within tol
        let best = null, bestD = anchorTol + 1, bestKey = null;
        for (const [tk, t] of T) {
            if (teleUsed.has(tk)) continue;
            const d = Math.max(Math.abs(g.x - t.x), Math.abs(g.y - t.y));
            if (d < bestD) { bestD = d; best = t; bestKey = tk; }
        }
        if (!best) { // game chest with content, telescope predicted no chest here
            missing += g.kinds.size;
            for (const k of g.kinds) if (sampleMiss.length < 30) sampleMiss.push({ chest: `(${Math.round(g.x)},${Math.round(g.y)})`, kind: k, side: 'no-tele-chest' });
            continue;
        }
        teleUsed.add(bestKey); chestsPaired++;
        for (const k of g.kinds) {
            if (best.kinds.has(k)) matched++;
            else { missing++; if (sampleMiss.length < 30) sampleMiss.push({ chest: `(${Math.round(g.x)},${Math.round(g.y)})`, kind: k, side: 'game-only' }); }
        }
        for (const k of best.kinds) if (!g.kinds.has(k)) { extra++; if (sampleExtra.length < 30) sampleExtra.push({ chest: `(${Math.round(best.x)},${Math.round(best.y)})`, kind: k }); }
    }
    // telescope chests that never paired (predicted a chest+content where the
    // dump opened none) — these are extras (telescope over-predicted content)
    let chestsTeleOnly = 0;
    for (const [tk, t] of T) {
        if (teleUsed.has(tk)) continue;
        chestsTeleOnly++;
        for (const k of t.kinds) { extra++; if (sampleExtra.length < 30) sampleExtra.push({ chest: `(${Math.round(t.x)},${Math.round(t.y)})`, kind: k, side: 'no-game-chest' }); }
    }
    const chestsGameOnly = G.size - chestsPaired;
    return { matched, missing, extra, chestsPaired, chestsGameOnly, chestsTeleOnly, sampleMiss, sampleExtra };
}

// Score spell-card PLACEMENT (not identity). All cards share action.xml and
// telescope predicts a spell's position but, for most mechanisms, not which spell
// (its `detail` is the literal 'spell'), so an exact (kind,x,y) diff is wrong on
// two counts: identity is unknowable and dispensed cards land at a jittered coord.
// Instead match each game card to the nearest telescope spell prediction within
// `tol` px (greedy, one-to-one), like a position-tolerant set diff. matched =
// telescope predicted a spell at that placement; missing = game placed one
// telescope didn't; extra = telescope predicted one the game didn't place.
function scoreSpells(gameSpells, teleSpells, tol = 24) {
    const used = new Set();
    let matched = 0, missing = 0;
    const sampleMiss = [], sampleExtra = [];
    for (const g of gameSpells) {
        let bi = -1, bd = tol + 1;
        for (let i = 0; i < teleSpells.length; i++) {
            if (used.has(i)) continue;
            const t = teleSpells[i];
            const d = Math.max(Math.abs(g.x - t.x), Math.abs(g.y - t.y));
            if (d < bd) { bd = d; bi = i; }
        }
        if (bi >= 0) { used.add(bi); matched++; }
        else { missing++; if (sampleMiss.length < 30) sampleMiss.push({ x: Math.round(g.x), y: Math.round(g.y), detail: g.detail, origin: g.raw?.lua_stack?.find?.((f) => !f.startsWith('[C]'))?.split('"]')[0]?.split('/').pop() || null }); }
    }
    let extra = 0;
    for (let i = 0; i < teleSpells.length; i++) {
        if (used.has(i)) continue;
        extra++;
        const t = teleSpells[i];
        if (sampleExtra.length < 30) sampleExtra.push({ x: Math.round(t.x), y: Math.round(t.y), detail: t.detail, origin: t.raw?.origin || null });
    }
    return { matched, missing, extra, sampleMiss, sampleExtra };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    // In --json mode stdout must carry ONLY the JSON object (compare.mjs parses
    // it), so push the human progress/report to stderr instead.
    if (opts.json) { const w = (...a) => process.stderr.write(a.join(' ') + '\n'); console.log = w; }
    const setManifest = JSON.parse(readFileSync(join(opts.set, 'set.json'), 'utf8'));
    const { seed, ng = 0, regions } = setManifest;
    const gameMode = setManifest.gameMode || 'normal';
    const isNGP = ng > 0;

    console.log(`fixture set: ${opts.set}  (seed=${seed} ng=${ng} mode=${gameMode}, ${regions.length} region(s))`);
    const ctx = await setupTelescope({ seed, ng, gameMode, biomeMap: opts.biomeMap, showEnemies: opts.showEnemies });

    const overall = {};
    const sampleMissing = [], sampleExtra = [];
    // Full (uncapped) instance lists for --json — compare.mjs diffs these by
    // (kind,x,y) to list which exact placements a ref fixed vs regressed.
    const allMissing = [], allExtra = [];
    const jrow = (region, r) => ({ region, kind: r.kind, x: Math.round(r.x), y: Math.round(r.y), detail: r.detail || null, origin: r.raw?.origin || null, file: r.raw?.file || null });
    const perRegion = [];

    for (const region of regions) {
        const regionDir = join(opts.set, region.dir || region.name);
        if (!existsSync(join(regionDir, 'set.json')) && !existsSync(join(regionDir, 'tile_done.ndjson'))) {
            console.log(`  [skip] ${region.name}: no tile_done.ndjson (not captured yet)`);
            continue;
        }
        const mask = buildMask(regionDir);

        // Game side: every category file present. Keep only modeled worldgen kinds, in-mask.
        const gameRaw = [
            ...readNdjson(join(regionDir, 'pixel_scenes.ndjson')),
            ...readNdjson(join(regionDir, 'items.ndjson')),
            ...readNdjson(join(regionDir, 'mobs.ndjson')),
        ];
        // A chest's reward is in-scope when the CHEST anchor is covered (the
        // reward itself spawns at a scratch coord that can be in another chunk).
        const anchorInMask = (px, py) => px != null && mask.has(`${Math.floor(px / CHUNK)},${Math.floor(py / CHUNK)}`);

        const gameCanon = gameRaw.map((r) => canonGame(r, isNGP));
        // Force-open reward rows carry chest_eid — scored separately as chest
        // content, not in the exact-position diff (they upwarp/teleport).
        // (spell cards carry chest_eid too but are scored by placement, not as
        // chest loot — exclude them here so lootKind doesn't mis-bucket e.g. BOMB.)
        const gameChestContent = gameCanon.filter((r) => r.raw.chest_eid != null && r.kind !== 'spell' && anchorInMask(r.raw.chest_x, r.raw.chest_y));
        // Spell cards (kind 'spell') are scored by placement, not the exact diff —
        // see scoreSpells. Include both directly-placed and container-dispensed
        // cards (telescope emits dispense spells at slot positions, not as
        // parent-anchored content, so they belong here, not in chest_content).
        const gameSpells = gameCanon.filter((r) => r.kind === 'spell' && inMask(mask, r));
        const game = gameCanon.filter((r) => r.raw.chest_eid == null && r.covered && TELESCOPE_KINDS.has(r.kind) && inMask(mask, r));

        // Telescope side: this PW, clipped to mask, same kind filter. Container
        // contents (chest loot, shop stock, boss drops) leave the exact diff and
        // (for chests) go to the by-parent-chest content score below.
        const teleCanonAll = generateForPW(ctx, region.pw, region.pwv).map((r) => canonTelescope(r, isNGP));
        const teleAll = teleCanonAll.filter((r) => TELESCOPE_KINDS.has(r.kind) && inMask(mask, r));
        const tele = teleAll.filter((r) => !isContainerContent(r));
        const contentExcluded = teleAll.length - tele.length;
        const teleChestContent = teleCanonAll.filter((r) => r.raw.parentX != null && r.kind !== 'spell' && anchorInMask(r.raw.parentX, r.raw.parentY));
        // Telescope spell predictions (kind 'spell'), in-mask — scored by placement.
        const teleSpells = teleCanonAll.filter((r) => r.kind === 'spell' && inMask(mask, r));

        const d = diff(game, tele);
        const acc = {};
        for (const r of d.matched) tally(acc, r.kind, 'matched');
        for (const r of d.missing) { tally(acc, r.kind, 'missing'); if (opts.json) allMissing.push(jrow(region.name, r)); if (sampleMissing.length < opts.dump && (!opts.kind || r.kind === opts.kind)) sampleMissing.push({ region: region.name, ...r }); }
        for (const r of d.extra) { tally(acc, r.kind, 'extra'); if (opts.json) allExtra.push(jrow(region.name, r)); if (sampleExtra.length < opts.dump && (!opts.kind || r.kind === opts.kind)) sampleExtra.push({ region: region.name, ...r }); }

        // Chest content (loot KIND, by parent chest). Only contributes when the
        // dump was captured with -force-open-chests (else gameChestContent ~= 0).
        const cc = scoreChestContents(gameChestContent, teleChestContent);
        tally(acc, 'chest_content', 'matched', cc.matched);
        tally(acc, 'chest_content', 'missing', cc.missing);
        tally(acc, 'chest_content', 'extra', cc.extra);
        if (opts.dump && (!opts.kind || opts.kind === 'chest_content')) {
            for (const s of cc.sampleMiss) if (sampleMissing.length < opts.dump) sampleMissing.push({ region: region.name, kind: 'chest_content', x: s.chest, y: '', detail: `${s.kind} [${s.side}]`, raw: {} });
            for (const s of cc.sampleExtra) if (sampleExtra.length < opts.dump) sampleExtra.push({ region: region.name, kind: 'chest_content', x: s.chest, y: '', detail: `${s.kind}${s.side ? ' [' + s.side + ']' : ''}`, raw: { origin: 'chest' } });
        }

        // Spell-card PLACEMENT (position-tolerant; identity unknowable). Only
        // meaningful on a dump that captured cards (else gameSpells ~= 0).
        const sc = scoreSpells(gameSpells, teleSpells);
        tally(acc, 'spell', 'matched', sc.matched);
        tally(acc, 'spell', 'missing', sc.missing);
        tally(acc, 'spell', 'extra', sc.extra);
        if (opts.dump && (!opts.kind || opts.kind === 'spell')) {
            for (const s of sc.sampleMiss) if (sampleMissing.length < opts.dump) sampleMissing.push({ region: region.name, kind: 'spell', x: s.x, y: s.y, detail: `${s.detail || ''} [${s.origin || '?'}]`, raw: {} });
            for (const s of sc.sampleExtra) if (sampleExtra.length < opts.dump) sampleExtra.push({ region: region.name, kind: 'spell', x: s.x, y: s.y, detail: s.detail || '', raw: { origin: s.origin } });
        }

        for (const k of Object.keys(acc)) { tally(overall, k, 'matched', acc[k].matched); tally(overall, k, 'missing', acc[k].missing); tally(overall, k, 'extra', acc[k].extra); }

        perRegion.push({ name: region.name, pw: region.pw, pwv: region.pwv, chunks: mask.size, acc, game: game.length, tele: tele.length, contentExcluded, cc });
    }

    if (opts.json) {
        process.stdout.write(JSON.stringify({
            set: opts.set, seed, ng, gameMode,
            kinds: overall,            // { kind: {matched,missing,extra} }
            missing: allMissing,       // game has, telescope lacks (per placement)
            extra: allExtra,           // telescope invented (per placement)
        }) + '\n');
        return;
    }

    // ── report ──
    const fmt = (acc) => {
        const rows = Object.entries(acc).sort((a, b) => (b[1].matched + b[1].missing + b[1].extra) - (a[1].matched + a[1].missing + a[1].extra));
        let M = 0, Mi = 0, E = 0;
        const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : 'n/a').padStart(5);
        const line = (label, m, mi, e) => console.log(
            `    ${label.padEnd(13)} match ${String(m).padStart(5)}  miss ${String(mi).padStart(5)}  extra ${String(e).padStart(5)}   R ${pct(m, m + mi)}%  P ${pct(m, m + e)}%`);
        for (const [kind, s] of rows) {
            M += s.matched; Mi += s.missing; E += s.extra;
            line(kind, s.matched, s.missing, s.extra);
        }
        line('TOTAL', M, Mi, E);
    };

    console.log('\n=== per region ===');
    for (const reg of perRegion) {
        console.log(`\n  region ${reg.name} (pw=${reg.pw}, pwv=${reg.pwv}) — ${reg.chunks} covered chunks, ${reg.game} game / ${reg.tele} telescope in-mask (+${reg.contentExcluded} container-content excluded)`);
        if (reg.cc && (reg.cc.chestsPaired || reg.cc.chestsGameOnly || reg.cc.chestsTeleOnly)) {
            console.log(`    chest content: ${reg.cc.chestsPaired} chests paired (game+telescope), ${reg.cc.chestsGameOnly} game-only (telescope predicted no chest), ${reg.cc.chestsTeleOnly} telescope-only (no force-opened chest in dump)`);
        }
        fmt(reg.acc);
    }
    console.log('\n=== overall (all regions) ===');
    fmt(overall);

    if (sampleMissing.length) {
        console.log(`\n-- sample MISSING (game has, telescope lacks)${opts.kind ? ' kind=' + opts.kind : ''} --`);
        for (const r of sampleMissing) console.log(`  [${r.region}] ${r.kind.padEnd(10)} (${r.x}, ${r.y})  ${r.detail || ''}   ${r.raw.file || ''}`);
    }
    if (sampleExtra.length) {
        console.log(`\n-- sample EXTRA (telescope invented)${opts.kind ? ' kind=' + opts.kind : ''} --`);
        for (const r of sampleExtra) console.log(`  [${r.region}] ${r.kind.padEnd(10)} (${r.x}, ${r.y})  ${r.detail || ''}   origin=${r.raw.origin || ''}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
