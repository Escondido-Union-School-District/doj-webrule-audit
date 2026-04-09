/* DOJ WebRule Audit — Review UI */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let currentPage = 1;
  let perPage = 10;
  const filters = { status: '', site: '', check: '', search: '' };
  var checkStats = {};       // { 1: { remaining: N, allPass: bool }, ... }
  var hiddenChecks = [];     // check numbers that are auto-hidden
  var showAllChecks = false; // user toggled unhide
  var activeDashFilter = ''; // which dashboard stat is active

  const CHECK_LABELS = {
    1: '1 KB Access', 2: '2 Reading Order', 3: '3 Skip Links', 4: '4 Focus Indicator',
    5: '5 Alt Text', 6: '6 Link Text', 7: '7 Color Alone', 8: '8 Contrast',
    9: '9 Tables', 10: '10 Forms', 11: '11 Headings', 12: '12 Embeds',
    13: '13 Zoom 200%', 14: '14 Linked Files', 15: '15 Videos',
  };

  const ROW1_CHECKS = [1, 2, 3, 4, 5, 6, 7, 8];
  const ROW2_CHECKS = [9, 10, 11, 12, 13, 14, 15];

  const CHECK_DESCRIPTIONS = {
    1: 'Keyboard Access — All interactive elements (menus, links, buttons, modals) must be operable with keyboard only. No keyboard traps.',
    2: 'Reading Order — Content must be read in a logical order by screen readers. Visual layout must match DOM order.',
    3: 'Skip Links — A "Skip to main content" link must be the first focusable element, allowing keyboard users to bypass navigation.',
    4: 'Visual Focus Indicator — All focusable elements must show a visible outline or highlight when focused via keyboard.',
    5: 'Alt Text / Labels — All images must have descriptive alt text. Decorative images must have alt="". SVGs need accessible names.',
    6: 'Link Text Well Named — Link text must describe its destination. No "click here", "read more", or raw URLs as link text.',
    7: 'Color Alone — Information must not be conveyed by color alone. Links in text need underlines or other non-color indicators.',
    8: 'Color Contrast — Text must meet WCAG AA contrast ratios: 4.5:1 for normal text, 3:1 for large text.',
    9: 'Tables — Data tables must have header cells (<th>) with scope attributes and a caption or aria-label.',
    10: 'Buttons / Form Controls — All form inputs must have visible labels. Buttons must have accessible names.',
    11: 'Heading Structure — Pages must have one <h1>, headings in sequential order (no skipping levels), no empty headings.',
    12: 'Embedded Videos / Carousels — Iframes must have title attributes. Carousels must have pause controls and keyboard navigation.',
    13: 'Magnification — Page must be usable when zoomed to 200% and 400%. No horizontal scrolling at 320px width.',
    14: 'Linked Files — Linked documents (PDFs, Word, etc.) must be accessible. Link text must indicate the file type.',
    15: 'Videos — All videos must have captions. YouTube embeds should force captions on with cc_load_policy=1.',
  };

  // ── DOM refs ───────────────────────────────────────────────────────────
  const $grid = document.getElementById('grid');
  const $pagination = document.getElementById('pagination');
  const $pageInfo = document.getElementById('page-info');
  const $perPage = document.getElementById('per-page');
  const $btnPrev = document.getElementById('btn-prev');
  const $btnNext = document.getElementById('btn-next');
  const $paginationTop = document.getElementById('pagination-top');
  const $pageInfoTop = document.getElementById('page-info-top');
  const $perPageTop = document.getElementById('per-page-top');
  const $btnPrevTop = document.getElementById('btn-prev-top');
  const $btnNextTop = document.getElementById('btn-next-top');
  const $filterStatus = document.getElementById('filter-status');
  const $filterSite = document.getElementById('filter-site');
  const $filterCheck = document.getElementById('filter-check');
  const $filterSearch = document.getElementById('filter-search');

  // ── Helpers ────────────────────────────────────────────────────────────
  function statusLabel(s) {
    if (s === 'pass') return 'P';
    if (s === 'fail') return 'F';
    return '?';
  }

  function nextStatus(s) {
    if (s === 'unreviewed') return 'pass';
    if (s === 'pass') return 'fail';
    return 'unreviewed';
  }

  function apiStatus(s) {
    return s === 'unreviewed' ? 'needs-review' : s;
  }


  // ── Fetch helpers ──────────────────────────────────────────────────────
  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    return res.json();
  }

  async function loadFilters() {
    const data = await fetchJSON('/api/filters');
    data.statuses.forEach(function (s) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      $filterStatus.appendChild(opt);
    });
    data.sites.forEach(function (s) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      $filterSite.appendChild(opt);
    });
    data.checks.forEach(function (c) {
      const opt = document.createElement('option');
      opt.value = c.number;
      opt.textContent = c.number + ' — ' + c.name;
      $filterCheck.appendChild(opt);
    });
  }

  // ── Load pages ─────────────────────────────────────────────────────────
  async function loadPages() {
    $grid.innerHTML = '<div class="loading">Loading...</div>';

    const params = new URLSearchParams({
      page: currentPage,
      perPage: perPage,
    });
    if (filters.status) params.set('status', filters.status);
    if (filters.site) params.set('site', filters.site);
    if (filters.check) params.set('check', filters.check);
    if (filters.search) params.set('search', filters.search);

    const data = await fetchJSON('/api/pages?' + params.toString());
    renderGrid(data.pages);
    renderPagination(data.pagination);
  }

  // ── Grid rendering ─────────────────────────────────────────────────────
  function renderGrid(pages) {
    $grid.innerHTML = '';
    if (!pages || pages.length === 0) {
      $grid.innerHTML = '<div class="loading">No pages found.</div>';
      return;
    }
    pages.forEach(function (page) {
      $grid.appendChild(buildPageTable(page));
    });
  }

  function buildPageTable(page) {
    const table = document.createElement('table');
    table.className = 'review-table';
    table.dataset.pageId = page.id;

    // ─ thead: header row for checks 1-8
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const thPage = document.createElement('th');
    thPage.textContent = 'Page';
    thPage.style.width = '140px';
    headerRow.appendChild(thPage);

    var allVisible = getVisibleChecks(ROW1_CHECKS.concat(ROW2_CHECKS));
    var visRow1 = allVisible.slice(0, 8);
    var visRow2 = allVisible.slice(8);

    visRow1.forEach(function (cn) {
      var th = document.createElement('th');
      th.colSpan = 2;
      th.className = 'check-start';
      var link = document.createElement('a');
      link.href = '#';
      link.className = 'check-label-link';
      link.textContent = CHECK_LABELS[cn];
      link.addEventListener('click', function (e) { e.preventDefault(); showCheckInfo(cn); });
      th.appendChild(link);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // ─ tbody
    const tbody = document.createElement('tbody');

    // Row 1: page cell + checks 1-8 data
    const row1 = document.createElement('tr');
    const pageCell = document.createElement('td');
    pageCell.className = 'page-cell';
    pageCell.rowSpan = visRow2.length > 0 ? 3 : 1;

    const link = document.createElement('a');
    link.href = page.url;
    link.rel = 'noopener';
    link.textContent = page.pageName;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var w = Math.max(1200, screen.availWidth - 100);
      var h = Math.max(800, screen.availHeight - 100);
      window.open(page.url, 'eusd-page-preview', 'popup=yes,width=' + w + ',height=' + h);
    });
    pageCell.appendChild(link);

    const urlSpan = document.createElement('span');
    urlSpan.className = 'page-url';
    urlSpan.textContent = page.url;
    pageCell.appendChild(urlSpan);

    const passBtn = document.createElement('button');
    passBtn.className = 'pass-all-btn';
    passBtn.textContent = 'Pass All';
    passBtn.addEventListener('click', function () { passAll(page.id, table, passBtn); });
    pageCell.appendChild(passBtn);

    var skipBtn = document.createElement('button');
    skipBtn.className = 'skip-btn';
    skipBtn.textContent = 'Skip';
    skipBtn.title = 'Remove this page from review (unpublished)';
    skipBtn.addEventListener('click', function () { deactivatePage(page.id, table); });
    pageCell.appendChild(skipBtn);

    row1.appendChild(pageCell);
    appendCheckCells(row1, page, visRow1, false);
    tbody.appendChild(row1);

    // Row 2: inline header for checks 9-15 (NO page cell)
    const row2Header = document.createElement('tr');
    row2Header.className = 'inline-header';
    if (visRow2.length === 0) {
      row1.className = 'page-sep';
      table.appendChild(tbody);
      return table;
    }

    visRow2.forEach(function (cn) {
      var td = document.createElement('td');
      td.colSpan = 2;
      td.className = 'check-start';
      var link = document.createElement('a');
      link.href = '#';
      link.className = 'check-label-link';
      link.textContent = CHECK_LABELS[cn];
      link.addEventListener('click', function (e) { e.preventDefault(); showCheckInfo(cn); });
      td.appendChild(link);
      row2Header.appendChild(td);
    });
    // Fill remaining columns to match row 1 width
    var diff = visRow1.length - visRow2.length;
    if (diff > 0) {
      var fillerTd = document.createElement('td');
      fillerTd.colSpan = diff * 2;
      row2Header.appendChild(fillerTd);
    }
    tbody.appendChild(row2Header);

    // Row 3: checks data
    var row3 = document.createElement('tr');
    row3.className = 'row2 page-sep';
    appendCheckCells(row3, page, visRow2, true);
    if (diff > 0) {
      var fillerPf = document.createElement('td');
      fillerPf.colSpan = diff * 2;
      row3.appendChild(fillerPf);
    }
    tbody.appendChild(row3);

    table.appendChild(tbody);
    return table;
  }

  function appendCheckCells(row, page, checks, isRow2) {
    checks.forEach(function (cn, idx) {
      var check = page.checks[cn] || { status: 'unreviewed', notes: null };
      var parityClass = idx % 2 === 0 ? 'check-odd' : 'check-even';

      // P/F cell
      var pfTd = document.createElement('td');
      pfTd.className = 'pf-cell check-start ' + parityClass;

      var displayStatus = (check.status === 'pass' || check.status === 'fail') ? check.status : 'unreviewed';
      var pfDiv = document.createElement('div');
      pfDiv.className = 'pf pf-' + displayStatus;
      pfDiv.textContent = statusLabel(displayStatus);
      pfDiv.dataset.pageId = page.id;
      pfDiv.dataset.check = cn;
      pfDiv.dataset.status = displayStatus;
      pfDiv.addEventListener('click', onPfClick);
      pfTd.appendChild(pfDiv);
      row.appendChild(pfTd);

      // Note cell — clickable preview
      var noteTd = document.createElement('td');
      noteTd.className = 'note-cell ' + parityClass;

      noteTd.dataset.pageId = page.id;
      noteTd.dataset.check = cn;
      noteTd.dataset.notes = check.notes || '';
      noteTd.style.cursor = 'pointer';
      noteTd.title = check.notes || 'Click to add note';

      // Check 14: link to files page if page has linked files
      if (cn === 14 && page.hasFiles) {
        var filesLink = document.createElement('a');
        filesLink.href = '/files.html?pageId=' + page.id;
        filesLink.textContent = check.notes || 'View linked files';
        filesLink.style.color = '#2563eb';
        filesLink.title = 'View linked files for this page';
        noteTd.appendChild(filesLink);
      } else {
        noteTd.textContent = check.notes || '';
        noteTd.addEventListener('click', onNoteClick);
      }
      row.appendChild(noteTd);
    });
  }

  // ── Page completion check ───────────────────────────────────────────────
  function checkPageDone(table) {
    var pfDivs = table.querySelectorAll('.pf');
    var allDone = true;
    for (var i = 0; i < pfDivs.length; i++) {
      var s = pfDivs[i].dataset.status;
      if (s !== 'pass' && s !== 'fail') { allDone = false; break; }
    }
    if (allDone) {
      table.classList.add('review-done');
    } else {
      table.classList.remove('review-done');
    }
  }

  // ── Click cycle ────────────────────────────────────────────────────────
  function onPfClick(e) {
    var div = e.currentTarget;
    var pageId = div.dataset.pageId;
    var checkNum = div.dataset.check;
    var current = div.dataset.status;
    var next = nextStatus(current);

    // Update UI immediately
    div.dataset.status = next;
    div.className = 'pf pf-' + next;
    div.textContent = statusLabel(next);

    // Show/hide note cell content based on status
    var table = div.closest('table');
    var noteCell = table.querySelector('.note-cell[data-page-id="' + pageId + '"][data-check="' + checkNum + '"]');
    var notes = noteCell ? noteCell.dataset.notes : '';


    fetchJSON('/api/results/' + pageId + '/' + checkNum, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: apiStatus(next), notes: notes || undefined }),
    }).then(function () { loadDashboard(); loadCheckStats(); });

    checkPageDone(table);
  }

  // ── Note popup ──────────────────────────────────────────────────────────
  function onNoteClick(e) {
    e.stopPropagation();
    var cell = e.currentTarget;
    var pageId = cell.dataset.pageId;
    var checkNum = cell.dataset.check;
    var currentNotes = cell.dataset.notes || '';

    var checkLabel = CHECK_LABELS[parseInt(checkNum)] || 'Check ' + checkNum;

    // Create overlay
    var overlay = document.createElement('div');
    overlay.className = 'note-overlay';

    var popup = document.createElement('div');
    popup.className = 'note-popup';

    var header = document.createElement('div');
    header.className = 'note-popup-header';
    header.textContent = checkLabel + ' — Notes';
    popup.appendChild(header);

    var textarea = document.createElement('textarea');
    textarea.className = 'note-popup-textarea';
    textarea.value = currentNotes;
    popup.appendChild(textarea);

    var actions = document.createElement('div');
    actions.className = 'note-popup-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { overlay.remove(); });
    actions.appendChild(cancelBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', function () {
      var newNotes = textarea.value;
      cell.textContent = newNotes;
      cell.dataset.notes = newNotes;

      // Find current status
      var table = cell.closest('table');
      var pfDiv = table.querySelector('.pf[data-page-id="' + pageId + '"][data-check="' + checkNum + '"]');
      var status = pfDiv ? pfDiv.dataset.status : 'unreviewed';

      fetchJSON('/api/results/' + pageId + '/' + checkNum, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: apiStatus(status), notes: newNotes }),
      });

      overlay.remove();
    });
    actions.appendChild(saveBtn);

    popup.appendChild(actions);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // Focus textarea and close on overlay click (delay to avoid catching the originating click)
    textarea.focus();
    setTimeout(function () {
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) overlay.remove();
      });
    }, 0);
  }

  // ── Check info popup ─────────────────────────────────────────────────────
  function showCheckInfo(cn) {
    var overlay = document.createElement('div');
    overlay.className = 'note-overlay';

    var popup = document.createElement('div');
    popup.className = 'note-popup';

    var header = document.createElement('div');
    header.className = 'note-popup-header';
    header.textContent = CHECK_LABELS[cn];
    popup.appendChild(header);

    var body = document.createElement('div');
    body.style.padding = '8px 0';
    body.style.fontSize = '0.9em';
    body.style.lineHeight = '1.5';
    body.style.color = '#334155';
    body.textContent = CHECK_DESCRIPTIONS[cn] || '';
    popup.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'note-popup-actions';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'btn-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    actions.appendChild(closeBtn);
    popup.appendChild(actions);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) overlay.remove();
    });
  }

  // ── Pass All / Undo ─────────────────────────────────────────────────────
  async function passAll(pageId, table, passBtn) {
    // Save current state before pass-all
    var pfDivs = table.querySelectorAll('.pf[data-page-id="' + pageId + '"]');
    var previousState = {};
    pfDivs.forEach(function (div) {
      previousState[div.dataset.check] = div.dataset.status;
    });

    var data = await fetchJSON('/api/results/' + pageId + '/pass-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!data.ok) return;

    // Update all P/F divs in this table
    pfDivs.forEach(function (div) {
      var cn = parseInt(div.dataset.check);
      var check = data.checks[cn];
      if (check) {
        div.dataset.status = check.status;
        div.className = 'pf pf-' + check.status;
        div.textContent = statusLabel(check.status);
      }
    });

    // Swap Pass All button to Undo
    passBtn.textContent = 'Undo';
    passBtn.className = 'undo-btn';
    var newBtn = passBtn.cloneNode(true);
    passBtn.parentNode.replaceChild(newBtn, passBtn);
    newBtn.addEventListener('click', function () {
      undoPassAll(pageId, table, newBtn, previousState);
    });

    loadDashboard();
    loadCheckStats();
    checkPageDone(table);
  }

  async function undoPassAll(pageId, table, undoBtn, previousState) {
    // Restore each check to its previous state
    var pfDivs = table.querySelectorAll('.pf[data-page-id="' + pageId + '"]');
    for (var i = 0; i < pfDivs.length; i++) {
      var div = pfDivs[i];
      var cn = div.dataset.check;
      var prev = previousState[cn];
      if (prev && prev !== div.dataset.status) {
        div.dataset.status = prev;
        div.className = 'pf pf-' + prev;
        div.textContent = statusLabel(prev);

        var noteCell = table.querySelector('.note-cell[data-page-id="' + pageId + '"][data-check="' + cn + '"]');
        var notes = noteCell ? noteCell.dataset.notes : '';

        await fetchJSON('/api/results/' + pageId + '/' + cn, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: apiStatus(prev), notes: notes }),
        });
      }
    }

    // Swap Undo button back to Pass All
    undoBtn.textContent = 'Pass All';
    undoBtn.className = 'pass-all-btn';
    var newBtn = undoBtn.cloneNode(true);
    undoBtn.parentNode.replaceChild(newBtn, undoBtn);
    newBtn.addEventListener('click', function () {
      passAll(pageId, table, newBtn);
    });

    loadDashboard();
    loadCheckStats();
    checkPageDone(table);
  }

  // ── Deactivate page ─────────────────────────────────────────────────────
  async function deactivatePage(pageId, table) {
    if (!confirm('Remove this page from review? (It was unpublished)')) return;

    await fetchJSON('/api/pages/' + pageId + '/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    // Remove the table from the grid
    table.remove();
    loadDashboard();
    loadCheckStats();
  }

  // ── Pagination ─────────────────────────────────────────────────────────
  function renderPagination(p) {
    if (!p || p.total === 0) {
      $pagination.classList.add('hidden');
      return;
    }
    $pagination.classList.remove('hidden');

    var start = (p.page - 1) * p.perPage + 1;
    var end = Math.min(p.page * p.perPage, p.total);
    var text = 'Showing ' + start + '-' + end + ' of ' + p.total + ' pages';
    $pageInfo.textContent = text;
    $pageInfoTop.textContent = text;

    $btnPrev.disabled = p.page <= 1;
    $btnNext.disabled = p.page >= p.totalPages;
    $btnPrevTop.disabled = p.page <= 1;
    $btnNextTop.disabled = p.page >= p.totalPages;
  }

  // ── Highlight state ────────────────────────────────────────────────────
  function updateHighlights() {
    // Dashboard stats
    document.querySelectorAll('.dash-stat').forEach(function (el) {
      if (activeDashFilter !== '' && el.dataset.filter === activeDashFilter) {
        el.style.borderColor = '#2563eb';
        el.style.background = '#eff6ff';
        el.style.boxShadow = '0 0 0 1px #2563eb';
      } else {
        el.style.borderColor = '';
        el.style.background = '';
        el.style.boxShadow = '';
      }
    });

    // Filter bar — highlight when any filter is active from dropdowns
    var filterBar = document.querySelector('.filter-bar');
    var hasBarFilter = filters.site || filters.check || filters.search ||
      (filters.status && activeDashFilter === '');
    if (hasBarFilter) {
      filterBar.style.borderColor = '#2563eb';
      filterBar.style.background = '#eff6ff';
      filterBar.style.boxShadow = '0 0 0 1px #2563eb';
    } else {
      filterBar.style.borderColor = '';
      filterBar.style.background = '';
      filterBar.style.boxShadow = '';
    }
  }

  // ── Event binding ──────────────────────────────────────────────────────
  var searchTimeout = null;

  function bindEvents() {
    $filterStatus.addEventListener('change', function () {
      filters.status = this.value;
      activeDashFilter = '';
      currentPage = 1;
      updateHighlights();
      loadPages();
    });
    $filterSite.addEventListener('change', function () {
      filters.site = this.value;
      activeDashFilter = '';
      currentPage = 1;
      updateHighlights();
      loadPages();
    });
    $filterCheck.addEventListener('change', function () {
      filters.check = this.value;
      activeDashFilter = '';
      currentPage = 1;
      updateHighlights();
      loadPages();
    });
    $filterSearch.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      var val = this.value;
      searchTimeout = setTimeout(function () {
        filters.search = val;
        activeDashFilter = '';
        currentPage = 1;
        updateHighlights();
        loadPages();
      }, 300);
    });

    document.getElementById('btn-clear-filters').addEventListener('click', function () {
      $filterStatus.value = '';
      $filterSite.value = '';
      $filterCheck.value = '';
      $filterSearch.value = '';
      filters.status = '';
      filters.site = '';
      filters.check = '';
      filters.search = '';
      activeDashFilter = '';
      currentPage = 1;
      updateHighlights();
      loadPages();
    });

    $perPage.addEventListener('change', function () {
      perPage = parseInt(this.value);
      $perPageTop.value = String(perPage);
      currentPage = 1;
      loadPages();
    });
    $perPageTop.addEventListener('change', function () {
      perPage = parseInt(this.value);
      $perPage.value = String(perPage);
      currentPage = 1;
      loadPages();
    });
    $btnPrev.addEventListener('click', function () {
      if (currentPage > 1) { currentPage--; loadPages(); }
    });
    $btnNext.addEventListener('click', function () {
      currentPage++;
      loadPages();
    });
    $btnPrevTop.addEventListener('click', function () {
      if (currentPage > 1) { currentPage--; loadPages(); }
    });
    $btnNextTop.addEventListener('click', function () {
      currentPage++;
      loadPages();
    });
  }

  // ── Dashboard ──────────────────────────────────────────────────────────
  async function loadDashboard() {
    var data = await fetchJSON('/api/stats');
    var $dash = document.getElementById('dashboard');

    function makeStat(number, label, filterStatus) {
      var div = document.createElement('div');
      div.className = 'dash-stat';
      div.dataset.filter = filterStatus !== null ? filterStatus : '';
      if (filterStatus !== null && activeDashFilter === filterStatus) {
        div.classList.add('active');
      }

      if (filterStatus !== null) {
        var a = document.createElement('a');
        a.href = '#';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          activeDashFilter = filterStatus;
          var actualFilter = filterStatus === 'all' ? '' : filterStatus;
          $filterStatus.value = actualFilter;
          filters.status = actualFilter;
          $filterSite.value = '';
          $filterCheck.value = '';
          $filterSearch.value = '';
          filters.site = '';
          filters.check = '';
          filters.search = '';
          currentPage = 1;
          updateHighlights();
          loadPages();
        });
        var num = document.createElement('span');
        num.className = 'dash-number';
        num.textContent = number;
        a.appendChild(num);
        a.appendChild(document.createTextNode(' ' + label));
        div.appendChild(a);
      } else {
        var num = document.createElement('span');
        num.className = 'dash-number';
        num.textContent = number;
        div.appendChild(num);
        div.appendChild(document.createTextNode(' ' + label));
      }

      return div;
    }

    $dash.innerHTML = '';
    $dash.appendChild(makeStat(data.fullyPassed, 'Fully Passed', 'pass'));
    $dash.appendChild(makeStat(data.fullyReviewedWithFailures, 'Reviewed w/ Failures', 'fail'));
    $dash.appendChild(makeStat(data.unreviewed, 'Need Review', 'unreviewed'));
    $dash.appendChild(makeStat(data.totalPages, 'Total Pages', 'all'));

    // Today's progress with goal
    var todayStat = makeStat(data.today + ' / ' + data.dailyGoal, 'Today', 'today');
    if (data.today >= data.dailyGoal) {
      todayStat.querySelector('.dash-number').style.color = '#166534';
    }
    $dash.appendChild(todayStat);

    $dash.appendChild(makeStat(data.thisWeek, 'This Week', 'week'));
    $dash.appendChild(makeStat(data.thisMonth, 'This Month', 'month'));

    // Behind schedule indicator
    if (data.behindThisWeek > 0) {
      var behindDiv = document.createElement('div');
      behindDiv.className = 'dash-stat';
      behindDiv.style.borderColor = '#fca5a5';
      behindDiv.style.background = '#fef2f2';
      var behindNum = document.createElement('span');
      behindNum.className = 'dash-number';
      behindNum.style.color = '#991b1b';
      behindNum.textContent = data.behindThisWeek;
      behindDiv.appendChild(behindNum);
      behindDiv.appendChild(document.createTextNode(' Behind This Week'));
      $dash.appendChild(behindDiv);
    }
  }

  // ── Check stats + auto-hide ─────────────────────────────────────────────
  async function loadCheckStats() {
    var data = await fetchJSON('/api/check-stats');
    checkStats = data.checks;

    // Determine which checks to hide
    if (!showAllChecks) {
      hiddenChecks = [];
      for (var cn = 1; cn <= 15; cn++) {
        if (checkStats[cn] && checkStats[cn].allPass) {
          hiddenChecks.push(cn);
        }
      }
    } else {
      hiddenChecks = [];
    }

    renderHiddenBar();
  }

  function renderHiddenBar() {
    var bar = document.getElementById('hidden-checks-bar');
    bar.style.display = 'flex';
    bar.innerHTML = '';

    var label = document.createElement('span');
    label.className = 'hidden-label';
    label.textContent = 'Check Progress:';
    bar.appendChild(label);

    // Show all checks with remaining counts (hidden ones marked as all-pass)
    for (var cn = 1; cn <= 15; cn++) {
      var stat = checkStats[cn];
      if (!stat) continue;
      var chip = document.createElement('span');
      chip.className = stat.allPass ? 'hidden-check all-pass' : 'hidden-check has-remaining';
      chip.textContent = CHECK_LABELS[cn] + (stat.allPass ? '' : ' (' + stat.remaining + ')');
      bar.appendChild(chip);
    }

    var btn = document.createElement('button');
    if (showAllChecks) {
      btn.textContent = 'Hide Passed';
      btn.addEventListener('click', function () {
        showAllChecks = false;
        loadCheckStats().then(function () { loadPages(); });
      });
    } else if (hiddenChecks.length > 0) {
      btn.textContent = 'Show All';
      btn.addEventListener('click', function () {
        showAllChecks = true;
        hiddenChecks = [];
        renderHiddenBar();
        loadPages();
      });
    }
    if (btn.textContent) bar.appendChild(btn);
  }

  function isCheckVisible(cn) {
    return hiddenChecks.indexOf(cn) === -1;
  }

  function getVisibleChecks(checkList) {
    return checkList.filter(function (cn) { return isCheckVisible(cn); });
  }

  // ── Init ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async function () {
    // Set perPage selects to match default
    $perPage.value = String(perPage);
    $perPageTop.value = String(perPage);

    loadDashboard();
    await loadCheckStats();
    loadFilters();
    loadPages();
    bindEvents();
  });
})();
