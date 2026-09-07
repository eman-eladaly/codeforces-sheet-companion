# Codeforces Statistics

A Manifest V3 extension that answers one question, inside the Codeforces page
itself: **how am I doing on this sheet?**

It is a companion for the sheet you are looking at, not an analytics dashboard
for your account. It shows the sheet's name, your progress through it, how many
of its problems you solved here versus elsewhere, and which ones are left.
Nothing account-wide — no overall rating, no global solve counts, no tag or
rating breakdowns of your whole history. No popup, no floating panel, no overlay, no fixed positioning —
the section is a normal block in the document flow, built from Codeforces' own
`datatable` / `caption titled` containers, and it inherits the page's typography.

## Install

1. `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. **Load unpacked** → select this folder (the one with `manifest.json`)
4. Open a Codeforces contest, group contest or group problemset

The section appears directly under the problem table, and each row of that table
gains a Status cell.

## The bug: why "solved elsewhere" was reported as "solved here"

The previous index folded the entire submission history into a boolean keyed by
**problem identity**:

```js
solvedKeys = { "1426/A": true }          // built from problem.contestId + index
...
if (lookup.solved[key]) solvedHere = true;
```

`contestId + index` identifies *which problem* was solved. It says nothing about
*where the submission was made*. Any accepted submission — practice, a normal
round, another group, the problemset — therefore satisfied the "solved here"
branch. Problem identity was being used as evidence of submission context, and
those are two different things. The page-highlight signal was merged into the
same boolean, so it could not be told apart either.

## The fix

`src/core/matching.js` now keeps, per problem, the **set of contexts an accepted
submission actually came from**:

```js
keys["692989/A"] = { ctx: ["692989"], pt: ["CONTESTANT"], att: false }
```

`ctx` holds the contest ids the accepted submissions were made in (Codeforces'
`Submission.contestId`, which for a group contest is that group contest's own
id). Classification compares that set against the context of the page being
viewed:

| Situation | Result |
| --- | --- |
| the index is Accepted in this sheet's My Submissions | **Solved here** |
| an accepted submission's contest id equals the current contest id | **Solved here** |
| Codeforces highlights the row green, with no in-sheet accept | **Solved elsewhere** |
| accepted, but only under other contest ids | **Solved elsewhere** |
| accepted, but the page has no contest of its own to compare against | **Unknown source** |
| the row is green but the problem belongs to another contest | **Unknown source** |
| accepted, but Codeforces did not report which contest | **Unknown source** |
| same title under a different problem id (opt-in) | **Unknown source**, marked `?` |
| no accepted submission | **Unsolved** |

"Solved here" is never inferred from problem identity alone, and a guess is
never promoted to "here".

### Third pass: the green row was never proof

Reported symptom: the section said **Solved Here** while the sheet's own
**My Submissions** listed no accepted submission for that problem — it had been
solved in another group.

Root cause: `pageProvesHere`. The code treated Codeforces' green
`accepted-problem` row as contest-scoped evidence. It is not. Codeforces derives
that highlight from the underlying problem, so on a sheet built from copied
problems the row turns green for a solve made anywhere. That branch is deleted.
A green row now means only "solved somewhere" and can never produce
"solved here".

Replacing it: `src/content/sheet-submissions.js` reads the sheet's own
**My Submissions** page (`/group/<gid>/contest/<cid>/my`, `/contest/<cid>/my`,
`/gym/<cid>/my`) — the same page you checked by hand — and extracts which
problem indices were accepted *inside this sheet*. That is the only source that
works for private groups, where the public API is blind.

"Solved here" now requires one of two positive proofs:

1. the problem's index appears as **Accepted in this sheet's My Submissions**, or
2. the API reports an accepted submission whose contest id **is** this contest
   (and the sheet listing does not contradict it).

Absence of the problem from a **completely read** My Submissions list actively
disproves "here": a green row with no in-sheet accept is reported as **Solved
elsewhere**. A partially read list never disproves anything. When the page
cannot be read at all, the section says so and falls back to API-only evidence
rather than guessing.

Proof is cached per sheet (`cfstats:sheet:<handle>:<group>:<contest>`, 5 minutes,
cleared by Refresh and on navigation), so one sheet's result can never be reused
for another.

### Second pass: three more paths that could reach "solved here"

1. **The page highlight was trusted for foreign rows.** A sheet that links to
   `/problemset/problem/1426/A` shows a problem belonging to contest 1426.
   Codeforces paints that row green because you solved it *somewhere*. The
   highlight is now only accepted as proof of "here" when the row's problem
   actually belongs to the contest the page represents
   (`String(problem.contestId) === context.contestId`).
2. **Submissions with no reported contest.** `Submission.contestId` may be
   absent. Falling back to `problem.contestId` would invent a context equal to
   the problem's own contest, which can match the page and fake a "here". Those
   accepts are now recorded as `unk` and resolve to unknown source.
3. **Stale context across sheets.** The context is re-detected on URL change and
   the section is rebuilt, so a new sheet is never classified against the
   previous contest.

API evidence always outranks the page highlight: if Codeforces reports where
every accepted submission happened and none happened here, the answer is
"solved elsewhere" even when the row is green.

### Why "unknown source" exists

A group *problemset* (`/group/<code>/problems`) has no contest of its own; it
links to problems that live in normal contests. Solving `1426/A` through that
sheet and solving it from the problemset produce an identical submission record,
so the source genuinely cannot be determined. Rather than guess in either
direction, those problems are reported as unknown source and the section says
why. Pages that *do* have a contest of their own (`/contest/<id>`,
`/gym/<id>`, `/group/<code>/contest/<id>`) are fully decidable.

## Files

| File | Role |
| --- | --- |
| `src/core/matching.js` | identity, context-preserving index, classification |
| `src/core/stats.js` | sheet counts, sheet progress, next-to-solve list |
| `src/core/cf-api.js` | Codeforces API client: throttling, paging, caching |
| `src/core/errors.js` | HTTP/API failures → sentences, never raw status codes |
| `src/content/page-context.js` | which surface is this, and is it comparable |
| `src/content/problem-parser.js` | reads problems from the page, finds the injection point |
| `src/content/sheet-submissions.js` | reads this sheet's My Submissions: proof of what was accepted here |
| `src/content/render.js` | DOM injection and the in-table status cells |
| `src/content/styles.css` | namespaced styles, no font-family, no positioning |
| `src/content/main.js` | orchestration |
| `src/background/service-worker.js` | all network calls, one queue for the browser |

Removed in this rewrite: `src/popup/*` and the fixed-position panel
(`src/content/panel.js`, `panel.css`). The `action` key and
`web_accessible_resources` are gone from the manifest — there is no extension UI
outside the page.

## Layout: why the page was getting taller

The section carried `clear: both`. Codeforces floats `#sidebar`, so clearing
dropped the section below the entire sidebar and left a page-tall gap after the
last problem. Removed. The section now sits in normal flow directly after the
problem table's container, beside the sidebar like any other Codeforces block.

Also fixed:

- the root is `width: 100%; height: auto; box-sizing: border-box` — its height
  is its content, with no `min-height`, no fixed height, no viewport units and
  no inline sizing;
- the rating scale (800–3500) and the unsolved list on a long sheet were free to
  grow to any height. Both, plus the tag list, are now capped and scroll
  *inside* the section, so a 120-problem sheet adds no more page height than a
  three-problem one;
- internal margins and padding were reduced;
- appending to a flex or grid parent would have created a new column, so in that
  case the section goes inside the table's own container instead.

No rule in the stylesheet touches `body`, `html`, `#pageContent`, `#sidebar` or
`.content-wrapper`, and none of them can change page scrolling — asserted by a
test that scans the compiled declarations.

## How the injection works

1. `findInjectionTarget()` looks for `table.problems` / `.datatable`, and inserts
   after its container; otherwise it appends to `#pageContent`, then
   `.content-wrapper`, then `#content`.
2. `ensureRoot()` looks up `#cf-stats-root` first and reuses it. Re-rendering,
   navigation and Codeforces DOM updates can only ever update the one node —
   there is a test that renders four times and asserts a single section.
3. `annotateTable()` appends one `Status` cell per row, tagging each row with
   `data-cf-stats-status` so repeat calls update instead of appending.
4. A `MutationObserver` on `document.body` (childList only, debounced) restores
   the section if Codeforces replaces the content.

Every selector is scoped under `.cf-stats-extension` or the `cf-stats-` prefix.
No Codeforces rule is overridden, and no `font-family`, `position: fixed`,
`position: sticky` or `z-index` appears anywhere in the stylesheet — all four are
asserted by a test.

## What the section shows

```
Your progress in this sheet
  Dynamic Programming Basics
  Assiut Newcomers · tester

  4 / 12 solved                                33%
  ███████░░░░░░░░░░░░░░░░

  ✓ 2 Here    ↗ 2 Elsewhere    ○ 8 Left

  Next to solve                        8 remaining
  E  Team                                     1200
  F  Next Round                               1300
  ...
  View all 8 remaining

  Refresh   Updated 13:25              match by title
```

Five problems are listed by default, easiest first where a rating is known;
"View all" expands the rest into a capped, internally scrolling list so the page
never grows. The "Unconfirmed" count appears only when it is not zero. Account-
wide charts (rating histogram, tag ranking) were removed: they answered a
question this extension is not for.

## Data

Official, documented, anonymous endpoints only:
`user.status` and `contest.status` (<https://codeforces.com/apiHelp/methods>).
No API key, no password, no cookie, no token; every request sends
`credentials: 'omit'`. Codeforces allows one call per two seconds, so all calls
go through a single queue in the service worker with a 2.1 s gap, paging capped
at five calls. Results are cached per handle for 10 minutes; **Refresh** in the
section footer ignores the cache. Ratings and tags come from the `problem`
objects in your own submissions and are aggregated at fetch time.

Handled: rate limits, 400/403/404/5xx, network failures, private groups,
signed-out users, empty sheets, pages with no problems — each with a sentence,
never a status code.

## Debug logging

One summary line is always logged. Per-problem tracing in the format requested is
off in production; turn it on with:

Per-problem tracing is now **on by default** so any status can be traced to its
evidence. Silence it with:

```js
localStorage.setItem('cfStatsDebug', '0')   // then reload
```

```
[CF Stats]
  Current Sheet ID:    692989
  Current Group ID:    oBT5JvzTgq
  Problem ID:          692989/A  (Alpha)
  Submission Contest:  700111
  Submission Source:   accepted in 700111, nothing accepted in 692989
                       (checked against this sheet's submissions)
  In-sheet accepted:   no
  Detected Status:     SOLVED ELSEWHERE
```

Plus one line per load:

```
[CF Stats] Current Sheet ID: 692989 | Current Group ID: oBT5JvzTgq |
           In-sheet submissions: 1 accepted, 1 failed
```

## Tests

```
node tests/run-tests.js
```

61 checks, including the six acceptance cases, regression tests pinning each
false-"here" path (including the green-row case and the My Submissions parser), and layout tests covering long sheets, short sheets, flex
parents and page-height leaks. DOM tests need `jsdom`; without it they report as skipped, never
as passed.

## Limitations

- Private group submissions are not exposed by the public API, so "solved here"
  in a private group depends on reading that sheet's My Submissions page. If
  Codeforces changes that page's markup, or the request fails, the section says
  so and reports unknown source instead of guessing.
- Reading My Submissions is a same-origin request for a page you can already
  open; the browser attaches its own session as it would for a normal click. The
  extension never reads, stores or forwards any credential, and API calls are
  still sent with `credentials: 'omit'`.
- Copied group problems carry a new contest id and no link to the original, so a
  solve of the original can only be spotted by title. That is opt-in, and it
  produces "unknown source" — never "solved elsewhere" and never "here".
- `contest.standings` is not used at all: Codeforces restricts it to gym and
  mashup contests, so the problem list is read from the page.
- Problem ratings in "Next to solve" are shown only when the sheet's own table
  prints them, or when they are already known from a submission of yours. A
  rating is never invented, and the slot is left blank when Codeforces does not
  state one.
