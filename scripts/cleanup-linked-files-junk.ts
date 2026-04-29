// Clean up linked_files entries that don't represent reviewable documents.
//
// Removes UNREVIEWED entries that match these specific patterns:
//   - Google Forms (any /a/<workspace>/ prefix or none, also forms.gle)
//   - Google Drive folder URLs (drive/folders/, drive/u/N/folders/, plain /drive)
//
// Preserves:
//   - Reviewed entries (status != 'unreviewed') — Mark's reviews stay; reported.
//   - drive.google.com/open?id=...  — old Drive sharing URL format that points
//     to a real file (just not matched by the new check 14 detector).
//   - Apptegy shortlinks (5il.co, aptg.co) and all real document URLs.
//   - Anything else that doesn't match a junk pattern. Truncated/malformed
//     URLs (e.g., 'https://docs.googl') are not auto-deleted; manual cleanup.

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
  const target = join(BACKUP_DIR, `audit-${stamp}-pre-junk-cleanup.db`);
  const src = new Database(SOURCE_DB, { readonly: true });
  try { await src.backup(target); } finally { src.close(); }
  return target;
}

const FORM_RE = /(?:docs\.google\.com\/(?:a\/[^/]+\/)?forms|forms\.gle)/i;
const FOLDER_RE = /drive\.google\.com\/(?:(?:a\/[^/]+\/)?drive(?:\/u\/\d+)?\/folders\/|drive(?:\?|$|\/$))/i;

function classify(url: string): 'form' | 'folder' | 'keep' {
  if (FORM_RE.test(url)) return 'form';
  if (FOLDER_RE.test(url)) return 'folder';
  return 'keep';
}

async function main() {
  console.log('=== Backing up DB ===');
  const backup = await makeBackup();
  console.log(`  Backup: ${backup}`);

  const db = new Database(SOURCE_DB);
  const all = db.prepare("SELECT id, page_id, file_url, file_type, status FROM linked_files").all() as Array<{
    id: number; page_id: number; file_url: string; file_type: string; status: string;
  }>;

  const counts: Record<string, number> = { form: 0, folder: 0 };
  const toDelete: typeof all = [];
  const reviewedJunk: typeof all = [];

  for (const row of all) {
    const c = classify(row.file_url);
    if (c === 'keep') continue;
    counts[c]++;
    if (row.status !== 'unreviewed') reviewedJunk.push(row);
    else toDelete.push(row);
  }

  console.log('\n=== Junk classification ===');
  console.table(counts);
  console.log(`Will delete (unreviewed only): ${toDelete.length}`);
  console.log(`Reviewed junk (kept, flagged): ${reviewedJunk.length}`);

  if (reviewedJunk.length > 0) {
    console.log('\n=== Reviewed entries that match a junk pattern (NOT deleted) ===');
    for (const r of reviewedJunk) {
      console.log(`  page ${r.page_id}, status=${r.status}: ${r.file_url}`);
    }
  }

  console.log('\n=== Sample of rows to delete (first 10) ===');
  for (const d of toDelete.slice(0, 10)) console.log(`  page ${d.page_id}: ${d.file_url}`);

  const del = db.prepare("DELETE FROM linked_files WHERE id = ?");
  const tx = db.transaction(() => {
    let n = 0;
    for (const d of toDelete) n += del.run(d.id).changes;
    return n;
  });
  const deleted = tx();
  console.log(`\n=== Deleted ${deleted} junk rows ===`);

  console.log('\n=== linked_files after cleanup ===');
  console.table(db.prepare("SELECT status, COUNT(*) as c FROM linked_files GROUP BY status").all());
  const total = (db.prepare("SELECT COUNT(*) as c FROM linked_files").get() as any).c;
  const pages = (db.prepare("SELECT COUNT(DISTINCT page_id) as c FROM linked_files").get() as any).c;
  console.log(`Total: ${total} files, ${pages} pages`);

  // Pages that were 'needs-review' but now have 0 linked_files (only Forms got
  // counted on those pages — they're effectively pass)
  const runId = (db.prepare(`SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status='completed' ORDER BY started_at DESC LIMIT 1`).get() as any).id;
  const orphanedPages = db.prepare(`
    SELECT ar.page_id, p.url
    FROM audit_results ar JOIN pages p ON p.id = ar.page_id
    WHERE ar.check_number = 14 AND ar.status = 'needs-review' AND p.active = 1
      AND ar.audited_by IN ('rescan-doc-link-fix', 'auto')
      AND (SELECT COUNT(*) FROM linked_files lf WHERE lf.page_id = ar.page_id) = 0
  `).all(runId) as any[];
  console.log(`\n=== ${orphanedPages.length} pages now have 0 linked_files (their only entries were Forms/folders); a follow-up rescan will flip these to pass ===`);
  for (const p of orphanedPages.slice(0, 10)) console.log(`  page ${p.page_id}: ${p.url}`);

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
