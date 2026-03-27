import { getDb, closeDb } from '../db.js';
import { fetchPage, releasePage, closeBrowser } from './page-fetcher.js';
import { runAllChecks } from '../checks/index.js';
import { CHECKS, CONCURRENCY, PAGE_DELAY_MS } from '../config.js';

interface BatchOptions {
  site?: string;
  limit?: number;
  unauditedOnly?: boolean;
}

interface BatchStats {
  pagesTotal: number;
  pagesDone: number;
  passed: number;
  failed: number;
  review: number;
  na: number;
  errors: number;
  cancelled: boolean;
}

/**
 * Runs automated audits on multiple pages concurrently.
 * Supports graceful shutdown via Ctrl+C — saves all completed results.
 */
export async function runBatch(options: BatchOptions = {}): Promise<BatchStats> {
  const db = getDb();
  let cancelled = false;

  // Handle graceful shutdown
  const onSignal = () => {
    if (cancelled) {
      console.log('\nForce quit. Saving what we have...');
      process.exit(1);
    }
    cancelled = true;
    console.log('\n\nGraceful shutdown requested — finishing current pages...');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Get pages to audit
  let sql: string;
  const params: any[] = [];

  if (options.unauditedOnly) {
    sql = `
      SELECT p.id, p.page_name, p.url, p.site FROM pages p
      WHERE p.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM audit_results ar WHERE ar.page_id = p.id
        AND ar.run_id != 'excel-import' AND ar.run_id != 'excel-auditdb-import'
      )
    `;
  } else {
    sql = 'SELECT id, page_name, url, site FROM pages WHERE active = 1';
  }

  if (options.site) {
    sql += ` AND ${options.unauditedOnly ? 'p.' : ''}site = ?`;
    params.push(options.site);
  }

  sql += ` ORDER BY ${options.unauditedOnly ? 'p.' : ''}site, ${options.unauditedOnly ? 'p.' : ''}page_name`;

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const pages = db.prepare(sql).all(...params) as Array<{ id: number; page_name: string; url: string; site: string }>;

  if (pages.length === 0) {
    console.log('No pages to audit.');
    return { pagesTotal: 0, pagesDone: 0, passed: 0, failed: 0, review: 0, na: 0, errors: 0, cancelled: false };
  }

  // Create audit run
  const runId = `run-${Date.now()}`;
  db.prepare(`
    INSERT INTO audit_runs (id, started_at, pages_total, status)
    VALUES (?, datetime('now'), ?, 'running')
  `).run(runId, pages.length);

  const insertResult = db.prepare(`
    INSERT OR REPLACE INTO audit_results
    (page_id, check_number, check_name, status, severity, auto_result, notes, remediation, axe_violations, audited_by, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)
  `);

  const insertManual = db.prepare(`
    INSERT OR REPLACE INTO manual_queue (page_id, check_number, reason, priority)
    VALUES (?, ?, ?, ?)
  `);

  const stats: BatchStats = {
    pagesTotal: pages.length,
    pagesDone: 0,
    passed: 0,
    failed: 0,
    review: 0,
    na: 0,
    errors: 0,
    cancelled: false,
  };

  console.log(`\n=== DOJ WebRule Audit — Batch Run ===`);
  console.log(`Pages: ${pages.length} | Concurrency: ${CONCURRENCY} | Run: ${runId}\n`);

  // Process pages with concurrency limit
  let pageIndex = 0;

  async function processNext(): Promise<void> {
    while (pageIndex < pages.length && !cancelled) {
      const idx = pageIndex++;
      const pageInfo = pages[idx];
      const pageNum = idx + 1;

      process.stdout.write(`[${pageNum}/${pages.length}] ${pageInfo.page_name || pageInfo.url}... `);

      // Small delay between requests to be respectful
      if (idx > 0) await sleep(PAGE_DELAY_MS);

      const fetched = await fetchPage(pageInfo.url);

      if (fetched.error) {
        console.log(`ERROR (${fetched.loadTimeMs}ms): ${fetched.error}`);
        for (const check of CHECKS) {
          insertResult.run(
            pageInfo.id, check.number, check.name, 'error', null, 'error',
            `Page load failed: ${fetched.error}`, '', '[]', runId
          );
        }
        await releasePage(fetched);
        stats.errors += 15;
        stats.pagesDone++;
        continue;
      }

      try {
        const results = await runAllChecks(fetched.page, pageInfo.url);

        for (const r of results) {
          insertResult.run(
            pageInfo.id, r.checkNumber, r.checkName, r.status, r.severity, r.status,
            r.notes, r.remediation, r.axeViolations, runId
          );

          if (r.needsManualReview) {
            insertManual.run(
              pageInfo.id, r.checkNumber,
              r.manualReason || 'Auto-audit flagged for manual review',
              r.status === 'fail' ? 'high' : 'normal'
            );
          }

          switch (r.status) {
            case 'pass': stats.passed++; break;
            case 'fail': stats.failed++; break;
            case 'needs-review': stats.review++; break;
            case 'n/a': stats.na++; break;
            case 'error': stats.errors++; break;
          }
        }

        const p = results.filter(r => r.status === 'pass').length;
        const f = results.filter(r => r.status === 'fail').length;
        const rv = results.filter(r => r.status === 'needs-review').length;
        console.log(`✓ ${p} pass, ${f} fail, ${rv} review (${fetched.loadTimeMs}ms)`);
      } catch (err) {
        console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
        stats.errors++;
      }

      await releasePage(fetched);
      stats.pagesDone++;

      db.prepare('UPDATE audit_runs SET pages_done = ? WHERE id = ?').run(stats.pagesDone, runId);
    }
  }

  // Launch concurrent workers
  const workers = Array.from({ length: Math.min(CONCURRENCY, pages.length) }, () => processNext());
  await Promise.all(workers);

  stats.cancelled = cancelled;

  // Finish run
  db.prepare(`
    UPDATE audit_runs SET finished_at = datetime('now'), status = ?, notes = ? WHERE id = ?
  `).run(
    cancelled ? 'cancelled' : 'completed',
    cancelled ? `Cancelled after ${stats.pagesDone} pages` : null,
    runId
  );

  // Update daily progress
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT INTO daily_progress (date, pages_auto, auto_passed, auto_failed, auto_review)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      pages_auto = pages_auto + excluded.pages_auto,
      auto_passed = auto_passed + excluded.auto_passed,
      auto_failed = auto_failed + excluded.auto_failed,
      auto_review = auto_review + excluded.auto_review
  `).run(today, stats.pagesDone, stats.passed, stats.failed, stats.review);

  // Cleanup
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  return stats;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
