import { getDb, getStats, getManualQueue, closeDb } from './db.js';
import { runImport } from './import.js';
import { fetchPage, releasePage, closeBrowser } from './crawler/page-fetcher.js';
import { runAllChecks } from './checks/index.js';
import { runBatch } from './crawler/batch-runner.js';
import { discoverPages } from './crawler/discover.js';
import { generateDashboard } from './reports/dashboard.js';
import { generateDailySummary, sendDailyEmail } from './reports/daily-summary.js';
import { exportResults } from './reports/export.js';
import { CHECKS } from './config.js';

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case 'import':
      runImport();
      break;

    case 'audit':
      await runAudit(args);
      break;

    case 'status':
      showStatus();
      break;

    case 'queue':
      showQueue(args);
      break;

    case 'review':
      recordReview(args);
      break;

    case 'review-batch':
      recordBatchReview(args);
      break;

    case 'today':
      showToday();
      break;

    case 'dashboard':
      generateDashboard();
      break;

    case 'discover':
      await discoverPages({ site: args.find((_, i) => args[i - 1] === '--site'), diff: args.includes('--diff') });
      break;

    case 'quickwins':
      showQuickWins();
      break;

    case 'export':
      exportResults(args.includes('--format') && args[args.indexOf('--format') + 1] === 'xlsx' ? 'xlsx' : 'csv');
      break;

    case 'email':
      await sendDailyEmail(args[0] as any || 'morning');
      break;

    case 'dupes':
      findDuplicates();
      break;

    default:
      console.log(`
DOJ WebRule Audit — EUSD ADA/WCAG Compliance Tool

Commands:
  import              Import pages from Excel into SQLite
  audit               Run automated accessibility audit
    --url <url>       Audit a single page
    --site <site>     Audit pages from a specific site
    --limit <n>       Limit number of pages to audit
    --new             Only audit pages not yet scanned
  status              Show overall progress
  today               Show today's action plan
  queue               Show manual review queue
    --check <n>       Filter by check number
    --site <site>     Filter by site
  review <id> <check> <pass|fail> "notes"
                      Record a manual review result
  review-batch --check <n> --site <site> <pass|fail> "notes"
                      Batch record manual reviews
  quickwins           Show low-hanging fruit report
  dashboard           Generate HTML dashboard
  discover            Crawl sites to find all current pages
  export              Export results to CSV
    --format xlsx     Export to Excel format
      `);
  }
}

// --- Audit command ---

async function runAudit(args: string[]) {
  let targetUrl: string | undefined;
  let targetSite: string | undefined;
  let limit: number | undefined;
  let unauditedOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) targetUrl = args[++i];
    if (args[i] === '--site' && args[i + 1]) targetSite = args[++i];
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    if (args[i] === '--new') unauditedOnly = true;
  }

  if (targetUrl) {
    // Single URL mode — quick one-off audit
    await runSingleAudit(targetUrl);
  } else {
    // Batch mode with concurrency
    const stats = await runBatch({ site: targetSite, limit, unauditedOnly });
    console.log(`\n=== Audit Complete${stats.cancelled ? ' (cancelled)' : ''} ===`);
    console.log(`Pages:  ${stats.pagesDone}/${stats.pagesTotal}`);
    console.log(`Pass:   ${stats.passed}`);
    console.log(`Fail:   ${stats.failed}`);
    console.log(`Review: ${stats.review}`);
    console.log(`N/A:    ${stats.na}`);
    console.log(`Error:  ${stats.errors}`);
    await closeBrowser();
    closeDb();
  }
}

