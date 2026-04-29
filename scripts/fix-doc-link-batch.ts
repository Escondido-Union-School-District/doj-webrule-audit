// One-off migration: undo the over-broad batch in commit d03a8b0.
//
// That batch set status='pass' for 717 pages whose only check-14 fail had been
// the file-type-indicator-in-link-text rule. The new check 14 code returns
// 'needs-review' (not 'pass') whenever doc links are found — so those pages
// should be 'needs-review' so the linked PDFs/docs get inspected via the
// Linked Files UI.
//
// Touches ONLY rows currently tagged audited_by='manual-batch-doc-link-rule-relaxed'.
// Does not touch any manual decision (pass/fail/needs-review set by Mark).
//
// After this update, run scripts/import-linked-files.ts to populate the
// linked_files table from the doc-link notes on these pages.

import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SOURCE_DB = resolve(PROJECT_ROOT, 'data', 'audit.db');
const BACKUP_DIR = resolve(PROJECT_ROOT, 'data', 'backups');

async function makeBackup(): Promise<string> {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(BACKUP_DIR, `audit-${stamp}-pre-doc-link-fix.db`);
  const src = new Database(SOURCE_DB, { readonly: true });
  try {
    await src.backup(target);
  } finally {
    src.close();
  }
  return target;
}

function countByStatusAuditedBy(db: Database.Database, runId: string) {
  return db.prepare(`
    SELECT status, audited_by, COUNT(*) as c
    FROM audit_results WHERE check_number = 14 AND run_id = ?
    GROUP BY status, audited_by ORDER BY c DESC
  `).all(runId);
}

function countLinkedFiles(db: Database.Database) {
  return {
    byStatus: db.prepare("SELECT status, COUNT(*) as c FROM linked_files GROUP BY status").all(),
    total: (db.prepare("SELECT COUNT(*) as c FROM linked_files").get() as any).c,
    pages: (db.prepare("SELECT COUNT(DISTINCT page_id) as c FROM linked_files").get() as any).c,
  };
}

async function main() {
  console.log('=== Backing up DB before fix ===');
  const backupPath = await makeBackup();
  console.log(`  Backup: ${backupPath}`);

  const db = new Database(SOURCE_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const runId = (db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).get() as any).id;
  console.log(`  Latest run id: ${runId}`);

  console.log('\n=== Check 14 status BEFORE ===');
  console.table(countByStatusAuditedBy(db, runId));

  const lfBefore = countLinkedFiles(db);
  console.log(`\n=== linked_files BEFORE: ${lfBefore.total} files / ${lfBefore.pages} pages ===`);
  console.table(lfBefore.byStatus);

  // Preview what we'll change.
  const targets = db.prepare(`
    SELECT page_id, notes FROM audit_results
    WHERE check_number = 14 AND run_id = ? AND audited_by = 'manual-batch-doc-link-rule-relaxed'
  `).all(runId) as Array<{ page_id: number; notes: string | null }>;
  console.log(`\n=== Pages targeted for fix: ${targets.length} ===`);

  // Extract doc-link count from each page's note. Notes look like:
  //   "Auto-cleared: only fail was the file-type-indicator-in-link-text rule (now removed — best practice but not a WCAG 2.1 SC); was: 'N document link(s) found...'"
  //   or the older: "N document link(s) found. N document link(s) don't indicate file type in link text"
  function extractCount(note: string | null): number | null {
    if (!note) return null;
    const m = note.match(/(\d+)\s+document link\(s\)\s+found/i);
    return m ? parseInt(m[1], 10) : null;
  }

  const update = db.prepare(`
    UPDATE audit_results
    SET status = 'needs-review',
        severity = NULL,
        manual_override = NULL,
        notes = ?,
        remediation = '',
        audited_by = 'migration-doc-link-fix',
        audit_date = datetime('now')
    WHERE page_id = ? AND check_number = 14 AND run_id = ?
      AND audited_by = 'manual-batch-doc-link-rule-relaxed'
  `);

  const tx = db.transaction((rows: typeof targets) => {
    let updated = 0;
    let unknownCount = 0;
    for (const r of rows) {
      const n = extractCount(r.notes);
      const note = n !== null
        ? `${n} document link(s) found — verify each linked file is accessible (tagged PDF, alt text, reading order).`
        : `Document link(s) present — verify each linked file is accessible (tagged PDF, alt text, reading order).`;
      if (n === null) unknownCount++;
      const res = update.run(note, r.page_id, runId);
      if (res.changes > 0) updated++;
    }
    return { updated, unknownCount };
  });

  console.log('\n=== Applying fix ===');
  const { updated, unknownCount } = tx(targets);
  console.log(`  Rows updated: ${updated}`);
  if (unknownCount > 0) console.log(`  Rows where doc-link count couldn't be parsed from notes: ${unknownCount}`);

  console.log('\n=== Check 14 status AFTER ===');
  console.table(countByStatusAuditedBy(db, runId));

  db.close();
  console.log('\nDone. Now run: npx tsx scripts/import-linked-files.ts');
}

main().catch(err => { console.error(err); process.exit(1); });
