import { chromium } from 'playwright';
import { getDb, closeDb } from '../db.js';
import { SITE_ORIGINS, PLAYWRIGHT_TIMEOUT } from '../config.js';

interface DiscoverOptions {
  site?: string;
  diff?: boolean;
}

interface DiscoveredPage {
  url: string;
  title: string;
  site: string;
}

/**
 * Crawls EUSD sites to discover all current pages.
 * Uses sitemap parsing + link following from rendered pages.
 */
export async function discoverPages(options: DiscoverOptions = {}): Promise<void> {
  const db = getDb();
  const sites = options.site
    ? { [options.site]: SITE_ORIGINS[options.site] }
    : SITE_ORIGINS;

  if (options.site && !SITE_ORIGINS[options.site]) {
    console.log(`Unknown site: ${options.site}`);
    console.log(`Available sites: ${Object.keys(SITE_ORIGINS).join(', ')}`);
    return;
  }

  console.log(`\n=== Page Discovery Crawl ===`);
  console.log(`Sites: ${Object.keys(sites).length}\n`);

  const browser = await chromium.launch({ headless: true });
  const allDiscovered: DiscoveredPage[] = [];

  for (const [siteKey, origin] of Object.entries(sites)) {
    process.stdout.write(`Crawling ${siteKey} (${origin})... `);

    try {
      const pages = await crawlSite(browser, siteKey, origin);
      allDiscovered.push(...pages);
      console.log(`${pages.length} pages found`);
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await browser.close();

  // Insert discovered pages
  const insertPage = db.prepare(`
    INSERT OR IGNORE INTO pages (site, page_name, url, source)
    VALUES (?, ?, ?, 'discover')
  `);

  let newCount = 0;
  for (const page of allDiscovered) {
    const result = insertPage.run(page.site, page.title || page.url, page.url);
    if (result.changes > 0) newCount++;
  }

  // Check for pages in DB that weren't discovered (may be removed/redirected)
  if (options.diff || !options.site) {
    showDiff(db, allDiscovered, options.site);
  }

  console.log(`\n=== Discovery Complete ===`);
  console.log(`Total discovered: ${allDiscovered.length}`);
  console.log(`New pages added:  ${newCount}`);
  console.log(`Already in DB:    ${allDiscovered.length - newCount}`);

  const totalInDb = (db.prepare('SELECT COUNT(*) as c FROM pages WHERE active = 1').get() as { c: number }).c;
  console.log(`Total in database: ${totalInDb}`);

  closeDb();
}

async function crawlSite(browser: any, siteKey: string, origin: string): Promise<DiscoveredPage[]> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EUSD-PageDiscovery/1.0',
  });

  const discovered = new Map<string, DiscoveredPage>();
  const visited = new Set<string>();
  const toVisit: string[] = [origin];

  // Also try to find sitemap
  try {
    const sitemapUrls = await fetchSitemap(context, origin);
    for (const url of sitemapUrls) {
      if (!toVisit.includes(url)) toVisit.push(url);
    }
  } catch {
    // Sitemap may not exist — that's fine
  }

  // Crawl with a limit to avoid runaway
  const MAX_PAGES = 200;
  let crawled = 0;

  while (toVisit.length > 0 && crawled < MAX_PAGES) {
    const url = toVisit.shift()!;
    const normalized = normalizeUrl(url);

    if (visited.has(normalized)) continue;
    if (!normalized.startsWith(origin)) continue;
    visited.add(normalized);
    crawled++;

    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: PLAYWRIGHT_TIMEOUT });

      // Wait for SPA content
      await page.waitForFunction(
        () => document.body && document.body.innerText.trim().length > 50,
        { timeout: 8000 }
      ).catch(() => {});

      const title = await page.title().catch(() => '');

      discovered.set(normalized, {
        url: normalized,
        title: title.replace(/\s*[-|]\s*Escondido Union School District.*$/i, '').trim() || normalized,
        site: siteKey,
      });

      // Extract internal links
      const links = await page.evaluate((orig: string) => {
        const anchors = document.querySelectorAll('a[href]');
        const urls: string[] = [];
        for (const a of anchors) {
          const href = a.getAttribute('href');
          if (!href) continue;
          try {
            const resolved = new URL(href, document.location.href).href;
            if (resolved.startsWith(orig) && !resolved.includes('#') &&
                !resolved.match(/\.(pdf|docx?|xlsx?|pptx?|zip|png|jpg|jpeg|gif|svg|mp4|mp3)$/i)) {
              urls.push(resolved);
            }
          } catch {}
        }
        return [...new Set(urls)];
      }, origin);

      for (const link of links) {
        const norm = normalizeUrl(link);
        if (!visited.has(norm) && !toVisit.includes(norm)) {
          toVisit.push(norm);
        }
      }

      await page.close();
    } catch {
      // Skip pages that fail to load
    }
  }

  await context.close();
  return Array.from(discovered.values());
}

async function fetchSitemap(context: any, origin: string): Promise<string[]> {
  const page = await context.newPage();
  const urls: string[] = [];

  try {
    const response = await page.goto(`${origin}/sitemap.xml`, { waitUntil: 'load', timeout: 10000 });
    if (response?.ok()) {
      const content = await page.content();
      const matches = content.matchAll(/<loc>(.*?)<\/loc>/gi);
      for (const match of matches) {
        const url = match[1].trim();
        if (url.startsWith(origin)) urls.push(url);
      }
    }
  } catch {
    // No sitemap — that's fine
  }

  await page.close();
  return urls;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash, lowercase
    let path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function showDiff(db: any, discovered: DiscoveredPage[], siteFilter?: string) {
  const discoveredUrls = new Set(discovered.map(p => p.url.toLowerCase()));

  let sql = 'SELECT url, page_name, site FROM pages WHERE active = 1';
  const params: string[] = [];
  if (siteFilter) {
    sql += ' AND site = ?';
    params.push(siteFilter);
  }

  const dbPages = db.prepare(sql).all(...params) as Array<{ url: string; page_name: string; site: string }>;
  const missing: typeof dbPages = [];

  for (const p of dbPages) {
    if (!discoveredUrls.has(p.url.toLowerCase())) {
      missing.push(p);
    }
  }

  if (missing.length > 0) {
    console.log(`\n⚠ ${missing.length} page(s) in database but NOT found during crawl:`);
    for (const p of missing.slice(0, 20)) {
      console.log(`  - ${p.page_name} (${p.url})`);
    }
    if (missing.length > 20) {
      console.log(`  ... and ${missing.length - 20} more`);
    }
    console.log('  These may have been removed, redirected, or hidden behind navigation.');
  }
}
