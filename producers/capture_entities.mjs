// Capture a parallel-world fixture *set* for the entity-accuracy harness by
// driving the `sweep` tool (sibling repo ~/reverse/noita/noita-map) once per
// region. Each region becomes its own sweep out-dir (manifest + tile_done +
// per-category ndjson); a top-level set.json records what was captured so the
// comparison side knows exactly which PWs/regions it has coverage for.
//
// Sweep is SLOW (it camera-pans the whole bbox to force worldgen), so the
// default is --quick: one small box near spawn, just to exercise the workflow
// end-to-end. Scale up by passing --regions and dropping --quick once the
// pipeline is trusted.
//
// Prereqs: the noitad coordinator must already be running in another terminal:
//     cd ~/reverse/noita/noita-map && go run ./cmd/noitad
// and a Noita worker reachable through it (see that repo's sweep README).
//
// Usage:
//   node scripts/capture_entities.mjs --seed=1 --quick
//   node scripts/capture_entities.mjs --seed=1 --regions=main,pw-1,pw+1,heaven,hell
//   node scripts/capture_entities.mjs --seed=1 --regions=main,pw+7,pw-12 --tile=2048
//
// Flags (env fallback in parens):
//   --seed=N            world seed (required)
//   --ng=N              NG+ count (default 0)
//   --regions=LIST      comma list: main | pw+N | pw-N | heaven | hell  (default main)
//   --quick             small box near spawn instead of the full region (good for testing)
//   --tile=N            sweep tile size 512..8192 (default 1024; smaller = thorough+slower)
//   --types=LIST        pixel_scene,item,mob subset (default all three)
//   --out=DIR           fixture-set root (default data/dumps/entities/<seed>_ng<ng>)
//   --noita-map=DIR     sibling repo with cmd/sweep   (NOITA_MAP_DIR, default ~/reverse/noita/noita-map)
//   --host=HOST:PORT    noitad address (HOST, default 127.0.0.1:8080)
//   --headless          pass -headless to sweep (faster; subsystem NOPs)
//   --dry-run           print the sweep commands without running them

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PW_WIDTH_NG0, PW_WIDTH_NGP, PW_HEIGHT } from './lib/entity_identity.mjs';

// Full main-world bbox — the sweep README's default (≈ the playable main world,
// inset from the 70×48 biome map's void edges).
const FULL_MAIN = { x: -15732, y: -6720, w: 32840, h: 27120 };
// Small box around the starting mines — enough chunks to see scenes, chests,
// wands, hearts without a multi-minute sweep.
const QUICK_MAIN = { x: -1536, y: -512, w: 4096, h: 5120 };

function parseArgs(argv) {
    const o = {
        seed: null, ng: 0, regions: 'main', quick: false, tile: 1024,
        types: 'pixel_scene,item,mob', out: null,
        noitaMap: process.env.NOITA_MAP_DIR || join(homedir(), 'reverse/noita/noita-map'),
        host: process.env.HOST || '127.0.0.1:8080',
        // Canonical-dump defaults. forceOpen: RNG-safe, makes chest loot
        // observable (--no-force-open opts out). filterNoise: drop sim-noise
        // categories the harness already ignores (--no-filter-noise opts out).
        // quietFrames/maxSettleMs: the default 20/600 cut tiles off early and
        // captured only ~half the entities (64% run-to-run stable); 30/4000
        // saturates to ~93%+ stable. Completeness > speed for a frozen corpus.
        headless: false, dryRun: false, forceOpen: true, filterNoise: true, fogReveal: false,
        // Tuned for frozen sim (2026-06-04): quiet-detection wins at p50~740ms
        // /p90~1430ms, so 20 quiet-frames + a 3000ms backstop cap gives 100%
        // run-to-run stability at ~1.2s/tile (full main world ≈18 min). The
        // old 30/4000 was 3x more settle than needed; 1500 was too tight (heavy
        // tiles, load up to 1.77s, got cut off → 98.9%). The cap is just a
        // backstop — keep it generous, it costs nothing on fast-settling tiles.
        quietFrames: 20, maxSettleMs: 3000,
        // Freeze simulation during capture: worldgen spawns are unaffected, but
        // AI wandering, physics/verlet settling, explosions (bombs from force-
        // opened chests, shattering potions), fire effects and the pixel sim all
        // add nondeterministic off-screen churn + CPU cost. Frozen → 100% stable
        // modeled-kind capture AND faster settle. (Lukki spiders still move via
        // a non-alias path but it provably doesn't perturb captured entities.)
        // --disable-subsystems=LIST overrides; --no-freeze disables.
        disableSubs: 'lighting,guns,velocity,ai,character,worms,pathfinding,box2d,joints,particles,cellsim,material,simplephysics,rigidbody,explosions,explosions_queue,vphysics,verlet,game_effects,creatures',
    };
    for (const a of argv) {
        if (a.startsWith('--seed=')) o.seed = +a.slice(7);
        else if (a.startsWith('--ng=')) o.ng = +a.slice(5);
        else if (a.startsWith('--regions=')) o.regions = a.slice(10);
        else if (a === '--quick') o.quick = true;
        else if (a.startsWith('--tile=')) o.tile = +a.slice(7);
        else if (a.startsWith('--types=')) o.types = a.slice(8);
        else if (a.startsWith('--out=')) o.out = a.slice(6);
        else if (a.startsWith('--noita-map=')) o.noitaMap = a.slice(12);
        else if (a.startsWith('--host=')) o.host = a.slice(7);
        else if (a === '--headless') o.headless = true;
        else if (a === '--force-open') o.forceOpen = true;
        else if (a === '--no-force-open') o.forceOpen = false;
        else if (a === '--no-filter-noise') o.filterNoise = false;
        else if (a === '--fog-reveal') o.fogReveal = true;
        else if (a === '--no-freeze') o.disableSubs = '';
        else if (a.startsWith('--disable-subsystems=')) o.disableSubs = a.slice(21);
        else if (a.startsWith('--quiet-frames=')) o.quietFrames = +a.slice(15);
        else if (a.startsWith('--max-settle=')) o.maxSettleMs = +a.slice(13);
        else if (a === '--dry-run') o.dryRun = true;
        else { console.error(`unknown arg: ${a}`); process.exit(1); }
    }
    if (o.seed == null || Number.isNaN(o.seed)) {
        console.error('--seed=N is required');
        process.exit(1);
    }
    if (!o.out) o.out = `data/dumps/entities/${o.seed}_ng${o.ng}`;
    return o;
}

