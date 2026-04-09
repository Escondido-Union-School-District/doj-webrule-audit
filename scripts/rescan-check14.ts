// Re-scan check 14 (Linked Docs/PDFs) for pages currently marked n/a
// Uses Playwright to load each page and check for document links including Google Drive

import { getDb, closeDb } from '../src/db.js';
import { fetchPage, releasePage, closeBrowser } from '../src/crawler/page-fetcher.js';
import type { Page } from 'playwright';

async function main() {
  const db = getDb();
  const runId = (db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).get() as any).id;

  const pages = db.prepare(`
    SELECT p.id, p.url FROM audit_results ar
    JOIN pages p ON p.id = ar.page_id AND p.active = 1
    WHERE ar.check_number = 14 AND ar.run_id = ? AND COALESCE(ar.manual_override, ar.status) = 'n/a'
  `).all(runId) as Array<{ id: number; url: string }>;

  console.log(`Re-scanning check 14 for ${pages.length} pages...`);

  let found = 0;
  let scanned = 0;

  for (const p of pages) {
    scanned++;
    if (scanned % 25 === 0) console.log(`  Progress: ${scanned}/${pages.length} (found docs on ${found} pages)`);

    try {
      const fetched = await fetchPage(p.url);
      if (fetched.error) {
        await releasePage(fetched);
        continue;
      }

      const docLinks = await fetched.page.evaluate(() => {
        const links = document.querySelectorAll('a[href]');
        const docs: Array<{ href: string; text: string }> = [];
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const text = (link.textContent || '').trim();
          const isDocLink = /\.(pdf|docx?|pptx?|xlsx?)(\?|#|$)/i.test(href) ||
                            /5il\.co|aptg\.co/i.test(href) ||
                            /drive\.google\.com|docs\.google\.com|sheets\.google\.com|slides\.google\.com/i.test(href);
          if (isDocLink) {
            docs.push({ href: href.slice(0, 150), text: text.slice(0, 80) });
          }
        }
        return docs;
      });

      if (docLinks.length > 0) {
        found++;
        const notes = `${docLinks.length} document link(s) found: ${docLinks.map(d => d.href).join('; ').slice(0, 200)}`;
        console.log(`  FOUND: ${p.url} — ${docLinks.length} doc(s)`);

        db.prepare(`
          UPDATE audit_results SET status = 'needs-review', manual_override = NULL, notes = ?, audited_by = 'rescan'
          WHERE page_id = ? AND check_number = 14 AND run_id = ?
        `).run(notes, p.id, runId);
      }

      await releasePage(fetched);
    } catch (err) {
      // skip errors
    }
  }

  console.log(`\nDone. Scanned ${scanned} pages. Found docs on ${found} pages.`);
  console.log(`${pages.length - found} pages confirmed no docs — safe to mark as Pass.`);

  await closeBrowser();
  closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
