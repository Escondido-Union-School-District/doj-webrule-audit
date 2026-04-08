import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { PLAYWRIGHT_TIMEOUT } from '../config.js';

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export interface FetchedPage {
  page: Page;
  context: BrowserContext;
  url: string;
  loadTimeMs: number;
  error?: string;
}

/**
 * Fetches a page using Playwright with SPA-aware waiting.
 * Apptegy CMS sites are Vue.js SPAs — content renders client-side.
 * We wait for network idle + content to appear in the DOM.
 */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EUSD-ADA-Audit/1.0',
  });

  const page = await context.newPage();
  const start = Date.now();

  try {
    // Use 'load' instead of 'networkidle' — Apptegy SPAs keep connections open
    // that prevent networkidle from ever firing
    await page.goto(url, {
      waitUntil: 'load',
      timeout: PLAYWRIGHT_TIMEOUT,
    });

    // Wait for Vue/Apptegy to render content into the DOM
    await page.waitForFunction(
      () => {
        const body = document.body;
        return body && body.innerText.trim().length > 100;
      },
      { timeout: 15000 }
    ).catch(() => {
      // Some pages may legitimately have little text — don't fail
    });

    // Expand all Apptegy accordions to load lazy content (tables, etc.)
    const accordionBtns = page.locator('button.panel-heading-button');
    const btnCount = await accordionBtns.count();
    if (btnCount > 0) {
      for (let i = 0; i < btnCount; i++) {
        try { await accordionBtns.nth(i).click({ timeout: 500 }); } catch {}
      }
      // Wait for accordion content to render
      await page.waitForTimeout(2000);
    }

    // Let lazy-loaded content settle
    await page.waitForTimeout(2000);

    return {
      page,
      context,
      url,
      loadTimeMs: Date.now() - start,
    };
  } catch (err) {
    return {
      page,
      context,
      url,
      loadTimeMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Cleanly closes a fetched page and its context.
 */
export async function releasePage(fetched: FetchedPage): Promise<void> {
  try {
    await fetched.page.close();
    await fetched.context.close();
  } catch {
    // Ignore cleanup errors
  }
}