async function runSingleAudit(targetUrl: string) {
  const db = getDb();

  // Ensure page is in DB
  let page = db.prepare('SELECT id, page_name, url, site FROM pages WHERE url = ?').get(targetUrl) as any;
  if (!page) {
    db.prepare('INSERT INTO pages (site, page_name, url, source) VALUES (?, ?, ?, ?)').run(
      'manual', targetUrl, targetUrl, 'cli'
    );
    page = db.prepare('SELECT id, page_name, url, site FROM pages WHERE url = ?').get(targetUrl);
  }

  const runId = `run-${Date.now()}`;
  db.prepare(`
    INSERT INTO audit_runs (id, started_at, pages_total, status)
    VALUES (?, datetime('now'), 1, 'running')
  `).run(runId);

  console.log(`\n=== DOJ WebRule Audit ===`);
  process.stdout.write(`Auditing: ${targetUrl}... `);

  const fetched = await fetchPage(targetUrl);

  if (fetched.error) {
    console.log(`ERROR (${fetched.loadTimeMs}ms): ${fetched.error}`);
    for (const check of CHECKS) {
      db.prepare(`
        INSERT OR REPLACE INTO audit_results
        (page_id, check_number, check_name, status, severity, auto_result, notes, remediation, axe_violations, audited_by, run_id)
        VALUES (?, ?, ?, 'error', null, 'error', ?, '', '[]', 'auto', ?)
      `).run(page.id, check.number, check.name, `Page load failed: ${fetched.error}`, runId);
    }
    await releasePage(fetched);
    await closeBrowser();
    closeDb();
    return;
  }

  const results = await runAllChecks(fetched.page, targetUrl);

  const insertResult = db.prepare(`
    INSERT OR REPLACE INTO audit_results
    (page_id, check_number, check_name, status, severity, auto_result, notes, remediation, axe_violations, audited_by, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)
  `);
  const insertManual = db.prepare(`
    INSERT OR REPLACE INTO manual_queue (page_id, check_number, reason, priority)
    VALUES (?, ?, ?, ?)
  `);

  let passed = 0, failed = 0, review = 0;
  for (const r of results) {
    insertResult.run(page.id, r.checkNumber, r.checkName, r.status, r.severity, r.status,
      r.notes, r.remediation, r.axeViolations, runId);
    if (r.needsManualReview) {
      insertManual.run(page.id, r.checkNumber, r.manualReason || 'Flagged for manual review',
        r.status === 'fail' ? 'high' : 'normal');
    }
    if (r.status === 'pass') passed++;
    else if (r.status === 'fail') failed++;
    else if (r.status === 'needs-review') review++;
  }

  console.log(`✓ ${passed} pass, ${failed} fail, ${review} review (${fetched.loadTimeMs}ms)`);

  // Print detailed results
  console.log('\nResults:');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'n/a' ? '—' : '?';
    console.log(`  ${icon} ${r.checkNumber}. ${r.checkName}: ${r.status.toUpperCase()}`);
    if (r.notes && r.status !== 'pass' && r.status !== 'n/a') {
      console.log(`    ${r.notes.slice(0, 120)}`);
    }
  }

  db.prepare(`UPDATE audit_runs SET finished_at = datetime('now'), pages_done = 1, status = 'completed' WHERE id = ?`).run(runId);
  await releasePage(fetched);
  await closeBrowser();
  closeDb();
}

// --- Status command ---

function showStatus() {
  const db = getDb();
  const stats = getStats(db);

  const pct = stats.totalPages > 0
    ? ((stats.pagesAudited / stats.totalPages) * 100).toFixed(1)
    : '0.0';

  console.log(`\n=== DOJ WebRule Audit — Status ===`);
  console.log(`Total pages:    ${stats.totalPages}`);
  console.log(`Pages audited:  ${stats.pagesAudited} (${pct}%)`);
  console.log(`Total checks:   ${stats.totalChecks}`);
  console.log(`  Passed:       ${stats.passed}`);
  console.log(`  Failed:       ${stats.failed}`);
  console.log(`  Needs review: ${stats.needsReview}`);
  console.log(`  Pending:      ${stats.pending}`);

  // Manual queue summary
  const pending = (db.prepare('SELECT COUNT(*) as c FROM manual_queue WHERE status = ?').get('pending') as { c: number }).c;
  console.log(`\nManual queue:   ${pending} items pending`);

  closeDb();
}

// --- Queue command ---

