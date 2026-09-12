# Handoff — public release of All-22 Film Search

**Written:** 2026-09-09. **Audience:** the next agent, plus Boorish.
**Your job:** scrutinise this plan, push back where it's wrong, then implement it and
get the extension onto the Chrome Web Store.

Read this whole file before touching anything. It records decisions *and their
reasons*, so you can overturn them on evidence rather than re-deriving them.

---

## 1. What this is

A Chrome MV3 extension that turns NFL Pro's film room into a searchable index.
The user searches ~48,771 nflverse play-by-play rows **locally**, clicks a play,
and the extension mounts NFL Pro's own React video player in a side panel on
`pro.nfl.com`, playing that clip under the user's own subscription.

It does not download, decrypt, cache, or re-host video. Clips are Widevine /
PlayReady / FairPlay DRM and play in NFL's own player. An active NFL Pro
subscription is mandatory — without one the extension does nothing useful.

### Why the traffic profile matters

This is the single most important fact for the release, and it should shape the
landing page copy and any conversation with the NFL:

- **Search is 100% local.** SQLite/WASM over a ~61 MB index. Zero NFL traffic.
- **One `/api/secured/videos/coaches` call per play the user actually clicks.**
- Game-UUID resolution is cached in `chrome.storage` and persists across sessions
  (`extension/panel.js`, `uuidCache` + `gameUuid()`).
- There is **no prefetching and no bulk enumeration**.

Net effect: a user browsing with this extension generates *less* load on
`/api/secured/*` than the same user clicking around the real film room, because
the filtering that would otherwise hit NFL's servers happens on their machine.

**Do not regress this.** Any feature that prefetches clips, warms a cache, or
walks a result set server-side destroys the argument that keeps this alive.

---

## 2. Architecture

```
build_index.py        downloads nflverse pbp + FTN charting -> data/plays.db
build_dictionary.py   bakes nflverse field docs -> extension/dictionary.json
server.py             local dev backend on :8722 (NOT shipped to users)
roles.py              shared query logic: roles, column groups, SQL expansion
nflpro.py             week-slug helpers

extension/
  manifest.json       MV3
  panel.js            MAIN world content script on pro.nfl.com — the whole UI
  iso.js              ISOLATED world — bridges panel.js to chrome.* APIs
  sw.js               service worker — owns the offscreen document
  db.js               offscreen document — SQLite/WASM, the real backend
  offscreen.html      loads db.js as a module
  dictionary.json     399 nflverse field descriptions, 31.5 KB, committed
  vendor/sqlite/      sqlite3.mjs (628K) + sqlite3.wasm (852K)
```

Extension package is ~1.6 MB. The 61 MB index is downloaded at runtime from
`github.com/boorish-sports/all-22-index/releases/latest` (see `DEFAULT_MANIFEST`
in `db.js`) and cached in IndexedDB.

### Columns that arrive after the play

nflverse's play-by-play lands within hours of a game. **FTN's charting layer
does not** — it is charted by hand, `nflreadr` documents it as "charted within
48 hours following each game", and nflverse polls FTN every six hours through
the season (`nflverse/nflverse-ftn`, `update_ftn.yaml`). Sunday's games are
therefore charted by Tuesday and Monday night's by Wednesday, which is when a
*week* becomes complete.

Left unsaid, that lag is a silent wrong answer: "Play action: Yes" over the
newest week returns nothing, and `0 plays` reads as an honest zero. So
`roles.LATE_SOURCES` (mirrored in `db.js`) names each late source, the columns
it supplies, and the weekday its drop is due; `/api/meta` measures how far it
has actually got — games charted out of games played in the newest week — and
`panel.js` says so wherever one of those columns is picked: the filter hint, the
dictionary row, and the `0 plays` line. The notice only turns amber when the
*selected* season/week reaches the uncharted weeks; on 2025 it stays a muted
line about the cadence.

The column list in `LATE_SOURCES` must stay in step with `FTN_COLS` in
`build_index.py`; `tests/test_mirror.py` fails if it drifts, and
`tests/test_late.mjs` drives the wording through every coverage state.

Not covered yet: the player facet rows. "No huddle" under a player is
`is_no_huddle`, an FTN column, but the facets come back as opaque sub-filter
keys with no column behind them, so a facet count of 0 on the newest week is
still unexplained. Worth fixing by having `/api/player_subfilters` return the
source key per row.

### The mirror rule — read this twice

