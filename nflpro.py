"""
Mapping between nflverse play data and NFL Pro's film room.

Everything here was derived from NFL Pro's public JS bundle (pro.nfl.com/_nuxt/*.js).
No credentials, no scraping of video. We only build URLs; playback stays on nfl.com
in the user's own authenticated browser session.

Key facts established:
  * route "/film/plays" accepts its filters as plain query params -- the app does
    $router.replace({name:"film-plays", query: q}) with the SAME object it sends to
    the API, so the URL query string IS the API filter payload.
  * requestToMakeBasedOnQuery(): `if (q.gameId) return "plays"` -- a gameId in the
    URL skips the game-card grid and lands directly on the play list.
  * The film page never reads playId from the URL; it auto-selects plays[0].
    So a URL narrows to a short list. For a single exact clip use the video API:
        GET /api/secured/videos/coaches?gameId=<fapiGameId>&playId=<playId>
  * ID equivalences (verified against nflverse):
        NFL Pro gameId / fapiGameId  ==  nflverse old_game_id   (e.g. 2025090400)
        NFL Pro playId               ==  nflverse play_id       (sparse GSIS ints)
        NFL Pro nflId                ==  nflverse players.nfl_id (5-digit NGS id)
"""

FILM_BASE = "https://pro.nfl.com/film/plays"
COACHES_API = "https://pro.nfl.com/api/secured/videos/coaches"
SUMMARY_API = "https://pro.nfl.com/api/plays/summaryPlay"

# nflverse week number -> NFL Pro weekSlug
POST_SLUGS = {19: "WC", 20: "DIV", 21: "CONF", 22: "SB"}
PRE_SLUGS = {0: "HOF", 1: "P1", 2: "P2", 3: "P3", 4: "P4"}


def week_slug(season_type, week):
    """nflverse (season_type, week) -> NFL Pro weekSlug."""
    week = int(week)
    if season_type == "REG":
        return "WEEK_%d" % week
    if season_type == "POST":
        return POST_SLUGS.get(week)
    if season_type == "PRE":
        return PRE_SLUGS.get(week)
    return None


# The film room's own filter vocabulary, lifted from the bundle. Every one of these
# is a legal query param on /film/plays. Values: boolean filters take 1, singular
# filters take the enum token shown in the UI.
FILTER_KEYS = {
    "player": ["passerId", "rusherId", "targetId", "routeRunnerId", "defenderId", "nflId"],
    "team": ["possessionTeamId", "defenseTeamId", "teamId"],
    "situation": ["down", "quarter", "yardsToGoType", "goalToGo", "redzone", "scoring"],
    "playtype": ["playType", "passPlay", "runPlay", "dropback", "playAction"],
    "result": ["completion", "reception", "target", "attempt", "touchdown",
               "interception", "sack", "fumble", "fumbleLost"],
    "pressure": ["pressure", "blitz", "passRushSnap", "turnoversCausedByPressure"],
    "scheme": ["offensePersonnel", "personnel", "qbAlignment", "receiverAlignment",
               "teamCoverageTypeManZone", "teamCoverageTypeSafetyShell",
               "defendersInTheBoxType", "db", "dl", "lb", "rb", "te", "wr"],
    "route": ["routeType", "targetLocation", "airYardType", "separationType",
              "dropbackTimeType", "rushDirection", "maxSpeedType"],
    "defense": ["coverageSnap", "defensiveSnap", "runDefenseSnap", "runStuff",
                "tackles", "tackleStop", "hustleStop", "linedUpInTheBox", "ballCarrier",
                "carries", "receptionNearestDefender", "receivingTDNearestDefender",
                "targetNearestDefender"],
}

# nflverse play_type -> NFL Pro playType token
PLAY_TYPE_MAP = {"run": "play_type_rush", "pass": "play_type_pass"}


def film_url(season, season_type, week, old_game_id=None, nfl_id=None,
             role="nflId", extra=None):
    """Build a deep link into the NFL Pro film room.

    role picks which player slot to filter on: nflId (any), passerId, rusherId,
    targetId, routeRunnerId or defenderId. Narrower roles give shorter play lists.
    """
    from urllib.parse import urlencode

    slug = week_slug(season_type, week)
    q = {"season": str(season), "seasonType": season_type}
    if slug:
        q["weekSlug"] = slug
    if old_game_id:
        q["gameId"] = str(old_game_id)
    if nfl_id:
        q[role] = str(nfl_id)
    if extra:
        q.update({k: v for k, v in extra.items() if v not in (None, "")})
    return FILM_BASE + "?" + urlencode(q)


def clip_api_url(old_game_id, play_id):
    """The exact-clip endpoint. Returns Broadcast / Sideline / Endzone items,
    each with an mcpPlaybackId used by NFL's own player. Requires the caller's
    NFL Pro session (same-origin from pro.nfl.com, or Bearer token)."""
    from urllib.parse import urlencode

    return COACHES_API + "?" + urlencode({"gameId": old_game_id, "playId": play_id})
