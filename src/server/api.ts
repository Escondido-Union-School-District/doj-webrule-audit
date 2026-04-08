import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { CHECKS } from '../config.js';

export const apiRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/pages — paginated page list with all 15 check results
// ---------------------------------------------------------------------------
apiRouter.get('/pages', (req: Request, res: Response) => {
  const db = getDb();

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage as string) || 25));
  const statusFilter = (req.query.status as string) || '';
  const siteFilter = (req.query.site as string) || '';
  const checkFilter = parseInt(req.query.check as string) || 0;
  const search = (req.query.search as string) || '';

  // Latest run ID excluding excel imports
  const latestRun = db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' ORDER BY started_at DESC LIMIT 1`
  ).get() as { id: string } | undefined;

  const runId = latestRun?.id ?? null;

  // Build WHERE clauses for page-level filtering
  const whereClauses: string[] = ['p.active = 1'];
  const params: (string | number)[] = [];

  if (siteFilter) {
    whereClauses.push('p.site = ?');
    params.push(siteFilter);
  }
  if (search) {
    whereClauses.push('(p.page_name LIKE ? OR p.url LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  // If filtering by status or check, we need to join audit_results for filtering
  if (runId && (statusFilter || checkFilter)) {
    // Subquery to find page IDs matching the filter
    const subWhere: string[] = ['ar.run_id = ?'];
    const subParams: (string | number)[] = [runId];

    if (checkFilter) {
      subWhere.push('ar.check_number = ?');
      subParams.push(checkFilter);
    }
    if (statusFilter === 'unreviewed') {
      subWhere.push(`(COALESCE(ar.manual_override, ar.status) = 'needs-review' OR COALESCE(ar.manual_override, ar.status) IS NULL)`);
    } else if (statusFilter) {
      subWhere.push('COALESCE(ar.manual_override, ar.status) = ?');
      subParams.push(statusFilter);
    }

    whereClauses.push(`p.id IN (SELECT ar.page_id FROM audit_results ar WHERE ${subWhere.join(' AND ')})`);
    params.push(...subParams);
  }
  // Handle 'unreviewed' status when there's no run (pages with no results at all)
  if (!runId && statusFilter === 'unreviewed') {
    // All pages are unreviewed if there's no run
  } else if (!runId && statusFilter) {
    // No run exists, so no pages can match pass/fail
    res.json({ pages: [], pagination: { page, perPage, total: 0, totalPages: 0 } });
    return;
  }

  const whereSQL = whereClauses.join(' AND ');

  // Count total matching pages
  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM pages p WHERE ${whereSQL}`
  ).get(...params) as { total: number };

  const total = countRow.total;
  const totalPages = Math.ceil(total / perPage);
  const offset = (page - 1) * perPage;

  // Fetch page rows
  const pageRows = db.prepare(
    `SELECT p.id, p.page_name, p.url, p.site FROM pages p WHERE ${whereSQL} ORDER BY p.site, p.page_name LIMIT ? OFFSET ?`
  ).all(...params, perPage, offset) as Array<{ id: number; page_name: string; url: string; site: string }>;

  // Fetch check results for these pages
  const pageIds = pageRows.map(r => r.id);
  let resultsByPage: Map<number, Map<number, { status: string; notes: string | null }>> = new Map();

  if (runId && pageIds.length > 0) {
    const placeholders = pageIds.map(() => '?').join(',');
    const results = db.prepare(
      `SELECT page_id, check_number, COALESCE(manual_override, status) as effective_status, notes
       FROM audit_results
       WHERE run_id = ? AND page_id IN (${placeholders})`
    ).all(runId, ...pageIds) as Array<{ page_id: number; check_number: number; effective_status: string; notes: string | null }>;

    for (const r of results) {
      if (!resultsByPage.has(r.page_id)) resultsByPage.set(r.page_id, new Map());
      resultsByPage.get(r.page_id)!.set(r.check_number, {
        status: r.effective_status === 'needs-review' ? 'unreviewed' : r.effective_status,
        notes: r.notes,
      });
    }
  }

  // Build response
  const pages = pageRows.map(p => {
    const checksMap = resultsByPage.get(p.id) || new Map();
    const checks: Record<number, { status: string; notes: string | null }> = {};
    for (let i = 1; i <= 15; i++) {
      checks[i] = checksMap.get(i) || { status: 'unreviewed', notes: null };
    }
    return {
      id: p.id,
      pageName: p.page_name,
      url: p.url,
      site: p.site,
      checks,
    };
  });

  res.json({
    pages,
    pagination: { page, perPage, total, totalPages },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/results/:pageId/:checkNumber — update a single check result
// ---------------------------------------------------------------------------
apiRouter.patch('/results/:pageId/:checkNumber', (req: Request, res: Response) => {
  const db = getDb();
  const pageId = parseInt(req.params.pageId);
  const checkNumber = parseInt(req.params.checkNumber);
  const { status, notes } = req.body as { status: string; notes?: string };

  if (!status || !['pass', 'fail', 'needs-review', 'n/a'].includes(status)) {
    res.status(400).json({ error: 'Invalid status. Must be pass, fail, needs-review, or n/a.' });
    return;
  }
  if (checkNumber < 1 || checkNumber > 15) {
    res.status(400).json({ error: 'Check number must be 1-15.' });
    return;
  }

  const checkDef = CHECKS.find(c => c.number === checkNumber);
  const checkName = checkDef?.name ?? `CHECK ${checkNumber}`;

  // Get latest non-excel run
  const latestRun = db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' ORDER BY started_at DESC LIMIT 1`
  ).get() as { id: string } | undefined;

  if (!latestRun) {
    res.status(404).json({ error: 'No audit run found.' });
    return;
  }

  // Upsert: try update first, then insert
  const existing = db.prepare(
    `SELECT id FROM audit_results WHERE page_id = ? AND check_number = ? AND run_id = ?`
  ).get(pageId, checkNumber, latestRun.id) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE audit_results
       SET manual_override = ?, status = ?, notes = ?, audited_by = 'manual', audit_date = datetime('now')
       WHERE id = ?`
    ).run(status, status, notes ?? null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO audit_results (page_id, check_number, check_name, status, manual_override, notes, audited_by, audit_date, run_id)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', datetime('now'), ?)`
    ).run(pageId, checkNumber, checkName, status, status, notes ?? null, latestRun.id);
  }

  // Update manual_queue if pending entry exists
  db.prepare(
    `UPDATE manual_queue SET status = 'done', reviewer = 'web-ui', reviewed_at = datetime('now'), result = ?, notes = ?
     WHERE page_id = ? AND check_number = ? AND status = 'pending'`
  ).run(status, notes ?? null, pageId, checkNumber);

  const displayStatus = status === 'needs-review' ? 'unreviewed' : status;
  res.json({ ok: true, pageId, checkNumber, status: displayStatus, notes: notes ?? null });
});

