/*
 * Codeforces Statistics — page context.
 *
 * "Solved here" is only answerable if we know what "here" is. This module
 * classifies the surface and, crucially, decides whether the page HAS a contest
 * of its own to compare submissions against:
 *
 *   GROUP_CONTEST  /group/<code>/contest/<id>      contestId = <id>   comparable
 *   CONTEST        /contest/<id>                   contestId = <id>   comparable
 *   GYM            /gym/<id>                       contestId = <id>   comparable
 *   GROUP_SHEET    /group/<code>[/problems]        contestId = null   NOT comparable
 *   PROBLEMSET     /problemset                     contestId = null   NOT comparable
 *
 * When contestId is null the page merely links to problems that live elsewhere,
 * so an accepted submission cannot be attributed to this page. Those problems
 * are reported as "unknown source" rather than guessed either way.
 */
(function (root) {
  'use strict';
  var CFST = (root.CFST = root.CFST || {});

  var KINDS = {
    GROUP_CONTEST: 'GROUP_CONTEST',
    GROUP_SHEET: 'GROUP_SHEET',
    CONTEST: 'CONTEST',
    GYM: 'GYM',
    PROBLEMSET: 'PROBLEMSET',
    UNSUPPORTED: 'UNSUPPORTED'
  };

  var LABELS = {
    GROUP_CONTEST: 'group contest',
    GROUP_SHEET: 'group problemset',
    CONTEST: 'contest',
    GYM: 'gym contest',
    PROBLEMSET: 'problemset'
  };

  var GROUP_CONTEST_RE = /^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)(?:\/(problem)\/([A-Za-z0-9]+))?/;
  var GROUP_RE = /^\/group\/([A-Za-z0-9]+)(?:\/(problems|contests|standings|blog|members)?)?/;
  var CONTEST_RE = /^\/(contest|gym)\/(\d+)(?:\/(problem)\/([A-Za-z0-9]+))?/;
  var PROBLEMSET_RE = /^\/problemset(?:\/problem\/(\d+)\/([A-Za-z0-9]+))?/;

  // Every shape of link that points at a concrete problem statement.
  var PROBLEM_LINK_RE = new RegExp(
    '^(?:https?://[^/]+)?' +
    '/(?:group/([A-Za-z0-9]+)/)?' +
    '(?:' +
      '(?:contest|gym)/(\\d+)/problem/([A-Za-z0-9]+)' +      // /contest/566/problem/A
      '|problemset/problem/(\\d+)/([A-Za-z0-9]+)' +          // /problemset/problem/566/A
    ')/?$'
  );

  function makeContext(fields) {
    return Object.assign({
      kind: KINDS.UNSUPPORTED,
      label: null,
      groupId: null,
      contestId: null,
      problemIndex: null,
      comparable: false,   // can submissions be attributed to this page?
      supported: false
    }, fields);
  }

  function detectPage(location) {
    var path = (location || root.location).pathname.replace(/\/+$/, '') || '/';
    var m;

    if ((m = GROUP_CONTEST_RE.exec(path))) {
      return makeContext({
        kind: KINDS.GROUP_CONTEST, label: LABELS.GROUP_CONTEST,
        groupId: m[1], contestId: m[2], problemIndex: m[4] || null,
        comparable: true, supported: true
      });
    }

    if ((m = CONTEST_RE.exec(path))) {
      var kind = m[1] === 'gym' ? KINDS.GYM : KINDS.CONTEST;
      return makeContext({
        kind: kind, label: LABELS[kind],
        contestId: m[2], problemIndex: m[4] || null,
        comparable: true, supported: true
      });
    }

    if ((m = GROUP_RE.exec(path))) {
      return makeContext({
        kind: KINDS.GROUP_SHEET, label: LABELS.GROUP_SHEET,
        groupId: m[1], comparable: false, supported: true
      });
    }

    if ((m = PROBLEMSET_RE.exec(path))) {
      return makeContext({
        kind: KINDS.PROBLEMSET, label: LABELS.PROBLEMSET,
        contestId: m[1] || null, problemIndex: m[2] || null,
        comparable: false, supported: true
      });
    }

    return makeContext({});
  }

  /** Human-readable description used in the injected section and in logs. */
  function describe(context) {
    if (!context || !context.supported) return 'unsupported page';
    var bits = [];
    if (context.groupId) bits.push('group ' + context.groupId);
    if (context.contestId) bits.push('contest ' + context.contestId);
    if (!bits.length) bits.push(context.label);
    return bits.join(', ');
  }

  /**
   * The name of the sheet currently open, read from the page in order of
   * reliability. Falls back to the contest id rather than inventing a title.
   */
  function detectSheetName(doc, context) {
    doc = doc || root.document;
    if (!context || !context.contestId) return groupName(doc, context) || 'This page';

    // 1. Codeforces links the contest by name from the sheet page itself.
    var link = doc.querySelector(
      'a[href$="/contest/' + context.contestId + '"], a[href*="/contest/' + context.contestId + '"].contest-name'
    );
    var name = link && clean(link.textContent);
    if (name && name.length > 1 && !/^\d+$/.test(name)) return name;

    // 2. The sidebar contest box puts the name in the first header cell.
    var th = doc.querySelector('#sidebar .rtable th, .rtable th');
    name = th && clean(th.textContent);
    if (name && name.length > 3 && !/^(#|problem|name)$/i.test(name)) return name;

    // 3. The document title: "Problems - <sheet> - Codeforces".
    name = clean(doc.title || '')
      .replace(/\s*-\s*Codeforces\s*$/i, '')
      .replace(/^\s*(problems|dashboard|standings|submissions)\s*-\s*/i, '');
    if (name && name.length > 3 && !/^codeforces$/i.test(name)) return name;

    return 'Contest ' + context.contestId;
  }

  function groupName(doc, context) {
    if (!context || !context.groupId) return null;
    var link = doc.querySelector('a[href$="/group/' + context.groupId + '"]');
    var name = link && clean(link.textContent);
    return name && name.length > 1 ? name : null;
  }

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /** Logged-in handle, read from the Codeforces header only. */
  function detectHandle(doc) {
    doc = doc || root.document;
    var header = doc.getElementById('header') || doc.body;
    if (!header) return null;

    var logout = header.querySelector('a[href*="/logout"]');
    if (!logout) return null;
    if (logout.parentElement) {
      var near = logout.parentElement.querySelector('a[href*="/profile/"]');
      if (near) return handleFromHref(near.getAttribute('href'));
    }
    var any = header.querySelector('a[href*="/profile/"]');
    return any ? handleFromHref(any.getAttribute('href')) : null;
  }

  function handleFromHref(href) {
    if (!href) return null;
    var m = /\/profile\/([^/?#]+)/.exec(href);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function problemUrl(context, problem, origin) {
    var base = origin || root.location.origin;
    if (problem && problem.url) return problem.url;
    var index = problem ? problem.index : '';
    if (context.groupId && context.contestId) {
      return base + '/group/' + context.groupId + '/contest/' + context.contestId + '/problem/' + index;
    }
    if (problem && problem.contestId) {
      return base + '/contest/' + problem.contestId + '/problem/' + index;
    }
    return base;
  }

  /**
   * Has the sheet/group context changed? Codeforces navigations are ordinary
   * page loads, but group pages can swap content in place, and a stale context
   * would classify the new sheet against the old contest.
   */
  function contextChanged(before, after) {
    if (!before || !after) return true;
    return before.kind !== after.kind ||
      String(before.groupId) !== String(after.groupId) ||
      String(before.contestId) !== String(after.contestId);
  }

  CFST.pageContext = {
    KINDS: KINDS,
    contextChanged: contextChanged,
    PROBLEM_LINK_RE: PROBLEM_LINK_RE,
    detectPage: detectPage,
    detectSheetName: detectSheetName,
    groupName: groupName,
    detectHandle: detectHandle,
    handleFromHref: handleFromHref,
    problemUrl: problemUrl,
    describe: describe
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CFST.pageContext;
})(typeof window !== 'undefined' ? window : globalThis);
