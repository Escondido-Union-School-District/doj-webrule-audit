// Daily backup of data/audit.db.
//
// Writes a date-stamped snapshot to two locations:
//   1. data/backups/                                     (last 30 days kept)
//   2. G:/My Drive/DOJ Audit Tool — DB Backups/db-backups/  (last 90 days kept)
//
// Uses better-sqlite3's .backup() API rather than a raw file copy. The .backup()
// method takes a consistent snapshot even while the DB is being written to,
// which means it's safe to run while the Review UI server is up.
//
// Run manually: npm run backup
// Run from a Windows scheduled task: see scripts/register-backup-task.ps1
//
// Exit codes:
//   0 = both backups succeeded
//   1 = local backup failed (treated as fatal — at least the local copy must exist)
//   2 = local OK but offsite (Drive) failed (warning, not fatal)

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const SOURCE_DB = resolve(PROJECT_ROOT, 'data', 'audit.db');
const LOCAL_BACKUP_DIR = resolve(PROJECT_ROOT, 'data', 'backups');
const DRIVE_BACKUP_DIR = 'G:/My Drive/DOJ Audit Tool — DB Backups/db-backups';
const LOCAL_RETENTION_DAYS = 30;
const DRIVE_RETENTION_DAYS = 90;

const dateStr = new Date().toISOString().slice(0, 10);
const fileName = `audit-${dateStr}.db`;

function logSize(label: string, path: string) {
  if (!existsSync(path)) {
    console.log(`  ${label.padEnd(10)} (missing)`);
    return;
  }
  const bytes = statSync(path).size;
  const mb = (bytes / 1024 / 1024).toFixed(2);
  console.log(`  ${label.padEnd(10)} ${mb} MB  ${path}`);
}

async function writeBackup(targetDir: string): Promise<string> {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, fileName);
  const db = new Database(SOURCE_DB, { readonly: true });
  try {
    await db.backup(targetPath);
  } finally {
    db.close();
  }
  return targetPath;
}

function pruneOldBackups(dir: string, retentionDays: number): number {
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = readdirSync(dir).filter(f => /^audit-\d{4}-\d{2}-\d{2}.*\.db$/.test(f));
  let deleted = 0;
  for (const f of files) {
    const full = join(dir, f);
    try {
      const mtime = statSync(full).mtimeMs;
      if (mtime < cutoff) {
        unlinkSync(full);
        deleted++;
      }
    } catch (err) {
      console.warn(`  pruning ${f} failed: ${(err as Error).message}`);
    }
  }
  return deleted;
}

async function main() {
  console.log(`\n=== DOJ Audit DB Backup — ${new Date().toISOString()} ===\n`);
  logSize('Source:', SOURCE_DB);

  if (!existsSync(SOURCE_DB)) {
    console.error('\n✗ Source DB does not exist. Aborting.');
    process.exit(1);
  }

  // 1. Local backup (fatal if it fails)
  let localPath: string;
  try {
    localPath = await writeBackup(LOCAL_BACKUP_DIR);
    logSize('Local:', localPath);
  } catch (err) {
    console.error(`\n✗ Local backup FAILED: ${(err as Error).message}`);
    process.exit(1);
  }

  const localPruned = pruneOldBackups(LOCAL_BACKUP_DIR, LOCAL_RETENTION_DAYS);
  if (localPruned > 0) console.log(`  Pruned ${localPruned} local backup(s) older than ${LOCAL_RETENTION_DAYS} days`);

  // 2. Drive backup (warning if it fails — local copy is good enough)
  let driveOk = true;
  if (!existsSync(dirname(DRIVE_BACKUP_DIR))) {
    console.warn(`\n⚠ Drive parent path not found: ${dirname(DRIVE_BACKUP_DIR)}`);
    console.warn('  Skipping offsite backup. Local copy is in place.');
    driveOk = false;
  } else {
    try {
      const drivePath = await writeBackup(DRIVE_BACKUP_DIR);
      logSize('Drive:', drivePath);
      const drivePruned = pruneOldBackups(DRIVE_BACKUP_DIR, DRIVE_RETENTION_DAYS);
      if (drivePruned > 0) console.log(`  Pruned ${drivePruned} drive backup(s) older than ${DRIVE_RETENTION_DAYS} days`);
    } catch (err) {
      console.error(`\n⚠ Drive backup FAILED: ${(err as Error).message}`);
      console.error('  Local backup is still in place.');
      driveOk = false;
    }
  }

  // Verify the local backup is readable and has the expected tables
  try {
    const verify = new Database(localPath, { readonly: true });
    const auditCount = (verify.prepare('SELECT COUNT(*) as c FROM audit_results').get() as { c: number }).c;
    const pageCount = (verify.prepare('SELECT COUNT(*) as c FROM pages WHERE active = 1').get() as { c: number }).c;
    verify.close();
    console.log(`\n✓ Backup verified: ${auditCount} audit_results rows, ${pageCount} active pages`);
  } catch (err) {
    console.error(`\n✗ Local backup verification FAILED: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!driveOk) {
    console.log('\nDone (local OK, drive skipped/failed).\n');
    process.exit(2);
  }
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Backup script crashed:', err);
  process.exit(1);
});
