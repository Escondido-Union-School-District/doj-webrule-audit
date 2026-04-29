import type { Page } from 'playwright';
import { CHECKS, type AuditStatus, type Severity, type CheckNumber } from '../config.js';
import { runAxe, filterWcagOnly, type AxeResults } from './axe-runner.js';
import { groupViolationsByCheck } from '../utils/wcag-mapping.js';

export interface CheckResult {
  checkNumber: CheckNumber;
  checkName: string;
  status: AuditStatus;
  severity: Severity;
  notes: string;
  remediation: string;
  axeViolations: string; // JSON string of relevant violations
  needsManualReview: boolean;
  manualReason?: string;
}

/**
 * Runs all 15 audit checks against a page.
 * Uses axe-core results as the foundation, then applies custom logic per check.
 */
export async function runAllChecks(page: Page, url: string): Promise<CheckResult[]> {
  // Run axe-core once — results feed into multiple checks
  let axeResults: AxeResults;
  try {
    axeResults = filterWcagOnly(await runAxe(page));
  } catch (err) {
    // If axe fails, return error status for all checks
    return CHECKS.map(c => ({
      checkNumber: c.number as CheckNumber,
      checkName: c.name,
      status: 'error' as AuditStatus,
      severity: null,
      notes: `axe-core failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: '',
      axeViolations: '[]',
      needsManualReview: true,
      manualReason: 'axe-core failed — full manual audit needed',
    }));
  }

  const violationsByCheck = groupViolationsByCheck(axeResults.violations);
  const results: CheckResult[] = [];

  for (const check of CHECKS) {
    const checkNum = check.number as CheckNumber;
    const violations = violationsByCheck.get(checkNum) || [];
    let result: CheckResult;

    switch (checkNum) {
      case 1:  result = await checkKbAccess(page, violations); break;
      case 2:  result = await checkReadingOrder(page, violations); break;
      case 3:  result = await checkSkipLinks(page, violations); break;
      case 4:  result = await checkFocusIndicator(page, violations); break;
      case 5:  result = await checkAltText(page, violations); break;
      case 6:  result = await checkLinkText(page, violations); break;
      case 7:  result = await checkColorAlone(page, violations); break;
      case 8:  result = await checkColorContrast(page, violations); break;
      case 9:  result = await checkTables(page, violations); break;
      case 10: result = await checkButtonsForms(page, violations); break;
      case 11: result = await checkHeadingStructure(page, violations); break;
      case 12: result = await checkEmbeddedMedia(page, violations); break;
      case 13: result = await checkMagnification(page, violations); break;
      case 14: result = await checkLinkedDocs(page, url, violations); break;
      case 15: result = await checkVideos(page, violations); break;
      default: result = makeResult(checkNum, check.name, 'error', null, 'Unknown check', '', violations);
    }

    results.push(result);
  }

  return results;
}

// --- Helper to build a CheckResult ---

function makeResult(
  checkNumber: CheckNumber,
  checkName: string,
  status: AuditStatus,
  severity: Severity,
  notes: string,
  remediation: string,
  violations: any[],
  needsManualReview = false,
  manualReason?: string,
): CheckResult {
  return {
    checkNumber,
    checkName,
    status,
    severity,
    notes,
    remediation,
    axeViolations: JSON.stringify(violations),
    needsManualReview,
    manualReason,
  };
}

function violationSummary(violations: any[]): string {
  if (violations.length === 0) return '';
  return violations
    .map(v => {
      const nodeCount = v.nodes?.length || 0;
      return `${v.id}: ${v.help} (${nodeCount} instance${nodeCount !== 1 ? 's' : ''})`;
    })
    .join('; ');
}

function maxSeverity(violations: any[]): Severity {
  const levels: Record<string, number> = { critical: 3, serious: 2, moderate: 1, minor: 0 };
  let max = -1;
  let maxName: Severity = null;
  for (const v of violations) {
    const level = levels[v.impact] ?? 0;
    if (level > max) {
      max = level;
      maxName = v.impact as Severity;
    }
  }
  return maxName;
}

// =============================================================
// Individual check implementations
// =============================================================

async function checkKbAccess(page: Page, violations: any[]): Promise<CheckResult> {
  // Custom: find interactive elements that may not be keyboard accessible
  const customIssues = await page.evaluate(() => {
    const issues: string[] = [];
    // Elements with click handlers but no keyboard role
    const clickables = document.querySelectorAll('[onclick]');
    for (const el of clickables) {
      const tag = el.tagName.toLowerCase();
      if (!['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)) {
        const role = el.getAttribute('role');
        const tabindex = el.getAttribute('tabindex');
        if (!role && tabindex === null) {
          issues.push(`<${tag}> with click handler but no role/tabindex: "${el.textContent?.slice(0, 50)}"`);
        }
      }
    }
    // Elements with tabindex > 0 (anti-pattern)
    const highTabindex = document.querySelectorAll('[tabindex]');
    for (const el of highTabindex) {
      const val = parseInt(el.getAttribute('tabindex') || '0', 10);
      if (val > 0) {
        issues.push(`tabindex="${val}" on <${el.tagName.toLowerCase()}>: "${el.textContent?.slice(0, 50)}"`);
      }
    }
    return issues;
  });

  const allIssues = [...violations.map(v => v.help), ...customIssues];
  const hasIssues = violations.length > 0 || customIssues.length > 0;

  return makeResult(
    1, 'KB ACCESS',
    hasIssues ? 'needs-review' : 'needs-review', // Always needs manual verification
    maxSeverity(violations),
    allIssues.length > 0
      ? `Auto-detected: ${allIssues.join('; ')}`
      : 'No automated issues found. Manual keyboard testing needed for interactive widgets.',
    violations.length > 0 ? 'Fix keyboard accessibility issues, then verify manually' : '',
    violations,
    true,
    'Keyboard navigation requires manual testing of interactive widgets (menus, modals, dropdowns)',
  );
}

async function checkReadingOrder(page: Page, violations: any[]): Promise<CheckResult> {
  // Reading order (WCAG 1.3.2 Meaningful Sequence, Level A) is governed by DOM
  // order, not CSS visual order. axe ships no rule for it because the
  // assessment genuinely requires reading the page with a screen reader.
  // (A previous version flagged any element with CSS `order:` ≠ 0 or
  // `flex-direction: row-reverse`, but that's a normal responsive-layout
  // pattern in Vue/Apptegy templates and produced misleading noise on ~99%
  // of pages.) The check now just records any axe violations that map here
  // and flags the page for manual review.
  return makeResult(
    2, 'READING ORDER',
    'needs-review',
    null,
    violations.length > 0
      ? violationSummary(violations)
      : 'Reading order requires manual screen reader or visual DOM-order verification.',
    violations.length > 0
      ? 'Verify the screen-reader announcement order matches the intended visual reading order.'
      : '',
    violations,
    true,
    'Reading order requires manual screen reader or visual DOM-order verification',
  );
}

async function checkSkipLinks(page: Page, violations: any[]): Promise<CheckResult> {
  const skipLinkInfo = await page.evaluate(() => {
    const firstFocusable = document.querySelector(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!firstFocusable) return { found: false, reason: 'No focusable elements found' };

    const isSkipLink = firstFocusable.tagName === 'A' &&
      firstFocusable.getAttribute('href')?.startsWith('#') &&
      /skip|main|content/i.test(firstFocusable.textContent || '');

    if (!isSkipLink) {
      return { found: false, reason: `First focusable is <${firstFocusable.tagName.toLowerCase()}>: "${firstFocusable.textContent?.trim().slice(0, 50)}"` };
    }

    const targetId = firstFocusable.getAttribute('href')!.slice(1);
    const target = document.getElementById(targetId);

    return {
      found: true,
      text: firstFocusable.textContent?.trim(),
      targetExists: !!target,
      targetId,
    };
  });

  if (skipLinkInfo.found && skipLinkInfo.targetExists) {
    return makeResult(3, 'SKIP LINKS', 'pass', null,
      `Skip link found: "${skipLinkInfo.text}" → #${skipLinkInfo.targetId}`, '', violations);
  }

  if (skipLinkInfo.found && !skipLinkInfo.targetExists) {
    return makeResult(3, 'SKIP LINKS', 'fail', 'serious',
      `Skip link found but target #${skipLinkInfo.targetId} does not exist`,
      `Add id="${skipLinkInfo.targetId}" to the main content area`, violations);
  }

  // Also check axe bypass rule
  const bypassFail = violations.some(v => v.id === 'bypass');
  return makeResult(
    3, 'SKIP LINKS',
    bypassFail ? 'fail' : 'fail',
    'serious',
    `No skip link found. ${skipLinkInfo.reason || ''}`,
    'Add a skip link as the first focusable element: <a href="#main-content" class="skip-link">Skip to main content</a>',
    violations,
  );
}

async function checkFocusIndicator(page: Page, violations: any[]): Promise<CheckResult> {
  // Focus visibility (WCAG 2.4.7, AA) genuinely requires keyboard testing —
  // axe-core ships no rule for it because computed styles alone can't tell you
  // whether focus is visually distinguishable. (A previous version of this
  // check counted elements with `outline: none` in their default state, but
  // that's noise: modern CSS deliberately resets the default outline and
  // restores a stronger indicator at :focus-visible. The count was firing on
  // ~99% of pages and measuring nothing useful.) The check now just records
  // any axe violations that map here and flags the page for manual review.
  return makeResult(
    4, 'VISUAL FOCUS INDICATOR',
    'needs-review',
    maxSeverity(violations),
    violations.length > 0
      ? violationSummary(violations)
      : 'Focus indicators require manual visual verification via keyboard navigation.',
    violations.length > 0
      ? 'Ensure all interactive elements have a visibly distinct :focus or :focus-visible state.'
      : '',
    violations,
    true,
    'Focus indicators require manual visual verification via keyboard navigation',
  );
}

async function checkAltText(page: Page, violations: any[]): Promise<CheckResult> {
  // Custom checks beyond axe
  const customIssues = await page.evaluate(() => {
    const issues: string[] = [];
    const images = document.querySelectorAll('img[alt]');

    for (const img of images) {
      const alt = img.getAttribute('alt') || '';
      // Filename as alt text
      if (/\.(jpg|jpeg|png|gif|svg|webp|bmp)$/i.test(alt)) {
        issues.push(`Filename as alt text: "${alt}" on image`);
      }
      // Overly long alt
      if (alt.length > 125) {
        issues.push(`Alt text too long (${alt.length} chars): "${alt.slice(0, 60)}..."`);
      }
    }

    // (Removed: a stricter-than-WCAG custom check that flagged any <svg> without
    // an accessible name. WCAG 1.1.1 only requires alt text on SVGs that convey
    // information; decorative SVGs are exempt. axe-core's `svg-img-alt` rule
    // already covers the WCAG-correct case — it fires only on svg[role="img"] —
    // and is mapped to check 5 in wcag-mapping.ts.)

    return issues.slice(0, 20);
  });

  const allIssues = [...violations, ...customIssues.map(i => ({ id: 'custom', help: i, nodes: [] }))];

  if (allIssues.length === 0) {
    return makeResult(5, 'ALT-TEXT/LABELS', 'pass', null, 'All images have appropriate alt text', '', []);
  }

  return makeResult(
    5, 'ALT-TEXT/LABELS', 'fail',
    maxSeverity(violations) || 'moderate',
    violationSummary(violations) + (customIssues.length > 0 ? '; Custom: ' + customIssues.join('; ') : ''),
    'Add descriptive alt text to images. Use alt="" for decorative images.',
    violations,
  );
}

async function checkLinkText(page: Page, violations: any[]): Promise<CheckResult> {
  const genericPatterns = [
    /^click\s*here$/i, /^here$/i, /^read\s*more$/i, /^more$/i, /^learn\s*more$/i,
    /^download$/i, /^link$/i, /^this$/i, /^go$/i, /^continue$/i,
    /^see\s*more$/i, /^view\s*more$/i, /^details$/i, /^info$/i,
  ];

  const linkIssues = await page.evaluate((patterns) => {
    const issues: string[] = [];
    const links = document.querySelectorAll('a[href]');

    for (const link of links) {
      const text = (link.textContent || '').trim();
      const href = link.getAttribute('href') || '';

      // Empty link text
      if (!text && !link.querySelector('img[alt]') && !link.getAttribute('aria-label')) {
        issues.push(`Empty link: ${href.slice(0, 60)}`);
        continue;
      }

      // Generic link text
      for (const pattern of patterns) {
        if (new RegExp(pattern).test(text)) {
          issues.push(`Generic link text "${text}": ${href.slice(0, 60)}`);
          break;
        }
      }

      // Raw URL as link text
      if (/^https?:\/\//i.test(text)) {
        issues.push(`URL as link text: "${text.slice(0, 60)}"`);
      }
    }

    // Note: a previous version reported duplicate link text pointing to
    // different URLs, but that's WCAG 2.4.9 (Link Purpose - Link Only,
    // Level AAA) — not part of the AA target. It also false-positived on
    // the standard home-page logo + breadcrumb pattern (both link to home
    // but with different URL forms like '/' vs '/o/<sitekey>').

    return issues.slice(0, 20);
  }, genericPatterns.map(r => r.source));

  const allIssueCount = violations.length + linkIssues.length;

  if (allIssueCount === 0) {
    return makeResult(6, 'LINK TEXT WELL NAMED', 'pass', null, 'All links have descriptive text', '', []);
  }

  return makeResult(
    6, 'LINK TEXT WELL NAMED', 'fail',
    maxSeverity(violations) || 'moderate',
    violationSummary(violations) + (linkIssues.length > 0 ? '; ' + linkIssues.join('; ') : ''),
    'Replace generic link text with descriptive text that indicates the link destination.',
    violations,
  );
}

async function checkColorAlone(page: Page, violations: any[]): Promise<CheckResult> {
  // Check for links in text that rely only on color
  const hasLinkInTextIssue = violations.some(v => v.id === 'link-in-text-block');

  return makeResult(
    7, 'COLOR ALONE',
    hasLinkInTextIssue ? 'fail' : 'needs-review',
    hasLinkInTextIssue ? 'serious' as Severity : null,
    hasLinkInTextIssue
      ? `Links distinguished only by color: ${violationSummary(violations)}`
      : 'No automated color-only issues detected. Manual review needed for charts/graphs/status indicators.',
    hasLinkInTextIssue ? 'Add underline or other visual indicator to links in text blocks.' : '',
    violations,
    true,
    'Color-only information use (charts, indicators) requires manual visual review',
  );
}

async function checkColorContrast(page: Page, violations: any[]): Promise<CheckResult> {
  if (violations.length === 0) {
    return makeResult(8, 'COLOR CONTRAST', 'pass', null, 'All text meets WCAG 2.1 AA contrast requirements', '', []);
  }

  const nodeCount = violations.reduce((sum, v) => sum + (v.nodes?.length || 0), 0);
  return makeResult(
    8, 'COLOR CONTRAST', 'fail',
    maxSeverity(violations) || 'serious',
    `${nodeCount} element(s) with insufficient contrast: ${violationSummary(violations)}`,
    'Increase text/background contrast to meet 4.5:1 for normal text, 3:1 for large text.',
    violations,
  );
}

async function checkTables(page: Page, violations: any[]): Promise<CheckResult> {
  const tableInfo = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    if (tables.length === 0) return { count: 0, issues: [] };

    const issues: string[] = [];
    for (const table of tables) {
      const ths = table.querySelectorAll('th');
      const tds = table.querySelectorAll('td');
      const caption = table.querySelector('caption');
      const ariaLabel = table.getAttribute('aria-label') || table.getAttribute('aria-labelledby');

      if (tds.length > 0 && ths.length === 0) {
        issues.push('Data table without <th> header cells');
      }
      if (!caption && !ariaLabel && tds.length > 4) {
        issues.push('Data table without caption or aria-label');
      }
    }

    return { count: tables.length, issues };
  });

  if (tableInfo.count === 0) {
    return makeResult(9, 'TABLES', 'pass', null, 'No tables found on page', '', []);
  }

  const allIssues = [...violations.map(v => v.help), ...tableInfo.issues];
  if (allIssues.length === 0) {
    return makeResult(9, 'TABLES', 'pass', null,
      `${tableInfo.count} table(s) found, all properly structured`, '', []);
  }

  return makeResult(
    9, 'TABLES', 'fail',
    maxSeverity(violations) || 'moderate',
    allIssues.join('; '),
    'Add <th> elements with scope attributes to data tables. Add captions or aria-labels.',
    violations,
  );
}

async function checkButtonsForms(page: Page, violations: any[]): Promise<CheckResult> {
  const formIssues = await page.evaluate(() => {
    const issues: string[] = [];
    // Inputs with placeholder but no label
    const inputs = document.querySelectorAll('input[placeholder]:not([type="hidden"]):not([type="submit"])');
    for (const input of inputs) {
      const id = input.getAttribute('id');
      const label = id ? document.querySelector(`label[for="${id}"]`) : null;
      const ariaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
      if (!label && !ariaLabel) {
        issues.push(`Input with placeholder but no label: "${input.getAttribute('placeholder')?.slice(0, 40)}"`);
      }
    }
    return issues.slice(0, 10);
  });

  const allIssues = [...violations.map(v => v.help), ...formIssues];
  if (allIssues.length === 0) {
    return makeResult(10, 'BUTTONS/FORM CONTROLS', 'pass', null,
      'All buttons and form controls are properly labeled', '', []);
  }

  return makeResult(
    10, 'BUTTONS/FORM CONTROLS', 'fail',
    maxSeverity(violations) || 'moderate',
    allIssues.join('; '),
    'Add labels to all form controls. Ensure buttons have accessible names.',
    violations,
  );
}

async function checkHeadingStructure(page: Page, violations: any[]): Promise<CheckResult> {
  const headingTree = await page.evaluate(() => {
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const tree: Array<{ level: number; text: string }> = [];
    const issues: string[] = [];
    let h1Count = 0;
    let prevLevel = 0;

    for (const h of headings) {
      const level = parseInt(h.tagName[1], 10);
      const text = (h.textContent || '').trim();

      tree.push({ level, text: text.slice(0, 80) });

      if (level === 1) h1Count++;
      if (!text) issues.push(`Empty <h${level}>`);
      if (prevLevel > 0 && level > prevLevel + 1) {
        issues.push(`Skipped heading level: h${prevLevel} → h${level}`);
      }
      prevLevel = level;
    }

    if (h1Count === 0) issues.push('No <h1> found');
    if (h1Count > 1) issues.push(`Multiple <h1> elements (${h1Count})`);

    return { tree, issues, h1Count };
  });

  const allIssues = [...violations.map(v => v.help), ...headingTree.issues];
  const treeStr = headingTree.tree.map(h => `${'  '.repeat(h.level - 1)}h${h.level}: ${h.text}`).join('\n');

  if (allIssues.length === 0) {
    return makeResult(11, 'HEADING STRUCTURE', 'pass', null,
      `Heading structure is valid. Tree:\n${treeStr}`, '', []);
  }

  return makeResult(
    11, 'HEADING STRUCTURE', 'fail',
    maxSeverity(violations) || 'moderate',
    `${allIssues.join('; ')}. Tree:\n${treeStr}`,
    'Fix heading hierarchy: use sequential levels (h1→h2→h3), one h1 per page, no empty headings.',
    violations,
  );
}

async function checkEmbeddedMedia(page: Page, violations: any[]): Promise<CheckResult> {
  const mediaInfo = await page.evaluate(() => {
    const issues: string[] = [];
    const iframes = document.querySelectorAll('iframe');
    const videos = document.querySelectorAll('video');
    let youtubeCount = 0;
    let contentIframeCount = 0;

    // Apptegy template iframes to ignore — these appear on every page
    // and are not user-embedded content
    const templatePatterns = [
      /statuspage\.io/i,           // IT status widget
      /recaptcha/i,                // Google reCAPTCHA
      /google\.com\/recaptcha/i,
    ];

    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') || '';

      // Skip hidden/empty iframes (framework artifacts)
      if (!src && iframe.offsetWidth === 0 && iframe.offsetHeight === 0) continue;

      // Skip known template iframes
      if (templatePatterns.some(p => p.test(src))) continue;

      // axe's frame-title rule accepts title, aria-label, OR aria-labelledby
      // as the accessible name. Mirror that here so we don't false-positive on
      // iframes that already have aria-label (e.g., Apptegy's Google Maps
      // embeds on contact pages).
      const accessibleName = (iframe.getAttribute('title') || '').trim()
        || (iframe.getAttribute('aria-label') || '').trim()
        || (iframe.getAttribute('aria-labelledby') || '').trim();
      if (/youtube|youtu\.be|vimeo/i.test(src)) {
        youtubeCount++;
        if (!accessibleName) issues.push(`iframe without accessible name: ${src.slice(0, 60)}`);
      } else {
        contentIframeCount++;
        if (!accessibleName) issues.push(`iframe without accessible name: ${src.slice(0, 60)}`);
      }
    }

    // Detect carousels
    const carouselSelectors = ['.swiper', '.slick-slider', '.owl-carousel', '[class*="carousel"]', '[class*="slider"]'];
    let carouselFound = false;
    for (const sel of carouselSelectors) {
      if (document.querySelector(sel)) { carouselFound = true; break; }
    }

    if (carouselFound) {
      issues.push('Carousel/slider detected — verify keyboard navigation and pause controls');
    }

    return {
      videoCount: videos.length,
      youtubeCount,
      contentIframeCount,
      carouselFound,
      issues,
    };
  });

  if (mediaInfo.youtubeCount === 0 && mediaInfo.contentIframeCount === 0 &&
      mediaInfo.videoCount === 0 && !mediaInfo.carouselFound) {
    return makeResult(12, 'EMBEDDED VIDEOS/CAROUSELS', 'pass', null,
      'No embedded media or carousels found', '', []);
  }

  const allIssues = [...violations.map(v => v.help), ...mediaInfo.issues];
  const hasAutoIssues = violations.length > 0 || mediaInfo.issues.some(i => i.includes('without title'));

  return makeResult(
    12, 'EMBEDDED VIDEOS/CAROUSELS',
    hasAutoIssues ? 'fail' : 'needs-review',
    hasAutoIssues ? (maxSeverity(violations) || 'moderate') : null,
    `Found: ${mediaInfo.youtubeCount} video embed(s), ${mediaInfo.contentIframeCount} content iframe(s), ${mediaInfo.videoCount} <video>(s), carousel: ${mediaInfo.carouselFound ? 'yes' : 'no'}. ${allIssues.join('; ')}`,
    allIssues.length > 0 ? 'Add title attributes to iframes. Ensure carousels have pause controls and keyboard nav.' : '',
    violations,
    true,
    'Embedded media keyboard controls and carousel navigation need manual testing',
  );
}

