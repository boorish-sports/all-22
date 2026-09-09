# Review of HANDOFF.md — 2026-09-09

Phase 1 findings from reading the codebase against the handoff. Everything below
was verified by reading the source or querying `data/plays.db` / the GitHub API;
nothing is taken from the handoff on trust.

## 1. The traffic-profile claim (§1) — holds, with two corrections

Read `extension/panel.js` end to end. Every NFL request originates in
`selectPlay()`, which fires only from a result-row click or the `n` / `p` keys.
There is no prefetch, no cache warming, no `Promise.all` over a result set, no
timer that touches the network. Search, facets and profiles all go through the
`postMessage` bridge to the offscreen SQLite document.

Corrections to the wording:

- **There are two `/api/secured/*` endpoints, not one.**
  `videos/filmroom/plays` resolves a game's UUID (once per game never seen on
  this machine; persisted to `chrome.storage.local.gameUuids` via `iso.js`),
  then `videos/coaches` fetches the clip list for the selected play. Worst case
  for a fresh install is ~272 UUID lookups per season, once.
- **Nothing serialises or spaces the requests today.** Holding `n` auto-repeats
  at ~30 Hz and each repeat calls `clipFor()`. There is also no in-flight guard,
  so responses race and the last one to *resolve* wins, not the last one
  *selected*. Item 7.4 is therefore not hardening — it fixes a live problem.
- NFL's own player component then makes its own asset/licence calls. Those are
  NFL's code doing what it does in the real film room; unchanged by us.

## 2. Things in the handoff that are stale, overconfident, or wrong

1. **The workflow in this repo is a hazard, not an orphan.** §6.2 says
   `.github/workflows/build-index.yml` "has evidently never run from here". True,
   but if this repo is pushed to GitHub it *will* run: it has a daily cron and
   `contents: write`, and would start cutting index releases into the extension
   repo. The real build lives in `boorish-sports/all-22-index` and its copy is
   newer (adds `content_hash`). Removed the workflow here and synced
   `build_index.py` to the index repo's version so there is one source.
2. **`manifest.json` has no `icons` key.** The Web Store rejects a package
   without a 128 px icon. Not mentioned anywhere in the handoff.
3. **Two manifest entries are dev leftovers that reviewers will ask about:**
   `http://localhost:8722/*` in `host_permissions` (unneeded even for dev —
   `server.py` sends `Access-Control-Allow-Origin: *`) and
   `web_accessible_resources` exposing `vendor/sqlite/*` to `pro.nfl.com`
   (nothing calls `chrome.runtime.getURL`; the WASM loads inside the offscreen
   document). Both removed. `https://github.com/*` narrowed to the index repo.
4. **The public README is a reverse-engineering writeup of NFL Pro's private
   API** — 65 filter keys, five other `/api/secured/*` endpoints, the DRM chain.
   It also describes the dev path (`server.py`, load unpacked, "372 columns")
   as if it were the user path. This is the single most letter-attracting file
   in the repo and it is unrelated to what users need. Flagged for Boorish below;
   not rewritten without a decision.
5. **§2's mirror table is incomplete.** `server.py /api/player_roles` returns a
   bare list; `db.js` returns `{default, roles}` sorted by position profile.
   `panel.js` tolerates both, so a developer testing against `server.py` sees
   different default-role behaviour than a user. Also `server.py base_filters`
   pushes a WHERE fragment and then `continue`s without its bind value when a
   numeric column gets a non-numeric value, which is a 500 in dev and a silent
   "0 plays" in the extension. Both fixed as part of item 8.
6. **Group labels can diverge on the next nflverse column.** Python
   `column_groups` calls `.capitalize()` on an unlabelled stem; `db.js groups()`
   does not. Invisible today because every current stem is in `GROUP_LABELS`.
   The committed test now covers labels.
7. **`panel.js` header comment** still says search runs on `localhost:8722`
   with 372 columns. Cosmetic, fixed.
8. **The developer fee is US$5, one-time.** The docs page does not state it (the
   handoff is right about that); the dashboard does. The account also needs
   2-Step Verification, and the dashboard now requires an EU "trader /
   non-trader" declaration before publishing — Boorish's call, see below.
