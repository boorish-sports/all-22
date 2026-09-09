# All-22 — fast film lookup for NFL Pro

Search nflverse play-by-play locally, then jump straight to that play on NFL Pro.
No video is downloaded, copied, or re-hosted. Playback happens on pro.nfl.com in
your own logged-in browser, under your own subscription.

## Run

```bash
python3 build_index.py 2025      # once per season (downloads nflverse pbp)
python3 server.py                # http://localhost:8722
```

## What was found

All of this came from NFL Pro's public JS bundle (`pro.nfl.com/_nuxt/*.js`).

### 1. The film room is fully URL-addressable

The app does:

```js
$router.replace({ name: "film-plays", query: q })   // and
$api.$get("/api/secured/videos/filmroom/plays", { params: q })
```

with the **same object** `q`. So the query string on `/film/plays` *is* the API
filter payload. Its router:

```js
if (q.displayGameFilmCards) return "cards";
if (q.gameId)               return "plays";   // <- skips the game-card grid
if (!q.season)              return "generic";
```

A `gameId` in the URL lands directly on the play list — no week picker, no game
card, no drilling. That is where the twenty clicks go.

### 2. ID mapping (verified against nflverse)

| NFL Pro | nflverse | example |
|---|---|---|
| `gameId` / `fapiGameId` | `old_game_id` | `2025090500` |
| `playId` | `play_id` | `476` |
| `nflId` | `players.csv` → `nfl_id` | `40011` (Kelce) |

nflverse `play_id` is the sparse GSIS numbering (1, 40, 63, 85…) — the same one
NFL Pro uses. So a play you found in nflverse is directly addressable.

### 3. Exact single clip

The film-room page **never reads `playId` from the URL** — it always auto-selects
`plays[0]`. So a URL narrows to a short list, not one play. For an exact clip:

```
GET /api/secured/videos/coaches?gameId=<fapiGameId>&playId=<playId>
GET /api/plays/summaryPlay?gameId=<fapiGameId>&playId=<playId>
```

Response `items[]`, one per angle:

```js
{ cameraSource: "Broadcast" | "Sideline" | "Endzone",
  mcpPlaybackId, description, thumbnail: { thumbnailUrl }, ids: { gameId } }
```

`Sideline` + `Endzone` are the All-22 coaches angles; `mcpPlaybackId` is what
NFL's own player takes. `/api/secured/*` requires your session; the rest is
same-origin from pro.nfl.com.

### 4. Filter vocabulary (65 keys, all legal URL params)

`passerId` `rusherId` `targetId` `routeRunnerId` `defenderId` `nflId`
`possessionTeamId` `defenseTeamId` `teamId` `down` `quarter` `yardsToGoType`
`goalToGo` `redzone` `scoring` `playType` `passPlay` `runPlay` `dropback`
`playAction` `completion` `reception` `target` `attempt` `touchdown`
`interception` `sack` `fumble` `fumbleLost` `pressure` `blitz` `passRushSnap`
`turnoversCausedByPressure` `offensePersonnel` `personnel` `qbAlignment`
`receiverAlignment` `teamCoverageTypeManZone` `teamCoverageTypeSafetyShell`
`defendersInTheBoxType` `db` `dl` `lb` `rb` `te` `wr` `routeType`
`targetLocation` `airYardType` `separationType` `dropbackTimeType`
`rushDirection` `maxSpeedType` `coverageSnap` `defensiveSnap` `runDefenseSnap`
`runStuff` `tackles` `tackleStop` `hustleStop` `linedUpInTheBox` `ballCarrier`
`carries` `receptionNearestDefender` `receivingTDNearestDefender`
`targetNearestDefender`

Booleans take `1`; enums take the UI token (`play_type_pass`, `11_PERSONNEL`,
`SHOTGUN`, `SHORT`, `QUICK`, `LIGHT` …).

`weekSlug`: `WEEK_1`..`WEEK_18` (REG), `WC`/`DIV`/`CONF`/`SB` (POST),
`HOF`/`P1`..`P4` (PRE).

### 5. Other endpoints seen