async function checkMagnification(page: Page, violations: any[]): Promise<CheckResult> {
  const magInfo = await page.evaluate(() => {
    const issues: string[] = [];
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      const content = viewport.getAttribute('content') || '';
      if (/user-scalable\s*=\s*no/i.test(content)) {
        issues.push('Viewport meta has user-scalable=no (prevents zoom)');
      }
      const maxScale = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
      if (maxScale && parseFloat(maxScale[1]) < 2) {
        issues.push(`Viewport maximum-scale=${maxScale[1]} (should be >= 2 or removed)`);
      }
    }

    // Check for fixed-width containers
    const body = document.body;
    const bodyWidth = window.getComputedStyle(body).width;
    if (bodyWidth && parseInt(bodyWidth) > 0 && parseInt(bodyWidth) < 320) {
      issues.push('Body width less than 320px');
    }

    return issues;
  });

  const metaViewportViolation = violations.some(v => v.id === 'meta-viewport');

  return makeResult(
    13, 'MAGNIFICATION',
    metaViewportViolation || magInfo.length > 0 ? 'fail' : 'needs-review',
    metaViewportViolation ? 'critical' as Severity : (magInfo.length > 0 ? 'serious' as Severity : null),
    magInfo.length > 0
      ? magInfo.join('; ')
      : 'Viewport meta OK. Manual zoom test needed at 200% and 400%.',
    magInfo.length > 0 ? 'Remove user-scalable=no and maximum-scale restrictions from viewport meta tag.' : '',
    violations,
    true,
    'Magnification/zoom requires manual testing at 200% and 400%',
  );
}

