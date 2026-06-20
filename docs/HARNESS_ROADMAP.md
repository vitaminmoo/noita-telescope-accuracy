# Entity-harness → shippable test suite: roadmap

**Goal:** a regression-testing suite, merged into the repo, that verifies
telescope's procedural generation against game-dumped ground truth. Must be:
- sane for a human to run (one command),
- fast to get results (seconds — consumers download the dump, they don't capture),
- understandable output (per-kind pass/fail + clear regressions),
- consumers verify their changes didn't regress; they do NOT make dumps.
- dump lives in-repo (compressed) or hosted + downloaded on demand.

**North star:** every row telescope emits is verified by dump data. Exclusions
are debt to be closed by fixing the harness/dump to capture more, not design.
See `HARNESS_FINDINGS.md` for the detail behind each item below.

Status legend: [ ] todo · [~] in progress · [x] done · [?] needs owner decision

---

## M0 — Decisions to lock (owner)
- [x] **Producer vs consumer split (DECIDED 2026-06-04):** the PR ships the
      CONSUMER path only — `verify_entities.mjs` + `lib/` + docs + dumps (committed
      known-good set OR a fetch-from-bucket/URL stage). `capture_entities.mjs` and
      all the force-open dump-production tooling (noita-map: `noita_hook.dll`
      FORCEOPEN/FORCEOPEN_SWEEP, `cmd/sweep -force-open-chests`) are PRODUCER-side,
      NOT upstreamed. Consumers verify against a dump; they never capture. So
      `capture_entities.mjs`'s current `go run ./cmd/sweep` subprocess form is fine
      (dev-only) and does NOT need to be reworked to talk to noitad directly.
- [?] **Dump distribution:** in-repo compressed (.ndjson.gz, ~MB) vs external host
      + download script w/ checksum. Current broad set = 3 regions × ~16k items /
      ~8.6k mobs / ~4.6k scenes (tens of MB raw). Leaning: gzip + host + fetch
      script, small enough subset could be in-repo. (Mechanism still open; the
      "consumers fetch, don't capture" principle is now locked, see above.)
- [?] **Canonical fixture scope:** seed(s) + regions. Proposal: seed 1, regions
      main + pw+1 + pw-1 + heaven + hell + a couple far-PW samples; NG0 first,
      NG+ later.
- [?] **Pass/fail mechanism:** committed per-kind R/P thresholds (fail on
      regression) vs golden snapshot of matched/missing/extra counts. Leaning:
      committed baseline JSON + thresholds, with a `--update-baseline` flag.
- [?] **Code location:** un-gitignore the core harness (currently all of
      `scripts/` is gitignored as a "previous attempt") and move to `tests/` or
      keep in `scripts/`. Prune scratch `dump_*.mjs`.
- [?] **Version pinning:** record Noita build + `sweep` commit + date in the
      fixture manifest; verify prints a clear message if telescope's assumptions
      drift from the dump's version.
- [?] **PR shape:** one harness PR (framework + fixtures + verified kinds, with
      gaps tracked in FINDINGS) vs gate on closing all exclusions first.
      Recommendation: ship a v1 with honest documented gaps, iterate.

---

## M1 — Close the exclusions (verify everything telescope EMITS)
Audit every category/origin telescope emits; each must have a dump counterpart.
- [ ] **shiny_orb / greed_orb:** un-exclude; verify telescope position vs game
      `physics_gold_orb.xml`. (Quick — game already dumps it; we just stopped
      counting it. Either confirms a match or surfaces a real bug.)
- [x] **Chest content (DONE 2026-06-04):** built `sweep -force-open-chests` — the
      hook opens each chest at creation (`forceopen_chest_eid`) and tags every
      reward spawn with its parent `chest_eid/chest_x/chest_y`. `verify_entities`
      now scores chest content by grouping each side's loot under its parent chest
      and matching loot KIND within an anchor radius (un-excluded). Result on a
      seed-1 force-open spot set: 11/11 paired chests match loot kind (R 100%);
      precision dings are telescope-predicted chests the (nondeterministic) sweep
      didn't open. Telescope's chest loot-table RNG is confirmed accurate. See
      FINDINGS C1 (RESOLVED). Remaining nit: per-type content POSITION offsets
      (bomb/heart/misc at chest-pos y-10 vs scratch).
- [~] **Utility box (placement DONE 2026-06-04; contents PENDING):** telescope
      generates all 15 boxes at the exact game coordinates, so the box is now
      modeled as a CONTAINER (`emitPoi` `utility_box` case → `item · utility_box`;
      origin `utility_box` in `CONTAINER_ORIGINS`) and scored on placement: 15/15
      matched, item recall 75 → 90%. Its dispensed contents are excluded as
      unobservable — the sweep doesn't shoot boxes open. **Next (producer):**
      force-open utility boxes the same way as chests (`sweep -force-open-boxes`,
      hook tags each dispensed item with parent box eid) so we can score box
      content like `chest_content`. CAVEAT: most box contents are SPELLS, which
      the dump doesn't capture yet (next bullet) — so the non-spell payoff is
      small until spell capture also lands. Needs a live re-capture.
- [ ] **Spells (shop / utility_box / boss):** the game never dumps spell-card
      pickups today → telescope's spell rows are unverifiable. Enhance the dump
      to capture spell entities (or resolve shop/utility contents another way) so
      `detail==='spell'` rows can be verified rather than excluded. (Unlocks the
      bulk of force-opened utility-box content above.)
- [ ] **Enemies:** enable in scoring by default; bring enemy jitter in line with
      the game (independent sequential `Random` draws, FINDINGS C2) OR define and
      document an explicit wobble tolerance so enemy is verified, not skipped.
- [ ] **Container-content audit:** enumerate every `isContainerContent` /
      `CONTAINER_ORIGINS` case; for each, either make the dump capture it or log
      an explicit, counted "known-unverifiable" reason (no silent excludes).

## M2 — Telescope model coverage (unmodeled → modeled → verified)
- [ ] Decide per unmodeled item type: model it or formally scope it out in an
      explicit, logged registry (no silent drop). Candidates to MODEL:
      `spell_refresh`, `gourd`, `heart_fullhp_temple`. Candidates to SCOPE-OUT
      with logged counts: `book_*`, `essence_*`, `orb_*`, `musicstone`,
      `egg_worm`, `experimental_wand`. (FINDINGS E) (`utility_box` entity is now
      MODELED as a container — see M1.)
- [ ] Reconcile `mimic` classification (telescope `mimic`/`mimic_potion` item vs
      game `potion_mimic`→potion / `chest_mimic`→enemy). (FINDINGS E1)

## M3 — Fix known telescope position bugs (so they verify)
- [ ] Cloud/sky potions: `spawn_potion`/`spawn_props3` `x+5` path + beer/milk
      material (FINDINGS D1).
- [~] Static special wands: good wands (`generateGoodWand1/2/3`) are
      INTENTIONALLY spread ±100px (vs game ±20px) for PoI clickability — not a bug;
      harness snaps them back to game coords (`GOOD_WAND_SNAP`, biome
      `solid_wall_tower_10`), so they now verify 3/3. Also resolved: the wandcave
      "wand ghost"/Taikasauva is an enemy holding a wand that telescope renders as
      a wand — harness classifies game `wand_ghost`→`wand` (30 placements matched,
      wand precision 86→96%). Remaining: kantele, flute offsets (FINDINGS D2).
- [ ] (Enemies — covered in M1.)

## M4 — Fixtures & provenance (consumer distribution)
- Canonical-dump model (owner, 2026-06-04): ONE fixed set of sweep options;
  coverage grows by adding MORE BOXES with the SAME options (not by varying
  settings) — partial-world coverage without dumping the whole world. Force-open
  chests is ON by default (`capture_entities.mjs` defaults `forceOpen=true`,
  `--no-force-open` to opt out). The dump is frozen/committed, so run-to-run
  sweep nondeterminism stops mattering — what matters instead is the canonical
  capture's COMPLETENESS (a missed entity becomes a false telescope "extra"
  against the frozen dump). So invest in a generous settle and/or score at
  spawn-intent rather than chasing reproducibility.
