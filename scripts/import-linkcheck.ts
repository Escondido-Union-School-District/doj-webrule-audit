// Import pages from the eusd-linkcheck project's pages-index CSV.
//
// Why this exists: the EUSD linkcheck project crawls all 26 EUSD subdomains
// regularly and writes a fresh pages-index-<timestamp>.csv. Rather than
// duplicating that crawl with our own discover, we read its output and
// register any new pages in our audit DB.
//
// Behavior:
//   1. Locate the latest pages-index-*.csv (or use --file <path>).
//   2. For each row, canonicalize the URL to the form already in our DB
//      (www.eusd.org/o/<sitekey>/<path>), apply EXCLUDED_URL_PATTERNS,
//      and INSERT OR IGNORE — existing rows (with their manual reviews)
//      are NEVER touched.
//   3. Print a summary grouped by site: how many new, how many already
//      existed, how many excluded, how many couldn't be mapped.
//
// Safety:
//   - INSERT OR IGNORE keys on the unique `url` column. Existing pages keep
//     their `id`, `active`, `priority`, `source`, and all linked
//     audit_results / manual_queue rows.
//   - Defaults to DRY RUN — no DB writes happen unless you pass --apply.
//   - source='linkcheck-import' on new rows so they're traceable.
//
// Run: npm run import-linkcheck             # dry run, prints summary
//      npm run import-linkcheck -- --apply  # actually inserts new pages
//      npm run import-linkcheck -- --file <path>  # explicit CSV

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SITE_ORIGINS, EXCLUDED_URL_PATTERNS, DB_PATH } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

const LINKCHECK_OUTPUT_ROOT = 'C:/Users/mberning/projects/eusd/eusd-linkcheck/output';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fileIdx = args.indexOf('--file');
const fileArg = fileIdx >= 0 ? args[fileIdx + 1] : undefined;

function findLatestCsv(): string {
  if (!existsSync(LINKCHECK_OUTPUT_ROOT)) {
    throw new Error(`Linkcheck output dir not found: ${LINKCHECK_OUTPUT_ROOT}`);
  }
  const yearDirs = readdirSync(LINKCHECK_OUTPUT_ROOT)
    .filter(d => /^\d{4}$/.test(d))
    .sort()
    .reverse();
  for (const year of yearDirs) {
    const yearPath = join(LINKCHECK_OUTPUT_ROOT, year);
    if (!statSync(yearPath).isDirectory()) continue;
    const monthDirs = readdirSync(yearPath).sort().reverse();
    for (const month of monthDirs) {
      const monthPath = join(yearPath, month);
      if (!statSync(monthPath).isDirectory()) continue;
      const files = readdirSync(monthPath)
        .filter(f => f.startsWith('pages-index-') && f.endsWith('.csv'))
        .sort()
        .reverse();
      if (files.length > 0) return join(monthPath, files[0]);
    }
  }
  throw new Error('No pages-index-*.csv found under ' + LINKCHECK_OUTPUT_ROOT);
}

// Simple CSV line parser supporting quoted fields with escaped quotes.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// hostname → audit site key (e.g., 'farr.eusd.org' → 'farravenue')
const HOSTNAME_TO_SITE: Record<string, string> = {};
for (const [key, url] of Object.entries(SITE_ORIGINS)) {
  HOSTNAME_TO_SITE[new URL(url).hostname] = key;
}

interface CanonResult { url: string; site: string; }

// Resolve a discovered URL to the canonical form used in our DB.
// Returns null if the URL doesn't belong to a known site.
function canonicalize(rawUrl: string): CanonResult | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }

  const host = u.hostname.toLowerCase();
  let path = u.pathname;
  const search = u.search; // keep query string (callers may exclude via patterns)

  // Strip a leading /o/<slug>/ — it's the redundant Apptegy alias path on
  // a school's own subdomain or on www.
  let oSlug: string | null = null;
  const oMatch = path.match(/^\/o\/([^/]+)(\/.*)?$/);
  if (oMatch) {
    oSlug = oMatch[1].toLowerCase();
    path = oMatch[2] ?? '';
  }

  // Determine site key.
  let site: string | undefined;

  if (host === 'www.eusd.org') {
    if (oSlug) {
      // /o/<slug>/... — slug should match an audit site key directly,
      // or map via the slug's own subdomain (e.g., 'farr' → farravenue).
      if (oSlug in SITE_ORIGINS) {
        site = oSlug;
      } else if (HOSTNAME_TO_SITE[`${oSlug}.eusd.org`]) {
        site = HOSTNAME_TO_SITE[`${oSlug}.eusd.org`];
      }
    } else if (path === '/hep' || path.startsWith('/hep/')) {
      site = 'hep';
    } else {
      site = 'eusd';
    }
  } else {
    // School subdomain — look up via hostname map.
    site = HOSTNAME_TO_SITE[host];
  }

  if (!site) return null;

  // Build canonical URL.
  let canonicalUrl: string;
  if (site === 'hep') {
    // HEP lives only at /hep on www; preserve that prefix.
    canonicalUrl = 'https://www.eusd.org' + (path.startsWith('/hep') ? path : '/hep' + path);
  } else if (site === 'eusd') {
    canonicalUrl = 'https://www.eusd.org' + (path || '/');
  } else {
    canonicalUrl = 'https://www.eusd.org/o/' + site + path;
  }

  // Append query string (preserve so e.g. ?fbclid= still trips exclusion).
  if (search) canonicalUrl += search;

  // Lowercase + strip trailing slash (matches discover.ts normalization).
  canonicalUrl = canonicalUrl.toLowerCase();
  canonicalUrl = canonicalUrl.replace(/\/+$/, '') || 'https://www.eusd.org';
  // Special case: bare domain root should retain a trailing pattern only for HEP/eusd
  if (canonicalUrl === 'https://www.eusd.org' && site === 'eusd') {
    // existing DB has the district homepage as 'https://www.eusd.org' (no slash) — keep as-is
  }

  return { url: canonicalUrl, site };
}

