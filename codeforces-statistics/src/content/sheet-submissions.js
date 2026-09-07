/*
 * Codeforces Statistics — in-sheet submission proof.
 *
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * "Solved here" needs proof that an ACCEPTED submission exists inside the
 * current sheet. Two earlier sources were not proof:
 *
 *   - problem identity (contestId + index)  → says which problem, not where
 *   - the green `accepted-problem` row      → Codeforces paints it from the
 *     underlying problem, so a sheet of copied problems shows green for a
 *     solve made in a completely different group. This produced the reported
 *     "Solved Here with no accepted submission in My Submissions".
 *
 * The public API cannot see private group submissions, so this module reads the
 * one page that can: the sheet's own **My Submissions** list
 * (/group/<gid>/contest/<cid>/my, /contest/<cid>/my, /gym/<cid>/my) — exactly
 * the page a user opens to check by hand. It is a same-origin request for a
 * page the signed-in user can already open; no credential is read, stored or
 * sent anywhere, and nothing is submitted.
 *
 * Result:
 *   { available, complete, contestId, accepted: [index], attempted: [index] }
 *
 * `complete` is false when pagination was truncated. Presence in `accepted` is
 * always proof of "solved here"; ABSENCE is only treated as proof of "not here"
 * when the listing is complete.
 */