// ---------------------------------------------------------------------------
// POST /api/results/:pageId/pass-all — pass all unreviewed/missing checks
// ---------------------------------------------------------------------------
apiRouter.post('/results/:pageId/pass-all', (req: Request, res: Response) => {
  const db = getDb();
  const pageId = parseInt(req.params.pageId);

  const latestRun = db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' ORDER BY started_at DESC LIMIT 1`
  ).get() as { id: string } | undefined;

  if (!latestRun) {
    res.status(404).json({ error: 'No audit run found.' });
    return;
  }

  // Get existing results for this page
  const existingResults = db.prepare(
    `SELECT check_number, COALESCE(manual_override, status) as effective_status
     FROM audit_results WHERE page_id = ? AND run_id = ?`
  ).all(pageId, latestRun.id) as Array<{ check_number: number; effective_status: string }>;

  const existingByCheck = new Map(existingResults.map(r => [r.check_number, r.effective_status]));

  const updated: number[] = [];

  const updateStmt = db.prepare(
    `UPDATE audit_results
     SET manual_override = 'pass', status = 'pass', notes = NULL, audited_by = 'manual-batch', audit_date = datetime('now')
     WHERE page_id = ? AND check_number = ? AND run_id = ?`
  );
  const insertStmt = db.prepare(
    `INSERT INTO audit_results (page_id, check_number, check_name, status, manual_override, audited_by, audit_date, run_id)
     VALUES (?, ?, ?, 'pass', 'pass', 'manual-batch', datetime('now'), ?)`
  );

  const batchTransaction = db.transaction(() => {
    for (let i = 1; i <= 15; i++) {
      const existing = existingByCheck.get(i);
      // Skip if already pass or fail
      if (existing === 'pass' || existing === 'fail') continue;

      const checkDef = CHECKS.find(c => c.number === i);
      const checkName = checkDef?.name ?? `CHECK ${i}`;

      if (existing) {
        // Row exists but is needs-review/n/a/error — update it
        updateStmt.run(pageId, i, latestRun.id);
      } else {
        // No row — insert
        insertStmt.run(pageId, i, checkName, latestRun.id);
      }
      updated.push(i);
    }

    // Mark any pending manual_queue entries as done
    db.prepare(
      `UPDATE manual_queue SET status = 'done', reviewer = 'web-ui', reviewed_at = datetime('now'), result = 'pass'
       WHERE page_id = ? AND status = 'pending'`
    ).run(pageId);
  });

  batchTransaction();

  // Return updated check states
  const allResults = db.prepare(
    `SELECT check_number, COALESCE(manual_override, status) as effective_status, notes
     FROM audit_results WHERE page_id = ? AND run_id = ?`
  ).all(pageId, latestRun.id) as Array<{ check_number: number; effective_status: string; notes: string | null }>;

  const checks: Record<number, { status: string; notes: string | null }> = {};
  for (let i = 1; i <= 15; i++) {
    const r = allResults.find(r => r.check_number === i);
    checks[i] = r
      ? { status: r.effective_status === 'needs-review' ? 'unreviewed' : r.effective_status, notes: r.notes }
      : { status: 'unreviewed', notes: null };
  }

  res.json({ ok: true, pageId, updated, checks });
});

// ---------------------------------------------------------------------------
// GET /api/filters — available filter options
// ---------------------------------------------------------------------------
apiRouter.get('/filters', (_req: Request, res: Response) => {
  const db = getDb();

  const sites = db.prepare(
    `SELECT DISTINCT site FROM pages WHERE active = 1 ORDER BY site`
  ).all() as Array<{ site: string }>;

  res.json({
    sites: sites.map(s => s.site),
    checks: CHECKS.map(c => ({ number: c.number, name: c.name, autoLevel: c.autoLevel })),
    statuses: ['unreviewed', 'pass', 'fail'],
  });
});
