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

    function cacheKey(handle) { return CACHE_PREFIX + String(handle).toLowerCase(); }

    function readCache(handle) {
      return Promise.resolve(storage.get(cacheKey(handle))).then(function (entry) {
        if (!entry || !entry.index || !entry.fetchedAt) return null;
        if (now() - entry.fetchedAt > ttl) return null;
        return entry;
      }).catch(function () { return null; });
    }

    function writeCache(handle, entry) {
      return Promise.resolve(storage.set(cacheKey(handle), entry)).catch(function () {});
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
      if (!handle) {
        return Promise.resolve({ ok: false, error: errors.build(400, 'missing handle') });
      }

      var cached = force ? Promise.resolve(null) : readCache(handle);

      return cached.then(function (entry) {
        if (entry) {
          log('using cached submissions', { age_s: Math.round((now() - entry.fetchedAt) / 1000) });
          return {
            ok: true,
            index: entry.index,
            fetchedAt: entry.fetchedAt,
            fromCache: true,
            warning: entry.warning || null
          };
        }

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
            var entryOut = { index: merged, fetchedAt: now(), warning: warning };
            return writeCache(handle, entryOut).then(function () {
              return {
                ok: true,
                index: merged,
                fetchedAt: entryOut.fetchedAt,
                fromCache: false,
                warning: warning
              };
            });
          });
        });
      });
    }

    function clearCache(handle) {
      if (handle) return Promise.resolve(storage.remove(cacheKey(handle)));
      return Promise.resolve();
    }

    return {
      loadIndex: loadIndex,
      clearCache: clearCache,
      _call: call,
      _fetchUserStatus: fetchUserStatus
    };
  }

  createApi.CONSTANTS = {
    API_BASE: API_BASE,
    MIN_GAP_MS: MIN_GAP_MS,
    PAGE_SIZE: PAGE_SIZE,
    MAX_PAGES: MAX_PAGES,
    CACHE_TTL_MS: CACHE_TTL_MS,
    CACHE_PREFIX: CACHE_PREFIX
  };

  return createApi;
});