- [ ] Capture canonical set per M0 scope (adds heaven/hell — also tests the
      24570-vs-24576 vertical-PW constant, FINDINGS C3 — and far-PW samples).
- [ ] Compress fixtures; write a `fetch-fixtures` script (download + checksum
      verify) OR commit the compressed set.
- [ ] Fixture manifest: seed, regions, Noita version, sweep commit, capture date.

## M5 — Harness ergonomics & packaging
- [ ] One entry point: `npm run test:worldgen` (or similar) that fetches fixtures
      if missing, runs the diff, prints a summary, exits nonzero on regression.
- [ ] Baseline + threshold gating (per M0); `--update-baseline`.
- [ ] Clear output: per-region/per-kind R/P table, overall, top sample
      missing/extra, and a one-line PASS/FAIL with what regressed.
- [ ] Node/ESLint compat: ensure the headless path runs clean under the repo's
      tooling; add any deps to `package.json` (PNG decode etc.).
- [ ] Un-gitignore core harness; prune scratch scripts; finalize layout.
- [ ] Usage README (run, interpret, update baseline) + keep ENTITY_HARNESS.md
      (design) and HARNESS_FINDINGS.md (gaps).
- [ ] (Optional) CI: GitHub Action runs the suite on PRs against the hosted dump.

## M6 — Land it
- [ ] Telescope generation fixes as their own small PR(s) off `main` (cherry-pick
      the 2 commits on `potion-y-offset-test`: potion clobber, item offsets).
- [ ] Harness as its own PR (framework + fixtures + verified kinds + docs).

---

### Current state snapshot (for continuity after compaction)
- Telescope fixes committed on branch `potion-y-offset-test`: potion Y clobber,
  item-offset (potion_spawnlist). Not yet cherry-picked to a clean main branch.
- Harness lives in gitignored `scripts/` (`verify_entities.mjs`, `lib/`,
  `capture_entities.mjs`); fixtures in `data/dumps/entities/1_ng0_broad`.
- Accuracy now: chest R99/P93 · wand R96/P91 · potion R95/P92 · heart R91/P96 ·
  item R48/P73 · enemy R74/P63 (only with --show-enemies).
- Live tp worker (seed 1) used for the chest investigation — torn down.
