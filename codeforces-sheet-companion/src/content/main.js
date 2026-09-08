/*
 * Codeforces Statistics — controller.
 *
 * Pipeline, one stage per module:
 *   page-context   → what am I looking at, and is it comparable?
 *   problem-parser → which problems are on this page?
 *   service worker → submission history (fetching + caching + rate limiting)
 *   matching       → per-problem classification against the current context
 *   stats          → aggregation
 *   render         → DOM injection
 */
(function (root) {
  'use strict';
  if (root.__CF_STATS_ACTIVE__) return;
  root.__CF_STATS_ACTIVE__ = true;

  var CFST = root.CFST;
  var matching = CFST.matching;
  var statsLib = CFST.stats;
  var pageContext = CFST.pageContext;
  var parser = CFST.problemParser;
  var view = CFST.render;

  var TAG = '[CF Stats]';
  var SETTINGS_KEY = 'cfstats:settings';
  var DEFAULT_SETTINGS = { nameMatch: false };

  // Per-problem tracing is on by default so a wrong status can always be
  // traced to the evidence behind it. Silence it with:
  //   localStorage.setItem('cfStatsDebug', '0')
  var DEBUG = (function () {
    try { return root.localStorage.getItem('cfStatsDebug') !== '0'; } catch (e) { return true; }
  })();

  var model = {
    phase: 'loading',
    context: null,
    handle: null,
    problems: [],
    summary: null,
    progress: null,
    next: null,
    expanded: false,
    sheetName: null,
    groupName: null,
    unsolved: [],
    sheetProof: null,
    fetchedAt: null,
    warning: null,
    error: null,
    settings: Object.assign({}, DEFAULT_SETTINGS)
  };

  var target = null;
  var lastIndex = null;
  var loading = false;

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(TAG);
    console.log.apply(console, args);
  }

  function debug() {
    if (!DEBUG) return;
    log.apply(null, arguments);
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.get(key, function (r) { resolve((r || {})[key]); }); }
      catch (e) { resolve(undefined); }
    });
  }

  function storageSet(key, value) {
    return new Promise(function (resolve) {
      var o = {}; o[key] = value;
      try { chrome.storage.local.set(o, function () { resolve(); }); }
      catch (e) { resolve(); }
    });
  }

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      var fallback = {
        ok: false,
        error: { code: 'NETWORK', message: 'The extension could not reach its background service. Reload the page and try again.' }
      };
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          resolve(chrome.runtime.lastError ? fallback : res);
        });
      } catch (e) { resolve(fallback); }
    });
  }

  /* -------------------------------------------------------------- render -- */

  function paint() {
    view.render(target, model, {
      onRefresh: function () { load(true); },
      onToggleAll: function (value) {
        model.expanded = !!value;
        paint();
      },
      onSettings: function (patch) {
        model.settings = Object.assign({}, model.settings, patch);
        storageSet(SETTINGS_KEY, model.settings);
        if (lastIndex) classify(lastIndex);
        else paint();
      }
    });
  }

  /* ------------------------------------------------------------ classify -- */

  function classify(index) {
    var proof = model.sheetProof;
    model.problems = matching.classifyAll(model.problems, index, model.context, {
      allowNameMatch: !!model.settings.nameMatch,
      sheetProof: proof
    });

    log('Current Sheet ID:', model.context.contestId || '(none)',
        '| Current Group ID:', model.context.groupId || '(none)',
        '| In-sheet submissions:',
        proof && proof.available
          ? proof.accepted.length + ' accepted, ' + proof.attempted.length + ' failed' +
            (proof.complete ? '' : ' (partial list)') + (proof.fromCache ? ', cached' : '')
          : 'unavailable — ' + ((proof && proof.reason) || 'not fetched'));

    if (DEBUG) {
      model.problems.forEach(function (p) {
        debug(
          '\n  Current Sheet ID:    ' + (model.context.contestId || '(none)') +
          '\n  Current Group ID:    ' + (model.context.groupId || '(none)') +
          '\n  Problem ID:          ' + (p.key || p.index) + '  (' + p.name + ')' +
          '\n  Submission Contest:  ' + (p.submissionSource || 'none') +
          '\n  Submission Source:   ' + p.reason +
          '\n  In-sheet accepted:   ' + (proof && proof.available
              ? (proof.accepted.indexOf(matching.normalizeIndex(p.index)) !== -1 ? 'yes' : 'no')
              : 'unknown') +
          '\n  Detected Status:     ' + matching.LABEL[p.status].toUpperCase()
        );
      });
    }

    model.summary = statsLib.summarize(model.problems);
    model.progress = statsLib.sheetProgress(model.summary);
    model.unsolved = statsLib.unsolvedList(model.problems);

    // Ratings come from the problems' own rows when Codeforces prints them,
    // and otherwise from problems the user has already submitted to.
    var ratings = Object.assign({}, index.ratings || {});
    model.problems.forEach(function (p) {
      if (typeof p.rating === 'number' && p.key) ratings[p.key] = p.rating;
    });
    var next = statsLib.nextToSolve(model.problems, ratings, 5);
    model.next = { rows: next.rows, total: next.total, all: statsLib.nextToSolve(model.problems, ratings).rows };
    model.phase = 'ready';

    log('context:', pageContext.describe(model.context),
        '| comparable:', model.context.comparable,
        '| problems:', model.problems.length,
        '| here:', model.summary.solvedHere,
        '| elsewhere:', model.summary.solvedElsewhere,
        '| unknown:', model.summary.unknownSource,
        '| unsolved:', model.summary.unsolved);

    paint();
    view.annotateTable(model.problems);
  }

  /* ---------------------------------------------------------------- load -- */

  function load(force) {
    if (loading) return;
    if (!model.handle) {
      model.phase = 'logged-out';
      paint();
      return;
    }
    loading = true;
    model.phase = 'loading';
    model.error = null;
    paint();

    Promise.all([
      sendMessage({
        type: 'CFSTATS_LOAD',
        handle: model.handle,
        contestId: model.context.comparable ? model.context.contestId : null,
        force: !!force,
        // Every load revalidates. The cached index is only reused after one
        // cheap call confirms no new submission exists, so solving a problem
        // and reloading the sheet can never be answered from pre-solve data.
        revalidate: true
      }),
      // Authoritative proof of what was accepted INSIDE this sheet. Never
      // rejects: without it the classifier simply refuses to say "here".
      CFST.sheetSubmissions.load({
        context: model.context,
        handle: model.handle,
        force: !!force
      })
    ]).then(function (out) {
      var res = out[0];
      model.sheetProof = out[1];
      loading = false;
      if (!res || !res.ok) {
        model.phase = 'error';
        model.error = (res && res.error) || { message: 'Codeforces data could not be loaded. Try again in a moment.' };
        log('load failed:', model.error.code || '', model.error.message);
        paint();
        return;
      }
      lastIndex = res.index;
      model.fetchedAt = res.fetchedAt;
      model.warning = res.warning || null;
      debug('submissions:', res.index.submissionCount,
            'cached:', !!res.fromCache,
            'revalidated:', !!res.revalidated,
            '| in-sheet listing:', model.sheetProof && model.sheetProof.fresh ? 'fresh' : 'stale/unavailable');
      classify(res.index);
    });
  }

  /* ----------------------------------------------------------------- run -- */

  function readProblems() {
    var parsed = parser.parseProblems(document, model.context);
    model.problems = parsed.problems.map(function (p) {
      return {
        contestId: p.contestId,
        groupId: p.groupId,
        index: matching.normalizeIndex(p.index) || p.index,
        name: p.name,
        url: p.url || pageContext.problemUrl(model.context, p),
        pageStatus: p.pageStatus,
        rating: typeof p.rating === 'number' ? p.rating : null,
        row: p.row
      };
    });
    return model.problems;
  }

  function start() {
    model.context = pageContext.detectPage(location);
    model.handle = pageContext.detectHandle(document);
    model.sheetName = pageContext.detectSheetName(document, model.context);
    model.groupName = pageContext.groupName(document, model.context);

    if (!model.context.supported) return;

    readProblems();
    if (!model.problems.length) {
      log('no problems detected on this page; nothing injected');
      return;
    }

    target = parser.findInjectionTarget(document);
    if (!target) {
      log('no place to inject into; nothing injected');
      return;
    }

    storageGet(SETTINGS_KEY).then(function (stored) {
      model.settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
      paint();
      if (!model.handle) {
        model.phase = 'logged-out';
        paint();
        return;
      }
      load(false);
      watchForRerenders();
    });
  }

  /**
   * Codeforces re-renders parts of some pages. If our section is removed, put
   * it back once; ensureRoot() guarantees a single instance either way.
   */
  function watchForRerenders() {
    var scheduled = null;
    var lastUrl = location.href;

    function recheck() {
      var urlChanged = location.href !== lastUrl;
      lastUrl = location.href;

      // A different sheet means a different context. Re-detect it before
      // anything is classified, otherwise the new sheet would be compared
      // against the previous contest and statuses would be stale.
      if (urlChanged) {
        var next = pageContext.detectPage(location);
        var changed = pageContext.contextChanged(model.context, next);
        model.context = next;
        // The heading must always name the sheet that is actually open.
        model.sheetName = pageContext.detectSheetName(document, next);
        model.groupName = pageContext.groupName(document, next);
        if (!next.supported) return;
        if (changed) {
          var root = document.getElementById(view.ROOT_ID);
          if (root) root.remove();
          // Drop everything that was scoped to the previous sheet, so no
          // status can survive a navigation. lastIndex belongs in here too:
          // it is merged with contest-scoped data for the sheet it was loaded
          // for, so reusing it would classify the new sheet against the old
          // one's submissions.
          model.problems = [];
          model.sheetProof = null;
          lastIndex = null;
          model.summary = null;
          model.progress = null;
          model.next = null;
          model.expanded = false;
        }
      } else if (document.getElementById(view.ROOT_ID)) {
        return;   // still on the same page and the section is intact
      }

      target = parser.findInjectionTarget(document);
      if (!target) return;
      if (!readProblems().length) return;
      if (lastIndex && model.sheetProof) classify(lastIndex);
      else load(false);
    }

    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = setTimeout(function () { scheduled = null; recheck(); }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: false });
    window.addEventListener('popstate', recheck);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
