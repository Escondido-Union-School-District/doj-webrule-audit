# DOJ WebRule Audit — Changelog

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