function showQueue(args: string[]) {
  const db = getDb();

  let checkNumber: number | undefined;
  let site: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1]) checkNumber = parseInt(args[++i], 10);
    if (args[i] === '--site' && args[i + 1]) site = args[++i];
  }

  const items = getManualQueue(db, { checkNumber, site }) as any[];

  if (items.length === 0) {
    console.log('\nNo pending manual reviews.');
    closeDb();
    return;
  }

  console.log(`\n=== Manual Review Queue (${items.length} items) ===\n`);

  for (const item of items.slice(0, 30)) {
    const checkInfo = CHECKS.find(c => c.number === item.check_number);
    console.log(`  [${item.id}] ${item.page_name}`);
    console.log(`       URL:    ${item.url}`);
    console.log(`       Check:  ${item.check_number}. ${checkInfo?.name || item.check_number}`);
    console.log(`       Reason: ${item.reason}`);
    console.log(`       Command: npm run review -- ${item.page_id} ${item.check_number} pass "description"`);
    console.log('');
  }

  if (items.length > 30) {
    console.log(`  ... and ${items.length - 30} more. Use --check or --site to filter.`);
  }

  closeDb();
}

// --- Review command ---

function recordReview(args: string[]) {
  if (args.length < 3) {
    console.log('Usage: npm run review -- <page_id> <check_number> <pass|fail> "notes"');
    return;
  }

  const db = getDb();
  const pageId = parseInt(args[0], 10);
  const checkNumber = parseInt(args[1], 10);
  const result = args[2].toLowerCase();
  const notes = args.slice(3).join(' ');

  if (!['pass', 'fail'].includes(result)) {
    console.log('Result must be "pass" or "fail"');
    closeDb();
    return;
  }

  // Update manual queue
  db.prepare(`
    UPDATE manual_queue
    SET status = 'done', result = ?, notes = ?, reviewer = 'mark', reviewed_at = datetime('now')
    WHERE page_id = ? AND check_number = ? AND status = 'pending'
  `).run(result, notes || null, pageId, checkNumber);

  // Update the latest audit result with manual override
  db.prepare(`
    UPDATE audit_results
    SET manual_override = ?, status = ?
    WHERE page_id = ? AND check_number = ?
    AND run_id = (SELECT id FROM audit_runs ORDER BY started_at DESC LIMIT 1)
  `).run(result, result, pageId, checkNumber);

  // Update daily progress
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO daily_progress (date, manual_done)
    VALUES (?, 1)
    ON CONFLICT(date) DO UPDATE SET manual_done = manual_done + 1
  `).run(today);

  const page = db.prepare('SELECT page_name FROM pages WHERE id = ?').get(pageId) as { page_name: string } | undefined;
  const checkName = CHECKS.find(c => c.number === checkNumber)?.name || `Check ${checkNumber}`;

  console.log(`✓ Recorded: ${page?.page_name || pageId} — ${checkName} → ${result.toUpperCase()}`);
  closeDb();
}

// --- Batch review command ---

function recordBatchReview(args: string[]) {
  const db = getDb();

  let checkNumber: number | undefined;
  let site: string | undefined;
  let result: string | undefined;
  let notes = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' && args[i + 1]) checkNumber = parseInt(args[++i], 10);
    else if (args[i] === '--site' && args[i + 1]) site = args[++i];
    else if (['pass', 'fail'].includes(args[i])) result = args[i];
    else if (result) notes += (notes ? ' ' : '') + args[i];
  }

  if (!checkNumber || !result) {
    console.log('Usage: npm run review:batch -- --check <n> [--site <site>] <pass|fail> "notes"');
    closeDb();
    return;
  }

  let sql = `
    SELECT mq.id, mq.page_id, mq.check_number, p.page_name
    FROM manual_queue mq
    JOIN pages p ON p.id = mq.page_id
    WHERE mq.status = 'pending' AND mq.check_number = ?
  `;
  const params: any[] = [checkNumber];
  if (site) {
    sql += ' AND p.site = ?';
    params.push(site);
  }

  const items = db.prepare(sql).all(...params) as any[];

  if (items.length === 0) {
    console.log('No matching pending items found.');
    closeDb();
    return;
  }

  const updateQueue = db.prepare(`
    UPDATE manual_queue
    SET status = 'done', result = ?, notes = ?, reviewer = 'mark', reviewed_at = datetime('now')
    WHERE id = ?
  `);

  const updateResult = db.prepare(`
    UPDATE audit_results
    SET manual_override = ?, status = ?
    WHERE page_id = ? AND check_number = ?
    AND run_id = (SELECT id FROM audit_runs ORDER BY started_at DESC LIMIT 1)
  `);

  for (const item of items) {
    updateQueue.run(result, notes || null, item.id);
    updateResult.run(result, result, item.page_id, item.check_number);
  }

  const checkName = CHECKS.find(c => c.number === checkNumber)?.name || `Check ${checkNumber}`;
  console.log(`✓ Batch updated ${items.length} items: ${checkName} → ${result!.toUpperCase()}`);
  closeDb();
}

// --- Today command ---

function showToday() {
  const db = getDb();
  const stats = getStats(db);

  // Get last session info
  const lastResult = db.prepare(`
    SELECT ar.audit_date, p.page_name, ar.check_name
    FROM audit_results ar
    JOIN pages p ON p.id = ar.page_id
    WHERE ar.audited_by != 'excel-import' AND ar.audited_by != 'excel-auditdb'
    ORDER BY ar.audit_date DESC LIMIT 1
  `).get() as { audit_date: string; page_name: string; check_name: string } | undefined;

  const pendingQueue = getManualQueue(db) as any[];
  const todayItems = pendingQueue.slice(0, 10);

  console.log(`\n=== DOJ WebRule Audit — Good morning! ===\n`);

  // Where you left off
  console.log('WHERE YOU LEFT OFF:');
  if (lastResult) {
    console.log(`  Last activity: ${lastResult.audit_date}`);
    console.log(`  Last page: ${lastResult.page_name} (${lastResult.check_name})`);
  } else {
    console.log('  No previous activity found. Run: npm run import');
  }
  console.log(`  Queue remaining: ${pendingQueue.length} items\n`);

  // Today's batch
  if (todayItems.length > 0) {
    console.log(`TODAY'S MANUAL REVIEWS (${todayItems.length} items):\n`);
    for (let i = 0; i < todayItems.length; i++) {
      const item = todayItems[i];
      const checkInfo = CHECKS.find(c => c.number === item.check_number);
      console.log(`  Page ${i + 1}: ${item.page_name}`);
      console.log(`    Open: ${item.url}`);
      console.log(`    Check: ${checkInfo?.name || item.check_number} — ${item.reason}`);
      console.log(`    Command: npm run review -- ${item.page_id} ${item.check_number} pass "description"`);
      console.log('');
    }
  } else {
    // Check if there are unaudited pages
    const unaudited = db.prepare(`
      SELECT COUNT(*) as c FROM pages p WHERE p.active = 1
      AND NOT EXISTS (SELECT 1 FROM audit_results ar WHERE ar.page_id = p.id)
    `).get() as { c: number };

    if (unaudited.c > 0) {
      console.log(`${unaudited.c} pages haven't been scanned yet.`);
      console.log(`Run: npm run audit --limit 50\n`);
    } else {
      console.log('All manual reviews complete! Run: npm run status\n');
    }
  }

  // Overall progress
  const pct = stats.totalPages > 0 ? ((stats.pagesAudited / stats.totalPages) * 100).toFixed(1) : '0.0';
  console.log(`SCHEDULE: ${stats.pagesAudited}/${stats.totalPages} pages (${pct}%)`);

  closeDb();
}

