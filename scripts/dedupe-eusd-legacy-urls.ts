// One-off: deactivate 12 freshly-imported canonical /page/<slug> duplicates of
// district pages that Mark has been actively reviewing under the legacy
// /o/eusd/page/<slug> URL form.
//
// Why deactivate (rather than delete): keeps the rows + their audit_results
// queryable for history, and the Review UI already filters by active=1 so
// they disappear from the working list.
//
// Defaults to DRY RUN. --apply to write. Always backs up the DB first.

import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SOURCE_DB = resolve(PROJECT_ROOT, 'data', 'audit.db');
const BACKUP_DIR = resolve(PROJECT_ROOT, 'data', 'backups');

// IDs of the canonical /page/<slug> duplicates to deactivate. Each shares
// content with a more-reviewed /o/eusd/page/<slug> row that Mark already has.
const DUP_IDS = [1437, 1438, 1439, 1441, 1446, 1448, 1449, 1451, 1452, 1453, 1454, 1475];

const apply = process.argv.includes('--apply');

async function makeBackup(): Promise<string> {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(BACKUP_DIR, `audit-${stamp}-pre-dedupe-eusd.db`);
  const src = new Database(SOURCE_DB, { readonly: true });
  try { await src.backup(target); } finally { src.close(); }
  return target;
}

async function main() {
  console.log(`\n=== Deactivate /o/eusd/ duplicates${apply ? '' : ' (DRY RUN)'} ===\n`);

  if (apply) console.log(`Backup: ${await makeBackup()}\n`);

  const db = new Database(SOURCE_DB);

  // Defensive: only act on rows that match expected pattern.
  const placeholders = DUP_IDS.map(() => '?').join(',');
  const targets = db.prepare(
    `SELECT id, url, active, page_name FROM pages WHERE id IN (${placeholders})`
  ).all(...DUP_IDS) as Array<{ id: number; url: string; active: number; page_name: string }>;

  console.log(`Found ${targets.length} of ${DUP_IDS.length} requested rows.`);
  for (const r of targets) {
    if (!/^https:\/\/www\.eusd\.org\/page\//.test(r.url)) {
      console.error(`  REFUSING: id=${r.id} url=${r.url} doesn't match /page/<slug> pattern.`);
      console.error('  Aborting to avoid deactivating wrong row.');
      process.exit(2);
    }
    const tag = r.active ? 'active' : 'already inactive';
    console.log(`  id=${r.id} (${tag}) ${r.url} — ${r.page_name}`);
  }

  if (apply) {
    const stmt = db.prepare(`UPDATE pages SET active = 0 WHERE id = ?`);
    const tx = db.transaction(() => {
      let n = 0;
      for (const r of targets) n += stmt.run(r.id).changes;
      return n;
    });
    const updated = tx();
    console.log(`\nDeactivated ${updated} rows.`);
  } else {
    console.log('\nDry run only. Re-run with --apply to write.');
  }

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
