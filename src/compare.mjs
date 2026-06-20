#!/usr/bin/env node
// Score two telescope git refs against the same game ground-truth and print the
// accuracy delta — the "this PR fixes N cases with zero regressions" report.
//
//   node scripts/compare.mjs <refA> <refB> [--set=DIR] [--examples=N]
//   node scripts/compare.mjs headless-import-support potion-y-offset-test
//
// refA is the BASELINE, refB is the CHANGE. For each ref we check out a detached
// git worktree *inside this repo* (so its js/ resolves the shared node_modules),
// run verify_entities.mjs --json against it with TELESCOPE_DIR pointed at the
// worktree, then diff the two scorecards. The harness code itself (this script,
// entity_identity, the fixtures) is constant across both runs — only the
// telescope js/ under test changes.
//
// Both refs must be headless-importable (upstream PR #5 / branch
// headless-import-support). A ref without it fails at module load with an
// https:// ESM scheme error; we detect that and say so.
//
// Exit code: non-zero if refB introduces any NON-enemy regression (a placement
// it gets wrong that refA got right). Enemy positions churn with the shared RNG
// stream and are reported but don't fail the run.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');                       // harness repo root
// The telescope git we make worktrees from: this repo in-place, or the submodule
// at telescope/ in the standalone layout. Worktrees still live under repoRoot so
// their js/ resolves the harness's node_modules.
const telescopeRepo = existsSync(join(repoRoot, 'js')) ? repoRoot : join(repoRoot, 'telescope');
// Fixtures: fixtures/ (standalone) or data/dumps/ (in-place).
const fixturesRoot = existsSync(join(repoRoot, 'fixtures')) ? join(repoRoot, 'fixtures') : join(repoRoot, 'data/dumps');