`/api/secured/plays/playlist/game`, `/api/secured/plays/winProbability`,
`/api/videos/filmSavedSearches` + `addSavedSearch`/`deleteSavedSearch`
(saved searches are stored server-side against your account),
`/api/stats/gamecenter`, `/api/teams/depth-chart`, `/api/players/search`.

## Exact clip: how playback actually works

`mcpPlaybackId` is not a video URL. NFL's player resolves it via
`api.nfl.com/play/v1/asset/<mcpID>`, and that stream is **DRM protected** —
Widevine, PlayReady and FairPlay (`get-widevine-license`,
`wv-keyos.licensekeyserver.com`, `connect.conax.com`), played through THEOplayer
under a **domain-locked licence** (`validate.theoplayer.com`).

So a `<video>` tag or hls.js on localhost can never play these. Verified working
the other way round: mounting NFL's own `NflRnUmdComponents.Video.Video`
component **on pro.nfl.com** plays the clip (`readyState 4`, `blob:` source)
with a two-item Sideline+Endzone playlist.

That is why the search UI is injected into pro.nfl.com rather than served from
localhost. The panel goes to the video.

### The ID chain (all verified against the live API)

    nflverse old_game_id + play_id          2025090705 / 115
      -> /api/secured/videos/filmroom/plays?...&gameId=2025090705
         returns plays[].fapiGameId          f591a18c-311e-11f0-b670-ae1250fadad1
      -> /api/secured/videos/coaches?gameId=<UUID>&playId=115
         returns Broadcast / Endzone / Sideline mcpPlaybackIds

**The coaches endpoint requires the UUID.** Pass the numeric `old_game_id` and it
returns `200` with an empty `items` array — a silent miss, not an error.

