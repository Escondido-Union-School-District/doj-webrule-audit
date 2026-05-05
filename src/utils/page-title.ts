// Helpers for normalizing the page_name column.
//
// The DB has three classes of page_name:
//   1. Real titles wrapped with leading backtick + trailing apostrophe
//      (artifact of an older import). cleanWrapper() strips those.
//   2. The URL itself (when no title was provided at import). deriveTitleFromUrl()
//      converts the last meaningful URL segment into a Title Case label.
//   3. Already-clean human titles. Both helpers leave these alone.

const SITE_LABELS: Record<string, string> = {
  bearvalley: 'Bear Valley',
  bernardo: 'Bernardo',
  central: 'Central',
  conway: 'Conway',
  ddaas: 'DDAAS',
  farravenue: 'Farr Avenue',
  felicita: 'Felicita',
  glenview: 'Glenview',
  hep: 'HEP',
  hiddenvalley: 'Hidden Valley',
  juniper: 'Juniper',
  lincoln: 'Lincoln',
  lla: 'LLA',
  lrgreen: 'LR Green',
  miller: 'Miller',
  mission: 'Mission',
  northbroadway: 'North Broadway',
  oakhill: 'Oak Hill',
  orangeglen: 'Orange Glen',
  pioneer: 'Pioneer',
  preschool: 'Preschool',
  quantum: 'Quantum',
  reidycreek: 'Reidy Creek',
  rincon: 'Rincon',
  rocksprings: 'Rock Springs',
  rose: 'Rose',
  district: 'District',
  eusd: 'EUSD',
};

export function cleanWrapper(s: string): string {
  if (!s) return s;
  // Strip a literal backtick prefix and apostrophe suffix added by an older
  // import. Only trim if BOTH are present, so we don't damage names that
  // happen to start or end with one of these characters legitimately.
  if (s.length >= 2 && s.charCodeAt(0) === 96 && s.charCodeAt(s.length - 1) === 39) {
    return s.slice(1, -1);
  }
  return s;
}

// Slugs are typically all-lowercase, so PTA / ICOC / etc. would otherwise
// title-case to "Pta" / "Icoc". Force uppercase for known school acronyms.
const ACRONYMS = new Set([
  'aaa', 'avid', 'cte', 'eld', 'esser', 'fafsa', 'fbla', 'gate', 'hep', 'iep',
  'icoc', 'ied', 'jr', 'lcap', 'lcff', 'lla', 'mtss', 'pbis', 'pta', 'ptaa',
  'ptcsa', 'pto', 'sd', 'sel', 'stem', 'steam', 'tk', 'tsa', 'usda', 'wasc',
  'fsa', 'jrotc', 'rotc',
]);

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(word => {
      // Preserve already-uppercase acronyms (PTA, ICOC, etc.).
      if (/^[A-Z]{2,5}$/.test(word)) return word;
      // Match against known acronyms in lowercase form.
      if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Convert a page URL into a readable title using the last meaningful path
 * segment. Returns null if the URL doesn't yield anything useful and the
 * caller should fall back to the URL itself.
 *
 * Examples:
 *   https://www.eusd.org/o/lincoln/page/bell-schedules  -> "Bell Schedules"
 *   https://lincoln.eusd.org/page/bell-schedules        -> "Bell Schedules"
 *   https://www.eusd.org/page/budget                    -> "Budget"
 *   https://www.eusd.org                                -> "EUSD Home"
 *   https://www.eusd.org/o/lincoln                      -> "Lincoln Home"
 *   https://lincoln.eusd.org/                           -> "Lincoln Home"
 */
export function deriveTitleFromUrl(url: string, site?: string): string | null {
  if (!url) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }

  const segments = path.split('/').filter(Boolean);

  // /o/<site>/...  → drop the /o/<site>/ prefix, leave the meaningful part
  if (segments[0] === 'o' && segments.length >= 2) {
    segments.splice(0, 2);
  }

  // /page/<slug> or /page/<group>/<slug> → drop the literal "page" segment
  if (segments[0] === 'page' && segments.length >= 2) {
    segments.shift();
  }

  // No meaningful segments left → it's a homepage URL
  if (segments.length === 0) {
    const label = site ? (SITE_LABELS[site] ?? site) : 'Site';
    return `${label} Home`;
  }

  // Drop trailing numeric IDs that Apptegy sometimes appends (/page/foo/12345)
  const last = segments[segments.length - 1];
  const useSegment = /^\d+$/.test(last) && segments.length > 1
    ? segments[segments.length - 2]
    : last;

  const title = titleCase(useSegment);
  return title || null;
}

/**
 * Best-effort cleanup: strips known wrapper junk, then if what's left looks
 * like a URL, derives a title from it. Returns the input unchanged otherwise.
 */
export function normalizePageName(rawName: string, url: string, site?: string): string {
  const cleaned = cleanWrapper((rawName || '').trim());
  if (!cleaned) {
    const fromUrl = deriveTitleFromUrl(url, site);
    return fromUrl ?? url;
  }
  // page_name was set to the URL itself (no real title at import time)
  if (/^https?:\/\//i.test(cleaned)) {
    const fromUrl = deriveTitleFromUrl(cleaned, site);
    return fromUrl ?? cleaned;
  }
  return cleaned;
}