function parseArgs(argv) {
    const o = { refA: null, refB: null, set: join(fixturesRoot, 'full_i'), examples: 5, showEnemies: true, enemyInstances: false };
    const pos = [];
    for (const a of argv) {
        if (a.startsWith('--set=')) o.set = a.slice(6);
        else if (a.startsWith('--examples=')) o.examples = +a.slice(11);
        else if (a === '--no-enemies') o.showEnemies = false;
        else if (a === '--include-enemy-instances') o.enemyInstances = true;
        else if (a.startsWith('--')) { console.error(`unknown arg: ${a}`); process.exit(2); }
        else pos.push(a);
    }
    [o.refA, o.refB] = pos;
    if (!o.refA || !o.refB) { console.error('usage: node scripts/compare.mjs <refA> <refB> [--set=DIR] [--examples=N]'); process.exit(2); }
    return o;
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

// Resolve a ref to a commit SHA, trying the name as given then origin/<name> —
// so a submodule clone whose branches are only remote-tracking still works.
function resolveRef(ref) {
    for (const cand of [ref, `origin/${ref}`]) {
        const r = sh('git', ['-C', telescopeRepo, 'rev-parse', '--verify', '--quiet', `${cand}^{commit}`]);
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    throw new Error(`ref '${ref}' not found in ${telescopeRepo} (tried '${ref}' and 'origin/${ref}')`);
}

function shortSha(ref) {
    try { return resolveRef(ref).slice(0, 9); } catch { return '?'; }
}

// Score one ref: detached worktree inside the repo, run verify_entities --json
// with TELESCOPE_DIR set, return the parsed scorecard.
function scoreRef(ref, opts) {
    const sha = resolveRef(ref);
    const wt = join(repoRoot, '.compare-wt', ref.replace(/[^A-Za-z0-9._-]/g, '_'));
    rmSync(wt, { recursive: true, force: true });
    sh('git', ['-C', telescopeRepo, 'worktree', 'prune']);
    const add = sh('git', ['-C', telescopeRepo, 'worktree', 'add', '--detach', wt, sha]);
    if (add.status !== 0) { throw new Error(`git worktree add failed for '${ref}':\n${add.stderr}`); }
    try {
        const args = [join(here, 'verify_entities.mjs'), `--set=${opts.set}`, '--json'];
        if (opts.showEnemies) args.push('--show-enemies');
        // stderr is captured (not inherited) so we can inspect it for the
        // headless-import failure; on any failure we forward it for context.
        const r = sh(process.execPath, args, { cwd: repoRoot, env: { ...process.env, TELESCOPE_DIR: wt }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        if (r.status !== 0) {
            if (/ERR_UNSUPPORTED_ESM_URL_SCHEME|protocol 'https'/.test(r.stderr || '')) {
                throw new Error(`ref '${ref}' is not headless-importable — it needs the PR #5 headless changes (branch headless-import-support) merged in or rebased underneath.`);
            }
            if (r.stderr) process.stderr.write(r.stderr);
            throw new Error(`verify_entities failed for '${ref}' (exit ${r.status})`);
        }
        return JSON.parse(r.stdout);
    } finally {
        sh('git', ['-C', telescopeRepo, 'worktree', 'remove', '--force', wt]);
        rmSync(wt, { recursive: true, force: true });
    }
}

const KEY = (r) => `${r.kind}|${r.x}|${r.y}`;
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : 'n/a');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(join(opts.set, 'set.json'))) { console.error(`no set.json in '${opts.set}'`); process.exit(2); }
    mkdirSync(join(repoRoot, '.compare-wt'), { recursive: true });

    let A, B;
    try {
        console.error(`scoring A (baseline) '${opts.refA}' …`);
        A = scoreRef(opts.refA, opts);
        console.error(`scoring B (change)   '${opts.refB}' …`);
        B = scoreRef(opts.refB, opts);
    } catch (e) {
        console.error(`\ncompare failed: ${e.message}`);
        process.exit(2);
    }

    // ── per-kind delta table ──
    console.log(`\n=== telescope accuracy: ${opts.refA} → ${opts.refB} ===`);
    console.log(`  A baseline: ${opts.refA} @ ${shortSha(opts.refA)}`);
    console.log(`  B change:   ${opts.refB} @ ${shortSha(opts.refB)}`);
    console.log(`  fixture:    ${opts.set}\n`);
    console.log('  R = recall (% of game spawns predicted) · P = precision (% of predictions real)\n');

    const kinds = [...new Set([...Object.keys(A.kinds), ...Object.keys(B.kinds)])];
    const order = ['wand', 'potion', 'chest', 'chest_great', 'heart', 'item', 'shop_slot', 'chest_content', 'enemy'];
    kinds.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const z = { matched: 0, missing: 0, extra: 0 };
    const tot = (S) => Object.values(S.kinds).reduce((a, v) => ({ matched: a.matched + v.matched, missing: a.missing + v.missing, extra: a.extra + v.extra }), { ...z });

    console.log(`  ${pad('kind', 14)}${pad('match', 14)}${pad('miss', 13)}${pad('extra', 13)}${pad('recall', 15)}precision`);
    const row = (label, a, b) => {
        const arrow = (x, y) => x === y ? `${x}` : `${x}→${y}`;
        console.log('  ' + pad(label, 14)
            + pad(arrow(a.matched, b.matched), 14)
            + pad(arrow(a.missing, b.missing), 13)
            + pad(arrow(a.extra, b.extra), 13)
            + pad(`${pct(a.matched, a.matched + a.missing)}→${pct(b.matched, b.matched + b.missing)}`, 15)
            + `${pct(a.matched, a.matched + a.extra)}→${pct(b.matched, b.matched + b.extra)}`);
    };
    for (const k of kinds) row(k, A.kinds[k] || z, B.kinds[k] || z);
    row('TOTAL', tot(A), tot(B));

    // ── per-placement fixed / regressed ──
    const aMiss = new Set(A.missing.map(KEY)), bMiss = new Set(B.missing.map(KEY));
    const aExtra = new Set(A.extra.map(KEY)), bExtra = new Set(B.extra.map(KEY));
    const label = (r) => `${pad(r.kind, 9)} (${r.x},${r.y})${r.detail ? ' ' + r.detail : ''}`;
    const fixed = [], regressed = [];
    for (const r of A.missing) if (!bMiss.has(KEY(r))) fixed.push({ r, why: 'now predicted' });
    for (const r of A.extra) if (!bExtra.has(KEY(r))) fixed.push({ r, why: 'no longer invented' });
    for (const r of B.missing) if (!aMiss.has(KEY(r))) regressed.push({ r, why: 'now missed' });
    for (const r of B.extra) if (!aExtra.has(KEY(r))) regressed.push({ r, why: 'newly invented' });

    const isEnemy = (e) => e.r.kind === 'enemy';
    const show = (list) => opts.enemyInstances ? list : list.filter((e) => !isEnemy(e));
    const enemyCount = (list) => list.filter(isEnemy).length;

    const print = (title, list) => {
        const vis = show(list);
        const hiddenEnemy = enemyCount(list);
        console.log(`\n${title} (${list.length}${hiddenEnemy && !opts.enemyInstances ? `, ${hiddenEnemy} enemy hidden` : ''}):`);
        if (!vis.length) { console.log('  (none)'); return; }
        for (const e of vis.slice(0, opts.examples)) console.log(`  ${label(e.r)}  [${e.why}]`);
        if (vis.length > opts.examples) console.log(`  … and ${vis.length - opts.examples} more`);
    };
    print('FIXED — B right where A was wrong', fixed);
    print('REGRESSED — B wrong where A was right', regressed);

    const nonEnemyReg = regressed.filter((e) => !isEnemy(e)).length;
    const nonEnemyFix = fixed.filter((e) => !isEnemy(e)).length;
    console.log(`\nresult: ${nonEnemyFix} fixed / ${nonEnemyReg} regressed (non-enemy).`
        + (nonEnemyReg === 0 ? '  ✅ no known regressions' : '  ❌ regressions present'));
    process.exit(nonEnemyReg === 0 ? 0 : 1);
}

main();
