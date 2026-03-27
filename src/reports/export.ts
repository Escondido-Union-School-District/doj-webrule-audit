import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import * as XLSX from 'xlsx';
import { getDb, closeDb } from '../db.js';
import { OUTPUT_DIR } from '../config.js';

export function exportResults(format: 'csv' | 'xlsx' = 'csv'): void {
  const db = getDb();
  mkdirSync(resolve(OUTPUT_DIR, 'exports'), { recursive: true });

  const today = new Date().toISOString().split('T')[0];

  // Get all results with page info
  const results = db.prepare(`
    SELECT p.site, p.page_name, p.url,
      ar.check_number, ar.check_name, ar.status, ar.severity,
      ar.auto_result, ar.manual_override, ar.notes, ar.remediation,
      ar.audited_by, ar.audit_date
    FROM audit_results ar
    JOIN pages p ON p.id = ar.page_id
    ORDER BY p.site, p.page_name, ar.check_number
  `).all();

  if (results.length === 0) {
    console.log('No results to export. Run an audit first.');
    closeDb();
    return;
  }

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();

    // Main results sheet
    const ws = XLSX.utils.json_to_sheet(results);
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Results');

    // Summary sheet
    const summary = db.prepare(`
      SELECT p.site, p.page_name, p.url,
        SUM(CASE WHEN ar.status = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN ar.status = 'fail' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN ar.status = 'needs-review' THEN 1 ELSE 0 END) as review,
        SUM(CASE WHEN ar.status = 'n/a' THEN 1 ELSE 0 END) as na,
        COUNT(*) as total
      FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id
      GROUP BY p.id
      ORDER BY failed DESC, review DESC
    `).all();
    const summaryWs = XLSX.utils.json_to_sheet(summary);
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

    // Manual queue sheet
    const queue = db.prepare(`
      SELECT p.site, p.page_name, p.url,
        mq.check_number, mq.reason, mq.priority, mq.status, mq.result, mq.notes
      FROM manual_queue mq
      JOIN pages p ON p.id = mq.page_id
      ORDER BY mq.status, mq.priority DESC
    `).all();
    const queueWs = XLSX.utils.json_to_sheet(queue);
    XLSX.utils.book_append_sheet(wb, queueWs, 'Manual Queue');

    const outPath = resolve(OUTPUT_DIR, 'exports', `audit-export-${today}.xlsx`);
    XLSX.writeFile(wb, outPath);
    console.log(`Excel exported to: ${outPath}`);
  } else {
    // CSV export
    const ws = XLSX.utils.json_to_sheet(results);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const outPath = resolve(OUTPUT_DIR, 'exports', `audit-export-${today}.csv`);
    writeFileSync(outPath, csv, 'utf-8');
    console.log(`CSV exported to: ${outPath}`);
  }

  closeDb();
}