// --- Quick Wins command ---

function showQuickWins() {
  const db = getDb();

  // Get most common failures grouped by check + notes pattern
  const commonFailures = db.prepare(`
    SELECT check_name, check_number, notes, COUNT(*) as page_count, severity
    FROM audit_results
    WHERE status = 'fail'
    GROUP BY check_name, notes
    ORDER BY page_count DESC
    LIMIT 15
  `).all() as Array<{ check_name: string; check_number: number; notes: string; page_count: number; severity: string }>;

  if (commonFailures.length === 0) {
    console.log('\nNo failures found yet. Run: npm run audit');
    closeDb();
    return;
  }

  console.log(`\n=== LOW-HANGING FRUIT (fix these first for maximum impact) ===\n`);

  for (let i = 0; i < commonFailures.length; i++) {
    const f = commonFailures[i];
    console.log(`${i + 1}. ${f.check_name} (affects ${f.page_count} page${f.page_count !== 1 ? 's' : ''})`);
    console.log(`   ${f.notes?.slice(0, 120) || 'No details'}`);
    console.log('');
  }

  closeDb();
}

// --- Duplicate detection ---

function findDuplicates() {
  const db = getDb();

  const pages = db.prepare('SELECT id, site, page_name, url FROM pages WHERE active = 1 ORDER BY url').all() as Array<{
    id: number; site: string; page_name: string; url: string;
  }>;

  console.log(`\n=== Duplicate Page Detection ===`);
  console.log(`Checking ${pages.length} pages...\n`);

  // 1. URL normalization: strip trailing slash, query params, fragments, lowercase
  const normalized = new Map<string, typeof pages>();
  for (const p of pages) {
    try {
      const parsed = new URL(p.url);
      const key = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
      if (!normalized.has(key)) normalized.set(key, []);
      normalized.get(key)!.push(p);
    } catch {
      // Skip invalid URLs
    }
  }

  // 2. Known Apptegy/Thrillshare duplicate patterns
  // e.g., /page/slug and /o/sitename/page/slug often point to same content
  // Only flag when on the SAME origin (cross-school same slugs are legit different pages)
  const slugMap = new Map<string, typeof pages>();
  for (const p of pages) {
    try {
      const parsed = new URL(p.url);
      const pathClean = parsed.pathname.replace(/\/+$/, '').toLowerCase();
      // Extract the meaningful slug — strip /o/sitename/ prefix
      const stripped = pathClean.replace(/^\/o\/[^/]+/, '');
      if (!stripped || stripped === '/') continue;
      const key = `${parsed.origin}::${stripped}`;
      if (!slugMap.has(key)) slugMap.set(key, []);
      slugMap.get(key)!.push(p);
    } catch {}
  }

  // 3. Same page_name on same site
  const nameMap = new Map<string, typeof pages>();
  for (const p of pages) {
    const key = `${p.site}::${p.page_name.toLowerCase().trim()}`;
    if (!nameMap.has(key)) nameMap.set(key, []);
    nameMap.get(key)!.push(p);
  }

  // Report duplicates
  let dupeCount = 0;
  const reported = new Set<string>();

  // Exact URL dupes (after normalization)
  for (const [key, group] of normalized) {
    if (group.length <= 1) continue;
    const ids = group.map(p => p.id).sort().join(',');
    if (reported.has(ids)) continue;
    reported.add(ids);
    dupeCount++;
    console.log(`URL DUPLICATE (normalized to same path):`);
    for (const p of group) {
      console.log(`  [${p.id}] ${p.page_name} — ${p.url}`);
    }
    console.log('');
  }

  // Slug dupes (different paths, same slug on same origin)
  for (const [key, group] of slugMap) {
    if (group.length <= 1) continue;
    // Skip if already caught as URL dupe
    const ids = group.map(p => p.id).sort().join(',');
    if (reported.has(ids)) continue;
    reported.add(ids);
    dupeCount++;
    console.log(`POSSIBLE DUPLICATE (same slug, different path):`);
    for (const p of group) {
      console.log(`  [${p.id}] ${p.page_name} — ${p.url}`);
    }
    console.log('');
  }

  // Name dupes on same site
  for (const [key, group] of nameMap) {
    if (group.length <= 1) continue;
    const ids = group.map(p => p.id).sort().join(',');
    if (reported.has(ids)) continue;
    reported.add(ids);
    dupeCount++;
    console.log(`SAME NAME on same site:`);
    for (const p of group) {
      console.log(`  [${p.id}] ${p.page_name} — ${p.url}`);
    }
    console.log('');
  }

  if (dupeCount === 0) {
    console.log('No duplicates found.');
  } else {
    console.log(`\n${dupeCount} potential duplicate group(s) found.`);
    console.log('To deactivate a duplicate, run:');
    console.log('  sqlite3 data/audit.db "UPDATE pages SET active = 0 WHERE id = <id>"');
  }

  closeDb();
}

// --- Run ---

main().catch(err => {
  console.error('Fatal error:', err);
  closeBrowser().catch(() => {});
  closeDb();
  process.exit(1);
});