(function (root) {
  'use strict';
  var CFST = (root.CFST = root.CFST || {});
  var matching = CFST.matching;
  var pageCtx = CFST.pageContext;

  var CACHE_PREFIX = 'cfstats:sheet:';
  var TTL_MS = 5 * 60 * 1000;
  var MAX_PAGES = 5;

  function empty(contestId, reason) {
    return {
      available: false, complete: false, contestId: contestId || null,
      accepted: [], attempted: [], reason: reason || 'not fetched'
    };
  }

  /** /group/<gid>/contest/<cid>/my, /contest/<cid>/my, /gym/<cid>/my */
  function mySubmissionsUrl(context, origin) {
    if (!context || !context.contestId) return null;
    var base = origin || root.location.origin;
    if (context.groupId) {
      return base + '/group/' + context.groupId + '/contest/' + context.contestId + '/my';
    }
    var section = context.kind === pageCtx.KINDS.GYM ? 'gym' : 'contest';
    return base + '/' + section + '/' + context.contestId + '/my';
  }

  /**
   * Parse one status page. Rows come from Codeforces' standard status table;
   * a row counts only when its problem link belongs to the contest we asked
   * about, so a stray link elsewhere on the page cannot leak in.
   */
  function parseStatusDocument(doc, contestId) {
    var accepted = [];
    var attempted = [];
    var rows = doc.querySelectorAll(
      'table.status-frame-datatable tr[data-submission-id], table.status-frame-datatable tr'
    );

    Array.prototype.forEach.call(rows, function (row) {
      if (!row.querySelectorAll || row.querySelector('th')) return;
      var links = row.querySelectorAll('a[href]');
      var index = null;
      for (var i = 0; i < links.length && !index; i++) {
        var link = CFST.problemParser.parseLink(links[i].getAttribute('href'));
        if (!link) continue;
        if (contestId && String(link.contestId) !== String(contestId)) continue;
        index = matching.normalizeIndex(link.index);
      }
      if (!index) return;

      var verdictCell = row.querySelector('.verdict-accepted, span[class*="verdict"]');
      var isAccepted = !!row.querySelector('.verdict-accepted');
      if (!isAccepted && verdictCell && /^\s*accepted\b/i.test(verdictCell.textContent || '')) {
        isAccepted = true;
      }

      var bucket = isAccepted ? accepted : attempted;
      if (bucket.indexOf(index) === -1) bucket.push(index);
    });

    // An accepted problem is never also "attempted only".
    attempted = attempted.filter(function (i) { return accepted.indexOf(i) === -1; });
    return { accepted: accepted, attempted: attempted };
  }

  /** Pagination links on the same status page, in order, deduplicated. */
  function nextPageUrls(doc, currentUrl) {
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll('.pagination a[href], .page-index a[href]'), function (a) {
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      var abs = href.indexOf('http') === 0 ? href : root.location.origin + href;
      if (abs === currentUrl || out.indexOf(abs) !== -1) return;
      if (abs.indexOf('/my') === -1) return;
      out.push(abs);
    });
    return out;
  }

  function fetchDocument(url) {
    // Same-origin request for a page the signed-in user can already open. The
    // browser attaches its own session as it would for a normal navigation;
    // the extension never reads, stores or forwards it.
    return fetch(url, { credentials: 'same-origin', redirect: 'follow' })
      .then(function (res) {
        if (!res.ok) return { ok: false, status: res.status };
        return res.text().then(function (html) {
          return { ok: true, doc: new DOMParser().parseFromString(html, 'text/html') };
        });
      })
      .catch(function (err) {
        return { ok: false, status: 0, message: err && err.message };
      });
  }

  function cacheKey(handle, context) {
    // Keyed by sheet, so navigating to another group or contest can never
    // reuse the previous sheet's proof.
    return CACHE_PREFIX + String(handle).toLowerCase() + ':' +
      (context.groupId || '-') + ':' + (context.contestId || '-');
  }

  function readCache(handle, context, now) {
    return new Promise(function (resolve) {
      var key = cacheKey(handle, context);
      try {
        chrome.storage.local.get(key, function (res) {
          var entry = res && res[key];
          if (!entry || !entry.fetchedAt || now - entry.fetchedAt > TTL_MS) return resolve(null);
          if (String(entry.proof.contestId) !== String(context.contestId)) return resolve(null);
          resolve(entry.proof);
        });
      } catch (e) { resolve(null); }
    });
  }

  function writeCache(handle, context, proof, now) {
    return new Promise(function (resolve) {
      var obj = {};
      obj[cacheKey(handle, context)] = { fetchedAt: now, proof: proof };
      try { chrome.storage.local.set(obj, function () { resolve(); }); }
      catch (e) { resolve(); }
    });
  }

  /**
   * Load in-sheet proof for the current context.
   * Never rejects: without proof the classifier simply refuses to say "here".
   */
  function load(options) {
    var context = options.context || {};
    var handle = options.handle;
    var now = options.now || Date.now();

    if (!handle) return Promise.resolve(empty(context.contestId, 'not signed in'));
    if (!context.comparable || !context.contestId) {
      return Promise.resolve(empty(context.contestId, 'page has no contest of its own'));
    }

    var url = mySubmissionsUrl(context, options.origin);
    if (!url) return Promise.resolve(empty(context.contestId, 'no submissions page for this page'));

    var cached = options.force ? Promise.resolve(null) : readCache(handle, context, now);

    return cached.then(function (hit) {
      if (hit) {
        hit.fromCache = true;
        return hit;
      }

      var accepted = [];
      var attempted = [];
      var visited = [];

      function walk(pageUrl) {
        visited.push(pageUrl);
        return fetchDocument(pageUrl).then(function (res) {
          if (!res.ok) {
            return visited.length > 1
              ? { truncated: true }                       // later page failed
              : { failed: true, status: res.status };
          }
          var parsed = parseStatusDocument(res.doc, context.contestId);
          parsed.accepted.forEach(function (i) { if (accepted.indexOf(i) === -1) accepted.push(i); });
          parsed.attempted.forEach(function (i) { if (attempted.indexOf(i) === -1) attempted.push(i); });

          var next = nextPageUrls(res.doc, pageUrl).filter(function (u) { return visited.indexOf(u) === -1; });
          if (!next.length) return { truncated: false };
          if (visited.length >= MAX_PAGES) return { truncated: true };
          return walk(next[0]);
        });
      }

      return walk(url).then(function (outcome) {
        if (outcome.failed) {
          return empty(context.contestId,
            'submissions page unavailable (' + (outcome.status || 'network') + ')');
        }
        var proof = {
          available: true,
          complete: !outcome.truncated,
          contestId: String(context.contestId),
          groupId: context.groupId || null,
          accepted: accepted,
          attempted: attempted,
          fetchedAt: now,
          reason: 'read from this sheet\'s My Submissions'
        };
        return writeCache(handle, context, proof, now).then(function () { return proof; });
      });
    });
  }

  CFST.sheetSubmissions = {
    CACHE_PREFIX: CACHE_PREFIX,
    TTL_MS: TTL_MS,
    empty: empty,
    load: load,
    cacheKey: cacheKey,
    mySubmissionsUrl: mySubmissionsUrl,
    parseStatusDocument: parseStatusDocument,
    nextPageUrls: nextPageUrls
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CFST.sheetSubmissions;
})(typeof window !== 'undefined' ? window : globalThis);
