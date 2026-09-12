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

### Screenshots

Three at 1280×800 in `store/screenshots/`, taken 2026-09-12 from a live
session over the Season Passing Stats page, no account details in frame:

1. `1-results.png` — the result list for "touchdown" over 2026 week 1
2. `2-clip.png` — the Sideline angle of a Purdy deep touchdown, paused mid-play
3. `3-dictionary.png` — the filter dictionary filtered to "epa"

Upload in that order; the first is the one shown in search results.

## Distribution tab

**Visibility:** Unlisted.
**Regions:** all.
**Payments:** free.
