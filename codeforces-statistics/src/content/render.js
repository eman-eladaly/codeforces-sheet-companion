/*
 * Codeforces Statistics — renderer.
 *
 * Injects normal block-level elements into the Codeforces document flow. No
 * fixed positioning, no overlay, no shadow root: the section is built out of
 * Codeforces' own `datatable` + `caption titled` structure so it inherits the
 * page's typography, width and colours, and it sits in the page like any other
 * Codeforces block.
 *
 * Everything this file adds is namespaced under .cf-stats-extension / #cf-stats-root
 * and it never edits a Codeforces element beyond appending one status cell per
 * problem row.
 */
(function (root) {
  'use strict';
  var CFST = (root.CFST = root.CFST || {});
  var matching = CFST.matching;
  var stats = CFST.stats;

  var ROOT_ID = 'cf-stats-root';
  var STATUS_ATTR = 'data-cf-stats-status';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function timeLabel(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function statusKey(status) {
    return {
      SOLVED_HERE: 'here',
      SOLVED_ELSEWHERE: 'elsewhere',
      UNKNOWN_SOURCE: 'unknown',
      UNSOLVED: 'unsolved'
    }[status] || 'unsolved';
  }

  /* ------------------------------------------------------------ container - */

  /**
   * Find the existing root or create it once. Re-renders reuse the same node,
   * so navigating, refreshing or a Codeforces DOM update can never produce a
   * second statistics section.
   */
  function ensureRoot(target) {
    var existing = document.getElementById(ROOT_ID);
    if (existing) return existing;
    if (!target || !target.parent) return null;

    var box = el('div', { id: ROOT_ID, class: 'datatable cf-stats-extension' });
    if (target.after && target.after.parentElement === target.parent) {
      target.parent.insertBefore(box, target.after.nextSibling);
    } else {
      target.parent.appendChild(box);
    }
    return box;
  }

  /* -------------------------------------------------------------- pieces -- */

  function caption() {
    return el('div', { class: 'caption titled', text: 'Your progress in this sheet' });
  }

  /** Sheet name and, quietly, where it lives. */
  function heading(model) {
    var sub = [];
    if (model.groupName) sub.push(model.groupName);
    else if (model.context && model.context.groupId) sub.push('group ' + model.context.groupId);
    if (model.handle) sub.push(model.handle);

    return el('div', { class: 'cf-stats-head' }, [
      el('h3', { class: 'cf-stats-sheet', text: model.sheetName || 'This sheet' }),
      sub.length ? el('span', { class: 'cf-stats-sheet-sub', text: sub.join(' \u00b7 ') }) : null
    ]);
  }

  /**
   * One bar, one fraction, one percentage. The bar is segmented by status so
   * the split between here and elsewhere is readable at a glance.
   */
  function progress(summary, progressModel) {
    var bar = el('div', {
      class: 'cf-stats-bar', role: 'img',
      'aria-label': summary.solved + ' of ' + summary.total + ' solved, ' + summary.percent + ' percent'
    });
    progressModel.segments.forEach(function (seg) {
      bar.appendChild(el('span', {
        class: 'cf-stats-seg cf-stats-seg-' + seg.key,
        style: 'width:' + (seg.value / summary.total * 100) + '%'
      }));
    });

    return el('div', { class: 'cf-stats-progress' }, [
      el('div', { class: 'cf-stats-figures' }, [
        el('strong', { class: 'cf-stats-fraction', text: summary.solved + ' / ' + summary.total }),
        el('span', { class: 'cf-stats-solvedword', text: 'solved' }),
        el('span', { class: 'cf-stats-percent', text: summary.percent + '%' })
      ]),
      bar
    ]);
  }

  /** Compact status counts. Zero-count buckets are not shown. */
  function chips(summary) {
    var list = el('ul', { class: 'cf-stats-chips' });
    [
      ['here', matching.GLYPH.SOLVED_HERE, summary.solvedHere, 'Here', 'Accepted inside this sheet'],
      ['elsewhere', matching.GLYPH.SOLVED_ELSEWHERE, summary.solvedElsewhere, 'Elsewhere', 'Accepted, but not inside this sheet'],
      ['unknown', matching.GLYPH.UNKNOWN_SOURCE, summary.unknownSource, 'Unconfirmed', 'Solved, but the sheet could not confirm where'],
      ['unsolved', matching.GLYPH.UNSOLVED, summary.unsolved, 'Left', 'No accepted submission yet']
    ].forEach(function (row) {
      if (!row[2] && row[0] === 'unknown') return;      // hide when it is zero
      list.appendChild(el('li', { 'data-k': row[0], title: row[4] }, [
        el('span', { class: 'cf-stats-glyph', text: row[1] }),
        el('b', { class: 'cf-stats-chip-num', text: String(row[2]) }),
        el('span', { class: 'cf-stats-chip-label', text: row[3] })
      ]));
    });
    return list;
  }

  /** The next few problems to attack, plus a way to see the rest. */
  function nextToSolve(model, handlers) {
    var next = model.next;
    if (!next || !next.total) {
      return el('p', { class: 'cf-stats-done', text: 'Every problem in this sheet is solved.' });
    }

    var shown = model.expanded ? next.total : Math.min(next.rows.length, 5);
    var rows = (model.expanded ? next.all : next.rows).slice(0, shown);

    var list = el('ol', { class: 'cf-stats-next' });
    rows.forEach(function (p) {
      list.appendChild(el('li', {}, [
        el('a', { class: 'cf-stats-next-link', href: p.url || '#', title: p.name }, [
          el('span', { class: 'cf-stats-idx', text: p.index }),
          el('span', { class: 'cf-stats-next-name', text: p.name })
        ]),
        el('span', {
          class: 'cf-stats-rating' + (p.rating ? '' : ' cf-stats-rating-none'),
          text: p.rating ? String(p.rating) : '\u2013'
        })
      ]));
    });

    var wrap = el('div', { class: 'cf-stats-block' }, [
      el('h4', { class: 'cf-stats-heading' }, [
        document.createTextNode('Next to solve'),
        el('span', { class: 'cf-stats-count', text: next.total + ' remaining' })
      ]),
      model.expanded ? el('div', { class: 'cf-stats-scroll' }, [list]) : list
    ]);

    if (next.total > 5) {
      var more = el('button', {
        type: 'button', class: 'cf-stats-more',
        text: model.expanded ? 'Show fewer' : 'View all ' + next.total + ' remaining'
      });
      more.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (handlers.onToggleAll) handlers.onToggleAll(!model.expanded);
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function footer(model, handlers) {
    var refresh = el('button', { type: 'button', class: 'cf-stats-action', text: 'Refresh' });
    refresh.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (handlers.onRefresh) handlers.onRefresh();
    });

    var toggle = el('input', { type: 'checkbox', id: 'cf-stats-namematch' });
    toggle.checked = !!(model.settings && model.settings.nameMatch);
    toggle.addEventListener('change', function () {
      if (handlers.onSettings) handlers.onSettings({ nameMatch: toggle.checked });
    });

    return el('div', { class: 'cf-stats-footer' }, [
      refresh,
      el('span', { class: 'cf-stats-note', text: model.fetchedAt ? 'Updated ' + timeLabel(model.fetchedAt) : '' }),
      el('label', {
        class: 'cf-stats-toggle',
        title: 'Treat an identical problem title solved under another id as a possible solve. Off by default because a title is not proof of identity.'
      }, [toggle, el('span', { text: ' match by title' })])
    ]);
  }

  function message(textValue, tone) {
    return el('p', { class: 'cf-stats-message' + (tone ? ' cf-stats-' + tone : ''), text: textValue });
  }

  /* -------------------------------------------------------------- render -- */

  function render(target, model, handlers) {
    handlers = handlers || {};
    var box = ensureRoot(target);
    if (!box) return null;

    box.textContent = '';
    box.appendChild(caption(model));

    var body = el('div', { class: 'cf-stats-body' });
    box.appendChild(body);
    body.appendChild(heading(model));

    if (model.phase === 'loading') {
      body.appendChild(message('Reading your submissions for this sheet\u2026'));
      return box;
    }
    if (model.phase === 'logged-out') {
      body.appendChild(message('Sign in to Codeforces to track your progress in this sheet.'));
      return box;
    }
    if (model.phase === 'no-problems') {
      body.appendChild(message('No problems found on this page.'));
      return box;
    }
    if (model.phase === 'error') {
      body.appendChild(message(model.error && model.error.message
        ? model.error.message
        : 'Codeforces data could not be loaded. Try again in a moment.', 'error'));
      body.appendChild(footer(model, handlers));
      return box;
    }

    var summary = model.summary;
    body.appendChild(progress(summary, model.progress));
    body.appendChild(chips(summary));

    var proof = model.sheetProof;
    if (model.context.comparable && (!proof || !proof.available)) {
      body.appendChild(message(
        'This sheet\'s submission list could not be read, so "here" is only shown where the ' +
        'Codeforces API confirms a submission in this contest.', 'note'));
    } else if (proof && proof.available && !proof.complete) {
      body.appendChild(message(
        'Only part of this sheet\'s submission list was read, so some problems may show as unconfirmed.', 'note'));
    } else if (!model.context.comparable) {
      body.appendChild(message(
        'This page has no contest of its own, so a solve cannot be attributed to it.', 'note'));
    }
    if (model.warning) body.appendChild(message(model.warning, 'note'));

    body.appendChild(nextToSolve(model, handlers));
    body.appendChild(footer(model, handlers));
    return box;
  }

  /* ------------------------------------------------- in-place table badges */

  /**
   * Add one status cell to each row of the Codeforces problem table. Rows are
   * tagged with a data attribute so a re-render updates the existing cell
   * rather than appending another one.
   */
  function annotateTable(problems) {
    var tables = [];
    problems.forEach(function (p) {
      if (!p.row || !p.row.closest) return;
      var table = p.row.closest('table');
      if (table && tables.indexOf(table) === -1) tables.push(table);
    });

    tables.forEach(function (table) {
      Array.prototype.forEach.call(table.rows, function (row) {
        if (row.hasAttribute(STATUS_ATTR)) return;
        if (!row.cells.length || row.querySelector('th')) {
          if (row.querySelector('th') && !row.hasAttribute(STATUS_ATTR)) {
            var th = el('th', { class: 'cf-stats-cell cf-stats-cell-head', text: 'Status' });
            row.appendChild(th);
            row.setAttribute(STATUS_ATTR, 'head');
          }
          return;
        }
        var td = el('td', { class: 'cf-stats-cell' });
        row.appendChild(td);
        row.setAttribute(STATUS_ATTR, 'pending');
      });
    });

    problems.forEach(function (p) {
      if (!p.row) return;
      var cell = p.row.querySelector('td.cf-stats-cell');
      if (!cell) return;
      cell.textContent = '';
      cell.setAttribute('class', 'cf-stats-cell cf-stats-cell-' + statusKey(p.status));
      cell.appendChild(el('span', { class: 'cf-stats-glyph', text: matching.GLYPH[p.status] }));
      cell.appendChild(el('span', {
        class: 'cf-stats-status-text',
        text: ' ' + matching.LABEL[p.status] + (p.inferred ? ' ?' : '')
      }));
      cell.setAttribute('title', p.reason || '');
      p.row.setAttribute(STATUS_ATTR, p.status);
    });
  }

  CFST.render = {
    ROOT_ID: ROOT_ID,
    STATUS_ATTR: STATUS_ATTR,
    ensureRoot: ensureRoot,
    render: render,
    annotateTable: annotateTable
  };
})(typeof window !== 'undefined' ? window : globalThis);
