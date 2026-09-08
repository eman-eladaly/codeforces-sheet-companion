/*
 * Codeforces Statistics — test suite.   node tests/run-tests.js
 *
 * Runs against the files the extension ships. DOM tests need jsdom; without it
 * they report as skipped, never as passed.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const matching = require(path.join(ROOT, 'src/core/matching.js'));
const statsLib = require(path.join(ROOT, 'src/core/stats.js'));
const errors = require(path.join(ROOT, 'src/core/errors.js'));
const createApi = require(path.join(ROOT, 'src/core/cf-api.js'));

const S = matching.STATUS;

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log('  ok   ' + name); },
        (e) => { failed++; failures.push([name, e]); console.log('  FAIL ' + name + '\n       ' + e.message); }
      );
    }
    passed++; console.log('  ok   ' + name);
  } catch (e) {
    failed++; failures.push([name, e]); console.log('  FAIL ' + name + '\n       ' + e.message);
  }
  return Promise.resolve();
}

function skip(name, why) { skipped++; console.log('  skip ' + name + ' (' + why + ')'); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((msg ? msg + ': ' : '') + 'expected ' + y + ', got ' + x);
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------- fixtures --- */

let subId = 1000;

/**
 * @param submissionContestId the contest the submission was MADE IN
 * @param problemContestId    the contest the problem BELONGS TO
 */
function sub(submissionContestId, problemContestId, index, name, verdict, opts) {
  opts = opts || {};
  return {
    id: subId++,
    contestId: submissionContestId,
    creationTimeSeconds: 1700000000 + subId,
    problem: {
      contestId: problemContestId,
      index,
      name,
      rating: opts.rating,
      tags: opts.tags
    },
    author: {
      contestId: submissionContestId,
      members: [{ handle: opts.handle || 'tester' }],
      participantType: opts.participantType || 'PRACTICE'
    },
    verdict
  };
}

function problem(contestId, index, name, pageStatus) {
  return {
    contestId: String(contestId),
    index,
    name,
    url: 'https://codeforces.com/contest/' + contestId + '/problem/' + index,
    pageStatus: pageStatus || null
  };
}

const GROUP_CONTEST = { kind: 'GROUP_CONTEST', groupId: 'oBT5JvzTgq', contestId: '692989', comparable: true, supported: true };
const GROUP_SHEET = { kind: 'GROUP_SHEET', groupId: 'oBT5JvzTgq', contestId: null, comparable: false, supported: true };
const CONTEST = { kind: 'CONTEST', groupId: null, contestId: '566', comparable: true, supported: true };

function classify(problems, submissions, context, opts) {
  const index = matching.buildSubmissionIndex(submissions, 'tester');
  return matching.classifyAll(problems, index, context, opts || {});
}

const statusesOf = (rows) => rows.map((r) => r.status);

/* ------------------------------------------------------------------------- */