**`server.py` + `roles.py` and `extension/db.js` are two hand-written
implementations of the same query layer.** Users only ever run `db.js`.
`server.py` exists for local development.

Every one of these exists in both, and they must stay in step:

| logic | python | javascript |
|---|---|---|
| column groups (merged slot columns) | `roles.column_groups` | `db.js groups()` |
| group SQL expansion | `roles.group_sql` | `db.js groupSql()` |
| `like` auto-wrapping | `roles.like_pattern` | `db.js likePattern()` |
| binary (yes/no) detection | `server.binary_columns` | `db.js binaryColumns()` |
| redundant-flag detection | `server.redundant_flags` | `db.js redundantFlags()` |
| column profiling | `server.profile` | `db.js profile()` |

A divergence here already shipped a user-visible bug (see §8). If you touch one
side, diff the two — §9 explains how.

---

## 3. State of play

Recently completed and verified working in the live extension:

- Header reduced to title + two Lucide icons; a tray strip on the panel edge in
  wide mode restores the NFL Pro page.
- **Merged columns.** nflverse splits one stat across numbered slots
  (`forced_fumble_player_1/2_player_name`, four `assist_tackle_*` slots, two
  half-sacks). 62 columns collapse into 27 `@`-prefixed synthetic columns that OR
  across the slots. Negative operators are *not* OR: `ne` means "no slot matches"
  (NULL-safe AND) and `isnull` means all slots empty.
- **`like` contains.** A `like` value with no `%` is wrapped as `%value%`.
  Values that already carry a `%` pass through, so anchored patterns still work.
- **Yes/No for binary columns.** 93 columns whose every non-null value is 0 or 1
  *and where both states occur*. The operator menu and value box are replaced by
  a Yes/No picker. The both-states rule keeps `play_clock` out — it's a real
  number column that happens to be all-zero this season.
- **Redundant flags hidden.** 6 flags measured to be exactly "the merged column
  is set" (`fumble_forced`, `qb_hit`, `solo_tackle`, `assist_tackle`,
  `tackle_with_assist`, `fumble`). `sack` and `tackled_for_loss` were tested and
  are *not* redundant, so they stay.
- **Filter dictionary.** Book icon in the header opens a searchable reference of
  all 296 options with nflverse's definition and real values from the user's own
  index. Descriptions are cleaned at generation time (238 of 337 rewritten to
  drop type boilerplate).
- **Contrast.** All dim greys lifted; three were below WCAG AA on `#121212`.

Nothing here is known-broken. There are no failing tests (there are no tests —
see §7 item 8).

---

## 4. The goal

Ship this publicly, pay-what-you-want, without setting Boorish up to be holding
refund liability when NFL Pro breaks it.

Context: the project got significant attention on NFL analytics Twitter today,
so there is real inbound demand and a real, raised profile.

---

## 5. Decisions already made — and why

Overturn any of these if you have a better argument, but bring the argument.

**5.1 The software is free. Money is tips only. No paywall, no license key.**
- A takedown leaves nobody holding a receipt for a dead product.
- No auth server, no key issuance, no revocation, nothing to keep alive.
- A gratuitous tool with a tip jar is a materially different legal posture than
  selling access to software whose only function targets a third party's paid
  service.
- Selling downloads internationally drags in EU VAT/MOSS and US sales-tax nexus.
  Donations generally don't. (Boorish to confirm with an accountant.)
- The Chrome Web Store removed its own payments system years ago, so payment is
  off-platform regardless.

**5.2 Chrome Web Store listing, with a self-hosted zip documented as fallback.**
Chrome blocks non-store installs for ordinary users on Windows and macOS; the
alternative is "enable Developer Mode and load an unpacked folder", which loses
most of a viral audience. CWS gives one-click install and auto-update. The cost
is a gatekeeper who can remove the item on a complaint — so the fallback must be
written *before* it's needed.

**5.3 Launch Unlisted, promote to Public later.** See §6.3.

**5.4 The disclaimer is prominent and honest, not buried.** "This may die at any
time and there will be no fix" is the actual truth and needs to appear before
anyone pays anything.

**5.5 No NFL marks anywhere.** No shield, no team logos, no wordmarks in the
icon, screenshots, or listing. Trademark use is the fastest route from
indifference to a letter.

---

## 6. Verified facts

All checked 2026-09-09. Re-verify anything load-bearing before relying on it.

