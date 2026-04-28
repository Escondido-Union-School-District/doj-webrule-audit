// Rescan with manual review preservation.
//
// On 2026-04-08 we discovered Apptegy accordions were hiding tables (and
// other content) from the auto-checks, so we re-ran the audit. The new run
// created fresh `audit_results` rows with `manual_override = NULL`, and the
// Review UI immediately stopped showing all of Mark's prior reviews until
// we hand-wrote a one-off migration script. This script makes that the
// official path: any future "we found something the scan missed" rescan
// should be done with `npm run rescan` instead of `npm run audit`.
//
// Behavior:
//   1. Note the current latest completed audit run (call it OLD_RUN).
//   2. Run the audit (creates NEW_RUN).
//   3. For every manual_override on OLD_RUN, copy it forward to NEW_RUN
//      EXCEPT when the new auto_result is 'fail' AND the old auto_result
//      was something other than 'fail' (i.e., the rescan found a violation
//      the previous scan missed — that's the whole point of rescanning,
//      so it should be left as a fresh fail and re-reviewed).
//   4. Backfill pages that are NOT in NEW_RUN (because the audit was
//      partial, e.g. --new, --site, --limit). For each (page_id, check)
//      absent from NEW_RUN, copy the most recent prior row forward.
//      Without this step the Review UI's dashboard scopes by run_id and
//      "loses sight" of every page outside the partial run — happened on
//      2026-04-28 with a 937-page partial audit.
//   5. Print a summary of what was preserved vs left for re-review.
//
// Backup safety:
//   We make a snapshot of audit.db BEFORE the audit runs, so a rollback
//   is one file copy if anything goes wrong.
//
// Run: npm run rescan [-- --site eusd] [-- --limit 50] [-- --new]

import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runBatch } from '../src/crawler/batch-runner.js';
import { closeBrowser } from '../src/crawler/page-fetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const DB_PATH = resolve(PROJECT_ROOT, 'data', 'audit.db');
const BACKUP_DIR = resolve(PROJECT_ROOT, 'data', 'backups');

function findLatestCompletedRun(db: Database.Database): string | null {
  const row = db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).get() as { id: string } | undefined;
  return row?.id ?? null;
}

function snapshotDb(): string {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = resolve(BACKUP_DIR, `audit-${stamp}-pre-rescan.db`);
  // Plain file copy is fine here — nothing else is writing to the DB at this
  // moment because we're about to start the audit run sequentially.
  copyFileSync(DB_PATH, backupPath);
  return backupPath;
}

function migrateOverrides(db: Database.Database, oldRun: string, newRun: string) {
  const candidates = db.prepare(`
    SELECT n.id AS new_id, o.manual_override, o.notes, o.audited_by, o.audit_date,
           o.auto_result AS old_auto, n.auto_result AS new_auto,
           n.page_id, n.check_number
    FROM audit_results o
    JOIN audit_results n
      ON n.page_id = o.page_id AND n.check_number = o.check_number AND n.run_id = ?
    WHERE o.run_id = ? AND o.manual_override IS NOT NULL
  `).all(newRun, oldRun) as Array<{
    new_id: number;
    manual_override: string;
    notes: string | null;
    audited_by: string | null;
    audit_date: string | null;
    old_auto: string;
    new_auto: string;
    page_id: number;
    check_number: number;
  }>;

  const update = db.prepare(`
    UPDATE audit_results
    SET manual_override = ?, status = ?, notes = ?, audited_by = ?, audit_date = ?
    WHERE id = ?
  `);

  let migrated = 0;
  const skipped: Array<{ page_id: number; check: number; old_auto: string; new_auto: string; old_override: string }> = [];

  const tx = db.transaction(() => {
    for (const r of candidates) {
      // The whole point of rescanning is to surface previously-missed violations.
      // If the new scan found a fail where the old scan said pass/n/a/needs-review,
      // do NOT carry the old override forward — leave it as a fresh fail so the
      // user re-reviews it.
      const newViolationFound = ['pass', 'n/a', 'needs-review'].includes(r.old_auto) && r.new_auto === 'fail';
      if (newViolationFound) {
        skipped.push({
          page_id: r.page_id,
          check: r.check_number,
          old_auto: r.old_auto,
          new_auto: r.new_auto,
          old_override: r.manual_override,
        });
        continue;
      }
      update.run(r.manual_override, r.manual_override, r.notes, r.audited_by, r.audit_date, r.new_id);
      migrated++;
    }
  });
  tx();

  return { migrated, skipped };
}

