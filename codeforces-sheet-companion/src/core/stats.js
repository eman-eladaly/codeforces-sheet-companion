/*
 * Codeforces Statistics — aggregation.
 *
 * Takes classified problems plus the submission index and produces the numbers
 * the page renders. No DOM, no network.
 */
(function (root, factory) {
  var api = factory();
  root.CFST = root.CFST || {};
  root.CFST.stats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /** Counts for the current sheet. Every problem lands in exactly one bucket. */
  function summarize(classified) {
    var s = {
      total: classified.length,
      solvedHere: 0,
      solvedElsewhere: 0,
      unknownSource: 0,
      unsolved: 0,
      attempted: 0,
      solved: 0,
      percent: 0
    };
    classified.forEach(function (p) {
      if (p.status === 'SOLVED_HERE') s.solvedHere++;
      else if (p.status === 'SOLVED_ELSEWHERE') s.solvedElsewhere++;
      else if (p.status === 'UNKNOWN_SOURCE') s.unknownSource++;
      else {
        s.unsolved++;
        if (p.attempted) s.attempted++;
      }
    });
    s.solved = s.solvedHere + s.solvedElsewhere + s.unknownSource;
    s.percent = s.total ? Math.round((s.solved / s.total) * 100) : 0;
    return s;
  }

  /**
   * The one line that matters: how far through THIS sheet am I?
   * Nothing here looks beyond the problems on the current page.
   */
  function sheetProgress(summary) {
    return {
      done: summary.solved,
      total: summary.total,
      percent: summary.percent,
      remaining: summary.unsolved,
      segments: [
        { key: 'here', value: summary.solvedHere },
        { key: 'elsewhere', value: summary.solvedElsewhere },
        { key: 'unknown', value: summary.unknownSource }
      ].filter(function (s) { return s.value > 0; })
    };
  }

  /**
   * The next few unsolved problems of this sheet, easiest first when ratings
   * are known. Problems without a known rating keep their sheet order and go
   * last, so the list never invents difficulty it does not have.
   */
  function nextToSolve(classified, ratings, limit) {
    var rated = [];
    var unrated = [];
    classified.forEach(function (p, i) {
      if (p.status !== 'UNSOLVED') return;
      var rating = ratings && p.key ? ratings[p.key] : undefined;
      var row = Object.assign({}, p, { rating: typeof rating === 'number' ? rating : null, order: i });
      (row.rating === null ? unrated : rated).push(row);
    });
    rated.sort(function (a, b) { return a.rating - b.rating || a.order - b.order; });
    var all = rated.concat(unrated);
    return { rows: limit ? all.slice(0, limit) : all, total: all.length };
  }

  function unsolvedList(classified) {
    return classified.filter(function (p) { return p.status === 'UNSOLVED'; });
  }

  /** "1426-A" style short label used in the unsolved list. */
  function shortLabel(problem) {
    if (!problem.contestId) return problem.index;
    return problem.contestId + '-' + problem.index;
  }

  return {
    summarize: summarize,
    sheetProgress: sheetProgress,
    nextToSolve: nextToSolve,
    unsolvedList: unsolvedList,
    shortLabel: shortLabel
  };
});
