# Review UI — Design Spec

## Overview

A web-based review interface that replaces CLI review commands. Runs locally as a lightweight HTTP server, reads/writes directly to the SQLite database. Launched via `npm run review-ui`.

## Architecture

- **Server:** Express.js (or similar lightweight Node HTTP server) running locally
- **Frontend:** Single-page HTML with vanilla JS — no framework needed
- **Data:** Reads/writes directly to `data/audit.db` via the existing `db.ts` module
- **API:** REST endpoints for reading pages/results and saving reviews

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pages` | Paginated page list with all check results. Query params: `page`, `perPage`, `status`, `site`, `check`, `search` |
| PATCH | `/api/results/:pageId/:checkNumber` | Update a single check result (status + notes) |
| POST | `/api/results/:pageId/pass-all` | Mark all unreviewed checks as Pass for a page |
| GET | `/api/filters` | Get available filter options (site list, check list) |

## Layout

### Grid Structure

Spreadsheet-style grid. Each page occupies two data rows plus a header row for row 2.

**Row 1:** Page cell (rowspan 3) + checks 1–8
**Row 2 header:** Check names 9–15 (no cell under Page column — header starts at check 9)
**Row 2 data:** Checks 9–15

Each check has two columns:
- **P/F cell:** Narrow square, clickable to cycle status
- **Notes cell:** Wide textarea, stretches to fill available space

Pages are separated by a thick bottom border.

### Header Rows

- Background: light tan (`#fdf6ee`)
- Text: dark warm gray (`#44403c`), left-aligned, `font-size: 1.15em`, `font-weight: 600`
- Height: compact (26px, `padding: 3px 8px`)
- Vertical separators between each check section (`border-left: 2px solid #94a3b8`)
- Row 1 and Row 2 headers use identical styling

### Data Cells

- P/F cells: 40x40px square
- Notes cells: 40px height, flexible width (fill remaining space)
- Alternating check section backgrounds for visual distinction:
  - Odd checks: `#fff` (row 1), `#f8fafc` (row 2)
  - Even checks: `#f8fafc` (row 1), `#f1f5f9` (row 2)
- Vertical separator at the start of each check section (`border-left: 2px solid #cbd5e1`)

### Page Cell

- Spans all 3 rows (data row 1, header row 2, data row 2) via `rowspan="3"`
- Contains: page name (link, opens in new window), URL subtitle, "Pass All" button
- Vertically centered
- Width: 140px

## Status States

Three states only — no N/A:

| Status | Display | Color | Background |
|--------|---------|-------|------------|
| Unreviewed | `?` | `#92400e` | `#fef3c7` (yellow) |
| Pass | `P` | `#166534` | `#dcfce7` (green) |
| Fail | `F` | `#991b1b` | `#fecaca` (red) |

**Click cycle:** ? → P → F → ? (repeating)

## Interactions

### P/F Toggle
- Click the P/F cell to cycle through statuses
- Change saves immediately to database (auto-save, no Save button)

### Notes
- Textarea in each notes cell
- Auto-saves on blur (when you click/tab away from the field)

### Pass All
- Button in the page cell
- Marks all **unreviewed** (?) checks for that page as Pass
- Does not override existing Pass or Fail judgments

### Page Link
- Page name is a link with `target="_blank"` — opens in a new browser window
- User arranges review UI and page side by side manually

## Filters

Filter bar at the top of the page. All filters are combinable (AND logic).

| Filter | Type | Options |
|--------|------|---------|
| Status | Dropdown | All statuses, Unreviewed, Pass, Fail |
| Site | Dropdown | All sites, then each site from the database |
| Check | Dropdown | All checks, then each of the 15 checks |
| Search | Text input | Matches against page name or URL |

**Filtering by check + status:** When a check filter is selected (e.g., "14 PDFs"), the status filter applies to that specific check. So "Check 14 + Fail" shows only pages where check 14 is failing.

## Pagination

- Bottom bar shows "Showing 1–10 of N pages"
- Per-page selector: 10, 25, 50 (default: 10)
- Prev/Next buttons
- Prev is disabled on page 1, Next disabled on last page

## Data Flow

### Reading
1. Server queries `pages` and `audit_results` tables
2. Joins results to pages, groups by page
3. Returns paginated JSON with all 15 check statuses and notes per page

### Writing (P/F toggle or note change)
1. Frontend sends PATCH to `/api/results/:pageId/:checkNumber`
2. Server updates `audit_results` table: sets `manual_override` to the new status, `notes` to the note text, `audited_by` to `'manual'`, `reviewed_at` to current timestamp
3. If no `audit_results` row exists for that page+check, creates one
4. Returns success — no page reload needed

### Writing (Pass All)
1. Frontend sends POST to `/api/results/:pageId/pass-all`
2. Server finds all checks for that page where status is `needs-review` or has no result
3. Sets each to `pass` with `audited_by = 'manual-batch'`
4. Returns updated results — frontend updates all affected cells

## New Files

```
src/
  server/
    index.ts          # Express server setup, serves static + API
    api.ts            # API route handlers
    static/
      index.html      # The review UI page
      app.js          # Frontend JS (fetch, render, interactions)
      style.css       # Styles
```

## Launch Command

Add to `package.json` scripts:
```json
"review-ui": "tsx src/server/index.ts"
```

Server starts on `localhost:3000` (or next available port) and opens the browser automatically.
