import type { CheckNumber } from '../config.js';

/**
 * Maps axe-core rule IDs to our 15 audit check categories.
 * A single axe rule may map to multiple checks.
 * Rules not listed here are tracked but don't map to a specific check.
 */
export const AXE_RULE_TO_CHECK: Record<string, CheckNumber[]> = {
  // Check 1: KB ACCESS
  'accesskeys': [1],
  'tabindex': [1],
  'focus-order-semantics': [1],
  'scrollable-region-focusable': [1],
  'nested-interactive': [1],

  // Check 3: SKIP LINKS
  'bypass': [3],
  'skip-link': [3],
  'landmark-one-main': [3],
  'region': [3],

  // Check 4: VISUAL FOCUS INDICATOR
  // axe doesn't directly test this well, custom checks handle it

  // Check 5: ALT-TEXT/LABELS
  'image-alt': [5],
  'input-image-alt': [5],
  'svg-img-alt': [5],
  'role-img-alt': [5],
  'area-alt': [5],
  'object-alt': [5],

  // Check 6: LINK TEXT WELL NAMED
  'link-name': [6],
  'link-in-text-block': [6, 7],  // Also relevant to Check 7: Color Alone
  'identical-links-same-purpose': [6],

  // Check 7: COLOR ALONE
  // link-in-text-block mapped above

  // Check 8: COLOR CONTRAST
  'color-contrast': [8],
  'color-contrast-enhanced': [8],

  // Check 9: TABLES
  'td-headers-attr': [9],
  'th-has-data-cells': [9],
  'table-duplicate-name': [9],
  'scope-attr-valid': [9],
  'table-fake-caption': [9],

  // Check 10: BUTTONS/FORM CONTROLS
  'button-name': [10],
  'label': [10],
  'select-name': [10],
  'input-button-name': [10],
  'aria-input-field-name': [10],
  'autocomplete-valid': [10],
  'label-title-only': [10],

  // Check 11: HEADING STRUCTURE
  'heading-order': [11],
  'empty-heading': [11],
  'page-has-heading-one': [11],

  // Check 12: EMBEDDED VIDEOS/CAROUSELS
  'frame-title': [12],
  'frame-tested': [12],
  'no-autoplay-audio': [12],

  // Check 14: LINKED DOCS/PDFS
  // No axe rules directly — handled by custom check

  // Check 15: VIDEOS
  'video-caption': [15],
  'audio-caption': [15],

  // General rules that map to multiple checks or no specific check
  'aria-allowed-attr': [1, 10],
  'aria-hidden-body': [1],
  'aria-required-attr': [10],
  'aria-required-children': [10],
  'aria-required-parent': [10],
  'aria-roles': [10],
  'aria-valid-attr': [10],
  'aria-valid-attr-value': [10],
  'document-title': [11],
  'html-has-lang': [11],
  'html-lang-valid': [11],
  'meta-viewport': [13],  // Check 13: MAGNIFICATION
};

/**
 * Given an axe rule ID, returns the check numbers it maps to.
 * Returns empty array if the rule doesn't map to any specific check.
 */
export function getCheckNumbers(axeRuleId: string): CheckNumber[] {
  return AXE_RULE_TO_CHECK[axeRuleId] || [];
}

/**
 * Groups axe violations by check number.
 */
export function groupViolationsByCheck(
  violations: Array<{ id: string; impact: string; description: string; help: string; helpUrl: string; tags: string[]; nodes: any[] }>
): Map<CheckNumber, typeof violations> {
  const grouped = new Map<CheckNumber, typeof violations>();

  for (const violation of violations) {
    const checks = getCheckNumbers(violation.id);
    if (checks.length === 0) {
      // Unmapped violations still get tracked — put them in a "general" bucket
      continue;
    }
    for (const checkNum of checks) {
      if (!grouped.has(checkNum)) {
        grouped.set(checkNum, []);
      }
      grouped.get(checkNum)!.push(violation);
    }
  }

  return grouped;
}