async function checkLinkedDocs(page: Page, pageUrl: string, violations: any[]): Promise<CheckResult> {
  const docLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href]');
    const seen = new Set<string>();
    const docs: Array<{ href: string; text: string }> = [];

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = (link.textContent || '').trim();

      // Detect downloadable / linked documents only:
      //   - Direct file extensions (pdf, doc(x), ppt(x), xls(x))
      //   - Apptegy doc shortlinks
      //   - Google Drive file URLs (file/ and uc?...export=download)
      //   - Google Docs / Sheets / Slides — but NOT Forms (forms are interactive, not documents)
      const isDocLink = /\.(pdf|docx?|pptx?|xlsx?)(\?|#|$)/i.test(href) ||
                        /5il\.co|aptg\.co/i.test(href) ||
                        /drive\.google\.com\/file\//i.test(href) ||
                        /drive\.google\.com\/uc\?.*export=download/i.test(href) ||
                        /docs\.google\.com\/(document|spreadsheets|presentation)\//i.test(href);

      if (!isDocLink) continue;
      // Dedupe: image-link + text-link to the same file are one resource.
      if (seen.has(href)) continue;
      seen.add(href);
      docs.push({ href: href.slice(0, 100), text: text.slice(0, 80) });
    }

    return docs;
  });

  if (docLinks.length === 0) {
    return makeResult(14, 'LINKED DOCS/PDFS', 'pass', null, 'No document links found', '', []);
  }

  // Note: file-type-indicator-in-link-text is a best practice, not a WCAG SC.
  // Link text quality is covered by check 6 (LINK TEXT WELL NAMED, axe
  // link-name). Check 14's correct scope is "the linked PDFs/docs themselves
  // need manual accessibility review (tagged structure, alt text, reading
  // order)" — handled via the Linked Files UI.
  return makeResult(
    14, 'LINKED DOCS/PDFS',
    'needs-review',
    null,
    `${docLinks.length} document link(s) found — verify each linked file is accessible (tagged PDF, alt text, reading order).`,
    '',
    violations,
    true,
    `${docLinks.length} linked document(s) need manual accessibility review (tagged PDF, reading order)`,
  );
}

