import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { getDb, closeDb } from '../db.js';
import { PROJECT_ROOT, CHECKS } from '../config.js';

export function exportSite(): void {
  const db = getDb();
  const outPath = resolve(PROJECT_ROOT, 'docs', 'data.json');

  const latestRun = db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' ORDER BY pages_total DESC, started_at DESC LIMIT 1`
  ).get() as { id: string } | undefined;

  const totalPages = (db.prepare('SELECT COUNT(*) as c FROM pages WHERE active = 1').get() as any).c;

  if (!latestRun) {
    const data = {
      exportedAt: new Date().toISOString(),
      totalPages,
      fullyPassed: 0,
      fullyReviewedWithFailures: 0,
      unreviewed: totalPages,
      thisWeek: 0,
      thisMonth: 0,
      today: 0,
      dailyGoal: 10,
      behindThisWeek: 0,
      checks: {} as Record<number, { name: string; remaining: number; allPass: boolean }>,
    };
    for (const c of CHECKS) {
      data.checks[c.number] = { name: c.name, remaining: totalPages, allPass: false };
    }
    writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`Exported to ${outPath}`);
    closeDb();
    return;
  }

  const runId = latestRun.id;

  const fullyPassed = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT ar.page_id FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id AND p.active = 1
      WHERE ar.run_id = ?
      GROUP BY ar.page_id
      HAVING SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) = 'pass' THEN 1 ELSE 0 END) = 15
    )
  `).get(runId) as any).c;

  const fullyReviewedWithFailures = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT ar.page_id FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id AND p.active = 1
      WHERE ar.run_id = ?
      GROUP BY ar.page_id
      HAVING SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) IN ('pass','fail') THEN 1 ELSE 0 END) = 15
        AND SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) = 'fail' THEN 1 ELSE 0 END) > 0
    )
  `).get(runId) as any).c;

  const unreviewed = (db.prepare(`
    SELECT COUNT(DISTINCT ar.page_id) as c FROM audit_results ar
    JOIN pages p ON p.id = ar.page_id AND p.active = 1
    WHERE ar.run_id = ? AND COALESCE(ar.manual_override, ar.status) NOT IN ('pass', 'fail')
  `).get(runId) as any).c;

  // Time-based stats
  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const mondayStr = monday.toISOString().split('T')[0];
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const todayStr = now.toISOString().split('T')[0];

  const thisWeek = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT ar.page_id, MAX(ar.audit_date) as completed_at FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id AND p.active = 1
      WHERE ar.run_id = ?
      GROUP BY ar.page_id
      HAVING SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) IN ('pass','fail') THEN 1 ELSE 0 END) = 15
        AND completed_at >= ?
    )
  `).get(runId, mondayStr) as any).c;

  const thisMonth = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT ar.page_id, MAX(ar.audit_date) as completed_at FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id AND p.active = 1
      WHERE ar.run_id = ?
      GROUP BY ar.page_id
      HAVING SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) IN ('pass','fail') THEN 1 ELSE 0 END) = 15
        AND completed_at >= ?
    )
  `).get(runId, monthStart) as any).c;

  const today = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT ar.page_id, MAX(ar.audit_date) as completed_at FROM audit_results ar
      JOIN pages p ON p.id = ar.page_id AND p.active = 1
      WHERE ar.run_id = ?
      GROUP BY ar.page_id
      HAVING SUM(CASE WHEN COALESCE(ar.manual_override, ar.status) IN ('pass','fail') THEN 1 ELSE 0 END) = 15
        AND completed_at >= ?
    )
  `).get(runId, todayStr) as any).c;

  // Behind schedule
  const DAILY_GOAL = 10;
  const TRACKING_START = '2026-04-08';
  const trackingStart = new Date(TRACKING_START + 'T00:00:00');
  let shouldHaveDone = 0;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const d = new Date(trackingStart);
  d.setDate(d.getDate() + 1);
  while (d <= yesterday) {
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) shouldHaveDone += DAILY_GOAL;
    d.setDate(d.getDate() + 1);
  }
  const behindThisWeek = Math.max(0, shouldHaveDone - (thisWeek + thisMonth - today));

  // Check progress
  const totalActive = totalPages;
  const checkRows = db.prepare(`
    SELECT check_number,
      SUM(CASE WHEN COALESCE(manual_override, status) IN ('pass', 'n/a') THEN 1 ELSE 0 END) as done
    FROM audit_results
    WHERE run_id = ? AND page_id IN (SELECT id FROM pages WHERE active = 1)
    GROUP BY check_number
  `).all(runId) as Array<{ check_number: number; done: number }>;

  const checks: Record<number, { name: string; remaining: number; allPass: boolean }> = {};
  for (const c of CHECKS) {
    const row = checkRows.find(r => r.check_number === c.number);
    const done = row ? row.done : 0;
    const remaining = totalActive - done;
    checks[c.number] = { name: c.name, remaining, allPass: remaining === 0 };
  }

  const data = {
    exportedAt: new Date().toISOString(),
    totalPages,
    fullyPassed,
    fullyReviewedWithFailures,
    unreviewed,
    thisWeek,
    thisMonth,
    today,
    dailyGoal: DAILY_GOAL,
    behindThisWeek,
    checks,
  };

  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Exported dashboard data to ${outPath}`);
  closeDb();
}
