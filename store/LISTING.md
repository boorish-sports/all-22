# Chrome Web Store listing — copy and checklist

Everything below is paste-ready for the developer dashboard. Nothing in it uses
an NFL shield, team mark, or wordmark; "NFL Pro" appears only as a plain-text
reference to the service the extension works with.

## Store listing tab

**Name:** All-22 Film Search

**Summary (132 chars max):**

    Search nflverse play-by-play locally, then watch the matching All-22 clip in NFL Pro. Needs an NFL Pro subscription. Unofficial.

**Category:** Entertainment (pick a sports subcategory if the dashboard offers one).
**Language:** English (United States).

**Detailed description:**

    REQUIRES AN ACTIVE NFL PRO SUBSCRIPTION. This extension does nothing useful without one.

    All-22 Film Search adds a search panel to NFL Pro's film room (pro.nfl.com). Filter 337 columns of nflverse play-by-play — tacklers, pressures, EPA, CPOE, personnel, play action, motion, drops, throwaways, and every other field nflverse publishes — and the matching plays appear instantly. Click a play and its Sideline and Endzone angles play in NFL Pro's own video player, in a side panel, under your own subscription. Frame stepping, speed control and keyboard shortcuts are built in.

    HOW IT WORKS
    • Search is entirely local. A SQLite index of public nflverse data (about 15 MB compressed) is downloaded from GitHub once and cached in your browser; in season, only the weeks that changed are fetched after that. Nothing you search leaves your machine.
    • The only requests made to NFL Pro are one clip lookup per play you click, using your own logged-in session — the same requests the film room makes when you click a play there. No prefetching, no bulk downloading.
    • No video is ever downloaded, copied, cached or re-hosted. Playback is NFL Pro's own DRM player.

    PLEASE READ
    • Unofficial. Not affiliated with, endorsed by, or connected to the NFL or NFL Pro.
    • Fragile. It depends on undocumented NFL Pro endpoints that can change or disappear at any time. If that happens the extension stops working and there may be no fix.
    • Free. There is a pay-what-you-want tip jar on the website; tips are thanks, not a purchase, and are not refunded.

    Data: nflverse-data (CC BY 4.0) with FTN charting; field definitions from nflreadr (MIT). Source code is MIT-licensed on GitHub.

**Homepage URL:** https://boorish-sports.github.io/all-22/
**Support URL:** https://github.com/boorish-sports/all-22/issues

**Store icon:** `store/icon128.png` (128×128, 96 px artwork with 16 px padding).
**Small promo tile (required):** `store/promo-440x280.png`.
**Marquee (optional):** skip.

### Screenshots — Boorish takes these (needs your NFL Pro session)

1280×800 PNG, up to five, no padding. Rules that matter for this listing:

- **Use wide mode** (the chevrons-left button in the panel header). It covers
  the NFL Pro page, so no NFL shield, nav bar, or your account name is visible.
- **Do not show a loaded clip.** Game footage shows helmets, field paint and
  broadcast graphics, all of which are team marks or NFL footage. Take the
  shots with the video area empty (before clicking a play), or with the video
  area covered by a solid `#000` block.
- Good shots: (1) a player + role search with the facet chips open, (2) a
  column-filter search with several chips, (3) the filter dictionary open on a
  search term, (4) the keyboard-shortcut help overlay (press `?` — this one
  needs a clip mounted, so mask the picture), (5) the first-run notice.
- Check each file before upload for any visible logo, wordmark, or personal
  detail, then check again at 100% zoom.

## Privacy practices tab

**Single purpose description:**

    Adds a search panel to NFL Pro's film room (pro.nfl.com) that filters nflverse play-by-play locally and plays the selected clip in NFL Pro's own player.

**Permission justifications:**

- `storage` — Keeps a small map of game identifiers and the user's UI
  preferences (first-run notice dismissed) in chrome.storage.local.
- `unlimitedStorage` — Caches the ~60 MB SQLite play index in IndexedDB so it
  is downloaded once rather than on every visit. Exceeds the default quota.
- `offscreen` — Runs the SQLite WebAssembly engine in an offscreen document.
  The content script runs inside pro.nfl.com, whose Content-Security-Policy
  forbids WebAssembly, and MV3 service workers are not suitable for holding a
  60 MB database in memory.
- Host `https://pro.nfl.com/*` — The extension's entire function: injects the
  search panel into the film room and, when the user clicks a play, requests
  that clip from NFL Pro under the user's own session.
- Host `https://github.com/boorish-sports/all-22-index/*`,
  `https://objects.githubusercontent.com/*`,
  `https://release-assets.githubusercontent.com/*` — Downloads the play index
  (a data file, not code) from the project's GitHub Releases. GitHub redirects
  release downloads through those two asset hosts, so each needs an entry.

**Remote code:** No, I am not using remote code. (If asked: the extension
downloads a SQLite data file from GitHub Releases and verifies its SHA-256
against a manifest before opening it. It contains no executable code. All
JavaScript and WebAssembly ship inside the package.)

**Data usage:** tick nothing under "What user data do you plan to collect?"
The extension collects no personally identifiable information, health,
financial, authentication, personal-communication, location, web-history,
user-activity, or website-content data. Certify all three statements.

**Privacy policy URL:** https://boorish-sports.github.io/all-22/privacy.html

## Distribution tab

**Visibility:** Unlisted.
**Regions:** all.
**Payments:** free.
