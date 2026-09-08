/*
 * Codeforces Statistics — API client.
 *
 * Only official, documented, anonymous endpoints are used:
 *   GET https://codeforces.com/api/user.status?handle=&from=&count=
 *   GET https://codeforces.com/api/contest.status?contestId=&handle=&from=&count=
 * (https://codeforces.com/apiHelp/methods)
 *
 * No API key, no password, no cookies, no session token — nothing private is
 * read or stored. Codeforces allows at most one API call every two seconds, so
 * every request goes through a single global queue with a 2.1s gap.
 *
 * Dependencies are injected so tests/run-tests.js can drive it with a fake
 * fetch, a fake clock and an in-memory store.
 */
(function (root, factory) {
  var api = factory();
  root.CFST = root.CFST || {};
  root.CFST.createApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var API_BASE = 'https://codeforces.com/api/';
  var MIN_GAP_MS = 2100;          // Codeforces: max 1 request / 2 seconds
  var PAGE_SIZE = 2000;
  var MAX_PAGES = 5;              // hard ceiling: never more than 5 calls per refresh
  var CACHE_TTL_MS = 10 * 60 * 1000;
  var CACHE_PREFIX = 'cfstats:index:';
  var PROBE_SIZE = 1;             // newest submission only — the cache validator

  function createApi(deps) {
    var fetchImpl = deps.fetchImpl;
    var storage = deps.storage;                       // {get(key), set(key,val), remove(key)}
    var matching = deps.matching;
    var errors = deps.errors;
    var now = deps.now || function () { return Date.now(); };
    var sleep = deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var minGap = deps.minGapMs === undefined ? MIN_GAP_MS : deps.minGapMs;
    var ttl = deps.cacheTtlMs === undefined ? CACHE_TTL_MS : deps.cacheTtlMs;
    var log = deps.log || function () {};

    var lastCallAt = 0;
    var chain = Promise.resolve();

    function throttled(task) {
      var run = chain.then(function () {
        var wait = Math.max(0, minGap - (now() - lastCallAt));
        return (wait > 0 ? sleep(wait) : Promise.resolve()).then(function () {
          lastCallAt = now();
          return task();
        });
      });
      // keep the queue alive even if one call rejects
      chain = run.then(function () {}, function () {});
      return run;
    }

    function call(method, params) {
      var qs = Object.keys(params)
        .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
        .join('&');
      var url = API_BASE + method + (qs ? '?' + qs : '');

      return throttled(function () {
        return fetchImpl(url, { credentials: 'omit', cache: 'no-store' }).then(function (res) {
          return res.json().then(function (body) {
            return { res: res, body: body };
          }, function () {
            return { res: res, body: null };
          });
        }).then(function (out) {
          var body = out.body;
          if (out.res.ok && body && body.status === 'OK') {
            return { ok: true, result: body.result };
          }
          var comment = body && body.comment ? body.comment : '';
          return { ok: false, error: errors.build(out.res.status, comment) };
        }, function (err) {
          return { ok: false, error: errors.fromNetwork(err) };
        });
      });
    }

    /** All submissions of a handle, paged, newest first. */
    function fetchUserStatus(handle) {
      var all = [];
      var page = 0;

      function step() {
        page++;
        return call('user.status', {
          handle: handle,
          from: (page - 1) * PAGE_SIZE + 1,
          count: PAGE_SIZE
        }).then(function (r) {
          if (!r.ok) {
            // A partial result is still useful; only fail hard if we have nothing.
            if (all.length) return { ok: true, result: all, partial: true, error: r.error };
            return r;
          }
          all = all.concat(r.result);
          if (r.result.length === PAGE_SIZE && page < MAX_PAGES) return step();
          return { ok: true, result: all, truncated: r.result.length === PAGE_SIZE };
        });
      }
      return step();
    }

    /**
     * Submissions of a handle inside one contest. Cheap and exact, but
     * Codeforces rejects it for contests the caller cannot read anonymously
     * (most private groups) — that failure is expected and not surfaced.
     */
    function fetchContestStatus(handle, contestId) {
      return call('contest.status', {
        contestId: contestId,
        handle: handle,
        from: 1,
        count: PAGE_SIZE
      });
    }

    /**
     * The id of the newest submission of a handle. Codeforces returns
     * user.status newest-first, so one row is enough. This is the cache
     * validator: submission history is append-only, so an unchanged newest id
     * proves that nothing has been submitted since the cache was built.
     */
    function fetchLatestSubmissionId(handle) {
      return call('user.status', { handle: handle, from: 1, count: PROBE_SIZE })
        .then(function (r) {
          if (!r.ok) return { ok: false, error: r.error };
          var newest = r.result && r.result.length ? r.result[0] : null;
          return { ok: true, id: newest && newest.id !== undefined ? String(newest.id) : null };
        });
    }

    function latestIdOf(submissions) {
      var newest = submissions && submissions.length ? submissions[0] : null;
      return newest && newest.id !== undefined ? String(newest.id) : null;
    }

    // Scoped to the contest as well as the handle: loadIndex() merges
    // contest-scoped data into the entry, so an entry built for sheet A is not
    // a valid answer for sheet B. Keying on the handle alone made every
    // navigation between two sheets reuse the first sheet's payload.
    function cacheKey(handle, contestId) {
      return CACHE_PREFIX + String(handle).toLowerCase() + '|' + (contestId ? String(contestId) : '-');
    }

    function readCache(handle, contestId) {
      return Promise.resolve(storage.get(cacheKey(handle, contestId))).then(function (entry) {
        if (!entry || !entry.index || !entry.fetchedAt) return null;
        if (now() - entry.fetchedAt > ttl) return null;
        return entry;
      }).catch(function () { return null; });
    }

    function writeCache(handle, contestId, entry) {
      return Promise.resolve(storage.set(cacheKey(handle, contestId), entry)).catch(function () {});
    }

    /**
     * Main entry point. Returns
     *   {ok:true, index, fetchedAt, fromCache, warning?}
     *   {ok:false, error:{code,message}}
     */
    function loadIndex(options) {
      var handle = options.handle;
      var contestId = options.contestId;
      var force = !!options.force;
      var revalidate = !!options.revalidate;
      if (!handle) {
        return Promise.resolve({ ok: false, error: errors.build(400, 'missing handle') });
      }

      var cached = force ? Promise.resolve(null) : readCache(handle, contestId);

      return cached.then(function (entry) {
        if (entry && !revalidate) {
          log('using cached submissions', { age_s: Math.round((now() - entry.fetchedAt) / 1000) });
          return serveCached(entry, false);
        }

        // A cache hit is a candidate answer, not the answer. One cheap call
        // tells us whether anything has been submitted since it was built; only
        // then is the full history paged again. This is what makes a solve made
        // between two page loads visible without refetching everything.
        if (entry) {
          return fetchLatestSubmissionId(handle).then(function (probe) {
            if (!probe.ok) {
              // The probe is an optimisation, not a gate. If it fails we still
              // answer from cache, but flagged as unvalidated so the classifier
              // knows not to draw negative conclusions from it.
              log('revalidation probe failed; serving unvalidated cache', probe.error && probe.error.code);
              return serveCached(entry, false);
            }
            if (entry.latestSubmissionId !== undefined &&
                String(entry.latestSubmissionId) === String(probe.id)) {
              log('cache revalidated: no new submissions since it was built');
              // Verified current, so the age clock restarts.
              var refreshed = Object.assign({}, entry, { fetchedAt: now() });
              return writeCache(handle, contestId, refreshed).then(function () {
                return serveCached(refreshed, true);
              });
            }
            log('new submissions detected; refetching history');
            return fetchFresh();
          });
        }

        return fetchFresh();
      });

      function serveCached(entry, validated) {
        return {
          ok: true,
          index: entry.index,
          fetchedAt: entry.fetchedAt,
          fromCache: true,
          revalidated: !!validated,
          warning: entry.warning || null
        };
      }

      function fetchFresh() {
        return fetchUserStatus(handle).then(function (userRes) {
          if (!userRes.ok) return { ok: false, error: userRes.error };

          var index = matching.buildSubmissionIndex(userRes.result, handle);
          var warning = null;
          if (userRes.truncated) {
            warning = 'Only your most recent submissions were checked.';
          } else if (userRes.partial) {
            warning = 'Some of your submission history could not be loaded.';
          }

          // The contest-scoped call adds nothing for public contests but can
          // recover group data when Codeforces allows it. Failure is ignored.
          var extra = contestId
            ? fetchContestStatus(handle, contestId).then(function (r) {
                if (!r.ok) {
                  log('contest.status unavailable for this contest', r.error.code);
                  return null;
                }
                return matching.buildSubmissionIndex(r.result, handle);
              })
            : Promise.resolve(null);

          return extra.then(function (contestIndex) {
            var merged = contestIndex ? matching.merge(index, contestIndex) : index;
            var entryOut = {
              index: merged,
              fetchedAt: now(),
              warning: warning,
              // Stored so the next load can validate this entry with one call
              // instead of paging the whole history again.
              latestSubmissionId: latestIdOf(userRes.result)
            };
            return writeCache(handle, contestId, entryOut).then(function () {
              return {
                ok: true,
                index: merged,
                fetchedAt: entryOut.fetchedAt,
                fromCache: false,
                revalidated: true,
                warning: warning
              };
            });
          });
        });
      }
    }

    function clearCache(handle, contestId) {
      if (handle) return Promise.resolve(storage.remove(cacheKey(handle, contestId)));
      return Promise.resolve();
    }

    return {
      loadIndex: loadIndex,
      clearCache: clearCache,
      _call: call,
      _cacheKey: cacheKey,
      _fetchUserStatus: fetchUserStatus,
      _fetchLatestSubmissionId: fetchLatestSubmissionId
    };
  }

  createApi.CONSTANTS = {
    API_BASE: API_BASE,
    MIN_GAP_MS: MIN_GAP_MS,
    PAGE_SIZE: PAGE_SIZE,
    MAX_PAGES: MAX_PAGES,
    CACHE_TTL_MS: CACHE_TTL_MS,
    CACHE_PREFIX: CACHE_PREFIX,
    PROBE_SIZE: PROBE_SIZE
  };

  return createApi;
});