**6.1 Licensing**
- `nflverse-data` (the pbp + FTN source) is **CC-BY-4.0**. Commercial use is
  permitted; **attribution is required**, not optional. Boorish redistributes a
  derived index from his own GitHub releases, so this applies.
- `nflreadr` (source of the field descriptions baked into `dictionary.json`) is
  **MIT**. The copyright notice must ship with the derived file.
- **This repo has no LICENSE file.** Nothing in it is currently grantable.

**6.2 Repo state — item zero**
- **`~/Documents/App Development/all-22` is not a git
  repository.** No `.git`. There is a `.github/workflows/build-index.yml` that
  has evidently never run from here.
- There is **no `.gitignore`**, and `data/` is **112 MB**. It must never be
  committed. Neither should `__pycache__/`.
- The index lives in a *separate* repo, `boorish-sports/all-22-index`, as release
  assets. Confirm that repo's state and licensing before launch.

**6.3 Chrome Web Store — the "beta" question**

Verified against `developer.chrome.com/docs/webstore/cws-dashboard-distribution`.
Three visibility settings:

| option | meaning |
|---|---|
| **Public** | Listed and searchable by everyone. |
| **Unlisted** | No store listing, but **anyone with the URL can install**. Not searchable. |
| **Private** | Installable only by named **trusted testers** (Google accounts you list), members of Google Groups you own, or — for Workspace domains whose admin enables it — a whole domain. |

**The catch, and it's the direct answer to the question asked:** all three
visibility levels go through the **same policy review**. Unlisted does not skip
approval, it only hides you from discovery and search. So you cannot use it to
dodge review, but you *can* use it to hand out a link to a controlled group,
iron things out, and flip to Public without a second review cycle.

There is also a **staged rollout** for updates — `setPublishedDeployPercentage`
in the CWS API — which publishes a new version to a percentage of existing
users. Useful once live; irrelevant for the first launch.

Registration requires a one-time developer fee. The docs page didn't state the
amount and I could not verify it, so confirm at registration rather than
quoting a number to anyone.

**Recommended path:** register → submit as **Unlisted** → hand the link to a
small group from the Twitter thread → fix what breaks → flip to **Public**.

---

## 7. Work items

Ordered. Each has an acceptance criterion. Push back on any that look wrong.

**1. Initialise the repo properly.**
`git init`, and a `.gitignore` covering `data/`, `__pycache__/`, `*.pyc`,
`.DS_Store`. Verify with `git status` that no file over ~1 MB is staged.
*Accept:* clean `git status`, `data/` untracked, first commit under 2 MB.

