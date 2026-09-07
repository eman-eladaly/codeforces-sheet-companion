/*
 * Codeforces Statistics — problem parser.
 *
 * Reads the problem list out of the page (contest.standings is not available
 * anonymously for group, gym and mashup contests). Two strategies:
 *
 *   1. table.problems / .datatable rows — contest sheets and group problemsets
 *   2. any anchor that points at a problem statement — the sidebar list on a
 *      single problem page
 *
 * Each parsed problem keeps a reference to its table row so the renderer can
 * add a status cell to the existing Codeforces table instead of duplicating it.
 */
(function (root) {
  'use strict';
  var CFST = (root.CFST = root.CFST || {});
  var ctx = CFST.pageContext;

  function text(node) {
    return (node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function parseLink(href) {
    if (!href) return null;
    var m = ctx.PROBLEM_LINK_RE.exec(href.split('?')[0].split('#')[0]);
    if (!m) return null;
    return {
      groupId: m[1] || null,
      contestId: m[2] || m[4],
      index: m[3] || m[5]
    };
  }

  /** The accepted / rejected highlighting Codeforces renders for the viewer. */
  function pageStatusOf(row) {
    if (!row || !row.querySelectorAll) return null;
    var own = typeof row.className === 'string' ? row.className : '';
    var cls = ' ' + own + ' ' + Array.prototype.map
      .call(row.querySelectorAll('td, span, div'), function (n) {
        return typeof n.className === 'string' ? n.className : '';
      })
      .join(' ') + ' ';
    if (/\baccepted-problem\b/.test(cls)) return 'SOLVED';
    if (/\brejected-problem\b/.test(cls)) return 'ATTEMPTED';
    if (row.querySelector('img[src*="accepted"], img[alt*="Accepted"], img[title*="Accepted"]')) return 'SOLVED';
    return null;
  }

  function absolute(href) {
    if (!href) return null;
    if (/^https?:/i.test(href)) return href;
    return root.location.origin + (href.charAt(0) === '/' ? '' : '/') + href;
  }

  function firstProblemAnchor(row) {
    var anchors = row.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      if (parseLink(anchors[i].getAttribute('href'))) return anchors[i];
    }
    return null;
  }

  /**
   * Some Codeforces problem tables carry a difficulty cell. Read it when it is
   * there; never guess a rating that the page does not state.
   */
  function ratingOf(row) {
    var tagged = row.querySelector('[title*="Difficulty" i], .ProblemRating, span[class*="rating" i]');
    var value = tagged && /(\d{3,4})/.exec(tagged.textContent || '');
    if (value) return Number(value[1]);
    var cells = row.querySelectorAll('td');
    for (var i = cells.length - 1; i >= 0 && i >= cells.length - 2; i--) {
      var t = text(cells[i]);
      if (/^x?\d{3,4}$/.test(t)) {
        var n = Number(t.replace(/^x/, ''));
        if (n >= 300 && n <= 4000 && n % 100 === 0) return n;
      }
    }
    return null;
  }

  function fromTables(doc, context) {
    var out = [];
    var seen = Object.create(null);
    var rows = doc.querySelectorAll('table.problems tr, .datatable table tr, table.rtable tr');

    Array.prototype.forEach.call(rows, function (row) {
      var cells = row.querySelectorAll('td');
      if (!cells.length) return;                       // header row

      var anchor = firstProblemAnchor(row);
      if (!anchor) return;
      var link = parseLink(anchor.getAttribute('href'));
      if (!link) return;

      var key = link.contestId + '/' + link.index.toUpperCase();
      if (seen[key]) return;
      seen[key] = true;

      var name = '';
      var nameCell = cells.length > 1 ? cells[1] : null;
      if (nameCell) {
        var nameLinks = nameCell.querySelectorAll('a[href]');
        for (var j = 0; j < nameLinks.length; j++) {
          if (!parseLink(nameLinks[j].getAttribute('href'))) continue;
          var t = text(nameLinks[j]);
          if (t && t.toUpperCase() !== link.index.toUpperCase()) { name = t; break; }
        }
        if (!name) name = text(nameCell.querySelector('div')) || text(nameCell);
      }

      out.push({
        rating: ratingOf(row),
        contestId: link.contestId,
        groupId: link.groupId || (context && context.groupId) || null,
        // Identity always comes from the href. The id cell may read "1426A"
        // on problemset-style sheets, which would corrupt the problem key.
        index: link.index.toUpperCase(),
        name: name || ('Problem ' + link.index),
        url: absolute(anchor.getAttribute('href')),
        pageStatus: pageStatusOf(row),
        row: row                                        // for in-place badges
      });
    });

    return out;
  }

  function fromAnchors(doc, context) {
    var byKey = Object.create(null);
    var order = [];

    Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
      var link = parseLink(a.getAttribute('href'));
      if (!link) return;
      if (context && context.contestId && link.contestId !== String(context.contestId)) return;

      var key = link.contestId + '/' + link.index.toUpperCase();
      if (!byKey[key]) {
        byKey[key] = {
          contestId: link.contestId,
          groupId: link.groupId || (context && context.groupId) || null,
          index: link.index.toUpperCase(),
          name: '',
          url: absolute(a.getAttribute('href')),
          pageStatus: null,
          row: a.closest ? a.closest('tr') : null
        };
        order.push(key);
      }
      var t = text(a);
      if (t && t.toUpperCase() !== link.index.toUpperCase() && t.length > byKey[key].name.length) {
        byKey[key].name = t;
      }
      var st = pageStatusOf(a.closest ? a.closest('tr') : null);
      if (st && !byKey[key].pageStatus) byKey[key].pageStatus = st;
    });

    return order
      .map(function (k) {
        if (!byKey[k].name) byKey[k].name = 'Problem ' + byKey[k].index;
        return byKey[k];
      })
      .sort(function (a, b) { return a.index.localeCompare(b.index, 'en', { numeric: true }); });
  }

  function parseProblems(doc, context) {
    doc = doc || root.document;
    var problems = fromTables(doc, context);
    var source = 'table';
    if (problems.length < 2) {
      var alt = fromAnchors(doc, context);
      if (alt.length > problems.length) {
        problems = alt;
        source = 'links';
      }
    }
    return { problems: problems, source: source };
  }

  /**
   * Where the statistics section should go: after the problem table if there is
   * one, otherwise at the end of the main content column. Falls back through a
   * list of Codeforces containers so a layout change degrades instead of
   * breaking.
   */
  function findInjectionTarget(doc) {
    doc = doc || root.document;
    var table = doc.querySelector('table.problems, .datatable table');
    if (table) {
      var box = table.closest('.datatable') || table.parentElement;
      if (box && box.parentElement) {
        // Appending to a flex or grid parent would create a new column and
        // stretch the layout. In that case stay inside the table's own
        // container, immediately after the last problem row.
        if (isFlowContainer(box.parentElement)) return { parent: box.parentElement, after: box };
        return { parent: box, after: table };
      }
      if (box) return { parent: box, after: table };
    }
    var candidates = ['#pageContent', '.content-wrapper', '#content', '.roundbox-content'];
    for (var i = 0; i < candidates.length; i++) {
      var node = doc.querySelector(candidates[i]);
      if (node) return { parent: node, after: null };
    }
    return doc.body ? { parent: doc.body, after: null } : null;
  }

  /** True for a parent we can safely append a block-level sibling to. */
  function isFlowContainer(node) {
    if (!node) return false;
    var display = '';
    try {
      display = root.getComputedStyle ? root.getComputedStyle(node).display : '';
    } catch (e) { display = ''; }
    return !/(^|\s)(flex|grid|inline-flex|inline-grid)$/.test(display || '');
  }

  CFST.problemParser = {
    parseProblems: parseProblems,
    parseLink: parseLink,
    pageStatusOf: pageStatusOf,
    isFlowContainer: isFlowContainer,
    findInjectionTarget: findInjectionTarget
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CFST.problemParser;
})(typeof window !== 'undefined' ? window : globalThis);
