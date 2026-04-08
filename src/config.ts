import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, '..');
export const DATA_DIR = resolve(PROJECT_ROOT, 'data');
export const OUTPUT_DIR = resolve(PROJECT_ROOT, 'output');
export const RESOURCES_DIR = resolve(PROJECT_ROOT, 'resources');
export const DB_PATH = resolve(DATA_DIR, 'audit.db');
export const EXCEL_PATH = resolve(RESOURCES_DIR, 'EUSD.org Full Audit.xlsx');

export const PLAYWRIGHT_TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '30000', 10);
export const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
export const PAGE_DELAY_MS = parseInt(process.env.PAGE_DELAY_MS || '100', 10);
export const DAILY_QUOTA = parseInt(process.env.DAILY_QUOTA || '10', 10);

// All EUSD sites — main district + 26 school subdomains
export const SITE_ORIGINS: Record<string, string> = {
  eusd: 'https://www.eusd.org',
  bearcreek: 'https://bearcreek.eusd.org',
  centralschool: 'https://centralschool.eusd.org',
  conwayelementary: 'https://conwayelementary.eusd.org',
  deldioselementa: 'https://deldioselementa.eusd.org',
  farravenue: 'https://farravenue.eusd.org',
  felicita: 'https://felicita.eusd.org',
  glenview: 'https://glenview.eusd.org',
  hep: 'https://hep.eusd.org',
  joshuasprings: 'https://joshuasprings.eusd.org',
  juniper: 'https://juniper.eusd.org',
  lincoln: 'https://lincoln.eusd.org',
  lla: 'https://lla.eusd.org',
  lrocksprings: 'https://lrocksprings.eusd.org',
  miller: 'https://miller.eusd.org',
  mission: 'https://mission.eusd.org',
  northbroadway: 'https://northbroadway.eusd.org',
  oak: 'https://oak.eusd.org',
  orange: 'https://orange.eusd.org',
  pioneer: 'https://pioneer.eusd.org',
  preschool: 'https://preschool.eusd.org',
  quantum: 'https://quantum.eusd.org',
  rinconmiddle: 'https://rinconmiddle.eusd.org',
  rosesmmeridge: 'https://rosesmmeridge.eusd.org',
  rtn: 'https://rtn.eusd.org',
  westvalley: 'https://westvalley.eusd.org',
};

// The 15 audit check categories
export const CHECKS = [
  { number: 1, name: 'KB ACCESS', autoLevel: 'partial' },
  { number: 2, name: 'READING ORDER', autoLevel: 'manual' },
  { number: 3, name: 'SKIP LINKS', autoLevel: 'full' },
  { number: 4, name: 'VISUAL FOCUS INDICATOR', autoLevel: 'partial' },
  { number: 5, name: 'ALT-TEXT/LABELS', autoLevel: 'full' },
  { number: 6, name: 'LINK TEXT WELL NAMED', autoLevel: 'full' },
  { number: 7, name: 'COLOR ALONE', autoLevel: 'partial' },
  { number: 8, name: 'COLOR CONTRAST', autoLevel: 'full' },
  { number: 9, name: 'TABLES', autoLevel: 'full' },
  { number: 10, name: 'BUTTONS/FORM CONTROLS', autoLevel: 'full' },
  { number: 11, name: 'HEADING STRUCTURE', autoLevel: 'full' },
  { number: 12, name: 'EMBEDDED VIDEOS/CAROUSELS', autoLevel: 'partial' },
  { number: 13, name: 'MAGNIFICATION', autoLevel: 'manual' },
  { number: 14, name: 'LINKED DOCS/PDFS', autoLevel: 'partial' },
  { number: 15, name: 'VIDEOS', autoLevel: 'partial' },
] as const;

export type CheckNumber = (typeof CHECKS)[number]['number'];
export type AuditStatus = 'pass' | 'fail' | 'needs-review' | 'error';
export type Severity = 'critical' | 'serious' | 'moderate' | null;

// URL patterns to exclude from auditing — these are moderated blog/feed content,
// not structural pages that need WCAG compliance auditing
export const EXCLUDED_URL_PATTERNS = [
  /\/live-feed/i,
  /\/news\b/i,
  /\/article\//i,
  /\?page_no=/i,        // Paginated views of feeds
  /\?fbclid=/i,         // Facebook tracking params
];