// Region name → parallel-world indices. main / pw±N (horizontal) / heaven|hell
// (vertical). Heaven is up (pwv -1), hell is down (pwv +1).
function parseRegion(name) {
    if (name === 'main') return { name, pw: 0, pwv: 0 };
    if (name === 'heaven') return { name, pw: 0, pwv: -1 };
    if (name === 'hell') return { name, pw: 0, pwv: 1 };
    const m = name.match(/^pw([+-]?\d+)$/);
    if (m) return { name, pw: +m[1], pwv: 0 };
    console.error(`unrecognized region "${name}" (expected main|heaven|hell|pw<N>)`);
    process.exit(1);
}

// Shift the base main-world box into a region's parallel world.
function regionBBox(base, region, isNGP) {
    const wWidth = isNGP ? PW_WIDTH_NGP : PW_WIDTH_NG0;
    return {
        x: base.x + region.pw * wWidth,
        y: base.y + region.pwv * PW_HEIGHT,
        w: base.w, h: base.h,
    };
}

function runSweep(opts, region, bbox, outDir) {
    const args = [
        'run', './cmd/sweep',
        '-seed', String(opts.seed), '-ng', String(opts.ng),
        '-x', String(bbox.x), '-y', String(bbox.y), '-w', String(bbox.w), '-h', String(bbox.h),
        '-tile', String(opts.tile), '-types', opts.types,
        '-quiet-frames', String(opts.quietFrames), '-max-settle-ms', String(opts.maxSettleMs),
        '-host', opts.host, '-out-dir', resolve(outDir),
    ];
    if (opts.disableSubs) args.push('-disable-subsystems', opts.disableSubs);
    if (opts.headless) args.push('-headless');
    if (opts.forceOpen) args.push('-force-open-chests');
    if (opts.filterNoise) args.push('-filter-noise');
    if (opts.fogReveal) args.push('-fog-reveal');

    const shown = `go ${args.join(' ')}`;
    console.log(`\n=== region ${region.name} (pw=${region.pw}, pwv=${region.pwv}) → ${outDir} ===`);
    console.log(`    bbox (${bbox.x},${bbox.y}) ${bbox.w}x${bbox.h}`);
    console.log(`    $ cd ${opts.noitaMap} && ${shown}`);
    if (opts.dryRun) return Promise.resolve(0);

    return new Promise((res, rej) => {
        const p = spawn('go', args, { cwd: opts.noitaMap, stdio: 'inherit' });
        p.on('error', rej);
        p.on('close', (code) => code === 0 ? res(0)
            : rej(new Error(`sweep for region ${region.name} exited ${code}`)));
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const isNGP = opts.ng > 0;
    const base = opts.quick ? QUICK_MAIN : FULL_MAIN;
    const regions = opts.regions.split(',').map((s) => s.trim()).filter(Boolean).map(parseRegion);

    mkdirSync(opts.out, { recursive: true });
    const setManifest = {
        seed: opts.seed, ng: opts.ng, quick: opts.quick, tile: opts.tile,
        types: opts.types.split(','), base, regions: [],
    };

    for (const region of regions) {
        const bbox = regionBBox(base, region, isNGP);
        const outDir = join(opts.out, region.name);
        if (!opts.dryRun) mkdirSync(outDir, { recursive: true });
        await runSweep(opts, region, bbox, outDir);
        setManifest.regions.push({ name: region.name, pw: region.pw, pwv: region.pwv, bbox, dir: region.name });
    }

    if (!opts.dryRun) {
        const setPath = join(opts.out, 'set.json');
        writeFileSync(setPath, JSON.stringify(setManifest, null, 2) + '\n');
        console.log(`\nwrote ${setPath} (${regions.length} region(s))`);
    }
    console.log('\ndone.');
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
