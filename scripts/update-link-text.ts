// Update linked_files link_text by visiting each page with Playwright
// and extracting the actual rendered link text for each file URL

import { getDb, closeDb } from '../src/db.js';
import { fetchPage, releasePage, closeBrowser } from '../src/crawler/page-fetcher.js';

async function main() {
  const db = getDb();

  // Get all pages that have linked files with missing link text
  const pages = db.prepare(`
    SELECT DISTINCT lf.page_id, p.url
    FROM linked_files lf
    JOIN pages p ON p.id = lf.page_id AND p.active = 1
    WHERE lf.link_text IS NULL OR lf.link_text = ''
  `).all() as Array<{ page_id: number; url: string }>;

  console.log(`Updating link text for files on ${pages.length} pages...`);

  let updated = 0;
  let scanned = 0;

  for (const p of pages) {
    scanned++;
    if (scanned % 10 === 0) console.log(`  Progress: ${scanned}/${pages.length} (updated ${updated} links)`);

    try {
      const fetched = await fetchPage(p.url);
      if (fetched.error) { await releasePage(fetched); continue; }

      // Get all links from the rendered page
      const pageLinks = await fetched.page.evaluate(() => {
        const links = document.querySelectorAll('a[href]');
        const result: Array<{ href: string; text: string }> = [];
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const text = (link.textContent || '').trim();
          if (text && href) result.push({ href, text: text.slice(0, 200) });
        }
        return result;
      });

      // Get this page's linked files with missing text
      const files = db.prepare(
        "SELECT id, file_url FROM linked_files WHERE page_id = ? AND (link_text IS NULL OR link_text = '')"
      ).all(p.page_id) as Array<{ id: number; file_url: string }>;

      for (const file of files) {
        // Find a link whose href exactly matches or contains the shortcode URL
        // Prefer exact match, then contains match, skip generic site titles
        const exactMatch = pageLinks.find(l => l.href === file.file_url);
        const containsMatch = pageLinks.find(l =>
          (l.href.includes(file.file_url) || file.file_url.includes(l.href)) &&
          l.text.length > 5 && l.text.length < 150 &&
          !/^(Escondido|EUSD|Home|Menu)/i.test(l.text)
        );
        const match = exactMatch || containsMatch;
        if (match) {
          db.prepare('UPDATE linked_files SET link_text = ? WHERE id = ?').run(match.text, file.id);
          updated++;
        }
      }

      await releasePage(fetched);
    } catch (err) {
      // skip errors
    }
  }

  console.log(`\nDone. Updated ${updated} link texts across ${scanned} pages.`);
  await closeBrowser();
  closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