9. **The index repo is public with no LICENSE** and its README credits nflverse
   only by a link. CC-BY-4.0 requires attribution and a licence notice; the
   files are drafted under `store/index-repo/` for Boorish to push (outward-facing,
   so not pushed from here).

## 3. The six open questions (§10)

**1. MIT?** Yes. The fork-and-strip-the-tip-jar scenario is real and does not
matter: anyone motivated enough to re-list it is not a lost tip. MIT is also the
licence that makes "gratuitous tool" unambiguous. The nuance worth knowing is
that MIT covers only the code: `dictionary.json` is derived from nflreadr (MIT,
notice required) and the index is CC-BY (attribution required). Proceeding with
MIT; change `LICENSE` before the first push if you disagree.

**2. Does the listing survive review?** Two different risks, and only one is
in our control.

- *Policy review* — likely passes. Narrow host permissions (one site plus one
  GitHub repo and its asset hosts), no remote code (the index is a data file,
  integrity-checked against a SHA-256 in the manifest — the policy explicitly
  allows "remote resources that are not used to evaluate logic"), one purpose,
  no minification. First-pass rejections come from missing icon, unjustified
  permissions, or a missing privacy URL; all handled. Budget for one
  reject-and-resubmit on wording. Review is "a few days, up to a few weeks".
- *Rights-holder complaint after publication* — this is the real risk, and it
  is not something visibility, wording, or code can mitigate. A complaint pulls
  the item; an appeal takes days and rarely wins against a rights holder.
  Neither Unlisted nor Private changes this.

What we do if it fails or is pulled: (a) the same `build_zip.sh` that builds
the store package also produces the fallback zip, published as a GitHub Release
with "Developer mode → Load unpacked" instructions on the landing page; (b)
Microsoft Edge Add-ons is a second Chromium store with a separate review — the
same zip works there; (c) Firefox is *not* a fallback without a port (no
`offscreen` API). One more thing: register the developer account on an email
you would be fine losing. A policy strike is against the account, not the item.

**3. Index repo public?** Yes, keep it public. The obligation is attribution
and a licence notice, which is a README paragraph and a LICENSE file — drafted.
Making it private would break every existing install's index download.

**4. Throttle or ceiling?** Both, but the ceiling is a bug backstop, not a
user quota. The ecosystem risk is not a power user watching 300 clips in an
evening — the real film room lets them do that and generates *more* requests
per clip. The risk is (a) key auto-repeat or a UI loop firing hundreds of
requests in seconds, which is possible today, and (b) a future regression that
adds an accidental loop. So: one request in flight at a time, rapid selections
coalesce to the latest one, a 1 s minimum gap, and a rolling ceiling of 400
clip requests per hour per page (one every nine seconds for an hour; a clip
plus its second angle takes 20–30 s to actually watch). A daily ceiling punishes
exactly the audience and defends against nothing the hourly one does not. The
counter is per page load, which is fine: a determined abuser can call the
endpoint without us, so persisting it buys nothing.

On 401/403 the panel stops making NFL requests for the rest of the page session
and shows a plain "NFL Pro is no longer serving this endpoint" message. On 429
it pauses for five minutes. No automatic retries anywhere.

**5. Tippers if it dies?** Say it on the page, in this order: tips are thanks
for work already done, not a purchase; nothing is owed in return; no refunds;
and the tip button comes down the day the extension stops working. The last
clause is what makes the first three fair. Offering refunds recreates exactly
the receipt-holding liability §5.1 was designed to avoid.

**6. Legal.** Not answerable here. Two things a lawyer would want to see
first: the README described in §2.4 above, and NFL Pro's terms on automation
and site modification. Both are Boorish's call.

## 4. Decisions needing Boorish (surfaced, not made)

- Trim the public README to what users and contributors need, or keep the
  research writeup. Recommendation: trim before the repo goes public.
- Trader vs non-trader declaration on the CWS dashboard (EU DSA). A free tool
  with a tip jar is usually non-trader, but confirm with the accountant
  alongside the VAT question already noted in §5.1.
- Push the LICENSE / attribution files to `all-22-index`.
- Create the Ko-fi (or Gumroad) page and drop its URL into `docs/index.html`.
- Take the listing screenshots — they need your NFL Pro session. Checklist in
  `store/LISTING.md`.