async function checkVideos(page: Page, violations: any[]): Promise<CheckResult> {
  const videoInfo = await page.evaluate(() => {
    const issues: string[] = [];
    // HTML5 video elements
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      const tracks = video.querySelectorAll('track[kind="captions"], track[kind="subtitles"]');
      if (tracks.length === 0) {
        issues.push('Video element without captions track');
      }
    }

    // YouTube and Vimeo embeds. Note: WCAG 1.2.2 requires captions to *exist*,
    // not to be enabled by default — so we don't flag missing cc_load_policy=1
    // (that's a UX best practice, not a compliance requirement). Caption
    // accuracy itself can't be evaluated automatically; the 'needs manual
    // review' flag at the bottom of this check covers it.
    const iframes = document.querySelectorAll('iframe');
    let ytCount = 0;
    for (const iframe of iframes) {
      const src = iframe.getAttribute('src') || '';
      if (/youtube|youtu\.be/i.test(src)) ytCount++;
      if (/vimeo/i.test(src)) {
        issues.push('Vimeo embed — caption status needs manual verification');
      }
    }

    return { videoCount: videos.length, ytCount, issues };
  });

  if (videoInfo.videoCount === 0 && videoInfo.ytCount === 0) {
    return makeResult(15, 'VIDEOS', 'pass', null, 'No video content found', '', []);
  }

  const allIssues = [...violations.map(v => v.help), ...videoInfo.issues];

  return makeResult(
    15, 'VIDEOS',
    allIssues.length > 0 ? 'fail' : 'needs-review',
    allIssues.length > 0 ? (maxSeverity(violations) || 'moderate') : null,
    `${videoInfo.videoCount} <video> element(s), ${videoInfo.ytCount} YouTube embed(s). ${allIssues.join('; ')}`,
    allIssues.length > 0 ? 'Add captions to all videos. For YouTube, add cc_load_policy=1 to embed URL.' : '',
    violations,
    true,
    'Video caption quality and accuracy require manual review',
  );
}
