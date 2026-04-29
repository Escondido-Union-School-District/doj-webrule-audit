// Rescan the 14 active pages still tagged audited_by='auto' AND
// status='needs-review' for check 14. These were flagged by the OLD detector
// (which counted Google Forms / Drive folders as documents). After the junk
// cleanup, 7 of them have 0 linked_files entries — orphaned. Rescanning with
// the new detector gives an accurate verdict.
//
// Same logic as scripts/rescan-doc-link-fix.ts, just narrower scope and
// audited_by tag = 'rescan-orphan-fix'.

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
  const target = join(BACKUP_DIR, `audit-${stamp}-pre-orphan-rescan.db`);
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
  if (/5il\.co|aptg\.co/.test(u)) return 'pdf';
  if (/docs\.google\.com\/(?:a\/[^/]+\/)?document\//.test(u)) return 'docx';
  if (/docs\.google\.com\/(?:a\/[^/]+\/)?spreadsheets\//.test(u)) return 'xlsx';
  if (/docs\.google\.com\/(?:a\/[^/]+\/)?presentation\//.test(u)) return 'pptx';
  return 'unknown';
}

async function main() {
  console.log('=== Backing up DB ===');
  console.log(`  Backup: ${await makeBackup()}`);

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
      AND ar.audited_by = 'auto' AND ar.status = 'needs-review' AND p.active = 1
    ORDER BY p.id
  `).all(runId) as Array<{ id: number; url: string }>;
  console.log(`\nRescanning ${pages.length} orphan pages...\n`);

  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO linked_files (page_id, file_url, link_text, file_type)
    VALUES (?, ?, ?, ?)
  `);
  const updateResult = db.prepare(`
    UPDATE audit_results
    SET status = ?, manual_override = NULL, severity = NULL,
        notes = ?, remediation = '', audited_by = 'rescan-orphan-fix',
        audit_date = datetime('now')
    WHERE page_id = ? AND check_number = 14 AND run_id = ?
      AND audited_by = 'auto' AND status = 'needs-review'
  `);

  let scanned = 0, errored = 0, flippedPass = 0, kept = 0, totalNewFiles = 0;
  let cursor = 0;

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
                                /docs\.google\.com\/(?:a\/[^/]+\/)?(document|spreadsheets|presentation)\//i.test(href);
              if (!isDocLink) continue;
              if (seen.has(href)) continue;
              seen.add(href);
              docs.push({ href, text: text.slice(0, 200) });
            }
            return docs;
          });
        }
        await releasePage(fetched);
      } catch { pageError = true; }

      if (pageError) { errored++; scanned++; continue; }

      const newFiles = db.transaction(() => {
        let added = 0;
        for (const d of docLinks) {
          const r = insertFile.run(p.id, d.href, d.text || null, inferFileType(d.href));
          if (r.changes > 0) added++;
        }
        if (docLinks.length === 0) {
          updateResult.run('pass', 'No document links found (rescan with tightened detector — Google Forms and non-doc URLs no longer counted).', p.id, runId);
        } else {
          updateResult.run('needs-review', `${docLinks.length} document link(s) found — verify each linked file is accessible (tagged PDF, alt text, reading order).`, p.id, runId);
        }
        return added;
      })();

      if (docLinks.length === 0) flippedPass++; else kept++;
      totalNewFiles += newFiles;
      scanned++;
      console.log(`  ${scanned}/${pages.length} ${p.url} → ${docLinks.length === 0 ? 'pass' : `${docLinks.length} doc(s)`}`);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, pages.length) }, () => worker());
  await Promise.all(workers);

  console.log(`\n=== Done ===`);
  console.log(`  Flipped → pass:    ${flippedPass}`);
  console.log(`  Kept needs-review: ${kept}`);
  console.log(`  New linked_files:  ${totalNewFiles}`);
  console.log(`  Errored:           ${errored}`);

  await closeBrowser();
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