function isExcluded(url: string): boolean {
  return EXCLUDED_URL_PATTERNS.some(p => p.test(url));
}

function deriveTitle(rawTitle: string, url: string): string {
  const t = (rawTitle ?? '').trim();
  if (!t) return url;
  // Strip the trailing site-name suffix Apptegy adds (e.g. " | Bear Valley Middle School").
  return t.replace(/\s*\|\s*[^|]+$/, '').trim() || url;
}

function main() {
  const csvPath = fileArg ? resolve(fileArg) : findLatestCsv();
  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`\n=== Linkcheck Import${apply ? '' : ' (DRY RUN)'} ===`);
  console.log(`Source: ${csvPath}`);
  console.log(`Mode:   ${apply ? 'APPLY (will write to DB)' : 'DRY RUN (no DB writes — pass --apply to commit)'}`);
  console.log();

  const csv = readFileSync(csvPath, 'utf8');
  const lines = csv.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }

  // Skip header.
  const rows = lines.slice(1).map(parseCsvLine);

  const db = new Database(DB_PATH);
  const exists = db.prepare<[string]>('SELECT 1 FROM pages WHERE url = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pages (site, page_name, url, source) VALUES (?, ?, ?, 'linkcheck-import')`
  );

  let total = 0, excluded = 0, unmapped = 0, alreadyInDb = 0, newPages = 0, dupesInImport = 0;
  const seenInImport = new Set<string>();
  const bySite: Record<string, { newCount: number; existing: number; excluded: number }> = {};
  const unmappedHosts: Record<string, number> = {};
  const sampleNewByOurSite: Record<string, string[]> = {};

  // Run inside a single transaction when applying — atomic and faster.
  const runImport = () => {
    for (const row of rows) {
      total++;
      const siteCol = row[0];
      const urlCol = row[1];
      const titleCol = row[2];
      if (!urlCol) continue;

      if (isExcluded(urlCol)) {
        excluded++;
        const host = (() => { try { return new URL(urlCol).hostname; } catch { return 'unknown'; } })();
        const k = HOSTNAME_TO_SITE[host] ?? siteCol ?? 'unknown';
        bySite[k] ??= { newCount: 0, existing: 0, excluded: 0 };
        bySite[k].excluded++;
        continue;
      }

      const canon = canonicalize(urlCol);
      if (!canon) {
        unmapped++;
        const host = (() => { try { return new URL(urlCol).hostname; } catch { return 'unknown'; } })();
        unmappedHosts[host] = (unmappedHosts[host] ?? 0) + 1;
        continue;
      }

      bySite[canon.site] ??= { newCount: 0, existing: 0, excluded: 0 };

      if (seenInImport.has(canon.url)) {
        dupesInImport++;
        continue;
      }
      seenInImport.add(canon.url);

      if (exists.get(canon.url)) {
        alreadyInDb++;
        bySite[canon.site].existing++;
      } else {
        newPages++;
        bySite[canon.site].newCount++;
        if (sampleNewByOurSite[canon.site] === undefined) sampleNewByOurSite[canon.site] = [];
        if (sampleNewByOurSite[canon.site].length < 3) sampleNewByOurSite[canon.site].push(canon.url);
        if (apply) {
          insert.run(canon.site, deriveTitle(titleCol, canon.url), canon.url);
        }
      }
    }
  };

  if (apply) db.transaction(runImport)();
  else runImport();

  // Print summary.
  console.log('Totals');
  console.log(`  rows in CSV:             ${total}`);
  console.log(`  excluded by patterns:    ${excluded}    (news/articles/live-feed/page_no/fbclid)`);
  console.log(`  unmapped (unknown host): ${unmapped}`);
  console.log(`  duplicate after canon:   ${dupesInImport}    (same canonical URL appeared in multiple linkcheck rows)`);
  console.log(`  already in audit DB:     ${alreadyInDb}`);
  console.log(`  NEW pages${apply ? ' inserted' : ' would be inserted'}: ${newPages}`);

  if (Object.keys(unmappedHosts).length > 0) {
    console.log('\nUnmapped hosts (skipped — add to SITE_ORIGINS if these are real sites):');
    for (const [host, n] of Object.entries(unmappedHosts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${host.padEnd(30)} ${n}`);
    }
  }

  console.log('\nBy site (sorted by new-page count):');
  console.log(`  ${'site'.padEnd(15)} ${'new'.padStart(5)}  ${'existing'.padStart(8)}  ${'excluded'.padStart(8)}`);
  const siteRows = Object.entries(bySite)
    .sort((a, b) => b[1].newCount - a[1].newCount || b[1].existing - a[1].existing);
  for (const [site, c] of siteRows) {
    console.log(`  ${site.padEnd(15)} ${String(c.newCount).padStart(5)}  ${String(c.existing).padStart(8)}  ${String(c.excluded).padStart(8)}`);
  }

  if (newPages > 0 && Object.keys(sampleNewByOurSite).length > 0) {
    console.log('\nSample new URLs (up to 3 per site):');
    for (const [site, urls] of Object.entries(sampleNewByOurSite).sort()) {
      console.log(`  [${site}]`);
      for (const u of urls) console.log(`    ${u}`);
    }
  }

  db.close();

  if (!apply) {
    console.log('\nDry run only. No rows were written. Re-run with --apply to commit these inserts.');
  } else {
    console.log(`\nDone. ${newPages} new pages added with source='linkcheck-import'.`);
  }
}

main();
