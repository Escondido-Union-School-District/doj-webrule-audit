# DOJ WebRule Audit

Audits all EUSD district webpages for ADA/WCAG 2.1 Level AA compliance per DOJ web accessibility rule. Tracks remediation progress with automated and manual checks.

## Tech Stack

Node.js + TypeScript (ESM), Playwright (required for Apptegy Vue.js SPA), axe-core (injected into browser context), better-sqlite3 (SQLite), xlsx (SheetJS)

## Key Commands

```bash
npm run import              # Import Excel → SQLite
npm run audit               # Automated scan (all pages)
npm run audit -- --url <u>  # Single page audit
npm run audit -- --site eusd --limit 50
npm run today               # Daily action plan
npm run status              # Progress summary
npm run queue               # Manual review queue
npm run review -- <page_id> <check#> pass|fail "notes"
npm run review:batch -- --check <n> pass|fail "notes"
npm run quickwins           # Low-hanging fruit report
npm run dashboard           # HTML dashboard (Phase 3)
npm run discover            # Fresh page crawl (Phase 3)
```

## Project Structure

```
src\
  main.ts                    # CLI entry point + command routing
  config.ts                  # Env vars, site origins, check definitions
  db.ts                      # SQLite schema + query helpers
  import.ts                  # Excel → SQLite importer
  crawler\
    page-fetcher.ts          # Playwright page loading (SPA-aware)
    batch-runner.ts          # Concurrent page auditing (Phase 3)
  checks\
    index.ts                 # All 15 check implementations
    axe-runner.ts            # axe-core injection + execution
  manual\
    queue.ts                 # Manual review queue (Phase 4)
    review.ts                # Record manual results (Phase 4)
  reports\
    dashboard.ts             # HTML dashboard (Phase 3)
    daily-summary.ts         # Console + email nudges (Phase 3)
    quickwins.ts             # Low-hanging fruit (Phase 3)
    export.ts                # CSV/Excel export (Phase 4)
  utils\
    wcag-mapping.ts          # axe rule ID → 15 check categories
data\                        # (gitignored) SQLite database
output\                      # (gitignored) Reports
resources\
  EUSD.org Full Audit.xlsx   # Source audit spreadsheet
docs\
  user-guide.html            # Printable user guide
```

## 15 Audit Checks

| # | Check | Auto Level |
|---|-------|-----------|
| 1 | KB ACCESS | Partial |
| 2 | READING ORDER | Manual |
| 3 | SKIP LINKS | Full |
| 4 | VISUAL FOCUS INDICATOR | Partial |
| 5 | ALT-TEXT/LABELS | Full |
| 6 | LINK TEXT WELL NAMED | Full |
| 7 | COLOR ALONE | Partial |
| 8 | COLOR CONTRAST | Full |
| 9 | TABLES | Full |
| 10 | BUTTONS/FORM CONTROLS | Full |
| 11 | HEADING STRUCTURE | Full |
| 12 | EMBEDDED VIDEOS/CAROUSELS | Partial |
| 13 | MAGNIFICATION | Manual |
| 14 | LINKED DOCS/PDFS | Partial |
| 15 | VIDEOS | Partial |

## Conventions

- All EUSD sites use Apptegy CMS (Vue.js SPA) — Playwright is required for page rendering
- axe-core runs inside the browser context for accurate color contrast and computed style checks
- Results stored in SQLite at `data/audit.db`
- Manual review items are queued automatically when automation can't determine pass/fail
- Template-level checks can be batch-applied across all pages using the same template