**2. LICENSE + attribution.**
MIT for the code (confirm with Boorish — MIT does permit someone forking and
stripping the tip jar; that's normal and rarely happens). Add `NOTICE.md` or an
attribution block in the README crediting nflverse (CC-BY-4.0, with a link) and
FTN charting, plus the nflreadr MIT notice covering `dictionary.json`.
*Accept:* both licences reproduced accurately; attribution visible in the repo
and in the extension's dictionary view or options page.

**3. First-run disclaimer inside the extension.**
The landing page will be missed by most installs. On first run, show a dismissible
notice in the panel covering: needs an active NFL Pro subscription; unofficial and
unaffiliated; uses undocumented endpoints that can break permanently at any time;
no video is downloaded or re-hosted. Persist dismissal in `chrome.storage`.
*Accept:* appears once on a fresh profile, never again after dismissal, and does
not block the panel's normal use.

**4. Request throttle + graceful 403.**
This is the item that most affects whether the tool survives. Add a client-side
minimum interval between `/api/secured/*` calls, and make a 401/403/429 render a
clear "NFL Pro is no longer serving this endpoint" state rather than a spinner or
a silent failure. Do **not** add retries with backoff that could amplify load.
*Accept:* rapid-fire play clicking issues serialised, throttled requests; a
simulated 403 produces a readable message.

**5. Privacy policy.**
Required by CWS. The honest version is short: the extension stores game-ID
mappings and UI preferences locally in `chrome.storage`, downloads a public data
file from GitHub, and transmits nothing to anyone. Host it wherever the landing
page lives.
*Accept:* a public URL, linked from the CWS listing.

**6. CWS listing assets.**
Icon (no NFL marks), screenshots of the panel — check them for any visible NFL
logo or personal account detail before upload — short and long descriptions
leading with "requires an active NFL Pro subscription", and a justification for
each permission. Expect review to ask about the `github.com` host permissions;
the answer is the index download.
*Accept:* submission passes review as **Unlisted**.

**7. Landing page + tip jar.**
Ko-fi (0% on tips) or Gumroad (PWYW with a $0 floor, ~10%). If it ever becomes a
real purchase rather than a tip, use a merchant-of-record (Lemon Squeezy, Polar)
so they absorb tax compliance. The disclaimer from §5.4 goes above the fold and
again at checkout.
*Accept:* a page that states the subscription requirement and the
may-die-at-any-time warning before any payment UI.

**8. A real test for the mirror rule.**
Everything in §2's table is currently verified by throwaway harnesses that no
longer exist. Before this is a public project taking money, there should be one
committed script that runs both implementations over `data/plays.db` and diffs
them. See §9 for the technique that works.
*Accept:* one command, exits non-zero on divergence.

---

## 8. Landmines

Real things that have already cost time here.

- **`node --check` is not enough for `db.js`.** A stray brace once closed
  `handle()` early, leaving the remaining `op ===` branches at module top level.
  It parsed fine and would have thrown at load, breaking the whole extension.
  Verify structurally — brace-match `handle()` and assert every branch is inside
  it — not just syntactically.
- **`CSS` is shadowed inside `panel.js`.** The file declares
  `const CSS = \`...\`` for its stylesheet, so the global `CSS` object — and
  therefore `CSS.escape` — is unreachable in that IIFE. Match on `dataset`
  instead.
- **Merged columns have no schema entry.** `cols()[col]` is `undefined` for an
  `@` key. Code that tests `!== "TEXT"` will misclassify them as numeric. Both
  backends now resolve the type from the first member; keep it that way.
- **The two backends diverge silently.** The bug above shipped because every
  harness pointed at `server.py`, and `db.js` — the one users actually run — was
  never exercised. Test the JavaScript path specifically.
- **Async timing in screenshots.** The panel loads `/api/columns` and profiles
  asynchronously; screenshots taken too early show empty state and look like
  bugs. Wait and re-query before concluding anything is broken.
- **Descriptions are cleaned at build time**, in `build_dictionary.py`, not at
  render time. Re-run it after changing the cleaner; the committed JSON is the
  artifact.

---

## 9. How to verify things here

There is no test suite. The technique that has worked is **extracting the real
functions out of the source files with regexes and running them against the real
database**, rather than reimplementing them in a harness — a reimplementation
proves nothing about the shipped code.

For `db.js`, stand in for the WASM handle with the `sqlite3` CLI:

```js
const { execFileSync } = require("child_process");
const run = sql => JSON.parse(
  execFileSync("sqlite3", ["-json", "data/plays.db", sql], { maxBuffer: 1 << 28 })
    .toString().trim() || "[]");
const db = {
  selectArrays: sql => run(sql).map(o => Object.values(o)),
  selectObjects: sql => run(sql),
};
```

Then `new Function(...)` the extracted source with `cols`, `db` and `fetch`
injected. This is how the merged-column bug was finally caught. Item 7.8 should
turn this into a committed script.

Guard against one trap: a harness that populates only *some* of the state
`panel.js` populates will produce fake failures. A chip once rendered as
`@sack player name` purely because the harness never filled `GROUPS`.

---

## 10. Scrutinise these

Genuine open questions. Don't just implement around them.

1. **Is MIT right?** It lets anyone fork, strip the tip jar, and re-list. For a
   viral free tool that is usually fine and rarely happens, but it is Boorish's call
   and he hasn't explicitly made it.
2. **Does the CWS listing survive review at all?** Nobody has tested this. An
   extension whose function depends on a third party's paid service may draw
   scrutiny. Have the self-hosted fallback ready before submitting, not after.
3. **Should the index repo be public?** `all-22-index` hosts a CC-BY derived
   dataset. Attribution obligations apply there too, and its current state is
   unverified.
4. **Is a throttle enough**, or should there be a hard daily ceiling on
   `/api/secured/*` calls per install? A ceiling protects the ecosystem but will
   annoy the power users who are exactly the audience.
5. **What happens to tippers if it dies in week one?** Even for gratuitous tips,
   decide the posture now and say it on the page rather than improvising later.
6. **Legal review.** Neither I nor you can answer whether this complies with NFL
   Pro's terms of service. If tips become meaningful money, that is an hour with
   a software/IP lawyer, and it should happen before the profile rises further,
   not after.
