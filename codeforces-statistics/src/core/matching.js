/*
 * Codeforces Statistics — classification core.
 *
 * THE BUG THIS FILE EXISTS TO FIX
 * ------------------------------------------------------------------
 * The previous index collapsed the whole submission history into
 *
 *     solvedKeys = { "1426/A": true }
 *
 * keyed by *problem* identity (contestId + index). Classification then read
 * `if (solved[key]) solvedHere = true`, so ANY accepted submission — practice,
 * another group, a normal round, the problemset — proved "solved here". Problem
 * identity was being used as evidence of submission context. Those are two
 * different things.
 *
 * The index below keeps, for every problem, the set of contexts an accepted
 * submission actually came from. "Solved here" now requires that one of those
 * contexts is the context the user is currently looking at. When the data
 * cannot distinguish the two, the answer is "unknown source", never "here".
 *
 * Pure functions only: no DOM, no chrome.*, no network.
 */
(function (root, factory) {
  var api = factory();
  root.CFST = root.CFST || {};
  root.CFST.matching = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var STATUS = {
    SOLVED_HERE: 'SOLVED_HERE',
    SOLVED_ELSEWHERE: 'SOLVED_ELSEWHERE',
    UNKNOWN_SOURCE: 'UNKNOWN_SOURCE',
    UNSOLVED: 'UNSOLVED'
  };

  var LABEL = {
    SOLVED_HERE: 'Solved here',
    SOLVED_ELSEWHERE: 'Solved elsewhere',
    UNKNOWN_SOURCE: 'Solved, unknown source',
    UNSOLVED: 'Unsolved'
  };

  var GLYPH = {
    SOLVED_HERE: '\u2713',        // ✓
    SOLVED_ELSEWHERE: '\u2197',   // ↗
    UNKNOWN_SOURCE: '?',
    UNSOLVED: '\u25CB'            // ○
  };

  /* ------------------------------------------------------------- identity - */

  function normalizeIndex(index) {
    return String(index == null ? '' : index).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Problem identity. Never the index alone: 100/A and 200/A are different.
  function problemKey(contestId, index) {
    var idx = normalizeIndex(index);
    if (contestId === null || contestId === undefined || contestId === '' || !idx) return null;
    return String(contestId) + '/' + idx;
  }

  function normalizeName(name) {
    var s = String(name == null ? '' : name);
    if (s.normalize) s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /* ----------------------------------------------------------- submission - */

  function isAccepted(verdict) { return verdict === 'OK'; }
  function isPending(verdict) { return !verdict || verdict === 'TESTING' || verdict === 'SUBMITTED'; }

  function belongsTo(submission, handle) {
    if (!handle) return true;
    var members = (submission.author && submission.author.members) || [];
    var wanted = String(handle).toLowerCase();
    for (var i = 0; i < members.length; i++) {
      if (members[i] && String(members[i].handle).toLowerCase() === wanted) return true;
    }
    return members.length === 0;
  }

  /**
   * Where did this submission happen?
   *
   * Submission.contestId is the contest the submission was made in; for a group
   * contest that is the group contest's own id, for a problemset/practice solve
   * it is the origin contest of the problem. Party.participantType tells
   * CONTESTANT / PRACTICE / VIRTUAL / MANAGER apart.
   */
  /**
   * Where did this submission happen?
   *
   * Submission.contestId is the contest the submission was MADE IN; for a group
   * contest that is the group contest's own id. It is deliberately NOT defaulted
   * to problem.contestId: that fallback used to invent a context equal to the
   * problem's own contest, which then compared equal to the sheet and produced a
   * false "solved here". When the API gives no contest, the context is unknown
   * and is recorded as such.
   */
  function submissionContext(sub) {
    var contestId = sub.contestId !== undefined && sub.contestId !== null ? sub.contestId : null;
    return {
      contestId: contestId === null ? null : String(contestId),
      participantType: (sub.author && sub.author.participantType) || null
    };
  }

  /**
   * Fold submissions into an index that PRESERVES context.
   *
   *   keys: {
   *     "692989/A": {
   *       ctx: ["692989"],   // contest ids an ACCEPTED submission came from
   *       pt:  ["PRACTICE"], // participant types of those accepted submissions
   *       unk: false,        // accepted, but the API gave no contest for it
   *       att: true          // has a non-accepted submission
   *     }
   *   }
   *
   * Rating and tag totals are aggregated here so the cache never has to hold
   * thousands of raw submissions.
   */
  function buildSubmissionIndex(submissions, handle) {
    var keys = Object.create(null);
    var names = Object.create(null);
    // Per-problem ratings, kept so the sheet can label its own problems.
    // Account-wide rating/tag totals used to live here; they answered
    // "how is my Codeforces account doing", which is not this extension's job.
    var ratings = Object.create(null);
    var countedForStats = Object.create(null);
    var considered = 0;
    var solvedTotal = 0;

    (submissions || []).forEach(function (sub) {
      if (!sub || !sub.problem) return;
      if (!belongsTo(sub, handle)) return;
      considered++;

      var problem = sub.problem;
      var key = problemKey(
        problem.contestId !== undefined ? problem.contestId : sub.contestId,
        problem.index
      );
      if (!key) return;

      var rec = keys[key] || (keys[key] = { ctx: [], pt: [], unk: false, att: false });
      if (typeof problem.rating === 'number' && ratings[key] === undefined) ratings[key] = problem.rating;
      var accepted = isAccepted(sub.verdict);

      if (!accepted) {
        rec.att = true;
        return;
      }

      var context = submissionContext(sub);
      if (context.contestId) {
        if (rec.ctx.indexOf(context.contestId) === -1) rec.ctx.push(context.contestId);
      } else {
        rec.unk = true;   // accepted, but we cannot say where
      }
      if (context.participantType && rec.pt.indexOf(context.participantType) === -1) rec.pt.push(context.participantType);

      var nk = normalizeName(problem.name);
      if (nk) {
        if (!names[nk]) names[nk] = [];
        if (names[nk].indexOf(key) === -1) names[nk].push(key);
      }

      // Rating / tag totals count each distinct problem once.
      if (!countedForStats[key]) {
        countedForStats[key] = true;
        solvedTotal++;
      }
    });

    return {
      keys: keys,
      names: names,
      ratings: ratings,
      solvedTotal: solvedTotal,
      submissionCount: considered
    };
  }

  function emptyIndex() {
    return {
      keys: {}, names: {}, ratings: {},
      solvedTotal: 0, submissionCount: 0
    };
  }

  function merge(a, b) {
    var out = emptyIndex();
    [a, b].forEach(function (src) {
      if (!src) return;
      Object.keys(src.keys || {}).forEach(function (key) {
        var from = src.keys[key];
        var to = out.keys[key] || (out.keys[key] = { ctx: [], pt: [], unk: false, att: false });
        (from.ctx || []).forEach(function (c) { if (to.ctx.indexOf(c) === -1) to.ctx.push(c); });
        (from.pt || []).forEach(function (p) { if (to.pt.indexOf(p) === -1) to.pt.push(p); });
        to.att = to.att || !!from.att;
        to.unk = to.unk || !!from.unk;
      });
      Object.keys(src.names || {}).forEach(function (n) {
        if (!out.names[n]) out.names[n] = [];
        src.names[n].forEach(function (k) { if (out.names[n].indexOf(k) === -1) out.names[n].push(k); });
      });
      Object.keys(src.ratings || {}).forEach(function (k) {
        if (out.ratings[k] === undefined) out.ratings[k] = src.ratings[k];
      });
      out.solvedTotal = Math.max(out.solvedTotal, src.solvedTotal || 0);
      out.submissionCount += src.submissionCount || 0;
    });
    return out;
  }

  /* ------------------------------------------------------------- classify - */

  /**
   * @param problem {contestId, index, name, pageStatus}
   *        pageStatus is what Codeforces itself renders on THIS page for the
   *        signed-in user ('SOLVED' | 'ATTEMPTED' | null). It is inherently
   *        scoped to the page's own context, which is what makes it usable as
   *        proof of "here" inside a private group.
   * @param index  buildSubmissionIndex() output
   * @param context {contestId, groupId, kind, tracksSubmissions}
   *        contestId is the contest THIS PAGE represents, or null for a listing
   *        page (a group problemset) that merely links to problems.
   */
  function classifyProblem(problem, index, context, options) {
    options = options || {};
    context = context || {};
    var key = problemKey(problem.contestId, problem.index);
    var rec = key ? index.keys[key] : null;
    var acceptedContexts = (rec && rec.ctx) || [];
    var acceptedUnknown = !!(rec && rec.unk);
    var hasAccepted = acceptedContexts.length > 0 || acceptedUnknown;
    var pageStatus = problem.pageStatus || null;
    var here = String(context.contestId == null ? '' : context.contestId);

    // A problem can only be "solved here" if it actually lives in the contest
    // this page represents. A sheet that links out to /problemset/problem/1426/A
    // is showing a problem that belongs to contest 1426; whatever Codeforces
    // paints green on this page, a solve of it cannot be attributed to the
    // contest being viewed.
    var problemBelongsHere = !!here && String(problem.contestId) === here;

    // The green `accepted-problem` row is NOT proof of "here". Codeforces
    // derives it from the underlying problem, so on a sheet of copied problems
    // it turns green for a solve made in another group entirely. Trusting it
    // caused "Solved Here" to appear for problems with no accepted submission
    // in this sheet's My Submissions. It now means only "solved somewhere" and
    // can never reach SOLVED_HERE.
    var pageSaysSolvedSomewhere = pageStatus === 'SOLVED';

    // Authoritative in-sheet evidence, read from this sheet's own
    // My Submissions page. Presence proves "here"; absence disproves it, but
    // only when the listing was read completely.
    var proof = options.sheetProof;
    var proofUsable = !!(proof && proof.available && here && String(proof.contestId) === here);
    var myIndex = normalizeIndex(problem.index);
    var provenHere = proofUsable && proof.accepted.indexOf(myIndex) !== -1;
    var disprovenHere = proofUsable && proof.complete && !provenHere;

    // An accepted submission the API itself places in this contest is equally
    // good proof; for public contests it agrees with My Submissions.
    var apiProvesHere = !!here && acceptedContexts.indexOf(here) !== -1;

    var status, reason, source = null, inferred = false;

    if (provenHere) {
      status = STATUS.SOLVED_HERE;
      reason = "accepted submission listed in this sheet's My Submissions";
      source = 'sheet ' + here;
    } else if (apiProvesHere && !disprovenHere) {
      status = STATUS.SOLVED_HERE;
      reason = 'accepted submission reported by the API in contest ' + here;
      source = here;
    } else if (acceptedContexts.length && here) {
      status = STATUS.SOLVED_ELSEWHERE;
      reason = 'accepted in ' + acceptedContexts.join(', ') + ', nothing accepted in ' + here +
        (proofUsable ? " (checked against this sheet's submissions)" : '');
      source = acceptedContexts.join(', ');
    } else if (disprovenHere && (pageSaysSolvedSomewhere || acceptedUnknown)) {
      // Codeforces marks the problem solved, and this sheet's own submission
      // list proves the accepted submission is not in this sheet. Exactly the
      // reported case: that is "elsewhere", not "here".
      status = STATUS.SOLVED_ELSEWHERE;
      reason = 'no accepted submission in this sheet, but Codeforces marks the problem solved';
      source = 'outside this sheet';
    } else if (hasAccepted && here) {
      status = STATUS.UNKNOWN_SOURCE;
      reason = 'accepted, but the contest it was made in could not be confirmed';
      source = acceptedContexts.join(', ') || 'unreported';
    } else if (hasAccepted || pageSaysSolvedSomewhere) {
      status = STATUS.UNKNOWN_SOURCE;
      reason = !here
        ? 'no contest context on this page to compare against'
        : (problemBelongsHere
            ? 'marked solved by Codeforces, but no in-sheet accepted submission was found'
            : 'problem belongs to contest ' + problem.contestId + ', not to ' + here);
      source = acceptedContexts.join(', ') || 'page';
    } else if (options.allowNameMatch && key) {
      var nk = normalizeName(problem.name);
      var hits = nk ? index.names[nk] : null;
      var others = (hits || []).filter(function (k) { return k !== key; });
      if (others.length) {
        // Same title, different problem id. Enough to suspect a solve, not
        // enough to claim one, and never enough to claim "here".
        status = STATUS.UNKNOWN_SOURCE;
        reason = 'title also solved as ' + others.join(', ');
        source = others.join(', ');
        inferred = true;
      }
    }

    if (!status) {
      status = STATUS.UNSOLVED;
      reason = (rec && rec.att) || pageStatus === 'ATTEMPTED'
        ? 'submitted, never accepted'
        : 'no submission';
    }

    return {
      key: key,
      status: status,
      solved: status === STATUS.SOLVED_HERE || status === STATUS.SOLVED_ELSEWHERE || status === STATUS.UNKNOWN_SOURCE,
      solvedHere: status === STATUS.SOLVED_HERE,
      solvedElsewhere: status === STATUS.SOLVED_ELSEWHERE,
      attempted: !!(rec && rec.att) || pageStatus === 'ATTEMPTED' ||
        !!(proofUsable && proof.attempted.indexOf(myIndex) !== -1),
      submissionSource: source,
      inferred: inferred,
      reason: reason
    };
  }

  function classifyAll(problems, index, context, options) {
    var idx = index || emptyIndex();
    return (problems || []).map(function (p) {
      return Object.assign({}, p, classifyProblem(p, idx, context, options));
    });
  }

  return {
    STATUS: STATUS,
    LABEL: LABEL,
    GLYPH: GLYPH,
    normalizeIndex: normalizeIndex,
    normalizeName: normalizeName,
    problemKey: problemKey,
    isAccepted: isAccepted,
    isPending: isPending,
    submissionContext: submissionContext,
    buildSubmissionIndex: buildSubmissionIndex,
    emptyIndex: emptyIndex,
    merge: merge,
    classifyProblem: classifyProblem,
    classifyAll: classifyAll
  };
});
