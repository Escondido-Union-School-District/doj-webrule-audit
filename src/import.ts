import { readFileSync } from 'fs';
import * as XLSX from 'xlsx';
import { getDb, closeDb } from './db.js';
import { EXCEL_PATH, CHECKS } from './config.js';

// School sheets map sheet name → site key
const SCHOOL_SHEETS: Record<string, string> = {
  eusd: 'eusd',
  farravenue: 'farravenue',
  glenview: 'glenview',
  hep: 'hep',
  lincoln: 'lincoln',
  lla: 'lla',
  mission: 'mission',
  pioneer: 'pioneer',
  preschool: 'preschool',
  quantum: 'quantum',
};

export function runImport(): void {
  console.log(`Reading Excel file: ${EXCEL_PATH}`);
  const buf = readFileSync(EXCEL_PATH);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const db = getDb();

  let totalPages = 0;
  let totalResults = 0;

  // --- Import pages from school sheets ---
  const insertPage = db.prepare(`
    INSERT OR IGNORE INTO pages (site, page_name, url, source)
    VALUES (?, ?, ?, 'excel-school')
  `);

  for (const [sheetName, siteKey] of Object.entries(SCHOOL_SHEETS)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      console.log(`  Skipping missing sheet: ${sheetName}`);
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });
    let count = 0;
    for (const row of rows) {
      const name = (row['Name'] || '').trim();
      const url = (row['URL'] || '').trim();
      if (!url) continue;
      insertPage.run(siteKey, name || url, url);
      count++;
    }
    console.log(`  ${sheetName}: ${count} pages`);
    totalPages += count;
  }

  // --- Import pages + results from District sheet ---
  const districtSheet = wb.Sheets['District'];
  if (districtSheet) {
    totalPages += importDistrictSheet(db, districtSheet);
  }

  // --- Import from Audit DB sheet (new normalized format) ---
  const auditDbSheet = wb.Sheets['Audit DB'];
  if (auditDbSheet) {
    totalResults += importAuditDb(db, auditDbSheet);
  }

  // Log the import
  db.prepare(`
    INSERT INTO import_log (source, rows_imported, notes)
    VALUES (?, ?, ?)
  `).run('excel-full', totalPages, `Imported ${totalPages} pages, ${totalResults} audit results`);

  const pageCount = (db.prepare('SELECT COUNT(*) as c FROM pages').get() as { c: number }).c;
  console.log(`\nImport complete: ${pageCount} total pages in database`);
  closeDb();
}

function importDistrictSheet(db: ReturnType<typeof getDb>, ws: XLSX.WorkSheet): number {
  // District sheet has:
  //   Row 0: Title row (ignored)
  //   Row 1: Category headers (KB ACCESS, READING ORDER, etc.) spanning 3 cols each
  //   Row 2: Sub-headers (Pass/Fail, Notes, Remediation) repeated
  //   Row 3+: Data
  const allRows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
  if (allRows.length < 4) {
    console.log('  District sheet: too few rows, skipping');
    return 0;
  }

  const insertPage = db.prepare(`
    INSERT OR IGNORE INTO pages (site, page_name, url, source)
    VALUES ('district', ?, ?, 'excel-district')
  `);

  // Check name mapping: column index → check number
  // Col 0=Name, Col 1=URL, then every 3 cols = one check (Pass/Fail, Notes, Remediation)
  // Check 1 starts at col 2, Check 2 at col 5, etc.

  let count = 0;
  const dataRows = allRows.slice(3); // Skip title, category headers, sub-headers

  for (const row of dataRows) {
    const name = String(row[0] || '').trim();
    const url = String(row[1] || '').trim();
    if (!url || !url.startsWith('http')) continue;

    insertPage.run(name || url, url);
    count++;

    // Import existing audit results for this page
    const page = db.prepare('SELECT id FROM pages WHERE url = ?').get(url) as { id: number } | undefined;
    if (!page) continue;

    // Create or get a run for imported data
    const importRunId = 'excel-import';
    db.prepare(`
      INSERT OR IGNORE INTO audit_runs (id, started_at, finished_at, status, notes)
      VALUES (?, datetime('now'), datetime('now'), 'completed', 'Imported from Excel')
    `).run(importRunId);

    for (let checkIdx = 0; checkIdx < 15; checkIdx++) {
      const colBase = 2 + (checkIdx * 3);
      const statusRaw = String(row[colBase] || '').trim().toLowerCase();
      const notes = String(row[colBase + 1] || '').trim();
      const remediation = String(row[colBase + 2] || '').trim();

      if (!statusRaw || statusRaw === 'tbd') continue;

      const status = statusRaw === 'pass' ? 'pass' : statusRaw === 'fail' ? 'fail' : 'needs-review';
      const check = CHECKS[checkIdx];

      db.prepare(`
        INSERT OR IGNORE INTO audit_results (page_id, check_number, check_name, status, notes, remediation, audited_by, run_id)
        VALUES (?, ?, ?, ?, ?, ?, 'excel-import', ?)
      `).run(page.id, check.number, check.name, status, notes || null, remediation || null, importRunId);
    }
  }

  console.log(`  District: ${count} pages with existing results`);
  return count;
}

function importAuditDb(db: ReturnType<typeof getDb>, ws: XLSX.WorkSheet): number {
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });
  if (rows.length === 0) return 0;

  // Create or get a run for Audit DB imported data
  const importRunId = 'excel-auditdb-import';
  db.prepare(`
    INSERT OR IGNORE INTO audit_runs (id, started_at, finished_at, status, notes)
    VALUES (?, datetime('now'), datetime('now'), 'completed', 'Imported from Audit DB sheet')
  `).run(importRunId);

  // Map test category names to check numbers
  const checkNameToNumber: Record<string, number> = {};
  for (const c of CHECKS) {
    checkNameToNumber[c.name.toLowerCase()] = c.number;
  }

  let count = 0;
  for (const row of rows) {
    const url = (row['URL'] || '').trim();
    const testCategory = (row['Test Category'] || '').trim();
    const statusRaw = (row['Status'] || '').trim().toLowerCase();

    if (!url || !testCategory || !statusRaw || statusRaw === 'tbd') continue;

    const checkNumber = checkNameToNumber[testCategory.toLowerCase()];
    if (!checkNumber) continue;

    const page = db.prepare('SELECT id FROM pages WHERE url = ?').get(url) as { id: number } | undefined;
    if (!page) continue;

    const status = statusRaw === 'pass' ? 'pass' : statusRaw === 'fail' ? 'fail' : 'needs-review';
    const severity = (row['Severity'] || '').trim().toLowerCase() || null;
    const notes = (row['Notes'] || '').trim() || null;
    const remediation = (row['Remediation'] || '').trim() || null;
    const auditedBy = (row['Audited By'] || '').trim() || 'excel-auditdb';

    db.prepare(`
      INSERT OR REPLACE INTO audit_results (page_id, check_number, check_name, status, severity, notes, remediation, audited_by, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(page.id, checkNumber, testCategory, status, severity, notes, remediation, auditedBy, importRunId);
    count++;
  }

  console.log(`  Audit DB: ${count} results imported`);
  return count;
}
