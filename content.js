// content.js -- OpenAir Timesheet Importer
// Injected into the OpenAir page. Manages the panel and fills the timesheet.

(function () {
  'use strict';

  // TEMP: cross-month "go to next month's timesheet" navigation is disabled while we
  // stabilise the single-month fill. Re-enable (set true) once that flow is solid.
  var CROSS_MONTH_ENABLED = false;

  // Auto-match acceptance threshold — SHARED by Client:Engagement AND Task. Both score the
  // Excel text against the LIVE OpenAir dropdown options using the same scoreMatch() function,
  // so they behave identically. Only a strong, name-present match auto-fills (exact / prefix /
  // all-words / substring all score >= 0.85); anything fuzzier is left blank for the user to
  // pick. "Try hard, but never guess wrong" — this also kills the "nearest alphabetical" false
  // match seen when many options share a prefix (e.g. "Connor Group : ...").
  var MATCH_MIN = 0.85;

  const GRID_SEL   = '[id^="ts_c1_r"]';
  const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOW_TO_COL = [3, 4, 5, 6, 7, 8, 9];
  const COL_TO_DOW = { 3:0, 4:1, 5:2, 6:3, 7:4, 8:5, 9:6 };
  const DAY_PATS   = [
    {re:/^sun/i,dow:0},{re:/^mon/i,dow:1},{re:/^tue/i,dow:2},
    {re:/^wed/i,dow:3},{re:/^thu/i,dow:4},{re:/^fri/i,dow:5},{re:/^sat/i,dow:6},
  ];

  const rowCache = new Map();
  let panelStatus = null;
  let _tooltipEl = null;
  let _tooltipTimer = null;

  // ── Theme ──────────────────────────────────────────────────────────────────
  // Theme is applied ONLY to .oai-panel and .oai-modal-overlay elements,
  // never to the host OpenAir page itself.

  var _themeMode  = 'light';
  var _themeColor = 'slate';
  var _hideSurprise = false; // "Preferences > don't show surprise button" (chrome.storage.sync)
  var _autoDefault = true;        // "Preferences > auto default client:engagement and task" (default ON)
  var _fillTimeNotesOnly = false; // "Preferences > just fill in time and notes" (default OFF)

  var THEME_ACCENTS = {
    slate: { hex: '#44536B', dark: '#303d50' },
    nam:   { hex: '#1B3D82', dark: '#143061' },
    becky: { hex: '#550000', dark: '#3D0000' },
    jenna: { hex: '#6C3BAA', dark: '#572E89' },
    omkar: { hex: '#DAA520', dark: '#B8860B' },
    alec:  { hex: '#40826D', dark: '#336654' },
  };

  // Pick readable text (dark or white) for a given accent background, so light accents
  // (e.g. a bright gold) get dark text instead of unreadable white.
  function readableOn(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var r = parseInt(h.substr(0,2),16)/255, g = parseInt(h.substr(2,2),16)/255, b = parseInt(h.substr(4,2),16)/255;
    function lin(c){ return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
    var L = 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
    return L > 0.38 ? '#1f2937' : '#ffffff';
  }

  function buildThemeCSS(mode, accent) {
    var a = accent.hex, ad = accent.dark;
    var onAccent = readableOn(a); // dark or white text that reads on the accent background
    // Expose the accent as CSS variables so content.css picks up the chosen colour
    // everywhere it used to hard-code slate (panel header, dropzone, spinner, etc.).
    var rootVars = ':root{--oai-accent:' + a + ';--oai-accent-dark:' + ad + ';--oai-accent-soft:' + a + '1a;--oai-on-accent:' + onAccent + ';}';
    // Accent overrides (all modes)
    var css = rootVars + '\n' + [
      '.oai-btn--primary{background:' + a + '!important;border-color:' + a + '!important}',
      '.oai-btn--primary:hover{background:' + ad + '!important;border-color:' + ad + '!important}',
      '.oai-conf-step-hint{background:' + a + '1a!important;color:' + a + '!important;border-color:' + a + '!important}',
      '.oai-select:focus{border-color:' + a + '!important;box-shadow:0 0 0 3px ' + a + '22!important}',
    ].join('\n');

    if (mode === 'light') return css;

    var isDark   = mode === 'dark';
    var bg       = isDark ? '#0f172a' : '#1a1a24';
    var surf     = isDark ? '#1e293b' : '#252530';
    var surfAlt  = isDark ? '#253047' : '#2e2e3e';
    var bdr      = isDark ? '#334155' : '#3a3a4a';
    var t1       = isDark ? '#f1f5f9' : '#e8e8f0';
    var t2       = isDark ? '#cbd5e1' : '#a8a8c0';
    var t3       = isDark ? '#94a3b8' : '#8888a0';

    return css + '\n' + [
      // Panel widget
      '#oai-panel{background:' + surf + '!important;border-color:' + bdr + '!important;color:' + t1 + '!important}',
      '#oai-panel .oai-header{border-color:' + bdr + '!important}',
      '#oai-panel .oai-header span,#oai-panel .oai-header svg{color:' + onAccent + '!important}',
      '#oai-panel .oai-title{color:' + onAccent + '!important}',
      '#oai-panel .oai-body{background:' + surf + '!important}',
      '#oai-panel p,#oai-panel small{color:' + t2 + '!important}',
      '.oai-dropzone{background:' + bg + '!important;border-color:' + bdr + '!important;color:' + t3 + '!important}',
      '.oai-dropzone-text{color:' + t3 + '!important}',
      '.oai-dz-sub{color:' + t3 + '!important}',
      '.oai-btn--download{background:' + surf + '!important;border-color:' + bdr + '!important;color:' + t2 + '!important}',
      '.oai-status{color:' + t2 + '!important}',
      // Modals (sheet picker + confirmation)
      '.oai-modal-overlay .oai-modal{background:' + surf + '!important;border-color:' + bdr + '!important}',
      '.oai-modal-header{background:' + bg + '!important;border-color:' + bdr + '!important}',
      '.oai-modal-title{color:' + t1 + '!important}',
      '.oai-modal-footer{background:' + bg + '!important;border-color:' + bdr + '!important}',
      '.oai-sort-btn{color:' + t2 + '!important}',
      '.oai-conf-header{background:' + bg + '!important;border-color:' + bdr + '!important}',
      '.oai-conf-title{color:' + t1 + '!important}',
      '.oai-conf-inner{background:' + surf + '!important}',
      '.oai-conf-actions{background:' + bg + '!important;border-color:' + bdr + '!important}',
      '.oai-conf-scroll{border-color:' + bdr + '!important}',
      '.oai-conf-table th{background:' + bg + '!important;color:' + t2 + '!important;border-color:' + bdr + '!important}',
      '.oai-conf-table td{background:' + surf + '!important;color:' + t1 + '!important;border-color:' + bdr + '!important}',
      '.oai-conf-table tr:nth-child(even) td{background:' + surfAlt + '!important}',
      '.oai-conf-hint{color:' + t3 + '!important}',
      '.oai-conf-hint strong{color:' + t2 + '!important}',
      '.oai-conf-step-hint{background:' + surf + '!important;color:#ffffff!important;border:1px dotted ' + a + '!important}',
      '.oai-conf-cross-month-warning{background:' + surfAlt + '!important;color:#fca5a5!important;border-color:' + bdr + '!important}',
      '.oai-conf-stats-banner{color:' + t3 + '!important}',
      '.oai-conf-sheet-label{color:' + t2 + '!important}',
      '.oai-conf-legend{color:' + t3 + '!important}',
      '.oai-conf-above-table{background:' + surf + '!important}',
      '.oai-modal-x{color:' + t2 + '!important}',
      '.oai-modal-x:hover{background:' + bdr + '!important;color:' + t1 + '!important}',
      '.oai-conf-sel{background:' + bg + '!important;border-color:' + bdr + '!important;color:' + t1 + '!important}',
      '.oai-btn--secondary{background:' + surf + '!important;border-color:' + bdr + '!important;color:' + t2 + '!important}',
      '.oai-btn--secondary:hover{background:' + surfAlt + '!important}',
      // Sheet picker list
      '.oai-sheet-list{background:' + surf + '!important}',
      '.oai-sheet-item{background:' + surf + '!important;border-color:' + bdr + '!important;color:' + t1 + '!important}',
      '.oai-sheet-item:hover{background:' + surfAlt + '!important}',
      // Completion modal + audit log (dark/cool need light, contrasting text)
      '.oai-completion-msg{color:' + t1 + '!important}',
      '.oai-gif-chance,.oai-gif-reward{color:' + t2 + '!important}',
      '.oai-audit{border-color:' + bdr + '!important}',
      '.oai-audit-title{color:' + t1 + '!important}',
      '.oai-audit-summary{color:' + t3 + '!important}',
      '.oai-audit-scroll{border-color:' + bdr + '!important}',
      '.oai-audit-table th{background:' + bg + '!important;color:' + t2 + '!important;border-color:' + bdr + '!important}',
      '.oai-audit-table td{background:' + surf + '!important;color:' + t1 + '!important;border-color:' + bdr + '!important}',
      '.oai-audit-reason{color:#fca5a5!important}',
    ].join('\n');
  }

  function applyContentTheme(color, mode) {
    _themeColor = color || 'slate';
    _themeMode  = mode  || 'light';
    var accent  = THEME_ACCENTS[_themeColor] || THEME_ACCENTS.slate;
    var css     = buildThemeCSS(_themeMode, accent);
    var el      = document.getElementById('oai-theme-style');
    if (!el) {
      el    = document.createElement('style');
      el.id = 'oai-theme-style';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  // Read theme on content script load and react to future changes
  chrome.storage.sync.get(['oai_theme_color', 'oai_theme_mode', 'oai_hide_surprise', 'oai_auto_default', 'oai_fill_time_notes_only'], function (prefs) {
    applyContentTheme(prefs.oai_theme_color, prefs.oai_theme_mode);
    _hideSurprise = !!prefs.oai_hide_surprise;
    _autoDefault = prefs.oai_auto_default !== false;      // unset -> ON
    _fillTimeNotesOnly = !!prefs.oai_fill_time_notes_only; // unset -> OFF
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    if (changes.oai_hide_surprise) _hideSurprise = !!changes.oai_hide_surprise.newValue;
    if (changes.oai_auto_default) _autoDefault = changes.oai_auto_default.newValue !== false;
    if (changes.oai_fill_time_notes_only) _fillTimeNotesOnly = !!changes.oai_fill_time_notes_only.newValue;
    var color = changes.oai_theme_color ? changes.oai_theme_color.newValue : _themeColor;
    var mode  = changes.oai_theme_mode  ? changes.oai_theme_mode.newValue  : _themeMode;
    applyContentTheme(color, mode);
  });

  // ── Utilities ──────────────────────────────────────────────────────────────

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Content scripts run in an isolated world, so setting window.onbeforeunload here does
  // NOT clear the PAGE's handler - OpenAir's "Leave site? Changes may not be saved" prompt
  // would still fire on our intentional reloads/navigations. page-helper.js runs in the
  // MAIN world and nulls the page's handler when it receives this event on the shared document.
  function clearBeforeUnload() {
    try { document.dispatchEvent(new CustomEvent('oai-clear-beforeunload')); } catch (_e) {}
  }

  function normalise(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const m = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const k = a.slice(i, i + 2);
      m.set(k, (m.get(k) || 0) + 1);
    }
    let h = 0;
    for (let j = 0; j < b.length - 1; j++) {
      const k = b.slice(j, j + 2);
      const n = m.get(k) || 0;
      if (n > 0) { h++; m.set(k, n - 1); }
    }
    return (2 * h) / (a.length + b.length - 2);
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setStatus(html, type) {
    if (!panelStatus) return;
    panelStatus.innerHTML = html;
    panelStatus.className = 'oai-status oai-status--' + type;
  }

  function clearStatus() {
    if (!panelStatus) return;
    panelStatus.innerHTML = '';
    panelStatus.className = 'oai-status';
  }

  // ── Custom tooltip (200ms delay) ───────────────────────────────────────────

  function _getTooltipEl() {
    if (!_tooltipEl) {
      _tooltipEl = document.createElement('div');
      _tooltipEl.className = 'oai-tooltip';
      document.body.appendChild(_tooltipEl);
    }
    return _tooltipEl;
  }

  function attachTooltip(el, text) {
    if (!text) return;
    el.addEventListener('mouseenter', function () {
      clearTimeout(_tooltipTimer); // drop any stale timer from a neighbouring element so the tip fires reliably
      _tooltipTimer = setTimeout(function () {
        var tip = _getTooltipEl();
        document.body.appendChild(tip); // move to end of <body> so it renders ABOVE the current modal overlay
        tip.textContent = text;
        tip.classList.add('oai-tooltip--visible');
        var rect = el.getBoundingClientRect();
        var maxW = 240;
        var left = rect.left + rect.width / 2 - maxW / 2;
        left = Math.max(4, Math.min(left, window.innerWidth - maxW - 4));
        tip.style.left = left + 'px';
        tip.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
      }, 200);
    });
    el.addEventListener('mouseleave', function () {
      clearTimeout(_tooltipTimer);
      _getTooltipEl().classList.remove('oai-tooltip--visible');
    });
  }

  function attachTooltips(container) {
    container.querySelectorAll('[data-oai-tip]').forEach(function (el) {
      attachTooltip(el, el.dataset.oaiTip);
    });
  }

  // ── Cross-month detection ──────────────────────────────────────────────────

  // Month index by 3-letter abbreviation (used to parse "Jul 19, 2026" style headers).
  var _MONTHS_ABBR = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

  function _mkDate(y, mo, d) {
    var dt = new Date(y, mo, d);
    if (isNaN(dt.getTime())) return null;
    // Guard against JS date rollover (e.g. Feb 31 -> Mar 3).
    if (dt.getMonth() !== ((mo % 12) + 12) % 12 || dt.getDate() !== d) return null;
    return dt;
  }

  // Given any day in a week, return that week's Sunday..Saturday.
  function _sundayToSaturday(base) {
    var sun = new Date(base); sun.setDate(base.getDate() - base.getDay());
    var sat = new Date(sun);  sat.setDate(sun.getDate() + 6);
    return { from: sun, to: sat };
  }

  // Parse the imported sheet TAB NAME (e.g. "7-12-2026" = M-D-YYYY, the week-start).
  function _parseSheetNameDate(sheetName) {
    var m = String(sheetName || '').match(/^\s*(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (!m) return null;
    var mo = parseInt(m[1], 10) - 1, d = parseInt(m[2], 10), y = parseInt(m[3], 10);
    return _mkDate(y, mo, d);
  }

  // Extract every date-like token from a string, in the many formats SuiteProjects Pro
  // / OpenAir uses for headers. Returns [{ dt, hasYear, mo, d }]. defaultYear is used only
  // when a token omits the year (display uses month+day only, so this is safe).
  function _extractDates(text, defaultYear) {
    var out = [], m, mo, d, y, hasY, dt;
    if (!text) return out;

    // numeric: M/D, M/D/YY, M/D/YYYY  (slash or dash separators)
    var reNum = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
    while ((m = reNum.exec(text))) {
      mo = parseInt(m[1], 10) - 1; d = parseInt(m[2], 10);
      hasY = !!m[3]; y = hasY ? parseInt(m[3], 10) : defaultYear;
      if (hasY && y < 100) y += 2000;
      if (mo < 0 || mo > 11 || d < 1 || d > 31) continue;
      dt = _mkDate(y, mo, d);
      if (dt) out.push({ dt: dt, hasYear: hasY, mo: mo, d: d });
    }

    // month-name first: "Jul 19", "Jul 19, 2026", "July 19 2026"
    var reMon = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/gi;
    while ((m = reMon.exec(text))) {
      mo = _MONTHS_ABBR[m[1].toLowerCase()]; d = parseInt(m[2], 10);
      hasY = !!m[3]; y = hasY ? parseInt(m[3], 10) : defaultYear;
      if (d < 1 || d > 31) continue;
      dt = _mkDate(y, mo, d);
      if (dt) out.push({ dt: dt, hasYear: hasY, mo: mo, d: d });
    }

    // day first: "19 Jul", "19 Jul 2026"
    var reDay = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/gi;
    while ((m = reDay.exec(text))) {
      d = parseInt(m[1], 10); mo = _MONTHS_ABBR[m[2].toLowerCase()];
      hasY = !!m[3]; y = hasY ? parseInt(m[3], 10) : defaultYear;
      if (d < 1 || d > 31) continue;
      dt = _mkDate(y, mo, d);
      if (dt) out.push({ dt: dt, hasYear: hasY, mo: mo, d: d });
    }

    return out;
  }

  // Turn a collection of extracted dates into a {from,to} week, if they look like a
  // single displayed week (earliest..latest, spanning at most ~8 days).
  function _weekFromDates(dates) {
    if (!dates || dates.length < 2) return null;
    var sorted = dates.slice().sort(function (a, b) { return a.dt - b.dt; });
    var from = sorted[0].dt, to = sorted[sorted.length - 1].dt;
    var span = Math.round((to.getTime() - from.getTime()) / 86400000);
    if (span < 0 || span > 8) return null;
    return { from: from, to: to };
  }

  // PRIMARY source of truth: the dates rendered in the timesheet grid's day-column headers.
  // The hours inputs are ts_c3_r{n}..ts_c9_r{n} (Sun..Sat); we locate the grid <table> from
  // one of those inputs and read date tokens out of its HEADER cells only (th / thead), so we
  // reflect exactly the week the user has OPEN rather than today's date.
  // ASSUMPTION (verify on a live page): the grid table exposes the per-day dates as text in its
  // <th>/<thead> header cells. If it does not, this returns null and we fall through to the
  // broadened page-header regex below.
  function _readGridWeekDates() {
    try {
      var dayInput = document.querySelector('[id^="ts_c3_r"]') ||
                     document.querySelector('[id^="ts_c9_r"]');
      var table = (dayInput && dayInput.closest) ? dayInput.closest('table') : null;
      if (!table) return null;

      var headerText = '';
      var cells = table.querySelectorAll('thead th, thead td, th');
      if (cells && cells.length) {
        cells.forEach(function (c) { headerText += ' ' + (c.textContent || ''); });
      }
      if (!headerText.trim()) return null;

      return _weekFromDates(_extractDates(headerText, (new Date()).getFullYear()));
    } catch (_e) {
      return null;
    }
  }

  // SECONDARY source: the page/header text. Accepts full ranges in many formats
  // ("07/19/2026 - 07/25/2026", "Jul 19, 2026 to Jul 25, 2026", "Jul 19 - 25, 2026", en/em dashes,
  // "to"/"through"/"thru"), and a lone week-start ("Week of 07/19/2026") from which the Sun..Sat
  // week is computed.
  function _readHeaderWeek() {
    try {
      var pageText = (document.body && document.body.innerText) || '';
      if (!pageText) return null;
      var year = (new Date()).getFullYear();
      var m, a, b;
      var SEP = '(?:to|through|thru|\\u2013|\\u2014|\\u2026|-)';

      // "Week of <date>" -> compute that week's Sun..Sat.
      var wm = pageText.match(/week\s+of\s+([^\n\r]{0,24})/i);
      if (wm) {
        var wd = _extractDates(wm[1], year);
        if (wd.length) return _sundayToSaturday(wd[0].dt);
      }

      // Numeric range: "M/D[/Y] <sep> M/D[/Y]".
      m = pageText.match(new RegExp(
        '(\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?)\\s*' + SEP +
        '\\s*(\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?)', 'i'));
      if (m) {
        a = _extractDates(m[1], year)[0];
        b = _extractDates(m[2], year)[0];
        if (a && b) return { from: a.dt, to: b.dt };
      }

      // Month-name range: "Mon D[, Y] <sep> [Mon ]D[, Y]" (second side may omit the month).
      var MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
      m = pageText.match(new RegExp(
        '(' + MON + '\\s+\\d{1,2}(?:\\s*,?\\s*\\d{4})?)\\s*' + SEP +
        '\\s*((?:' + MON + '\\s+)?\\d{1,2}(?:\\s*,?\\s*\\d{4})?)', 'i'));
      if (m) {
        a = _extractDates(m[1], year)[0];
        b = _extractDates(m[2], year)[0];
        if (a && !b) {
          // Second side had no month word (e.g. "25, 2026") -> inherit month from first side.
          var dm = m[2].match(/(\d{1,2})/);
          var ym = m[2].match(/(\d{4})/);
          if (dm) {
            var yr = ym ? parseInt(ym[1], 10) : (a.hasYear ? a.dt.getFullYear() : year);
            var bd = _mkDate(yr, a.mo, parseInt(dm[1], 10));
            if (bd) b = { dt: bd };
          }
        }
        if (a && b) return { from: a.dt, to: b.dt };
      }

      return null;
    } catch (_e) {
      return null;
    }
  }

  function detectCrossMonth(sheetName) {
    // Detection must reflect the timesheet the user has OPEN on the page, never today's date.
    // Sources, most authoritative first:
    //   A) grid day-column header dates (what's rendered on screen)
    //   B) broadened page/header date range (or "Week of …")
    //   C) the imported sheet tab name (week-start)
    //   D) LAST RESORT: today -> return {isCross:false}. We deliberately do NOT raise a
    //      cross-month warning from today's calendar week alone, because that produced the
    //      false positive this fix targets (a July-only timesheet flagged Jul 26 - Aug 1).
    var week = _readGridWeekDates();
    if (!week) week = _readHeaderWeek();
    if (!week) {
      var base = _parseSheetNameDate(sheetName);
      if (base) week = _sundayToSaturday(base);
    }
    if (!week) return { isCross: false };

    if (week.from.getMonth() !== week.to.getMonth() ||
        week.from.getFullYear() !== week.to.getFullYear()) {
      return { isCross: true, from: week.from, to: week.to };
    }
    return { isCross: false };
  }

  function formatCrossMonthDates(from, to) {
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[from.getMonth()] + ' ' + from.getDate() + ' - ' +
           months[to.getMonth()]   + ' ' + to.getDate();
  }

  // ── OpenAir DOM helpers ────────────────────────────────────────────────────

  function enumerateCandidateRows() {
    var clientSelects = document.querySelectorAll('[id^="ts_c1_r"]');
    if (!clientSelects.length) return { rows: [], allOptions: [] };

    // Collect all options (keep _FIND -- filtered only during matching)
    var allOptions = Array.from(clientSelects[0].options)
      .filter(function (o) { return o.value && o.value !== ':'; })
      .map(function (o)    { return { value: o.value, label: o.text.trim() }; });

    var rows = [];
    clientSelects.forEach(function (sel) {
      var m = sel.id.match(/ts_c1_r(\d+)/);
      if (!m) return;
      var rowNum = parseInt(m[1], 10);
      var chosen = sel.options[sel.selectedIndex];
      if (chosen && chosen.value && chosen.value !== ':') {
        rows.push({ rowNum: rowNum, value: chosen.value, label: chosen.text.trim() });
      }
    });
    return { rows: rows, allOptions: allOptions };
  }

  function enumerateTaskOptions(rowNum) {
    var sel = document.getElementById('ts_c2_r' + rowNum);
    if (!sel) return [];
    return Array.from(sel.options)
      .filter(function (o) { return o.value && o.value !== '_FIND' && o.value !== ':' && o.value !== '' && o.value !== '0'; })
      .map(function (o)    { return { value: o.value, label: o.text.trim() }; });
  }

  // ── Fill helpers ───────────────────────────────────────────────────────────

  // Builds one OpenAir row per Client:Engagement value. OpenAir auto-loads a row's
  // Task options AND spawns the next empty row the instant a Client:Engagement is
  // committed on the empty-row control, so we simply commit each value in turn - no
  // "duplicate row" dance (which never triggered the task load and left tasks empty).
  // Returns an array parallel to ceValues giving the REAL OpenAir row number for each
  // value (null for blank/skipped), so callers never assume rows are 1..N sequential.
  async function exposeAndFillClientEngagement(ceValues) {
    var rowNums = [];
    if (!ceValues || ceValues.length === 0) return rowNums;

    for (var i = 0; i < ceValues.length; i++) {
      var ceVal = ceValues[i];

      if (!ceVal || ceVal === '' || ceVal === ':') {
        // Blank Client:Engagement — the user chose "- leave blank for import -", so we KEEP it
        // blank on the timesheet (no "Open Code Pending" substitution anywhere now).
        // OpenAir won't spawn a row for a blank value, so commit a TEMPORARY valid option
        // just to make the row exist (this loads tasks + spawns the next empty row), record
        // the row number, then reset that row's Client:Engagement back to blank.
        var erBlank = Array.from(document.querySelectorAll('[id^="ts_c1_r"]'))
          .find(function (s) { return /timesheetEmptyRowControl/.test(s.className); });
        if (!erBlank) { rowNums.push(null); continue; }
        var emB = erBlank.id.match(/ts_c1_r(\d+)/);
        var blankRowNum = emB ? parseInt(emB[1], 10) : null;
        var prevCountB = document.querySelectorAll('[id^="ts_c1_r"]').length;
        // First real option on the control = the throwaway value used to create the row.
        // Prefer "Open Code Pending" as the throwaway engagement (a universal one every user
        // has), else fall back to the first real option. Either way it's reset to blank below.
        var tempVal = null;
        for (var t = 0; t < erBlank.options.length; t++) {
          var oT = erBlank.options[t];
          if (oT.value && oT.value !== ':' && oT.value !== '_FIND' && /open code pending/i.test(oT.text || '')) { tempVal = oT.value; break; }
        }
        if (!tempVal) {
          for (var t2 = 0; t2 < erBlank.options.length; t2++) {
            var tv = erBlank.options[t2].value;
            if (tv && tv !== ':' && tv !== '_FIND') { tempVal = tv; break; }
          }
        }
        if (!tempVal) { rowNums.push(null); continue; } // no options at all — can't create a row
        erBlank.value = tempVal;
        erBlank.dispatchEvent(new Event('input',  { bubbles: true }));
        erBlank.dispatchEvent(new Event('change', { bubbles: true }));
        for (var wB = 0; wB < 60; wB++) {
          await delay(100);
          if (document.querySelectorAll('[id^="ts_c1_r"]').length > prevCountB) break;
        }
        // Reset the just-created row's Client:Engagement back to blank.
        var createdSel = document.getElementById('ts_c1_r' + blankRowNum);
        if (createdSel) {
          createdSel.value = ':';
          createdSel.dispatchEvent(new Event('input',  { bubbles: true }));
          createdSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        rowNums.push(blankRowNum);
        continue;
      }

      // Current empty-row Client:Engagement control (OpenAir always keeps exactly one).
      var emptyRow = Array.from(document.querySelectorAll('[id^="ts_c1_r"]'))
        .find(function (s) { return /timesheetEmptyRowControl/.test(s.className); });
      if (!emptyRow) throw new Error('Timesheet empty row control not found - are you on the weekly timesheet page?');

      var m = emptyRow.id.match(/ts_c1_r(\d+)/);
      var rowNum = m ? parseInt(m[1], 10) : null;
      var prevRowCount = document.querySelectorAll('[id^="ts_c1_r"]').length;

      // Commit it - OpenAir loads this row's Task options and spawns the next empty row.
      emptyRow.value = ceVal;
      emptyRow.dispatchEvent(new Event('input',  { bubbles: true }));
      emptyRow.dispatchEvent(new Event('change', { bubbles: true }));

      // Wait until a fresh empty row appears (confirms this row committed) or timeout.
      // Poll finely (100ms) so we continue the instant OpenAir spawns the next row.
      for (var w = 0; w < 60; w++) {           // up to ~6s
        await delay(100);
        if (document.querySelectorAll('[id^="ts_c1_r"]').length > prevRowCount) break;
      }
      rowNums.push(rowNum);
    }

    await delay(200); // let the last row's Task options finish loading
    return rowNums;
  }

  async function fillTimesheet(entries) {
    var results = { success: 0, failed: [], skipped: 0 };
    for (var entry of entries) {
      if (!entry.row) { results.skipped++; continue; }
      try {
        var inputId = 'ts_c' + entry.col + '_r' + entry.row;
        var notesId = 'ts_notes_c' + entry.col + '_r' + entry.row;
        var input   = document.getElementById(inputId);
        if (!input)         { results.failed.push({ day: entry.dayName, client: entry.clientEngagement, reason: 'cell not found on page' }); continue; }
        if (input.disabled) { results.failed.push({ day: entry.dayName, client: entry.clientEngagement, reason: 'input disabled (day may belong to another month)' }); continue; }
        input.value = entry.hours;
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (entry.notes) {
          await delay(200);
          var notesEl = document.getElementById(notesId);
          if (notesEl) {
            notesEl.click();
            await delay(350);
            var ta = document.getElementById('tm_notes');
            if (ta) {
              ta.value = entry.notes;
              ta.dispatchEvent(new Event('input',  { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await delay(200);
            var ok = document.querySelector('.dialogOkButton');
            if (ok) ok.click();
            await delay(200);
          }
        }
        results.success++;
      } catch (err) {
        results.failed.push({ day: entry.dayName || '?', client: entry.clientEngagement || '', reason: err.message });
      }
    }
    return results;
  }

  // Find a row's "Open Code Pending" task option value (label like "1: Open Code Pending").
  // Matched from that row's own live options, so the correct per-engagement task id is used.
  function findOpenCodePendingTask(taskOpts) {
    var norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
    var strip = function (lbl) { return norm(String(lbl).replace(/^\s*\d+\s*:\s*/, '')); };
    var opts = taskOpts || [];
    var hit = opts.find(function (o) { return strip(o.label) === 'open code pending'; }) ||
              opts.find(function (o) { return norm(o.label).indexOf('open code pending') >= 0; });
    return hit ? hit.value : null;
  }

  async function fillTasksAndHours(entries, taskMap) {
    var seen = new Set();
    for (var e of entries) {
      var rowNum = e.row;
      if (!rowNum || seen.has(rowNum)) continue;
      seen.add(rowNum);
      var taskVal = taskMap.get(rowNum);
      // Task left blank STAYS blank — no "Open Code Pending" default. Only set it if we matched one.
      if (taskVal) {
        var sel = document.getElementById('ts_c2_r' + rowNum);
        if (sel) {
          sel.value = taskVal;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(300);
        }
      }
    }
    return fillTimesheet(entries);
  }

  // ── Excel parsing ──────────────────────────────────────────────────────────

  function detectDow(cell) {
    if (cell instanceof Date) return cell.getDay();
    if (typeof cell === 'number' && cell > 40000 && cell < 60000)
      return new Date((cell - 25569) * 86400 * 1000).getUTCDay();
    if (typeof cell === 'string') {
      var t = cell.trim();
      for (var p of DAY_PATS) if (p.re.test(t)) return p.dow;
    }
    return -1;
  }

  function parseSheet(wb, sheetName) {
    var ws = wb.Sheets[sheetName];
    if (!ws) throw new Error('Sheet "' + sheetName + '" not found.');
    var a1 = ws['A1'];
    if (!a1 || !/client/i.test(String(a1.v || '')))
      throw new Error('Cell A1 must say "Client : Engagement". Is this the right sheet?');
    var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    if (!rows || rows.length < 2) throw new Error('Sheet appears empty.');
    var header  = rows[0];
    var dayCols = [];
    for (var i = 0; i < header.length; i++) {
      var dow = detectDow(header[i]);
      if (dow >= 0) dayCols.push({ idx: i, col: DOW_TO_COL[dow], day: DAY_NAMES[dow], notesIdx: i + 1 });
    }
    if (dayCols.length === 0)
      [2,4,6,8,10,12,14].forEach(function (pos, d) {
        dayCols.push({ idx: pos, col: DOW_TO_COL[d], day: DAY_NAMES[d], notesIdx: pos + 1 });
      });

    var entries = []; var skippedCells = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r]; if (!row) continue;
      var client = String(row[0] || '').trim();
      var task   = String(row[1] || '').trim();
      // Skip only summary/total rows. A row is included whenever ANY day has time or notes,
      // even if Client/Task were left blank in Excel.
      if (/^total/i.test(client)) continue;
      // ONE grid row per Excel row — NEVER consolidate. The row index makes every row unique, so
      // two rows with the SAME Client + Task (e.g. two "Cerebras / NS Admin" rows) stay separate
      // and their day values never overwrite each other. The review grid mirrors the sheet 1:1.
      var groupKey = client + '\x00' + task + '\x00#' + r;
      for (var dc of dayCols) {
        var raw      = row[dc.idx];
        var notes    = String(row[dc.notesIdx] || '').trim();
        var hours    = parseFloat(raw);
        var hasHours = !(isNaN(hours) || hours <= 0);
        if (!hasHours && !notes) { skippedCells++; continue; } // nothing entered this day
        entries.push({ clientEngagement: client, task: task, hours: hasHours ? hours : 0, notes: notes,
                       col: dc.col, dayName: dc.day, row: null, groupKey: groupKey });
      }
    }
    if (entries.length === 0) throw new Error('No time entries found. Check hours are filled in.');
    return { entries: entries, skippedCells: skippedCells };
  }

  // ── Match scoring ──────────────────────────────────────────────────────────
  // Scores the Excel client name against one OpenAir option label.
  // ONLY uses the client:engagement cell from Excel - never the task column.
  // This prevents "Cerebras" matching "Crexi" just because they share a task suffix.

  function scoreMatch(clientKey, normLabel) {
    if (!clientKey || !normLabel) return 0;
    // Exact match
    if (clientKey === normLabel) return 1.0;
    // Label starts with the full client key (e.g. "Empyrean" -> "Empyrean : Project X")
    if (normLabel.startsWith(clientKey + ' ') || normLabel.startsWith(clientKey + ':')) return 0.95;
    // All significant client words appear in the label
    var clientWords = clientKey.split(' ').filter(function (w) { return w.length > 2; });
    var labelWords  = normLabel.split(' ');
    if (clientWords.length > 0 &&
        clientWords.every(function (w) { return labelWords.indexOf(w) >= 0; })) return 0.9;
    // Client key is a substring of the label (at least 4 chars to avoid noise)
    if (clientKey.length >= 4 && normLabel.indexOf(clientKey) >= 0) return 0.85;
    // Dice coefficient on client name only
    return dice(clientKey, normLabel);
  }

  // Scores an Excel task string against the live OpenAir task option labels and
  // returns the best-matching option value, or null if nothing clears threshold.
  // OpenAir task labels carry an ID prefix like "26: Phase 3 …" - strip it before
  // scoring so the free-text Excel task can match. Mirrors the Client:Engagement
  // matching (scoreMatch + MATCH_MIN threshold).
  function resolveTaskForRow(taskText, taskOpts) {
    if (!_autoDefault) return null; // auto-default off -> leave the task blank for import
    if (!taskText || !taskOpts || taskOpts.length === 0) return null;
    var taskKey = normalise(taskText);
    if (!taskKey) return null;
    var best = null, bestScore = 0;
    for (var o of taskOpts) {
      var lbl = normalise(String(o.label).replace(/^\s*\d+\s*:\s*/, ''));
      var s = scoreMatch(taskKey, lbl);
      if (s > bestScore) { bestScore = s; best = o; }
    }
    return (best && bestScore >= MATCH_MIN) ? best.value : null;
  }

  // ── Row resolution ─────────────────────────────────────────────────────────
  // Handles duplicate client:engagement rows (each gets a distinct OpenAir rowNum).
  // Cache is keyed by client name only so multiple tasks under the same client
  // all resolve to the same option value.

  function resolveRows(rawEntries, existingRows, allOptions) {
    var matchOptions = allOptions.filter(function (o) { return o.value !== '_FIND'; });
    var passCache    = new Map(); // clientKey -> optionValue
    var usedRowNums  = new Set(); // OpenAir rowNums already assigned this pass

    return rawEntries.map(function (entry) {
      // auto-default off -> don't guess; leave Client:Engagement blank ("- leave blank for import -")
      if (!_autoDefault) return Object.assign({}, entry, { matchedValue: null, matchedLabel: null, row: null });
      var clientKey = normalise(entry.clientEngagement); // match on C:E only, NOT task

      var optVal, optLabel;

      if (rowCache.has(clientKey)) {
        optVal = rowCache.get(clientKey);
        var rc = matchOptions.find(function (o) { return o.value === optVal; });
        optLabel = rc ? rc.label : optVal;
      } else if (passCache.has(clientKey)) {
        optVal = passCache.get(clientKey);
        var pc = matchOptions.find(function (o) { return o.value === optVal; });
        optLabel = pc ? pc.label : optVal;
      } else {
        var bestOpt = null, bestScore = 0;
        for (var opt of matchOptions) {
          var s = scoreMatch(clientKey, normalise(opt.label));
          if (s > bestScore) { bestScore = s; bestOpt = opt; }
        }
        // Require a strong, name-present match (>= MATCH_MIN); else leave blank.
        optVal   = (bestOpt && bestScore >= MATCH_MIN) ? bestOpt.value : null;
        optLabel = (bestOpt && bestScore >= MATCH_MIN) ? bestOpt.label : null;
        passCache.set(clientKey, optVal);
      }

      // Find an OpenAir row with this optionValue not yet used in this pass
      var existRow = optVal
        ? existingRows.find(function (r) { return r.value === optVal && !usedRowNums.has(r.rowNum); })
        : null;
      if (existRow) usedRowNums.add(existRow.rowNum);

      return Object.assign({}, entry, {
        matchedValue: optVal,
        matchedLabel: optLabel,
        row: existRow ? existRow.rowNum : null,
      });
    });
  }

  // ── Sheet picker modal ─────────────────────────────────────────────────────

  function showSheetPicker(names) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'oai-modal-overlay';

      var modal = document.createElement('div');
      modal.className = 'oai-modal oai-modal--sheet';
      modal.innerHTML =
        '<div class="oai-modal-header">' +
          '<span class="oai-modal-title">Select Worksheet</span>' +
          '<div class="oai-modal-header-right">' +
            '<button class="oai-sort-btn" id="oai-sheet-sort" title="Toggle sort order">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l4-4 4 4"/><path d="M7 5v14"/><path d="M21 15l-4 4-4-4"/><path d="M17 19V5"/></svg>' +
            '</button>' +
            '<button class="oai-modal-x" id="oai-sheet-x" aria-label="Close">&times;</button>' +
          '</div>' +
        '</div>' +
        '<div class="oai-sheet-list" id="oai-sheet-list"></div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      var selected  = null;
      var sortAsc   = false;
      var list      = modal.querySelector('#oai-sheet-list');
      var sortBtn   = modal.querySelector('#oai-sheet-sort');

      function renderList() {
        list.innerHTML = '';
        var sorted = sortAsc ? names.slice() : names.slice().reverse();
        sorted.forEach(function (name) {
          var btn = document.createElement('button');
          btn.className = 'oai-sheet-item' + (name === selected ? ' oai-sheet-item--selected' : '');
          btn.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:#64748b"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            '<span>' + esc(name) + '</span>';
          btn.addEventListener('click', function () {
            document.body.removeChild(overlay);
            resolve(name);
          });
          list.appendChild(btn);
        });
      }

      renderList();
      sortBtn.addEventListener('click', function () { sortAsc = !sortAsc; renderList(); });
      modal.querySelector('#oai-sheet-x').addEventListener('click', function () { document.body.removeChild(overlay); resolve(null); });
    });
  }

  // ── Grid HTML builders ─────────────────────────────────────────────────────

  function _buildDayRows(rowKeys, rowMap) {
    // Shared pivot builder -- returns { html, dayTotals, grandTotal }
    var dayTotals  = [0,0,0,0,0,0,0];
    var grandTotal = 0;
    var html       = '';

    for (var key of rowKeys) {
      var r        = rowMap.get(key);
      var rowTotal = r.days.reduce(function (s, d) { return s + (d ? d.hours : 0); }, 0);
      grandTotal  += rowTotal;

      html += '<tr class="oai-conf-row" data-key="' + esc(key) + '">';
      // Client:Engagement cell placeholder -- caller fills this
      html += r._clientCellHtml;

      for (var d = 0; d < 7; d++) {
        var cell = r.days[d];
        var hasHours = cell && cell.hours > 0;
        var hasNotes = cell && cell.notes;
        if (hasHours || hasNotes) {
          if (hasHours) dayTotals[d] += cell.hours;
          var tipText = cell.notes || 'No notes';
          var ind = cell.notes
            ? '<span class="oai-conf-ind oai-conf-ind--yes" data-oai-tip="Notes present">&#10003;</span>'
            : '<span class="oai-conf-ind oai-conf-ind--no" data-oai-tip="No notes">&#10005;</span>';
          var hoursText = hasHours ? cell.hours.toFixed(2) : '&mdash;';
          html += '<td class="oai-conf-td oai-conf-td--hours oai-conf-td--filled" data-oai-tip="' + esc(tipText) + '"><span class="oai-cell-content">' + hoursText + ind + '</span></td>';
        } else {
          html += '<td class="oai-conf-td oai-conf-td--hours oai-conf-td--empty">&mdash;</td>';
        }
      }
      html += '<td class="oai-conf-td oai-conf-td--rowtotal">' + (rowTotal > 0 ? rowTotal.toFixed(2) : '') + '</td>';
      html += '</tr>';
    }
    return { html: html, dayTotals: dayTotals, grandTotal: grandTotal };
  }

  function _footerRow(dayTotals, grandTotal, extraLeadCols) {
    var html = '<tr class="oai-conf-row-footer">';
    for (var x = 0; x < extraLeadCols; x++) {
      html += x === extraLeadCols - 1
        ? '<td class="oai-conf-td oai-conf-td--footer-label">TOTAL</td>'
        : '<td class="oai-conf-td oai-conf-td--footer-label"></td>';
    }
    for (var d = 0; d < 7; d++) {
      var t = dayTotals[d];
      html += t > 0
        ? '<td class="oai-conf-td oai-conf-td--daytotal">' + t.toFixed(2) + '</td>'
        : '<td class="oai-conf-td oai-conf-td--daytotal oai-conf-td--empty">&mdash;</td>';
    }
    html += '<td class="oai-conf-td oai-conf-td--grandtotal">' + grandTotal.toFixed(2) + '</td></tr>';
    return html;
  }

  var LEGEND_HTML =
    '<div class="oai-conf-legend">' +
      '<span><span class="oai-conf-ind oai-conf-ind--yes">&#10003;</span> Notes present</span>' +
      '<span><span class="oai-conf-ind oai-conf-ind--no">&#10005;</span> No notes</span>' +
    '</div>';

  function _statsHtml(stats) {
    return '<div class="oai-conf-stats-banner">Found <strong>' + stats.entries +
      '</strong> time entries for <strong>' + stats.dataRows +
      '</strong> client/task row(s).</div>';
  }

  // Phase 1 grid: Client:Engagement dropdown | Sun-Sat | Total
  function buildPhase1Grid(entries, allOptions, matchMap, stats) {
    var rowKeys = [], rowMap = new Map();
    for (var e of entries) {
      var key = e.groupKey;
      if (!rowMap.has(key)) {
        rowKeys.push(key);
        rowMap.set(key, { client: e.clientEngagement, task: e.task, days: new Array(7).fill(null), _clientCellHtml: '' });
      }
      var rec = rowMap.get(key);
      var dow = COL_TO_DOW[e.col];
      if (dow !== undefined) rec.days[dow] = { hours: e.hours, notes: e.notes };
    }

    var regularOpts = allOptions.filter(function (o) { return o.value !== '_FIND'; });

    // Build client cell HTML per row
    for (var key of rowKeys) {
      var r = rowMap.get(key);
      if (regularOpts.length === 0) {
        r._clientCellHtml = '<td class="oai-conf-td oai-conf-td--client oai-conf-td--plaintext">' + esc(r.client) + '</td>';
      } else {
        var curVal = matchMap.get(key);
        var opts   = '<option value="">- leave blank for import -</option>';
        for (var o of regularOpts) {
          opts += '<option value="' + esc(o.value) + '"' + (o.value === curVal ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }
        // Note: "Find more..." (_FIND) is intentionally omitted. The native OpenAir dialog
        // cannot reliably appear above the injected modal overlay due to CSS stacking context
        // constraints - the injected overlay owns its own stacking context and blocks native
        // dialogs from rendering on top of it, regardless of z-index on child elements.
        r._clientCellHtml = '<td class="oai-conf-td oai-conf-td--client"><select class="oai-conf-sel oai-conf-sel--client" data-key="' + esc(key) + '">' + opts + '</select></td>';
      }
    }

    var body   = _buildDayRows(rowKeys, rowMap);
    var footer = _footerRow(body.dayTotals, body.grandTotal, 1);

    return '<div class="oai-conf-hint-legend-row">' +
        '<div class="oai-conf-step-hint">' +
          'Step 1: Review <strong>Client : Engagement</strong> column, time, and notes<br>' +
          '- If you can\'t find your <strong>Client : Engagement</strong>, select - leave blank for import -' +
        '</div>' +
        '<div class="oai-conf-right-col">' +
          (stats._fileName || stats._sheetName ? '<div class="oai-conf-sheet-label">' + (stats._fileName ? 'file name: <strong>' + esc(stats._fileName) + '</strong><br>' : '') + 'sheet name: <strong>' + esc(stats._sheetName || '') + '</strong>' + '</div>' : '') +
          LEGEND_HTML +
        '</div>' +
      '</div>' +
      '<div class="oai-conf-scroll"><table class="oai-conf-table"><thead><tr>' +
      '<th class="oai-conf-th oai-conf-th--client">CLIENT : ENGAGEMENT</th>' +
      DAY_NAMES.map(function (d) { return '<th class="oai-conf-th oai-conf-th--day">' + d.toUpperCase() + '</th>'; }).join('') +
      '<th class="oai-conf-th oai-conf-th--total">TOTAL</th>' +
      '</tr></thead><tbody>' + body.html + footer + '</tbody></table></div>' +
      _statsHtml(stats);
  }

  // Phase 2 grid: Client:Engagement (read-only) | Task dropdown | Sun-Sat | Total
  function buildPhase2Grid(entries, rowTaskOptions, taskMap, meta) {
    var rowKeys = [], rowMap = new Map();
    for (var e of entries) {
      var key = e.groupKey;
      if (!rowMap.has(key)) {
        rowKeys.push(key);
        rowMap.set(key, {
          client:       e.clientEngagement,
          task:         e.task,
          matchedLabel: e.matchedLabel,
          row:          e.row,
          days:         new Array(7).fill(null),
          _clientCellHtml: '',
        });
      }
      var rec = rowMap.get(key);
      var dow = COL_TO_DOW[e.col];
      if (dow !== undefined) rec.days[dow] = { hours: e.hours, notes: e.notes };
    }

    // Build client+task cells per row
    for (var key of rowKeys) {
      var r        = rowMap.get(key);
      var isBlankCE = !r.matchedLabel; // user left "- leave blank for import -" in Step 1
      var taskOpts = r.row ? (rowTaskOptions.get(r.row) || []) : [];
      var curTask  = taskMap.get(r.row) || '';
      if (!isBlankCE && !curTask && taskOpts.length > 0) {
        var _autoTask = resolveTaskForRow(r.task, taskOpts);
        if (_autoTask) { curTask = _autoTask; if (r.row) taskMap.set(r.row, _autoTask); }
      }

      // Client:Engagement -- read-only. Reflect the STEP 1 choice: the matched label, or the blank
      // placeholder when the user left it blank -- never the raw Excel client text.
      r._clientCellHtml = '<td class="oai-conf-td oai-conf-td--client oai-conf-td--readonly">' +
        (isBlankCE ? '<span class="oai-conf-ce-blank">- leave blank for import -</span>' : esc(r.matchedLabel)) + '</td>';

      // Task dropdown. Blank-engagement rows have no tasks to load, so they never show a loading spinner.
      var _taskLoading = !isBlankCE && taskOpts.length === 0;
      var opts = '<option value="">- leave blank for import -</option>';
      for (var o of taskOpts) {
        opts += '<option value="' + esc(o.value) + '"' + (o.value === curTask ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }
      r._clientCellHtml += '<td class="oai-conf-td oai-conf-td--task' + (_taskLoading ? ' oai-conf-td--task-loading' : '') + '">' +
        '<select class="oai-conf-sel oai-conf-sel--task" data-row="' + (r.row || '') + '"' + (_taskLoading ? ' data-loading="1"' : '') + '>' +
        opts + '</select></td>';
    }

    var body   = _buildDayRows(rowKeys, rowMap);
    var footer = _footerRow(body.dayTotals, body.grandTotal, 2);

    var _metaLabel = (meta && (meta.fileName || meta.sheetName))
      ? '<div class="oai-conf-sheet-label">' + (meta.fileName ? 'file name: <strong>' + esc(meta.fileName) + '</strong><br>' : '') + 'sheet name: <strong>' + esc(meta.sheetName || '') + '</strong>' + '</div>'
      : '';
    return '<div class="oai-conf-hint-legend-row">' +
        '<div class="oai-conf-step-hint oai-conf-step-hint--bottom">' +
          'Step 2: Review <strong>Task</strong> - if you can\'t find your Task, select - leave blank for import -' +
        '</div>' +
        '<div class="oai-conf-right-col">' +
          _metaLabel +
          LEGEND_HTML +
        '</div>' +
      '</div>' +
      '<div class="oai-conf-scroll"><table class="oai-conf-table"><thead><tr>' +
      '<th class="oai-conf-th oai-conf-th--client">CLIENT : ENGAGEMENT</th>' +
      '<th class="oai-conf-th oai-conf-th--task">TASK</th>' +
      DAY_NAMES.map(function (d) { return '<th class="oai-conf-th oai-conf-th--day">' + d.toUpperCase() + '</th>'; }).join('') +
      '<th class="oai-conf-th oai-conf-th--total">TOTAL</th>' +
      '</tr></thead><tbody>' + body.html + footer + '</tbody></table></div>' +
      (meta && meta.stats ? _statsHtml(meta.stats) : '');
  }

  // ── "Just fill time & notes" mode ────────────────────────────────────────────
  // Read-only review: Client:Engagement + Task are shown as plain Excel text (no dropdowns).
  // On Fill, handleFile leaves BOTH blank on the timesheet and writes only hours + notes.
  function buildTimeNotesGrid(entries, meta) {
    var rowKeys = [], rowMap = new Map();
    for (var e of entries) {
      var key = e.groupKey;
      if (!rowMap.has(key)) {
        rowKeys.push(key);
        rowMap.set(key, { client: e.clientEngagement, task: e.task, days: new Array(7).fill(null), _clientCellHtml: '' });
      }
      var rec = rowMap.get(key);
      var dow = COL_TO_DOW[e.col];
      if (dow !== undefined) rec.days[dow] = { hours: e.hours, notes: e.notes };
    }
    for (var key of rowKeys) {
      var r = rowMap.get(key);
      r._clientCellHtml =
        '<td class="oai-conf-td oai-conf-td--client oai-conf-td--readonly">' + esc(r.client || '\u2014') + '</td>' +
        '<td class="oai-conf-td oai-conf-td--task"><select class="oai-conf-sel oai-conf-sel--readonly" tabindex="-1" aria-readonly="true"><option>' + esc(r.task || '\u2014') + '</option></select></td>';
    }
    var body   = _buildDayRows(rowKeys, rowMap);
    var footer = _footerRow(body.dayTotals, body.grandTotal, 2);
    var _metaLabel = (meta && (meta.fileName || meta.sheetName))
      ? '<div class="oai-conf-sheet-label">' + (meta.fileName ? 'file name: <strong>' + esc(meta.fileName) + '</strong><br>' : '') + 'sheet name: <strong>' + esc(meta.sheetName || '') + '</strong>' + '</div>'
      : '';
    return '<div class="oai-conf-hint-legend-row">' +
        '<div class="oai-conf-step-hint oai-conf-step-hint--bottom">' +
          'Time &amp; notes only \u2014 <strong>Client : Engagement</strong> and <strong>Task</strong> are shown for reference and will be left blank on your timesheet' +
        '</div>' +
        '<div class="oai-conf-right-col">' + _metaLabel + LEGEND_HTML + '</div>' +
      '</div>' +
      '<div class="oai-conf-scroll"><table class="oai-conf-table"><thead><tr>' +
      '<th class="oai-conf-th oai-conf-th--client">CLIENT : ENGAGEMENT</th>' +
      '<th class="oai-conf-th oai-conf-th--task">TASK</th>' +
      DAY_NAMES.map(function (d) { return '<th class="oai-conf-th oai-conf-th--day">' + d.toUpperCase() + '</th>'; }).join('') +
      '<th class="oai-conf-th oai-conf-th--total">TOTAL</th>' +
      '</tr></thead><tbody>' + body.html + footer + '</tbody></table></div>' +
      (meta && meta.stats ? _statsHtml(meta.stats) : '');
  }

  // Single read-only modal for the "just fill time & notes" preference. Reuses the same modal
  // shell + grid helpers as the two-phase flow; resolves { confirmed, goBack }.
  function showTimeNotesOnly(entries, meta, crossMonth) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'oai-modal-overlay';
      var modal = document.createElement('div');
      modal.className = 'oai-modal oai-modal--conf';

      var crossMonthHtml = '';
      if (crossMonth && crossMonth.isCross) {
        var dateRange = formatCrossMonthDates(crossMonth.from, crossMonth.to);
        crossMonthHtml =
          '<div class="oai-conf-cross-month-warning">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>' +
            ' This timesheet spans two months (' + esc(dateRange) + '). ' + (CROSS_MONTH_ENABLED ? 'The tool will fill both months.' : '<br>Only the current month will be filled, switch to the other month and run again') +
          '</div>';
      }

      modal.innerHTML =
        '<div class="oai-conf-header">' +
          '<span class="oai-conf-title-group">' +
            '<span class="oai-conf-title">Fill Time &amp; Notes Only</span>' +
          '</span>' +
          '<button class="oai-modal-x" id="oai-tn-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="oai-conf-inner">' + buildTimeNotesGrid(entries, meta) + '</div>' +
        '<div class="oai-conf-actions">' +
          crossMonthHtml +
          '<div class="oai-conf-buttons">' +
            '<button class="oai-btn oai-btn--secondary" id="oai-tn-back"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg> Back</button>' +
            '<button class="oai-btn oai-btn--primary" id="oai-tn-ok">Fill Timesheet</button>' +
          '</div>' +
        '</div>';

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      attachTooltips(modal);

      function close(confirmed, goBack) {
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve({ confirmed: confirmed, goBack: !!goBack });
      }
      modal.querySelector('#oai-tn-ok').addEventListener('click',   function () { close(true); });
      modal.querySelector('#oai-tn-back').addEventListener('click', function () { close(false, true); });
      modal.querySelector('#oai-tn-x').addEventListener('click',    function () { close(false); });
    });
  }

  // ── _FIND handler ──────────────────────────────────────────────────────────

  function handleFindMore(key, ourSel, matchMap, overlay) {
    // Use an unset OpenAir row as a scratch select for the find dialog
    var pageSelects = Array.from(document.querySelectorAll('[id^="ts_c1_r"]'));
    var scratchSel  = pageSelects.find(function (s) { return !s.value || s.value === ':'; }) || pageSelects[0];
    if (!scratchSel) { ourSel.value = matchMap.get(key) || ''; return; }

    // Make overlay transparent so user can interact with OpenAir's dialog
    overlay.classList.add('oai-modal-overlay--passthrough');

    var prevVal = scratchSel.value;
    scratchSel.value = '_FIND';
    scratchSel.dispatchEvent(new Event('change', { bubbles: true }));

    var polls = 0;
    var iv = setInterval(function () {
      polls++;
      var newVal = scratchSel.value;
      var done   = (newVal !== '_FIND' && newVal !== prevVal) || polls > 300;
      if (!done) return;
      clearInterval(iv);
      overlay.classList.remove('oai-modal-overlay--passthrough');

      if (newVal && newVal !== '_FIND' && newVal !== prevVal) {
        // Add option to our dropdown if it isn't there already
        var existing = Array.from(ourSel.options).find(function (o) { return o.value === newVal; });
        if (!existing) {
          var pageOpt = Array.from(scratchSel.options).find(function (o) { return o.value === newVal; });
          var newOpt  = document.createElement('option');
          newOpt.value = newVal;
          newOpt.text  = pageOpt ? pageOpt.text : newVal;
          var findOpt  = ourSel.querySelector('option[value="_FIND"]');
          ourSel.insertBefore(newOpt, findOpt || null);
        }
        ourSel.value = newVal;
        matchMap.set(key, newVal);

        // Restore scratch row
        scratchSel.value = prevVal;
        if (prevVal) scratchSel.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Cancelled -- revert our select and restore scratch
        ourSel.value = matchMap.get(key) || '';
        scratchSel.value = prevVal;
        if (prevVal) scratchSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 200);
  }

  function attachPhase1Events(container, matchMap, overlay) {
    container.querySelectorAll('.oai-conf-sel--client').forEach(function (sel) {
      var key = sel.dataset.key;
      if (sel.value) matchMap.set(key, sel.value);
      sel.addEventListener('change', function () {
        if (this.value === '_FIND') {
          handleFindMore(key, this, matchMap, overlay);
          return;
        }
        matchMap.set(key, this.value || null);
      });
    });
  }


  // ── Save / navigation helpers ──────────────────────────────────────────────

  // Poll until all given row task selects have loaded options (or timeout)
  async function waitForTaskOptions(rowNums, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
      var ready = rowNums.every(function (r) {
        var sel = document.getElementById('ts_c2_r' + r);
        return sel && sel.options.length > 1;
      });
      if (ready) break;
      await delay(100);
    }
    await delay(100); // small buffer after options appear
  }

  // Poll until the timesheet grid reappears (after page navigation)
  async function waitForTimesheetGrid(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.querySelector(GRID_SEL)) return;
      await delay(300);
    }
    throw new Error('Timed out waiting for timesheet grid to load.');
  }

  // Click the "Go to [next month] timesheet" link OpenAir shows after a cross-month save
  async function clickNextMonthLink() {
    var link = Array.from(document.querySelectorAll('a,button,input[type="button"]')).find(function (el) {
      return /go to.+timesheet/i.test((el.textContent || el.value || '').trim());
    });
    if (!link) throw new Error('"Go to next month timesheet" link not found. Please navigate manually.');
    clearBeforeUnload();
    link.click();
    await delay(500);
  }

  // Completion modal. `results` = { success, failed:[{day,client,reason}], skipped }.
  // The Audit Log only appears when something failed. 'surprise' rolls an emote in place.
  function showCompletionModal(results) {
    return new Promise(function (resolve) {
      var failed = (results && results.failed) ? results.failed : [];
      var hasFailures = failed.length > 0;

      var auditHtml = '';
      if (hasFailures) {
        var rowsHtml = failed.map(function (f) {
          return '<tr>' +
            '<td class="oai-audit-day">' + esc(f.day || '') + '</td>' +
            '<td class="oai-audit-client">' + esc(f.client || '') + '</td>' +
            '<td class="oai-audit-reason">' + esc(f.reason || '') + '</td>' +
          '</tr>';
        }).join('');
        var summary = esc(failed.length + ' ' + (failed.length === 1 ? 'entry' : 'entries') + ' could not be entered');
        auditHtml =
          '<div class="oai-audit">' +
            '<div class="oai-audit-title">Audit Log</div>' +
            '<div class="oai-audit-summary">' + summary + '</div>' +
            '<div class="oai-audit-scroll"><table class="oai-audit-table">' +
              '<thead><tr><th>Day</th><th>Client : Engagement</th><th>Issue</th></tr></thead>' +
              '<tbody>' + rowsHtml + '</tbody>' +
            '</table></div>' +
          '</div>';
      }

      var overlay = document.createElement('div');
      overlay.className = 'oai-modal-overlay';
      var modal = document.createElement('div');
      modal.className = 'oai-modal oai-modal--completion';
      modal.innerHTML =
        '<div class="oai-conf-header">' +
          '<span class="oai-conf-title">Complete</span>' +
        '</div>' +
        '<div class="oai-completion-body">' +
          '<div class="oai-completion-icon">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
          '</div>' +
          '<p class="oai-completion-msg">thank you for using the extension</p>' +
          auditHtml +
        '</div>' +
        '<div class="oai-conf-actions">' +
          (_hideSurprise ? '' : '<button class="oai-btn oai-btn--secondary" id="oai-surprise">surprise</button>') +
          '<div class="oai-conf-buttons">' +
            '<button class="oai-btn oai-btn--primary" id="oai-done-close">Close</button>' +
          '</div>' +
        '</div>';
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Warm the emote cache in the background so the surprise reveal is quick.
      if (!_hideSurprise) {
        ((window.OAI_GIFS && window.OAI_GIFS.length) ? window.OAI_GIFS : OAI_GIFS_FALLBACK)
          .forEach(function (g) { if (g && g.url) { var pre = new Image(); pre.src = g.url; } });
      }

      modal.querySelector('#oai-done-close').addEventListener('click', function () {
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve();
      });

      // 'surprise' - roll a gif and show it (with its odds); the page's CSP allows
      // chrome-extension: images, so a direct URL renders fine. Hide the button after use.
      var surpriseBtn = modal.querySelector('#oai-surprise');
      if (surpriseBtn) surpriseBtn.addEventListener('click', function () {
        var picked = rollGif();
        if (!picked) return;
        var body = modal.querySelector('.oai-completion-body');
        var btn  = modal.querySelector('#oai-surprise');
        if (btn) btn.style.display = 'none';
        var title = modal.querySelector('.oai-conf-title');
        if (title) title.textContent = 'Surprise'; // header becomes "Surprise" for the gif view

        // Show a spinner while the gif loads, then reveal the gif + subtext AT THE SAME TIME
        // (revealing the subtext first would spoil the surprise).
        body.innerHTML = '<div class="oai-gif-loading"><span class="oai-spinner oai-spinner--lg"></span></div>';

        var revealed = false;
        function reveal() {
          if (revealed) return; revealed = true;
          body.innerHTML =
            '<img src="' + esc(picked.url) + '" class="oai-gif-img" alt="' + esc(picked.alt) + '">' +
            '<div class="oai-gif-chance">this gif had a <strong>' + picked.chance + '%</strong> chance of appearing!</div>' +
            (picked.reward ? '<div class="oai-gif-reward">' + esc(picked.reward) + '</div>' : '');
        }

        var pre = new Image();
        pre.onload  = reveal;   // image is cached now, so the reveal renders it instantly
        pre.onerror = reveal;   // still reveal (rather than spin forever) if it fails to load
        pre.src = picked.url;
        if (pre.complete) reveal();               // already cached from the preload
        setTimeout(reveal, 4000);                  // safety net
      });
    });
  }

  // ── Loading modal ──────────────────────────────────────────────────────────

  // gifs.js (a separate content-script file) is the editable source for the emote list
  // via window.OAI_GIFS. This inline copy is ONLY used as a fallback if that global didn't
  // load, so the surprise button never dead-ends. Edit gifs.js to change the list.
  var OAI_GIFS_FALLBACK = [
    { url: 'https://cdn3.emoji.gg/emojis/366752-cat.gif',                   alt: 'cat' },
    { url: 'https://cdn3.emoji.gg/emojis/666930-catrun.gif',               alt: 'CatRun' },
    { url: 'https://cdn3.emoji.gg/emojis/257763-dancingcat.gif',           alt: 'DancingCat' },
    { url: 'https://cdn3.emoji.gg/emojis/656926-wiggletailcat.gif',        alt: 'wiggletailcat' },
    { url: 'https://cdn3.emoji.gg/emojis/79967-happy-shiba-tailwag.gif',   alt: 'happy_shiba_tailwag' },
    { url: 'https://cdn3.emoji.gg/emojis/679076-dogkeyboard.gif',          alt: 'DogKeyboard' },
    { url: 'https://cdn3.emoji.gg/emojis/996211-pikachu.gif',              alt: 'pikachu' },
    { url: 'https://cdn3.emoji.gg/emojis/700719-hellokittysleighride.gif', alt: 'HelloKittySleighRide' },
    { url: 'https://cdn3.emoji.gg/emojis/281357-christmashellokitty.gif',  alt: 'ChristmasHelloKitty' },
    { url: 'https://cdn3.emoji.gg/emojis/747946-yoshi.gif',                alt: 'Yoshi' },
    { url: 'https://cdn3.emoji.gg/emojis/136245-sneakycat.gif',            alt: 'sneakycat', chance: 5 },
    { url: 'https://cdn3.emoji.gg/emojis/3516-scubbacat.gif',              alt: 'Scubbacat', chance: 1 },
    { url: 'https://cdn3.emoji.gg/emojis/623251-shocked.gif',              alt: 'shocked',   chance: 1 },
    { url: 'https://cdn3.emoji.gg/emojis/29323-doggorun.gif',              alt: 'Doggorun',  chance: 2 },
    { url: 'https://cdn3.emoji.gg/emojis/8196-yoshi-bonk.gif',             alt: 'yoshi_bonk', chance: 1 },
    { url: 'https://cdn3.emoji.gg/emojis/13344-cat-wtf.gif',               alt: 'cat_wtf', chance: 0.5, reward: 'please screenshot this to Q, he owes you a coffee' },
  ];

  // Build the weight for every gif. Entries with a pinned `chance` keep it; entries WITHOUT
  // one are RANDOMLY assigned a share of the leftover budget so that the grand total is
  // exactly 100%. Computed once per session (memoised) so the displayed odds stay stable.
  var _gifWeights = null, _gifWeightsLen = -1;
  function computeGifWeights(list) {
    var pinnedSum = 0, unpinned = [];
    list.forEach(function (g, i) { if (typeof g.chance === 'number') pinnedSum += g.chance; else unpinned.push(i); });
    var budget  = Math.max(0, 100 - pinnedSum);
    var weights = list.map(function (g) { return typeof g.chance === 'number' ? g.chance : 0; });
    if (unpinned.length) {
      var rand = unpinned.map(function () { return Math.random(); });
      var rsum = rand.reduce(function (a, b) { return a + b; }, 0) || 1;
      unpinned.forEach(function (idx, k) { weights[idx] = budget * rand[k] / rsum; }); // random share of leftover
    }
    return weights;
  }

  // Roll one gif from window.OAI_GIFS (gifs.js; OAI_GIFS_FALLBACK if it didn't load).
  // Returns { url, alt, chance, reward } — chance is the effective % (up to 1 decimal).
  function rollGif() {
    var list = ((window.OAI_GIFS && window.OAI_GIFS.length) ? window.OAI_GIFS : OAI_GIFS_FALLBACK).slice();
    if (!list.length) return null;
    if (!_gifWeights || _gifWeightsLen !== list.length) { _gifWeights = computeGifWeights(list); _gifWeightsLen = list.length; }
    var weights = _gifWeights;
    var total = weights.reduce(function (a, w) { return a + w; }, 0) || 1;
    var roll = Math.random() * total, cum = 0, idx = 0;
    for (var i = 0; i < weights.length; i++) { cum += weights[i]; if (roll < cum) { idx = i; break; } }
    return {
      url:    list[idx].url,
      alt:    list[idx].alt || '',
      chance: +(weights[idx] / total * 100).toFixed(1),
      reward: list[idx].reward || ''
    };
  }

  function showLoadingModal(message) {
    var overlay = document.createElement('div');
    overlay.className = 'oai-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'oai-modal oai-modal--loading';
    modal.innerHTML =
      '<span class="oai-spinner oai-spinner--lg"></span>' +
      '<span class="oai-loading-text">' + esc(message) + '</span>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    return {
      remove: function () { if (overlay.parentNode) document.body.removeChild(overlay); }
    };
  }

  // ── Confirmation modal (Phase 1: Preview Data) ─────────────────────────────

  function showConfirmation(entries, existingRows, allOptions, stats, crossMonth, sheetName, fileName) {
    return new Promise(function (resolve) {
      var matchMap = new Map();
      var seen = new Set();
      for (var e of entries) {
        var key = e.groupKey;
        if (!seen.has(key)) { seen.add(key); matchMap.set(key, e.matchedValue || null); }
      }

      var overlay = document.createElement('div');
      overlay.className = 'oai-modal-overlay';

      var modal = document.createElement('div');
      modal.className = 'oai-modal oai-modal--conf';

      var crossMonthHtml = '';
      if (crossMonth && crossMonth.isCross) {
        var dateRange = formatCrossMonthDates(crossMonth.from, crossMonth.to);
        crossMonthHtml =
          '<div class="oai-conf-cross-month-warning">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>' +
            ' This timesheet spans two months (' + esc(dateRange) + '). ' + (CROSS_MONTH_ENABLED ? 'The tool will fill both months.' : '<br>Only the current month will be filled, switch to the other month and run again') +
          '</div>';
      }

      var gridHtml = buildPhase1Grid(entries, allOptions, matchMap, Object.assign({}, stats, { _sheetName: sheetName, _fileName: fileName }));

      modal.innerHTML =
        '<div class="oai-conf-header">' +
          '<span class="oai-conf-title-group">' +
            '<span class="oai-conf-title">Step 1: Review Data</span>' +
            '<span class="oai-info-icon" data-oai-tip="This tool reads your Excel file row by row and matches the hours and notes in each day column to the right Client : Engagement in OpenAir. Review the Client : Engagement column here before moving on to tasks."><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>' +
          '</span>' +
          '<button class="oai-modal-x" id="oai-p1-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="oai-conf-inner">' + gridHtml + '</div>' +
        '<div class="oai-conf-actions">' +
          crossMonthHtml +
          '<div class="oai-conf-buttons">' +
            '<button class="oai-btn oai-btn--secondary" id="oai-p1-refresh" title="Re-pull the Client : Engagement list from the page">↻ Refresh engagement</button>' +
            '<button class="oai-btn oai-btn--secondary" id="oai-p1-back"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:2px"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg> Back</button>' +
            '<button class="oai-btn oai-btn--primary" id="oai-p1-ok">Step 2: Tasks <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-left:2px"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></button>' +
            '<button class="oai-btn oai-btn--primary oai-btn--submit" id="oai-submit">Submit <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-left:2px"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></button>' +
          '</div>' +
        '</div>';

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      attachPhase1Events(modal, matchMap, overlay);
      attachTooltips(modal);

      // Client names in grid order (client <select>s render one-per-key in this same order).
      var orderedClients = [];
      (function () {
        var seenc = new Set();
        entries.forEach(function (e) {
          var k = e.groupKey;
          if (!seenc.has(k)) { seenc.add(k); orderedClients.push(e.clientEngagement); }
        });
      })();

      // Re-pull the live Client:Engagement options from the page and rebuild each row's
      // dropdown. Keeps a still-valid prior pick; otherwise re-runs the client auto-match.
      function refreshEngagementOptions() {
        var live = enumerateCandidateRows().allOptions.filter(function (o) { return o.value !== '_FIND'; });
        if (live.length === 0) return 0;
        var sels = Array.from(modal.querySelectorAll('.oai-conf-sel--client'));
        sels.forEach(function (sel, i) {
          var prev = sel.value;
          var html = '<option value="">- leave blank for import -</option>';
          live.forEach(function (o) { html += '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; });
          sel.innerHTML = html;
          if (prev && Array.from(sel.options).some(function (o) { return o.value === prev; })) {
            sel.value = prev;
          } else if (!_autoDefault) {
            sel.value = ''; // auto-default off -> leave blank for import
          } else {
            var ckey = normalise(orderedClients[i] || ''), best = null, bestScore = 0;
            live.forEach(function (o) { var sc = scoreMatch(ckey, normalise(o.label)); if (sc > bestScore) { bestScore = sc; best = o; } });
            sel.value = (best && bestScore >= MATCH_MIN) ? best.value : '';
          }
        });
        return sels.length;
      }

      modal.querySelector('#oai-p1-refresh').addEventListener('click', function () {
        var b = this, o = b.innerHTML;
        var n = refreshEngagementOptions();
        b.innerHTML = n > 0 ? '✓ Pulled ' + n : 'No options yet';
        setTimeout(function () { b.innerHTML = o; }, 1400);
      });

      function close(confirmed, goBack, submitDirect) {
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve({ confirmed: confirmed, goBack: !!goBack, submitDirect: !!submitDirect, matchMap: matchMap });
      }

      var okBtn     = modal.querySelector('#oai-p1-ok');
      var submitBtn = modal.querySelector('#oai-submit');

      // Shared commit for BOTH "Step 2: Tasks" and "Submit": read the reviewed
      // Client:Engagement picks, build the OpenAir rows, and stamp row/CE onto each entry.
      // `activeBtn` is only the button that shows the "Setting up rows..." progress label.
      // Kept in one place so the two buttons can never drift apart. Returns true on success.
      async function commitPhase1(activeBtn) {
        var btn = activeBtn;
        var origHTML = btn.innerHTML;
        // A row left on "- leave blank for import -" is committed BLANK — no "Open Code Pending"
        // substitution. exposeAndFillClientEngagement still spawns the OpenAir row for a blank value
        // (via a throwaway engagement it immediately resets), so the hours/notes land on a real row
        // while Client:Engagement stays blank on the timesheet.
        var ceArr = [];
        modal.querySelectorAll('.oai-conf-sel--client').forEach(function (sel) {
          ceArr.push(sel.value);
        });
        // Unique CE+Task keys in grid order. buildPhase1Grid renders one client <select>
        // per unique key in this same order, so index i lines up with ceArr[i]. We map
        // purely in memory here - NEVER via a data-* attribute, because the '\x00' key
        // separator does not survive an HTML attribute round-trip (it becomes U+FFFD),
        // which previously made every row resolve to null (blank tasks + no fill).
        var orderedKeys = [];
        entries.forEach(function (e) { var k = e.groupKey; if (orderedKeys.indexOf(k) < 0) orderedKeys.push(k); });
        okBtn.disabled = true;
        submitBtn.disabled = true;
        btn.textContent = 'Setting up rows…';
        try {
          var rowNums = await exposeAndFillClientEngagement(ceArr);
          var keyToRow = new Map(), keyToCE = new Map();
          orderedKeys.forEach(function (k, idx) {
            if (rowNums[idx]) keyToRow.set(k, rowNums[idx]);
            if (ceArr[idx] && ceArr[idx] !== ':' && ceArr[idx] !== '') keyToCE.set(k, ceArr[idx]);
          });
          entries.forEach(function (e) {
            var k = e.groupKey;
            e.row = keyToRow.has(k) ? keyToRow.get(k) : null;
            var ce = keyToCE.has(k) ? keyToCE.get(k) : null;
            e.matchedValue = ce;
            e.matchedLabel = ce ? (((allOptions || []).find(function (o) { return o.value === ce; }) || {}).label || ce) : null;
          });
          return true;
        } catch (err) {
          okBtn.disabled = false;
          submitBtn.disabled = false;
          btn.innerHTML = origHTML;
          setStatus(esc(err.message), 'error');
          return false;
        }
      }

      // "Step 2: Tasks" -> build rows, then open the Review Tasks modal.
      okBtn.addEventListener('click', async function () {
        if (await commitPhase1(this)) close(true);
      });
      // "Submit" -> build rows, then SKIP the Review Tasks modal. handleFile auto-matches
      // tasks and fills straight through to the completion modal (submitDirect flag).
      submitBtn.addEventListener('click', async function () {
        if (await commitPhase1(this)) close(true, false, true);
      });
      modal.querySelector('#oai-p1-back').addEventListener('click',  function () { close(false, true); });
      modal.querySelector('#oai-p1-x').addEventListener('click',     function () { close(false); });
    });
  }

  // ── Task selection modal (Phase 2: Input Tasks) ────────────────────────────

  function showTaskSelection(entries, rowTaskOptions, crossMonth, meta) {
    return new Promise(function (resolve) {
      var taskMap = new Map(); // rowNum -> taskValue
      var rowTaskText = new Map(); // rowNum -> Excel task string (for auto-match)
      entries.forEach(function (e) {
        if (e.row && !rowTaskText.has(e.row)) rowTaskText.set(e.row, e.task);
      });

      var overlay = document.createElement('div');
      overlay.className = 'oai-modal-overlay';

      var modal = document.createElement('div');
      modal.className = 'oai-modal oai-modal--conf';

      var crossMonthHtml = '';
      if (crossMonth && crossMonth.isCross) {
        var dateRange = formatCrossMonthDates(crossMonth.from, crossMonth.to);
        crossMonthHtml =
          '<div class="oai-conf-cross-month-warning">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17.01"/></svg>' +
            ' This timesheet spans two months (' + esc(dateRange) + '). ' + (CROSS_MONTH_ENABLED ? 'The tool will fill both months.' : '<br>Only the current month will be filled, switch to the other month and run again') +
          '</div>';
      }

      var gridHtml = buildPhase2Grid(entries, rowTaskOptions, taskMap, meta);

      modal.innerHTML =
        '<div class="oai-conf-header">' +
          '<span class="oai-conf-title-group">' +
            '<span class="oai-conf-title">Step 2: Input Tasks</span>' +
            '<span class="oai-info-icon" data-oai-tip="For each row, the tool pulls the Tasks OpenAir offers for that Client : Engagement. Pick the matching Task or leave it blank, then Fill Timesheet writes your hours and notes into OpenAir."><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>' +
          '</span>' +
          '<button class="oai-modal-x" id="oai-p2-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="oai-conf-inner">' + gridHtml + '</div>' +
        '<div class="oai-conf-actions">' +
          crossMonthHtml +
          '<div class="oai-conf-buttons">' +
            '<button class="oai-btn oai-btn--secondary" id="oai-p2-refresh" title="Re-pull each row\'s Task list from the page">↻ Refresh tasks</button>' +
            '<button class="oai-btn oai-btn--secondary" id="oai-p2-restart">↺ Restart</button>' +
            '<button class="oai-btn oai-btn--primary" id="oai-p2-ok">Fill Timesheet</button>' +
          '</div>' +
        '</div>';

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      modal.querySelectorAll('.oai-conf-sel--task').forEach(function (sel) {
        var rowNum = parseInt(sel.dataset.row, 10);
        if (sel.value) taskMap.set(rowNum, sel.value);
        sel.addEventListener('change', function () { taskMap.set(rowNum, this.value || null); });
      });
      attachTooltips(modal);

      // Dynamically populate task selects that haven't loaded yet
      var _taskPollActive = true;
      (function pollTaskOptions() {
        if (!_taskPollActive) return;
        var pending = modal.querySelectorAll('.oai-conf-sel--task[data-loading]');
        if (pending.length === 0) return;
        pending.forEach(function (sel) {
          var rowNum = parseInt(sel.dataset.row, 10);
          if (!rowNum) return;
          var liveOpts = enumerateTaskOptions(rowNum);
          if (liveOpts.length > 0) {
            liveOpts.forEach(function (o) {
              var opt = document.createElement('option');
              opt.value = o.value;
              opt.text = o.label;
              sel.appendChild(opt);
            });
            sel.removeAttribute('data-loading');
            sel.closest('td').classList.remove('oai-conf-td--task-loading');
            if (!sel.value) {
              var _m = resolveTaskForRow(rowTaskText.get(rowNum), liveOpts);
              if (_m) { sel.value = _m; taskMap.set(rowNum, _m); }
            }
          }
        });
        setTimeout(pollTaskOptions, 500);
      })();

      function close(confirmed, goBack) {
        _taskPollActive = false;
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve({ confirmed: confirmed, goBack: !!goBack, taskMap: taskMap });
      }

      // Re-pull each row's Task <select> options straight from the live DOM. Use this if
      // OpenAir finished loading a row's tasks after this modal opened, or if a row came
      // up empty. enumerateTaskOptions(rowNum) reads ts_c2_r{rowNum}, so each row shows the
      // Tasks OpenAir loaded for THAT row's Client:Engagement.
      function refreshTaskOptions() {
        var repulled = 0;
        modal.querySelectorAll('.oai-conf-sel--task').forEach(function (sel) {
          var rowNum = parseInt(sel.dataset.row, 10);
          if (!rowNum) return;
          var liveOpts = enumerateTaskOptions(rowNum);
          var prev = sel.value;
          sel.innerHTML = '<option value="">- leave blank for import -</option>';
          liveOpts.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.value; opt.text = o.label;
            sel.appendChild(opt);
          });
          // Keep the user's prior pick if still valid; otherwise re-run auto-match.
          if (prev && Array.from(sel.options).some(function (o) { return o.value === prev; })) {
            sel.value = prev;
          } else {
            var m = resolveTaskForRow(rowTaskText.get(rowNum), liveOpts);
            sel.value = m || '';
          }
          taskMap.set(rowNum, sel.value || null);
          if (liveOpts.length > 0) {
            sel.removeAttribute('data-loading');
            var td = sel.closest('td'); if (td) td.classList.remove('oai-conf-td--task-loading');
            repulled++;
          }
        });
        return repulled;
      }

      modal.querySelector('#oai-p2-refresh').addEventListener('click', function () {
        var btn = this, orig = btn.innerHTML;
        var n = refreshTaskOptions();
        btn.innerHTML = n > 0 ? '✓ Pulled ' + n : 'No tasks yet';
        setTimeout(function () { btn.innerHTML = orig; }, 1400);
      });

      modal.querySelector('#oai-p2-ok').addEventListener('click', function () { close(true); });
      modal.querySelector('#oai-p2-restart').addEventListener('click', function () {
        if (overlay.parentNode) document.body.removeChild(overlay);
        clearBeforeUnload();
        window.location.reload();
      });
      modal.querySelector('#oai-p2-x').addEventListener('click', function () { close(false); });
    });
  }

  // ── Main file handler ──────────────────────────────────────────────────────

  async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setStatus('Only <strong>.xlsx</strong> files are supported.', 'error');
      return;
    }
    try {
      clearStatus();
      var buffer = await file.arrayBuffer();
      var wb     = XLSX.read(buffer, { type: 'array', cellDates: true });

      // Sheet picker loop - Back button in Phase 2 restarts here
      var sheetName, rawEntries, skippedCells, existingRows, allOptions, resolved, stats, crossMonth, p1;
      while (true) {
        sheetName = await showSheetPicker(wb.SheetNames);
        if (!sheetName) { clearStatus(); return; }

        setStatus('<span class="oai-spinner"></span> Parsing sheet&hellip;', 'info');
        try {
          var parsed   = parseSheet(wb, sheetName);
          rawEntries   = parsed.entries;
          skippedCells = parsed.skippedCells;
        } catch (err) { setStatus(esc(err.message), 'error'); return; }

        setStatus('<span class="oai-spinner"></span> Reading OpenAir grid&hellip;', 'info');
        var enumResult = enumerateCandidateRows();
        existingRows = enumResult.rows;
        allOptions   = enumResult.allOptions;

        if (existingRows.length === 0 && allOptions.length === 0) {
          setStatus('No timesheet grid found. Make sure you are on the weekly timesheet entry page.', 'error');
          return;
        }

        resolved   = resolveRows(rawEntries, existingRows, allOptions);
        var uniqueKeys = new Set(rawEntries.map(function (e) { return e.groupKey; }));
        stats = { entries: rawEntries.length, dataRows: uniqueKeys.size, skippedCells: skippedCells };
        clearStatus();

        crossMonth = detectCrossMonth(sheetName);

        // ── "Just fill time & notes" mode: skip Client:Engagement/Task selection entirely ──
        if (_fillTimeNotesOnly) {
          var tn = await showTimeNotesOnly(rawEntries, { fileName: file.name, sheetName: sheetName, stats: stats }, crossMonth);
          if (tn.goBack) continue;                       // Back -> re-show the sheet picker
          if (!tn.confirmed) { clearStatus(); return; }

          // Build one blank-Client:Engagement row per unique Excel grouping. Passing a blank
          // value makes exposeAndFillClientEngagement spawn each OpenAir row via a throwaway
          // engagement that it immediately resets to blank, then we fill ONLY hours + notes.
          setStatus('<span class="oai-spinner"></span> Setting up rows\u2026', 'info');
          var tnKeys = [];
          rawEntries.forEach(function (e) { if (tnKeys.indexOf(e.groupKey) < 0) tnKeys.push(e.groupKey); });
          var tnRowNums = await exposeAndFillClientEngagement(tnKeys.map(function () { return ':'; }));
          var tnKeyToRow = new Map();
          tnKeys.forEach(function (k, idx) { if (tnRowNums[idx]) tnKeyToRow.set(k, tnRowNums[idx]); });
          rawEntries.forEach(function (e) { e.row = tnKeyToRow.has(e.groupKey) ? tnKeyToRow.get(e.groupKey) : null; });

          setStatus('<span class="oai-spinner"></span> Filling time & notes\u2026', 'info');
          var tnResults;
          try { tnResults = await fillTimesheet(rawEntries); }
          catch (err) { setStatus('Fill failed: ' + esc(err.message), 'error'); return; }
          clearStatus();
          await showCompletionModal(tnResults);
          return;
        }

        // ── Phase 1: Preview Data ──
        p1 = await showConfirmation(resolved, existingRows, allOptions, stats, crossMonth, sheetName, file.name);
        if (p1.goBack) continue; // Back button - re-show sheet picker
        if (!p1.confirmed) { clearStatus(); return; }
        break; // proceed to fill
      }

      // Row + Client:Engagement (matchedValue/Label) were assigned onto `resolved` during
      // Phase 1, in memory - no fragile data-attribute key round-trip. Just clone them.
      var finalEntries = resolved.map(function (e) { return Object.assign({}, e); });

      // Cache confirmed selections (keyed by client name only, matching resolveRows)
      var seenKeys = new Set();
      finalEntries.forEach(function (e) {
        var k = normalise(e.clientEngagement);
        if (e.matchedValue && !seenKeys.has(k)) { rowCache.set(k, e.matchedValue); seenKeys.add(k); }
      });

      // Wait briefly for OpenAir to populate task dropdowns for each row.
      var loadingModal = showLoadingModal('Loading task options…');
      setStatus('<span class="oai-spinner"></span> Loading task options…', 'info');
      // Only wait on rows that actually have an engagement — blank ("- leave blank for import -")
      // rows have no tasks to load, so waiting on them would just stall the modal.
      var uniqueRowNums = Array.from(new Set(finalEntries.filter(function (e) { return e.row && e.matchedValue; }).map(function (e) { return e.row; })));
      await waitForTaskOptions(uniqueRowNums);

      // Collect whatever task options are available; Phase 2 polls for the rest.
      var rowTaskOptions = new Map();
      finalEntries.forEach(function (e) {
        if (e.row && !rowTaskOptions.has(e.row)) {
          rowTaskOptions.set(e.row, enumerateTaskOptions(e.row));
        }
      });

      loadingModal.remove();
      clearStatus();

      // ── Tasks: Submit auto-matches and fills; otherwise the Review Tasks modal (Phase 2) ──
      var fillResults, usedTaskMap;

      if (p1.submitDirect) {
        // Submit path: skip the Review Tasks modal. Auto-match each row's Task from the
        // options OpenAir loaded (the same auto-match the Review Tasks modal pre-selects),
        // then fill Client:Engagement + tasks + hours + notes straight through.
        usedTaskMap = new Map();
        finalEntries.forEach(function (e) {
          if (e.row && !usedTaskMap.has(e.row)) {
            var _opts = rowTaskOptions.get(e.row) || [];
            usedTaskMap.set(e.row, _opts.length ? (resolveTaskForRow(e.task, _opts) || null) : null);
          }
        });
      } else {
        // Phase 2: Input Tasks (Back button loops to the sheet picker).
        var p2 = await showTaskSelection(finalEntries, rowTaskOptions, crossMonth, { fileName: file.name, sheetName: sheetName, stats: stats });
        if (p2.goBack) {
          // User hit Back - re-enter handleFile from the top to avoid deep re-entrant state.
          handleFile(file);
          return;
        }
        if (!p2.confirmed) { clearStatus(); return; }
        usedTaskMap = p2.taskMap;
      }

      // ── Fill tasks + hours ──
      setStatus('<span class="oai-spinner"></span> Filling timesheet…', 'info');
      try { fillResults = await fillTasksAndHours(finalEntries, usedTaskMap); }
      catch (err) { setStatus('Fill failed: ' + esc(err.message), 'error'); return; }

      // ── Scenario 1: cross-month - navigate to next month and re-fill ──
      // TEMP: gated off via CROSS_MONTH_ENABLED while single-month is stabilised. The
      // banner still warns the user; only the auto-navigation is suppressed.
      if (CROSS_MONTH_ENABLED && crossMonth && crossMonth.isCross) {
        try {
          setStatus('<span class="oai-spinner"></span> Navigating to next month…', 'info');
          await clickNextMonthLink();
          await waitForTimesheetGrid();

          // Build ordered CE values + keys (same order as Phase 1 modal rows)
          var ceValuesOrdered = [], ceKeysOrdered = [];
          var _seenCeKeys = new Set();
          finalEntries.forEach(function (e) {
            var k = e.groupKey;
            if (!_seenCeKeys.has(k)) { _seenCeKeys.add(k); ceValuesOrdered.push(e.matchedValue || ':'); ceKeysOrdered.push(k); }
          });

          setStatus('<span class="oai-spinner"></span> Setting up rows for next month…', 'info');
          var rowNumsNext = await exposeAndFillClientEngagement(ceValuesOrdered);

          // Remap each entry's row (and the task map) to next month's REAL row numbers.
          var keyToRowNext = new Map();
          ceKeysOrdered.forEach(function (k, idx) { if (rowNumsNext[idx]) keyToRowNext.set(k, rowNumsNext[idx]); });
          var taskMapNext = new Map();
          finalEntries.forEach(function (e) {
            var k = e.groupKey;
            if (keyToRowNext.has(k)) {
              var oldRow = e.row, newRow = keyToRowNext.get(k);
              if (usedTaskMap.has(oldRow) && !taskMapNext.has(newRow)) taskMapNext.set(newRow, usedTaskMap.get(oldRow));
              e.row = newRow;
            }
          });
          await waitForTaskOptions(rowNumsNext.filter(Boolean));

          setStatus('<span class="oai-spinner"></span> Filling next month…', 'info');
          await fillTasksAndHours(finalEntries, taskMapNext);

        } catch (err) {
          setStatus('Cross-month fill error: ' + esc(err.message), 'warning');
          return;
        }
      }

      // ── Completion modal (shows an Audit Log only when entries failed) ──
      clearStatus();
      await showCompletionModal(fillResults);
    } catch (err) {
      setStatus(esc(err.message), 'error');
    }
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  function createPanel() {
    if (document.getElementById('oai-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'oai-panel';

    panel.innerHTML =
      '<div class="oai-header">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
        '<span class="oai-title">Timesheet Importer</span>' +
      '</div>' +
      '<div class="oai-body">' +
        '<div class="oai-dropzone" id="oai-dz" tabindex="0" role="button" aria-label="Drop .xlsx or click to browse">' +
          '<div class="oai-dropzone-icon">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '</div>' +
          '<div class="oai-dropzone-text">Drop <strong>.xlsx</strong> here</div>' +
          '<div class="oai-dz-sub">or click to browse</div>' +
          '<div class="oai-dz-sub oai-dz-sub--cols">Mandatory columns: client : eng, task, [day] time, [day] notes</div>' +
          '<input type="file" id="oai-file-input" accept=".xlsx" style="display:none">' +
        '</div>' +
        '<button class="oai-btn--download" id="oai-dl-btn">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          'Download template' +
        '</button>' +
        '<div class="oai-status" id="oai-status" aria-live="polite"></div>' +
      '</div>';

    document.body.appendChild(panel);
    panelStatus = panel.querySelector('#oai-status');

    var dz        = panel.querySelector('#oai-dz');
    var fileInput = panel.querySelector('#oai-file-input');

    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      dz.classList.add('oai-dz--active');
    });
    dz.addEventListener('dragleave', function () { dz.classList.remove('oai-dz--active'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      dz.classList.remove('oai-dz--active');
      var f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    dz.addEventListener('click', function () { fileInput.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files[0]) handleFile(fileInput.files[0]);
      fileInput.value = '';
    });

    panel.querySelector('#oai-dl-btn').addEventListener('click', function () {
      // This runs in the page (https) context, where the `download` filename is IGNORED for
      // cross-origin chrome-extension: URLs (it would save as "template.xlsx"). Fetch the file
      // as a blob (same-origin) so the download keeps its tracking name.
      fetch(chrome.runtime.getURL('template.xlsx'))
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'Timesheet template v1.2.xlsx';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        })
        .catch(function () {
          // Fallback: direct link (may save as template.xlsx if the browser ignores the name)
          var a = document.createElement('a');
          a.href = chrome.runtime.getURL('template.xlsx');
          a.download = 'Timesheet template v1.2.xlsx';
          a.click();
        });
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === 'ping') {
      sendResponse({ ok: true, isTimesheetPage: !!document.querySelector(GRID_SEL) });
      return false;
    }
    if (msg.action === 'getCandidateRows') {
      var r = enumerateCandidateRows();
      sendResponse({ rows: r.rows, allOptions: r.allOptions });
      return false;
    }
    if (msg.action === 'fillTimesheet') {
      fillTimesheet(msg.entries)
        .then(function (results) { sendResponse({ ok: true, results: results }); })
        .catch(function (err)    { sendResponse({ ok: false, error: err.message }); });
      return true;
    }
    if (msg.action === 'applyTheme') {
      applyContentTheme(msg.color, msg.mode);
      sendResponse({ ok: true });
      return false;
    }
  });

  function init() {
    if (document.querySelector(GRID_SEL)) { createPanel(); return; }
    var t = setInterval(function () {
      if (document.querySelector(GRID_SEL)) { clearInterval(t); createPanel(); }
    }, 500);
    setTimeout(function () { clearInterval(t); }, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
