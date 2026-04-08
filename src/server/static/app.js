/* DOJ WebRule Audit — Review UI */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  let currentPage = 1;
  let perPage = 10;
  const filters = { status: '', site: '', check: '', search: '' };

  const CHECK_LABELS = {
    1: '1 KB Access', 2: '2 Reading', 3: '3 Skip Links', 4: '4 Focus',
    5: '5 Alt Text', 6: '6 Link Text', 7: '7 Color', 8: '8 Contrast',
    9: '9 Tables', 10: '10 Forms', 11: '11 Headings', 12: '12 Embeds',
    13: '13 Zoom', 14: '14 PDFs', 15: '15 Videos',
  };

  const ROW1_CHECKS = [1, 2, 3, 4, 5, 6, 7, 8];
  const ROW2_CHECKS = [9, 10, 11, 12, 13, 14, 15];

  // ── DOM refs ───────────────────────────────────────────────────────────
  const $grid = document.getElementById('grid');
  const $pagination = document.getElementById('pagination');
  const $pageInfo = document.getElementById('page-info');
  const $perPage = document.getElementById('per-page');
  const $btnPrev = document.getElementById('btn-prev');
  const $btnNext = document.getElementById('btn-next');
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

    ROW1_CHECKS.forEach(function (cn) {
      const th = document.createElement('th');
      th.colSpan = 2;
      th.className = 'check-start';
      th.textContent = CHECK_LABELS[cn];
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
    pageCell.rowSpan = 3;

    const link = document.createElement('a');
    link.href = page.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = page.pageName;
    pageCell.appendChild(link);

    const urlSpan = document.createElement('span');
    urlSpan.className = 'page-url';
    urlSpan.textContent = page.url;
    pageCell.appendChild(urlSpan);

    const passBtn = document.createElement('button');
    passBtn.className = 'pass-all-btn';
    passBtn.textContent = 'Pass All';
    passBtn.addEventListener('click', function () { passAll(page.id, table); });
    pageCell.appendChild(passBtn);

    row1.appendChild(pageCell);
    appendCheckCells(row1, page, ROW1_CHECKS, false);
    tbody.appendChild(row1);

    // Row 2: inline header for checks 9-15 (NO page cell)
    const row2Header = document.createElement('tr');
    row2Header.className = 'inline-header';
    ROW2_CHECKS.forEach(function (cn) {
      const td = document.createElement('td');
      td.colSpan = 2;
      td.className = 'check-start';
      td.textContent = CHECK_LABELS[cn];
      row2Header.appendChild(td);
    });
    // Fill remaining column (row1 has 8 checks = 16 cols, row2 has 7 checks = 14 cols)
    const fillerTd = document.createElement('td');
    fillerTd.colSpan = 2;
    row2Header.appendChild(fillerTd);
    tbody.appendChild(row2Header);

    // Row 3: checks 9-15 data
    const row3 = document.createElement('tr');
    row3.className = 'row2 page-sep';
    appendCheckCells(row3, page, ROW2_CHECKS, true);
    // Filler cells for the extra column
    const fillerPf = document.createElement('td');
    fillerPf.className = 'pf-cell';
    row3.appendChild(fillerPf);
    const fillerNote = document.createElement('td');
    fillerNote.className = 'note-cell';
    row3.appendChild(fillerNote);
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

      var pfDiv = document.createElement('div');
      pfDiv.className = 'pf pf-' + check.status;
      pfDiv.textContent = statusLabel(check.status);
      pfDiv.dataset.pageId = page.id;
      pfDiv.dataset.check = cn;
      pfDiv.dataset.status = check.status;
      pfDiv.addEventListener('click', onPfClick);
      pfTd.appendChild(pfDiv);
      row.appendChild(pfTd);

      // Note cell
      var noteTd = document.createElement('td');
      noteTd.className = 'note-cell ' + parityClass;

      var textarea = document.createElement('textarea');
      textarea.className = 'note-input';
      textarea.dataset.pageId = page.id;
      textarea.dataset.check = cn;
      textarea.value = check.notes || '';
      textarea.addEventListener('blur', onNoteBlur);
      noteTd.appendChild(textarea);
      row.appendChild(noteTd);
    });
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

    // Find the note for this check
    var table = div.closest('table');
    var noteEl = table.querySelector('.note-input[data-page-id="' + pageId + '"][data-check="' + checkNum + '"]');
    var notes = noteEl ? noteEl.value : '';

    fetchJSON('/api/results/' + pageId + '/' + checkNum, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: apiStatus(next), notes: notes || undefined }),
    });
  }

  // ── Auto-save notes ────────────────────────────────────────────────────
  function onNoteBlur(e) {
    var textarea = e.currentTarget;
    var pageId = textarea.dataset.pageId;
    var checkNum = textarea.dataset.check;
    var notes = textarea.value;

    // Find current status for this check
    var table = textarea.closest('table');
    var pfDiv = table.querySelector('.pf[data-page-id="' + pageId + '"][data-check="' + checkNum + '"]');
    var status = pfDiv ? pfDiv.dataset.status : 'unreviewed';

    fetchJSON('/api/results/' + pageId + '/' + checkNum, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: apiStatus(status), notes: notes }),
    });
  }

  // ── Pass All ───────────────────────────────────────────────────────────
  async function passAll(pageId, table) {
    var data = await fetchJSON('/api/results/' + pageId + '/pass-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!data.ok) return;

    // Update all P/F divs in this table
    var pfDivs = table.querySelectorAll('.pf[data-page-id="' + pageId + '"]');
    pfDivs.forEach(function (div) {
      var cn = parseInt(div.dataset.check);
      var check = data.checks[cn];
      if (check) {
        div.dataset.status = check.status;
        div.className = 'pf pf-' + check.status;
        div.textContent = statusLabel(check.status);
      }
    });
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
    $pageInfo.textContent = 'Showing ' + start + '-' + end + ' of ' + p.total + ' pages';

    $btnPrev.disabled = p.page <= 1;
    $btnNext.disabled = p.page >= p.totalPages;
  }

  // ── Event binding ──────────────────────────────────────────────────────
  var searchTimeout = null;

  function bindEvents() {
    $filterStatus.addEventListener('change', function () {
      filters.status = this.value;
      currentPage = 1;
      loadPages();
    });
    $filterSite.addEventListener('change', function () {
      filters.site = this.value;
      currentPage = 1;
      loadPages();
    });
    $filterCheck.addEventListener('change', function () {
      filters.check = this.value;
      currentPage = 1;
      loadPages();
    });
    $filterSearch.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      var val = this.value;
      searchTimeout = setTimeout(function () {
        filters.search = val;
        currentPage = 1;
        loadPages();
      }, 300);
    });

    $perPage.addEventListener('change', function () {
      perPage = parseInt(this.value);
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
  }

  // ── Init ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Set perPage select to match default
    $perPage.value = String(perPage);

    loadFilters();
    loadPages();
    bindEvents();
  });
})();
