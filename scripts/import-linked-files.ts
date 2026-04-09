// Import linked files from:
// 1. find-pdfs results.json (5il.co/aptg.co shortcodes)
// 2. Existing audit_results notes for check 14 (files found during scan)

import { getDb, closeDb } from '../src/db.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function main() {
  const db = getDb();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO linked_files (page_id, file_url, link_text, file_type)
    VALUES (?, ?, ?, ?)
  `);

  let imported = 0;
  let skipped = 0;

  // 1. Import from find-pdfs results
  const findPdfsPath = resolve(__dirname, '../../find-pdfs/results.json');
  try {
    const findPdfs = JSON.parse(readFileSync(findPdfsPath, 'utf8'));
    console.log(`Loading ${findPdfs.length} entries from find-pdfs...`);

    for (const entry of findPdfs) {
      // Match page URL to our pages table
      const pageUrl = entry.page.replace(/\/$/, '');
      const page = db.prepare(
        'SELECT id FROM pages WHERE (url = ? OR url = ?) AND active = 1'
      ).get(pageUrl, pageUrl + '/') as { id: number } | undefined;

      if (!page) { skipped++; continue; }

      const fileType = entry.is_pdf ? 'pdf' :
        entry.content_type?.includes('spreadsheet') ? 'xlsx' :
        entry.content_type?.includes('presentation') ? 'pptx' :
        entry.content_type?.includes('document') ? 'docx' : 'other';

      const result = insert.run(page.id, entry.shortcode, entry.link_text || null, fileType);
      if (result.changes > 0) imported++;
    }
    console.log(`  Imported: ${imported}, Skipped (no matching page): ${skipped}`);
  } catch (err) {
    console.log('find-pdfs results not found, skipping.');
  }

  // 2. Import from audit_results notes (check 14 entries that found docs)
  const runId = (db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).get() as any)?.id;

  if (runId) {
    const results = db.prepare(`
      SELECT ar.page_id, ar.notes FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id AND p.active = 1
      WHERE ar.check_number = 14 AND ar.run_id = ?
      AND COALESCE(ar.manual_override, ar.status) != 'n/a'
      AND ar.notes LIKE '%document link%'
    `).all(runId) as Array<{ page_id: number; notes: string }>;

    console.log(`\nChecking ${results.length} audit results for additional file links...`);
    let fromAudit = 0;

    for (const r of results) {
      // Extract URLs from notes like "3 document link(s) found: https://5il.co/xxx; https://..."
      const urlMatches = r.notes.match(/https?:\/\/[^\s;,]+/g);
      if (!urlMatches) continue;

      for (const url of urlMatches) {
        const result = insert.run(r.page_id, url.replace(/\.$/, ''), null, 'unknown');
        if (result.changes > 0) fromAudit++;
      }
    }
    console.log(`  Added ${fromAudit} files from audit results`);
  }

  const total = (db.prepare('SELECT COUNT(*) as c FROM linked_files').get() as any).c;
  const pages = (db.prepare('SELECT COUNT(DISTINCT page_id) as c FROM linked_files').get() as any).c;
  console.log(`\nTotal linked files: ${total} across ${pages} pages`);

  closeDb();
}

main();