function backfillOrphanedPages(db: Database.Database, newRun: string) {
  // "Orphaned" = active pages with prior audit history but no entries in NEW_RUN.
  // The Review UI scopes by latest run_id, so any page not in NEW_RUN vanishes
  // from the dashboard. Backfill copies the most recent prior row per check
  // forward into NEW_RUN, preserving each cell's original status,
  // manual_override, audit_date, etc.
  const orphans = db.prepare(`
    SELECT COUNT(*) c FROM pages p
    WHERE p.active = 1
      AND EXISTS (SELECT 1 FROM audit_results ar WHERE ar.page_id = p.id AND ar.run_id != ?)
      AND NOT EXISTS (SELECT 1 FROM audit_results ar WHERE ar.page_id = p.id AND ar.run_id = ?)
  `).get(newRun, newRun) as { c: number };

  if (orphans.c === 0) {
    return { backfilled: 0, pages: 0 };
  }

  const tx = db.transaction(() => {
    return db.prepare(`
      INSERT INTO audit_results
        (page_id, check_number, check_name, status, severity, auto_result,
         manual_override, notes, remediation, axe_violations,
         audited_by, audit_date, run_id)
      SELECT
        ar.page_id, ar.check_number, ar.check_name, ar.status, ar.severity, ar.auto_result,
        ar.manual_override, ar.notes, ar.remediation, ar.axe_violations,
        ar.audited_by, ar.audit_date, ?
      FROM audit_results ar
      JOIN (
        SELECT page_id, check_number, MAX(id) AS max_id
        FROM audit_results
        WHERE page_id IN (
          SELECT p.id FROM pages p
          WHERE p.active = 1
            AND EXISTS (SELECT 1 FROM audit_results ar2 WHERE ar2.page_id = p.id AND ar2.run_id != ?)
            AND NOT EXISTS (SELECT 1 FROM audit_results ar3 WHERE ar3.page_id = p.id AND ar3.run_id = ?)
        )
          AND run_id != ?
        GROUP BY page_id, check_number
      ) latest ON latest.max_id = ar.id
    `).run(newRun, newRun, newRun, newRun);
  });

  const result = tx();
  return { backfilled: result.changes, pages: orphans.c };
}

function parseArgs(argv: string[]) {
  const out: { site?: string; limit?: number; unauditedOnly?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site' && argv[i + 1]) { out.site = argv[++i]; continue; }
    if (argv[i] === '--limit' && argv[i + 1]) { out.limit = parseInt(argv[++i], 10); continue; }
    if (argv[i] === '--new') { out.unauditedOnly = true; continue; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('\n=== DOJ WebRule Rescan ===');
  console.log('Phase 1: snapshot DB');
  const snapshot = snapshotDb();
  console.log(`  Saved: ${snapshot}`);

  // Open DB AFTER snapshot so we don't conflict with the file copy
  const db = new Database(DB_PATH);

  const oldRun = findLatestCompletedRun(db);
  if (!oldRun) {
    console.log('  No previous completed run found — this is a fresh audit, no migration needed.');
  } else {
    console.log(`  Previous run (will migrate from): ${oldRun}`);
  }

  // Close the DB before runBatch — runBatch opens its own connection
  db.close();

  console.log('\nPhase 2: run audit');
  console.log(`  Args: ${JSON.stringify(args)}`);
  const stats = await runBatch(args);
  console.log(`\n  Pages: ${stats.pagesDone}/${stats.pagesTotal}`);
  console.log(`  Pass:  ${stats.passed}  Fail: ${stats.failed}  Review: ${stats.review}  N/A: ${stats.na}  Error: ${stats.errors}`);
  await closeBrowser();

  if (stats.cancelled || stats.pagesDone === 0) {
    console.log('\n⚠ Audit was cancelled or scanned 0 pages. Skipping migration.');
    console.log(`  DB snapshot for rollback: ${snapshot}`);
    process.exit(stats.cancelled ? 130 : 0);
  }

  if (!oldRun) {
    console.log('\nPhase 3: skipped (no previous run to migrate from)');
    console.log('\nDone.');
    return;
  }

  // Reopen DB and find the run we just created (latest completed)
  const db2 = new Database(DB_PATH);
  const newRun = findLatestCompletedRun(db2);
  if (!newRun || newRun === oldRun) {
    console.log('\n⚠ No new completed run detected after audit. Did the run finish successfully?');
    console.log(`  DB snapshot for rollback: ${snapshot}`);
    db2.close();
    process.exit(1);
  }
  console.log(`\nPhase 3: migrate manual overrides from ${oldRun} → ${newRun}`);

  const { migrated, skipped } = migrateOverrides(db2, oldRun, newRun);

  console.log(`  Migrated forward (your reviews preserved): ${migrated}`);
  console.log(`  Left as fresh fails (rescan found new issues): ${skipped.length}`);

  if (skipped.length > 0) {
    console.log('\n  Pages/checks needing re-review:');
    // Group by check number for a tidy summary
    const byCheck: Record<number, number> = {};
    for (const s of skipped) byCheck[s.check] = (byCheck[s.check] || 0) + 1;
    for (const cn of Object.keys(byCheck).sort((a, b) => parseInt(a) - parseInt(b))) {
      console.log(`    Check ${cn}: ${byCheck[parseInt(cn)]} page(s)`);
    }
    if (skipped.length <= 30) {
      console.log('\n  Detail:');
      for (const s of skipped) {
        console.log(`    page ${s.page_id} check ${s.check}: was ${s.old_auto}→${s.old_override}, now ${s.new_auto}`);
      }
    } else {
      console.log(`\n  (${skipped.length} total — too many to list. Query the DB for details.)`);
    }
  }

  // Phase 4: backfill pages that the partial audit left out of NEW_RUN, so
  // the Review UI dashboard still sees them. No-op when the audit covered
  // every active page (e.g. a full rescan).
  console.log(`\nPhase 4: backfill pages absent from ${newRun}`);
  const backfill = backfillOrphanedPages(db2, newRun);
  if (backfill.pages === 0) {
    console.log(`  All active pages are present in the new run — nothing to backfill.`);
  } else {
    console.log(`  Pages absent from new run: ${backfill.pages}`);
    console.log(`  Result rows backfilled:    ${backfill.backfilled}`);
    console.log(`  (Each row copies the most recent prior status / manual_override / audit_date forward.)`);
  }

  db2.close();
  console.log(`\n  DB snapshot for rollback: ${snapshot}`);
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Rescan crashed:', err);
  process.exit(1);
});
