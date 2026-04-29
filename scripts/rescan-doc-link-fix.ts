// Rescan the 717 pages flipped by the migration-doc-link-fix migration with
// the NEW (tightened) check 14 detector. For each page:
//   - Fetch with Playwright
//   - Find document links using the same matcher as src/checks/index.ts
//   - INSERT linked_files rows for each unique doc URL
//   - Update audit_results for check 14:
//       0 doc links found → status='pass'  (the old detector falsely flagged
//                                            Google Forms / non-doc URLs)
//       >0 doc links     → status='needs-review' with accurate count
//
// Only touches rows where audited_by='migration-doc-link-fix' on active pages.
// Result rows get audited_by='rescan-doc-link-fix' so the migration is traceable.

import Database from 'better-sqlite3';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { fetchPage, releasePage, closeBrowser } from '../src/crawler/page-fetcher.js';
import { CONCURRENCY } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SOURCE_DB = resolve(PROJECT_ROOT, 'data', 'audit.db');
const BACKUP_DIR = resolve(PROJECT_ROOT, 'data', 'backups');

async function makeBackup(): Promise<string> {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = join(BACKUP_DIR, `audit-${stamp}-pre-doc-link-rescan.db`);
  const src = new Database(SOURCE_DB, { readonly: true });
  try { await src.backup(target); } finally { src.close(); }
  return target;
}

function inferFileType(href: string): string {
  const u = href.toLowerCase();
  if (/\.pdf(\?|#|$)/.test(u)) return 'pdf';
  if (/\.docx?(\?|#|$)/.test(u)) return 'docx';
  if (/\.xlsx?(\?|#|$)/.test(u)) return 'xlsx';
  if (/\.pptx?(\?|#|$)/.test(u)) return 'pptx';
  if (/5il\.co|aptg\.co/.test(u)) return 'pdf'; // Apptegy convention
  if (/docs\.google\.com\/document\//.test(u)) return 'docx';
  if (/docs\.google\.com\/spreadsheets\//.test(u)) return 'xlsx';
  if (/docs\.google\.com\/presentation\//.test(u)) return 'pptx';
  return 'unknown';
}

async function main() {
  console.log('=== Backing up DB ===');
  const backup = await makeBackup();
  console.log(`  Backup: ${backup}`);

  const db = new Database(SOURCE_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const runId = (db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).get() as any).id;

  const pages = db.prepare(`
    SELECT p.id, p.url FROM audit_results ar
    JOIN pages p ON p.id = ar.page_id
    WHERE ar.check_number = 14 AND ar.run_id = ?
      AND ar.audited_by = 'migration-doc-link-fix' AND p.active = 1
    ORDER BY p.id
  `).all(runId) as Array<{ id: number; url: string }>;

  console.log(`\nRescanning ${pages.length} active pages with new detector...`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO linked_files (page_id, file_url, link_text, file_type)
    VALUES (?, ?, ?, ?)
  `);
  const updateResult = db.prepare(`
    UPDATE audit_results
    SET status = ?, manual_override = NULL, severity = NULL,
        notes = ?, remediation = ?, audited_by = 'rescan-doc-link-fix',
        audit_date = datetime('now')
    WHERE page_id = ? AND check_number = 14 AND run_id = ?
      AND audited_by = 'migration-doc-link-fix'
  `);

  let scanned = 0, errored = 0, flippedPass = 0, kept = 0, totalNewFiles = 0;
  let cursor = 0;
  const start = Date.now();

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= pages.length) return;
      const p = pages[idx];

      let docLinks: Array<{ href: string; text: string }> = [];
      let pageError = false;

      try {
        const fetched = await fetchPage(p.url);
        if (fetched.error) {
          pageError = true;
        } else {
          docLinks = await fetched.page.evaluate(() => {
            const links = document.querySelectorAll('a[href]');
            const seen = new Set<string>();
            const docs: Array<{ href: string; text: string }> = [];
            for (const link of links) {
              const href = link.getAttribute('href') || '';
              const text = (link.textContent || '').trim();
              const isDocLink = /\.(pdf|docx?|pptx?|xlsx?)(\?|#|$)/i.test(href) ||
                                /5il\.co|aptg\.co/i.test(href) ||
                                /drive\.google\.com\/file\//i.test(href) ||
                                /drive\.google\.com\/uc\?.*export=download/i.test(href) ||
                                /docs\.google\.com\/(document|spreadsheets|presentation)\//i.test(href);
              if (!isDocLink) continue;
              if (seen.has(href)) continue;
              seen.add(href);
              docs.push({ href, text: text.slice(0, 200) });
            }
            return docs;
          });
        }
        await releasePage(fetched);
      } catch (err) {
        pageError = true;
      }

      if (pageError) {
        errored++;
        scanned++;
        continue;
      }

      // Persist results in a transaction per page so Ctrl+C is safe.
      const newFilesForThisPage = db.transaction(() => {
        let added = 0;
        for (const d of docLinks) {
          const result = insertFile.run(p.id, d.href, d.text || null, inferFileType(d.href));
          if (result.changes > 0) added++;
        }
        if (docLinks.length === 0) {
          updateResult.run(
            'pass', 'No document links found (rescan with tightened detector — Google Forms and non-doc URLs no longer counted).', '',
            p.id, runId,
          );
        } else {
          updateResult.run(
            'needs-review',
            `${docLinks.length} document link(s) found — verify each linked file is accessible (tagged PDF, alt text, reading order).`,
            '',
            p.id, runId,
          );
        }
        return added;
      })();

      if (docLinks.length === 0) flippedPass++; else kept++;
      totalNewFiles += newFilesForThisPage;
      scanned++;

      if (scanned % 25 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        const rate = (scanned / Math.max(1, parseFloat(elapsed))).toFixed(2);
        console.log(`  Progress: ${scanned}/${pages.length} (pass: ${flippedPass}, kept: ${kept}, errors: ${errored}, new files: ${totalNewFiles}, ${elapsed}s @ ${rate}/s)`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, pages.length) }, () => worker());
  await Promise.all(workers);

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`  Scanned:        ${scanned}`);
  console.log(`  Flipped → pass: ${flippedPass}  (no actual doc links — old detector false positive)`);
  console.log(`  Kept needs-review: ${kept}`);
  console.log(`  Errored:        ${errored}`);
  console.log(`  New linked_files rows: ${totalNewFiles}`);

  // Final state
  console.log('\n=== Check 14 status (after rescan) ===');
  console.table(db.prepare(`
    SELECT status, audited_by, COUNT(*) as c FROM audit_results
    WHERE check_number = 14 AND run_id = ?
    GROUP BY status, audited_by ORDER BY c DESC
  `).all(runId));

  console.log('\n=== linked_files ===');
  console.table(db.prepare("SELECT status, COUNT(*) as c FROM linked_files GROUP BY status").all());
  const total = (db.prepare("SELECT COUNT(*) as c FROM linked_files").get() as any).c;
  const pagesWithFiles = (db.prepare("SELECT COUNT(DISTINCT page_id) as c FROM linked_files").get() as any).c;
  console.log(`  Total files: ${total}, pages with files: ${pagesWithFiles}`);

  await closeBrowser();
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
