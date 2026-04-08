/* DOJ WebRule Audit — Linked Files Review */
(function () {
  'use strict';

  let currentPage = 1;
  let perPage = 25;
  const filters = { status: '', search: '' };
  let pageIdFilter = 0; // set from URL param

  const $grid = document.getElementById('grid');
  const $pagination = document.getElementById('pagination');
  const $pageInfo = document.getElementById('page-info');
  const $perPage = document.getElementById('per-page');
  const $btnPrev = document.getElementById('btn-prev');
  const $btnNext = document.getElementById('btn-next');
  const $filterStatus = document.getElementById('filter-status');
  const $filterSearch = document.getElementById('filter-search');

  // Check URL params for pageId filter
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('pageId')) {
    pageIdFilter = parseInt(urlParams.get('pageId'));
  }

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    return res.json();
  }

  // ── Dashboard ──────────────────────────────────────────────────────────
  async function loadDashboard() {
    var data = await fetchJSON('/api/files/stats');
    var $dash = document.getElementById('dashboard');
    $dash.innerHTML = '';

    function addStat(number, label, filterVal) {
      var div = document.createElement('div');
      div.className = 'dash-stat';
      if (filterVal !== null) {
        var a = document.createElement('a');
        a.href = '#';
        a.addEventListener('click', function (e) {
          e.preventDefault();
          $filterStatus.value = filterVal;
          filters.status = filterVal;
          $filterSearch.value = '';
          filters.search = '';
          pageIdFilter = 0;
          currentPage = 1;
          history.replaceState(null, '', '/files.html');
          loadFiles();
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
      $dash.appendChild(div);
    }

    addStat(data.total, 'Total Files', '');
    addStat(data.pass, 'Passed', 'pass');
    addStat(data.fail, 'Failed', 'fail');
    addStat(data.unreviewed, 'Unreviewed', 'unreviewed');
    addStat(data.pagesAllPass, 'Pages Complete', null);
    addStat(data.pagesWithFiles, 'Pages w/ Files', null);
  }

  // ── Load files ─────────────────────────────────────────────────────────
  async function loadFiles() {
    $grid.innerHTML = '<div class="loading">Loading...</div>';

    var params = new URLSearchParams({ page: currentPage, perPage: perPage });
    if (filters.status) params.set('status', filters.status);
    if (filters.search) params.set('search', filters.search);
    if (pageIdFilter) params.set('pageId', pageIdFilter);

    var data = await fetchJSON('/api/files?' + params.toString());
    renderFiles(data.files);
    renderPagination(data.pagination);
  }

  function renderFiles(files) {
    $grid.innerHTML = '';
    if (!files || files.length === 0) {
      $grid.innerHTML = '<div class="loading">No files found.</div>';
      return;
    }

    var table = document.createElement('table');
    table.className = 'files-table';

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    ['Status', 'Link Text', 'File URL', 'Notes'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    var lastPageId = null;
    var lastDataRow = null;

    files.forEach(function (file, idx) {
      // Page group header
      if (file.pageId !== lastPageId) {
        // Mark previous group's last row
        if (lastDataRow) lastDataRow.classList.add('last-in-group');
        lastPageId = file.pageId;
        var groupRow = document.createElement('tr');
        groupRow.className = 'page-group-header';

        // Page name spanning most columns
        var pageTd = document.createElement('td');
        pageTd.colSpan = 3;
        var pageLink = document.createElement('a');
        pageLink.href = file.pageUrl;
        pageLink.target = '_blank';
        pageLink.textContent = file.pageName;
        pageTd.appendChild(pageLink);
        groupRow.appendChild(pageTd);

        // Pass All button
        var actionsTd = document.createElement('td');
        var passAllBtn = document.createElement('button');
        passAllBtn.className = 'pass-all-files';
        passAllBtn.textContent = 'Pass All';
        passAllBtn.addEventListener('click', function () {
          passAllFiles(file.pageId, tbody);
        });
        actionsTd.appendChild(passAllBtn);
        groupRow.appendChild(actionsTd);

        tbody.appendChild(groupRow);
      }

      var row = document.createElement('tr');
      row.dataset.fileId = file.id;

      // Status cell
      var statusTd = document.createElement('td');
      statusTd.className = 'file-status';
      var pfDiv = document.createElement('div');
      pfDiv.className = 'file-pf pf-' + file.status;
      pfDiv.textContent = file.status === 'pass' ? 'P' : file.status === 'fail' ? 'F' : '?';
      pfDiv.dataset.fileId = file.id;
      pfDiv.dataset.status = file.status;
      pfDiv.addEventListener('click', onPfClick);
      statusTd.appendChild(pfDiv);
      row.appendChild(statusTd);

      // Link text cell
      var textTd = document.createElement('td');
      textTd.className = 'file-link-text';
      textTd.textContent = file.linkText || '(no text)';
      textTd.title = file.linkText || '';
      row.appendChild(textTd);

      // File URL cell
      var urlTd = document.createElement('td');
      urlTd.className = 'file-url';
      var fileLink = document.createElement('a');
      fileLink.href = file.fileUrl;
      fileLink.target = '_blank';
      fileLink.textContent = file.fileUrl;
      fileLink.title = file.fileUrl;
      urlTd.appendChild(fileLink);
      row.appendChild(urlTd);

      // Notes cell
      var notesTd = document.createElement('td');
      notesTd.className = 'file-notes';
      notesTd.textContent = file.notes || '';
      notesTd.dataset.fileId = file.id;
      notesTd.dataset.notes = file.notes || '';
      notesTd.addEventListener('click', onNoteClick);
      row.appendChild(notesTd);

      lastDataRow = row;
      tbody.appendChild(row);
    });
    if (lastDataRow) lastDataRow.classList.add('last-in-group');

    table.appendChild(tbody);
    $grid.appendChild(table);
  }

  // ── P/F click ──────────────────────────────────────────────────────────
  function onPfClick(e) {
    var div = e.currentTarget;
    var fileId = div.dataset.fileId;
    var current = div.dataset.status;
    var next = current === 'unreviewed' ? 'pass' : current === 'pass' ? 'fail' : 'unreviewed';

    div.dataset.status = next;
    div.className = 'file-pf pf-' + next;
    div.textContent = next === 'pass' ? 'P' : next === 'fail' ? 'F' : '?';

    var row = div.closest('tr');
    var notesTd = row.querySelector('.file-notes');
    var notes = notesTd ? notesTd.dataset.notes : '';

    fetchJSON('/api/files/' + fileId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next, notes: notes }),
    }).then(function () { loadDashboard(); });
  }

  // ── Notes popup ────────────────────────────────────────────────────────
  function onNoteClick(e) {
    e.stopPropagation();
    var cell = e.currentTarget;
    var fileId = cell.dataset.fileId;
    var currentNotes = cell.dataset.notes || '';

    var overlay = document.createElement('div');
    overlay.className = 'note-overlay';

    var popup = document.createElement('div');
    popup.className = 'note-popup';

    var header = document.createElement('div');
    header.className = 'note-popup-header';
    header.textContent = 'File Notes';
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

      var row = cell.closest('tr');
      var pfDiv = row.querySelector('.file-pf');
      var status = pfDiv ? pfDiv.dataset.status : 'unreviewed';

      fetchJSON('/api/files/' + fileId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status, notes: newNotes }),
      });
      overlay.remove();
    });
    actions.appendChild(saveBtn);

    popup.appendChild(actions);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    textarea.focus();
    setTimeout(function () {
      overlay.addEventListener('click', function (ev) {
        if (ev.target === overlay) overlay.remove();
      });
    }, 0);
  }

  // ── Pass All Files ─────────────────────────────────────────────────────
  async function passAllFiles(pageId, tbody) {
    var data = await fetchJSON('/api/files/' + pageId + '/pass-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!data.ok) return;

    // Update UI
    var pfDivs = tbody.querySelectorAll('.file-pf');
    pfDivs.forEach(function (div) {
      var fileId = parseInt(div.dataset.fileId);
      var match = data.files.find(function (f) { return f.id === fileId; });
      if (match) {
        div.dataset.status = match.status;
        div.className = 'file-pf pf-' + match.status;
        div.textContent = match.status === 'pass' ? 'P' : match.status === 'fail' ? 'F' : '?';
      }
    });

    loadDashboard();
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
    $pageInfo.textContent = 'Showing ' + start + '-' + end + ' of ' + p.total + ' files';
    $btnPrev.disabled = p.page <= 1;
    $btnNext.disabled = p.page >= p.totalPages;
  }

  // ── Events ─────────────────────────────────────────────────────────────
  var searchTimeout = null;

  function bindEvents() {
    $filterStatus.addEventListener('change', function () {
      filters.status = this.value;
      currentPage = 1;
      loadFiles();
    });
    $filterSearch.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      var val = this.value;
      searchTimeout = setTimeout(function () {
        filters.search = val;
        currentPage = 1;
        loadFiles();
      }, 300);
    });
    document.getElementById('btn-clear-filters').addEventListener('click', function () {
      $filterStatus.value = '';
      $filterSearch.value = '';
      filters.status = '';
      filters.search = '';
      pageIdFilter = 0;
      currentPage = 1;
      history.replaceState(null, '', '/files.html');
      loadFiles();
    });
    $perPage.addEventListener('change', function () {
      perPage = parseInt(this.value);
      currentPage = 1;
      loadFiles();
    });
    $btnPrev.addEventListener('click', function () {
      if (currentPage > 1) { currentPage--; loadFiles(); }
    });
    $btnNext.addEventListener('click', function () {
      currentPage++;
      loadFiles();
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    $perPage.value = String(perPage);
    loadDashboard();
    loadFiles();
    bindEvents();
  });
})();
