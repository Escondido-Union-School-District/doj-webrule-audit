import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { DB_PATH } from './config.js';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      site            TEXT NOT NULL,
      page_name       TEXT NOT NULL,
      url             TEXT NOT NULL UNIQUE,
      priority        INTEGER DEFAULT 0,
      template_variant TEXT,
      discovered_at   TEXT DEFAULT (datetime('now')),
      source          TEXT DEFAULT 'import',
      active          INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS audit_runs (
      id          TEXT PRIMARY KEY,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      pages_total INTEGER,
      pages_done  INTEGER DEFAULT 0,
      status      TEXT DEFAULT 'running',
      notes       TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id         INTEGER NOT NULL REFERENCES pages(id),
      check_number    INTEGER NOT NULL,
      check_name      TEXT NOT NULL,
      status          TEXT NOT NULL,
      severity        TEXT,
      auto_result     TEXT,
      manual_override TEXT,
      notes           TEXT,
      remediation     TEXT,
      axe_violations  TEXT,
      audited_by      TEXT DEFAULT 'auto',
      audit_date      TEXT DEFAULT (datetime('now')),
      run_id          TEXT NOT NULL REFERENCES audit_runs(id),
      UNIQUE(page_id, check_number, run_id)
    );

    CREATE TABLE IF NOT EXISTS manual_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id      INTEGER NOT NULL REFERENCES pages(id),
      check_number INTEGER NOT NULL,
      reason       TEXT NOT NULL,
      priority     TEXT DEFAULT 'normal',
      status       TEXT DEFAULT 'pending',
      reviewer     TEXT,
      reviewed_at  TEXT,
      result       TEXT,
      notes        TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(page_id, check_number)
    );

    CREATE TABLE IF NOT EXISTS import_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL,
      imported_at   TEXT DEFAULT (datetime('now')),
      rows_imported INTEGER,
      notes         TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      target_date     TEXT NOT NULL,
      daily_quota     INTEGER NOT NULL,
      pages_per_week  INTEGER NOT NULL,
      created_at      TEXT DEFAULT (datetime('now')),
      active          INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS daily_progress (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT NOT NULL UNIQUE,
      pages_auto      INTEGER DEFAULT 0,
      pages_manual    INTEGER DEFAULT 0,
      auto_passed     INTEGER DEFAULT 0,
      auto_failed     INTEGER DEFAULT 0,
      auto_review     INTEGER DEFAULT 0,
      manual_done     INTEGER DEFAULT 0,
      notes           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_results_page ON audit_results(page_id);
    CREATE INDEX IF NOT EXISTS idx_results_status ON audit_results(status);
    CREATE INDEX IF NOT EXISTS idx_results_run ON audit_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_results_check ON audit_results(check_number);
    CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site);
    CREATE INDEX IF NOT EXISTS idx_pages_active ON pages(active);
    CREATE INDEX IF NOT EXISTS idx_manual_status ON manual_queue(status);
    CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_progress(date);
  `);
}

// Helper: get summary stats
export function getStats(db: Database.Database) {
  const totalPages = db.prepare('SELECT COUNT(*) as count FROM pages WHERE active = 1').get() as { count: number };

  const latestRun = db.prepare(
    'SELECT id FROM audit_runs ORDER BY started_at DESC LIMIT 1'
  ).get() as { id: string } | undefined;

  if (!latestRun) {
    return {
      totalPages: totalPages.count,
      pagesAudited: 0,
      totalChecks: 0,
      passed: 0,
      failed: 0,
      needsReview: 0,
      notApplicable: 0,
      pending: totalPages.count * 15,
    };
  }

  const results = db.prepare(`
    SELECT
      COUNT(DISTINCT page_id) as pagesAudited,
      COUNT(*) as totalChecks,
      SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'needs-review' THEN 1 ELSE 0 END) as needsReview,
      SUM(CASE WHEN status = 'n/a' THEN 1 ELSE 0 END) as notApplicable
    FROM audit_results
    WHERE run_id = ?
  `).get(latestRun.id) as {
    pagesAudited: number;
    totalChecks: number;
    passed: number;
    failed: number;
    needsReview: number;
    notApplicable: number;
  };

  return {
    totalPages: totalPages.count,
    ...results,
    pending: (totalPages.count * 15) - results.totalChecks,
  };
}

// Helper: get pages needing manual review
export function getManualQueue(db: Database.Database, filters?: { checkNumber?: number; site?: string }) {
  let sql = `
    SELECT mq.*, p.page_name, p.url, p.site
    FROM manual_queue mq
    JOIN pages p ON p.id = mq.page_id
    WHERE mq.status = 'pending'
  `;
  const params: (string | number)[] = [];

  if (filters?.checkNumber) {
    sql += ' AND mq.check_number = ?';
    params.push(filters.checkNumber);
  }
  if (filters?.site) {
    sql += ' AND p.site = ?';
    params.push(filters.site);
  }

  sql += ' ORDER BY mq.priority DESC, mq.check_number, p.page_name';
  return db.prepare(sql).all(...params);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
