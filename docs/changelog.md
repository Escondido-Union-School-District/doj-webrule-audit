# DOJ WebRule Audit — Changelog

## [2026-05-06] Duplicate district pages removed; legacy URL display fix

### Review UI — Duplicate Pages
- Deactivated 12 canonical `/page/<slug>` rows that were shadow duplicates of existing `/o/eusd/page/<slug>` rows. Both URL forms serve identical content; the legacy-URL rows carry months of review state and are preserved. The duplicate canonical rows had near-zero review touches.
- `import-linkcheck` now checks both URL forms (`/page/<slug>` ↔ `/o/eusd/page/<slug>` and `/hep/<slug>` ↔ `/o/hep/page/<slug>`) before inserting. If either form exists in the DB, the row is skipped — preventing the duplicates from being recreated on the next linkcheck import.

### Review UI — Display URL
- Fixed: pages stored as `https://www.eusd.org/o/eusd/page/<slug>` now render as `www.eusd.org/page/<slug>` in the Review UI instead of the incorrect `eusd.eusd.org/…` form. Same fix applied to `/o/hep/` → `www.eusd.org/hep/…`. Database URLs unchanged; purely cosmetic.

## [2026-05-05] Page title cleanup; slug search; dashboard tile and behind-schedule fixes; daily auto-publish

### Review UI — Page Titles
- Stripped backtick-prefix / apostrophe-suffix wrappers from 505 page names (artifact of an older import).
- Derived readable Title Case labels for 30+ pages whose `page_name` was the raw URL (e.g., `/page/bell-schedules` → "Bell Schedules"). Known acronyms (PTA, AVID, IEP, ICOC, etc.) are uppercased correctly.
- Future `import-linkcheck` runs use the same derivation instead of falling back to the raw URL.

### Review UI — Search
- Search field now matches URL slugs: hyphens and underscores in the URL are treated as spaces, so typing "bell schedules" finds pages with `/page/bell-schedules` in their URL.

### Review UI — Dashboard Tiles
- Using the search field or changing the site/check dropdowns no longer clears the active dashboard tile selection. The tile (e.g., "Need Review") now stays highlighted while you narrow results further.
- Fixed `.active` CSS class management on dashboard tiles so switching tiles correctly highlights the new selection without the previous tile staying highlighted.

### Behind-Schedule Counter
- Fixed: the counter was calculating against only the current week + current month window, producing a "140 behind" reading when Mark was actually ahead. Replaced with a cumulative query: pages fully resolved since tracking start (2026-04-08) vs. expected daily-10-page pace.
- Also added `doneSinceTrackingStart` and `trackingStart` fields to the `/api/stats` response for transparency.

### Team Dashboard Auto-Publish
- Added `scripts/publish-dashboard.ts` (`npm run publish-dashboard`): regenerates `docs/data.json`, skips commits when only the `exportedAt` timestamp changed, and pushes to origin.
- Wired into the 3 AM scheduled backup task — team dashboard at GitHub Pages now refreshes daily without manual intervention.

## [2026-04-29] Tightened audit checks; filter persistence; Linked Files workflow

### Review UI
- Filter state (status, site, check, search, dashboard tile, page number) is now mirrored to the browser URL via `history.replaceState`. Pressing Back after navigating to a Linked Files report restores the previous filter.
- Page URLs in the Review UI and Linked Files report now display as `<site>.eusd.org/…` instead of the internal `www.eusd.org/o/<site>/…` alias form. Database is unchanged.

### Check 2 — Reading Order
- Removed CSS `order` / `flex-direction: row-reverse` detector. It measured CSS property values, not DOM order, which is what WCAG 1.3.2 actually tests. Apptegy's Vue template uses flex order for legitimate responsive layout.
- Check now emits a plain manual-review marker; status remains needs-review.

### Check 4 — Visual Focus Indicator
- Removed counter of elements with `outline: none` in their unfocused state. That only detected pages using modern CSS (reset outline by default; restore at `:focus-visible`), not actual focus invisibility.
- Check now emits a plain manual-review marker; status remains needs-review.

### Check 5 — Alt Text / Labels
- Removed custom SVG-without-accessible-name rule. WCAG 1.1.1 only requires alt text on SVGs conveying information; decorative SVGs are exempt. axe-core's `svg-img-alt` rule already covers `svg[role="img"]` correctly.

### Check 6 — Link Text Well Named
- Dropped "same link text must not point to different URLs" rule (WCAG 2.4.9, Level AAA — not part of the AA target). It also false-positived on the normal CMS pattern of logo + breadcrumb both linking home via slightly different URL forms.
- Remaining active rules: generic text ("click here"), empty links, URL-as-link-text, axe `link-name`.

### Check 12 — Embedded Videos / Carousels
- Iframe accessible-name check now accepts `aria-label` and `aria-labelledby` in addition to `title`, matching axe-core behavior. Google Maps embeds rendered by Apptegy with `aria-label` but no `title` no longer false-positive.

### Check 14 — Linked Docs / PDFs
- Narrowed doc-link detector to real document URLs: PDF/DOC/XLS extensions, `docs.google.com/document|spreadsheets|presentation`, `drive.google.com/file`, Drive export-download links, and Apptegy shortlinks (`5il.co`, `aptg.co`). Google Forms in the site-wide footer are no longer counted as documents.
- Detector now also handles Workspace-domain URLs (`docs.google.com/a/<domain>/document/…`).
- Removed "must indicate file type in link text" rule (WebAIM best practice, not a WCAG AA requirement; link text quality is already covered by check 6).
- When doc links are present, check returns needs-review (not pass) and populates the per-page Linked Files table so reviewers can assess each file individually.
- 72 unreviewed Google Forms / Drive-folder entries removed from `linked_files`; pages with no remaining real document links flipped to pass.

### Check 15 — Videos
- Removed `cc_load_policy=1` requirement. WCAG 1.2.2 only requires captions to exist, not to be forced on by default. The YouTube CC button satisfies the requirement.

## [2026-04-28] Expanded page coverage; import-linkcheck; rescan safety

- Added `npm run import-linkcheck` as the preferred import path (imports ~1,400 pages from the eusd-linkcheck crawler CSV).
- Rescan procedure now backfills pages omitted from a partial audit run so the dashboard stays accurate.
- Expanded page coverage from 471 to 1,408 pages across all EUSD sites.
- Corrected SITE_ORIGINS; imported 937 new pages from eusd-linkcheck.

## [2026-04-27] Initial user guide; backup/rescan tooling

- Added printable user guide at `docs/user-guide.html`.
- Added `npm run backup` and `npm run rescan` commands.
- Scheduled daily automatic database backup via Windows Task Scheduler.
