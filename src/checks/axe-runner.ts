import type { Page } from 'playwright';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const axeCorePath = require.resolve('axe-core');
const axeSource = readFileSync(axeCorePath, 'utf-8');

export interface AxeViolation {
  id: string;
  impact: string;
  description: string;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: Array<{
    html: string;
    target: string[];
    failureSummary: string;
  }>;
}

export interface AxeResults {
  violations: AxeViolation[];
  passes: Array<{ id: string; tags: string[]; nodes: Array<{ html: string; target: string[] }> }>;
  incomplete: Array<{ id: string; impact: string; description: string; help: string; nodes: Array<{ html: string; target: string[] }> }>;
  inapplicable: Array<{ id: string }>;
  timestamp: string;
  url: string;
}

/**
 * Injects axe-core into the page and runs a WCAG 2.1 AA audit.
 * Must be run against a fully-rendered page (after SPA hydration).
 */
export async function runAxe(page: Page): Promise<AxeResults> {
  // Inject axe-core source into the page
  await page.evaluate(axeSource);

  // Run axe with WCAG 2.1 AA rules
  const results = await page.evaluate(() => {
    return (window as any).axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
      resultTypes: ['violations', 'passes', 'incomplete', 'inapplicable'],
    });
  });

  return results as AxeResults;
}

/**
 * Filters axe results to only WCAG 2.1 A and AA (removes best-practice-only results).
 */
export function filterWcagOnly(results: AxeResults): AxeResults {
  const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
  const isWcag = (tags: string[]) => tags.some(t => wcagTags.includes(t));

  return {
    ...results,
    violations: results.violations.filter(v => isWcag(v.tags)),
    passes: results.passes.filter(p => isWcag(p.tags)),
    incomplete: results.incomplete.filter(i => isWcag((i as any).tags || [])),
  };
}
