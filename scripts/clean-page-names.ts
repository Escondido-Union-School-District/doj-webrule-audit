// One-off migration: clean up the pages.page_name column.
//
//   - Strip leading-backtick + trailing-apostrophe wrappers (~431 rows).
//   - For pages whose page_name is just the URL, derive a Title Case label
//     from the last meaningful URL segment (~781 rows).
//
// Defaults to DRY RUN. Pass --apply to write. Always backs up the DB first.

import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { normalizePageName } from '../src/utils/page-title.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SOURCE_DB = resolve(PROJECT_ROOT, 'data', 'audit.db');
const BACKUP_DIR = resolve(PROJECT_ROOT, 'data', 'backups');

const apply = process.argv.includes('--apply');

async function makeBackup(): Promise<string> {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(BACKUP_DIR, `audit-${stamp}-pre-clean-page-names.db`);
  const src = new Database(SOURCE_DB, { readonly: true });
  try { await src.backup(target); } finally { src.close(); }
  return target;
}

async function main() {
  console.log(`\n=== Clean page_name${apply ? '' : ' (DRY RUN)'} ===`);

  if (apply) {
    console.log(`Backup: ${await makeBackup()}`);
  }

  const db = new Database(SOURCE_DB);
  const rows = db.prepare(
    "SELECT id, site, page_name, url FROM pages"
  ).all() as Array<{ id: number; site: string; page_name: string; url: string }>;

  let unchanged = 0;
  let unwrapped = 0;
  let derivedFromUrl = 0;
  const samples: Array<{ id: number; before: string; after: string; type: string }> = [];

  const update = db.prepare("UPDATE pages SET page_name = ? WHERE id = ?");

  function processAll() {
    for (const r of rows) {
      const before = r.page_name;
      const after = normalizePageName(before, r.url, r.site);
      if (after === before) { unchanged++; continue; }

      const looksLikeUrl = /^https?:\/\//i.test(before);
      const wasWrapped = before.length >= 2 &&
        before.charCodeAt(0) === 96 &&
        before.charCodeAt(before.length - 1) === 39;

      let type: string;
      if (looksLikeUrl) { derivedFromUrl++; type = 'url→title'; }
      else if (wasWrapped) { unwrapped++; type = 'unwrapped'; }
      else { type = 'other'; }

      if (samples.length < 12) samples.push({ id: r.id, before, after, type });

      if (apply) update.run(after, r.id);
    }
  }

  if (apply) db.transaction(processAll)();
  else processAll();

  console.log(`\nTotal pages:           ${rows.length}`);
  console.log(`  unchanged:           ${unchanged}`);
  console.log(`  unwrapped (\`...'):  ${unwrapped}`);
  console.log(`  derived from URL:    ${derivedFromUrl}`);

  console.log('\nSample changes:');
  for (const s of samples) {
    console.log(`  [${s.type}] id=${s.id}`);
    console.log(`     before: ${JSON.stringify(s.before)}`);
    console.log(`     after:  ${JSON.stringify(s.after)}`);
  }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to write.');
  } else {
    console.log('\nApplied. Refresh the Review UI to see new titles.');
  }

  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
