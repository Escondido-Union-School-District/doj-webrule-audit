# DOJ WebRule Audit

Audits all EUSD district webpages for ADA/WCAG 2.1 Level AA compliance per DOJ web accessibility rule. Tracks remediation progress with automated and manual checks.

## Tech Stack

Node.js + TypeScript (ESM), Playwright (required for Apptegy Vue.js SPA), axe-core (injected into browser context), better-sqlite3 (SQLite), xlsx (SheetJS)

## Key Commands

```bash
npm run import-linkcheck    # Import pages from eusd-linkcheck CSV (preferred)
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
  server\
    index.ts                 # Express server (port 3000) — primary review interface
    api.ts                   # REST API for pages, results, stats, filters
    files-api.ts             # Linked files API
    static\
      index.html             # Review UI (main grid)
      app.js                 # All Review UI logic (versioned ?v=N for cache busting)
      style.css              # Review UI styles
      files.html             # Linked Files review page
      favicon.svg            # Amber checkmark favicon for localhost tab
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
| 4 | VISUAL FOCUS INDICATOR | Manual |
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
- **The Review UI (`npm run review-ui`, localhost:3000) is the primary workflow interface.** CLI review commands (`npm run review`, `npm run review:batch`, `npm run today`, `npm run status`, `npm run quickwins`) are deprecated — they are no-ops routing to DEPRECATED_COMMANDS in `main.ts`.
- **Page state flags in `pages` table:** `active` (1=in queue, 0=unpublished/removed) and `review_later` (1=parked, hidden from default queue). Default list query requires `active=1 AND review_later=0`. Unpublished pill shows `active=0`; Review Later pill shows `active=1 AND review_later=1`. Pills are mutually exclusive in the UI.
- After any change to server or static files, restart the Review UI: kill the node process on :3000 and relaunch with `NO_OPEN=1 npm run review-ui` (bash background). Always bump `?v=N` on `app.js` and `style.css` script/link tags when changing those files.
