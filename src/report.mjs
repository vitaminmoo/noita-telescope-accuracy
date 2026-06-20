#!/usr/bin/env node
// Single entrypoint for the telescope accuracy report.
//
//   node scripts/report.mjs [SET_DIR]
//   npm run report -- [SET_DIR]
//
// Does two things against a captured ground-truth dump:
//   1. prints the scorecard (verify_entities) — enemies INCLUDED, because the
//      worldgen RNG stream is shared, so telescope's enemy generation must be on
//      for every other category's positions to line up;
//   2. regenerates the per-item miss/extra triage at scripts/mismatches.md.
//
// SET_DIR is a dump dir (containing set.json). Defaults to $TELESCOPE_DUMP, then
// the in-repo (gitignored) corpus at data/dumps/full_i.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
// fixtures/ (standalone) or data/dumps/ (in-place inside the telescope repo).
const fixturesRoot = existsSync(join(repoRoot, 'fixtures')) ? join(repoRoot, 'fixtures') : join(repoRoot, 'data/dumps');
const set = process.argv[2] || process.env.TELESCOPE_DUMP || join(fixturesRoot, 'full_i');

if (!existsSync(join(set, 'set.json'))) {
    console.error(`no set.json in '${set}' — pass a dump dir: node scripts/report.mjs <dir>`);
    process.exit(1);
}

const run = (script, args) => {
    const r = spawnSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
};

console.log(`== scorecard (${set}) ==`);
run('verify_entities.mjs', [`--set=${set}`, '--show-enemies']);
console.log('\n== mismatch triage ==');
const out = join(here, 'mismatches.md');   // beside the scripts (scripts/ or src/)
run('mismatch_report.mjs', [`--set=${set}`, `--out=${out}`]);

// 3. Pixel-scene PLACEMENT score (complementary to the entity diff): does telescope
//    place the same gameplay scenes as the game? Custom-art / non-deterministic /
//    aliased scenes are handled in lib/exceptions.mjs.
console.log('\n== pixel-scene placement ==');
run('compare_scenes.mjs', [`--set=${set}`]);
