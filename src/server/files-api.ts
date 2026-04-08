import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';

export const filesRouter = Router();

// GET /api/files — paginated linked files with filters
filesRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage as string) || 25));
  const statusFilter = req.query.status as string || '';
  const pageIdFilter = parseInt(req.query.pageId as string) || 0;
  const search = (req.query.search as string || '').trim();

  const wheres: string[] = ['p.active = 1'];
  const params: (string | number)[] = [];

  if (statusFilter) {
    wheres.push('lf.status = ?');
    params.push(statusFilter);
  }
  if (pageIdFilter) {
    wheres.push('lf.page_id = ?');
    params.push(pageIdFilter);
  }
  if (search) {
    wheres.push('(lf.file_url LIKE ? OR lf.link_text LIKE ? OR p.page_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereClause = wheres.length ? ' WHERE ' + wheres.join(' AND ') : '';

  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM linked_files lf JOIN pages p ON p.id = lf.page_id ${whereClause}`
  ).get(...params) as any).c;

  const offset = (page - 1) * perPage;
  const files = db.prepare(`
    SELECT lf.*, p.page_name, p.url as page_url
    FROM linked_files lf
    JOIN pages p ON p.id = lf.page_id
    ${whereClause}
    ORDER BY lf.status = 'unreviewed' DESC, p.page_name, lf.id
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset) as any[];

  res.json({
    files: files.map(f => ({
      id: f.id,
      pageId: f.page_id,
      pageName: f.page_name,
      pageUrl: f.page_url,
      fileUrl: f.file_url,
      linkText: f.link_text,
      fileType: f.file_type,
      status: f.status,
      notes: f.notes,
    })),
    pagination: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
  });
});

// GET /api/files/stats — progress stats
filesRouter.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();

  const total = (db.prepare(
    'SELECT COUNT(*) as c FROM linked_files lf JOIN pages p ON p.id = lf.page_id AND p.active = 1'
  ).get() as any).c;

  const byStatus = db.prepare(`
    SELECT lf.status, COUNT(*) as c
    FROM linked_files lf JOIN pages p ON p.id = lf.page_id AND p.active = 1
    GROUP BY lf.status
  `).all() as Array<{ status: string; c: number }>;

  const statusMap: Record<string, number> = { unreviewed: 0, pass: 0, fail: 0 };
  for (const s of byStatus) statusMap[s.status] = s.c;

  // Pages with all files passing
  const pagesAllPass = (db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT lf.page_id
      FROM linked_files lf JOIN pages p ON p.id = lf.page_id AND p.active = 1
      GROUP BY lf.page_id
      HAVING SUM(CASE WHEN lf.status = 'pass' THEN 1 ELSE 0 END) = COUNT(*)
    )
  `).get() as any).c;

  const pagesWithFiles = (db.prepare(`
    SELECT COUNT(DISTINCT lf.page_id) as c
    FROM linked_files lf JOIN pages p ON p.id = lf.page_id AND p.active = 1
  `).get() as any).c;

  res.json({ total, ...statusMap, pagesAllPass, pagesWithFiles });
});

// PATCH /api/files/:id — update a file's status/notes
filesRouter.patch('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const { status, notes } = req.body;

  db.prepare(`
    UPDATE linked_files SET status = ?, notes = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(status, notes ?? null, id);

  // Check if all files on this page now pass — if so, auto-pass check 14
  const file = db.prepare('SELECT page_id FROM linked_files WHERE id = ?').get(id) as any;
  if (file) {
    rollupCheck14(db, file.page_id);
  }

  res.json({ ok: true });
});

// POST /api/files/:pageId/pass-all — pass all unreviewed files for a page
filesRouter.post('/:pageId/pass-all', (req: Request, res: Response) => {
  const db = getDb();
  const pageId = parseInt(req.params.pageId, 10);

  db.prepare(`
    UPDATE linked_files SET status = 'pass', reviewed_at = datetime('now')
    WHERE page_id = ? AND status = 'unreviewed'
  `).run(pageId);

  rollupCheck14(db, pageId);

  const files = db.prepare('SELECT id, status, notes FROM linked_files WHERE page_id = ?').all(pageId);
  res.json({ ok: true, files });
});

function rollupCheck14(db: any, pageId: number) {
  const fileCounts = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failed
    FROM linked_files WHERE page_id = ?
  `).get(pageId) as { total: number; passed: number; failed: number };

  if (fileCounts.total === 0) return;

  const runId = (db.prepare(
    `SELECT id FROM audit_runs WHERE id NOT LIKE 'excel%' ORDER BY pages_total DESC, started_at DESC LIMIT 1`
  ).get() as any)?.id;

  if (!runId) return;

  let newStatus: string;
  if (fileCounts.passed === fileCounts.total) {
    newStatus = 'pass';
  } else if (fileCounts.failed > 0) {
    newStatus = 'fail';
  } else {
    newStatus = 'needs-review';
  }

  db.prepare(`
    UPDATE audit_results SET status = ?, manual_override = ?, audited_by = 'file-rollup', audit_date = datetime('now')
    WHERE page_id = ? AND check_number = 14 AND run_id = ?
  `).run(newStatus, newStatus, pageId, runId);
}