async function main() {

  section('Acceptance cases (the reported bug)');

  await test('CASE 1: solved inside the current group contest → Solved here', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha')],
      [sub(692989, 692989, 'A', 'Alpha', 'OK', { participantType: 'CONTESTANT' })],
      GROUP_CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_HERE]);
    eq(rows[0].solvedHere, true);
    eq(rows[0].submissionSource, '692989');
  });

  await test('CASE 2: same problem solved on normal Codeforces → Solved elsewhere', () => {
    // The sheet lists problem 1426/A; the accepted submission came from
    // contest 1426 itself, not from the group contest being viewed.
    const rows = classify(
      [problem(1426, 'A', 'Floor Number')],
      [sub(1426, 1426, 'A', 'Floor Number', 'OK')],
      GROUP_CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
    eq(rows[0].solvedHere, false);
    eq(rows[0].solvedElsewhere, true);
  });

  await test('CASE 3: solved inside a different group → Solved elsewhere', () => {
    const rows = classify(
      [problem(700111, 'C', 'Gamma')],
      [sub(700111, 700111, 'C', 'Gamma', 'OK')],   // another group's contest id
      GROUP_CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
  });

  await test('CASE 4: never solved → Unsolved', () => {
    const rows = classify([problem(692989, 'D', 'Delta')], [], GROUP_CONTEST);
    eq(statusesOf(rows), [S.UNSOLVED]);
    eq(rows[0].solved, false);
  });

  await test('CASE 5: solved repeatedly, the relevant context decides', () => {
    // Accepted three times: twice outside, once inside the current contest.
    const inside = classify(
      [problem(692989, 'A', 'Alpha')],
      [
        sub(1426, 692989, 'A', 'Alpha', 'OK'),
        sub(555, 692989, 'A', 'Alpha', 'OK'),
        sub(692989, 692989, 'A', 'Alpha', 'OK')
      ],
      GROUP_CONTEST
    );
    eq(statusesOf(inside), [S.SOLVED_HERE]);

    // The same history minus the in-context submission must flip the answer.
    const outside = classify(
      [problem(692989, 'A', 'Alpha')],
      [sub(1426, 692989, 'A', 'Alpha', 'OK'), sub(555, 692989, 'A', 'Alpha', 'OK')],
      GROUP_CONTEST
    );
    eq(statusesOf(outside), [S.SOLVED_ELSEWHERE]);
  });

  await test('CASE 6: identical index, different context → never automatically Solved here', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha')],
      [sub(100, 100, 'A', 'Something else', 'OK')],
      GROUP_CONTEST
    );
    eq(statusesOf(rows), [S.UNSOLVED]);
    eq(matching.problemKey(100, 'A') === matching.problemKey(692989, 'A'), false);
  });

  section('Regression: the exact defect that was shipped');

  await test('an accepted submission alone no longer proves "solved here"', () => {
    // Old behaviour: solvedKeys["566/A"] = true  →  SOLVED_HERE.
    // The submission was made in contest 566 while the user is looking at
    // group contest 692989, so it is elsewhere.
    const index = matching.buildSubmissionIndex([sub(566, 566, 'A', 'Matching Names', 'OK')], 'tester');
    eq(index.keys['566/A'].ctx, ['566'], 'the index must retain the submission context');
    const here = matching.classifyProblem(problem(566, 'A', 'Matching Names'), index, GROUP_CONTEST, {});
    eq(here.status, S.SOLVED_ELSEWHERE);
    const onItsOwnPage = matching.classifyProblem(problem(566, 'A', 'Matching Names'), index, CONTEST, {});
    eq(onItsOwnPage.status, S.SOLVED_HERE);
  });

  await test('practice submissions inside the current contest still count as here', () => {
    const rows = classify(
      [problem(566, 'A', 'Matching Names')],
      [sub(566, 566, 'A', 'Matching Names', 'OK', { participantType: 'PRACTICE' })],
      CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_HERE]);
  });

  await test('a listing page with no contest of its own reports Unknown source, not Here', () => {
    const rows = classify(
      [problem(1426, 'A', 'Floor Number')],
      [sub(1426, 1426, 'A', 'Floor Number', 'OK')],
      GROUP_SHEET
    );
    eq(statusesOf(rows), [S.UNKNOWN_SOURCE]);
    eq(rows[0].solvedHere, false);
    assert(/no contest context/.test(rows[0].reason));
  });

  await test('a green row on its own is NOT proof of here (the reported bug)', () => {
    // Codeforces paints the row from the underlying problem, so on a sheet of
    // copied problems it goes green for a solve made in another group.
    const rows = classify([problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST);
    eq(statusesOf(rows), [S.UNKNOWN_SOURCE]);
    eq(rows[0].solvedHere, false);
    assert(/no in-sheet accepted submission/.test(rows[0].reason), rows[0].reason);
  });

  await test('a green row plus in-sheet proof IS solved here', () => {
    const proof = { available: true, complete: true, contestId: '692989', accepted: ['A'], attempted: [] };
    const rows = classify([problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: proof });
    eq(statusesOf(rows), [S.SOLVED_HERE]);
    assert(/My Submissions/.test(rows[0].reason));
  });

  await test('title-only matches are Unknown source and are off by default', () => {
    const problems = [problem(692989, 'A', 'Watermelon')];
    const history = [sub(4, 4, 'A', 'Watermelon', 'OK')];
    eq(statusesOf(classify(problems, history, GROUP_CONTEST)), [S.UNSOLVED]);
    const on = classify(problems, history, GROUP_CONTEST, { allowNameMatch: true });
    eq(statusesOf(on), [S.UNKNOWN_SOURCE]);
    eq(on[0].inferred, true);
    eq(on[0].solvedHere, false);
  });

  section('Regression: remaining false "solved here" paths');

  await test('Case B — green row for a problem of ANOTHER contest is not Solved here', () => {
    // The sheet links out to /problemset/problem/1426/A, so the row belongs to
    // contest 1426 while the page is group contest 692989. Codeforces paints it
    // green because it is solved somewhere; that is not proof of "here".
    const rows = classify([problem(1426, 'A', 'Floor Number', 'SOLVED')], [], GROUP_CONTEST);
    eq(statusesOf(rows), [S.UNKNOWN_SOURCE]);
    eq(rows[0].solvedHere, false);
    assert(/belongs to contest 1426/.test(rows[0].reason), rows[0].reason);
  });

  await test('Case B — green row plus an accepted submission elsewhere is Solved elsewhere', () => {
    const rows = classify(
      [problem(1426, 'A', 'Floor Number', 'SOLVED')],
      [sub(1426, 1426, 'A', 'Floor Number', 'OK')],
      GROUP_CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
    eq(rows[0].solvedHere, false);
  });

  await test('API evidence outranks the page highlight, never the other way round', () => {
    // Green row on this contest page, but every accepted submission happened in
    // another contest. The API is specific; the highlight is not.
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')],
      [sub(555, 692989, 'A', 'Alpha', 'OK')],
      GROUP_CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
  });

  await test('an accepted submission with no reported contest is never Solved here', () => {
    const history = [{
      id: 9, problem: { contestId: 692989, index: 'A', name: 'Alpha' },
      author: { members: [{ handle: 'tester' }], participantType: 'PRACTICE' },
      verdict: 'OK'                      // no contestId on the submission
    }];
    const index = matching.buildSubmissionIndex(history, 'tester');
    eq(index.keys['692989/A'].unk, true);
    eq(index.keys['692989/A'].ctx, []);
    const rows = matching.classifyAll([problem(692989, 'A', 'Alpha')], index, GROUP_CONTEST, {});
    eq(statusesOf(rows), [S.UNKNOWN_SOURCE]);
    eq(rows[0].solvedHere, false);
  });

  await test('switching sheets re-classifies the same history against the new context', () => {
    const history = [sub(692989, 692989, 'A', 'Alpha', 'OK')];
    const index = matching.buildSubmissionIndex(history, 'tester');
    const onItsSheet = matching.classifyAll([problem(692989, 'A', 'Alpha')], index, GROUP_CONTEST, {});
    eq(statusesOf(onItsSheet), [S.SOLVED_HERE]);
    const otherSheet = { kind: 'GROUP_CONTEST', groupId: 'other', contestId: '700111', comparable: true, supported: true };
    const onAnother = matching.classifyAll([problem(692989, 'A', 'Alpha')], index, otherSheet, {});
    eq(statusesOf(onAnother), [S.SOLVED_ELSEWHERE], 'stale context would have said "here"');
  });

  await test('classification is deterministic across repeats (refresh must not flip it)', () => {
    const history = [sub(1426, 1426, 'A', 'Floor Number', 'OK')];
    const problems = [problem(1426, 'A', 'Floor Number', 'SOLVED')];
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      const index = matching.buildSubmissionIndex(history, 'tester');
      seen.add(matching.classifyAll(problems, index, GROUP_CONTEST, {})[0].status);
    }
    eq(Array.from(seen), [S.SOLVED_ELSEWHERE]);
  });

  section('In-sheet proof (My Submissions)');

  const proofOf = (accepted, opts) => Object.assign({
    available: true, complete: true, contestId: '692989', accepted, attempted: []
  }, opts || {});

  await test('THE REPORTED CASE: green row, solved in another group, nothing accepted in this sheet', () => {
    // My Submissions for this sheet lists a failed attempt only.
    const proof = proofOf([], { attempted: ['A'] });
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')],
      [sub(700111, 692989, 'A', 'Alpha', 'OK')],       // accepted in another group
      GROUP_CONTEST,
      { sheetProof: proof }
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
    eq(rows[0].solvedHere, false);
    eq(rows[0].attempted, true);
  });

  await test('green row, no API record at all, nothing accepted in this sheet → elsewhere', () => {
    // Private group: the API is blind, but My Submissions is not.
    const rows = classify([problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: proofOf([]) });
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
    assert(/no accepted submission in this sheet/.test(rows[0].reason), rows[0].reason);
  });

  await test('in-sheet proof overrides an API record that points elsewhere', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha')],
      [sub(1426, 692989, 'A', 'Alpha', 'OK')],
      GROUP_CONTEST,
      { sheetProof: proofOf(['A']) }
    );
    eq(statusesOf(rows), [S.SOLVED_HERE]);
  });

  await test('an API accept in this contest is refused when the sheet listing disproves it', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha')],
      [sub(692989, 692989, 'A', 'Alpha', 'OK')],
      GROUP_CONTEST,
      { sheetProof: proofOf([]) }          // complete listing, A is absent
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
  });

  await test('a partial listing never disproves anything', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST,
      { sheetProof: proofOf([], { complete: false }) }
    );
    eq(statusesOf(rows), [S.UNKNOWN_SOURCE], 'an incomplete list must not be treated as proof of absence');
  });

  await test('proof from another sheet is ignored entirely', () => {
    const stale = proofOf(['A'], { contestId: '700111' });   // a different sheet
    const rows = classify([problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: stale });
    eq(statusesOf(rows), [S.UNKNOWN_SOURCE]);
    eq(rows[0].solvedHere, false);
  });

  await test('unavailable proof falls back to API evidence, never to the green row', () => {
    const none = { available: false, complete: false, contestId: '692989', accepted: [], attempted: [] };
    eq(statusesOf(classify([problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: none })),
       [S.UNKNOWN_SOURCE]);
    eq(statusesOf(classify([problem(692989, 'A', 'Alpha')],
       [sub(692989, 692989, 'A', 'Alpha', 'OK')], GROUP_CONTEST, { sheetProof: none })), [S.SOLVED_HERE]);
  });

  section('Verdict handling');

  await test('WA, WA, TLE then OK in this contest → Solved here', () => {
    const rows = classify(
      [problem(566, 'A', 'Matching Names')],
      [
        sub(566, 566, 'A', 'Matching Names', 'WRONG_ANSWER'),
        sub(566, 566, 'A', 'Matching Names', 'TIME_LIMIT_EXCEEDED'),
        sub(566, 566, 'A', 'Matching Names', 'OK')
      ],
      CONTEST
    );
    eq(statusesOf(rows), [S.SOLVED_HERE]);
    eq(rows[0].attempted, true, 'the failed attempts are still recorded');
  });

  await test('only failed submissions → Unsolved, flagged as attempted', () => {
    const rows = classify(
      [problem(566, 'A', 'Matching Names')],
      [sub(566, 566, 'A', 'Matching Names', 'WRONG_ANSWER')],
      CONTEST
    );
    eq(statusesOf(rows), [S.UNSOLVED]);
    eq(rows[0].attempted, true);
  });

  await test('a queued submission never counts as solved', () => {
    const rows = classify(
      [problem(566, 'A', 'Matching Names')],
      [sub(566, 566, 'A', 'Matching Names', undefined), sub(566, 566, 'A', 'Matching Names', 'TESTING')],
      CONTEST
    );
    eq(statusesOf(rows), [S.UNSOLVED]);
  });

  await test('other people\'s submissions are ignored', () => {
    const rows = classify(
      [problem(566, 'A', 'Matching Names')],
      [sub(566, 566, 'A', 'Matching Names', 'OK', { handle: 'someone_else' })],
      CONTEST
    );
    eq(statusesOf(rows), [S.UNSOLVED]);
  });

  section('Statistics');

  await test('buckets are exclusive and add up', () => {
    const rows = classify(
      [
        problem(692989, 'A', 'Alpha'), problem(692989, 'B', 'Beta'),
        problem(1426, 'A', 'Floor Number'), problem(692989, 'D', 'Delta'),
        problem(692989, 'E', 'Epsilon')
      ],
      [
        sub(692989, 692989, 'A', 'Alpha', 'OK'),
        sub(692989, 692989, 'B', 'Beta', 'OK'),
        sub(1426, 1426, 'A', 'Floor Number', 'OK'),
        sub(692989, 692989, 'D', 'Delta', 'WRONG_ANSWER')
      ],
      GROUP_CONTEST
    );
    const s = statsLib.summarize(rows);
    eq([s.solvedHere, s.solvedElsewhere, s.unknownSource, s.unsolved], [2, 1, 0, 2]);
    eq(s.solvedHere + s.solvedElsewhere + s.unknownSource + s.unsolved, s.total);
    eq(s.solved, 3);
    eq(s.percent, 60);
    eq(s.attempted, 1);
  });

  await test('empty sheet → zeroes, no crash', () => {
    const s = statsLib.summarize([]);
    eq([s.total, s.solved, s.percent], [0, 0, 0]);
  });

  await test('per-problem ratings are recorded once per problem', () => {
    const index = matching.buildSubmissionIndex([
      sub(1, 1, 'A', 'One', 'OK', { rating: 800, tags: ['math'] }),
      sub(1, 1, 'A', 'One', 'OK', { rating: 800, tags: ['math'] }),
      sub(3, 3, 'C', 'Three', 'OK', { rating: 1100, tags: ['dp'] })
    ], 'tester');
    eq(index.solvedTotal, 2);
    eq(index.ratings, { '1/A': 800, '3/C': 1100 });
    assert(index.ratingCounts === undefined, 'account-wide rating totals must be gone');
    assert(index.tagCounts === undefined, 'account-wide tag totals must be gone');
  });

  await test('sheet progress describes only this sheet', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha'), problem(692989, 'B', 'Beta'),
       problem(1426, 'A', 'Floor Number'), problem(692989, 'D', 'Delta')],
      [sub(692989, 692989, 'A', 'Alpha', 'OK'), sub(1426, 1426, 'A', 'Floor Number', 'OK')],
      GROUP_CONTEST
    );
    const summary = statsLib.summarize(rows);
    const progress = statsLib.sheetProgress(summary);
    eq([progress.done, progress.total, progress.percent, progress.remaining], [2, 4, 50, 2]);
    eq(progress.segments.map((x) => x.key + ':' + x.value), ['here:1', 'elsewhere:1']);
  });

  await test('next to solve lists unsolved problems, easiest first', () => {
    const rows = classify(
      [problem(692989, 'A', 'Alpha'), problem(692989, 'B', 'Beta'),
       problem(692989, 'C', 'Gamma'), problem(692989, 'D', 'Delta')],
      [sub(692989, 692989, 'A', 'Alpha', 'OK')],
      GROUP_CONTEST
    );
    const ratings = { '692989/C': 900, '692989/B': 1500 };
    const next = statsLib.nextToSolve(rows, ratings);
    eq(next.total, 3);
    // rated ascending, then problems whose rating the page never stated
    eq(next.rows.map((p) => p.index + ':' + p.rating), ['C:900', 'B:1500', 'D:null']);
    eq(statsLib.nextToSolve(rows, ratings, 2).rows.length, 2);
  });

  await test('a fully solved sheet has nothing left to solve', () => {
    const rows = classify([problem(692989, 'A', 'Alpha')],
      [sub(692989, 692989, 'A', 'Alpha', 'OK')], GROUP_CONTEST);
    eq(statsLib.nextToSolve(rows, {}).total, 0);
    eq(statsLib.sheetProgress(statsLib.summarize(rows)).percent, 100);
  });

  await test('unsolved list keeps links and short labels', () => {
    const rows = classify([problem(2060, 'C', 'Something')], [], GROUP_CONTEST);
    const list = statsLib.unsolvedList(rows);
    eq(list.length, 1);
    eq(statsLib.shortLabel(list[0]), '2060-C');
    assert(list[0].url.indexOf('/problem/C') !== -1);
  });

  section('API errors, caching and rate limiting');

  const memStore = () => {
    const map = new Map();
    return { map, get: (k) => map.get(k), set: (k, v) => { map.set(k, v); }, remove: (k) => { map.delete(k); } };
  };
  const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  const fakeClock = () => {
    let t = 1700000000000;
    return { now: () => t, sleep: (ms) => { t += ms; return Promise.resolve(); }, advance: (ms) => { t += ms; }, value: () => t };
  };
  const buildApi = (fetchImpl, store, clock) => createApi({
    fetchImpl, storage: store, matching, errors, now: clock.now, sleep: clock.sleep, minGapMs: 2100
  });

  await test('HTTP 400 / 429 / 403 map to sentences, never to raw statuses', () => {
    eq(errors.build(400, 'handle: bad').code, 'BAD_REQUEST');
    assert(!/400/.test(errors.build(400, '').message));
    eq(errors.build(429, '').code, 'RATE_LIMITED');
    eq(errors.build(200, 'Call limit exceeded').code, 'RATE_LIMITED');
    eq(errors.build(400, 'contestId: You have to be authenticated to use this method').code, 'FORBIDDEN');
    eq(errors.build(400, 'handle: User with handle x not found').code, 'NOT_FOUND');
    eq(errors.fromNetwork(new Error('boom')).code, 'NETWORK');
  });

  await test('network failure returns an error and caches nothing', async () => {
    const store = memStore();
    const api = buildApi(() => Promise.reject(new Error('Failed to fetch')), store, fakeClock());
    const res = await api.loadIndex({ handle: 'tester', contestId: '692989' });
    eq(res.ok, false);
    eq(store.map.size, 0);
  });

  await test('a second load is served from cache; Refresh bypasses it', async () => {
    const store = memStore();
    const clock = fakeClock();
    let solved = false;
    const calls = [];
    const fetchImpl = (url) => {
      calls.push(url);
      if (url.includes('user.status')) {
        return Promise.resolve(jsonResponse(200, {
          status: 'OK',
          result: solved ? [sub(692989, 692989, 'A', 'Alpha', 'OK')] : [sub(692989, 692989, 'A', 'Alpha', 'WRONG_ANSWER')]
        }));
      }
      return Promise.resolve(jsonResponse(200, { status: 'OK', result: [] }));
    };
    const api = buildApi(fetchImpl, store, clock);
    const problems = [problem(692989, 'A', 'Alpha')];

    let res = await api.loadIndex({ handle: 'tester', contestId: '692989' });
    eq(statusesOf(matching.classifyAll(problems, res.index, GROUP_CONTEST, {})), [S.UNSOLVED]);
    const n = calls.length;

    res = await api.loadIndex({ handle: 'tester', contestId: '692989' });
    eq(res.fromCache, true);
    eq(calls.length, n, 'a cached load must not hit the network');

    solved = true;
    res = await api.loadIndex({ handle: 'tester', contestId: '692989', force: true });
    eq(res.fromCache, false);
    eq(statusesOf(matching.classifyAll(problems, res.index, GROUP_CONTEST, {})), [S.SOLVED_HERE]);
  });

  await test('cached indexes survive a JSON round trip (chrome.storage)', async () => {
    const store = memStore();
    const clock = fakeClock();
    const fetchImpl = () => Promise.resolve(jsonResponse(200, {
      status: 'OK', result: [sub(692989, 692989, 'A', 'Alpha', 'OK', { rating: 800, tags: ['math'] })]
    }));
    const api = buildApi(fetchImpl, store, clock);
    await api.loadIndex({ handle: 'tester', contestId: '692989' });
    const raw = JSON.parse(JSON.stringify(store.map.get('cfstats:index:tester|692989')));
    eq(raw.index.keys['692989/A'].ctx, ['692989']);
    eq(raw.index.ratings['692989/A'], 800);
    eq(statusesOf(matching.classifyAll([problem(692989, 'A', 'Alpha')], raw.index, GROUP_CONTEST, {})), [S.SOLVED_HERE]);
  });

  await test('requests stay at least 2 seconds apart and paging is capped', async () => {
    const store = memStore();
    const clock = fakeClock();
    const stamps = [];
    const page = [];
    for (let i = 0; i < 2000; i++) page.push(sub(566, 566, 'A', 'Matching Names', 'WRONG_ANSWER'));
    const fetchImpl = (url) => {
      stamps.push(clock.value());
      if (url.includes('user.status')) return Promise.resolve(jsonResponse(200, { status: 'OK', result: page }));
      return Promise.resolve(jsonResponse(200, { status: 'OK', result: [] }));
    };
    const api = buildApi(fetchImpl, store, clock);
    const res = await api.loadIndex({ handle: 'tester', contestId: '566' });
    eq(res.ok, true);
    eq(stamps.length, 6, 'five user.status pages plus one contest.status');
    for (let i = 1; i < stamps.length; i++) assert(stamps[i] - stamps[i - 1] >= 2000, 'gap too small');
  });

  await test('a private-group contest.status rejection does not break the load', async () => {
    const store = memStore();
    const api = buildApi((url) => Promise.resolve(
      url.includes('contest.status')
        ? jsonResponse(400, { status: 'FAILED', comment: 'contestId: You have to be authenticated to use this method' })
        : jsonResponse(200, { status: 'OK', result: [sub(1426, 1426, 'A', 'Floor Number', 'OK')] })
    ), store, fakeClock());
    const res = await api.loadIndex({ handle: 'tester', contestId: '692989' });
    eq(res.ok, true);
    eq(Object.keys(res.index.keys), ['1426/A']);
  });

  await test('no key, cookie or credential is ever sent', async () => {
    const store = memStore();
    const seen = [];
    const api = buildApi((url, init) => {
      seen.push({ url, init });
      return Promise.resolve(jsonResponse(200, { status: 'OK', result: [] }));
    }, store, fakeClock());
    await api.loadIndex({ handle: 'tester', contestId: '566' });
    seen.forEach(({ url, init }) => {
      assert(!/apiKey|apiSig|secret|cookie|token/i.test(url), 'credential in ' + url);
      eq(init.credentials, 'omit');
    });
  });

  /* ------------------------------------------------- staleness lifecycle -- */

  section('Stale submission data after a new solve (the reported bug)');

  /**
   * A fake Codeforces whose submission list can grow between page loads,
   * honouring from/count the way user.status does (newest first).
   */
  function fakeCf(state) {
    const calls = [];
    const impl = (url) => {
      calls.push(url);
      if (url.includes('user.status')) {
        const count = Number(/count=(\d+)/.exec(url)[1]);
        const from = Number(/from=(\d+)/.exec(url)[1]);
        return Promise.resolve(jsonResponse(200, {
          status: 'OK', result: state.subs.slice(from - 1, from - 1 + count)
        }));
      }
      const cid = /contestId=(\d+)/.exec(url)[1];
      if (state.privateGroups) {
        return Promise.resolve(jsonResponse(400, {
          status: 'FAILED', comment: 'contestId: You have to be authenticated to use this method'
        }));
      }
      return Promise.resolve(jsonResponse(200, {
        status: 'OK', result: state.subs.filter((s) => String(s.contestId) === String(cid))
      }));
    };
    return { impl, calls, probes: () => calls.filter((u) => /count=1(&|$)/.test(u)).length };
  }

  await test('STEP 2/6: unsolved sheet, then a solve, then a reload → Solved here', async () => {
    const store = memStore();
    const clock = fakeClock();
    // newest first, as user.status returns them
    const state = { subs: [sub(692989, 692989, 'A', 'Alpha', 'WRONG_ANSWER', { participantType: 'CONTESTANT' })] };
    const cf = fakeCf(state);
    const api = buildApi(cf.impl, store, clock);
    const problems = [problem(692989, 'A', 'Alpha')];

    // 2. open the sheet → Unsolved
    let res = await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });
    eq(statusesOf(matching.classifyAll(problems, res.index, GROUP_CONTEST, {})), [S.UNSOLVED]);

    // 3. the user solves it on Codeforces (a NEW submission appears, newest first)
    state.subs.unshift(sub(692989, 692989, 'A', 'Alpha', 'OK', { participantType: 'CONTESTANT' }));

    // 4/5. return to the sheet and reload — same cache TTL window, no forced refresh
    clock.advance(30 * 1000);
    res = await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });

    // 6. the new submission must be visible
    eq(res.fromCache, false, 'a new submission must invalidate the cached index');
    eq(statusesOf(matching.classifyAll(problems, res.index, GROUP_CONTEST, {})), [S.SOLVED_HERE]);
  });

  await test('an unchanged history is revalidated with ONE call, not a full refetch', async () => {
    const store = memStore();
    const clock = fakeClock();
    const state = { subs: [sub(692989, 692989, 'A', 'Alpha', 'OK', { participantType: 'CONTESTANT' })] };
    const cf = fakeCf(state);
    const api = buildApi(cf.impl, store, clock);

    await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });
    const after = cf.calls.length;

    clock.advance(60 * 1000);
    const res = await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });
    eq(res.fromCache, true);
    eq(res.revalidated, true);
    eq(cf.calls.length - after, 1, 'revalidation must cost exactly one probe call');
  });

  await test('a failed probe serves cache rather than an error, marked unvalidated', async () => {
    const store = memStore();
    const clock = fakeClock();
    const state = { subs: [sub(692989, 692989, 'A', 'Alpha', 'OK', { participantType: 'CONTESTANT' })] };
    const cf = fakeCf(state);
    let online = true;
    const api = buildApi((url) => (online ? cf.impl(url) : Promise.reject(new Error('Failed to fetch'))), store, clock);

    await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });
    online = false;
    clock.advance(60 * 1000);
    const res = await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });
    eq(res.ok, true);
    eq(res.fromCache, true);
    eq(res.revalidated, false, 'an unverified cache hit must not claim to be revalidated');
  });

  await test('STEP 9: two sheets get separate cache entries, never each other\'s data', async () => {
    const store = memStore();
    const clock = fakeClock();
    const state = {
      subs: [
        sub(222, 222, 'A', 'Bravo', 'OK', { participantType: 'CONTESTANT' }),
        sub(111, 111, 'A', 'Alpha', 'OK', { participantType: 'CONTESTANT' })
      ]
    };
    const cf = fakeCf(state);
    const api = buildApi(cf.impl, store, clock);

    const a = await api.loadIndex({ handle: 'tester', contestId: '111', revalidate: true });
    const b = await api.loadIndex({ handle: 'tester', contestId: '222', revalidate: true });

    eq(b.fromCache, false, "sheet B must not be answered from sheet A's entry");
    eq([...store.map.keys()].sort(), ['cfstats:index:tester|111', 'cfstats:index:tester|222']);

    const ctxA = { kind: 'CONTEST', groupId: null, contestId: '111', comparable: true, supported: true };
    const ctxB = { kind: 'CONTEST', groupId: null, contestId: '222', comparable: true, supported: true };
    eq(statusesOf(matching.classifyAll([problem(111, 'A', 'Alpha')], a.index, ctxA, {})), [S.SOLVED_HERE]);
    eq(statusesOf(matching.classifyAll([problem(222, 'A', 'Bravo')], b.index, ctxB, {})), [S.SOLVED_HERE]);
    // and B's contest-scoped call really was made for B
    assert(cf.calls.some((u) => u.includes('contest.status') && u.includes('contestId=222')),
      'sheet B must fetch its own contest-scoped submissions');
  });

  await test('STEP 7/8: elsewhere and unsolved are unaffected by revalidation', async () => {
    const store = memStore();
    const clock = fakeClock();
    const state = {
      subs: [
        sub(1426, 1426, 'A', 'Floor Number', 'OK'),          // solved in another contest
        sub(999, 999, 'Z', 'Zeta', 'OK')
      ]
    };
    const api = buildApi(fakeCf(state).impl, store, clock);
    const res = await api.loadIndex({ handle: 'tester', contestId: '692989', revalidate: true });
    const rows = matching.classifyAll(
      [problem(1426, 'A', 'Floor Number'), problem(692989, 'B', 'Never touched')],
      res.index, GROUP_CONTEST, {}
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE, S.UNSOLVED]);
  });

  section('Stale in-sheet proof must never disprove a solve');

  await test('THE REPORTED BUG: stale listing + green row is NOT "Solved elsewhere"', () => {
    // The listing was cached before the solve, so it lists nothing accepted.
    // Codeforces itself already paints the row green on the freshly loaded page.
    const stale = {
      available: true, complete: true, fresh: false, contestId: '692989',
      accepted: [], attempted: ['A']
    };
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')],
      [],                                  // private group: the API sees nothing
      GROUP_CONTEST,
      { sheetProof: stale }
    );
    assert(rows[0].status !== S.SOLVED_ELSEWHERE,
      'a stale listing must not be used as proof that the solve happened elsewhere');
    eq(rows[0].status, S.UNKNOWN_SOURCE);
  });

  await test('once the listing is re-read, the same problem becomes Solved here', () => {
    const fresh = {
      available: true, complete: true, fresh: true, contestId: '692989',
      accepted: ['A'], attempted: []
    };
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: fresh }
    );
    eq(statusesOf(rows), [S.SOLVED_HERE]);
  });

  await test('a stale listing can still PROVE a solve it already recorded', () => {
    // Presence is monotone: an accepted submission never becomes unaccepted.
    const stale = {
      available: true, complete: true, fresh: false, contestId: '692989',
      accepted: ['A'], attempted: []
    };
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: stale }
    );
    eq(statusesOf(rows), [S.SOLVED_HERE]);
  });

  await test('a fresh listing still proves a solve happened elsewhere', () => {
    const fresh = {
      available: true, complete: true, fresh: true, contestId: '692989',
      accepted: [], attempted: []
    };
    const rows = classify(
      [problem(692989, 'A', 'Alpha', 'SOLVED')], [], GROUP_CONTEST, { sheetProof: fresh }
    );
    eq(statusesOf(rows), [S.SOLVED_ELSEWHERE]);
  });

  /* --------------------------------------------------------------- DOM ---- */

  section('Page detection and DOM injection');

  let JSDOM = null;
  for (const p of ['jsdom', path.join(process.env.HOME || '/home/claude', 'testenv/node_modules/jsdom')]) {
    try { JSDOM = require(p).JSDOM; break; } catch (e) { /* keep looking */ }
  }

  if (!JSDOM) {
    skip('page detection', 'jsdom not installed');
    skip('DOM injection', 'jsdom not installed');
  } else {
    const css = fs.readFileSync(path.join(ROOT, 'src/content/styles.css'), 'utf8');

    function loadDom(html, url) {
      const dom = new JSDOM(html, { url });
      globalThis.window = dom.window;
      globalThis.document = dom.window.document;
      globalThis.location = dom.window.location;
      [
        'src/content/page-context.js',
        'src/content/problem-parser.js',
        'src/content/sheet-submissions.js',
        'src/content/render.js'
      ].forEach((f) => delete require.cache[require.resolve(path.join(ROOT, f))]);
      dom.window.CFST = { matching, stats: statsLib };
      require(path.join(ROOT, 'src/content/page-context.js'));
      require(path.join(ROOT, 'src/content/problem-parser.js'));
      require(path.join(ROOT, 'src/content/sheet-submissions.js'));
      require(path.join(ROOT, 'src/content/render.js'));
      loadDom.lastWindow = dom.window;
      return { dom, CFST: dom.window.CFST };
    }

    // Builds the model the renderer consumes, mirroring what main.js assembles.
    function viewModel(context, rows, extra) {
      const summary = statsLib.summarize(rows);
      const ratings = (extra && extra.ratings) || {};
      const next = statsLib.nextToSolve(rows, ratings, 5);
      return Object.assign({
        phase: 'ready', context, handle: 'tester', sheetName: 'Test sheet',
        problems: rows, summary, progress: statsLib.sheetProgress(summary),
        next: { rows: next.rows, total: next.total, all: statsLib.nextToSolve(rows, ratings).rows },
        unsolved: statsLib.unsolvedList(rows), settings: {}
      }, extra || {});
    }

    const HEADER = '<div id="header"><div><a href="/profile/tester">tester</a> | <a href="/logout?csrf=x">Logout</a></div></div>';

    const groupContestHtml = `<html><body>${HEADER}
      <div id="pageContent">
        <div class="datatable">
          <div class="caption titled">Problems</div>
          <table class="problems">
            <tr><th class="top">#</th><th>Name</th></tr>
            <tr class="accepted-problem">
              <td class="id"><a href="/group/oBT5JvzTgq/contest/692989/problem/A">A</a></td>
              <td><div><a href="/group/oBT5JvzTgq/contest/692989/problem/A">Alpha Centauri</a></div>
                  <div><a class="notice" href="/problemset/tags/dp">dp</a></div></td>
            </tr>
            <tr>
              <td class="id"><a href="/group/oBT5JvzTgq/contest/692989/problem/B">B</a></td>
              <td><div><a href="/group/oBT5JvzTgq/contest/692989/problem/B">Beta Decay</a></div></td>
            </tr>
          </table>
        </div>
      </div></body></html>`;

    await test('group contest, contest, gym are comparable; group sheet and problemset are not', () => {
      const { CFST } = loadDom('<html><body></body></html>', 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const gc = CFST.pageContext.detectPage(globalThis.location);
      eq([gc.kind, gc.groupId, gc.contestId, gc.comparable], ['GROUP_CONTEST', 'oBT5JvzTgq', '692989', true]);

      const sheet = loadDom('<html><body></body></html>', 'https://codeforces.com/group/oBT5JvzTgq/problems');
      const gs = sheet.CFST.pageContext.detectPage(globalThis.location);
      eq([gs.kind, gs.contestId, gs.comparable], ['GROUP_SHEET', null, false]);

      const ps = loadDom('<html><body></body></html>', 'https://codeforces.com/problemset');
      eq(ps.CFST.pageContext.detectPage(globalThis.location).comparable, false);

      const gym = loadDom('<html><body></body></html>', 'https://codeforces.com/gym/104000');
      eq(gym.CFST.pageContext.detectPage(globalThis.location).kind, 'GYM');
    });

    await test('problemset-style links are parsed as problems too', () => {
      const { CFST } = loadDom(`<html><body>${HEADER}<div id="pageContent"><table class="problems">
        <tr><th>#</th><th>Name</th></tr>
        <tr><td class="id"><a href="/problemset/problem/1426/A">1426A</a></td>
            <td><a href="/problemset/problem/1426/A">Floor Number</a></td></tr>
        <tr><td class="id"><a href="/problemset/problem/2060/C">2060C</a></td>
            <td><a href="/problemset/problem/2060/C">Game</a></td></tr>
      </table></div></body></html>`, 'https://codeforces.com/group/oBT5JvzTgq/problems');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const { problems } = CFST.problemParser.parseProblems(globalThis.document, context);
      eq(problems.map((p) => p.contestId + '-' + p.index), ['1426-A', '2060-C']);
      eq(problems.map((p) => p.name), ['Floor Number', 'Game']);
    });

    await test('handle comes from the header; a logged-out page yields null', () => {
      const { CFST } = loadDom(`<html><body>${HEADER}<div id="sidebar"><a href="/profile/tourist">tourist</a></div></body></html>`, 'https://codeforces.com/contest/566');
      eq(CFST.pageContext.detectHandle(globalThis.document), 'tester');
      const out = loadDom('<html><body><div id="header"><a href="/enter">Enter</a></div><div id="sidebar"><a href="/profile/tourist">t</a></div></body></html>', 'https://codeforces.com/contest/566');
      eq(out.CFST.pageContext.detectHandle(globalThis.document), null);
    });

    await test('the section is injected into the page flow, right after the problem table', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const target = CFST.problemParser.findInjectionTarget(globalThis.document);
      const rows = matching.classifyAll(parsed.problems, matching.emptyIndex(), context, {});

      CFST.render.render(target, viewModel(context, rows, { fetchedAt: Date.now() }), {});

      const doc = dom.window.document;
      const box = doc.getElementById('cf-stats-root');
      assert(box, 'section was not injected');
      eq(box.parentElement.id, 'pageContent');
      eq(box.previousElementSibling.className, 'datatable');
      assert(box.classList.contains('datatable'), 'must reuse the Codeforces datatable container');
      assert(box.querySelector('.caption.titled'), 'must reuse the Codeforces caption');
      eq(box.getAttribute('style'), null, 'no inline positioning on the section');
    });

    await test('nothing in the stylesheet is fixed, floating, or global', () => {
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '');   // declarations only
      assert(!/position\s*:\s*fixed/.test(code), 'no fixed positioning allowed');
      assert(!/position\s*:\s*sticky/.test(code), 'no sticky positioning allowed');
      assert(!/z-index/.test(code), 'no stacking games needed in normal flow');
      assert(!/font-family/.test(code), 'typography must be inherited from Codeforces');
      code.split('}').forEach((rule) => {
        const selector = rule.split('{')[0].trim();
        if (!selector || selector.startsWith('@')) return;
        assert(/cf-stats/.test(selector), 'unscoped selector: ' + selector);
      });
    });

    await test('re-rendering never produces a second section', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const target = CFST.problemParser.findInjectionTarget(globalThis.document);
      const rows = matching.classifyAll(parsed.problems, matching.emptyIndex(), context, {});
      const model = viewModel(context, rows);
      for (let i = 0; i < 4; i++) CFST.render.render(target, model, {});
      eq(dom.window.document.querySelectorAll('#cf-stats-root').length, 1);
      eq(dom.window.document.querySelectorAll('.cf-stats-extension').length, 1);
    });

    await test('the existing problem table gets one status cell per row, once', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const index = matching.buildSubmissionIndex([sub(1426, 1426, 'B', 'Beta Decay', 'OK')], 'tester');
      // Problem B in the sheet is 692989/B, so the 1426/B accept must not touch it.
      // Row A is green AND proven in this sheet's My Submissions.
      const proof = { available: true, complete: true, contestId: '692989', accepted: ['A'], attempted: [] };
      const rows = matching.classifyAll(parsed.problems, index, context, { sheetProof: proof });
      eq(statusesOf(rows), [S.SOLVED_HERE, S.UNSOLVED]);

      CFST.render.annotateTable(rows);
      CFST.render.annotateTable(rows);
      CFST.render.annotateTable(rows);

      const doc = dom.window.document;
      const table = doc.querySelector('table.problems');
      eq(table.rows[0].cells.length, 3, 'header gained exactly one cell');
      eq(table.rows[1].cells.length, 3);
      eq(doc.querySelectorAll('.cf-stats-cell').length, 3);
      assert(/Solved here/.test(table.rows[1].cells[2].textContent));
      assert(/Unsolved/.test(table.rows[2].cells[2].textContent));
      assert(table.rows[1].cells[2].className.indexOf('cf-stats-cell-here') !== -1);
    });

    await test('loading, logged-out and error states render inside the same section', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const target = CFST.problemParser.findInjectionTarget(globalThis.document);
      const doc = dom.window.document;

      CFST.render.render(target, { phase: 'loading', context, sheetName: 'Test sheet', settings: {} }, {});
      assert(/Reading your submissions for this sheet/.test(doc.getElementById('cf-stats-root').textContent));
      assert(/Test sheet/.test(doc.getElementById('cf-stats-root').textContent), 'the sheet is named while loading');

      CFST.render.render(target, { phase: 'logged-out', context, sheetName: 'Test sheet', settings: {} }, {});
      assert(/track your progress in this sheet/.test(doc.getElementById('cf-stats-root').textContent));

      CFST.render.render(target, {
        phase: 'error', context, settings: {},
        error: { message: 'Codeforces is temporarily limiting requests. Please wait a moment and refresh.' }
      }, {});
      const text = doc.getElementById('cf-stats-root').textContent;
      assert(/temporarily limiting/.test(text));
      assert(!/HTTP|400|429/.test(text), 'no raw status codes in the UI');
      eq(doc.querySelectorAll('#cf-stats-root').length, 1);
    });

    await test('a listing page explains why sources are unknown', () => {
      const { dom, CFST } = loadDom(
        `<html><body>${HEADER}<div id="pageContent"><table class="problems">
          <tr><th>#</th><th>Name</th></tr>
          <tr><td class="id"><a href="/problemset/problem/1426/A">1426A</a></td><td><a href="/problemset/problem/1426/A">Floor Number</a></td></tr>
        </table></div></body></html>`,
        'https://codeforces.com/group/oBT5JvzTgq/problems'
      );
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const index = matching.buildSubmissionIndex([sub(1426, 1426, 'A', 'Floor Number', 'OK')], 'tester');
      const rows = matching.classifyAll(parsed.problems, index, context, {});
      eq(statusesOf(rows), [S.UNKNOWN_SOURCE]);

      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document), viewModel(context, rows), {});
      const text = dom.window.document.getElementById('cf-stats-root').textContent;
      assert(/cannot be attributed/.test(text), 'the limitation must be stated in the page');
      assert(/Unconfirmed/.test(text), 'unconfirmed solves get their own count');
    });

    await test('the stylesheet cannot stretch the page or touch Codeforces layout', () => {
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert(!/clear\s*:\s*both/.test(code), 'clear:both drops the section below the floated sidebar');
      assert(!/min-height/.test(code), 'no min-height anywhere');
      assert(!/\d+(vh|vmin|vmax)/.test(code), 'no viewport-sized boxes');
      assert(!/\boverflow\s*:\s*hidden\b/.test(code.split('.cf-stats-bar')[0] || ''), 'no page-level overflow changes');
      assert(!/(^|[\s,{])(body|html)\s*[,{]/.test(code), 'no global body/html rules');
      assert(!/#pageContent|#sidebar|\.content-wrapper/.test(code), 'no Codeforces containers restyled');
      const rootRule = code.split('#cf-stats-root.cf-stats-extension {')[1].split('}')[0];
      assert(/height:\s*auto/.test(rootRule), 'root must size to its content');
      assert(/box-sizing:\s*border-box/.test(rootRule));
      assert(/width:\s*100%/.test(rootRule));
      assert(/\.cf-stats-scroll\b[^}]*max-height/.test(code), 'tall lists must be capped, not page-stretching');
    });

    await test('a sheet with many problems does not stretch the page', () => {
      const many = [];
      for (let i = 0; i < 120; i++) many.push(problem(692989, 'P' + i, 'Problem ' + i));
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const rows = matching.classifyAll(many, matching.emptyIndex(), context, {});
      const ratings = {};
      for (let r = 800; r <= 3500; r += 100) ratings[r] = 1;      // full rating scale
      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document),
        viewModel(context, rows, { expanded: true }), {});

      const box = dom.window.document.getElementById('cf-stats-root');
      eq(box.querySelectorAll('.cf-stats-scroll').length, 1, 'the expanded list is the only scroller');
      assert(box.querySelector('ol.cf-stats-next').closest('.cf-stats-scroll'),
        '120 remaining problems must scroll inside the section, not stretch the page');
      assert(!/height|min-height/.test(box.getAttribute('style') || ''), 'no inline sizing on the root');
      Array.prototype.forEach.call(box.querySelectorAll('[style]'), (n) => {
        assert(!/(^|;)\s*(height|min-height|position)\s*:/.test(n.getAttribute('style')),
          'inline sizing/positioning found: ' + n.getAttribute('style'));
      });
    });

    await test('a sheet with a couple of problems stays compact', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const rows = matching.classifyAll(parsed.problems, matching.emptyIndex(), context, {});
      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document), viewModel(context, rows), {});
      const box = dom.window.document.getElementById('cf-stats-root');
      // Two problems: A is green (solved, source unconfirmed), B is remaining.
      eq(box.querySelectorAll('ol.cf-stats-next li').length, 1);
      assert(!box.querySelector('.cf-stats-more'), 'no "view all" for a short list');
      assert(!box.querySelector('.cf-stats-scroll'), 'nothing to scroll on a small sheet');
      assert(box.querySelectorAll('*').length < 60, 'the section must stay small: ' + box.querySelectorAll('*').length);
    });

    await test('a flex or grid parent gets no extra column', () => {
      const { CFST } = loadDom(
        `<html><head><style>#pageContent{display:flex}</style></head><body>${HEADER}
         <div id="pageContent"><div class="datatable"><table class="problems">
           <tr><th>#</th><th>Name</th></tr>
           <tr><td class="id"><a href="/contest/566/problem/A">A</a></td><td><a href="/contest/566/problem/A">Matching Names</a></td></tr>
         </table></div><div id="sidebar"></div></div></body></html>`,
        'https://codeforces.com/contest/566'
      );
      eq(CFST.problemParser.isFlowContainer(globalThis.document.getElementById('pageContent')), false);
      const target = CFST.problemParser.findInjectionTarget(globalThis.document);
      eq(target.parent.className, 'datatable', 'must stay inside the sheet container');
      CFST.render.render(target, { phase: 'loading', context: { supported: true }, settings: {} }, {});
      const box = globalThis.document.getElementById('cf-stats-root');
      eq(box.parentElement.className, 'datatable');
      eq(globalThis.document.getElementById('pageContent').children.length, 2, 'no new flex column');
    });

    await test('a changed sheet context is detected', () => {
      const { CFST } = loadDom('<html><body></body></html>', 'https://codeforces.com/group/A1/contest/1');
      const a = CFST.pageContext.detectPage(globalThis.location);
      const other = loadDom('<html><body></body></html>', 'https://codeforces.com/group/A1/contest/2');
      const b = other.CFST.pageContext.detectPage(globalThis.location);
      eq(CFST.pageContext.contextChanged(a, b), true);
      eq(CFST.pageContext.contextChanged(a, a), false);
      eq(CFST.pageContext.contextChanged(null, b), true);
    });

    await test('My Submissions is parsed into accepted / attempted indices', () => {
      const { CFST } = loadDom(`<html><body>${HEADER}
        <table class="status-frame-datatable">
          <tr><th>#</th><th>When</th><th>Problem</th><th>Verdict</th></tr>
          <tr data-submission-id="1"><td>1</td><td>now</td>
            <td><a href="/group/oBT5JvzTgq/contest/692989/problem/A">A - Alpha</a></td>
            <td><span class="verdict-accepted">Accepted</span></td></tr>
          <tr data-submission-id="2"><td>2</td><td>now</td>
            <td><a href="/group/oBT5JvzTgq/contest/692989/problem/B">B - Beta</a></td>
            <td><span class="verdict-rejected">Wrong answer on test 3</span></td></tr>
          <tr data-submission-id="3"><td>3</td><td>now</td>
            <td><a href="/group/oBT5JvzTgq/contest/692989/problem/B">B - Beta</a></td>
            <td><span class="verdict-accepted">Accepted</span></td></tr>
          <tr data-submission-id="4"><td>4</td><td>now</td>
            <td><a href="/contest/1426/problem/C">C - Elsewhere</a></td>
            <td><span class="verdict-accepted">Accepted</span></td></tr>
        </table></body></html>`, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989/my');
      const parsed = CFST.sheetSubmissions.parseStatusDocument(globalThis.document, '692989');
      eq(parsed.accepted.sort(), ['A', 'B']);
      eq(parsed.attempted, [], 'B was eventually accepted');
      assert(parsed.accepted.indexOf('C') === -1, 'a row for another contest must not leak in');
    });

    await test('an empty My Submissions page proves nothing was accepted here', () => {
      const { CFST } = loadDom(`<html><body>${HEADER}
        <table class="status-frame-datatable"><tr><th>#</th><th>Problem</th></tr></table>
        </body></html>`, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989/my');
      const parsed = CFST.sheetSubmissions.parseStatusDocument(globalThis.document, '692989');
      eq(parsed.accepted, []);
      eq(parsed.attempted, []);
    });

    await test('the My Submissions url is built per surface', () => {
      const { CFST } = loadDom('<html><body></body></html>', 'https://codeforces.com/group/G1/contest/42');
      const su = CFST.sheetSubmissions;
      eq(su.mySubmissionsUrl({ groupId: 'G1', contestId: '42' }, 'https://codeforces.com'),
         'https://codeforces.com/group/G1/contest/42/my');
      eq(su.mySubmissionsUrl({ groupId: null, contestId: '566', kind: 'CONTEST' }, 'https://codeforces.com'),
         'https://codeforces.com/contest/566/my');
      eq(su.mySubmissionsUrl({ groupId: null, contestId: '104000', kind: 'GYM' }, 'https://codeforces.com'),
         'https://codeforces.com/gym/104000/my');
      eq(su.mySubmissionsUrl({ groupId: null, contestId: null }, 'https://codeforces.com'), null);
    });

    await test('proof is cached per sheet, so navigating cannot reuse it', () => {
      const { CFST } = loadDom('<html><body></body></html>', 'https://codeforces.com/group/G1/contest/42');
      const su = CFST.sheetSubmissions;
      const a = su.cacheKey('tester', { groupId: 'G1', contestId: '42' });
      const b = su.cacheKey('tester', { groupId: 'G1', contestId: '43' });
      const c = su.cacheKey('tester', { groupId: 'G2', contestId: '42' });
      assert(a !== b && a !== c && b !== c, 'cache keys must separate group and contest');
      assert(a.indexOf('42') !== -1 && a.indexOf('G1') !== -1);
    });

    // The content script resolves `fetch` and `chrome` as free variables, which
    // in a real content script are window's. Under Node they resolve to
    // globalThis, so stubs go there and are restored afterwards.
    function withGlobals(stubs, fn) {
      const saved = {};
      Object.keys(stubs).forEach((k) => { saved[k] = globalThis[k]; globalThis[k] = stubs[k]; });
      const restore = () => Object.keys(stubs).forEach((k) => {
        if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
      });
      return Promise.resolve().then(fn).then(
        (v) => { restore(); return v; },
        (e) => { restore(); throw e; }
      );
    }

    function fakeStorage(store) {
      return {
        storage: {
          local: {
            get: (k, cb) => cb({ [k]: store[k] }),
            set: (o, cb) => { Object.assign(store, o); cb && cb(); }
          }
        }
      };
    }

    await test('the listing is re-read on every load, never served from cache', async () => {
      const url = 'https://codeforces.com/group/G1/contest/42';
      const { CFST } = loadDom('<html><body></body></html>', url);
      const su = CFST.sheetSubmissions;
      const context = { kind: 'GROUP_CONTEST', groupId: 'G1', contestId: '42', comparable: true, supported: true };

      // A cache entry written BEFORE the solve: nothing accepted here.
      const store = {};
      store[su.cacheKey('tester', context)] = {
        fetchedAt: Date.now(),
        proof: { available: true, complete: true, fresh: true, contestId: '42', accepted: [], attempted: ['A'] }
      };

      // The live page now shows an accepted submission for A.
      const html = '<table class="status-frame-datatable">' +
        '<tr><th>#</th></tr>' +
        '<tr data-submission-id="1"><td><a href="/group/G1/contest/42/problem/A">A - Alpha</a></td>' +
        '<td><span class="verdict-accepted">Accepted</span></td></tr>' +
        '</table>';
      let fetched = 0;

      const proof = await withGlobals({
        chrome: fakeStorage(store),
        DOMParser: loadDom.lastWindow.DOMParser,
        fetch: () => {
          fetched++;
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
        }
      }, () => su.load({ context, handle: 'tester' }));

      eq(fetched, 1, 'a cached listing must not suppress the fetch');
      eq(proof.accepted, ['A']);
      eq(proof.fresh, true);
      eq(proof.available, true);
    });

    await test('when the listing cannot be re-read, cached proof comes back stale', async () => {
      const url = 'https://codeforces.com/group/G1/contest/42';
      const { CFST } = loadDom('<html><body></body></html>', url);
      const su = CFST.sheetSubmissions;
      const context = { kind: 'GROUP_CONTEST', groupId: 'G1', contestId: '42', comparable: true, supported: true };

      const store = {};
      store[su.cacheKey('tester', context)] = {
        fetchedAt: Date.now(),
        proof: { available: true, complete: true, fresh: true, contestId: '42', accepted: ['B'], attempted: [] }
      };

      const proof = await withGlobals({
        chrome: fakeStorage(store),
        fetch: () => Promise.reject(new Error('offline'))
      }, () => su.load({ context, handle: 'tester' }));

      eq(proof.available, true, 'cached proof is still usable as positive evidence');
      eq(proof.accepted, ['B']);
      eq(proof.fresh, false, 'it must be flagged so absence cannot disprove a solve');
    });

    await test('pagination links are discovered, foreign links are not', () => {
      const { CFST } = loadDom(`<html><body>
        <div class="pagination"><ul>
          <li><a href="/group/G/contest/692989/my/page/2">2</a></li>
          <li><a href="#">current</a></li>
          <li><a href="/group/G/contest/692989/standings">standings</a></li>
        </ul></div></body></html>`, 'https://codeforces.com/group/G/contest/692989/my');
      const next = CFST.sheetSubmissions.nextPageUrls(globalThis.document, 'https://codeforces.com/group/G/contest/692989/my');
      eq(next, ['https://codeforces.com/group/G/contest/692989/my/page/2']);
    });

    await test('the section is about THIS sheet and shows no account-wide analytics', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const rows = matching.classifyAll(parsed.problems, matching.emptyIndex(), context, {});
      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document),
        viewModel(context, rows, { sheetName: 'Dynamic Programming Basics' }), {});

      const box = dom.window.document.getElementById('cf-stats-root');
      const text = box.textContent;
      eq(box.querySelector('h3.cf-stats-sheet').textContent, 'Dynamic Programming Basics');
      assert(/progress in this sheet/i.test(text), 'the caption must frame it as this sheet');
      [
        /across all of Codeforces/i, /Tags solved/i, /Problem ratings/i,
        /rating/i, /acceptance/i, /all-time/i, /total problems solved/i
      ].forEach((banned) => {
        assert(!banned.test(box.querySelector('.cf-stats-head').textContent + ' ' +
          (box.querySelector('h4.cf-stats-heading') || { textContent: '' }).textContent),
          'account-wide analytics leaked into the headings: ' + banned);
      });
      assert(!box.querySelector('.cf-stats-chart, .cf-stats-tags, .cf-stats-summary'),
        'the old dashboard blocks must be gone');
    });

    await test('progress reads in one glance: fraction, percentage, one bar', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const rows = matching.classifyAll(
        [problem(692989, 'A', 'A'), problem(692989, 'B', 'B'), problem(692989, 'C', 'C'), problem(692989, 'D', 'D')],
        matching.buildSubmissionIndex([
          sub(692989, 692989, 'A', 'A', 'OK'),
          sub(1426, 692989, 'B', 'B', 'OK')
        ], 'tester'), context, {});
      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document), viewModel(context, rows), {});

      const box = dom.window.document.getElementById('cf-stats-root');
      eq(box.querySelector('.cf-stats-fraction').textContent, '2 / 4');
      eq(box.querySelector('.cf-stats-percent').textContent, '50%');
      eq(box.querySelectorAll('.cf-stats-bar').length, 1, 'exactly one progress visual');
      const segs = Array.from(box.querySelectorAll('.cf-stats-seg'));
      eq(segs.map((s) => s.className.replace('cf-stats-seg cf-stats-seg-', '')), ['here', 'elsewhere']);
      const chips = Array.from(box.querySelectorAll('.cf-stats-chips li'))
        .map((li) => li.getAttribute('data-k') + ':' + li.querySelector('.cf-stats-chip-num').textContent);
      eq(chips, ['here:1', 'elsewhere:1', 'unsolved:2'], 'zero-count buckets are hidden');
    });

    await test('next to solve shows five, then expands to the rest', () => {
      const many = [];
      for (let i = 0; i < 9; i++) many.push(problem(692989, 'P' + i, 'Problem ' + i));
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const rows = matching.classifyAll(many, matching.emptyIndex(), context, {});
      const target = CFST.problemParser.findInjectionTarget(globalThis.document);

      CFST.render.render(target, viewModel(context, rows), {});
      const box = dom.window.document.getElementById('cf-stats-root');
      eq(box.querySelectorAll('ol.cf-stats-next li').length, 5);
      assert(/9 remaining/.test(box.querySelector('h4.cf-stats-heading').textContent));
      eq(box.querySelector('.cf-stats-more').textContent, 'View all 9 remaining');

      let expanded = null;
      CFST.render.render(target, viewModel(context, rows), { onToggleAll: (v) => { expanded = v; } });
      dom.window.document.querySelector('.cf-stats-more').click();
      eq(expanded, true, 'the button reports intent back to the controller');

      CFST.render.render(target, viewModel(context, rows, { expanded: true }), {});
      eq(dom.window.document.querySelectorAll('ol.cf-stats-next li').length, 9);
      eq(dom.window.document.querySelector('.cf-stats-more').textContent, 'Show fewer');
    });

    await test('a finished sheet says so instead of showing an empty list', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const rows = matching.classifyAll([problem(692989, 'A', 'Alpha')],
        matching.buildSubmissionIndex([sub(692989, 692989, 'A', 'Alpha', 'OK')], 'tester'), context, {});
      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document), viewModel(context, rows), {});
      const box = dom.window.document.getElementById('cf-stats-root');
      assert(/Every problem in this sheet is solved/.test(box.textContent));
      assert(!box.querySelector('ol.cf-stats-next'));
      eq(box.querySelector('.cf-stats-percent').textContent, '100%');
    });

    await test('the sheet name is read from the page, and falls back honestly', () => {
      const named = loadDom(`<html><body>${HEADER}
        <div id="sidebar"><table class="rtable"><tr><th><a href="/group/oBT5JvzTgq/contest/692989">Dynamic Programming Basics</a></th></tr></table></div>
        </body></html>`, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const ctx1 = named.CFST.pageContext.detectPage(globalThis.location);
      eq(named.CFST.pageContext.detectSheetName(globalThis.document, ctx1), 'Dynamic Programming Basics');

      const titled = loadDom(`<html><head><title>Problems - Graph Theory Sheet - Codeforces</title></head><body>${HEADER}</body></html>`,
        'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const ctx2 = titled.CFST.pageContext.detectPage(globalThis.location);
      eq(titled.CFST.pageContext.detectSheetName(globalThis.document, ctx2), 'Graph Theory Sheet');

      const bare = loadDom(`<html><head><title>Codeforces</title></head><body>${HEADER}</body></html>`,
        'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const ctx3 = bare.CFST.pageContext.detectPage(globalThis.location);
      eq(bare.CFST.pageContext.detectSheetName(globalThis.document, ctx3), 'Contest 692989');
    });

    await test('a rating shown by the page is picked up; none is invented', () => {
      const { CFST } = loadDom(`<html><body>${HEADER}<div id="pageContent"><table class="problems">
        <tr><th>#</th><th>Name</th><th></th></tr>
        <tr><td class="id"><a href="/problemset/problem/1426/A">1426A</a></td>
            <td><a href="/problemset/problem/1426/A">Floor Number</a></td><td>800</td></tr>
        <tr><td class="id"><a href="/problemset/problem/2060/C">2060C</a></td>
            <td><a href="/problemset/problem/2060/C">Game</a></td><td>x1234</td></tr>
      </table></div></body></html>`, 'https://codeforces.com/group/oBT5JvzTgq/problems');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const { problems } = CFST.problemParser.parseProblems(globalThis.document, context);
      eq(problems.map((p) => p.rating), [800, null], 'x1234 is a solve count, not a rating');
    });

    await test('remaining problems link straight to their Codeforces page', () => {
      const { dom, CFST } = loadDom(groupContestHtml, 'https://codeforces.com/group/oBT5JvzTgq/contest/692989');
      const context = CFST.pageContext.detectPage(globalThis.location);
      const parsed = CFST.problemParser.parseProblems(globalThis.document, context);
      const rows = matching.classifyAll(parsed.problems, matching.emptyIndex(), context, {});
      CFST.render.render(CFST.problemParser.findInjectionTarget(globalThis.document), viewModel(context, rows), {});
      const link = dom.window.document.querySelector('ol.cf-stats-next a');
      assert(link, 'no remaining-problem link rendered');
      eq(link.getAttribute('href'), 'https://codeforces.com/group/oBT5JvzTgq/contest/692989/problem/B');
      assert(/Beta Decay/.test(link.textContent), 'the problem is named, not just numbered');
    });
  }

  console.log('\n' + '-'.repeat(52));
  console.log(passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  if (failed) {
    console.log('\nFailures:');
    failures.forEach(([n, e]) => console.log(' • ' + n + ': ' + e.message));
    process.exitCode = 1;
  }
}

main();
