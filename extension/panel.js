/* All-22 Film Search — runs in the page on pro.nfl.com (manifest world: "MAIN").
 *
 * Why it lives here rather than in a localhost page: NFL's clips are Widevine /
 * FairPlay DRM, played through THEOplayer under a domain-locked license. They can
 * only decrypt on nfl.com. So the search panel comes to the video, not the other
 * way round -- one tab, no popups, NFL's own player, your own subscription.
 *
 * Search itself is local: nflverse SQLite (337 columns) running in the
 * extension's offscreen document, reached through iso.js. The only requests
 * that go to NFL are the clip lookups for plays the user actually selects, and
 * one film-room query for a search that uses an NFL Pro filter -- see secured()
 * below. Nothing is downloaded, cached or re-hosted.
 */
(() => {
  if (window.__all22) return;
  window.__all22 = true;

  // Not a server. A fake origin so the paths below parse as URLs; iso.js maps
  // each path to an extension message. Nothing is ever fetched from it.
  const API = "http://all22.invalid";
  const ANGLES = ["Sideline", "Endzone"];     // All-22 coaches angles; Broadcast excluded
  // backend calls go through the isolated-world content script (CSP-immune)
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", ev => {
    const m = ev.data;
    if (ev.source !== window || !m) return;
    if (m.__all22 === "progress") {
      const st = document.getElementById("all22-st");
      if (!st) return;
      if (m.stage === "refreshed") {
        // the offscreen document swapped in a newer index; the dropdowns were
        // filled from the old one and may be missing this week
        loadMeta().then(() => { st.textContent = "play index updated — " + m.rows + " plays"; })
                  .catch(() => {});
        return;
      }
      if (st.dataset.loaded) return;
      st.textContent = {
        downloading: "downloading play index (" + Math.round((m.bytes || 0) / 1e6) + " MB)…",
        decompressing: "unpacking index…",
        opening: "opening database…",
      }[m.stage] || "loading…";
      return;
    }
    if (m.__all22 !== "res") return;
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m.reply); }
  });
  function backend(path, init) {
    return new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, reply => {
        if (!reply || reply.error) return rej(new Error(reply ? reply.error : "no reply"));
        if (!reply.ok) return rej(new Error("backend HTTP " + reply.status));
        res(reply.json);
      });
      window.postMessage({ __all22: "req", id, url: API + path, init }, "*");
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rej(new Error("index did not load — check the extension's service worker console")); }
      }, 120000);
    });
  }
  const post = (path, body) => backend(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const $ = (t, css, html) => {
    const e = document.createElement(t);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    return e;
  };
  // nflverse column names are snake_case with a lot of domain acronyms; render
  // them as a human would write them rather than making people read raw keys.
  const ACRONYMS = new Set(["epa","wpa","wp","cpoe","yac","td","qb","rb","wr","te","fg","xp",
    "id","nfl","pff","rpo","ypa","ol","dl","lb","db","cb","ko","pat","gsis","ngs","ftn","ep"]);
  /* Names the generic snake_case rule gets wrong or leaves as machine talk.
     nflverse names a column for the code that writes it, not for the person
     reading it -- "is_qb_fault_sack", "sp", "ydsnet", "xyac_fd". Anything a
     human would not say out loud gets spelled out here. */
  const COL_NAMES = {
    // core row
    desc: "Play description", posteam: "Offense", defteam: "Defense",
    old_game_id: "Game ID", play_id: "Play ID", ydstogo: "Yards to go",
    qtr: "Quarter", yardline_100: "Yards from end zone",
    yrdln: "Yard line", ydsnet: "Drive net yards",
    posteam_type: "Offense home/away",
    posteam_timeouts_remaining: "Offense timeouts left",
    defteam_timeouts_remaining: "Defense timeouts left",
    play_type_nfl: "Play type (NFL)", st_play_type: "Special teams play type",
    // both are game keys; only old_game_id is the numeric one the panel uses
    game_id: "Game key",

    // models: expected points, win probability, completion probability
    ep: "Expected points", epa: "EPA", qb_epa: "QB EPA",
    air_epa: "Air EPA", yac_epa: "YAC EPA",
    comp_air_epa: "Completed air EPA", comp_yac_epa: "Completed YAC EPA",
    wp: "Win probability", wpa: "Win probability added",
    def_wp: "Defense win probability",
    home_wp: "Home win probability", away_wp: "Away win probability",
    home_wp_post: "Home win probability (after)",
    away_wp_post: "Away win probability (after)",
    vegas_wp: "Vegas win probability", vegas_home_wp: "Vegas home win probability",
    cp: "Completion probability", cpoe: "CPOE",
    no_score_prob: "No score probability", opp_fg_prob: "Opponent FG probability",
    opp_safety_prob: "Opponent safety probability", opp_td_prob: "Opponent TD probability",
    extra_point_prob: "Extra point probability",
    two_point_conversion_prob: "Two-point conversion probability",
    xyac_epa: "xYAC EPA", xyac_mean_yardage: "xYAC mean yardage",
    xyac_median_yardage: "xYAC median yardage",
    xyac_success: "xYAC success probability",
    xyac_fd: "xYAC first-down probability",
    xpass: "Pass probability (xPass)", pass_oe: "Pass rate over expected",

    // spelled-out abbreviations
    sp: "Scoring play", div_game: "Divisional game",
    drive_inside20: "Drive reached inside 20",
    fixed_drive: "Drive number", fixed_drive_result: "Drive result",
    two_point_conv_result: "Two-point conversion result",
    defensive_two_point_attempt: "Defensive two-point attempt",
    defensive_two_point_conv: "Defensive two-point conversion",
    defensive_extra_point_conv: "Defensive extra point conversion",
    quarter_end: "Quarter ended",
    // success is exactly epa > 0; say so rather than leaving it to be guessed
    success: "Successful play (EPA > 0)",
    // nflverse's own convenience flag, not the same set as special_teams_play
    special: "Special teams flag",
    n_blitzers: "# Blitzers", n_pass_rushers: "# Pass rushers",
    n_defense_box: "# In the box", n_offense_backfield: "# In the backfield",
    name: "Primary player", id: "Primary player ID",

    // 0/1 event flags whose plain name is now taken by the merged player
    // column: "Sack = W.Anderson" is a person, "Sack occurred: Yes" is a fact
    sack: "Sack occurred", qb_hit: "QB hit occurred",
    solo_tackle: "Solo tackle occurred", assist_tackle: "Assist tackle occurred",
    tackle_with_assist: "Tackle with assist occurred",

    /* FTN charting. Every one of these is a yes/no, so the "is_" prefix the
       schema carries is noise the value already says: "Play action: Yes".
       Labels match the Did menu's sub-filters so the same thing is called the
       same thing in both places. */
    is_play_action: "Play action", is_rpo: "RPO", is_screen_pass: "Screen pass",
    is_motion: "Pre-snap motion", is_trick_play: "Trick play",
    is_no_huddle: "No huddle (FTN)", is_qb_sneak: "QB sneak",
    is_qb_out_of_pocket: "QB out of pocket", is_throw_away: "Throwaway",
    is_interception_worthy: "Interception-worthy",
    is_catchable_ball: "Catchable ball", is_contested_ball: "Contested ball",
    is_created_reception: "Created reception", is_drop: "Drop",
    is_qb_fault_sack: "Sack was QB's fault",
    read_thrown: "Read thrown to", qb_location: "QB alignment",

    /* Participation (nflverse, published after each season). Two of these
       overlap FTN's counts, so the source is named where it would clash. */
    offense_formation: "Formation", offense_personnel: "Offensive personnel",
    defense_personnel: "Defensive personnel",
    defenders_in_box: "# In the box (participation)",
    number_of_pass_rushers: "# Pass rushers (participation)",
    n_offense: "# Offensive players", n_defense: "# Defensive players",
    time_to_throw: "Time to throw (s)", was_pressure: "QB pressured",
    route: "Primary receiver route", defense_man_zone_type: "Man / zone",
    defense_coverage_type: "Coverage shell",
  };
  /* Merged columns, published by the backend: one "Forced fumble" instead of
     the two numbered slots nflverse actually stores. GROUPS is keyed by the
     synthetic "@..." column, MEMBER maps each real slot back to its group so a
     raw key typed in full still reads as a name rather than a schema dump. */
  let GROUPS = {}, MEMBER = {};
  function humanCol(c) {
    if (!c) return "";
    if (GROUPS[c]) return GROUPS[c].label;
    if (MEMBER[c] && MEMBER[c].slot) return `${MEMBER[c].label} (slot ${MEMBER[c].slot})`;
    if (COL_NAMES[c]) return COL_NAMES[c];
    const parts = String(c).split("_");
    if (parts[0] === "n" && parts.length > 1) parts[0] = "#";
    return parts.map((w, i) => {
      if (!w) return w;
      if (w === "#") return w;
      if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : w;
    }).join(" ");
  }
  const OPSYM = { eq: "=", ne: "\u2260", gt: ">", gte: "\u2265", lt: "<", lte: "\u2264",
                  like: "contains", notnull: "is set", isnull: "is empty" };

  const esc = s => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const nuxt = () => window.$nuxt;

  /* ---------------- NFL Pro API (via the app's authed axios) ---------------- */

  /* Every request to /api/secured/* goes through here, and this is the whole
     of the extension's NFL traffic: one UUID lookup per game never seen on this
     machine, one clip lookup per play the user selects, one film-room query
     per search that uses an NFL Pro filter (cached), one summaryPlay per play
     while the On field list is showing (cached). There is deliberately
     no prefetching and no bulk enumeration anywhere -- a user with this panel
     open generates less load than the same user clicking around the film room.

     What this gate adds:
       - one request in flight at a time, at least GAP ms apart. Holding "n"
         auto-repeats at ~30 Hz; without this each repeat was a request.
       - a rolling ceiling. Not a quota for people -- CEILING per hour is one
         request every nine seconds for an hour, and a clip plus its second
         angle takes twenty or thirty seconds to actually watch. It is a
         backstop against a runaway loop, ours or a future one.
       - no retries. A 401/403 means NFL Pro has stopped serving the endpoint
         (or the session ended); we stop for the rest of the page and say so.
         A 429 pauses for COOLDOWN. Nothing here ever re-issues a request on
         its own; the next attempt is always the next thing the user clicks. */
  const GAP = 1000, CEILING = 400, WINDOW = 3600e3, COOLDOWN = 5 * 60e3;
  let chain = Promise.resolve(), lastAt = 0, stamps = [], apiDown = null, pausedUntil = 0;
  const httpStatus = e => e && (e.statusCode || e.status ||
                                (e.response && e.response.status)) || 0;
  class ApiError extends Error {
    constructor(msg, status) { super(msg); this.status = status; this.api = true; }
  }
  function apiGate() {
    if (apiDown) {
      throw new ApiError("NFL Pro is no longer serving this endpoint (HTTP " + apiDown +
        "). It may have changed or your session may have ended -- reload the page to try again.", apiDown);
    }
    const now = Date.now();
    if (now < pausedUntil) {
      throw new ApiError("NFL Pro asked us to slow down (HTTP 429). Paused for " +
        Math.ceil((pausedUntil - now) / 60e3) + " min.", 429);
    }
    stamps = stamps.filter(t => now - t < WINDOW);
    if (stamps.length >= CEILING) {
      const wait = Math.ceil((WINDOW - (now - stamps[0])) / 60e3);
      throw new ApiError("Clip limit reached (" + CEILING + " per hour). Try again in " +
        wait + " min.", 0);
    }
  }
  function secured(path, params) {
    const run = async () => {
      apiGate();
      const wait = lastAt + GAP - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      apiGate();                              // state may have changed while waiting
      lastAt = Date.now();
      stamps.push(lastAt);
      try {
        return await nuxt().$api.$get(path, { params });
      } catch (e) {
        const s = httpStatus(e);
        if (s === 401 || s === 403) apiDown = s;
        else if (s === 429) pausedUntil = Date.now() + COOLDOWN;
        if (s) {
          apiGate();                          // throws the dead / paused message
          throw new ApiError("NFL Pro returned HTTP " + s + ".", s);
        }
        throw e;
      }
    };
    // serialise: each call waits for the previous one, success or failure
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  // nflverse old_game_id (2025090705) -> NFL Pro fapiGameId (UUID).
  // The coaches endpoint only accepts the UUID: pass the numeric id and it
  // returns 200 with zero items.
  const uuidCache = new Map();
  async function gameUuid(row) {
    const key = String(row.old_game_id);
    if (uuidCache.has(key)) return uuidCache.get(key);
    try {
      const c = await backend(`/api/game_uuid?old_game_id=${key}`);
      if (c && c.fapi_game_id) { uuidCache.set(key, c.fapi_game_id); return c.fapi_game_id; }
    } catch {}
    const d = await secured("/api/secured/videos/filmroom/plays",
      { season: row.season, seasonType: row.season_type, weekSlug: row.week_slug, gameId: key });
    const uuid = d.plays && d.plays.length ? d.plays[0].fapiGameId : null;
    if (uuid) {
      uuidCache.set(key, uuid);
      post("/api/game_uuid", { old_game_id: key, fapi_game_id: uuid }).catch(() => {});
    }
    return uuid;
  }

  async function clipFor(row) {
    const uuid = await gameUuid(row);
    if (!uuid) throw new Error("no NFL Pro game for " + row.old_game_id);
    const d = await secured("/api/secured/videos/coaches", { gameId: uuid, playId: row.play_id });
    const items = d.items || [];
    const list = ANGLES.map(a => items.find(i => i.cameraSource === a)).filter(Boolean);
    if (!list.length) throw new Error("no Sideline/Endzone clip for this play");
    return list.map(t => ({
      videoView: t.cameraSource.toLowerCase(), title: t.description, id: t.id,
      mcpID: t.mcpPlaybackId,
      posterImage: t.thumbnail && t.thumbnail.thumbnailUrl,
      imageSrc: t.thumbnail && t.thumbnail.thumbnailUrl,
    }));
  }

  /* ---------------- NFL Pro film-room queries ----------------
     NFL Pro's own film room filters plays by data nflverse does not carry
     in season: who was on the field, routes run, pass-rush and coverage snaps,
     nearest defender, separation, speed. One request answers a whole search
     -- the same request the film room makes when you change a filter there --
     and comes back as a list of game/play ids, which the local index then
     narrows further with every other filter. Cached, so re-running a search
     or re-sorting it costs nothing. Probed 2026-10-27: a full league season
     (7,625 pass plays, ~4 MB) arrives in one response, no paging. */
  const NFL_TTL = 10 * 60e3;          // a live week's answer can still change
  const NFL_CACHE_MAX = 24;
  const nflCache = new Map();         // query string -> result
  const nflKey = (g, pl) => `${g}/${pl}`;

  // season + week as NFL Pro names them; no week means the regular season
  function nflWhen(season, week) {
    const out = { season: Number(season), seasonType: "REG" };
    const w = Number(week);
    if (week !== "" && week != null && !isNaN(w)) {
      const post = { 19: "WC", 20: "DIV", 21: "CONF", 22: "SB" }[w];
      if (post) { out.seasonType = "POST"; out.weekSlug = post; }
      else out.weekSlug = "WEEK_" + w;
    }
    return out;
  }

  async function nflPlays(params) {
    const qs = new URLSearchParams(Object.entries(params)
      .filter(([, v]) => v !== "" && v != null).sort()).toString();
    const hit = nflCache.get(qs);
    if (hit && (hit.settled || Date.now() - hit.at < NFL_TTL)) {
      nflCache.delete(qs); nflCache.set(qs, hit);      // most recent last
      return Object.assign({ cached: true }, hit);
    }
    const d = await secured("/api/secured/videos/filmroom/plays", Object.fromEntries(new URLSearchParams(qs)));
    // NFL Pro's own "too many plays" answer: a code, or a count with no plays
    if (!d || d.code || (d.count > 0 && !(d.plays || []).length))
      throw new ApiError("NFL Pro says that search covers too many plays. Narrow it with a week, a team or a player.", 0);
    const plays = new Map();
    const uuids = {};
    for (const pl of d.plays || []) {
      const g = String(pl.gameId);
      plays.set(nflKey(g, pl.playId), pl);
      // every row names its game's UUID: remember it, and the clip lookup
      // for any of these plays skips the request that would have found it
      if (pl.fapiGameId && !uuidCache.has(g)) { uuidCache.set(g, pl.fapiGameId); uuids[g] = pl.fapiGameId; }
    }
    if (Object.keys(uuids).length) post("/api/game_uuid", { many: uuids }).catch(() => {});
    const res = { at: Date.now(), count: plays.size, keys: [...plays.keys()], plays,
                  // a finished season's answer will not change
                  settled: params.season < new Date().getFullYear() - (new Date().getMonth() < 2 ? 1 : 0) };
    nflCache.set(qs, res);
    while (nflCache.size > NFL_CACHE_MAX) nflCache.delete(nflCache.keys().next().value);
    return res;
  }

  /* A play NFL Pro has and the local index does not yet (nflverse lands a few
     hours behind), drawn from NFL's own fields in the shape a search row has.
     It plays like any other: clipFor needs only the ids and the game UUID. */
  function nflRow(pl) {
    const home = pl.homeTeamAbbr, away = pl.visitorTeamAbbr;
    const pos = pl.possessionTeamId === pl.homeTeamId ? home
              : pl.possessionTeamId === pl.visitorTeamId ? away : null;
    return {
      old_game_id: String(pl.gameId), play_id: pl.playId, season: pl.season,
      season_type: pl.seasonType, week: pl.week, week_slug: pl.weekSlug,
      home_team: home, away_team: away, posteam: pos,
      defteam: pos ? (pos === home ? away : home) : null,
      qtr: pl.quarter, time: pl.gameClock, down: pl.down || null,
      ydstogo: pl.down ? pl.yardsToGo : null, desc: pl.playDescription || "",
      play_type: null, epa: null, nflOnly: true,
    };
  }

  /* NFL Pro filters offered in "Any filter", curated from the film room's own
     definitions (its public bundle, read 2026-10-27). Only what nflverse and
     FTN do not already give during the season: plain play facts (down, sack,
     play action, box count...) stay with the index, and NFL's own player and
     team pickers give way to ours. `who` is the NFL key the picked player
     fills; `needs` marks a filter that means nothing without a player. */
  const YN = [["1", "Yes"], ["0", "No"]], YES = [["1", "Yes"]];
  const n_ = k => [...Array(k + 1).keys()].map(i => [String(i), String(i)]);
  const NFLF = [
    { key: "dropbackTimeType", label: "Time to throw", group: "Passing", who: "passerId",
      values: [["QUICK", "Quick (under 2.5 s)"], ["LONG", "Long (2.5 s or more)"]] },
    { key: "pressure", label: "Pressured", group: "Passing", values: YN },
    { key: "routeType", label: "Route type", group: "Receiving", who: "routeRunnerId",
      values: [["IN", "In-breaking"], ["OUT", "Out-breaking"], ["VERTICAL", "Vertical"],
               ["RB_SCREEN", "RB screen"], ["WR_SCREEN", "WR screen"]] },
    { key: "receiverAlignment", label: "Receiver alignment", group: "Receiving", who: "routeRunnerId",
      values: [["WIDE", "Wide"], ["SLOT", "Slot"], ["TIGHT", "Tight"], ["BACKFIELD", "Backfield"]] },
    { key: "rec_coverageType", label: "Coverage faced: press or off", group: "Receiving", who: "routeRunnerId",
      values: [["PRESS", "Press"], ["OFF", "Off"]] },
    { key: "rec_motion", label: "Receiver in motion", group: "Receiving", who: "routeRunnerId", values: YN },
    { key: "separationType", label: "Separation at the target", group: "Receiving", who: "targetId",
      values: [["TIGHT", "Tight window (under 1 yd)"], ["OPEN", "Open (3+ yds)"]] },
    { key: "targetLocation", label: "Target location", group: "Receiving", who: "targetId",
      values: [["OUTSIDE_NUMBERS", "Outside the numbers"], ["DOWN_SEAMS", "Down the seams"],
               ["BETWEEN_HASHES", "Between the hashes"]] },
    { key: "maxSpeedType", label: "Max speed", group: "Ball carrier", who: "nflId", needs: true,
      values: [["LESS_THAN_15", "Under 15 mph"], ["OVER_15", "Over 15 mph"], ["OVER_20", "Over 20 mph"]] },
    { key: "teamCoverageTypeManZone", label: "Man vs zone", group: "Coverage",
      values: [["MAN_COVERAGE", "Man"], ["ZONE_COVERAGE", "Zone"]] },
    { key: "teamCoverageTypeSafetyShell", label: "Safety shell", group: "Coverage",
      values: [["SINGLE_HIGH", "Single high"], ["SPLIT_SAFETY", "Split safety"], ["COVER_0", "Cover 0"]] },
    { key: "personnel", label: "Defensive personnel", group: "Personnel",
      values: [["BASE", "Base"], ["NICKEL", "Nickel"], ["DIME", "Dime"]] },
    { key: "offensePersonnel", label: "Offensive personnel", group: "Personnel",
      values: [["11_PERSONNEL", "11"], ["12_PERSONNEL", "12"], ["13_PERSONNEL", "13"],
               ["21_PERSONNEL", "21"], ["JUMBO_PERSONNEL", "Jumbo"]] },
    { key: "rb", label: "Running backs on the field", group: "Personnel", values: n_(3) },
    { key: "te", label: "Tight ends on the field", group: "Personnel", values: n_(3) },
    { key: "wr", label: "Wide receivers on the field", group: "Personnel", values: n_(5) },
    { key: "runStuff", label: "Run stuffed", group: "Run defense", values: YN },
    { key: "passRushSnap", label: "Pass-rush snap", group: "Defender", who: "defenderId", needs: true, values: YN },
    { key: "coverageSnap", label: "Coverage snap", group: "Defender", who: "defenderId", needs: true, values: YN },
    { key: "runDefenseSnap", label: "Run-defense snap", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "defensiveSnap", label: "Defensive snap", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "linedUpInTheBox", label: "Lined up in the box", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "def_alignment", label: "Defender alignment", group: "Defender", who: "defenderId", needs: true,
      values: [["PLAYER_ALIGNMENT_EDGE", "Edge"], ["PLAYER_ALIGNMENT_DT", "DT"], ["PLAYER_ALIGNMENT_LB", "LB"],
               ["PLAYER_ALIGNMENT_SLOT", "Slot"], ["PLAYER_ALIGNMENT_CB", "CB"],
               ["PLAYER_ALIGNMENT_SS", "SS"], ["PLAYER_ALIGNMENT_FS", "FS"]] },
    { key: "def_coverageType", label: "Defender in press or off", group: "Defender", who: "defenderId", needs: true,
      values: [["PRESS", "Press"], ["OFF", "Off"]] },
    { key: "def_pressure", label: "Pressure by the defender", group: "Defender", who: "defenderId", needs: true, values: YN },
    { key: "def_runStuff", label: "Run stuff by the defender", group: "Defender", who: "defenderId", needs: true, values: YN },
    { key: "tackleStop", label: "Tackle for a stop", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "hustleStop", label: "Hustle stop", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "turnoversCausedByPressure", label: "Turnover caused by pressure", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "targetNearestDefender", label: "Nearest defender on the target", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "receptionNearestDefender", label: "Nearest defender on a catch", group: "Defender", who: "defenderId", needs: true, values: YES },
    { key: "receivingTDNearestDefender", label: "Nearest defender on a TD catch", group: "Defender", who: "defenderId", needs: true, values: YES },
  ];
  const NFLF_BY = Object.fromEntries(NFLF.map(d => [d.key, d]));
  // "Any filter" keys NFL Pro filters as "nfl:<key>" so they never collide with a column
  const nflDef = k => (k && k.startsWith("nfl:") ? NFLF_BY[k.slice(4)] || null : null);
  const nflValLabel = (d, v) => ((d.values.find(x => x[0] === String(v)) || [, v])[1]);

  /* What a picked player can ask NFL Pro, offered in the Action menu. Each is
     one film-room query scoped to him; none of them narrows the index by the
     nflverse participation columns, which never record a snap he only lined
     up for. */
  const DEF_POS = /^(DE|DT|NT|DL|LB|ILB|OLB|MLB|EDGE|CB|S|SS|FS|SAF|DB)$/;
  const NFL_ACTIONS = [
    { key: "nfl:field", label: "On field", who: "nflId" },
    { key: "nfl:routes", label: "Routes run", who: "routeRunnerId", side: "off", pos: /^(WR|TE|RB|FB)$/ },
    { key: "nfl:rush", label: "Pass-rush snaps", who: "defenderId", side: "def", set: { passRushSnap: 1 } },
    { key: "nfl:cover", label: "Coverage snaps", who: "defenderId", side: "def", set: { coverageSnap: 1 } },
    { key: "nfl:rundef", label: "Run-defense snaps", who: "defenderId", side: "def", set: { runDefenseSnap: 1 } },
    { key: "nfl:nearest", label: "Targets as nearest defender", who: "defenderId", side: "def", set: { targetNearestDefender: 1 } },
  ];
  const NFL_ACTION_BY = Object.fromEntries(NFL_ACTIONS.map(a => [a.key, a]));

  /* ---------------- player ---------------- */
  let root = null, curList = [], curIdx = 0, syncTimer = null, vpCache = null;
  /* Playback rate is sticky across clips: film study is a rate you settle on,
     not one you re-pick every play. It rides on the raw <video> element, which
     NFL's player recreates per clip and resets during the load, so it is
     re-asserted on that load's own events (see enforceRate) rather than on a
     timer -- polling would fight the player's own rate menu the moment you
     used it. */
  const RATES = [0.5, 1, 1.5, 2];
  let rate = 1, ratedEl = null, autoNext = false, menuOpen = false;

  // Find NFL's player instance by walking the React fiber off the mounted node.
  // Breadth-first: the instance is not on the first-child chain, and a passed
  // ref is not reliable here.
  function livePlayer() {
    if (vpCache && vpCache.state && document.contains(vpCache._a22box)) return vpCache;
    const box = document.querySelector("#all22-video .a22box");
    if (!box) return null;
    let fiber = null;
    for (const k in box) if (k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")) { fiber = box[k]; break; }
    const q = [fiber];
    let n = 0;
    while (q.length && n < 4000) {
      const f = q.shift(); n++;
      if (!f) continue;
      const si = f.stateNode;
      const cand = si && si.videoPlayer && si.videoPlayer.props ? si.videoPlayer
                 : (si && si.props && Array.isArray(si.props.playlist) && typeof si.loadVideoFromProps === "function" ? si : null);
      if (cand) { cand._a22box = box; vpCache = cand; return cand; }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }
    return null;
  }

  function drawAngles() {
    const bar = document.getElementById("all22-ang");
    if (!curList.length) { bar.innerHTML = ""; return; }
    /* The angles sit left. Opposite them: step-through as two bare chevrons,
       because moving between plays is the thing you do most and it should cost
       one glance; everything you set once and leave alone -- speed, whether a
       clip rolls into the next -- goes behind the gear rather than crowding
       the bar with five buttons. */
    const prev = selIdx > 0;
    const more = selIdx >= 0 && selIdx + 1 < lastRows.length;
    bar.innerHTML = curList.map((c, i) =>
      `<button class="${i === curIdx ? "on" : ""}" data-i="${i}">${esc(c.videoView)}</button>`).join("") +
      '<span class="pgrp">' +
        (p.classList.contains("wide") ? "" :
          `<button class="ofb${onOpen ? " on" : ""}" data-of="1" title="Who was on the field"` +
          ` aria-expanded="${onOpen}">On field</button>`) +
        `<button class="ico" data-prev="1"${prev ? "" : " disabled"}` +
        ` title="Previous play (p)" aria-label="Previous play">\u2039</button>` +
        `<button class="ico" data-next="1"${more ? "" : " disabled"}` +
        ` title="Next play (n)" aria-label="Next play">\u203a</button>` +
        `<button class="ico gear${autoNext ? " act" : ""}" data-gear="1"` +
        ` title="Playback settings" aria-label="Playback settings"` +
        ` aria-expanded="${menuOpen}">\u2699\ufe0e</button>` +
        `<div id="all22-pop"${menuOpen ? "" : " hidden"}>
           <div class="prow col"><span class="plab">Speed</span><span class="seg">` +
             RATES.map(r => `<button class="${r === rate ? "on" : ""}" data-r="${r}">${r}\u00d7</button>`).join("") +
           `</span></div>
           <div class="prow"><span class="plab">Auto-play next</span>
             <button class="tg${autoNext ? " on" : ""}" data-auto="1">${autoNext ? "On" : "Off"}</button>
           </div>
           <div class="pnote">Plays both angles, then loads the next play.</div>
         </div>` +
      '</span>' +
      '<span class="khint" title="Keyboard shortcuts">? Keys · \u2190 \u2192 Frame step</span>';
    bar.querySelectorAll("button[data-i]").forEach(b =>
      b.onclick = () => setAngle(+b.dataset.i));
    bar.querySelectorAll("button[data-r]").forEach(b =>
      b.onclick = () => setRateAbs(+b.dataset.r));
    const auto = bar.querySelector("button[data-auto]");
    if (auto) auto.onclick = () => setAutoNext(!autoNext);
    const nx = bar.querySelector("button[data-next]");
    if (nx) nx.onclick = () => nextPlay();
    const pv = bar.querySelector("button[data-prev]");
    if (pv) pv.onclick = () => prevPlay();
    const gear = bar.querySelector("button[data-gear]");
    if (gear) gear.onclick = e => { e.stopPropagation(); setMenu(!menuOpen); };
    const kh = bar.querySelector(".khint");
    if (kh) kh.onclick = () => toggleHelp();
    const of = bar.querySelector("button[data-of]");
    if (of) of.onclick = e => { e.stopPropagation(); setOnField(!onOpen); };
  }

  /* The bar is redrawn whenever the angle, rate or toggle changes, which would
     otherwise slam the menu shut under the click that just opened it. */
  function setMenu(on) {
    menuOpen = !!on;
    const pop = document.getElementById("all22-pop");
    const gear = document.querySelector("#all22-ang .gear");
    if (pop) pop.hidden = !menuOpen;
    if (gear) gear.setAttribute("aria-expanded", String(menuOpen));
  }

  function nextPlay() {
    if (selIdx + 1 < lastRows.length) selectPlay(selIdx + 1);
  }

  function prevPlay() {
    if (selIdx > 0) selectPlay(selIdx - 1);
  }

  function setAutoNext(on) {
    autoNext = !!on;
    drawAngles();
    flash(autoNext ? "auto-play next: on" : "auto-play next: off");
    post("/api/prefs", { autoNext }).catch(() => {});
  }

  /* Setting the rate once on a fresh <video> does not hold: NFL's player puts
     it back to 1 while the clip loads, which is after any rate we set on the
     bare element. So re-assert it on the events a load actually fires.
     Deliberately NOT on a timer -- mid-clip, a rate the viewer picked from the
     player's own control should stand until the next clip. */
  function enforceRate() {
    const v = vid();
    if (!v) return;
    ratedEl = v;
    if (Math.abs(v.playbackRate - rate) > 0.001) {
      try { v.playbackRate = rate; } catch {}
    }
  }

  function setAngle(i) {
    if (!curList[i]) return;
    const vp = livePlayer();
    if (vp && vp.props && typeof vp.loadVideoFromProps === "function") {
      try {
        vp.props.currentVideoIndex = i;   // playlist is in canonical order, so no offset
        vp.loadVideoFromProps();
        curIdx = i; drawAngles();
        return;
      } catch {}
    }
    render(curList);                       // fallback: remount, then switch
    curIdx = i; drawAngles();
    setTimeout(() => { const v = livePlayer(); if (v && i) { try { v.props.currentVideoIndex = i; v.loadVideoFromProps(); } catch {} } }, 700);
  }

  // The live angle lives in state.currentVideo.videoView. props.currentVideoIndex
  // is only the initial value and never updates, so it cannot be used here.
  /* NFL's player records its container width when it mounts and pins a pixel
     max-width on its wrappers. Widening the panel therefore leaves the video at
     its original size, and a window resize event alone does NOT dislodge it
     (measured: box 1395 / video 639 before and after). Rewriting those pinned
     max-widths to the current box, then firing resize, does. */
  function relayoutVideo() {
    const box = document.querySelector("#all22-video .a22box");
    const el = document.querySelector("#all22-video video");
    // only touch a player that has finished mounting -- poking its DOM mid-init
    // leaves it spinning forever
    if (!box || !el) return;
    const w = Math.round(box.getBoundingClientRect().width);
    if (!w) return;
    let touched = 0;
    box.querySelectorAll("*").forEach(el => {
      const m = getComputedStyle(el).maxWidth;
      // only the stale pins that are now too small; leave everything else alone
      if (m && m !== "none" && m.endsWith("px") && parseFloat(m) < w - 1) {
        el.style.maxWidth = w + "px";
        touched++;
      }
    });
    if (touched) window.dispatchEvent(new Event("resize"));
  }

  // one pass, once the resize has settled -- repeated passes during init
  // are what broke playback
  let relayoutTimer = null;
  function relayoutSoon(attempt) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      const ready = !!document.querySelector("#all22-video video");
      if (ready) return relayoutVideo();
      // resized while the clip was still loading: wait for it, but only twice
      if ((attempt || 0) < 2) relayoutSoon((attempt || 0) + 1);
    }, 260 + (attempt || 0) * 900);
  }

  // A width change resizes the player's container; THEOplayer stops on that.
  // The element is never remounted, so just restore the previous state.
  function preservePlayback(fn) {
    let wasPlaying = false;
    const v = document.querySelector("#all22-video video");
    try { wasPlaying = !!(v && !v.paused && !v.ended); } catch {}
    fn();
    if (!wasPlaying) return;
    let tries = 0;
    const tick = setInterval(() => {
      const el = document.querySelector("#all22-video video");
      if (!el || ++tries > 12) return clearInterval(tick);
      if (el.paused && !el.ended) {
        const vp = livePlayer();
        try {
          if (vp && typeof vp.resume === "function") vp.resume();
          else el.play();
        } catch {}
      } else {
        clearInterval(tick);
      }
    }, 120);
  }

  function currentAngleIndex() {
    const vp = livePlayer();
    const view = vp && vp.state && vp.state.currentVideo && vp.state.currentVideo.videoView;
    if (!view) return null;
    const k = curList.findIndex(c => c.videoView === String(view).toLowerCase());
    return k === -1 ? null : k;
  }

  function startSync() {
    clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      const host = document.getElementById("all22-video");
      if (!host || !host.firstChild) { clearInterval(syncTimer); return; }
      const i = currentAngleIndex();
      if (i != null && i !== curIdx) { curIdx = i; drawAngles(); }
    }, 400);
  }

  function render(playlist) {
    const host = document.getElementById("all22-video");
    host.innerHTML = "";
    vpCache = null;
    const box = $("div");
    box.className = "a22box";
    host.appendChild(box);
    const U = window.NflRnUmdComponents;
    if (!U || !U.Video || !window.React || !window.ReactDOM) {
      host.innerHTML = '<div style="padding:18px;color:#e0a86b">NFL player not loaded on this page — open the Film Room once, then retry.</div>';
      return;
    }
    root = window.ReactDOM.createRoot(box);
    root.render(window.React.createElement(U.Video.Video, {
      playlist, currentVideoIndex: 0,
      autoplay: true, autoDocking: false, enableTheoPlayer: true,
      enablePlaybackRateControls: true, loop: false, defaultMuted: false,
      startWithControlsVisible: true, withoutBgLayer: true,
      staging: false, env: "PROD", analytics: {},
    }));
    startSync();
  }

  function mount(playlist) {
    fps = 30;
    bare = false;
    setTimeout(() => measureFps(vid()), 600);
    curList = playlist;
    curIdx = 0;
    drawAngles();
    render(playlist);
  }

  /* ---------------- keyboard ----------------
   * Built on the raw <video> element rather than NFL's player, because the one
   * thing film study needs -- stepping a single frame -- has no API there.
   * Seeking to currentTime ± 1/fps lands on the adjacent frame.
   */
  const vid = () => document.querySelector("#all22-video video");
  let fps = 30;                       // refined per clip by measurement below

  // Derive the real frame rate from presentation timestamps instead of assuming
  // 30: coaches film is not always 30, and a wrong step drifts or double-steps.
  function measureFps(v) {
    if (!v || typeof v.requestVideoFrameCallback !== "function") return;
    const deltas = [];
    let last = null;
    const cb = (_now, meta) => {
      if (last != null) {
        const d = meta.mediaTime - last;
        if (d > 0.004 && d < 0.2) deltas.push(d);
      }
      last = meta.mediaTime;
      if (deltas.length < 10) { try { v.requestVideoFrameCallback(cb); } catch {} return; }
      deltas.sort((a, b) => a - b);
      const med = deltas[deltas.length >> 1];
      if (med > 0) fps = Math.min(120, Math.max(10, Math.round(1 / med)));
    };
    try { v.requestVideoFrameCallback(cb); } catch {}
  }

  let bare = false;
  function setBare(on) {
    const box = document.querySelector("#all22-video .a22box");
    if (!box) return;
    bare = !!on;
    box.classList.toggle("bare", bare);
    if (!bare) { const t = document.getElementById("a-tc"); if (t) t.remove(); }
    else timecode();
  }

  // In bare mode the controls are gone, so show a small frame/time readout in a
  // corner instead -- enough to know where you are without covering the play.
  function timecode() {
    const v = vid();
    if (!v || !bare) return;
    let el = document.getElementById("a-tc");
    if (!el) {
      el = $("div");
      el.id = "a-tc";
      el.setAttribute("data-a22", "");
      (document.querySelector("#all22-video .a22box") || p).appendChild(el);
    }
    const t = v.currentTime;
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(Math.floor(t % 60)).padStart(2, "0");
    const ff = String(Math.floor((t % 1) * fps)).padStart(2, "0");
    el.textContent = `${mm}:${ss}.${ff}  ·  ${fps}fps`;
  }

  function stepFrames(n) {
    const v = vid();
    if (!v) return;
    v.pause();
    const d = isFinite(v.duration) ? v.duration : 1e9;
    v.currentTime = Math.max(0, Math.min(d - 1e-4, v.currentTime + n / fps));
    setBare(true);            // stepping means studying: get the chrome out of the way
    setTimeout(timecode, 30);
  }

  function seekBy(sec) {
    const v = vid();
    if (!v) return;
    const d = isFinite(v.duration) ? v.duration : 1e9;
    v.currentTime = Math.max(0, Math.min(d - 1e-4, v.currentTime + sec));
    flash((sec > 0 ? "+" : "") + sec + "s");
  }

  function setRateAbs(r) {
    rate = Math.min(4, Math.max(0.1, +(+r).toFixed(2)));
    const v = vid();
    if (v) { try { v.playbackRate = rate; } catch {} ratedEl = v; }
    flash(rate + "×");
    drawAngles();
    post("/api/prefs", { rate }).catch(() => {});
  }

  // [ and ] nudge from wherever the rate is now, so the keys and the buttons
  // are two views of one value
  function setRate(mult) { setRateAbs(rate * mult); }

  let flashTimer = null;
  function flash(txt) {
    let el = document.getElementById("a-flash");
    if (!el) {
      el = $("div");
      el.id = "a-flash";
      el.setAttribute("data-a22", "");
      (document.getElementById("all22-video") || p).appendChild(el);
    }
    el.textContent = txt;
    el.style.opacity = "1";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.style.opacity = "0"; }, 700);
  }

  const HELP = [
    ["Space / K", "Play · pause"],
    ["← →", "Step one frame"],
    ["Shift ← →", "Step 10 frames"],
    ["J / L", "Back / forward 1s"],
    ["Shift J / L", "Back / forward 5s"],
    ["0 / Home", "Restart clip"],
    ["1 / 2", "Sideline / endzone"],
    ["N / P", "Next / previous play"],
    ["S", "Save to last cutup"],
    ["E", "Note on this play"],
    ["[ ]", "Slower / faster"],
    ["H", "Hide / show controls"],
    ["M", "Mute"],
    ["F", "Fullscreen"],
    ["?", "Toggle this help"],
  ];

  function toggleHelp(force) {
    let el = document.getElementById("a-help");
    if (el && force !== true) { el.remove(); return; }
    if (el) return;
    el = $("div");
    el.id = "a-help";
    el.setAttribute("data-a22", "");
    el.innerHTML = "<b>Keyboard</b>" + HELP.map(([k, v]) =>
      `<div><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join("");
    el.onclick = () => el.remove();
    (document.getElementById("all22-video") || p).appendChild(el);
  }

  function keyHandler(e) {
    if (p.classList.contains("hid")) return;
    if (e.key === "Escape" && menuOpen) {
      setMenu(false);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && onOpen) {
      setOnField(false);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && saveOpen) {
      setSaveMenu(false);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && !document.getElementById("a-dict").hidden) {
      if (selFor) return;           // an open menu closes first, by its own handler
      // one step back at a time: the open filter editor, then the dictionary
      if (dictEd) dictToggle(dictEd.k); else showDict(false);
      e.preventDefault();
      return;
    }
    const t = e.target;
    // never steal keys from the filter inputs
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = vid();
    const k = e.key;
    let handled = true;

    switch (k) {
      case " ": case "k":
        if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); }
        setBare(false);
        break;
      case "h": setBare(!bare); break;
      case "ArrowLeft":  stepFrames(e.shiftKey ? -10 : -1); break;
      case "ArrowRight": stepFrames(e.shiftKey ? 10 : 1); break;
      case ",":          stepFrames(-1); break;
      case ".":          stepFrames(1); break;
      case "j":          seekBy(e.shiftKey ? -5 : -1); break;
      case "l":          seekBy(e.shiftKey ? 5 : 1); break;
      case "0": case "Home":
        if (v) { v.currentTime = 0; flash("restart"); }
        break;
      case "1": setBare(false); setAngle(0); break;
      case "2": setBare(false); setAngle(1); break;
      case "n": nextPlay(); break;
      case "s": quickSave(); break;
      case "e": if (curRow) setNote(true, true); else handled = false; break;
      case "p": prevPlay(); break;
      case "[": setRate(1 / 1.25); break;
      case "]": setRate(1.25); break;
      case "m": if (v) { v.muted = !v.muted; flash(v.muted ? "muted" : "unmuted"); } break;
      case "f":
        try {
          const host = document.getElementById("all22-video");
          document.fullscreenElement ? document.exitFullscreen() : host.requestFullscreen();
        } catch {}
        break;
      case "?": toggleHelp(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();   // keep NFL's own handlers from firing twice
    }
  }
  // capture phase so the page cannot swallow the key first
  window.addEventListener("keydown", keyHandler, true);

  // A click on the picture brings the controls back. Deliberately NOT mousemove:
  // the mouse sits idle over the video while you work the keyboard, and the
  // slightest drift was cancelling bare mode instantly.
  document.addEventListener("click", e => {
    if (!bare) return;
    const host = document.getElementById("all22-video");
    if (host && host.contains(e.target)) setBare(false);
  }, true);

  /* ---------------- UI ---------------- */
  const CSS = `
  #all22{position:fixed;top:0;right:0;width:640px;height:100vh;z-index:2147483000;
    background:#121212;color:#e6e6e6;font:13px/1.45 "All-ProSans-Regular",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    border-left:1px solid #282828;display:flex;flex-direction:column;box-shadow:-8px 0 30px #0008}
  #all22.hid{transform:translateX(100%)}
  #all22 .hd,#all22-ang,#all22-note,#all22 .body,#all22 .dict,#all22 .notice{text-align:left}
  #all22.wide{width:calc(100% - 30px)}
  #all22 h2{margin:0;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#b1924f;font-family:"AllProDisplayC-Bold","All-ProSans-Medium",sans-serif}
  #all22 .hd{padding:11px 14px;border-bottom:1px solid #282828;display:flex;justify-content:space-between;align-items:center}
  #all22 .fl{padding:10px 14px;border-bottom:1px solid #282828;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  /* Scope every control style to our own toolbars. A bare "#all22 button" rule
     also hits NFL's player controls, which mount inside this panel -- that paints
     the play/pause/scrubber gold and buries the video. */
  #all22 .fl input,#all22 .fl select{background:#1e1e1e;border:1px solid #282828;color:#e6e6e6;padding:5px 7px;border-radius:4px;font:inherit;font-size:12px}
  /* One control height, one arrow, everywhere in the panel. Every select draws
     the same chevron and opens the panel's own menu (see "one dropdown"),
     never the OS popup; a cap keeps a long option from shoving Sort onto a
     second row. */
  #all22 .fl input,#all22 .fl select,#all22 .fl button,#all22 .pchip{height:30px;box-sizing:border-box}
  #all22 .fl select{-webkit-appearance:none;appearance:none;padding-right:24px!important;max-width:190px;
    text-overflow:ellipsis;cursor:pointer;background-repeat:no-repeat;background-position:right 8px center;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23adadad' stroke-width='1.5'/%3E%3C/svg%3E")}
  #all22 .fl input:focus,#all22 .fl select:focus{outline:none;border-color:#b1924f}
  #all22 .fl [hidden]{display:none!important}
  #all22 .fl button,#all22 .hd button{background:#b1924f;color:#17130a;border:0;padding:6px 13px;border-radius:4px;font:600 12px inherit;cursor:pointer}
  #all22 .fl button.g,#all22 .hd button.g{background:transparent;color:#adadad;border:1px solid #282828;padding:4px 9px;font-weight:500}
  #all22 .fl button.g:hover,#all22 .hd button.g:hover{color:#b1924f;border-color:#b1924f}
  /* icon buttons: square, quiet until hovered, gold like everything else */
  #all22 .hd .btns{display:flex;gap:6px;align-items:center}
  #all22 .hd button.ib{background:transparent;color:#adadad;border:1px solid #282828;
    padding:0;width:28px;height:28px;border-radius:4px;display:inline-flex;
    align-items:center;justify-content:center;cursor:pointer}
  #all22 .hd button.ib:hover{color:#b1924f;border-color:#b1924f}
  /* the tip jar is a link, styled as the buttons beside it */
  #all22 .hd a.ib{background:transparent;color:#adadad;border:1px solid #282828;padding:0;width:28px;height:28px;
    border-radius:4px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;text-decoration:none}
  #all22 .hd a.ib:hover{color:#b1924f;border-color:#b1924f}
  #all22 .hd a.ib svg{width:16px;height:16px;display:block}
  #all22 .hd button.ib svg{width:16px;height:16px;display:block}
  /* hard boundary: nothing of ours reaches into the player subtree */
  #all22-video{contain:layout style}
  /* Everything below the video scrolls as one region. Without min-height:0 a
     flex child refuses to shrink below its content, so it overflows instead of
     scrolling and the wheel falls through to the page underneath. */
  #all22 .body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  #all22 .res{}
  #all22 .dict{flex:1;min-height:0;display:flex;flex-direction:column;background:#121212}
  #all22 .dict[hidden]{display:none}
  #all22 .dhead{display:flex;gap:8px;align-items:center;padding:10px 14px;
    border-bottom:1px solid #282828;background:#191919}
  #all22 .dhead input{flex:1;background:#1e1e1e;border:1px solid #282828;color:#e6e6e6;
    padding:6px 9px;border-radius:4px;font:inherit;font-size:12px}
  #all22 .dhead input:focus{outline:none;border-color:#b1924f}
  #all22 .dhead .dcount{color:#bdbdbd;font-size:11px;white-space:nowrap}
  #all22 .dlist{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  #all22 .dent{padding:10px 14px;border-bottom:1px solid #232323;cursor:pointer}
  #all22 .dent:hover{background:#1e1e1e}
  #all22 .dent .dtop{display:flex;gap:8px;align-items:baseline}
  #all22 .dent .dname{color:#e6e6e6;font-weight:600;font-size:12.5px}
  #all22 .dent .dkind{color:#bdbdbd;font-size:10px;letter-spacing:.06em;
    text-transform:uppercase;margin-left:auto;white-space:nowrap}
  #all22 .dent .dkey{color:#8f8f8f;font-family:ui-monospace,Menlo,monospace;font-size:10px}
  #all22 .dent .ddesc{color:#bdbdbd;font-size:11.5px;line-height:1.4;margin-top:3px}
  #all22 .dval{font-size:11px;color:#a3a3a3;font-family:ui-monospace,Menlo,monospace}
  #all22 .dent .dval{margin-top:4px}
  #all22 .dval b{color:#b1924f;font-weight:600;cursor:pointer}
  #all22 .dval b:hover{color:#c9a961;text-decoration:underline}
  #all22 .dn{color:#8f8f8f}
  /* a column that has not been charted for the weeks on screen: muted when it
     is only the cadence worth knowing, amber when data is actually missing */
  #all22 .m .sv{color:#c9a961}
  #all22 .late{flex:0 0 100%;color:#9a9a9a;font-size:10.5px;line-height:1.4;margin-top:4px}
  #all22 .late.warn{color:#e0a86b}
  #all22 .dempty{padding:16px 14px;color:#bdbdbd;font-size:12px}
  /* the dictionary's two levels: category tabs, then section chips inside one.
     Buttons here assert every property, because NFL's page styles bare buttons */
  #all22 .dtabs{flex:none;display:flex;gap:2px;padding:0 8px;border-bottom:1px solid #282828;
    background:#191919;overflow-x:auto;scrollbar-width:none}
  #all22 .dtab{flex:none;background:none;border:0;border-bottom:2px solid transparent;border-radius:0;margin:0;
    color:#adadad;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;
    line-height:1.3;padding:9px 8px 7px;cursor:pointer;white-space:nowrap}
  #all22 .dtab:hover{color:#e6e6e6}
  #all22 .dtab.on{color:#e6e6e6;border-bottom-color:#b1924f}
  #all22 .dtab.dim{opacity:.38}
  #all22 .dsecs{flex:none;display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #282828;
    background:#151515;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#333 transparent}
  #all22 .dsecs[hidden]{display:none}
  #all22 .dsc{flex:none;background:#1e1e1e;color:#adadad;border:1px solid #282828;border-radius:11px;margin:0;
    padding:3px 10px;font-family:inherit;font-size:11px;font-weight:500;line-height:1.4;letter-spacing:0;
    text-transform:none;cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:baseline}
  #all22 .dsc:hover{color:#e6e6e6}
  #all22 .dsc .n{color:#8f8f8f;font-size:10px}
  #all22 .dsc.on{background:#b1924f;color:#17130a;border-color:#b1924f;font-weight:600}
  #all22 .dsc.on .n{color:#2a2210}
  #all22 .dsc.dim{opacity:.38}
  /* a section's header stays put while its rows scroll under it */
  #all22 .dsh{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:baseline;
    padding:6px 14px 5px;background:#171717;border-bottom:1px solid #232323;color:#9a9a9a;font-size:10px;
    letter-spacing:.08em;text-transform:uppercase;font-weight:600}
  #all22 .dsh .n{color:#8a8a8a;letter-spacing:.02em}
  #all22 .dlink{background:none;border:0;padding:0;margin:0;color:#b1924f;font:inherit;cursor:pointer}
  #all22 .dlink:hover{color:#c9a961;text-decoration:underline}
  /* + on every row opens a filter editor inside it */
  #all22 .dplus{align-self:center;flex:none;width:24px;height:24px;box-sizing:border-box;margin:0;padding:0;
    border-radius:4px;border:1px solid #2e2e2e;background:#1a1a1a;color:#bdbdbd;display:inline-flex;
    align-items:center;justify-content:center;cursor:pointer}
  #all22 .dplus:hover,#all22 .dent.open .dplus{color:#b1924f;border-color:#b1924f}
  #all22 .dplus svg{width:14px;height:14px;display:block}
  #all22 .dent.open,#all22 .dent.open:hover{background:#17150f;border-left:3px solid #b1924f;padding-left:11px}
  #all22 .dact{display:inline-block;margin-right:6px;color:#17130a;background:#b1924f;border-radius:3px;
    padding:0 5px;font-weight:700;font-size:9px;letter-spacing:.06em;line-height:15px}
  #all22 .ded{margin-top:9px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;cursor:default}
  #all22 .ded input,#all22 .ded select{height:28px;box-sizing:border-box;margin:0;background:#1e1e1e;
    border:1px solid #2e2e2e;color:#e6e6e6;padding:0 8px;border-radius:4px;font-family:inherit;font-size:12px}
  #all22 .ded input{width:120px}
  #all22 .ded select{-webkit-appearance:none;appearance:none;padding-right:24px;max-width:240px;
    text-overflow:ellipsis;cursor:pointer;background-repeat:no-repeat;background-position:right 8px center;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23adadad' stroke-width='1.5'/%3E%3C/svg%3E")}
  #all22 .ded input:focus,#all22 .ded select:focus{outline:none;border-color:#b1924f}
  #all22 .ded .dhint{font-family:ui-monospace,Menlo,monospace;font-size:11px}
  #all22 .ded .dgrow{flex:1}
  #all22 .ded .a22b{height:28px;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px}
  #all22 .ded .a22b svg{width:13px;height:13px;stroke-width:2.5}
  #all22 .ded .a22b:disabled{opacity:.4;cursor:default}
  #all22 .ded .a22b:not(.pri):disabled:hover{color:#adadad;border-color:#282828}
  #all22 .dseg{display:inline-flex;gap:4px}
  #all22 .dsb{height:28px;box-sizing:border-box;margin:0;background:#1e1e1e;color:#adadad;border:1px solid #2e2e2e;
    padding:0 12px;border-radius:4px;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:0;
    text-transform:none;cursor:pointer;display:inline-flex;gap:7px;align-items:center}
  #all22 .dsb:hover{color:#e6e6e6}
  #all22 .dsb .dn{font:400 10.5px ui-monospace,Menlo,monospace}
  #all22 .dsb.on{background:#b1924f;color:#17130a;border-color:#b1924f}
  #all22 .dsb.on .dn{color:#2a2210}
  #all22 .dneed{flex:0 0 100%;color:#9a9a9a;font-size:11px}
  #all22 .dneed.warn,#all22 .derr.warn{color:#e0a86b}
  #all22 .derr{flex:0 0 100%;color:#e0736b;font-size:11px}
  #all22 .derr[hidden]{display:none}
  /* the active filters, in view while you build them */
  #all22 .dtray{flex:none;display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;padding:8px 14px;
    border-top:1px solid #3a3222;background:#1a1710}
  #all22 .dtray[hidden]{display:none}
  #all22 .dtcap{color:#b1924f;font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
  #all22 .dtray .dtchips{flex:1;min-width:0}
  #all22 .dtray .a22b{padding:3px 9px;font-size:11px}
  #all22 .dtray .chip.fresh{animation:a22fresh 1.2s ease-out}
  @keyframes a22fresh{0%{box-shadow:0 0 0 3px #b1924f99}100%{box-shadow:0 0 0 0 #b1924f00}}
  #all22 .dfoot{padding:8px 14px;border-top:1px solid #282828;background:#191919;
    color:#a3a3a3;font-size:10.5px;line-height:1.4}
  #all22 .dfoot a{color:#b1924f;text-decoration:none}
  #all22 .dfoot a:hover{color:#c9a961;text-decoration:underline}
  #all22 .notice{padding:10px 14px 12px;border-bottom:1px solid #282828;background:#1a1710;
    color:#e6e6e6;font-size:12px;line-height:1.45}
  #all22 .notice[hidden]{display:none}
  #all22 .notice > b{display:block;color:#b1924f;font-size:10px;letter-spacing:.14em;
    text-transform:uppercase;margin-bottom:6px}
  #all22 .notice ul{margin:0 0 8px;padding-left:18px}
  #all22 .notice li{margin:3px 0}
  #all22 .notice button{background:#b1924f;color:#17130a;border:0;padding:5px 12px;
    border-radius:4px;font:600 12px inherit;cursor:pointer}

  /* display and margin are asserted: NFL Pro's UI framework styles every
     ".row" on the page as a wrapping flex row with -12px margins, which ran
     each play's meta line inline after its description */
  #all22 .row{display:block;margin:0;flex:none;padding:9px 14px;border-bottom:1px solid #232323;cursor:pointer}
  #all22 .row:hover{background:#1e1e1e}
  #all22 .row.on{background:#282828;border-left:3px solid #b1924f;padding-left:11px}
  #all22 .m{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#adadad}
  #all22 .pos{color:#5cc98a}#all22 .neg{color:#e0736b}
  #all22 .st{padding:9px 14px;color:#adadad;font-size:12px}
  #all22-video{background:#000;width:100%;display:flex;justify-content:center}
  /* Fill the panel width, limited only by the height actually available:
     100vh minus the header, the angle buttons and one filter row. (The note
     strip opens on demand and scrolls the list rather than shrinking this.) In wide mode
     that is roughly double the old 620px-height cap; in narrow, width:100%
     still governs. */
  #all22-video .a22box{width:100%;max-width:calc((100vh - 210px) * 16 / 9);
    aspect-ratio:16/9;background:#000;position:relative}
  /* NFL's player wraps the <video> in divs that size to their own defaults;
     make the chain fill the box so the picture scales with the panel */
  /* stretch the player's own wrappers, but never our injected overlays --
     :not([data-a22]) matters: without it the timecode badge inherited
     width/height 100% and its translucent background dimmed the whole picture */
  #all22-video .a22box > div:not([data-a22]),
  #all22-video .a22box > div:not([data-a22]) > div{width:100%;height:100%}
  #all22-video video{width:100%;height:100%;object-fit:contain;background:#000}
  #all22 .pwrap{position:relative;display:inline-block}
  /* every menu in the panel -- player, Any filter, and each select's list --
     is this one box: same surface, rows, hover, and current-value mark */
  #all22 .pmenu,#all22 .a22sel{position:absolute;z-index:40;max-height:300px;overflow:auto;
    overscroll-behavior:contain;background:#1a1a1a;border:1px solid #313131;border-radius:6px;
    padding:4px;box-shadow:0 12px 28px rgba(0,0,0,.6);text-align:left}
  #all22 .pmenu{top:100%;left:0;min-width:300px;margin-top:3px}
  #all22 .pmenu div,#all22 .a22sel .it{padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px;
    color:#e6e6e6;display:flex;justify-content:space-between;gap:12px;align-items:baseline;white-space:nowrap}
  #all22 .pmenu div:hover,#all22 .pmenu div.sel,#all22 .a22sel .it:hover,#all22 .a22sel .it.kb{background:#282828}
  #all22 .pmenu .who{color:#e6e6e6;overflow:hidden;text-overflow:ellipsis;min-width:0}
  #all22 .pmenu .meta2{color:#8f8f8f;font-size:11px;white-space:nowrap;flex:none}
  #all22 .a22sel .it.on{color:#b1924f;font-weight:600}
  #all22 .a22sel .it.on::after{content:"\\2713";font-weight:600}
  #all22 .a22sel .it.dis{opacity:.4;cursor:default}
  #all22 .a22sel .g{margin:4px 6px;border-top:1px solid #2a2a2a}
  #all22 .a22sel .g[data-l]:not([data-l=""]){border:0;margin:6px 10px 2px;color:#8f8f8f;
    font-size:10px;letter-spacing:.08em;text-transform:uppercase}
  #all22 .a22sel .g[data-l]:not([data-l=""])::before{content:attr(data-l)}
  #all22 .a22sel[hidden]{display:none!important}
  #all22 .ctl{display:inline-flex;flex-direction:column;gap:3px}
  #all22 .ctl > span:first-child{font-size:10px;letter-spacing:.02em;
    color:#adadad;padding-left:2px}
  #all22 #a-role-wrap{display:none}
  #all22 #a-role-wrap.on{display:inline-flex}
  #all22 #a-facethead{display:none;align-items:center;gap:8px;padding:7px 14px;
    background:#191919;border-bottom:1px solid #282828;cursor:pointer;user-select:none}
  #all22 #a-facethead.on{display:flex}
  #all22 #a-facethead:hover{background:#1e1e1e}
  #all22 #a-facethead .cap{font-size:11px;letter-spacing:.02em;color:#adadad;min-width:82px}
  #all22 #a-facethead .sum{font-size:11px;color:#a3a3a3;flex:1;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  #all22 #a-facethead .sum .k{color:#bdbdbd;font-size:10px;letter-spacing:.04em;
    text-transform:uppercase;margin-right:6px}
  #all22 #a-facethead .sum .grp{margin-right:14px}
  #all22 #a-facethead .sum .grp+.grp{border-left:1px solid #303030;padding-left:13px}
  #all22 #a-facethead .sum .v{color:#b1924f;font-weight:600}
  #all22 #a-facethead .sum .x{color:#be6f60;font-weight:600}
  #all22 #a-facethead .sum .v+.v::before,#all22 #a-facethead .sum .x+.x::before{
    content:"\\00b7";color:#7d7d7d;font-weight:400;margin:0 5px}
  #all22 #a-facethead .sum .none{color:#bdbdbd}
  #all22 #a-facethead .chev{color:#a3a3a3;font-size:10px;transition:transform .15s}
  #all22 #a-facethead.shut .chev{transform:rotate(-90deg)}
  #all22 #a-facets{display:none;flex-direction:column;gap:6px;padding:9px 14px;
    border-bottom:1px solid #282828;background:#191919}
  #all22 #a-facets.on{display:flex}
  /* .on and .shut have equal specificity, so this must stay AFTER .on to win */
  #all22 #a-facets.on.shut{display:none}
  #all22 #a-facetrows{display:flex;flex-direction:column;gap:6px}
  #all22 #a-facetrows:empty,#all22 #a-colrow:empty{display:none}
  #all22 #a-facfoot{display:none}
  #all22 #a-facfoot.on{display:flex}
  #all22 .fac{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  #all22 .fac .lab{font-size:11px;letter-spacing:.02em;color:#adadad;min-width:82px}
  #all22 .fac .chip{display:inline-flex;align-items:stretch;border:1px solid #282828;
    border-radius:11px;overflow:hidden;background:#1e1e1e}
  #all22 .fac .chip .inc{background:none;border:0;color:#adadad;padding:4px 9px;
    font:500 11px inherit;cursor:pointer;white-space:nowrap}
  #all22 .fac .chip .exc{background:none;border:0;border-left:1px solid #282828;color:#a3a3a3;
    padding:4px 7px;font:600 11px inherit;cursor:pointer;line-height:1}
  #all22 .fac .chip .inc:hover{color:#e6e6e6}
  #all22 .fac .chip .exc:hover{color:#be6f60;background:#231513}
  #all22 .fac .chip.on{border-color:#b1924f}
  #all22 .fac .chip.on .inc{background:#b1924f;color:#17130a;font-weight:600}
  #all22 .fac .chip.no{border-color:#6d372c}
  #all22 .fac .chip.no .inc{background:#231513;color:#be6f60;text-decoration:line-through}
  #all22 .fac .chip.no .exc{color:#be6f60}
  #all22 .fac .chip.zero .inc{opacity:.38}
  #all22 .fac .allbtn{background:#1e1e1e;color:#adadad;border:1px solid #282828;
    padding:4px 10px;border-radius:11px;font:500 11px inherit;cursor:pointer}
  #all22 .fac .allbtn.on{background:#b1924f;color:#17130a;border-color:#b1924f;font-weight:600}
  #all22 .fac .hint{color:#adadad;font-size:10px;margin-left:2px}
  #all22 #a-hint a{color:#b1924f;text-decoration:none;border-bottom:1px dotted #b1924f80}
  #all22 #a-hint a:hover{color:#c9a961;border-bottom-color:#c9a961}
  #all22 .pchip{background:#b1924f;color:#17130a;border-radius:4px;padding:5px 9px;
    font:600 12px inherit;display:inline-flex;gap:7px;align-items:center;cursor:pointer}
  #all22-video{position:relative}
  /* Bare mode: nothing over the picture. NFL's class names are emotion hashes,
     so the overlay is found by structure -- every element that neither is nor
     wraps the <video> -- rather than by name. It has to be a selector and not a
     class we stamp on: while you step, NFL's player rebuilds its whole overlay
     about once a second (title, and a loading icon where play/pause sits) as
     brand-new elements, and a tag on the old ones does not follow. Measured:
     each step's seek lands in under 20ms with the frame ready, so that flash
     was never the video. This also covers the paused-state dim layers and
     THEOplayer's poster and spinner. [data-a22] is our own timecode. */
  #all22-video .a22box.bare > :not([data-a22]):not(:has(video)),
  #all22-video .a22box.bare > :not([data-a22]) :not(video):not(:has(video)){
    opacity:0!important;pointer-events:none!important}
  #a-tc{position:absolute;left:10px;bottom:10px;z-index:8;width:auto!important;height:auto!important;background:#000a;color:#b1924f;
    padding:3px 8px;border-radius:4px;font:600 11px ui-monospace,Menlo,monospace;
    letter-spacing:.04em;pointer-events:none}
  #a-flash{position:absolute;left:10px;top:10px;z-index:6;
    background:#000c;color:#b1924f;border:1px solid #b1924f;border-radius:4px;
    padding:4px 9px;font:600 11px "All-ProSans-Medium",sans-serif;letter-spacing:.04em;
    pointer-events:none;opacity:0;transition:opacity .18s}
  #a-help{position:absolute;right:14px;top:14px;z-index:7;background:#121212f2;
    border:1px solid #282828;border-radius:4px;padding:12px 14px;cursor:pointer;
    font:12px "All-ProSans-Regular",sans-serif;color:#e6e6e6;box-shadow:0 10px 34px #000a}
  #a-help b{display:block;color:#b1924f;font-size:10px;letter-spacing:.14em;
    text-transform:uppercase;margin-bottom:8px}
  #a-help div{display:flex;gap:12px;padding:2px 0}
  #a-help kbd{min-width:82px;color:#adadad;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  #all22-ang .pgrp{margin-left:auto;display:flex;gap:4px;align-items:center;position:relative}
  #all22-ang .ico{padding:4px 9px;min-width:30px;font-size:15px;line-height:16px}
  #all22-ang .ico:hover:not(:disabled){border-color:#b1924f;color:#b1924f}
  #all22-ang .ico:disabled{opacity:.3;cursor:default}
  /* positioned so the dot below anchors to the gear itself rather than to
     .pgrp, where it would only look right while the gear stays last */
  #all22-ang .gear{font-size:12px;position:relative}
  /* a clip rolling into the next one is worth knowing about without opening
     the menu to check */
  #all22-ang .gear.act::after{content:"";position:absolute;top:2px;right:3px;
    width:5px;height:5px;border-radius:50%;background:#b1924f}
  /* the panel's CSS lands in NFL's page, so hidden is asserted rather than
     left to the UA sheet -- same as .dict and .notice above */
  #all22-pop[hidden]{display:none!important}
  #all22-pop{position:absolute;top:calc(100% + 8px);right:0;z-index:30;width:212px;
    background:#1a1a1a;border:1px solid #313131;border-radius:8px;padding:8px 10px 9px;
    box-shadow:0 12px 28px rgba(0,0,0,.6)}
  #all22-pop .prow{display:flex;align-items:center;justify-content:space-between;
    gap:10px;padding:5px 0}
  /* the speed row stacks, so adding a rate widens the buttons rather than
     squeezing them against the label */
  #all22-pop .prow.col{display:block;padding:3px 0 7px}
  #all22-pop .prow.col .plab{display:block;margin-bottom:5px}
  #all22-pop .prow.col .seg{display:flex}
  #all22-pop .prow.col .seg button{flex:1;min-width:0}
  #all22-pop .plab{color:#cfcfcf;font-size:12px;white-space:nowrap}
  #all22-pop .seg{display:flex;gap:4px}
  #all22-pop .seg button{padding:3px 7px;min-width:34px;font-size:11px}
  #all22-pop .tg{padding:3px 11px;font-size:11px}
  #all22-pop .pnote{color:#7d7d7d;font-size:10.5px;line-height:1.35;
    padding:5px 0 0;border-top:1px solid #262626;margin-top:4px}
  #all22-ang .khint{color:#a3a3a3;font-size:11px;line-height:1;cursor:pointer;margin-left:10px;white-space:nowrap}
  #all22-ang .khint:hover{color:#b1924f}
  /* centred, so the keyboard hint sits on the buttons' midline, not their top edge */
  #all22-ang{display:flex;align-items:center;gap:6px;padding:8px 14px;background:#121212;border-bottom:1px solid #282828}
  /* Wide mode covers the page instead of squeezing it into a sliver. This strip
     rides just outside the panel's left edge (translateX(-100%)) and is the way
     back: one click narrows the panel and the page reflows beside it again. */
  #all22 .tray{display:none;position:absolute;left:0;top:0;height:100%;
    box-sizing:border-box;width:30px;transform:translateX(-100%);background:#191919;
    border-left:1px solid #282828;border-right:1px solid #282828;box-shadow:-8px 0 30px #0008;cursor:pointer;
    color:#a3a3a3;flex-direction:column;align-items:center;justify-content:center;
    gap:10px;user-select:none}
  #all22.wide .tray{display:flex}
  #all22 .tray:hover{background:#1e1e1e;color:#b1924f}
  #all22 .tray svg{width:14px;height:14px;display:block;flex:none}
  #all22 .tray span{writing-mode:vertical-rl;font:600 10px "All-ProSans-Medium",sans-serif;
    letter-spacing:.16em;text-transform:uppercase}
  #all22-ang button{background:#1e1e1e;color:#adadad;border:1px solid #282828;padding:5px 14px;
    border-radius:4px;font:600 12px inherit;letter-spacing:.02em;text-transform:capitalize;cursor:pointer}
  #all22-ang button.on{background:#b1924f;color:#17130a;border-color:#b1924f}
  /* Squeeze the NFL Pro page into the remaining width instead of overlaying it.
     The transform on <body> is load-bearing: it makes body the containing block
     for NFL's own position:fixed chrome (score strip, nav), so that reflows too
     rather than staying full-width underneath us. */
  html.a22push body{width:calc(100% - var(--a22w,640px))!important;transform:translateZ(0);min-height:100vh}
  html.a22push{overflow-x:hidden}
  #all22-tab{position:fixed;top:50%;right:0;z-index:2147483000;transform:translateY(-50%);
    background:#b1924f;color:#17130a;writing-mode:vertical-rl;padding:14px 6px;cursor:pointer;
    border-radius:4px 0 0 5px;font:600 11px "All-ProSans-Medium",sans-serif;letter-spacing:.14em}
  /* ---- NFL Pro: anything answered by NFL Pro's film room is blue ---- */
  #all22 .src{display:inline-block;font:700 9px/1.5 ui-monospace,Menlo,monospace;letter-spacing:.06em;
    color:#6fa3dd;border:1px solid #4f8fd166;border-radius:3px;padding:0 4px;margin-left:6px;vertical-align:1px}
  #all22 .dent .dkind .src{margin-left:0;margin-right:6px}
  /* ---- layout: the stage (video, angles, note, On field) over the list in
       half view; side by side in wide view, so the filters and the play list
       get the full height instead of a strip under a full-width picture ---- */
  #all22 .a22main{flex:1;min-height:0;display:flex;flex-direction:column}
  #all22 .a22stage{flex:none;display:flex;flex-direction:column;min-width:0}
  #all22 .a22list{flex:1;min-height:0;display:flex;flex-direction:column;min-width:0}
  #all22.wide .a22main{flex-direction:row}
  #all22.wide .a22stage{flex:1.55 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;
    border-right:1px solid #282828;background:#121212}
  #all22.wide .a22list{flex:1 1 0}
  /* in wide view the picture leaves room under it for the angle bar and the
     22-man On field list (~280px), and is otherwise as big as the column */
  #all22.wide #all22-video .a22box{max-width:calc((100vh - 340px) * 16 / 9)}
  #all22 .vrow{display:flex;align-items:stretch;background:#000}
  #all22 .vrow #all22-video{flex:1;min-width:0}
  #a-onside[hidden],#a-onsheet[hidden]{display:none!important}
  #all22 .ofwrap{position:relative;height:0;z-index:25}
  #a-onsheet{position:absolute;left:0;right:0;top:0;background:#161616;border-bottom:1px solid #333;
    box-shadow:0 18px 40px #000c;max-height:70vh;overflow-y:auto;overscroll-behavior:contain;text-align:left}
  #all22 .ofh{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid #282828}
  #all22 .ofh .t{color:#b1924f;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;flex:none}
  #all22 .ofh .s{color:#8f8f8f;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  #all22 #a-onside .ofh .s{color:#cfcfcf;font-size:12px}
  #all22 .ofh .sp{flex:1}
  #all22 .ofteams{display:grid;grid-template-columns:1fr 1fr}
  /* Wide view: On field fills the rest of the stage under the video, offense
     and defense side by side, and the 11 rows of each share that height --
     every player on screen, no scrolling. Type scales with the list's own
     height (cqh) between a readable floor and the half-view size; below the
     floor it scrolls rather than overlap. */
  #a-onside{flex:1 1 auto;min-height:230px;container-type:size;display:flex;flex-direction:column;
    background:#151515;border-top:1px solid #282828;overflow-y:auto;overscroll-behavior:contain;text-align:left}
  #all22 #a-onside .ofh{flex:none;padding:clamp(4px,2.4cqh,9px) 14px}
  #all22 #a-onside .ofteams{flex:1 1 auto;min-height:0}
  #all22 #a-onside .ofteam{display:flex;flex-direction:column;min-height:0;padding:2px 0}
  #all22 #a-onside .ofteam h4{flex:none;padding:clamp(1px,1.2cqh,4px) 14px;font-size:clamp(9px,3.8cqh,11px)}
  #all22 #a-onside .ofp{flex:1 1 0;min-height:14px;padding-top:0;padding-bottom:0;font-size:clamp(10px,4.6cqh,12.5px)}
  #all22 #a-onside .ofp .p{font-size:clamp(9px,4cqh,10.5px)}
  #all22 #a-onside .ofp .n{font-size:clamp(9px,4.2cqh,11px)}
  #all22 #a-onside .ofp .go2{font-size:clamp(9px,4cqh,11px)}
  #all22 .ofteam{padding:6px 0;min-width:0}
  #all22 .ofteams .ofteam+.ofteam{border-left:1px solid #282828}
  #all22 .ofteam h4{margin:0;padding:4px 14px 6px;font-size:11px;color:#adadad;font-weight:600;letter-spacing:.04em}
  #all22 .ofp{display:grid;grid-template-columns:34px 24px minmax(0,1fr) auto;gap:6px;align-items:center;
    padding:3px 14px;font-size:12px;cursor:pointer;color:#e6e6e6}
  #all22 .ofp .p{color:#8f8f8f;font:10.5px ui-monospace,Menlo,monospace}
  #all22 .ofp .n{color:#8f8f8f;font:11px ui-monospace,Menlo,monospace;text-align:right}
  #all22 .ofp .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #all22 .ofp .go2{opacity:0;color:#6fa3dd;font-size:11px;white-space:nowrap}
  #all22 .ofp:hover{background:#202734}
  #all22 .ofp:hover .go2{opacity:1}
  #all22 .ofp.nolink{cursor:default}
  #all22 .ofp.nolink:hover{background:none}
  #all22 .ofmsg{padding:12px 14px;color:#8f8f8f;font-size:12px}
  #all22 .offoot{padding:7px 14px 9px;color:#8f8f8f;font-size:10.5px;border-top:1px solid #282828}
  /* ---- saved plays: note strip, save menu, cutups view ---- */
  #all22 .a22b{background:transparent;color:#adadad;border:1px solid #282828;padding:4px 10px;
    border-radius:4px;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
  #all22 .a22b:hover{color:#b1924f;border-color:#b1924f}
  #all22 .a22b.on,#all22 .a22b.pri{background:#b1924f;color:#17130a;border-color:#b1924f;font-weight:600}
  #all22 .a22b.warn{color:#e0736b;border-color:#6d372c}
  #all22 .a22i{background:#1e1e1e;border:1px solid #282828;color:#e6e6e6;padding:5px 8px;
    border-radius:4px;font-family:inherit;font-size:12px;min-width:0}
  #all22 .a22i:focus{outline:none;border-color:#b1924f}
  #all22-note{display:flex;gap:8px;align-items:flex-start;padding:8px 14px;
    border-bottom:1px solid #282828;background:#121212}
  #all22-note[hidden]{display:none!important}
  /* the play on screen: save and note sit in the header beside Cutups */
  #all22 .hd .sgrp{position:relative;display:inline-flex}
  #all22 .hd button.ib:disabled{opacity:.3;cursor:default}
  #all22 .hd button.ib:disabled:hover{color:#adadad;border-color:#282828}
  #all22 .hd #a-save.on{color:#b1924f;border-color:#b1924f}
  #all22 .hd #a-save.on svg{fill:currentColor}
  #all22 .hd #a-notebtn{position:relative}
  #all22 .hd #a-notebtn.open{color:#b1924f;border-color:#b1924f}
  /* this play already has a note */
  #all22 .hd #a-notebtn.has::after{content:"";position:absolute;top:3px;right:3px;
    width:5px;height:5px;border-radius:50%;background:#b1924f}
  #all22-note textarea{flex:1;height:30px;min-height:30px;max-height:120px;resize:none;
    background:#1e1e1e;border:1px solid #282828;color:#e6e6e6;padding:6px 8px;border-radius:4px;
    font-family:inherit;font-size:12px;line-height:1.4;box-sizing:border-box}
  #all22-note textarea:focus{outline:none;border-color:#b1924f}
  #a-savemenu{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:250px;text-align:left;
    background:#1a1a1a;border:1px solid #313131;border-radius:8px;padding:6px;
    box-shadow:0 12px 28px rgba(0,0,0,.6)}
  #a-savemenu[hidden]{display:none!important}
  #a-savemenu .ci{display:flex;gap:8px;align-items:center;padding:6px;border-radius:4px;
    cursor:pointer;font-size:12px;color:#e6e6e6}
  #a-savemenu .ci:hover{background:#242424}
  #a-savemenu .ci input{accent-color:#b1924f;margin:0}
  #a-savemenu .ci .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #a-savemenu .ci .n{color:#8f8f8f;font-size:11px}
  #a-savemenu .pe{color:#8f8f8f;font-size:11.5px;padding:6px}
  #a-savemenu .newc{display:flex;gap:6px;border-top:1px solid #262626;margin-top:4px;padding-top:6px}
  #a-savemenu .newc input{flex:1}
  #a-cuthead{display:none}
  #all22.cutmode #a-cuthead{display:block}
  #all22.cutmode #a-body > .fl,#all22.cutmode #a-facethead,#all22.cutmode #a-facets{display:none!important}
  #all22 .cbar{display:flex;gap:6px;align-items:center;padding:9px 14px;flex-wrap:wrap;
    border-bottom:1px solid #282828;background:#191919}
  #all22 .cbar .cap{color:#b1924f;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
  #all22 .cbar .cn{color:#e6e6e6;font-weight:600;font-size:13px;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap;max-width:260px}
  #all22 .cbar .cnt{color:#8f8f8f;font-size:11px}
  #all22 .cbar .sp{flex:1}
  #all22 .cbar input{flex:1}
  #all22 .crow{padding:10px 14px;border-bottom:1px solid #232323;cursor:pointer;
    display:flex;gap:10px;align-items:center}
  #all22 .crow:hover{background:#1e1e1e}
  #all22 .crow .cmain{flex:1;min-width:0}
  #all22 .crow .cname{font-weight:600;color:#e6e6e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #all22 .crow .cact{display:flex;gap:4px;flex:none}
  #all22 .crow .cact .a22b{padding:3px 8px;font-size:11px}
  #all22 .cempty{padding:16px 14px;color:#bdbdbd;font-size:12px;line-height:1.5}
  #all22 .row .nt{margin-top:4px;color:#d8c9a3;font-size:11.5px;white-space:pre-wrap;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
    border-left:2px solid #b1924f66;padding-left:7px}
  #all22 .row .star{color:#b1924f}
  #all22 .row{position:relative}
  #all22.cutmode .row{padding-right:92px}
  #all22 .row .rctl{position:absolute;right:12px;top:8px;display:flex;gap:3px;opacity:0}
  #all22 .row:hover .rctl,#all22 .row.on .rctl{opacity:1}
  #all22 .row .rctl button{background:transparent;border:1px solid #282828;color:#8f8f8f;
    border-radius:4px;width:22px;height:22px;padding:0;cursor:pointer;font-size:11px;line-height:1}
  #all22 .row .rctl button:hover:not(:disabled){color:#b1924f;border-color:#b1924f}
  #all22 .row .rctl button:disabled{opacity:.3;cursor:default}`;
  document.head.appendChild($("style", "", CSS));

  /* Lucide glyphs, inlined. The panel is plain DOM in the page world -- no React,
     no bundler -- so these carry lucide's own path data for chevrons-left,
     chevrons-right and x, with the two subpaths of each chevron joined into one. */
  /* The tip jar is a plain link to the landing page's tip section, which
     carries the terms (not a purchase, not refunded) beside Ko-fi's form.
     Nothing loads until it is clicked: no Ko-fi frame inside NFL Pro. */
  const TIP_URL = "https://boorish-sports.github.io/all-22/#tip";
  const ICON = {
    wide:   "m11 17-5-5 5-5M18 17l-5-5 5-5",
    narrow: "m6 17 5-5-5-5M13 17l5-5-5-5",
    hide:   "M18 6 6 18M6 6l12 12",
    cuts:   "M12 12H3M16 6H3M12 18H3M16 12l5 3-5 3v-6Z",
    tip:    "M10 2v2M14 2v2M6 2v2M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1",
    star:   "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
    note:   "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
    book:   "M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
  };
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${d}"/></svg>`;

  const tab = $("div", "", "ALL-22");
  tab.id = "all22-tab";
  // attach to <html>: body gets a transform below, which would otherwise become
  // the containing block for these fixed elements and misplace them
  document.documentElement.appendChild(tab);

  const p = $("div");
  p.id = "all22";
  p.innerHTML = `
    <div class="tray" id="all22-tray" title="Narrow the panel to show NFL Pro">${svg(ICON.narrow)}<span>NFL Pro</span></div>
    <div class="hd"><h2>All-22 Film Search</h2>
      <span class="btns">
        <a class="ib" id="a-tip" href="${TIP_URL}" target="_blank" rel="noopener noreferrer" title="Tip jar: opens the All-22 page in a new tab" aria-label="Tip jar (opens in a new tab)">${svg(ICON.tip)}</a>
        <span class="sgrp"><button class="ib" id="a-save" title="Save this play to a cutup (S)" aria-label="Save this play to a cutup" disabled>${svg(ICON.star)}</button><div id="a-savemenu" hidden></div></span>
        <button class="ib" id="a-notebtn" title="Note on this play (E)" aria-label="Note on this play" disabled>${svg(ICON.note)}</button>
        <button class="ib" id="all22-c" title="Cutups" aria-label="Cutups">${svg(ICON.cuts)}</button>
        <button class="ib" id="all22-d" title="Filter dictionary" aria-label="Filter dictionary">${svg(ICON.book)}</button>
        <button class="ib" id="all22-w" title="Widen the panel" aria-label="Widen the panel">${svg(ICON.wide)}</button>
        <button class="ib" id="all22-x" title="Hide the panel" aria-label="Hide the panel">${svg(ICON.hide)}</button>
      </span></div>
    <div class="a22main">
    <div class="a22stage">
    <div class="vrow"><div id="all22-video"></div></div>
    <div id="all22-ang"></div>
    <div class="ofwrap"><div id="a-onsheet" hidden></div></div>
    <div id="all22-note" hidden>
      <textarea id="a-notetx" rows="1" placeholder="Note on this play. Saves as you type; Esc closes." maxlength="4000"></textarea>
    </div>
    <div id="a-onside" hidden></div>
    </div>
    <div class="a22list">
    <div class="body" id="a-body">
    <div id="a-cuthead"></div>
    <div class="fl">
      <label class="ctl"><span>Season</span><select id="a-season"></select></label>
      <label class="ctl"><span>Week</span><select id="a-week"><option value="">Any</option></select></label>
      <label class="ctl"><span>Team</span><select id="a-team"><option value="">Any</option></select></label>
      <label class="ctl"><span>Player</span><span class="pwrap"><input id="a-player" placeholder="Any" size="11" autocomplete="off"><div class="pmenu" id="a-pmenu" hidden></div></span></label>
      <label class="ctl" id="a-role-wrap"><span>Action</span><select id="a-role"></select></label>
      <label class="ctl"><span>Play Type</span><select id="a-type"><option value="">Any</option><option value="pass">Pass</option><option value="run">Run</option><option value="punt">Punt</option><option value="field_goal">Field goal</option></select></label>
      <label class="ctl"><span>Sort</span><select id="a-order"><option value="game">By game</option><option value="epa">EPA high</option><option value="epa_asc">EPA low</option></select></label>
    </div>
    <div class="fl">
      <span class="pwrap"><input id="a-col" placeholder="Any filter" size="18" autocomplete="off"><div class="pmenu" id="a-colmenu" hidden></div></span>
      <select id="a-op"><option value="eq">=</option><option value="gt">&gt;</option><option value="lt">&lt;</option><option value="gte">&ge;</option><option value="lte">&le;</option><option value="like">Contains</option><option value="notnull">Is set</option></select>
      <input id="a-val" placeholder="Value" size="7">
      <select id="a-bool" hidden><option value="1">Yes</option><option value="0">No</option></select>
      <select id="a-nflv" hidden></select>
      <button class="g" id="a-add">+ Filter</button>
      <input id="a-text" placeholder="Text in description" size="14">
      <button id="a-go">Search</button>
    </div>
    <div id="a-facethead"><span class="cap">Filters</span><span class="sum"></span><span class="chev">&#9660;</span></div>
    <div id="a-facets">
      <div id="a-facetrows"></div>
      <div class="fac" id="a-colrow"></div>
      <div class="fac" id="a-facfoot">
        <span class="lab"></span><span class="hint">&minus; Excludes</span>
        <button class="allbtn" id="a-clear" style="visibility:hidden">Clear all</button>
      </div>
    </div>
    <div class="fl" id="a-hint" style="padding-top:0;border:0;min-height:16px"></div>
    <div class="st" id="all22-st">loading play index…</div>
    <div class="res" id="all22-res"></div>
    </div>
    <div class="dict" id="a-dict" hidden>
      <div class="dhead">
        <input id="a-dsearch" placeholder="Search filter options" autocomplete="off">
        <span class="dcount"></span>
      </div>
      <div class="dtabs" id="a-dtabs" role="tablist" aria-label="Filter categories"></div>
      <div class="dsecs" id="a-dsecs" aria-label="Sections" hidden></div>
      <div class="dlist" id="a-dlist"></div>
      <div class="dtray" id="a-dtray" hidden></div>
      <div class="dfoot">Definitions from <a href="https://github.com/nflverse/nflreadr" target="_blank" rel="noopener">nflreadr</a> (MIT).
        Play data from <a href="https://github.com/nflverse/nflverse-data" target="_blank" rel="noopener">nflverse</a> (CC BY 4.0),
        charting by FTN Data via nflverse. Not affiliated with the NFL, NFL Pro, nflverse or FTN.</div>
    </div>
    </div>
    </div>`;
  document.documentElement.appendChild(p);

  /* Every event a clip load fires, because which one the player resets the rate
     on is its business, and one late re-assert for a reset that lands after
     playback has already started. */
  (function wireRate() {
    const host = document.getElementById("all22-video");
    ["loadedmetadata", "loadeddata", "canplay", "play", "playing"].forEach(ev =>
      host.addEventListener(ev, enforceRate, true));
    host.addEventListener("playing", () => setTimeout(enforceRate, 300), true);
  })();

  // a menu that only closes by its own button is a menu you fight
  document.addEventListener("click", e => {
    if (!menuOpen) return;
    const grp = document.querySelector("#all22-ang .pgrp");
    if (grp && !grp.contains(e.target)) setMenu(false);
  }, true);

  /* Auto-advance. "ended" does not bubble, but a capturing listener on the
     host still sees it, which survives NFL's player recreating its <video>
     for every clip -- attaching per clip would need a hook into a mount we do
     not own. Wired here rather than beside the other listeners because
     #all22-video does not exist until the panel is in the document. Off by
     default: a clip ending is where you rewind and look again, so advancing
     has to be asked for. */
  let endTimer = null;
  document.getElementById("all22-video").addEventListener("ended", e => {
    if (!autoNext || e.target !== vid()) return;
    /* The two angles are one playlist inside NFL's player, but it does NOT
       roll on to the second by itself -- playback simply stops at the end of
       the sideline clip. So walk the angles here first and only leave the play
       from the last one. Getting this wrong skips endzone entirely, which is
       half of what All-22 is for. */
    const wasIdx = curIdx, wasSel = selIdx;
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      if (!autoNext || selIdx !== wasSel || curIdx !== wasIdx) return;
      const v = vid();
      if (v && !v.paused && !v.ended) return;   // something started it again
      if (curIdx >= curList.length - 1) { nextPlay(); return; }
      setAngle(curIdx + 1);
      // whether loadVideoFromProps honours the player's autoplay for a
      // mid-playlist switch is its business; nudge it rather than leave the
      // endzone angle sitting paused on a black frame
      setTimeout(() => {
        const nv = vid();
        if (nv && nv.paused) nv.play().catch(() => {});
      }, 400);
    }, 250);
  }, true);

  const q = s => p.querySelector(s);

  /* First-run notice. The landing page is missed by most installs, so the
     facts that matter go in the panel itself, once, until dismissed. The
     dismissal is keyed by NOTICE_VERSION so a materially changed notice shows
     again. Persisted through iso.js into chrome.storage.local. */
  const NOTICE_VERSION = 2;          // 2: NFL Pro filters ask NFL Pro once per search
  const notice = $("div");
  notice.className = "notice";
  notice.hidden = true;
  notice.innerHTML = `
    <b>Before you start</b>
    <ul>
      <li>This needs an <b>active NFL Pro subscription</b>. Clips play in NFL Pro's own player, under your account.</li>
      <li>It is <b>unofficial</b> and not affiliated with the NFL or NFL Pro.</li>
      <li>It uses <b>undocumented endpoints</b> that can change or disappear at any time. When that happens it will stop working, and there may be no fix.</li>
      <li><b>No video is downloaded or re-hosted.</b> Search runs on your machine. NFL Pro is asked only when you act: one clip lookup per play you click, one query when a search uses an NFL Pro filter, and one per play for the On field list while it is showing.</li>
    </ul>
    <button id="a-notice-ok">Got it</button>`;
  q(".hd").insertAdjacentElement("afterend", notice);
  backend("/api/prefs").then(prefs => {
    prefs = prefs || {};
    // rate is clamped on the way in: it is read back from storage, which a
    // previous version or a hand-edit could leave anything in
    if (prefs.rate) rate = Math.min(4, Math.max(0.1, +prefs.rate || 1));
    autoNext = !!prefs.autoNext;
    lastCut = prefs.lastCut || null;
    if (curList.length) drawAngles();
    if (prefs.noticeDismissed >= NOTICE_VERSION) return;
    notice.hidden = false;
  }).catch(() => { notice.hidden = false; });
  q("#a-notice-ok").onclick = () => {
    notice.hidden = true;
    post("/api/prefs", { noticeDismissed: NOTICE_VERSION }).catch(() => {});
  };
  const extra = [];   // active generic filters

  // ---- player autocomplete -------------------------------------------------
  // Descriptions abbreviate names ("51-W.Anderson"), so typing "Will Anderson"
  // never matched. Resolve to a player id instead and filter on participation,
  // which also disambiguates players who share an abbreviation.
  let picked = null, pTimer = null;

  function showPicked() {
    const wrap = q("#a-player").closest(".pwrap");
    let chip = wrap.querySelector(".pchip");
    if (!picked) { if (chip) chip.remove(); q("#a-player").hidden = false; return; }
    q("#a-player").hidden = true;
    if (!chip) {
      chip = $("span");
      chip.className = "pchip";
      wrap.insertBefore(chip, wrap.firstChild);
      chip.onclick = () => {
        picked = null; facets = {}; excl = new Set(); showPicked(); loadRoles(); loadSubs();
        q("#a-player").value = ""; q("#a-player").focus(); run();
      };
    }
    chip.textContent = picked.name + " ✕";
    chip.title = [picked.position, picked.team, picked.plays + " plays"].filter(Boolean).join(" · ");
  }

  function closeMenu() { q("#a-pmenu").hidden = true; }

  // Populate the role menu with this player's real counts, so "Forced fumble (6)"
  // means six plays he forced one -- not six plays where a fumble happened near him.
  // Each dimension is its own row: pick one option within a row, and rows
  // combine. A single dropdown made Direction overwrite Run type, so you could
  // never ask for "designed runs, up the middle".
  // Each chip has three states: off -> include -> exclude -> off.
  // Includes are exclusive within a dimension; excludes stack, so you can ask
  // for "under center, no play action, no screens".
  let facets = {};        // group label -> included option key
  let excl = new Set();   // excluded option keys, across dimensions

  let skeleton = null;     // rows/options fixed for the life of a role selection

  // The facet block can run to seven rows; collapsing it gives the results list
  // the vertical space back while still showing what is active.
  const COLLAPSE_KEY = "all22.filtersShut";
  let filtersShut = false;
  try { filtersShut = localStorage.getItem(COLLAPSE_KEY) === "1"; } catch {}

  function applyCollapse() {
    q("#a-facets").classList.toggle("shut", filtersShut);
    q("#a-facethead").classList.toggle("shut", filtersShut);
    paintSummary();
  }

  // Facet rows and ad-hoc column filters share one panel, and either can be the
  // only thing in it -- so visibility is decided from both, not from the facets.
  function syncPanelVisibility() {
    const rows = !!(skeleton && skeleton.length);
    const any = rows || extra.length > 0;
    q("#a-facets").classList.toggle("on", any);
    q("#a-facethead").classList.toggle("on", any);
    q("#a-facfoot").classList.toggle("on", any);
    // the legend explains the chips' minus buttons, which only facet rows have
    q("#a-facfoot .hint").style.display = rows ? "" : "none";
    const dirty = Object.keys(facets).length || excl.size || extra.length;
    q("#a-clear").style.visibility = dirty ? "visible" : "hidden";
    applyCollapse();
  }

  function paintSummary() {
    const el = q("#a-facethead") && q("#a-facethead").querySelector(".sum");
    if (!el) return;
    const label = k => {
      for (const g of skeleton || []) for (const o of g.options) if (o.key === k) return o.label;
      return k;
    };
    const inc = Object.values(facets).map(label);
    // a column filter narrows the set exactly like an included facet does
    extra.forEach(f => inc.push(colChipText(f)));
    const exc = [...excl].map(label);
    // name the two lists rather than leaving colour to carry the meaning
    const list = (name, items, cls) => !items.length ? "" :
      `<span class="grp"><span class="k">${name}</span>` +
      items.map(t => `<span class="${cls}">${esc(t)}</span>`).join("") + "</span>";
    el.innerHTML = (inc.length || exc.length)
      ? list("Include", inc, "v") + list("Exclude", exc, "x")
      : '<span class="none">none</span>';
  }

  function toggleCollapse() {
    filtersShut = !filtersShut;
    try { localStorage.setItem(COLLAPSE_KEY, filtersShut ? "1" : "0"); } catch {}
    applyCollapse();
  }

  // Redraw numbers and states without touching structure. Rebuilding innerHTML
  // on every click made chips jump under the cursor, which is intolerable when
  // excluding needs a second click on the same target.
  function paintFacets(groups) {
    const box = q("#a-facetrows");
    const byKey = {};
    (groups || []).forEach(g => g.options.forEach(o => { byKey[o.key] = o.n; }));
    box.querySelectorAll(".chip").forEach(chip => {
      const k = chip.dataset.k, g = chip.closest(".fac").dataset.g;
      const n = byKey[k] === undefined ? 0 : byKey[k];
      chip.querySelector(".inc").textContent = chip.dataset.label + " (" + n + ")";
      chip.classList.toggle("on", facets[g] === k);
      chip.classList.toggle("no", excl.has(k));
      chip.classList.toggle("zero", !n && facets[g] !== k && !excl.has(k));
    });
    box.querySelectorAll(".allbtn[data-g]").forEach(b => {
      const g = b.dataset.g;
      const anyExcl = (skeleton.find(x => x.group === g) || { options: [] })
        .options.some(o => excl.has(o.key));
      b.classList.toggle("on", !facets[g] && !anyExcl);
    });
    syncPanelVisibility();
  }

  function renderFacets(groups) {
    const box = q("#a-facetrows");
    skeleton = (groups || []).filter(g => g.useful);
    if (!skeleton.length) { box.innerHTML = ""; syncPanelVisibility(); return; }
    box.innerHTML = skeleton.map(g => `
      <div class="fac" data-g="${esc(g.group)}">
        <span class="lab">${esc(g.group)}</span>
        <button class="allbtn on" data-g="${esc(g.group)}">All</button>
        ${g.options.map(o => `<span class="chip" data-k="${o.key}" data-label="${esc(o.label)}">
            <button class="inc">${esc(o.label)} (${o.n})</button>
            <button class="exc">&minus;</button>
          </span>`).join("")}
      </div>`).join("");
    syncPanelVisibility();

    box.querySelectorAll(".allbtn[data-g]").forEach(b => b.onclick = () => {
      const g = b.dataset.g;
      delete facets[g];
      (skeleton.find(x => x.group === g) || { options: [] }).options
        .forEach(o => excl.delete(o.key));
      apply();
    });
    box.querySelectorAll(".chip").forEach(chip => {
      const g = chip.closest(".fac").dataset.g, k = chip.dataset.k;
      chip.querySelector(".inc").onclick = () => {
        if (facets[g] === k) delete facets[g]; else { facets[g] = k; excl.delete(k); }
        apply();
      };
      chip.querySelector(".exc").onclick = () => {
        if (excl.has(k)) excl.delete(k);
        else { excl.add(k); if (facets[g] === k) delete facets[g]; }
        apply();
      };
    });
    paintFacets(groups);
  }

  // one click -> search + refresh the numbers, structure untouched
  function apply() {
    run();
    refreshCounts();
  }

  function refreshCounts() {
    if (!picked || !skeleton) return;
    const role = q("#a-role").value || "any";
    const u = contextParams();
    u.set("player", picked.gsis_id);
    u.set("role", role);
    Object.values(facets).forEach(k => u.append("sub", k));
    excl.forEach(k => u.append("nsub", k));
    backend("/api/player_subfilters?" + u).then(d => paintFacets(d.groups)).catch(() => {});
  }

  function loadSubs() {
    if (!picked) { skeleton = null; facets = {}; excl = new Set(); renderFacets(null); return; }
    const role = q("#a-role").value || "any";
    // NFL Pro actions have no index facets: their plays come from NFL Pro
    if (role.startsWith("nfl:")) { skeleton = null; facets = {}; excl = new Set(); renderFacets(null); return; }
    // no facet selections here on purpose -- the row/option set must not depend
    // on them -- but the surrounding filters still apply
    const u0 = contextParams();
    u0.set("player", picked.gsis_id);
    u0.set("role", role);
    backend("/api/player_subfilters?" + u0)
      .then(d => renderFacets(d.groups))
      .catch(() => renderFacets(null));
  }

  function loadRoles(want) {
    const sel = q("#a-role");
    const wrap = q("#a-role-wrap");
    if (!picked) { wrap.classList.remove("on"); sel.innerHTML = ""; return; }
    wrap.classList.add("on");
    sel.innerHTML = '<option value="any">Loading roles…</option>';
    const ur = contextParams();
    ur.set("player", picked.gsis_id);
    ur.set("position", picked.position || "");
    backend("/api/player_roles?" + ur).then(d => {
      const list = d.roles || d;                     // tolerate the older shape
      sel.innerHTML = list.map(r =>
        `<option value="${r.key}">${esc(r.label)}${r.n ? " (" + r.n + ")" : ""}</option>`).join("") +
        nflActionOptions();
      sel.value = want && [...sel.options].some(o => o.value === want) ? want
        : d.default && list.some(r => r.key === d.default) ? d.default : "any";
      facets = {}; excl = new Set();
      loadSubs();
      run();                                          // land on the position's default view
    }).catch(() => { sel.innerHTML = '<option value="any">Any</option>'; });
  }

  // the NFL Pro actions that fit the picked player's side of the ball
  function nflActionOptions() {
    if (!picked || !picked.nfl_id) return "";
    const side = DEF_POS.test(picked.position || "") ? "def" : "off";
    const fit = NFL_ACTIONS.filter(a => (!a.side || a.side === side)
      && (!a.pos || a.pos.test(picked.position || "")));
    // an unlabelled group: the panel's menu draws it as a divider
    return `<optgroup label="">` + fit.map(a =>
      `<option value="${a.key}">${esc(a.label)}</option>`).join("") + `</optgroup>`;
  }
  function nflAction() {
    const r = picked && q("#a-role").value;
    return r && r.startsWith("nfl:") ? NFL_ACTION_BY[r] || null : null;
  }
  // does the picked player fit this filter's player key? a corner is no route runner
  function nflWho(d) {
    if (!picked || !picked.nfl_id || !d.who) return false;
    const def = DEF_POS.test(picked.position || "");
    return d.who === "defenderId" ? def : d.who === "nflId" ? true : !def;
  }

  function playerLookup(term) {
    const menu = q("#a-pmenu");
    if (!term || term.length < 2) return closeMenu();
    backend("/api/players?q=" + encodeURIComponent(term)).then(list => {
      if (!list || !list.length) return closeMenu();
      menu.hidden = false;
      menu.innerHTML = list.map((p, i) => `
        <div data-i="${i}">
          <span class="who">${esc(p.name)}</span>
          <span class="meta2">${esc([p.position, p.team].filter(Boolean).join(" · "))}${
            p.plays ? " · " + p.plays + " plays" : ""}</span>
        </div>`).join("");
      menu.querySelectorAll("div").forEach(el => el.onclick = () => {
        picked = list[+el.dataset.i];
        closeMenu();
        showPicked();
        loadRoles();
        run();
      });
    }).catch(closeMenu);
  }

  /* The page always shares the screen: NFL Pro lays out in whatever width the
     panel leaves it. Wide is the one exception -- it takes everything but the
     tray strip, so there is no remainder worth reflowing into; the page keeps
     its own full-width layout underneath and the tray is the way back. */
  function applyPush() {
    const root = document.documentElement;
    root.classList.remove("a22push");
    root.style.removeProperty("--a22w");
    if (p.classList.contains("hid") || p.classList.contains("wide")) return;
    root.style.setProperty("--a22w", Math.round(p.getBoundingClientRect().width) + "px");
    root.classList.add("a22push");
  }
  window.addEventListener("resize", () => { applyPush(); relayoutSoon(); });

  tab.onclick = () => { p.classList.toggle("hid"); applyPush(); };
  q("#all22-x").onclick = () => { p.classList.add("hid"); applyPush(); };

  function setWide(on) {
    preservePlayback(() => {
      p.classList.toggle("wide", on);
      const b = q("#all22-w");
      // the click can land on the <svg> or its <path>, so never read e.target here
      b.innerHTML = svg(on ? ICON.narrow : ICON.wide);
      b.title = on ? "Narrow the panel" : "Widen the panel";
      b.setAttribute("aria-label", b.title);
      applyPush();
      relayoutSoon();
    });
    drawAngles();
    drawOnField();
  }
  /* ---------------- filter dictionary ----------------
     Every filterable option with nflverse's own definition and what the column
     really holds in this index. Definitions ship with the extension; the values
     are read from the index, so they describe the data you actually have.

     Profiles load only for the rows on screen. Profiling all 275 up front costs
     about four seconds of table scans, which is a long time to stare at a
     spinner for a reference you are going to scroll a screenful of. */

  /* Where each option sits: a tab, then a section inside it. Rules run in
     order and the first match wins, so the unambiguous families (kickoff_,
     punt_...) go first. NFL Pro's filters are matched as "nfl:<key>", the way
     "Any filter" keys them. A column no rule names -- a field nflverse adds
     next season -- lands in "Other" rather than vanishing; the category test
     (tests/test_dict_cats.mjs) fails until it is given a home. */
  const DICT_TABS = [["all", "All"], ["off", "Offense"], ["def", "Defense"],
    ["st", "Special teams"], ["sit", "Game state"], ["res", "Result"], ["game", "Team & game"]];
  const DICT_RULES = [
    ["st", "Kickoffs", /^(kickoff_|own_kickoff_|lateral_kickoff_)|^home_opening_kickoff$/],
    ["st", "Punts", /^(punt_|punter_|lateral_punt_)/],
    ["st", "Field goals & tries", /^(field_goal_|kick_distance|extra_point_|kicker_|blocked_player_|two_point_|defensive_two_point_|defensive_extra_point_)/],
    ["st", "Returns", ["return_team", "return_yards", "lateral_return", "touchback"]],
    ["st", "General", ["special_teams_play", "st_play_type", "special"]],

    ["off", "Passing", /^(passer|passing_|lateral_sack_)|^(qb_dropback|pass_attempt|pass|complete_pass|incomplete_pass|pass_length|pass_location|air_yards|qb_scramble|qb_spike|cp|cpoe|xpass|pass_oe|time_to_throw|read_thrown|is_qb_out_of_pocket|is_throw_away|is_interception_worthy|is_qb_fault_sack|ngs_air_yards|nfl:dropbackTimeType)$/],
    ["off", "Play design", ["is_play_action", "is_rpo", "is_screen_pass", "is_trick_play"]],
    ["off", "Receiving", /^(receiver|receiving_|lateral_receiv|xyac_)|^(yards_after_catch|lateral_reception|is_catchable_ball|is_contested_ball|is_created_reception|is_drop|route|nfl:routeType|nfl:receiverAlignment|nfl:rec_coverageType|nfl:rec_motion|nfl:separationType|nfl:targetLocation)$/],
    ["off", "Rushing", /^(rusher|rushing_|lateral_rush)|^(rush_attempt|rush|run_location|run_gap|qb_kneel|is_qb_sneak|nfl:maxSpeedType)$/],
    ["off", "Formation & personnel", ["shotgun", "no_huddle", "is_no_huddle", "is_motion", "offense_formation",
      "offense_personnel", "n_offense", "n_offense_backfield", "qb_location", "starting_hash",
      "offense_players", "offense_names", "offense_numbers", "offense_positions",
      "nfl:offensePersonnel", "nfl:rb", "nfl:te", "nfl:wr"]],
    ["off", "Primary player", ["name", "id", "jersey_number", "fantasy_player_name", "fantasy_player_id", "fantasy", "fantasy_id"]],

    ["def", "Pass rush", /^@(sack|qb_hit)_|^(sack|qb_hit|n_blitzers|n_pass_rushers|number_of_pass_rushers|was_pressure|nfl:pressure|nfl:passRushSnap|nfl:def_pressure|nfl:turnoversCausedByPressure)$/],
    ["def", "Coverage", /^@pass_defense_|^(defense_man_zone_type|defense_coverage_type|nfl:teamCoverageTypeManZone|nfl:teamCoverageTypeSafetyShell|nfl:coverageSnap|nfl:def_coverageType|nfl:targetNearestDefender|nfl:receptionNearestDefender|nfl:receivingTDNearestDefender)$/],
    ["def", "Tackling & run defense", /^@(solo_tackle|assist_tackle|tackle_with_assist|tackle_for_loss)_|^(tackled_for_loss|solo_tackle|assist_tackle|tackle_with_assist|nfl:runStuff|nfl:runDefenseSnap|nfl:def_runStuff|nfl:tackleStop|nfl:hustleStop)$/],
    ["def", "Takeaways", /^(@forced_fumble_|@fumble_recovery_|interception_player|lateral_interception_)|^interception$/],
    ["def", "Personnel & alignment", ["defense_personnel", "n_defense", "defenders_in_box", "n_defense_box",
      "defense_players", "defense_names", "defense_numbers", "defense_positions", "nfl:personnel", "nfl:linedUpInTheBox", "nfl:def_alignment", "nfl:defensiveSnap"]],

    ["sit", "Down & distance", ["down", "ydstogo", "goal_to_go", "yardline_100", "yrdln", "side_of_field"]],
    ["sit", "Clock & timeouts", /^(qtr|time|game_half|quarter_seconds_remaining|half_seconds_remaining|game_seconds_remaining|quarter_end|play_clock|timeout|timeout_team|.*_timeouts_remaining)$/],
    ["sit", "Score", /^(score_differential|score_differential_post|(home|away|posteam|defteam)_score|(posteam|defteam)_score_post|total_(home|away)_score)$/],
    ["sit", "Win probability & expected points", /^(wp|def_wp|home_wp|away_wp|home_wp_post|away_wp_post|vegas_wp|vegas_home_wp|ep|no_score_prob|opp_fg_prob|opp_safety_prob|opp_td_prob|fg_prob|td_prob|safety_prob)$|^total_(home|away)_/],
    ["sit", "Drive & series", /^(drive|fixed_drive|series)|^ydsnet$/],

    ["res", "EPA & success", /^(epa|qb_epa|air_epa|yac_epa|comp_air_epa|comp_yac_epa|success|wpa|air_wpa|yac_wpa|comp_air_wpa|comp_yac_wpa|vegas_wpa|vegas_home_wpa)$/],
    ["res", "First downs & conversions", /^(first_down|third_down_|fourth_down_)/],
    ["res", "Scoring", /^(touchdown|pass_touchdown|rush_touchdown|return_touchdown|td_team|td_player_|sp|safety|safety_player_)/],
    ["res", "Fumbles", /^(@fumbled_|fumble$|fumble_lost|fumble_forced|fumble_not_forced|fumble_out_of_bounds)/],
    ["res", "Penalties", /^penalty/],
    ["res", "The play", ["play_type", "play_type_nfl", "play", "desc", "yards_gained", "end_yard_line", "end_clock_time",
      "out_of_bounds", "aborted_play", "replay_or_challenge", "replay_or_challenge_result", "play_deleted", "lateral_recovery"]],

    ["game", "Teams", ["posteam", "defteam", "home_team", "away_team", "posteam_type", "possession_team",
      "home_coach", "away_coach"]],
    ["game", "Schedule", ["season", "season_type", "week", "game_date", "div_game", "start_time", "time_of_day"]],
    ["game", "Venue & weather", ["location", "game_stadium", "stadium", "stadium_id", "temp", "wind", "weather", "roof", "surface"]],
    ["game", "Lines & final score", ["spread_line", "total_line", "result", "total"]],
    ["game", "IDs", ["play_id", "game_id", "old_game_id", "order_sequence", "nflverse_game_id", "nflverse_play_id",
      "ftn_game_id", "ftn_play_id", "nfl_api_id", "players_on_play", "date_pulled"]],
  ];
  const DICT_OTHER = ["game", "Other"];
  // every section in the order the list shows them: by tab, then as the rules
  // name them (special teams match first but list third), "Other" last
  const DICT_SECS = DICT_TABS.flatMap(([id]) => DICT_RULES.filter(r => r[0] === id).map(r => [r[0], r[1]]))
    .concat([DICT_OTHER]);
  function dictPlace(key) {
    for (const [tab, sec, t] of DICT_RULES)
      if (Array.isArray(t) ? t.includes(key) : t.test(key)) return [tab, sec];
    return DICT_OTHER;
  }
  /* ---- end of the category map ---- */

  const PROF = new Map();          // col -> profile, once fetched
  let dictObs = null, dictQueue = new Set(), dictTimer = null;
  // A profile is only true of the scope it was read under, so the cache is
  // dropped whenever that scope moves -- otherwise picking a player leaves
  // every row still quoting the whole index.
  let profScope = null;
  function profReset(scope) {
    if (scope === profScope) return;
    profScope = scope;
    PROF.clear();
    dictQueue.clear();
    const list = q("#a-dlist");
    if (!list) return;           // run() can fire before the dictionary exists
    list.querySelectorAll(".dent").forEach(el => {
      // NFL Pro rows list their own values and are never profiled: left alone,
      // not blanked to a "…" nothing would ever fill in again
      if (nflDef(el.dataset.k)) return;
      el.querySelector(".dval").innerHTML = '<span class="dn">…</span>';
      // the lag note names the weeks the new scope is missing, so it moves too
      const n = lateNote(el.dataset.k), late = el.querySelector(".late");
      if (late && n) { late.textContent = n.text; late.classList.toggle("warn", !!n.warn); }
    });
    // Re-observing makes the observer report whatever is on screen right now,
    // so only those rows are profiled again. Requeuing all 275 here would cost
    // the four seconds of scans the lazy load exists to avoid -- and would pay
    // it again on every filter change.
    if (dictObs) {
      dictObs.disconnect();
      list.querySelectorAll(".dent").forEach(el => dictObs.observe(el));
    }
  }

  function dictFlush() {
    clearTimeout(dictTimer);
    dictTimer = setTimeout(() => {
      const scope = scopeParams().toString();
      profReset(scope);
      const want = [...dictQueue].filter(c => !PROF.has(c)).slice(0, 40);
      dictQueue.clear();
      if (!want.length) return;
      backend("/api/values?" + scope + "&cols=" + want.map(encodeURIComponent).join(",")).then(r => {
        if (scope !== profScope) return;      // the scope moved while we waited
        Object.entries(r.profiles || {}).forEach(([k, v]) => PROF.set(k, v));
        want.forEach(paintDictRow);
      }).catch(() => {});
    }, 90);
  }

  // what the dictionary is showing: a tab, maybe one section of it, and the
  // one row whose filter editor is open ({ k, op, val }), if any
  let dictTab = "all", dictSec = null, dictEd = null;
  const DICT_TAB_NAME = Object.fromEntries(DICT_TABS);
  const PLUS = "M5 12h14M12 5v14", MINUS = "M5 12h14";
  const DICT_NUMOPS = [["gte", "≥"], ["gt", ">"], ["eq", "="], ["lte", "≤"], ["lt", "<"], ["notnull", "is set"]];
  const DICT_TEXTOPS = [["eq", "="], ["like", "contains"], ["notnull", "is set"]];

  // rows are found by walking, not by selector: keys like "nfl:pressure" and
  // "@sack_player_name" would each need escaping
  const dictRow = k => [...p.querySelectorAll("#a-dlist .dent")].find(el => el.dataset.k === k) || null;
  const nActive = k => extra.filter(f => f.col === k).length;
  const actBadge = k => {
    const n = nActive(k);
    return n ? `<span class="dact">${n > 1 ? n + " active" : "active"}</span>` : "";
  };

  function paintDictRow(col) {
    const row = dictRow(col);
    const d = PROF.get(col);
    if (!row || !d) return;
    const box = row.querySelector(".dval");
    box.innerHTML = profileHtml(d);
    wireValueClicks(box, col, v => dictToggle(col, { val: v }));
    if (!row.querySelector(".ddesc").textContent && d.desc)
      row.querySelector(".ddesc").textContent = d.desc;
    row.querySelector(".dkt").textContent =
      (d.kind === "yesno" ? "yes / no" : d.kind === "number" ? "number"
       : d.kind === "list" ? d.distinct + " values" : d.kind === "empty" ? "empty" : "text")
      + (GROUPS[col] ? ` · ${GROUPS[col].members.length} cols` : "");
    // an open editor learns the column's values: a list becomes a menu, a
    // yes/no gets its counts, a number its range
    if (dictEd && dictEd.k === col) dictRowState(col, true);
  }

  const plusHtml = (name, open) =>
    `<button type="button" class="dplus" aria-expanded="${open}" title="${open ? "Close" : "Add a filter"}"` +
    ` aria-label="${open ? "Close the filter for" : "Add a filter on"} ${esc(name)}">${svg(open ? MINUS : PLUS)}</button>`;

  function dictRowHtml(c) {
    const k = c.key, open = !!(dictEd && dictEd.k === k);
    const top = c.nfl
      ? `<span class="dname">${esc(c.name)}</span>
         <span class="dkind"><span class="dactw">${actBadge(k)}</span><span class="src">NFL PRO</span><span class="dkt">${
           esc(c.nfl.group)}${c.nfl.needs ? " · needs a player" : ""}</span></span>`
      : `<span class="dname">${esc(c.name)}</span>
         <span class="dkey">${esc(k)}</span>
         <span class="dkind"><span class="dactw">${actBadge(k)}</span><span class="dkt">${
           BINARY.has(k) ? "yes / no" : c.type === "TEXT" ? "text" : "number"}${
           GROUPS[k] ? ` · ${GROUPS[k].members.length} cols` : ""}</span></span>`;
    const body = c.nfl
      ? `<div class="ddesc">From NFL Pro's film room: one request per search, any season NFL Pro covers.</div>
         <div class="dval">${c.nfl.values.map(([v, l]) => `<b data-v="${esc(v)}">${esc(l)}</b>`).join(" · ")}</div>`
      : `<div class="ddesc">${esc(DESCRIBE[k] || "")}</div>
         ${lateHtml(k)}
         <div class="dval"><span class="dn">…</span></div>`;
    return `<div class="dent${open ? " open" : ""}" data-k="${esc(k)}">
      <div class="dtop">${top}${plusHtml(c.name, open)}</div>${body}${open ? editorHtml(k) : ""}</div>`;
  }

  /* ---- the filter editor inside a row ----
     The control follows the column: Yes / No for a flag, NFL Pro's own values
     for its filters, a comparison and a box for a number, the column's values
     as a menu when it has few enough to list (the profile says so), and a
     box for free text. "is set" needs no value; "contains" always types one. */
  function dictDefaults(k) {
    const d = nflDef(k), prof = PROF.get(k);
    if (d) return { op: "eq", val: d.values[0][0] };
    if (BINARY.has(k)) return { op: "eq", val: "1" };
    if (prof && prof.kind === "list" && prof.values.length) return { op: "eq", val: String(prof.values[0].v) };
    return { op: NUMERIC(k) ? "gte" : "eq", val: "" };
  }

  const dictCanAdd = k => !!dictEd && dictEd.k === k &&
    (!!nflDef(k) || BINARY.has(k) || dictEd.op === "notnull" || String(dictEd.val).trim() !== "");

  function editorHtml(k) {
    const e = dictEd, d = nflDef(k), prof = PROF.get(k);
    const opts = (list, cur) => list.map(([v, l, n]) =>
      `<option value="${esc(v)}"${v === cur ? " selected" : ""}${n ? ` data-n="${esc(n)}"` : ""}>${esc(l)}</option>`).join("");
    let ctl = "", note = "";
    if (d) {
      ctl = `<select data-r="val" aria-label="${esc(d.label)}">${opts(d.values, e.val)}</select>`;
      const h = nflHint(d);
      if (h) note = `<div class="dneed${d.needs && !(picked && nflWho(d)) ? " warn" : ""}">${esc(h)}</div>`;
    } else if (BINARY.has(k)) {
      const n = v => (prof && prof.kind === "yesno" ? nfmt(v === "1" ? prof.yes : prof.no) : "");
      ctl = `<span class="dseg" role="group" aria-label="Yes or no">` + [["1", "Yes"], ["0", "No"]].map(([v, l]) =>
        `<button type="button" class="dsb${e.val === v ? " on" : ""}" data-b="${v}" aria-pressed="${e.val === v}">` +
        `${l}<span class="dn">${n(v)}</span></button>`).join("") + `</span>`;
    } else {
      ctl = `<select data-r="op" aria-label="Comparison">${opts(NUMERIC(k) ? DICT_NUMOPS : DICT_TEXTOPS, e.op)}</select>`;
      const list = prof && prof.kind === "list" && prof.values.length;
      if (e.op === "notnull") {
        // nothing to type
      } else if (list && e.op !== "like") {
        if (!prof.values.some(x => String(x.v) === e.val)) e.val = String(prof.values[0].v);
        ctl += `<select data-r="val" aria-label="Value">${
          opts(prof.values.map(x => [String(x.v), String(x.v), nfmt(x.n)]), e.val)}</select>`;
      } else {
        const ex = prof && prof.values && prof.values.length ? String(prof.values[0].v).slice(0, 24) : "";
        ctl += `<input data-r="val" aria-label="Value" autocomplete="off" value="${esc(String(e.val))}"` +
          ` placeholder="${NUMERIC(k) ? "value" : ex ? "e.g. " + esc(ex) : "text"}">`;
      }
      if (prof && prof.kind === "number")
        ctl += `<span class="dn dhint">range ${esc(sig(prof.min))} … ${esc(sig(prof.max))} · avg ${esc(sig(prof.avg))}</span>`;
    }
    return `<div class="ded">${ctl}<span class="dgrow"></span>
      <button type="button" class="a22b" data-act="cancel">Cancel</button>
      <button type="button" class="a22b pri" data-act="add"${dictCanAdd(k) ? "" : " disabled"}>${svg(PLUS)}Add filter</button>
      ${note}<div class="derr" hidden></div></div>`;
  }

  function wireEditor(el) {
    const ed = el.querySelector(".ded"), k = el.dataset.k;
    if (!ed || !dictEd || dictEd.k !== k) return;
    const add = ed.querySelector('[data-act="add"]');
    const sync = () => { add.disabled = !dictCanAdd(k); };
    ed.querySelectorAll("[data-b]").forEach(b => b.onclick = () => {
      dictEd.val = b.dataset.b;
      ed.querySelectorAll("[data-b]").forEach(x => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
    });
    ed.querySelectorAll("select[data-r]").forEach(s => s.addEventListener("change", () => {
      dictEd[s.dataset.r] = s.value;
      // the comparison decides which value control fits, so it redraws them
      if (s.dataset.r === "op") { dictRowState(k); focusEditor(k, "op"); }
      else sync();
    }));
    const inp = ed.querySelector("input[data-r]");
    if (inp) {
      inp.addEventListener("input", () => { dictEd.val = inp.value; sync(); });
      inp.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();        // the panel's own Enter runs a search
        dictSubmit(k);
      });
    }
    ed.querySelector('[data-act="cancel"]').onclick = () => dictToggle(k);
    add.onclick = () => dictSubmit(k);
  }

  function focusEditor(k, which) {
    const el = dictRow(k), ed = el && el.querySelector(".ded");
    if (!ed) return;
    const f = (which && ed.querySelector(`[data-r="${which}"]`)) || ed.querySelector("input[data-r]")
      || ed.querySelector('select[data-r="val"]') || ed.querySelector('[data-act="add"]');
    if (f) f.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }

  // Bring one row in line with dictEd: its + and its editor. keepFocus puts
  // the caret back where it was, for a redraw the user did not ask for.
  function dictRowState(k, keepFocus) {
    const el = dictRow(k);
    if (!el) return;
    const open = !!(dictEd && dictEd.k === k);
    const a = document.activeElement;
    const had = keepFocus && a && el.contains(a) && a.dataset ? a.dataset.r : null;
    const caret = had && a.tagName === "INPUT" ? a.selectionStart : null;
    el.classList.toggle("open", open);
    el.querySelector(".dplus").outerHTML = plusHtml(el.querySelector(".dname").textContent, open);
    const old = el.querySelector(".ded");
    if (old) old.remove();
    if (open) {
      el.insertAdjacentHTML("beforeend", editorHtml(k));
      wireEditor(el);
      const back = had && el.querySelector(`.ded [data-r="${had}"]`);
      if (back) {
        back.focus({ preventScroll: true });
        if (caret != null && back.setSelectionRange) back.setSelectionRange(caret, caret);
      }
    }
  }

  // The + (or a click on the row, or on one of its values): open this row's
  // editor and close any other; the same again closes it. A value opens it
  // filled in with that value.
  function dictToggle(k, preset) {
    const was = dictEd && dictEd.k;
    if (was === k && !preset) dictEd = null;
    else {
      dictEd = Object.assign({}, was === k ? dictEd : Object.assign({ k }, dictDefaults(k)), preset || {});
      // a picked value wants "=": "is set" takes none, "contains" is for typing
      if (preset && (dictEd.op === "notnull" || dictEd.op === "like")) dictEd.op = "eq";
    }
    if (was && was !== k) dictRowState(was);
    dictRowState(k);
    if (dictEd && dictEd.k === k) focusEditor(k);
  }

  function dictSubmit(k) {
    if (!dictCanAdd(k)) return;
    // a filter belongs to the search, so from a cutup, go back to the search first
    if (cutView) leaveCuts();
    const op = dictEd.op, val = String(dictEd.val).trim();
    const err = addFilter(k, op, val);
    if (err) {
      const box = dictRow(k) && dictRow(k).querySelector(".derr");
      if (box) { box.hidden = false; box.className = "derr" + (err.warn ? " warn" : ""); box.textContent = err.msg; }
      return;
    }
    dictEd = null;
    dictRowState(k);
    const f = extra.find(x => x.col === k && (x.nfl || BINARY.has(k) || (x.op === op && x.val === val)));
    drawDictTray(extra.indexOf(f));
  }

  /* The active filters, at the foot of the dictionary: the same list as the
     Filters strip's "Added" row, redrawn whenever that is (drawChips), so the
     two never disagree. The row badges follow it too. */
  function drawDictTray(fresh) {
    const t = q("#a-dtray");
    if (!t) return;
    p.querySelectorAll("#a-dlist .dent").forEach(el => {
      const w = el.querySelector(".dactw");
      if (w) w.innerHTML = actBadge(el.dataset.k);
    });
    t.hidden = !extra.length;
    if (!extra.length) { t.innerHTML = ""; return; }
    t.innerHTML = `<span class="dtcap">Active filters</span>
      <span class="dtchips fac">${extra.map((f, i) => {
        const txt = esc(colChipText(f));
        return `<span class="chip on${i === fresh ? " fresh" : ""}" data-i="${i}">` +
          `<button type="button" class="inc" title="Remove">${txt}</button>` +
          `<button type="button" class="exc" title="Remove" aria-label="Remove ${txt}">&#10005;</button></span>`;
      }).join("")}</span>
      <button type="button" class="a22b" data-act="clear">Clear</button>
      <button type="button" class="a22b pri" data-act="show">Show plays</button>`;
    // like the Filters strip, both halves of a chip remove it
    const edit = fn => () => { if (cutView) leaveCuts(); fn(); drawChips(); run(); };
    t.querySelectorAll(".chip").forEach(chip => chip.querySelectorAll("button").forEach(b =>
      b.onclick = edit(() => extra.splice(+chip.dataset.i, 1))));
    t.querySelector('[data-act="clear"]').onclick = edit(() => { extra.length = 0; });
    t.querySelector('[data-act="show"]').onclick = () => showDict(false);
  }

  function dictGo(tab, sec) {
    dictTab = tab;
    dictSec = sec;
    drawDict(q("#a-dsearch").value);
    q("#a-dlist").scrollTop = 0;
  }

  // the tabs dim, rather than vanish, when a search finds nothing in them
  function drawDictTabs(total, nTab, searching) {
    const el = q("#a-dtabs"), sl = el.scrollLeft;
    el.innerHTML = DICT_TABS.map(([id, label]) => {
      const n = id === "all" ? total : nTab[id] || 0;
      return `<button type="button" role="tab" class="dtab${id === dictTab ? " on" : ""}${searching && !n ? " dim" : ""}"` +
        ` aria-selected="${id === dictTab}" data-tab="${id}" title="${n} option${n === 1 ? "" : "s"}">${esc(label)}</button>`;
    }).join("");
    el.scrollLeft = sl;
    el.querySelectorAll(".dtab").forEach(b => b.onclick = () => dictGo(b.dataset.tab, null));
  }

  function drawDictSecs(secs, nSec, searching) {
    const el = q("#a-dsecs"), sl = el.scrollLeft;
    el.hidden = dictTab === "all";
    if (el.hidden) { el.innerHTML = ""; return; }
    const n = s => nSec[s[0] + "|" + s[1]] || 0;
    const total = secs.reduce((a, s) => a + n(s), 0);
    el.innerHTML = `<button type="button" class="dsc${dictSec ? "" : " on"}" data-sec="">All<span class="n">${total}</span></button>` +
      secs.filter(s => n(s) || searching || dictSec === s[1]).map(s =>
        `<button type="button" class="dsc${dictSec === s[1] ? " on" : ""}${n(s) ? "" : " dim"}" data-sec="${esc(s[1])}">` +
        `${esc(s[1])}<span class="n">${n(s)}</span></button>`).join("");
    el.scrollLeft = sl;
    el.querySelectorAll(".dsc").forEach(b => b.onclick = () =>
      dictGo(dictTab, b.dataset.sec && b.dataset.sec !== dictSec ? b.dataset.sec : null));
  }

  function drawDict(term) {
    const list = q("#a-dlist");
    const t = (term || "").trim().toLowerCase();
    const all = filterChoices();
    // a search reaches the name, the column, the definition and the section
    const hits = all.filter(c => !t || c.name.toLowerCase().includes(t)
      || c.key.toLowerCase().includes(t) || (DESCRIBE[c.key] || "").toLowerCase().includes(t)
      || (c.nfl && c.nfl.group.toLowerCase().includes(t)) || dictPlace(c.key)[1].toLowerCase().includes(t));
    const at = new Map(), nTab = {}, nSec = {};
    hits.forEach(c => {
      const [tab, sec] = dictPlace(c.key), id = tab + "|" + sec;
      at.set(c.key, id);
      nTab[tab] = (nTab[tab] || 0) + 1;
      nSec[id] = (nSec[id] || 0) + 1;
    });
    const secs = DICT_SECS.filter(([tab]) => dictTab === "all" || tab === dictTab);
    if (dictSec && !secs.some(s => s[1] === dictSec)) dictSec = null;
    drawDictTabs(hits.length, nTab, !!t);
    drawDictSecs(secs, nSec, !!t);

    let shown = 0, html = "";
    secs.forEach(([tab, sec]) => {
      if (dictSec && dictSec !== sec) return;
      const rows = hits.filter(c => at.get(c.key) === tab + "|" + sec)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!rows.length) return;
      shown += rows.length;
      const label = dictTab === "all" ? DICT_TAB_NAME[tab] + " · " + sec : sec;
      html += `<div class="dsh"><span>${esc(label)}</span><span class="n">${rows.length}</span></div>` +
        rows.map(dictRowHtml).join("");
    });
    p.querySelector(".dcount").textContent = (t ? shown + " of " + all.length : shown) + " options";

    if (!shown) {
      // say where the matches are rather than "nothing" while a tab hides them
      const inTab = dictSec ? (nTab[dictTab] || 0) : 0;
      const where = dictSec && inTab ? [dictTab, DICT_TAB_NAME[dictTab], inTab]
        : dictTab !== "all" && hits.length ? ["all", "All", hits.length] : null;
      list.innerHTML = `<div class="dempty">${where
        ? `Nothing in ${esc(dictSec || DICT_TAB_NAME[dictTab])} matches. ` +
          `<button type="button" class="dlink" data-tab="${where[0]}">Show ${where[2]} in ${esc(where[1])}</button>`
        : "Nothing matches."}</div>`;
      const go = list.querySelector(".dlink");
      if (go) go.onclick = () => dictGo(go.dataset.tab, null);
      dictEd = null;
      return;
    }
    list.innerHTML = html;
    if (dictEd && !dictRow(dictEd.k)) dictEd = null;     // searched out of view

    list.querySelectorAll(".dent").forEach(el => {
      const k = el.dataset.k;
      // a click anywhere on the row opens its editor; the editor's own don't
      el.onclick = e => { if (!e.target.closest(".ded")) dictToggle(k); };
      if (nflDef(k)) wireValueClicks(el.querySelector(".dval"), k, v => dictToggle(k, { val: v }));
      wireEditor(el);
    });

    if (dictObs) dictObs.disconnect();
    dictObs = new IntersectionObserver(ents => {
      let any = false;
      ents.forEach(e => {
        if (!e.isIntersecting) return;
        const k = e.target.dataset.k;
        if (nflDef(k)) return;          // NFL Pro's values are listed, not profiled
        if (PROF.has(k)) return paintDictRow(k);
        dictQueue.add(k);
        any = true;
      });
      if (any) dictFlush();
    }, { root: list, rootMargin: "200px" });
    list.querySelectorAll(".dent").forEach(el => {
      if (nflDef(el.dataset.k)) return;
      dictObs.observe(el);
      if (PROF.has(el.dataset.k)) paintDictRow(el.dataset.k);
    });
  }

  function showDict(on) {
    q("#a-dict").hidden = !on;
    q("#a-body").hidden = on;
    closeSel();
    dictEd = null;                  // an editor left open does not come back next time
    if (on) {
      drawDict(q("#a-dsearch").value);
      drawDictTray();
      q("#a-dsearch").focus();
    } else if (dictObs) {
      dictObs.disconnect();
    }
  }

  q("#all22-d").onclick = () => showDict(q("#a-dict").hidden);
  let dsTimer = null;
  q("#a-dsearch").addEventListener("input", e => {
    clearTimeout(dsTimer);
    const v = e.target.value;
    dsTimer = setTimeout(() => drawDict(v), 120);
  });

  q("#all22-w").onclick = () => setWide(!p.classList.contains("wide"));
  q("#all22-tray").onclick = () => setWide(false);

  // Fills the season/week/team menus from the index. Runs once at load and
  // again whenever the offscreen document swaps in a newer index, so it only
  // ever adds options that are not there yet -- the user's selection stays.
  function loadMeta() {
    return backend("/api/meta").then(m => {
      EMPTY = m.empty || {};
      const add = (sel, vals) => {
        const have = new Set([...q(sel).options].map(o => o.value));
        vals.forEach(v => { if (!have.has(String(v)))
          q(sel).insertAdjacentHTML("beforeend", `<option>${v}</option>`); });
      };
      add("#a-season", m.seasons);
      add("#a-week", m.weeks);
      add("#a-team", m.teams);
      setLate(m.late);
      return m;
    });
  }

  /* ---------------- columns that arrive after the play ----------------
     nflverse's play-by-play lands within hours of a game. FTN's charting layer
     is charted by hand and reaches the index days later, and the silence is the
     trap: "Play action: Yes" over the newest week returns nothing, which reads
     as "it never happened" rather than "nobody has charted it yet". So every
     place one of these columns is picked -- the filter hint, the dictionary,
     the empty result -- says where the charting stops and when the next drop
     is due. The backend measures the coverage; the weekday is the source's own
     published cadence (nflreadr: charted within 48 hours of each game, so a
     week is complete once Monday night is in). */
  const LATEOF = new Map();        // column -> /api/meta's entry for its source

  function setLate(late) {
    LATEOF.clear();
    (late || []).forEach(s => s.cols.forEach(c => LATEOF.set(c, s)));
  }

  /* Does what the user is looking at reach the weeks the source has not charted?
     Filtering 2025 while 2026 waits on FTN is not worth a warning -- 2025 is
     complete, and a banner that cries on every view is one nobody reads. */
  function scopeReachesGap(s) {
    const season = Number(q("#a-season").value);
    if (!season) return true;                  // every season, the gap included
    if (season !== s.season) return season > s.season;
    const week = Number(q("#a-week").value);   // "Any" is ""  ->  0
    return !week || week >= s.week;
  }

  // null for a column that arrives with the play, which is nearly all of them
  function lateNote(col) {
    const s = LATEOF.get(col);
    if (!s) return null;
    const at = `${s.season} week ${s.week}`;
    const next = s.next || `new weeks usually land ${s.weekday}`;
    if (s.games && s.charted >= s.games)
      return { text: `${s.label} · complete through ${at} · ${next}` };
    if (!scopeReachesGap(s))
      return { text: `${s.label} · ${s.how || "charted by hand"} · ${next}` };
    if (s.charted)
      return { warn: true,
               text: `${s.label} has ${s.charted} of ${s.games} games in ${at} so far. ${s.note}` };
    return { warn: true, text: `Not charted yet for ${at}` +
      (s.through ? ` — ${s.label} stops at ${s.through.season} week ${s.through.week}. `
                 : `. `) + s.note };
  }
  loadMeta().then(m => {
    // loading is done; replace whatever progress text was left on screen
    const st = q("#all22-st");
    st.dataset.loaded = "1";
    const msg = m.columns + " pbp columns and " + NFLF.length +
      " more filters — type in Any filter: tacklers, EPA, routes, coverage, pass rush…";
    // a cutup opened from a link can beat the index here; its line is the one
    // to keep, and search gets this one back when you return to it
    if (cutView && searchState) searchState.st = esc(msg);
    else st.textContent = msg;
    q("#a-season").value = m.seasons[m.seasons.length - 1];
  }).catch(e => { q("#all22-st").innerHTML = `<span style="color:#e0736b">${esc(e.message)}</span>`; });

  /* 0/1 event flags. There is nothing to type and only one sensible operator,
     so the value box and the op menu give way to a Yes / No picker. */
  let BINARY = new Set();
  let DESCRIBE = {};         // nflverse's own wording, shipped with the extension
  /* 0/1 flags the backend measured to be exactly "the merged column is set" --
     fumble_forced asks nothing that Forced fumble does not. Hidden rather than
     renamed: two names for one question is the confusion. */
  let REDUNDANT = new Set();
  let COLTYPE = {};
  let COLLIST = [];          // offered in the menu: merged columns, no raw slots
  /* season -> columns with no value at all that season (nflverse publishes
     participation only after the Super Bowl). "Any filter" and the dictionary
     leave those out for the selected season rather than offer a filter that
     cannot match; another season brings them back. */
  let EMPTY = {};
  function colVisible(key) {
    const e = EMPTY[q("#a-season").value];
    if (!e || !e.length) return true;
    const gone = colVisible.cache && colVisible.cache.e === e ? colVisible.cache.set
      : (colVisible.cache = { e, set: new Set(e) }).set;
    const g = GROUPS[key];
    return g ? g.members.some(m => !gone.has(m)) : !gone.has(key);
  }
  // the season's nflverse columns and NFL Pro's filters, as one list
  function filterChoices() {
    return COLLIST.filter(c => colVisible(c.key))
      .concat(NFLF.map(d => ({ key: "nfl:" + d.key, name: d.label, nfl: d })));
  }
  let COLALL = [];           // everything, so a typed-out slot key still resolves
  backend("/api/columns").then(d => {
    (d.groups || []).forEach(g => {
      GROUPS[g.key] = g;
      g.members.forEach(m => {
        // the absorbed full-sack column carries no number; it falls through to
        // the generic rule rather than being labelled a slot it is not
        const n = (m.match(/(?:^|_)(\d+)(?:_|$)/) || [])[1];
        MEMBER[m] = { label: g.label, slot: n || null };
      });
    });
    BINARY = new Set(d.binary || []);
    REDUNDANT = new Set(d.redundant || []);
    DESCRIBE = d.describe || {};
    COLTYPE = Object.assign({}, d.columns);
    Object.values(GROUPS).forEach(g => { COLTYPE[g.key] = g.type; });
    COLALL = Object.keys(COLTYPE)
      .map(k => ({ key: k, name: humanCol(k), type: COLTYPE[k] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // the merged column stands in for its slots; listing both would put
    // "Forced fumble" next to two near-identical rows that search the same data
    COLLIST = COLALL.filter(x => !MEMBER[x.key] && !REDUNDANT.has(x.key));
  }).catch(() => {});

  // The native <datalist> always renders the raw option value next to the label,
  // so nflverse keys leaked through no matter how the label was written. This
  // menu shows only the readable name and keeps the real column out of sight.
  let colPick = null;        // the actual column key behind what is typed

  function colLookup(term) {
    const menu = q("#a-colmenu");
    const t = term.trim().toLowerCase();
    if (!t) { menu.hidden = true; return; }
    // names that start with what you typed first, then the rest, A-Z
    const hits = filterChoices().filter(c =>
      c.name.toLowerCase().includes(t) || c.key.toLowerCase().includes(t)
      || (c.nfl && c.nfl.group.toLowerCase().includes(t)))
      .sort((a, b) => (b.name.toLowerCase().startsWith(t) - a.name.toLowerCase().startsWith(t))
                      || a.name.localeCompare(b.name))
      .slice(0, 14);
    if (!hits.length) { menu.hidden = true; return; }
    menu.hidden = false;
    menu.innerHTML = hits.map((c, i) => `
      <div data-i="${i}">
        <span class="who">${esc(c.name)}</span>
        <span class="meta2">${c.nfl ? (c.nfl.values.length <= 2 && c.nfl.values[0][1] === "Yes" ? "yes / no" : "list")
            + (c.nfl.needs ? " · needs a player" : "")
          : BINARY.has(c.key) ? "yes / no" : c.type === "TEXT" ? "text" : "number"}</span>
      </div>`).join("");
    menu.querySelectorAll("div[data-i]").forEach(el => el.onclick = () => {
      const c = hits[+el.dataset.i];
      colPick = c.key;
      q("#a-col").value = c.name;      // the human name is what stays on screen
      menu.hidden = true;
      syncOpUI(c.key);
      hint(c.key);
    });
  }

  // A binary column has no value to type and no operator worth choosing.
  // An NFL Pro filter takes one of its own values, from a list.
  function syncOpUI(col) {
    const d = nflDef(col);
    const bin = !d && BINARY.has(col);
    q("#a-op").hidden = bin || !!d;
    q("#a-val").hidden = bin || !!d;
    q("#a-bool").hidden = !bin;
    const nv = q("#a-nflv");
    nv.hidden = !d;
    nv.innerHTML = d ? d.values.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("") : "";
  }

  // typing free-text still works: resolve it back to a real column
  function resolveCol() {
    if (colPick) return colPick;
    const t = q("#a-col").value.trim().toLowerCase();
    if (!t) return null;
    const exact = COLALL.find(c => c.name.toLowerCase() === t || c.key.toLowerCase() === t);
    if (exact) return exact.key;
    const nfl = NFLF.find(d => d.label.toLowerCase() === t);
    return nfl ? "nfl:" + nfl.key : null;
  }

  const NUMOPS = ["gt", "gte", "lt", "lte"];

  const nfmt = n => (n == null ? "" : Number(n).toLocaleString());
  /* The hint sits under the filter row and wraps, so it gets the sentence that
     defines the column, not nflverse's caveats -- read_thrown's entry runs 425
     characters. The dictionary shows the whole thing. */
  function oneLine(t) {
    if (!t) return "";
    const cut = t.slice(0, 200);
    const stop = cut.search(/\.(\s|$)/);
    const first = stop > 30 ? cut.slice(0, stop + 1) : cut;
    return first.length < t.length ? first.replace(/\.$/, "") + "…" : first;
  }
  // 3 significant figures is enough to see the shape of a range
  const sig = v => {
    // a merged column's min/max can arrive as text; never assume a number
    const n = typeof v === "number" ? v : Number(v);
    if (v == null || !Number.isFinite(n)) return v == null ? "" : String(v);
    return Math.abs(n) >= 100 || Number.isInteger(n)
      ? Math.round(n).toLocaleString() : Number(n.toPrecision(3)).toString();
  };

  /* One column, rendered from its profile. The shape follows the data: a
     yes/no shows its split, a short enumeration shows every value, a number
     shows its range, free text shows a sample and how much else there is.
     Values carry data-v so they can be clicked into the filter box. */
  function profileHtml(d) {
    if (!d || d.kind === "empty") return '<span class="dn">no values in this selection</span>';
    const val = x => `<b data-v="${esc(String(x.v))}">${esc(String(x.v))}</b>` +
                     `<span class="dn"> ${nfmt(x.n)}</span>`;
    if (d.kind === "yesno")
      return `<b data-v="1">Yes</b><span class="dn"> ${nfmt(d.yes)}</span> · ` +
             `<b data-v="0">No</b><span class="dn"> ${nfmt(d.no)}</span>`;
    if (d.kind === "number")
      return `<span class="dn">range</span> ${sig(d.min)} … ${sig(d.max)}` +
             `<span class="dn"> · avg</span> ${sig(d.avg)}` +
             `<span class="dn"> · ${nfmt(d.distinct)} values</span>`;
    const vs = (d.values || []).map(val).join("<span class=\"dn\"> · </span>");
    const more = d.kind === "text" && d.distinct > (d.values || []).length
      ? `<span class="dn"> · ${nfmt(d.distinct)} distinct in all</span>` : "";
    return vs + more;
  }

  // clicking a value in the hint drops it into the filter; the dictionary
  // passes its own pick, which opens that row's editor with the value in it
  function wireValueClicks(el, col, pick) {
    el.querySelectorAll("b[data-v]").forEach(b => b.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      if (pick) { pick(b.dataset.v); return; }
      if (BINARY.has(col)) { q("#a-bool").value = b.dataset.v; return; }
      q("#a-val").value = b.dataset.v;
      q("#a-op").value = "eq";
    });
  }

  // A late column's note goes on its own line: it is about the selection, not
  // about the column, and it has to survive the hint being rebuilt around it.
  // what an NFL Pro filter will do with the player you have (or have not) picked
  function nflHint(d) {
    if (d.needs && !(picked && nflWho(d)))
      return `${d.label} is about one player's snaps: pick a ${d.who === "defenderId" ? "defensive " : ""}player above.`;
    return d.who && picked && nflWho(d) ? `${d.label}: applies to ${picked.name}.` : "";
  }
  const lateHtml = col => {
    const n = lateNote(col);
    return n ? `<div class="late${n.warn ? " warn" : ""}">${esc(n.text)}</div>` : "";
  };

  // show what a column actually contains, so you are not guessing
  async function hint(col) {
    const h = q("#a-hint");
    const d = nflDef(col);
    if (d) { h.innerHTML = nflHint(d) ? `<span class="m">${esc(nflHint(d))}</span>` : ""; return; }
    if (!col || !COLTYPE[col]) { h.textContent = ""; return; }
    const name = esc(humanCol(col));
    const desc = DESCRIBE[col] ? ` <span class="dn">— ${esc(oneLine(DESCRIBE[col]))}</span>` : "";
    const late = lateHtml(col);
    h.innerHTML = `<span class="m">${name}${desc} · loading…</span>` + late;
    try {
      const d = await backend(
        `/api/values?${scopeParams()}&col=${encodeURIComponent(col)}`);
      h.innerHTML = `<span class="m">${name}${
        d.desc ? ` <span class="dn">— ${esc(oneLine(d.desc))}</span>` : desc} · </span>` +
        `<span class="dval">${profileHtml(d)}</span>` + late;
      wireValueClicks(h, col);
    } catch {
      h.innerHTML = `<span class="m">${name}${desc}</span>` + late;
    }
  }
  let colTimer = null;
  q("#a-col").addEventListener("input", e => {
    colPick = null;
    clearTimeout(colTimer);
    const v = e.target.value;
    colTimer = setTimeout(() => colLookup(v), 120);
  });
  q("#a-col").addEventListener("blur", () => setTimeout(() => {
    q("#a-colmenu").hidden = true;
    const k = resolveCol();
    syncOpUI(k);
    if (k) hint(k);
  }, 180));

  /* ---------------- the measure that picked the play ----------------
     The row has always shown EPA, because EPA is on every play. Whatever else
     you filtered by was invisible: "Air EPA >= 0" returns thirty plays and not
     one of them says what its air EPA was, so the filter can be trusted but not
     read. These carry it onto the row and onto the Sort menu. */
  const NUMERIC = c => COLTYPE[c] === "REAL" || COLTYPE[c] === "INTEGER";

  // "air_epa:desc" -> "air_epa"; the three fixed sorts carry no column
  function sortCol() {
    const v = q("#a-order").value, cut = v.lastIndexOf(":");
    return cut > 0 ? v.slice(0, cut) : null;
  }

  /* Already spelled out by the row template below, so repeating one as a
     measure would print "3&8" and then "Ydstogo 8" beside it. Not a copy of
     CORE in server.py / db.js: that list is what the row CARRIES, this one is
     what it DISPLAYS, and they are free to differ. Sorting by these is still
     worth offering -- longest-to-go first is a real question. */
  const ON_ROW = new Set(["desc", "home_team", "away_team", "week", "qtr", "time",
                          "down", "ydstogo", "epa", "old_game_id", "play_id"]);

  /* An "=" filter and a Yes/No flag already tell you their value -- printing
     "Play action Yes" on every row of a play-action search is noise -- so only
     the filters whose value can still vary are worth the space. The column you
     sorted by always earns its place: it is the one you are reading down. */
  function showCols() {
    const out = [];
    const add = c => { if (c && !ON_ROW.has(c) && !out.includes(c)) out.push(c); };
    extra.forEach(f => {
      if (f.nfl || f.op === "eq" || f.op === "isnull" || BINARY.has(f.col)) return;
      add(f.col);
    });
    const s = sortCol();
    if (s && !ON_ROW.has(s) && !out.includes(s)) out.unshift(s);
    return out.slice(0, 4);          // SHOW_MAX in roles.py / db.js
  }

  /* Sort offers the measures you filtered by, because a range filter is nearly
     always a question about the extremes -- "air EPA >= 0" wants the best ones
     first. Numbers only: ranking by a player name, or by a flag you have
     already pinned to one state, orders nothing. */
  function drawSort() {
    const sel = q("#a-order"), was = sel.value;
    sel.querySelectorAll("option[data-col]").forEach(o => o.remove());
    const seen = new Set(["epa"]);   // EPA high / low are already on the menu
    extra.forEach(f => {
      if (f.nfl || seen.has(f.col) || BINARY.has(f.col) || !NUMERIC(f.col)) return;
      seen.add(f.col);
      const n = esc(humanCol(f.col)), c = esc(f.col);
      sel.insertAdjacentHTML("beforeend",
        `<option data-col="1" value="${c}:desc">${n} high</option>` +
        `<option data-col="1" value="${c}:asc">${n} low</option>`);
    });
    // the sort in use may have just lost the filter that offered it
    sel.value = [...sel.options].some(o => o.value === was) ? was : "game";
  }

  function colChipText(f) {
    const d = nflDef(f.col);
    if (d) return `${d.label}: ${nflValLabel(d, f.val)}`;
    // "Play action: Yes" beats "Play action = 1" in the chip and in the
    // Filters strip, which is the same string
    if (BINARY.has(f.col)) return `${humanCol(f.col)}: ${f.val === "0" ? "No" : "Yes"}`;
    return `${humanCol(f.col)} ${OPSYM[f.op] || f.op} ${f.val || ""}`.trim();
  }

  // Column filters render as chips in the facet panel so every active filter
  // lives in one place. Both halves remove -- unlike a facet chip there is no
  // include/exclude split here.
  function drawChips() {
    drawSort();                 // the sorts on offer follow the filters
    const c = q("#a-colrow");
    c.innerHTML = !extra.length ? "" :
      `<span class="lab">Added</span>` + extra.map((f, i) =>
        `<span class="chip on" data-i="${i}">
           <button class="inc">${esc(colChipText(f))}</button>
           <button class="exc" title="Remove">&#10005;</button>
         </span>`).join("");
    c.querySelectorAll(".chip").forEach(chip =>
      chip.querySelectorAll("button").forEach(b => b.onclick = () => {
        extra.splice(+chip.dataset.i, 1); drawChips(); run();
      }));
    syncPanelVisibility();
    drawDictTray();             // the dictionary's own copy of this list
  }

  /* One way in for a column filter, from the filter row or the dictionary:
     the same checks, and one value per NFL Pro filter or yes/no flag -- a
     second pick replaces the first, since "Play action: Yes" with "Play
     action: No" can only ever match nothing. The same filter twice is added
     once. Returns null once the filter is on and the search is running,
     otherwise { msg, warn } to show where it was asked for. */
  function addFilter(col, op, val) {
    const d = nflDef(col), bin = !d && BINARY.has(col);
    if (!d) {
      if (!COLTYPE[col]) return { msg: `No such column: ${col}` };
      // >, <, >=, <= against a text column silently matches nothing -- catch it here
      if (!bin && COLTYPE[col] === "TEXT" && NUMOPS.includes(op))
        return { warn: true, msg: `${humanCol(col)} is text, so “${OPSYM[op] || op}” matches 0 plays. Use = or contains.` };
    }
    const f = d ? { col, op: "eq", val, nfl: true } : { col, op: bin ? "eq" : op, val };
    if (d || bin) {
      const at = extra.findIndex(x => x.col === col);
      if (at !== -1) extra.splice(at, 1);
    }
    if (!extra.some(x => x.col === f.col && x.op === f.op && x.val === f.val)) extra.push(f);
    drawChips(); run();
    return null;
  }

  q("#a-add").onclick = () => {
    const col = resolveCol();
    if (!col) {
      if (q("#a-col").value.trim())
        q("#a-hint").innerHTML = '<span style="color:#e0736b">Pick a column from the list</span>';
      return;
    }
    const val = nflDef(col) ? q("#a-nflv").value
      : BINARY.has(col) ? q("#a-bool").value : q("#a-val").value.trim();
    const err = addFilter(col, q("#a-op").value, val);
    if (err) {
      const msg = `<span style="color:${err.warn ? "#e0a86b" : "#e0736b"}">${esc(err.msg)}</span>`;
      q("#a-hint").innerHTML = msg;
      // the column's values beside the warning are what show the mismatch, but
      // hint() redraws the whole line, so the warning goes back in front after
      if (err.warn) hint(col).then(() => q("#a-hint").insertAdjacentHTML("afterbegin", msg + " "));
      return;
    }
    q("#a-col").value = ""; q("#a-val").value = ""; colPick = null;
    syncOpUI(null);
    q("#a-hint").textContent = "";
  };

  // current result set + selection, shared by clicks and the keyboard
  let lastRows = [], selIdx = -1, lastShown = [];
  let nflActive = null;            // the NFL Pro answer the current list is under
  // the play on screen, which outlives a re-run search or a reordered cutup
  let curRow = null;
  // saved plays (see "saved plays" below); filled from chrome.storage at load
  let NOTES = {}, CUTS = {}, lastCut = null, cutView = null, saveOpen = false;
  let noteOpen = false;            // the note box, opened by its header button or E

  /* Selection is coalesced: while a clip is loading, further selections only
     move the highlight, and when the load finishes the LATEST selection is
     fetched. Holding "n" through twenty plays costs two requests, not twenty,
     and a slow response for play 5 can never land on top of play 9. */
  let fetching = false, wanted = -1;
  function selectPlay(i) {
    const row = lastRows[i];
    if (!row) return;
    selIdx = i;
    curRow = row;
    drawNote();
    const res = q("#all22-res");
    res.querySelectorAll(".row").forEach(x => x.classList.remove("on"));
    const el = res.querySelector(`.row[data-i="${i}"]`);
    if (el) { el.classList.add("on"); el.scrollIntoView({ block: "nearest" }); }
    q("#all22-st").textContent = "loading clip…";
    wanted = i;
    if (!fetching) drain();
  }
  async function drain() {
    fetching = true;
    try {
      while (wanted !== -1) {
        const i = wanted; wanted = -1;
        const row = lastRows[i];
        if (!row) continue;
        try {
          const pl = await clipFor(row);
          if (wanted !== -1) continue;        // superseded while loading; do not mount
          mount(pl);
          drawOnField();
          q("#all22-st").textContent =
            pl.map(x => x.videoView).join(" + ") + " · " + row.old_game_id + "/" + row.play_id;
        } catch (e) {
          if (wanted !== -1 && !(e && e.api)) continue;
          drawOnField();                      // not the last play's players
          const dead = e && e.api && (e.status === 401 || e.status === 403);
          q("#all22-st").innerHTML =
            `<span style="color:${dead ? "#e0736b" : "#e0a86b"}">${esc(e.message || String(e))}</span>`;
          if (dead) wanted = -1;              // nothing further will succeed this session
        }
      }
    } finally {
      fetching = false;
    }
  }

  // the measures this search was selected by, beside the EPA that is always
  // there. NULL prints as "--": the play has no such measure, which is a
  // different answer from zero and the row should not pretend otherwise.
  function rowHtml(r, i) {
    const k = pkey(r), n = NOTES[k];
    const inCut = cutView && cutView !== "list";
    const measures = lastShown.map(c =>
      `<span class="sv">${esc(humanCol(c))} ${r[c] == null ? "--"
        : esc(NUMERIC(c) ? sig(r[c]) : String(r[c]))}</span> · `).join("");
    const ctl = !inCut ? "" :
      `<span class="rctl">` +
      `<button data-mv="-1" title="Move up"${i ? "" : " disabled"}>↑</button>` +
      `<button data-mv="1" title="Move down"${i + 1 < lastRows.length ? "" : " disabled"}>↓</button>` +
      `<button data-rm="1" title="Remove from this cutup">✕</button></span>`;
    const star = !inCut && savedIn(k).length ? '<span class="star" title="In a cutup">★</span> ' : "";
    return `<div class="row${i === selIdx ? " on" : ""}" data-i="${i}">${ctl}
        <div>${star}${esc((r.desc || "").slice(0, 150))}</div>
        <div class="m"${r.nflOnly ? ' title="Newer than the play index: no EPA or charting yet"' : ""}>${esc(r.away_team)} @ ${esc(r.home_team)} · wk ${esc(String(r.week))} · Q${esc(String(r.qtr))} ${esc(r.time || "")} ·
          ${r.down ? esc(String(r.down)) + "&amp;" + esc(String(r.ydstogo)) : "--"} ·
          <span class="${r.epa > 0 ? "pos" : "neg"}">EPA ${r.epa == null ? "--" : (+r.epa).toFixed(2)}</span> ·
          ${measures}${esc(k)}</div>
        ${n ? `<div class="nt">${esc(n.t)}</div>` : ""}
      </div>`;
  }
  function wireRow(el) {
    const i = +el.dataset.i;
    el.onclick = () => selectPlay(i);
    el.querySelectorAll(".rctl button").forEach(b => b.onclick = e => {
      e.stopPropagation();
      if (b.dataset.rm) removeFromCut(i); else moveInCut(i, +b.dataset.mv);
    });
  }
  function drawRows() {
    const res = q("#all22-res");
    res.innerHTML = lastRows.map(rowHtml).join("");
    res.querySelectorAll(".row").forEach(wireRow);
  }
  // a note or a save changed one play: redraw just its rows, not the list
  function refreshRow(k) {
    q("#all22-res").querySelectorAll(".row").forEach(el => {
      const i = +el.dataset.i, r = lastRows[i];
      if (!r || pkey(r) !== k) return;
      const t = $("div");
      t.innerHTML = rowHtml(r, i);
      const nu = t.firstElementChild;
      el.replaceWith(nu);
      wireRow(nu);
    });
  }

  /* ---------------- saved plays ----------------
     A note belongs to a play, not to a cutup: it shows wherever that play turns
     up. A cutup is a named, ordered list of plays, each kept as a copy of its
     search row -- everything clipFor() needs -- so it plays back without a
     search and survives the index being rebuilt. Both live in chrome.storage
     through iso.js and never leave the machine, except in a link the user
     chooses to copy, which carries only play ids, the name and the notes. */
  const pkey = r => `${r.old_game_id}/${r.play_id}`;
  const SNAP = ["play_id", "old_game_id", "season", "season_type", "week", "week_slug",
                "home_team", "away_team", "posteam", "defteam", "qtr", "time", "down",
                "ydstogo", "desc", "play_type", "epa"];
  const snap = r => Object.fromEntries(SNAP.map(c => [c, r[c] ?? null]));
  const cutList = () => Object.values(CUTS).sort((a, b) => b.at - a.at);
  const savedIn = k => cutList().filter(c => c.plays.some(r => pkey(r) === k));
  const saveCut = c => post("/api/cutup", { cutup: c })
    .catch(() => flash("could not save — reload NFL Pro"));
  function setLastCut(id) {
    lastCut = id;
    post("/api/prefs", { lastCut: id }).catch(() => {});
  }
  function newCut(name, plays) {
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const c = { id, name: String(name || "").trim().slice(0, 80) || "Untitled cutup",
                at: Date.now(), plays: plays || [] };
    CUTS[id] = c;
    saveCut(c);
    setLastCut(id);
    return c;
  }
  // put a play in or take it out of one cutup; returns whether it is now in
  function toggleIn(id, row, on) {
    const c = CUTS[id];
    if (!c || !row) return false;
    const k = pkey(row), at = c.plays.findIndex(r => pkey(r) === k);
    if (on === undefined) on = at === -1;
    if (on && at === -1) c.plays.push(snap(row));
    if (!on && at !== -1) c.plays.splice(at, 1);
    c.at = Date.now();
    saveCut(c);
    setLastCut(id);
    afterCutChange(k);
    return on;
  }
  function afterCutChange(k) {
    drawSaveBtn();
    if (saveOpen) drawSaveMenu();
    if (cutView === "list") drawLibrary();
    else if (cutView) syncCutRows();
    else if (k) refreshRow(k);
  }
  // S: the play on screen into (or back out of) the cutup used last
  function quickSave() {
    if (!curRow) { flash("select a play first"); return; }
    const c = CUTS[lastCut] || newCut("My cutup");
    const on = toggleIn(c.id, curRow);
    flash((on ? "saved to " : "removed from ") + c.name);
  }

  /* -- note box: under the angle buttons, for the play on screen. Closed until
        its header button (or E) opens it; once open it follows you from play to
        play until closed, so annotating a reel is not a click per play. -- */
  let noteTimer = null, noteFor = null;
  function drawNote() {
    const bar = q("#all22-note");
    if (curRow) {
      const k = pkey(curRow), tx = q("#a-notetx");
      if (noteFor !== k) {
        flushNote();                     // the previous play's unsaved typing
        noteFor = k;
        tx.value = (NOTES[k] && NOTES[k].t) || "";
      }
    }
    bar.hidden = !(curRow && noteOpen);
    if (!bar.hidden) growNote();
    drawSaveBtn();
    drawNoteBtn();
    if (saveOpen) drawSaveMenu();
  }
  function drawNoteBtn() {
    const b = q("#a-notebtn");
    const has = !!(curRow && NOTES[pkey(curRow)]);
    b.disabled = !curRow;
    b.classList.toggle("has", has);
    b.classList.toggle("open", !!(curRow && noteOpen));
    b.title = !curRow ? "Note on this play (pick a play first)"
      : noteOpen ? "Close the note (Esc)" : has ? "This play has a note (E)" : "Note on this play (E)";
  }
  function setNote(open, focus) {
    if (!open) flushNote();
    noteOpen = !!open;
    drawNote();
    if (noteOpen && focus && curRow) {
      const tx = q("#a-notetx");
      tx.focus();
      tx.setSelectionRange(tx.value.length, tx.value.length);
    }
  }
  q("#a-notebtn").onclick = () => setNote(!noteOpen, !noteOpen);
  function growNote() {
    const tx = q("#a-notetx");
    tx.style.height = "30px";
    tx.style.height = Math.min(120, Math.max(30, tx.scrollHeight + 2)) + "px";
  }
  function saveNote() {
    noteTimer = null;
    const k = noteFor;
    if (!k) return;
    const t = q("#a-notetx").value;
    if ((NOTES[k] ? NOTES[k].t : "") === t) return;
    if (t.trim()) NOTES[k] = { t, at: Date.now() }; else delete NOTES[k];
    post("/api/note", { key: k, text: t }).catch(() => flash("note not saved — reload NFL Pro"));
    drawNoteBtn();
    if (cutView === "list") drawLibrary(); else refreshRow(k);
  }
  function flushNote() {
    if (!noteTimer) return;
    clearTimeout(noteTimer);
    saveNote();
  }
  (function wireNote() {
    const tx = q("#a-notetx");
    tx.addEventListener("input", () => {
      growNote();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(saveNote, 400);
    });
    tx.addEventListener("blur", flushNote);
    tx.addEventListener("keydown", e => {
      // typing is not a shortcut: keep NFL's own key handlers out of it too
      e.stopPropagation();
      if (e.key === "Escape") { tx.blur(); setNote(false); }
    });
  })();

  /* -- save menu: tick the cutups this play belongs in, or start one -- */
  function drawSaveBtn() {
    const b = q("#a-save");
    const n = curRow ? savedIn(pkey(curRow)).length : 0;
    b.disabled = !curRow;
    b.classList.toggle("on", !!n);
    b.title = !curRow ? "Save to a cutup (pick a play first)"
      : n ? `In ${n} cutup${n > 1 ? "s" : ""} (S saves to the last one)` : "Save this play to a cutup (S)";
  }
  function setSaveMenu(on) {
    saveOpen = !!on && !!curRow;
    q("#a-savemenu").hidden = !saveOpen;
    if (saveOpen) drawSaveMenu();
  }
  function drawSaveMenu() {
    const m = q("#a-savemenu");
    if (!curRow) { setSaveMenu(false); return; }
    const k = pkey(curRow), list = cutList();
    m.innerHTML = (list.length ? list.map(c =>
        `<label class="ci"><input type="checkbox" data-id="${esc(c.id)}"` +
        `${c.plays.some(r => pkey(r) === k) ? " checked" : ""}>` +
        `<span class="nm">${esc(c.name)}</span><span class="n">${c.plays.length}</span></label>`).join("")
      : '<div class="pe">No cutups yet. Name one below.</div>') +
      `<div class="newc"><input class="a22i" id="a-newcut" placeholder="New cutup" maxlength="80">` +
      `<button class="a22b pri" id="a-newcut-go">Add</button></div>`;
    m.querySelectorAll("input[data-id]").forEach(cb =>
      cb.onchange = () => toggleIn(cb.dataset.id, curRow, cb.checked));
    const inp = m.querySelector("#a-newcut");
    const add = () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      const c = newCut(name);
      toggleIn(c.id, curRow, true);
      flash("saved to " + c.name);
    };
    m.querySelector("#a-newcut-go").onclick = add;
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); add(); }
      if (e.key === "Escape") setSaveMenu(false);
    });
  }
  q("#a-save").onclick = e => { e.stopPropagation(); setSaveMenu(!saveOpen); };
  document.addEventListener("click", e => {
    if (!saveOpen) return;
    const g = q(".hd .sgrp");
    if (g && !g.contains(e.target)) setSaveMenu(false);
  }, true);

  /* -- cutups view: replaces the filters; a cutup's plays become the list,
        so next / previous / auto-play walk it like any search -- */
  let searchState = null;           // the search to put back on the way out
  function enterCuts() {
    if (cutView) return;
    if (!q("#a-dict").hidden) showDict(false);
    searchState = { rows: lastRows, sel: selIdx, shown: lastShown,
                    st: q("#all22-st").innerHTML, top: q("#a-body").scrollTop };
    p.classList.add("cutmode");
  }
  function leaveCuts() {
    if (!cutView) return;
    cutView = null;
    p.classList.remove("cutmode");
    q("#a-cuthead").innerHTML = "";
    q("#all22-c").classList.remove("on");
    const s0 = searchState || { rows: [], sel: -1, shown: [], st: "", top: 0 };
    searchState = null;
    lastRows = s0.rows; lastShown = s0.shown;
    // the play on screen may sit somewhere else in the search, or not at all
    selIdx = curRow ? lastRows.findIndex(r => pkey(r) === pkey(curRow)) : s0.sel;
    q("#all22-st").innerHTML = s0.st;
    drawRows();
    q("#a-body").scrollTop = s0.top;
    if (curList.length) drawAngles();
  }
  function drawLibrary(msg) {
    enterCuts();
    cutView = "list";
    q("#all22-c").classList.add("on");
    q("#a-cuthead").innerHTML =
      `<div class="cbar"><span class="cap">Cutups</span><span class="sp"></span>` +
      `<button class="a22b" data-act="back">Back to search</button></div>` +
      `<div class="cbar"><input class="a22i" id="a-imp" placeholder="Paste a shared cutup link" autocomplete="off">` +
      `<button class="a22b" id="a-imp-go">Import</button></div>`;
    wireCutHead();
    const imp = q("#a-imp");
    const go = () => importLink(imp.value).catch(e =>
      q("#all22-st").innerHTML = `<span style="color:#e0736b">${esc(e.message || String(e))}</span>`);
    q("#a-imp-go").onclick = go;
    imp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") go(); });
    const list = cutList();
    q("#all22-st").innerHTML = msg || (list.length ? list.length + (list.length > 1 ? " cutups" : " cutup") : "");
    const when = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    q("#all22-res").innerHTML = !list.length
      ? `<div class="cempty">No cutups yet. Pick a play in search, then press <b>Save</b> (or <b>S</b>)
         under the video to start one. Each play can carry a note.</div>`
      : list.map(c => {
          const notes = c.plays.filter(r => NOTES[pkey(r)]).length;
          return `<div class="crow" data-id="${esc(c.id)}"><div class="cmain">
              <div class="cname">${esc(c.name)}</div>
              <div class="m">${c.plays.length} play${c.plays.length === 1 ? "" : "s"}` +
              `${notes ? ` · ${notes} note${notes === 1 ? "" : "s"}` : ""} · updated ${esc(when(c.at))}</div></div>
            <span class="cact"><button class="a22b" data-act="link">Copy link</button>` +
            `<button class="a22b" data-act="ren">Rename</button>` +
            `<button class="a22b" data-act="del">Delete</button></span></div>`;
        }).join("");
    q("#all22-res").querySelectorAll(".crow").forEach(el => {
      const c = CUTS[el.dataset.id];
      el.onclick = () => openCut(c.id);
      el.querySelector('[data-act="link"]').onclick = e => { e.stopPropagation(); copyLink(c); };
      el.querySelector('[data-act="ren"]').onclick = e => { e.stopPropagation(); renameInline(el.querySelector(".cname"), c); };
      const del = el.querySelector('[data-act="del"]');
      // two clicks: a cutup is an evening's work, and there is no undo
      del.onclick = e => {
        e.stopPropagation();
        if (!del.classList.contains("warn")) {
          del.classList.add("warn"); del.textContent = "Delete?";
          setTimeout(() => { del.classList.remove("warn"); del.textContent = "Delete"; }, 3000);
          return;
        }
        delete CUTS[c.id];
        post("/api/cutup", { delete: c.id }).catch(() => {});
        if (lastCut === c.id) setLastCut(null);
        drawSaveBtn();
        drawLibrary(`Deleted “${esc(c.name)}”`);
      };
    });
  }
  function renameInline(box, c) {
    box.style.maxWidth = "none";
    box.style.flex = "1";
    box.innerHTML = `<input class="a22i" maxlength="80" style="width:100%">`;
    const inp = box.firstChild;
    inp.value = c.name;
    inp.onclick = e => e.stopPropagation();
    inp.focus(); inp.select();
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (keep && v && v !== c.name) { c.name = v.slice(0, 80); c.at = Date.now(); saveCut(c); }
      cutView === "list" ? drawLibrary() : openCut(c.id);
    };
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    inp.addEventListener("blur", () => finish(true));
  }
  function wireCutHead() {
    const h = q("#a-cuthead");
    h.querySelectorAll('[data-act="back"]').forEach(b => b.onclick = leaveCuts);
    h.querySelectorAll('[data-act="lib"]').forEach(b => b.onclick = () => drawLibrary());
  }
  function openCut(id) {
    const c = CUTS[id];
    if (!c) return drawLibrary();
    enterCuts();
    cutView = id;
    q("#all22-c").classList.add("on");
    setLastCut(id);
    q("#a-cuthead").innerHTML =
      `<div class="cbar"><button class="a22b" data-act="lib">‹ Cutups</button>` +
      `<span class="cn" title="Click to rename">${esc(c.name)}</span><span class="sp"></span>` +
      `<button class="a22b" data-act="link">Copy link</button>` +
      `<button class="a22b" data-act="back">Search</button></div>`;
    wireCutHead();
    const h = q("#a-cuthead");
    h.querySelector('[data-act="link"]').onclick = () => copyLink(c);
    h.querySelector(".cn").onclick = e => renameInline(e.currentTarget, c);
    syncCutRows();
  }
  // the open cutup changed (order, removal, a save from the menu): redraw it
  function syncCutRows() {
    const c = CUTS[cutView];
    if (!c) return drawLibrary();
    lastRows = c.plays.slice();
    lastShown = [];
    selIdx = curRow ? lastRows.findIndex(r => pkey(r) === pkey(curRow)) : -1;
    q("#all22-st").textContent = lastRows.length
      ? `${lastRows.length} play${lastRows.length === 1 ? "" : "s"} · N / P to step through`
      : "Empty. Pick plays in search and press Save (or S) to add them here.";
    drawRows();
    if (curList.length) drawAngles();
  }
  function moveInCut(i, d) {
    const c = CUTS[cutView], j = i + d;
    if (!c || j < 0 || j >= c.plays.length) return;
    [c.plays[i], c.plays[j]] = [c.plays[j], c.plays[i]];
    c.at = Date.now();
    saveCut(c);
    syncCutRows();
  }
  function removeFromCut(i) {
    const c = CUTS[cutView];
    if (!c || !c.plays[i]) return;
    const k = pkey(c.plays[i]);
    c.plays.splice(i, 1);
    c.at = Date.now();
    saveCut(c);
    afterCutChange(k);
  }
  q("#all22-c").onclick = () => cutView ? leaveCuts() : drawLibrary();

  /* -- share links --
     pro.nfl.com/#all22=<base64url JSON {v, n: name, p: [[old_game_id, play_id, note?]]}>.
     Only ids travel; the receiver's own index fills each play back in. The
     fragment is never sent to NFL's servers, and iso.js takes it off the URL
     before the page's router sees it. */
  const SHARE_V = 1, SHARE_MAX = 500;
  function b64u(str) {
    let bin = "";
    for (const x of new TextEncoder().encode(str)) bin += String.fromCharCode(x);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return new TextDecoder().decode(Uint8Array.from(atob(s), ch => ch.charCodeAt(0)));
  }
  function shareLink(c) {
    const plays = c.plays.map(r => {
      const n = NOTES[pkey(r)];
      return n ? [String(r.old_game_id), r.play_id, n.t] : [String(r.old_game_id), r.play_id];
    });
    return "https://pro.nfl.com/#all22=" + b64u(JSON.stringify({ v: SHARE_V, n: c.name, p: plays }));
  }
  async function copyLink(c) {
    if (!c.plays.length) { flash("nothing to share yet"); return; }
    const url = shareLink(c);
    try {
      await navigator.clipboard.writeText(url);
      q("#all22-st").textContent =
        `Link to “${c.name}” copied. Anyone with NFL Pro and All-22 can open it.`;
    } catch {
      window.prompt("Copy this link to share the cutup:", url);
    }
  }
  async function importLink(str) {
    const m = /all22=([A-Za-z0-9_-]+)/.exec(String(str || ""));
    if (!m) throw new Error("That is not an All-22 cutup link.");
    let d;
    try { d = JSON.parse(unb64u(m[1])); } catch { d = null; }
    if (!d || d.v !== SHARE_V || !Array.isArray(d.p))
      throw new Error("That link is damaged or incomplete.");
    const items = d.p.slice(0, SHARE_MAX).filter(x => Array.isArray(x) &&
      /^\d{10}$/.test(String(x[0])) && /^\d{1,6}$/.test(String(x[1])));
    const key = x => `${x[0]}/${Number(x[1])}`;
    q("#all22-st").textContent = "importing cutup…";
    const rows = items.length
      ? await backend("/api/plays?ids=" + encodeURIComponent(items.map(key).join(","))) : [];
    const by = new Map((Array.isArray(rows) ? rows : []).map(r => [pkey(r), r]));
    const plays = [], seen = new Set();
    let missing = 0, kept = 0;
    for (const x of items) {
      const k = key(x), r = by.get(k);
      if (!r) { missing++; continue; }
      if (seen.has(k)) continue;
      seen.add(k);
      plays.push(snap(r));
      const t = typeof x[2] === "string" ? x[2].slice(0, 4000) : "";
      if (!t.trim()) continue;
      // a note of your own on the same play wins: an import never overwrites
      if (NOTES[k]) { if (NOTES[k].t !== t) kept++; continue; }
      NOTES[k] = { t, at: Date.now() };
      post("/api/note", { key: k, text: t }).catch(() => {});
    }
    if (!plays.length) throw new Error("None of that cutup's plays are in your play index yet.");
    let name = String(d.n || "").trim().slice(0, 80) || "Shared cutup";
    if (Object.values(CUTS).some(c => c.name === name)) name = (name + " (shared)").slice(0, 80);
    const c = newCut(name, plays);
    p.classList.remove("hid");
    applyPush();
    openCut(c.id);
    q("#all22-st").textContent = `Imported “${c.name}”: ${plays.length} play${plays.length === 1 ? "" : "s"}` +
      (missing ? ` · ${missing} not in your play index yet` : "") +
      (kept ? ` · kept your own note on ${kept}` : "");
    return c;
  }

  /* ---------------- on field ----------------
     The 22 players on the field for the play on screen, from NFL Pro's
     summaryPlay -- one request per play, cached, and only made when the list
     is showing: always in wide view, beside the video; in half view only while
     its panel is open. A name is a search: every snap he played that season,
     through the NFL Pro "On field" action. */
  const ON_FIELD = new Map();       // play key -> summaryPlay answer (a promise)
  const ON_FIELD_MAX = 60;
  let onOpen = false, ofSeq = 0;
  const POS_ORDER = ["QB", "RB", "HB", "FB", "WR", "TE", "LT", "T", "OT", "LG", "G", "OG", "C",
    "RG", "RT", "OL", "DE", "EDGE", "DT", "NT", "DL", "OLB", "LB", "ILB", "MLB", "CB", "NB", "DB",
    "S", "FS", "SS", "SAF", "K", "P", "LS"];
  const posRank = x => { const i = POS_ORDER.indexOf(x); return i === -1 ? 99 : i; };
  const short = pl => (pl.firstName ? pl.firstName[0] + "." : "") + (pl.lastName || pl.playerName || "");

  function onFieldData(row) {
    const k = pkey(row);
    if (ON_FIELD.has(k)) return ON_FIELD.get(k);
    const job = (async () => {
      const uuid = await gameUuid(row);
      if (!uuid) throw new Error("NFL Pro has no game for this play.");
      const d = await secured("/api/plays/summaryPlay", { gameId: uuid, playId: row.play_id });
      if (!d || (!(d.home || []).length && !(d.away || []).length))
        throw new Error("NFL Pro lists no players for this play.");
      return d;
    })();
    ON_FIELD.set(k, job);
    job.catch(() => ON_FIELD.delete(k));        // a failure is not worth remembering
    while (ON_FIELD.size > ON_FIELD_MAX) ON_FIELD.delete(ON_FIELD.keys().next().value);
    return job;
  }

  /* "NE @ JAX · Week 3 · Q3 · 04:28 · 3rd & 9": the game, the week and the
     moment, in the order you would say them. The play's own row supplies the
     week (summaryPlay's schedule names teams, not always the week). */
  const ORD = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th" };
  const POST_WEEK = { WC: "Wild Card", DIV: "Divisional", CONF: "Conference", SB: "Super Bowl" };
  function gameLine(d, row) {
    const sc = d.schedule || {}, pl = d.play || {};
    const away = sc.visitorTeamAbbr || (row && row.away_team) || "";
    const home = sc.homeTeamAbbr || (row && row.home_team) || "";
    const slug = (row && row.week_slug) || "";
    const week = POST_WEEK[slug] || (row && row.week ? "Week " + row.week : sc.week ? "Week " + sc.week : "");
    const q = Number(pl.quarter);
    return [away && home ? `${away} @ ${home}` : "", week,
            q ? (q > 4 ? (q > 5 ? "OT" + (q - 4) : "OT") : "Q" + q) : "",
            pl.gameClock || "",
            ORD[pl.down] ? `${ORD[pl.down]} & ${pl.yardsToGo}` : ""].filter(Boolean).join(" \u00b7 ");
  }

  function onFieldHtml(d, wide, row) {
    const sc = d.schedule || {}, pl = d.play || {};
    const homeOff = !!d.homeIsOffense;
    const team = (arr, abbr, side) => {
      const rows = (arr || []).slice().sort((a, b) =>
        posRank(a.position) - posRank(b.position) || (+a.uniformNumber || 0) - (+b.uniformNumber || 0));
      return `<div class="ofteam"><h4>${esc(abbr || "")} · ${side}</h4>` + rows.map(x =>
        `<div class="ofp${x.nflId ? "" : " nolink"}" data-g="${esc(x.gsisId || "")}" data-n="${esc(String(x.nflId || ""))}"` +
        ` data-f="${esc(x.firstName || "")}" data-l="${esc(x.lastName || "")}" data-pos="${esc(x.position || "")}"` +
        `${x.nflId ? ` title="Search every snap ${esc(short(x))} played"` : ""}>` +
        `<span class="p">${esc(x.position || "")}</span><span class="n">${esc(String(x.uniformNumber ?? ""))}</span>` +
        `<span class="nm">${esc(short(x))}</span><span class="go2">${x.nflId ? "on-field plays →" : ""}</span></div>`).join("") +
        `</div>`;
    };
    const off = team(homeOff ? d.home : d.away, homeOff ? sc.homeTeamAbbr : sc.visitorTeamAbbr, "OFFENSE");
    const def = team(homeOff ? d.away : d.home, homeOff ? sc.visitorTeamAbbr : sc.homeTeamAbbr, "DEFENSE");
    return onFieldHead(wide, wide ? gameLine(d, row) : (pl.playDescription || "").replace(/\s+/g, " ")) +
      `<div class="ofteams">${off}${def}</div>` +
      (wide ? "" : `<div class="offoot">Click a player to search every snap he played that season</div>`);
  }
  const onFieldHead = (wide, sub) =>
    `<div class="ofh"><span class="t">On field</span>` +
    (wide ? `<span class="sp"></span><span class="s">${esc(sub || "")}</span>`
          : `<span class="s">${esc(sub || "")}</span><span class="sp"></span>` +
            `<button class="a22b" data-ofx="1" title="Close (Esc)" aria-label="Close">✕</button>`) + `</div>`;

  async function drawOnField() {
    const sheet = q("#a-onsheet"), side = q("#a-onside");
    const wide = p.classList.contains("wide");
    side.hidden = !(wide && curRow);
    sheet.hidden = !(!wide && onOpen && curRow);
    const host = wide ? side : sheet;
    const seq = ++ofSeq;
    if (host.hidden) return;
    const row = curRow, wire = () => {
      const x = host.querySelector("[data-ofx]");
      if (x) x.onclick = () => setOnField(false);
      host.querySelectorAll(".ofp:not(.nolink)").forEach(el => el.onclick = () => searchOnField(el.dataset, row));
    };
    host.innerHTML = onFieldHead(wide, "") + '<div class="ofmsg">asking NFL Pro…</div>';
    wire();
    try {
      const d = await onFieldData(row);
      if (seq !== ofSeq) return;
      host.innerHTML = onFieldHtml(d, wide, row);
    } catch (e) {
      if (seq !== ofSeq) return;
      host.innerHTML = onFieldHead(wide, "") + `<div class="ofmsg">${esc(e.message || String(e))}</div>`;
    }
    wire();
  }
  function setOnField(on) {
    onOpen = !!on;
    drawAngles();
    drawOnField();
  }
  // the panel closes on a click anywhere else, like the other menus
  document.addEventListener("click", e => {
    if (!onOpen || p.classList.contains("wide")) return;
    const sheet = q("#a-onsheet"), btn = q("#all22-ang button[data-of]");
    if (sheet.contains(e.target) || (btn && btn.contains(e.target))) return;
    setOnField(false);
  }, true);

  // a name in the list: pick him and ask NFL Pro for every snap he was on for
  async function searchOnField(ds, row) {
    let rec = null;
    try {
      const list = await backend("/api/players?q=" + encodeURIComponent(ds.l || ""));
      rec = (list || []).find(x => x.gsis_id === ds.g) || null;
    } catch {}
    picked = Object.assign(rec || { gsis_id: ds.g, name: `${ds.f} ${ds.l}`.trim(),
                                    position: ds.pos, team: null, plays: 0 },
                           { nfl_id: rec && rec.nfl_id ? rec.nfl_id : Number(ds.n) });
    if (cutView) leaveCuts();
    onOpen = false;
    // "that season": the play's season, every week, either team
    const sel = q("#a-season");
    if ([...sel.options].some(o => o.value === String(row.season))) sel.value = String(row.season);
    q("#a-week").value = "";
    q("#a-team").value = "";
    q("#a-player").value = "";
    closeMenu();
    showPicked();
    facets = {}; excl = new Set();
    drawAngles();
    drawOnField();
    loadRoles("nfl:field");
  }

  /* ---------------- one dropdown ----------------
     A native <select> opens a list the OS draws -- white on macOS, beside our
     dark menus. Every select in the panel opens the panel's own menu instead.
     The select stays the source of truth: the menu only sets .value and fires
     "change", so nothing that reads or listens to a select changes. */
  let selMenu = null, selFor = null, selKb = -1, selItems = [];
  function closeSel() {
    if (selMenu) selMenu.hidden = true;
    selFor = null; selKb = -1;
  }
  function pickSel(i) {
    const it = selItems[i], sel = selFor;
    if (!it || !it.o || it.o.disabled || !sel) return;
    closeSel();
    if (sel.value !== it.o.value) {
      sel.value = it.o.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sel.focus();
  }
  function markSel(i) {
    selKb = i;
    selMenu.querySelectorAll(".it").forEach(el => el.classList.toggle("kb", +el.dataset.i === i));
    const el = selMenu.querySelector(`.it[data-i="${i}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function openSel(sel) {
    if (!selMenu) {
      selMenu = $("div");
      selMenu.className = "a22sel";
      selMenu.hidden = true;
      p.appendChild(selMenu);
    }
    selFor = sel;
    selItems = [];
    for (const node of sel.children) {
      if (node.tagName === "OPTGROUP") {
        selItems.push({ g: node.label || "" });
        for (const o of node.children) selItems.push({ o });
      } else selItems.push({ o: node });
    }
    selMenu.innerHTML = selItems.map((it, i) => it.o
      ? `<div class="it${it.o.value === sel.value ? " on" : ""}${it.o.disabled ? " dis" : ""}" data-i="${i}">` +
        // data-n: a count beside the value, as the dictionary's value menus carry
        `<span>${esc(it.o.textContent)}${it.o.dataset.n ? `<span class="dn"> ${esc(it.o.dataset.n)}</span>` : ""}</span></div>`
      : `<div class="g" data-l="${esc(it.g)}"></div>`).join("");
    selMenu.querySelectorAll(".it").forEach(el => {
      el.onmousedown = e => e.preventDefault();      // keep focus on the select
      el.onclick = e => { e.stopPropagation(); pickSel(+el.dataset.i); };
    });
    // under the select, inside the panel; above it when there is no room below
    const r = sel.getBoundingClientRect(), pr = p.getBoundingClientRect();
    selMenu.style.minWidth = Math.max(r.width, 140) + "px";
    selMenu.style.left = Math.max(8, Math.min(r.left - pr.left, pr.width - 220)) + "px";
    selMenu.style.top = (r.bottom - pr.top + 3) + "px";
    selMenu.hidden = false;
    const mb = selMenu.getBoundingClientRect();
    if (mb.bottom > window.innerHeight - 8 && r.top - mb.height - 3 > 8)
      selMenu.style.top = (r.top - pr.top - mb.height - 3) + "px";
    const cur = selItems.findIndex(it => it.o && it.o.value === sel.value);
    if (cur !== -1) markSel(cur);
  }
  p.addEventListener("mousedown", e => {
    const sel = e.target && e.target.closest && e.target.closest("select");
    // ours only: NFL's player mounts inside the panel and keeps its own controls
    if (!sel || sel.disabled || sel.closest("#all22-video")) return;
    e.preventDefault();                               // no OS popup
    if (selFor === sel) { closeSel(); return; }
    sel.focus();
    openSel(sel);
  }, true);
  // the keys that would open the OS popup open ours; with ours open, they drive it
  p.addEventListener("keydown", e => {
    const t = e.target;
    if (selFor) {
      const live = selItems.map((it, i) => (it.o && !it.o.disabled ? i : -1)).filter(i => i !== -1);
      const at = live.indexOf(selKb);
      if (e.key === "ArrowDown") markSel(live[Math.min(live.length - 1, at + 1)]);
      else if (e.key === "ArrowUp") markSel(live[Math.max(0, at - 1)]);
      else if (e.key === "Enter" || e.key === " ") pickSel(selKb);
      else if (e.key === "Escape" || e.key === "Tab") { closeSel(); if (e.key === "Tab") return; }
      else return;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (t && t.tagName === "SELECT" && !t.closest("#all22-video") && [" ", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      openSel(t);
    }
  }, true);
  document.addEventListener("mousedown", e => {
    if (selFor && !selMenu.contains(e.target) && e.target !== selFor) closeSel();
  }, true);
  q("#a-body").addEventListener("scroll", closeSel);
  q("#a-dlist").addEventListener("scroll", closeSel);
  window.addEventListener("resize", closeSel);

  // load the library, then take any cutup that arrived by link
  backend("/api/library").then(lib => {
    NOTES = (lib && lib.notes) || {};
    CUTS = (lib && lib.cutups) || {};
    if (lastRows.length) drawRows();
    if (curRow) drawNote();
    return backend("/api/pending_import");
  }).then(r => {
    if (r && r.link) return importLink(r.link);
  }).catch(e => {
    q("#all22-st").innerHTML = `<span style="color:#e0736b">${esc(e.message || String(e))}</span>`;
  });

  // Everything except the player/role/facet selection. The facet counts need the
  // very same filters, or a chip claims a player's whole season while the list
  // below shows the four plays that actually match.
  function contextParams() {
    const u = new URLSearchParams();
    const push = (c, o, v) => u.append("f", v === undefined || v === "" ? `${c}:${o}` : `${c}:${o}:${v}`);
    if (q("#a-season").value) push("season", "eq", q("#a-season").value);
    if (q("#a-week").value) push("week", "eq", q("#a-week").value);
    if (q("#a-type").value) push("play_type", "eq", q("#a-type").value);
    if (q("#a-team").value) push("__team", "eq", q("#a-team").value);
    if (!picked) {
      const pl = q("#a-player").value.trim();
      if (pl) u.append("q", pl);          // free text against the description
    }
    const tx = q("#a-text").value.trim();
    if (tx) u.append("q", tx);
    extra.forEach(f => { if (!f.nfl) push(f.col, f.op, f.val); });
    // narrowed to what NFL Pro answered, when the search asked it anything
    if (nflActive) u.set("ids", nflActive.keys.join(","));
    return u;
  }

  // contextParams plus the player and facet selection: the full scope the play
  // list is under. A column profile asks for the same one, so the range it
  // reports is the range of what you are looking at.
  function scopeParams() {
    const u = contextParams();
    // an NFL Pro action is answered by NFL Pro alone: the index's participation
    // columns never record a snap he only lined up for
    if (picked && !nflAction()) {
      u.set("player", picked.gsis_id);
      const role = q("#a-role").value;
      if (role && role !== "any") u.set("role", role);   // scope the stat to HIM
      Object.values(facets).forEach(k => u.append("sub", k));
      excl.forEach(k => u.append("nsub", k));
    }
    return u;
  }

  /* The NFL Pro half of a search, as film-room params; null when nothing in
     it asks NFL Pro anything, { error } when it cannot be asked yet. */
  function nflQuery() {
    const act = nflAction();
    const fs = extra.filter(f => f.nfl);
    if (!act && !fs.length) return null;
    const params = nflWhen(q("#a-season").value, q("#a-week").value);
    const id = picked && picked.nfl_id;
    if (act) {
      if (!id) return { error: `NFL Pro has no id for ${picked.name}.` };
      params[act.who] = id;
      Object.assign(params, act.set || {});
    }
    for (const f of fs) {
      const d = nflDef(f.col);
      if (!d) continue;
      if (d.needs && !nflWho(d)) return { error: nflHint(d) };
      params[d.key] = f.val;
      if (nflWho(d) && !(d.who in params)) params[d.who] = id;
    }
    return params;
  }
  // anything besides season, week and team that the index alone can judge
  function localNarrowing() {
    return extra.some(f => !f.nfl) || !!q("#a-text").value.trim() || !!q("#a-type").value
      || (picked && !nflAction()) || (!picked && !!q("#a-player").value.trim());
  }

  const warnHtml = t => `<span style="color:#e0a86b">${esc(t)}</span>`;
  const errHtml = t => `<span style="color:#e0736b">${esc(t)}</span>`;
  let runSeq = 0;
  async function run() {
    const seq = ++runSeq;           // a newer search makes this one moot
    const st = q("#all22-st");
    dictFlush();                    // the dictionary, if open, describes the new scope
    q("#all22-res").innerHTML = "";
    const settle = (rows, shown) => {
      lastRows = rows; selIdx = -1; lastShown = shown;
      drawRows();
    };

    // 1. NFL Pro, when the search asks it anything: one request, or none if cached
    const np = nflQuery();
    nflActive = null;
    let nfl = null;
    if (np && np.error) { st.innerHTML = warnHtml(np.error); settle([], []); return; }
    if (np) {
      st.textContent = "asking NFL Pro…";
      try { nfl = await nflPlays(np); }
      catch (e) { if (seq === runSeq) { st.innerHTML = errHtml(e.message || String(e)); settle([], []); } return; }
      if (seq !== runSeq) return;
      nflActive = nfl;
    }

    // 2. the index, narrowed to NFL Pro's plays and then by everything else
    const u = scopeParams();
    u.set("order", q("#a-order").value);
    // read once: the rows are rendered against the same list that asked for them
    const shown = showCols();
    if (shown.length) u.set("show", shown.join(","));
    u.set("limit", nfl ? "1000" : "300");
    st.textContent = "searching…";
    let rows;
    try { rows = await backend(`/api/search?${u}`); }
    catch (e) { if (seq === runSeq) st.innerHTML = errHtml(String(e)); return; }
    if (seq !== runSeq) return;
    if (rows.error) { st.innerHTML = errHtml(rows.error); return; }

    // 3. plays NFL Pro has and the index does not yet (nflverse runs hours
    //    behind): shown from NFL's own fields, unless a filter only the index
    //    can judge is in play -- then they are counted, not guessed at
    let newer = [], missing = 0;
    if (nfl && nfl.count) {
      let known;
      try { known = new Set(await backend("/api/known?ids=" + encodeURIComponent(nfl.keys.join(",")))); }
      catch { known = new Set(nfl.keys); }
      if (seq !== runSeq) return;
      const absent = nfl.keys.filter(k => !known.has(k));
      missing = absent.length;
      if (missing && !localNarrowing()) {
        const team = q("#a-team").value;
        newer = absent.map(k => nflRow(nfl.plays.get(k)))
          .filter(r => !team || r.posteam === team || r.defteam === team);
      }
    }
    rows = rows.concat(newer);

    if (nfl) {
      const n = v => v + (v === 1 ? " play" : " plays");
      // two stages, one sentence: what matched, then what your other filters kept
      st.innerHTML = (localNarrowing() ? `${n(rows.length - newer.length)} · ${nfl.count} before your other filters`
                                       : n(rows.length)) +
        (newer.length ? ` · ${newer.length} newer than the play index`
          : missing ? ` · ${missing} not in the play index yet` : "") +
        (!rows.length && nfl.count ? " — try removing a filter" : "");
    } else if (!rows.length) {
      const sus = extra.filter(f => COLTYPE[f.col] === "TEXT" && NUMOPS.includes(f.op));
      // the whole point of tracking the lag: an empty result on a charting
      // column is usually the charting, not the football
      const late = extra.map(f => lateNote(f.col)).find(n => n && n.warn);
      st.innerHTML = "0 plays" + (sus.length
        ? ` — <span style="color:#e0a86b">${esc(humanCol(sus[0].col))} is text; “${esc(OPSYM[sus[0].op] || sus[0].op)}” can’t match</span>`
        : late ? ` — <span style="color:#e0a86b">${esc(late.text)}</span>`
        : " — try removing a filter");
    } else {
      st.textContent = rows.length + " plays";
    }
    settle(rows, shown);
    if (nfl) refreshCounts();       // facet counts asked before NFL Pro answered
  }
  applyPush();
  q("#a-player").addEventListener("input", e => {
    picked = null;
    clearTimeout(pTimer);
    const v = e.target.value.trim();
    pTimer = setTimeout(() => playerLookup(v), 180);
  });
  q("#a-player").addEventListener("blur", () => setTimeout(closeMenu, 180));
  q("#a-role").addEventListener("change", () => { facets = {}; excl = new Set(); loadSubs(); run(); });
  q("#a-facethead").onclick = toggleCollapse;
  // wired once: the footer is static markup now, and column filters can be the
  // only thing to clear (renderFacets never runs when there are no facet rows)
  q("#a-clear").onclick = () => {
    facets = {}; excl = new Set(); extra.length = 0;
    drawChips(); apply();
  };
  q("#a-go").onclick = () => { run(); refreshCounts(); };
  ["#a-season", "#a-week", "#a-team", "#a-type"].forEach(sel =>
    q(sel).addEventListener("change", () => { run(); refreshCounts(); }));
  // re-sorting does not change WHICH plays match, only their order, so it runs
  // the search again but leaves the facet counts alone
  q("#a-order").addEventListener("change", () => run());
  p.addEventListener("keydown", e => {
    if (e.key !== "Enter" || cutView) return;
    if (e.target && e.target.closest && e.target.closest("#all22-note")) return;
    // the dictionary's Enter adds a filter, which runs the search itself
    if (e.target && e.target.closest && e.target.closest("#a-dict")) return;
    run();
  });
})();