NFL Pro's `playId` values for that game (`40, 63, 85, 115, 135, 166, 188, 214,
243, 266, 289, 327`) match nflverse `play_id` exactly.

### Angles

`ANGLES = ["Sideline", "Endzone"]` — Broadcast excluded. This is also NFL Pro's
own default for `auth/clipTypeSettings`.

### Extension layout

* `iso.js` — isolated world, `document_start`. Only talks to the local backend.
  Content-script fetches carry extension privileges, so localhost is not subject
  to pro.nfl.com's CSP.
* `panel.js` — main world, `document_idle`. Needs `window.$nuxt` (for NFL's
  authenticated axios) and NFL's React globals (to mount the player), neither of
  which an isolated world can see. Talks to `iso.js` via `postMessage`.

A note on why the panel does **not** drive NFL Pro's own film-room routing: the
film page commits `season`/`seasonType` from the URL but never commits `gameId`,
so `filmRoomKeys/selected` returns three keys, the filter component rewrites the
URL from that store, `gameId` is dropped, and the router falls back to the game
cards. Deep links carrying `gameId` therefore land on the grid, not the play.
The panel sidesteps this by calling the video API directly.

## Filtering

All **372** pbp columns are indexed and filterable — the same data
`nfl_data_py.import_pbp_data()` returns. Filters are `f=<column>:<op>[:<value>]`,
repeatable and ANDed; ops are `eq ne gt gte lt lte like notnull isnull`.

    # sacks that cost more than a point of EPA
    /api/search?f=sack:eq:1&f=epa:lt:-1

    # every play Cam Jordan made the solo tackle on
    /api/search?f=@solo_tackle_player_name:like:C.Jordan

    # fumbles lost, worst EPA first
    /api/search?f=fumble_lost:eq:1&order=epa_asc

So yes: tacklers, forced fumbles, EPA, CPOE, personnel groupings, win
probability, air yards, drive state — anything in the row.

### Merged columns

nflverse numbers the slots of a multi-participant stat — two forced-fumble
columns, four assist-tackle ones, two half-sacks — so filtering
`forced_fumble_player_1_player_name` quietly misses whoever landed in slot 2.
That is not a rounding error: 8,177 plays have a second assist tackler, 150 a
second QB hitter, 159 a split sack.

`/api/columns` therefore returns `{columns, groups}`, where each group is a
synthetic `@`-prefixed column standing in for every slot of one stat:

    # Will Anderson's sacks: 17, not the 14 in sack_player_name alone --
    # the other three were split sacks, which live in half_sack_1/2_player_name
    /api/search?f=@sack_player_name:eq:W.Anderson

OR is applied for `eq like gt gte lt lte notnull`. The negative operators are
not OR: `ne` means *no* slot matches (a NULL-safe AND, plus the stat having
happened at all) and `isnull` means every slot is empty. The raw slot columns
stay filterable by their real names.

`roles.py` derives the groups from the schema and `extension/db.js` mirrors it —
keep the two in step.

### The filter dictionary

Every filterable option carries nflverse's own definition. `build_dictionary.py`
bakes `dictionary_pbp.csv` and `dictionary_ftn_charting.csv` into
`extension/dictionary.json` (399 fields, 37 KB, committed, so the panel needs no
network) — between them they describe all 337 columns in the index, which is why
nothing here is a guess. Re-run it when nflverse adds fields:

    python3 build_dictionary.py

`build_dictionary.py` also rewrites the wording. nflverse writes for whoever is
reading the schema — 238 of the 337 entries open by restating the storage type
("Binary indicator for if the play ended in a sack") which the panel already
shows as a badge, and a few describe the implementation ("Play description
contains ran ob") or name a raw column ("Yards by the receiver_player_name").
The generator strips the type preamble, and a short override table in the same
file handles the dozen that do not clean up mechanically. A merged column
borrows the definition of the slot it leads with; that it spans several columns
is plumbing, so it goes on the badge as `2 cols`, not into the sentence.

The book icon in the panel header opens the dictionary: every option with its
definition and what the column actually holds in *your* index. Search matches
names, raw column keys and the definitions, so "scrambles" finds `pass`,
`passer`, `play_type` and `rusher`. Picking a row arms the filter box; clicking
a value drops it straight into the filter.

`/api/values` backs both that view and the hint line under the filter row. It
takes `col=` for one column or `cols=` for up to 40, and the profile it returns
is shaped by the column, because one shape does not fit:

    yes / no   Yes 507 · No 46,809
    list       guard 3,753 · end 3,554 · tackle 3,551        (<= 25 distinct)
    number     range -5.5 … 6.88 · avg 0.451 · 18,278 values
    text       J.Campbell 123 · A.Singleton 92 · 1,128 distinct in all

epa's five most common values are noise; pass_location's three are the entire
vocabulary. Profiles load only for the rows on screen — profiling all 275 up
front costs about four seconds of table scans.

### Redundant flags

nflverse ships a 0/1 flag beside several of these stats, and where the flag is
*exactly* "the merged column is set" it is a second name for one question —
`fumble_forced` next to `Forced fumble` reads as two options that do different
things. `/api/columns` returns those in `redundant` and the panel hides them.

The list is candidates only, each confirmed against the actual index, because
two look redundant and are not: `sack` is set on 9 plays that credit no player,
and `tackled_for_loss` disagrees with its own player columns on 1,463 plays.
Both stay. Confirmed redundant this season: `fumble_forced`, `qb_hit`,
`solo_tackle`, `assist_tackle`, `tackle_with_assist`, `fumble`.

### Yes / no columns

`/api/columns` also returns `binary`: the columns whose every non-null value is
0 or 1 *and* where both states actually occur — 93 of the 337. The panel drops
the operator menu and the value box for these and offers a Yes / No picker
instead, since `=` is the only sensible operator and there are only two values.

Requiring both states is deliberate. `play_clock` is a real number column that
happens to hold nothing but `0` this season; offering it as a yes/no would be a
lie about the data. Detection is one table scan at runtime, cached, so it
re-reads the truth on every index rebuild rather than trusting a hardcoded list.

### `like` contains

A `like` value with no `%` in it is wrapped as `%value%`, because LIKE without
wildcards is a case-insensitive equals: `like:Anderson` against a column holding
`W.Anderson` used to match nothing and read as "he never did this" rather than
as a mistake. A value that already carries a `%` is passed through untouched, so
`like:(Shotgun)%` still means starts-with.

## Note

`/api/secured/*` is private, undocumented, and can change without warning. Keep
usage to your own subscription and your own viewing; don't redistribute clips or
share the endpoints as a service. Automated bulk calling risks your account.
