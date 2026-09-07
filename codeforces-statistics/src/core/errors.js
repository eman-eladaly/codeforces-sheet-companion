/*
 * Codeforces Statistics — error normalization.
 *
 * Turns every failure mode (HTTP status, Codeforces "FAILED" comment, network
 * error) into a stable code plus a sentence a human can act on. Raw statuses
 * like "HTTP 400" never reach the panel.
 */
(function (root, factory) {
  var api = factory();
  root.CFST = root.CFST || {};
  root.CFST.errors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var CODES = {
    RATE_LIMITED: 'RATE_LIMITED',
    NOT_FOUND: 'NOT_FOUND',
    FORBIDDEN: 'FORBIDDEN',
    BAD_REQUEST: 'BAD_REQUEST',
    NETWORK: 'NETWORK',
    SERVER: 'SERVER',
    UNKNOWN: 'UNKNOWN'
  };

  var MESSAGES = {
    RATE_LIMITED: 'Codeforces is temporarily limiting requests. Please wait a moment and refresh.',
    NOT_FOUND: 'Codeforces has no submission history for this handle yet.',
    FORBIDDEN: 'Codeforces did not share this data. Private groups are only visible to their members.',
    BAD_REQUEST: 'Unable to retrieve your Codeforces submissions. Please try again.',
    NETWORK: 'Cannot reach Codeforces right now. Check your connection and refresh.',
    SERVER: 'Codeforces is having trouble responding. Please try again in a minute.',
    UNKNOWN: 'Unable to retrieve your Codeforces submissions. Please try again.'
  };

  function codeFor(status, comment) {
    var text = String(comment || '').toLowerCase();
    if (status === 429 || text.indexOf('call limit exceeded') !== -1 || text.indexOf('limit exceeded') !== -1) {
      return CODES.RATE_LIMITED;
    }
    if (text.indexOf('not found') !== -1) return CODES.NOT_FOUND;
    if (status === 403 || text.indexOf('authenticated') !== -1 || text.indexOf('access denied') !== -1) {
      return CODES.FORBIDDEN;
    }
    if (status === 404) return CODES.NOT_FOUND;
    if (status === 400) return CODES.BAD_REQUEST;
    if (status >= 500) return CODES.SERVER;
    if (status === 0) return CODES.NETWORK;
    return CODES.UNKNOWN;
  }

  // `detail` is kept for the console only — the UI shows `message`.
  function build(status, comment) {
    var code = codeFor(status, comment);
    return {
      code: code,
      message: MESSAGES[code] || MESSAGES.UNKNOWN,
      detail: comment ? String(comment) : (status ? 'status ' + status : ''),
      retryable: code !== CODES.NOT_FOUND
    };
  }

  function fromNetwork(err) {
    return {
      code: CODES.NETWORK,
      message: MESSAGES.NETWORK,
      detail: err && err.message ? err.message : 'network error',
      retryable: true
    };
  }

  return { CODES: CODES, MESSAGES: MESSAGES, codeFor: codeFor, build: build, fromNetwork: fromNetwork };
});
