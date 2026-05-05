// Regenerate docs/data.json and push to origin if it changed.
//
// Run from the daily backup scheduled task (3 AM) so the GitHub Pages
// dashboard at escondido-union-school-district.github.io/doj-webrule-audit/
// reflects current progress every morning.
//
// Idempotent: exits 0 silently if data.json didn't change. Exits 0 with a
// "skipped" message if there are unrelated dirty files in the working tree
// (we only ever commit docs/data.json — never sweep unrelated edits).

import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exportSite } from '../src/reports/export-site.js';
import { closeDb } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DATA_FILE = 'docs/data.json';

function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function log(msg: string) {
  console.log(`[publish-dashboard ${new Date().toISOString()}] ${msg}`);
}

function main() {
  log('Regenerating docs/data.json...');
  try {
    exportSite();
    closeDb();
  } catch (err) {
    log(`export-site failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Has docs/data.json meaningfully changed? export-site updates exportedAt
  // every run; ignore changes that are only that line.
  const diff = run('git', ['diff', '--unified=0', '--', DATA_FILE]);
  if (diff.code !== 0 && !diff.stdout) {
    log(`git diff failed: ${diff.stderr}`);
    process.exit(1);
  }
  const meaningfulLines = diff.stdout.split('\n').filter(line => {
    // skip diff headers
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@ ')) return false;
    if (line.startsWith('---') || line.startsWith('+++')) return false;
    // only care about actual change lines
    if (!line.startsWith('-') && !line.startsWith('+')) return false;
    // ignore the timestamp churn
    if (/"exportedAt"\s*:/.test(line)) return false;
    return true;
  });
  if (meaningfulLines.length === 0) {
    log('No meaningful change in docs/data.json (only exportedAt churned) — skipping commit.');
    // Reset the working-tree change so the file doesn't sit dirty.
    run('git', ['checkout', '--', DATA_FILE]);
    return;
  }

  // Make sure no unrelated files are about to be swept up. We only stage
  // docs/data.json, but be defensive: check that DATA_FILE isn't already
  // staged with extra paths.
  const staged = run('git', ['diff', '--cached', '--name-only']);
  if (staged.stdout && !staged.stdout.split('\n').every(p => p === DATA_FILE)) {
    log(`Aborting: extra files already staged (${staged.stdout}). Manual intervention needed.`);
    process.exit(2);
  }

  // Stage and commit only the dashboard data file.
  const add = run('git', ['add', DATA_FILE]);
  if (add.code !== 0) { log(`git add failed: ${add.stderr}`); process.exit(1); }

  const date = new Date().toISOString().slice(0, 10);
  const commitMsg = `Auto-refresh dashboard data ${date}`;
  const commit = run('git', ['commit', '-m', commitMsg]);
  if (commit.code !== 0) {
    // Race: another process committed it between our diff check and now
    if (/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      log('Race: nothing staged at commit time — fine.');
      return;
    }
    log(`git commit failed:\n${commit.stdout}\n${commit.stderr}`);
    process.exit(1);
  }
  log(`Committed: ${commitMsg}`);

  const push = run('git', ['push', 'origin', 'main']);
  if (push.code !== 0) {
    log(`git push failed (commit is local; will push next run):\n${push.stdout}\n${push.stderr}`);
    process.exit(1);
  }
  log('Pushed to origin/main. Pages site rebuilds in 1-2 min.');
}

main();
