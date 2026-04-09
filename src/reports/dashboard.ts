import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { getDb, closeDb } from '../db.js';
import { OUTPUT_DIR, CHECKS } from '../config.js';

export function generateDashboard(): void {
  const db = getDb();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Pin every query to the latest completed audit run.
  const latestRun = db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).get() as { id: string } | undefined;

  if (!latestRun) {
    console.log('No completed audit run found. Run an audit first.');
    closeDb();
    return;
  }
  const runId = latestRun.id;

  // --- Gather all data ---

  const totalPages = (db.prepare('SELECT COUNT(*) as c FROM pages WHERE active = 1').get() as any).c;
  const totalAudited = (db.prepare(`
    SELECT COUNT(DISTINCT page_id) as c FROM audit_results
    WHERE run_id = ?
  `).get(runId) as any).c;

  // Results by status — use COALESCE so manual overrides take precedence
  const statusCounts = db.prepare(`
    SELECT COALESCE(manual_override, status) as status, COUNT(*) as count FROM audit_results
    WHERE run_id = ?
    GROUP BY COALESCE(manual_override, status)
  `).all(runId) as Array<{ status: string; count: number }>;

  const statusMap: Record<string, number> = {};
  for (const s of statusCounts) statusMap[s.status] = s.count;

  // Results by check
  const byCheck = db.prepare(`
    SELECT check_number, check_name,
      SUM(CASE WHEN COALESCE(manual_override, status) = 'pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN COALESCE(manual_override, status) = 'fail' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN COALESCE(manual_override, status) = 'needs-review' THEN 1 ELSE 0 END) as review,
      SUM(CASE WHEN COALESCE(manual_override, status) = 'n/a' THEN 1 ELSE 0 END) as na,
      SUM(CASE WHEN COALESCE(manual_override, status) = 'error' THEN 1 ELSE 0 END) as errors,
      COUNT(*) as total
    FROM audit_results
    WHERE run_id = ?
    GROUP BY check_number
    ORDER BY check_number
  `).all(runId) as Array<{
    check_number: number; check_name: string;
    passed: number; failed: number; review: number; na: number; errors: number; total: number;
  }>;

  // Results by site
  const bySite = db.prepare(`
    SELECT p.site,
      COUNT(DISTINCT p.id) as pages,
      SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) = 'pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) = 'fail' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) = 'needs-review' THEN 1 ELSE 0 END) as review
    FROM pages p
    LEFT JOIN audit_results ar ON ar.page_id = p.id AND ar.run_id = ?
    WHERE p.active = 1
    GROUP BY p.site
    ORDER BY p.site
  `).all(runId) as Array<{ site: string; pages: number; passed: number; failed: number; review: number }>;

  // Critical failures (most impactful)
  const criticalFailures = db.prepare(`
    SELECT ar.check_name, ar.notes, COUNT(*) as page_count, ar.severity
    FROM audit_results ar
    WHERE COALESCE(ar.manual_override, ar.status) = 'fail'
      AND ar.run_id = ?
    GROUP BY ar.check_name, ar.notes
    ORDER BY page_count DESC
    LIMIT 10
  `).all(runId) as Array<{ check_name: string; notes: string; page_count: number; severity: string }>;

  // Manual queue pending
  const manualPending = (db.prepare('SELECT COUNT(*) as c FROM manual_queue WHERE status = ?').get('pending') as any).c;
  const manualDone = (db.prepare('SELECT COUNT(*) as c FROM manual_queue WHERE status = ?').get('done') as any).c;

  // Daily progress history
  const dailyProgress = db.prepare(`
    SELECT date, pages_auto, auto_passed, auto_failed, auto_review, manual_done
    FROM daily_progress ORDER BY date DESC LIMIT 14
  `).all() as Array<{ date: string; pages_auto: number; auto_passed: number; auto_failed: number; auto_review: number; manual_done: number }>;

  // Pages fully passing (all 15 checks = pass or n/a) — pinned to latest run
  const fullyPassing = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT page_id, COUNT(*) as total,
        SUM(CASE WHEN COALESCE(manual_override, status) IN ('pass', 'n/a') THEN 1 ELSE 0 END) as good
      FROM audit_results
      WHERE run_id = ?
      GROUP BY page_id
      HAVING total = 15 AND good = 15
    )
  `).get(runId) as any;

  // --- Generate HTML ---

  const pct = totalPages > 0 ? ((totalAudited / totalPages) * 100).toFixed(1) : '0.0';
  const passRate = (statusMap['pass'] || 0) + (statusMap['n/a'] || 0);
  const totalChecks = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const passRatePct = totalChecks > 0 ? ((passRate / totalChecks) * 100).toFixed(1) : '0.0';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DOJ WebRule Audit — Dashboard</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 1000px; margin: 2em auto; padding: 0 1.5em; line-height: 1.6; color: #222; background: #f8f9fa; }
  h1 { color: #1a56db; border-bottom: 3px solid #1a56db; padding-bottom: 0.3em; }
  h2 { color: #1a56db; border-bottom: 1px solid #ccc; padding-bottom: 0.2em; margin-top: 2em; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1em; margin: 1.5em 0; }
  .card { background: white; border-radius: 8px; padding: 1.2em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
  .card .number { font-size: 2.2em; font-weight: bold; margin: 0; }
  .card .label { color: #666; font-size: 0.9em; margin-top: 0.3em; }
  .card.pass .number { color: #16a34a; }
  .card.fail .number { color: #dc2626; }
  .card.review .number { color: #d97706; }
  .card.total .number { color: #1a56db; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { border: 1px solid #e5e7eb; padding: 0.6em 0.8em; text-align: left; font-size: 0.9em; }
  th { background: #1a56db; color: white; font-weight: 600; }
  tr:nth-child(even) { background: #f9fafb; }
  .progress-bar { background: #e5e7eb; border-radius: 4px; height: 20px; position: relative; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .progress-fill.good { background: #16a34a; }
  .progress-fill.warn { background: #d97706; }
  .progress-fill.bad { background: #dc2626; }
  .progress-text { position: absolute; right: 6px; top: 1px; font-size: 0.75em; color: #333; font-weight: 600; }
  .badge { display: inline-block; padding: 0.15em 0.5em; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .badge-pass { background: #dcfce7; color: #166534; }
  .badge-fail { background: #fee2e2; color: #991b1b; }
  .badge-review { background: #fef3c7; color: #92400e; }
  .badge-na { background: #e5e7eb; color: #4b5563; }
  .timestamp { color: #666; font-size: 0.85em; margin-top: 0.5em; }
  @media print { body { background: white; } .card { box-shadow: none; border: 1px solid #ccc; } }
</style>
</head>
<body>

<h1>DOJ WebRule Audit Dashboard</h1>
<p>EUSD ADA/WCAG 2.1 Level AA Compliance — <strong>Deadline: April 26, 2027</strong></p>

<div class="card-grid">
  <div class="card total">
    <p class="number">${totalPages}</p>
    <p class="label">Total Pages</p>
  </div>
  <div class="card total">
    <p class="number">${totalAudited}</p>
    <p class="label">Pages Scanned (${pct}%)</p>
  </div>
  <div class="card pass">
    <p class="number">${fullyPassing.c}</p>
    <p class="label">Fully Passing</p>
  </div>
  <div class="card pass">
    <p class="number">${passRatePct}%</p>
    <p class="label">Check Pass Rate</p>
  </div>
  <div class="card fail">
    <p class="number">${statusMap['fail'] || 0}</p>
    <p class="label">Failed Checks</p>
  </div>
  <div class="card review">
    <p class="number">${manualPending}</p>
    <p class="label">Manual Reviews Pending</p>
  </div>
</div>

<h2>Progress by Check</h2>
<table>
  <tr><th>#</th><th>Check</th><th>Pass</th><th>Fail</th><th>Review</th><th>N/A</th><th>Progress</th></tr>
  ${byCheck.map(c => {
    const done = c.passed + c.na;
    const pct = c.total > 0 ? ((done / c.total) * 100).toFixed(0) : '0';
    const cls = c.failed > 0 ? 'bad' : parseInt(pct) > 80 ? 'good' : 'warn';
    const autoLevel = CHECKS.find(ch => ch.number === c.check_number)?.autoLevel || '';
    return `<tr>
      <td>${c.check_number}</td>
      <td>${c.check_name} <span class="badge badge-${autoLevel === 'full' ? 'pass' : autoLevel === 'partial' ? 'review' : 'na'}">${autoLevel}</span></td>
      <td><span class="badge badge-pass">${c.passed}</span></td>
      <td>${c.failed > 0 ? `<span class="badge badge-fail">${c.failed}</span>` : '0'}</td>
      <td>${c.review > 0 ? `<span class="badge badge-review">${c.review}</span>` : '0'}</td>
      <td>${c.na}</td>
      <td><div class="progress-bar"><div class="progress-fill ${cls}" style="width:${pct}%"></div><span class="progress-text">${pct}%</span></div></td>
    </tr>`;
  }).join('\n  ')}
</table>

<h2>Progress by Site</h2>
<table>
  <tr><th>Site</th><th>Pages</th><th>Passed</th><th>Failed</th><th>Review</th><th>Pass Rate</th></tr>
  ${bySite.map(s => {
    const total = s.passed + s.failed + s.review;
    const pct = total > 0 ? ((s.passed / total) * 100).toFixed(0) : '—';
    return `<tr>
      <td><strong>${s.site}</strong></td>
      <td>${s.pages}</td>
      <td>${s.passed}</td>
      <td>${s.failed > 0 ? `<span class="badge badge-fail">${s.failed}</span>` : '0'}</td>
      <td>${s.review > 0 ? `<span class="badge badge-review">${s.review}</span>` : '0'}</td>
      <td>${pct}%</td>
    </tr>`;
  }).join('\n  ')}
</table>

${criticalFailures.length > 0 ? `
<h2>Top Issues (Low-Hanging Fruit)</h2>
<table>
  <tr><th>Check</th><th>Issue</th><th>Pages Affected</th><th>Severity</th></tr>
  ${criticalFailures.map(f => `<tr>
    <td>${f.check_name}</td>
    <td>${escapeHtml((f.notes || '').slice(0, 100))}</td>
    <td><strong>${f.page_count}</strong></td>
    <td>${f.severity ? `<span class="badge badge-${f.severity === 'critical' ? 'fail' : f.severity === 'serious' ? 'fail' : 'review'}">${f.severity}</span>` : '—'}</td>
  </tr>`).join('\n  ')}
</table>
` : ''}

${dailyProgress.length > 0 ? `
<h2>Recent Activity</h2>
<table>
  <tr><th>Date</th><th>Pages Scanned</th><th>Auto Pass</th><th>Auto Fail</th><th>Auto Review</th><th>Manual Done</th></tr>
  ${dailyProgress.map(d => `<tr>
    <td>${d.date}</td>
    <td>${d.pages_auto}</td>
    <td>${d.auto_passed}</td>
    <td>${d.auto_failed}</td>
    <td>${d.auto_review}</td>
    <td>${d.manual_done}</td>
  </tr>`).join('\n  ')}
</table>
` : ''}

<h2>Manual Review Queue</h2>
<p><strong>${manualPending}</strong> items pending &nbsp;|&nbsp; <strong>${manualDone}</strong> completed</p>

<p class="timestamp">Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}</p>

</body>
</html>`;

  const outPath = resolve(OUTPUT_DIR, 'dashboard.html');
  writeFileSync(outPath, html, 'utf-8');
  console.log(`Dashboard written to: ${outPath}`);
  console.log(`Open: file:///${outPath.replace(/\\/g, '/')}`);

  closeDb();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
