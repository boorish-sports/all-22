/* SQLite runs here, in an MV3 offscreen document.
 *
 * Not in the content script: the panel lives in pro.nfl.com's page world, where
 * NFL's Content-Security-Policy forbids WebAssembly. An offscreen document runs
 * on the extension's own origin with the extension's CSP, so wasm is allowed and
 * IndexedDB is ours rather than nfl.com's.
 *
 * The whole index is held in memory (~61 MB) via sqlite3_deserialize. That is
 * simpler and far faster than an OPFS/VFS setup, and the data is read-only
 * between syncs. It arrives as parts -- a file per completed season, one per
 * week of the newest season -- merged here and cached in IndexedDB, so an
 * in-season update downloads the weeks that changed and nothing else.
 */
import sqlite3InitModule from "./vendor/sqlite/sqlite3.mjs";

const DEFAULT_MANIFEST =
  "https://github.com/boorish-sports/all-22-index/releases/latest/download/manifest.json";
const IDB = { name: "all22", store: "blobs" };

let sqlite3 = null, db = null, meta = null, loading = null;

/* The offscreen document lives until Chrome quits, so without this an index
   published on Friday morning would not be seen until the next restart. On the
   first query after RECHECK_MS the manifest is fetched again (a few KB), the
   parts whose content id moved are fetched, and the merged database is
   swapped in place. */
const RECHECK_MS = 60 * 60e3;
let checkedAt = 0;

/* ---------- tiny IndexedDB cache so we download once ---------- */
/* Two keys: "index" holds the merged database (one serialized SQLite file),
   "index:meta" records which part of the published index each of its rows
   came from, so the next manifest can be diffed against it. */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB.name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB.store);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
let cache = {
  get: async k => req((await idb()).transaction(IDB.store, "readonly").objectStore(IDB.store).get(k)),
  put: async (k, v) => req((await idb()).transaction(IDB.store, "readwrite").objectStore(IDB.store).put(v, k)),
  keys: async () => req((await idb()).transaction(IDB.store, "readonly").objectStore(IDB.store).getAllKeys()),
  del: async k => req((await idb()).transaction(IDB.store, "readwrite").objectStore(IDB.store).delete(k)),
};

/* The few things the sync needs from SQLite that are not SQL. Kept apart from
   the SQL so the test harness can stand them in with node:sqlite. */
let engine = {
  // an in-memory database from a serialized file, or an empty one from null
  open(bytes) {
    const h = new sqlite3.oo1.DB();
    if (bytes) {
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      // RESIZEABLE: parts get inserted into it, so it has to be able to grow
      h.checkRc(sqlite3.capi.sqlite3_deserialize(
        h.pointer, "main", p, bytes.length, bytes.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
        sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE));
    }
    return h;
  },
  // mount a serialized part as the schema `name` on an open handle
  attach(h, name, bytes) {
    h.exec("ATTACH ':memory:' AS " + name);
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    h.checkRc(sqlite3.capi.sqlite3_deserialize(
      h.pointer, name, p, bytes.length, bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE));
  },
  detach(h, name) { h.exec("DETACH " + name); },
  export(h) { return sqlite3.capi.sqlite3_js_db_export(h.pointer); },
};

/* ---------- load ---------- */
/* Offscreen documents do not get chrome.storage, so the dev override
   (chrome.storage.local.set({ manifestUrl: "http://localhost:8722/dist/manifest.json" }))
   is read by the service worker and handed to us on every message. */
async function grab(url, what) {
  let r;
  try {
    r = await fetch(url, { cache: "no-cache" });
  } catch (e) {
    // fetch() rejects with a bare "Failed to fetch" for CORS and host-permission
    // problems alike, so say which URL died -- GitHub has moved its release-asset
    // host before, and each redirect hop needs its own host_permissions entry.
    throw new Error("could not reach the " + what + " at " + url +
                    " (" + String(e && e.message || e) + ")");
  }
  if (!r.ok) throw new Error(what + " returned HTTP " + r.status + " from " + r.url);
  return r;
}

/* The published index is PARTS: one file per completed season, one per week
   of the newest season, one for the players table (build_index.publish). Each
   carries a content id that moves only when its rows do. Diffing the manifest
   against what the merged copy already holds says exactly which files to
   fetch: a completed season is downloaded once and never again, and the
   revision nflverse ships on a Tuesday costs one week's file, not the whole
   index. A schema change (a column retyped) changes every id and the schema
   hash, and the merged copy is rebuilt from scratch. */
function planSync(man, have) {
  man = normalise(man);
  const rebuild = !have || have.schema !== man.schema;
  const had = rebuild ? {} : have.parts || {};
  return {
    rebuild,
    fetch: man.parts.filter(p => !had[p.key] || had[p.key].id !== p.id),
    drop: Object.values(had).filter(c => !man.parts.some(p => p.key === c.key)),
  };
}

/* The index used to be published as one file (manifest "version" 1: a single
   `file` + `sha256`). Read as a single part that owns every table, so an
   extension carrying this code works against either publication and the two
   repos can ship in any order. There is nothing to diff inside one file, so
   any change to it is a rebuild. */
function normalise(man) {
  if (Array.isArray(man.parts)) return man;
  if (!man.file || !man.sha256) {
    throw new Error("index manifest names neither parts nor a file");
  }
  return Object.assign({}, man, {
    schema: "v1:" + (man.content_hash || man.sha256),
    parts: [{ key: "index", file: man.file, sha256: man.sha256,
              id: man.content_hash || man.sha256, bytes: man.bytes, rows: man.rows,
              table: "*" }],
  });
}

/* The rows a part is responsible for. A part replaces exactly this scope, so
   a revised week overwrites the old copy of that week and nothing else. A
   "*" part (the single-file publication) owns every table it carries. */
const TABLES = { plays: 1, players: 1, games: 1 };
function partTables(h, part) {
  const names = part.table === "*"
    ? h.selectArrays("SELECT name FROM part.sqlite_master WHERE type = 'table'").map(r => r[0])
    : [part.table];
  for (const t of names) {
    if (!TABLES[t]) throw new Error("index part names an unknown table: " + t);
  }
  return names;
}
function scopeSql(table, part) {
  const where = [], args = [];
  if (part.season != null) { where.push("season = ?"); args.push(part.season); }
  if (part.week != null) { where.push("week = ?"); args.push(part.week); }
  return ['DELETE FROM main."' + table + '"' + (where.length ? " WHERE " + where.join(" AND ") : ""), args];
}
function deleteScope(h, tables, part) {
  const present = new Set(
    h.selectArrays("SELECT name FROM main.sqlite_master WHERE type = 'table'").map(r => r[0]));
  for (const t of tables.filter(t => present.has(t))) {
    const [del, args] = scopeSql(t, part);
    h.exec({ sql: del, bind: args });
  }
}

/* Copy one downloaded part into the merged database. */
function applyPart(h, part, bytes) {
  engine.attach(h, "part", bytes);
  try {
    // every part carries the full DDL of its tables; the first one in creates them
    for (const r of h.selectObjects(
        "SELECT sql FROM part.sqlite_master WHERE type IN ('table','index')" +
        " AND sql IS NOT NULL ORDER BY type DESC, name")) {
      h.exec(r.sql.replace(/^CREATE (TABLE|INDEX) /, "CREATE $1 IF NOT EXISTS "));
    }
    const tables = partTables(h, part);
    deleteScope(h, tables, part);
    for (const t of tables) {
      h.exec('INSERT INTO main."' + t + '" SELECT * FROM part."' + t + '"');
    }
  } finally {
    engine.detach(h, "part");
  }
}

async function download(part, murl, progress) {
  const url = new URL(part.file, murl).href;
  const buf = await (await grab(url, "index part " + part.key)).arrayBuffer();
  // the artifact comes off the public internet -- verify it before opening it
  const got = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
  if (part.sha256 && got !== part.sha256) {
    throw new Error("index part " + part.key + " failed checksum (expected " +
                    part.sha256.slice(0, 12) + ", got " + got.slice(0, 12) + ")");
  }
  progress && progress({ stage: "decompressing" });
  // the artifact is gzipped; the browser can inflate it natively
  const ds = new DecompressionStream("gzip");
  const inflated = new Response(new Blob([buf]).stream().pipeThrough(ds));
  return new Uint8Array(await inflated.arrayBuffer());
}

function swapIn(h, man, progress) {
  const old = db;
  db = h;
  meta = man;
  if (old) {
    // everything derived from the schema or the data was read off the old index
    schema = null; _binary = null; _redundant = null; _groups = null; _shape.clear();
    old.close();
    progress && progress({ stage: "refreshed", rows: man.rows });
  }
}

/* When the manifest cannot be reached on a cold start, the last merged copy is
   opened as-is and the manifest is tried again sooner than the usual hour. */
const RETRY_MS = 5 * 60e3;

async function ensureDb(progress, override) {
  if (db && Date.now() - checkedAt < RECHECK_MS) return;
  if (loading) return loading;
  loading = (async () => {
    sqlite3 = sqlite3 || await sqlite3InitModule();
    const murl = override || DEFAULT_MANIFEST;
    const have = await cache.get("index:meta");
    let man;
    try {
      man = await (await grab(murl, "index manifest")).json();
    } catch (e) {
      // a recheck that cannot reach GitHub keeps the index we already have;
      // a cold start falls back to the last copy, and only a first-ever load
      // has nothing to fall back on
      if (db) { checkedAt = Date.now(); return; }
      const bytes = have && await cache.get("index");
      if (!bytes) throw e;
      checkedAt = Date.now() - RECHECK_MS + RETRY_MS;
      swapIn(engine.open(bytes), have.manifest || {}, progress);
      return;
    }
    checkedAt = Date.now();
    man = normalise(man);
    const plan = planSync(man, have);
    if (!plan.fetch.length && !plan.drop.length) {
      if (db) return;                                   // in-session recheck: unchanged
      const bytes = await cache.get("index");
      if (bytes) { swapIn(engine.open(bytes), man, progress); return; }
      // the meta survived but the blob did not: start over
      plan.rebuild = true; plan.fetch = man.parts; plan.drop = [];
    }
    progress && progress({
      stage: "downloading",
      bytes: plan.fetch.reduce((n, p) => n + (p.bytes || 0), 0),
      parts: plan.fetch.length,
    });
    // build the next index on its own handle, so queries keep running against
    // the current one until it is complete
    const base = plan.rebuild ? null : await cache.get("index");
    const h = engine.open(base);
    try {
      for (const c of plan.drop) {
        deleteScope(h, c.table === "*" ? Object.keys(TABLES) : [c.table], c);
      }
      for (const p of plan.fetch) applyPart(h, p, await download(p, murl, progress));
      progress && progress({ stage: "opening" });
      // deleted rows leave holes; without this they would be serialized too
      h.exec("VACUUM");
    } catch (e) {
      h.close();
      throw e;
    }
    const parts = {};
    for (const p of man.parts) {
      parts[p.key] = { key: p.key, id: p.id, table: p.table, season: p.season, week: p.week };
    }
    await cache.put("index", engine.export(h));
    await cache.put("index:meta", { schema: man.schema, parts, manifest: man });
    // drop whatever an older layout left behind (the whole-index "db:<sha>" blobs)
    for (const k of await cache.keys()) {
      if (k !== "index" && k !== "index:meta") await cache.del(k);
    }
    swapIn(h, man, progress);
  })();
  try { await loading; } finally { loading = null; }
}

/* ---------- query layer (mirrors the old python server) ---------- */
/* nflverse numbers the slots of a multi-participant stat: two forced-fumble
   columns, four assist-tackle ones, two half-sacks. Filtering
   forced_fumble_player_1_player_name quietly misses whoever landed in slot 2 --
   8,177 plays have a second assist tackler, 150 a second QB hitter, 159 a split
   sack. These groups publish one merged column per stat and OR the slots under
   it. Mirrors roles.py -- keep the two in step. */
// /g so a name with two slot numbers collapses every one of them, matching
// python's re.sub; String.match and String.replace both reset lastIndex first,
// so sharing one global regex here is safe
const SLOT = /(^|_)\d+(_|$)/g;
const GROUP_LABELS = {
  tackle_for_loss: "Tackle for loss", qb_hit: "QB hit",
  forced_fumble_player: "Forced fumble", solo_tackle: "Solo tackle",
  assist_tackle: "Assist tackle", tackle_with_assist: "Tackle with assist",
  pass_defense: "Pass defensed", fumbled: "Fumbled",
  fumble_recovery: "Fumble recovery", half_sack: "Sack",
};
const SUFFIX_LABELS = { player_name: "", player_id: " player ID",
                        team: " team", yards: " yards" };
/* A full sack and a split sack live in differently-named columns, so the slot
   rule alone leaves "Sack" (1,184 plays) and "Half sack" (159) as separate
   lookups -- ask for Anderson's sacks and the split ones never show. */
const GROUP_ABSORB = {
  "half_sack_#_player_id":   ["@sack_player_id", ["sack_player_id"]],
  "half_sack_#_player_name": ["@sack_player_name", ["sack_player_name"]],
};

/* Columns whose every non-null value is 0 or 1, and where both actually occur
   -- the nflverse event flags. Requiring both states is what keeps play_clock
   out: a real number column that happens to hold nothing but '0' this season,
   which offered as a yes/no would be a lie about the data. One table scan,
   cached. Three cheap counting aggregates rather than COUNT(DISTINCT), which
   would build a hash set per column -- 337 of them, some with 48k distinct
   values. Mirrors server.py. */
let _binary = null;
function binaryColumns() {
  if (_binary) return _binary;
  const keys = Object.keys(cols());
  const sel = keys.map(k =>
    `SUM("${k}" IN ('0',0)), SUM("${k}" IN ('1',1)), COUNT("${k}")`).join(", ");
  const row = db.selectArrays("SELECT " + sel + " FROM plays")[0];
  _binary = keys.filter((k, i) => {
    const n0 = row[i * 3] || 0, n1 = row[i * 3 + 1] || 0, n = row[i * 3 + 2];
    return n && n0 && n1 && n0 + n1 === n;
  });
  return _binary;
}

/* nflverse also ships a 0/1 flag beside several of these stats. Where the flag
   is *exactly* "the merged column is set" it is a second name for the same
   question and only muddies the picker ("Forced fumble" vs "Fumble forced").
   Candidates only -- each is checked against the actual index, because two are
   not redundant: sack is set on 9 plays crediting nobody, and tackled_for_loss
   disagrees with its players on 1,463. Mirrors roles.py. */
const REDUNDANT_FLAGS = {
  fumble_forced: "@forced_fumble_player_player_name",
  sack: "@sack_player_name",
  qb_hit: "@qb_hit_player_name",
  solo_tackle: "@solo_tackle_player_name",
  assist_tackle: "@assist_tackle_player_name",
  tackle_with_assist: "@tackle_with_assist_player_name",
  tackled_for_loss: "@tackle_for_loss_player_name",
  fumble: "@fumbled_player_name",
};
let _redundant = null;
function redundantFlags() {
  if (_redundant) return _redundant;
  const c = cols(), gs = groups();
  _redundant = [];
  for (const [flag, key] of Object.entries(REDUNDANT_FLAGS)) {
    const g = gs[key];
    if (!g || !(flag in c)) continue;
    const named = g.members.map(m => `"${m}" IS NOT NULL`).join(" OR ");
    const set_ = `("${flag}" = '1' OR "${flag}" = 1)`;
    const diff = db.selectArrays(
      `SELECT COUNT(*) FROM plays WHERE (${set_} AND NOT (${named}))` +
      ` OR (NOT ${set_} AND (${named}))`)[0][0];
    if (!diff) _redundant.push(flag);
  }
  return _redundant;
}

/* ---------- columns that arrive after the play ----------
   nflverse's play-by-play lands within hours of a game, but FTN's charting
   layer is charted BY HAND: nflreadr documents it as "charted within 48 hours
   following each game", and nflverse polls FTN every six hours through the
   season, so it appears within hours of FTN finishing. Sunday's games are
   charted by Tuesday and Monday night's by Wednesday -- which is when a *week*
   is complete.

   The failure without this is silent: ask for "Play action: Yes" on Monday and
   the newest week returns nothing, which reads as an honest zero or a broken
   index rather than "not charted yet". Mirrors roles.py -- keep in step. */
const LATE_SOURCES = [{
  key: "ftn",
  label: "FTN charting",
  weekday: "Wednesday",
  note: "FTN charts each game within about 48 hours, so a week is usually " +
        "complete by Wednesday.",
  // non-NULL on exactly the plays FTN charted: it fills every field on a play
  // it charts and none on a play it skips, so coverage is measured, not assumed
  marker: "qb_location",
  // must stay in step with FTN_COLS in build_index.py
  cols: ["starting_hash", "qb_location", "n_offense_backfield", "n_defense_box",
         "is_no_huddle", "is_motion", "is_play_action", "is_screen_pass", "is_rpo",
         "is_trick_play", "is_qb_out_of_pocket", "is_interception_worthy",
         "is_throw_away", "read_thrown", "is_catchable_ball", "is_contested_ball",
         "is_created_reception", "is_drop", "is_qb_sneak", "n_blitzers",
         "n_pass_rushers", "is_qb_fault_sack"],
}];

function lateSources() {
  const c = cols();
  return LATE_SOURCES.filter(s => s.marker in c && s.cols.some(x => x in c));
}

/* How far each late source has actually been charted -- the cheap version of
   the question. Rather than scanning the whole table for a coverage histogram
   (90 ms a season, paid on every panel load), this asks only about the frontier
   -- the newest week the index carries -- and counts GAMES, not plays, because
   that is the unit the source charts and the unit a gap shows up in: "14 of 16
   games" is a partial week, where "97% of plays" is what a *complete* week
   looks like (FTN skips kneels and spikes).

   Every query here is answered from idx_sw, so the whole thing is ~35 ms
   regardless of how many seasons have stacked up. Mirrors server.py. */
function lateCoverage() {
  const out = [], c = cols();
  const season = db.selectArrays("SELECT MAX(season) FROM plays")[0][0];
  if (season == null || !("game_id" in c)) return out;
  const week = db.selectArrays(
    "SELECT MAX(week) FROM plays WHERE season=?", [season])[0][0];
  for (const s of lateSources()) {
    const [games, charted] = db.selectArrays(
      `SELECT COUNT(DISTINCT game_id), COUNT(DISTINCT CASE WHEN "${s.marker}"` +
      " IS NOT NULL THEN game_id END) FROM plays WHERE season=? AND week=?",
      [season, week])[0];
    const row = Object.assign({}, s, { season, week, games, charted });
    if (!charted) {
      // nothing at the frontier: say where the data does stop, so the gap reads
      // as a lag with a known edge rather than a missing column. MAX(season)
      // walks idx_sw backwards and stops at the first charted row, so it costs
      // nothing even though the marker is unindexed.
      const cs = db.selectArrays(
        `SELECT MAX(season) FROM plays WHERE "${s.marker}" IS NOT NULL`)[0][0];
      if (cs != null) row.through = { season: cs, week: db.selectArrays(
        `SELECT MAX(week) FROM plays WHERE season=? AND "${s.marker}" IS NOT NULL`,
        [cs])[0][0] };
    }
    out.push(row);
  }
  return out;
}

let _groups = null;
function groups() {
  if (_groups) return _groups;
  const c = cols(), fams = new Map();
  for (const col of Object.keys(c)) {
    if (!col.match(SLOT)) continue;
    const fam = col.replace(SLOT, (m, a, b) => a + "#" + b);
    if (!fams.has(fam)) fams.set(fam, []);
    fams.get(fam).push(col);
  }
  _groups = {};
  for (const [fam, members] of fams) {
    const at = fam.indexOf("_#_");
    // one member is not a group, and yardline_100 is not a slot
    if (members.length < 2 || at < 0) continue;
    const stem = fam.slice(0, at), suffix = fam.slice(at + 3);
    if (!suffix) continue;
    let key = "@" + stem + "_" + suffix, extra = [];
    if (GROUP_ABSORB[fam]) {
      key = GROUP_ABSORB[fam][0];
      extra = GROUP_ABSORB[fam][1].filter(x => x in c);
    }
    const label = (GROUP_LABELS[stem] || stem.replace(/_/g, " "))
      + (suffix in SUFFIX_LABELS ? SUFFIX_LABELS[suffix] : " " + suffix.replace(/_/g, " "));
    _groups[key] = { key, label, type: c[members[0]], members: extra.concat(members) };
  }
  return _groups;
}

/* What "Contains" has to send. LIKE without wildcards is a case-insensitive
   equals, so a fragment typed into the panel -- "Anderson" against a column
   holding "W.Anderson" -- matched 0 plays and read as "he never did this"
   rather than as a mistake. A value already carrying a % is passed through, so
   an anchored pattern like "(Shotgun)%" still means starts-with. */
function likePattern(val) {
  return (val == null || val.includes("%")) ? val : "%" + val + "%";
}

/* Expand a merged column across its slots. OR is right only for the positive
   operators: "not W.Anderson" has to mean *no* slot is W.Anderson -- an AND of
   NULL-safe <> -- or it matches nearly every play; "is empty" means all empty. */
function groupSql(g, op, val) {
  const qs = g.members.map(m => `"${m}"`);
  if (op === "isnull") return ["(" + qs.map(q => q + " IS NULL").join(" AND ") + ")", []];
  const someset = "(" + qs.map(q => q + " IS NOT NULL").join(" OR ") + ")";
  if (op === "notnull") return [someset, []];
  let v = val;
  if (g.type !== "TEXT") {
    v = Number(val);
    if (!Number.isFinite(v)) return [null, []];
  }
  if (op === "ne") {
    const nomatch = qs.map(q => `(${q} IS NULL OR ${q} <> ?)`).join(" AND ");
    return ["(" + nomatch + " AND " + someset + ")", qs.map(() => v)];
  }
  return ["(" + qs.map(q => `${q} ${OPS[op]} ?`).join(" OR ") + ")", qs.map(() => v)];
}

const OPS = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
              like: "LIKE", notnull: "IS NOT NULL", isnull: "IS NULL" };
const CORE = ["play_id", "old_game_id", "season", "season_type", "week", "home_team",
              "away_team", "posteam", "defteam", "qtr", "time", "down", "ydstogo",
              "desc", "play_type", "epa"];
const POST_SLUG = { 19: "WC", 20: "DIV", 21: "CONF", 22: "SB" };
const PRE_SLUG = { 0: "HOF", 1: "P1", 2: "P2", 3: "P3", 4: "P4" };
function weekSlug(t, w) {
  w = Number(w);
  if (t === "REG") return "WEEK_" + w;
  if (t === "POST") return POST_SLUG[w] || null;
  if (t === "PRE") return PRE_SLUG[w] || null;
  return null;
}

/* nflverse spreads one stat across several columns (two forced-fumble slots,
   four assist-tackle slots, a sack plus two half-sacks). Filtering
   `fumble_forced = 1` only says a forced fumble happened on the play; to say
   THIS player forced it, match their id against that stat's own columns.
   Mirrors roles.py -- keep the two in step. */
const ROLES = [
  ["any", "Any", null],
  ["passer", "Passing", ["passer_player_id"]],
  ["rusher", "Rushing", ["rusher_player_id", "lateral_rusher_player_id"]],
  ["receiver", "Receiving", ["receiver_player_id", "lateral_receiver_player_id"]],
  ["touchdown", "Touchdown", ["td_player_id"]],
  ["sack", "Sack", ["sack_player_id", "half_sack_1_player_id", "half_sack_2_player_id", "lateral_sack_player_id"]],
  ["qb_hit", "QB hit", ["qb_hit_1_player_id", "qb_hit_2_player_id"]],
  ["tackle_for_loss", "Tackle for loss", ["tackle_for_loss_1_player_id", "tackle_for_loss_2_player_id"]],
  ["tackle", "Tackle (any)", ["solo_tackle_1_player_id", "solo_tackle_2_player_id",
    "assist_tackle_1_player_id", "assist_tackle_2_player_id", "assist_tackle_3_player_id",
    "assist_tackle_4_player_id", "tackle_with_assist_1_player_id", "tackle_with_assist_2_player_id",
    "tackle_for_loss_1_player_id", "tackle_for_loss_2_player_id"]],
  ["solo_tackle", "Solo tackle", ["solo_tackle_1_player_id", "solo_tackle_2_player_id"]],
  ["interception", "Interception", ["interception_player_id", "lateral_interception_player_id"]],
  ["pass_defense", "Pass defensed", ["pass_defense_1_player_id", "pass_defense_2_player_id"]],
  ["forced_fumble", "Forced fumble", ["forced_fumble_player_1_player_id", "forced_fumble_player_2_player_id"]],
  ["fumbled", "Fumble", ["fumbled_1_player_id", "fumbled_2_player_id"]],
  ["fumble_recovery", "Fumble recovery", ["fumble_recovery_1_player_id", "fumble_recovery_2_player_id"]],
  ["penalty", "Penalty", ["penalty_player_id"]],
  ["returner", "Return", ["punt_returner_player_id", "kickoff_returner_player_id",
    "lateral_punt_returner_player_id", "lateral_kickoff_returner_player_id"]],
  ["kicking", "Kick / punt", ["kicker_player_id", "punter_player_id"]],
  ["safety", "Safety", ["safety_player_id"]],
];

/* Second-level splits. Each option carries conditions (column, op, value);
   "ne" is NULL-safe not-equal. ANDing them is what makes the run-type split
   mutually exclusive -- over half of a QB's "designed runs" are kneeldowns and
   another chunk are sneaks. Mirrors roles.py SUBS. */
const SUBS = {
  rusher: [
    ["Run type", [
      ["scramble", "Scramble", [["qb_scramble", "eq", "1"]]],
      ["sneak", "QB sneak", [["is_qb_sneak", "eq", "1"]]],
      ["designed", "Designed run", [["qb_scramble", "ne", "1"], ["qb_kneel", "ne", "1"], ["is_qb_sneak", "ne", "1"]]],
      ["kneel", "Kneeldown", [["qb_kneel", "eq", "1"]]],
    ]],
    ["Direction", [["run_left", "Left", [["run_location", "eq", "left"]]],
                   ["run_middle", "Middle", [["run_location", "eq", "middle"]]],
                   ["run_right", "Right", [["run_location", "eq", "right"]]]]],
    ["Gap", [["gap_end", "End", [["run_gap", "eq", "end"]]],
             ["gap_guard", "Guard", [["run_gap", "eq", "guard"]]],
             ["gap_tackle", "Tackle", [["run_gap", "eq", "tackle"]]]]],
    ["Play call", [["rpo", "RPO", [["is_rpo", "eq", "1"]]]]],
  ],
  passer: [
    ["Result", [["complete", "Complete", [["complete_pass", "eq", "1"]]],
                ["incomplete", "Incomplete", [["incomplete_pass", "eq", "1"]]],
                ["intercepted", "Intercepted", [["interception", "eq", "1"]]]]],
    ["Depth", [["short", "Short", [["pass_length", "eq", "short"]]],
               ["deep", "Deep", [["pass_length", "eq", "deep"]]]]],
    ["Side", [["pl_left", "Left", [["pass_location", "eq", "left"]]],
              ["pl_middle", "Middle", [["pass_location", "eq", "middle"]]],
              ["pl_right", "Right", [["pass_location", "eq", "right"]]]]],
    ["Formation", [["shotgun", "Shotgun", [["shotgun", "eq", "1"]]],
                   ["under_center", "Under center", [["shotgun", "eq", "0"]]]]],
    ["Play call", [["play_action", "Play action", [["is_play_action", "eq", "1"]]],
                   ["rpo", "RPO", [["is_rpo", "eq", "1"]]],
                   ["screen", "Screen", [["is_screen_pass", "eq", "1"]]]]],
    ["Pocket", [["out_of_pocket", "Out of pocket", [["is_qb_out_of_pocket", "eq", "1"]]],
                ["in_pocket", "In pocket", [["is_qb_out_of_pocket", "eq", "0"]]]]],
    ["Ball", [["throw_away", "Throwaway", [["is_throw_away", "eq", "1"]]],
              ["int_worthy", "Interception-worthy", [["is_interception_worthy", "eq", "1"]]]]],
  ],
  receiver: [
    ["Result", [["caught", "Caught", [["complete_pass", "eq", "1"]]],
                ["incomplete", "Incomplete", [["incomplete_pass", "eq", "1"]]]]],
    ["Depth", [["short", "Short", [["pass_length", "eq", "short"]]],
               ["deep", "Deep", [["pass_length", "eq", "deep"]]]]],
    ["Side", [["pl_left", "Left", [["pass_location", "eq", "left"]]],
              ["pl_middle", "Middle", [["pass_location", "eq", "middle"]]],
              ["pl_right", "Right", [["pass_location", "eq", "right"]]]]],
    ["Play call", [["play_action", "Play action", [["is_play_action", "eq", "1"]]],
                   ["screen", "Screen", [["is_screen_pass", "eq", "1"]]],
                   ["rpo", "RPO", [["is_rpo", "eq", "1"]]]]],
    ["Catch", [["contested", "Contested", [["is_contested_ball", "eq", "1"]]],
               ["drop", "Drop", [["is_drop", "eq", "1"]]],
               ["created", "Created reception", [["is_created_reception", "eq", "1"]]]]],
  ],
  touchdown: [
    ["Type", [["td_rush", "Rushing", [["rush_attempt", "eq", "1"]]],
              ["td_pass", "Receiving", [["pass_attempt", "eq", "1"]]]]],
  ],
  any: [
    ["Phase", [["on_pass", "Pass play", [["pass_attempt", "eq", "1"]]],
               ["on_run", "Run play", [["rush_attempt", "eq", "1"]]]]],
    ["Charting", [["motion", "Pre-snap motion", [["is_motion", "eq", "1"]]],
                  ["play_action", "Play action", [["is_play_action", "eq", "1"]]],
                  ["no_huddle_ftn", "No huddle", [["is_no_huddle", "eq", "1"]]],
                  ["trick", "Trick play", [["is_trick_play", "eq", "1"]]]]],
  ],
};

/* Kneeldowns and spikes carry a rusher_player_id and rush_attempt=1, so they
   masquerade as rushes. Drop them from the rushing role unless asked for. */
const ROLE_EXCLUDE = {
  rusher: { conds: [["qb_kneel", "ne", "1"], ["qb_spike", "ne", "1"]], unless: ["kneel"] },
};

/* Which role a position opens on, and which stat roles to promote in the menu.
   Keeps a DE from defaulting to "Passing". Mirrors roles.py POSITION_PROFILES. */
const POSITION_PROFILES = {
  QB: ["passer", ["passer", "rusher", "touchdown"]],
  RB: ["rusher", ["rusher", "receiver", "touchdown"]],
  FB: ["rusher", ["rusher", "receiver", "touchdown"]],
  WR: ["receiver", ["receiver", "rusher", "touchdown"]],
  TE: ["receiver", ["receiver", "touchdown"]],
  DE: ["sack", ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]],
  DT: ["sack", ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]],
  DL: ["sack", ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]],
  EDGE: ["sack", ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]],
  LB: ["tackle", ["tackle", "sack", "tackle_for_loss", "pass_defense", "forced_fumble"]],
  OLB: ["sack", ["sack", "qb_hit", "tackle", "tackle_for_loss"]],
  MLB: ["tackle", ["tackle", "tackle_for_loss", "pass_defense"]],
  CB: ["pass_defense", ["pass_defense", "interception", "tackle", "solo_tackle"]],
  SAF: ["tackle", ["tackle", "pass_defense", "interception", "solo_tackle"]],
  S: ["tackle", ["tackle", "pass_defense", "interception", "solo_tackle"]],
  FS: ["tackle", ["tackle", "pass_defense", "interception"]],
  SS: ["tackle", ["tackle", "pass_defense", "interception"]],
  K: ["kicking", ["kicking"]],
  P: ["kicking", ["kicking"]],
};

function roleColumns(role, c) {
  const all = Object.keys(c).filter(k => k.endsWith("_player_id"));
  if (!role || role === "any") return all;
  const hit = ROLES.find(r => r[0] === role);
  return (hit && hit[2] ? hit[2] : all).filter(k => all.includes(k));
}

/* NOT (a AND b AND c) == (NOT a) OR (NOT b) OR (NOT c). Flipping eq<->ne keeps
   it NULL-safe, which matters: "no play action" must still return the plays FTN
   never charted rather than dropping them, since NULL <> '1' is NULL in SQL. */
function negate(conds) {
  return conds.map(([col, op, val]) => [col, op === "ne" ? "eq" : "ne", val]);
}

function subGroup(key, role) {
  for (const [group, opts] of SUBS[role || "any"] || []) {
    for (const [k] of opts) if (k === key) return group;
  }
  return null;
}

function subConditions(key, role) {
  for (const [, opts] of SUBS[role || "any"] || []) {
    for (const [k, , conds] of opts) if (k === key) return conds;
  }
  return null;
}

function roleExclusions(role, chosen) {
  const rule = ROLE_EXCLUDE[role || ""];
  if (!rule) return [];
  if ((chosen || []).some(k => rule.unless.includes(k))) return [];
  return rule.conds;
}

// "ne" stays NULL-safe so plays with no charting still pass the filter
function sqlCondition(col, op, val, coltype) {
  const v = coltype === "TEXT" ? val : Number(val);
  return op === "ne"
    ? [`("${col}" IS NULL OR "${col}" <> ?)`, v]
    : [`"${col}" = ?`, v];
}

let schema = null;
function cols() {
  if (!schema) {
    schema = {};
    for (const r of db.selectObjects("PRAGMA table_info(plays)")) schema[r.name] = r.type;
  }
  return schema;
}

/* The season/team/column/text filters, shared by the search and the facet
   counts. Without this the chip labels report a player's whole season while the
   result list shows only what survives the other filters. */
function baseFilters(q) {
  const c = cols(), where = [], args = [];
  for (const spec of q.f || []) {
    const [col, op = "eq", ...rest] = spec.split(":");
    let val = rest.join(":");
    if (op === "like") val = likePattern(val);
    if (col === "__team") {           // either side of the ball, not just offense
      where.push('("posteam" = ? OR "defteam" = ?)');
      args.push(val, val);
      continue;
    }
    const g = groups()[col];
    if (g) {                          // merged column: one filter, every slot
      if (!(op in OPS)) continue;
      const [frag, vals] = groupSql(g, op, val);
      if (frag) { where.push(frag); args.push(...vals); }
      continue;
    }
    if (!(col in c) || !(op in OPS)) continue;
    if (op === "notnull" || op === "isnull") { where.push(`"${col}" ${OPS[op]}`); continue; }
    where.push(`"${col}" ${OPS[op]} ?`);
    args.push(c[col] === "TEXT" ? val : Number(val));
  }
  for (const t of q.q || []) {
    if (!t.trim()) continue;
    where.push(`"desc" LIKE ?`);
    args.push("%" + t.trim() + "%");
  }
  return [where, args];
}

/* Everything that narrows the play list: the base filters, the facet selection
   and the player's own participation columns. profile() needs the very same
   scope -- without it the dictionary describes the whole index while the list
   under it shows one player's afternoon. */
function scopeFilters(q) {
  const c = cols();
  const [where, args] = baseFilters(q);
  // A player id may appear in any of ~43 participant columns (passer, rusher,
  // receiver, tacklers, sack, fumble, ...). Matching the id catches involvement
  // the description text never names -- 144 plays vs 82 for Will Anderson.
  // excluded options
  for (const key of q.nsub || []) {
    const cs = subConditions(key, q.role);
    if (!cs) continue;
    const frags = [], vals = [];
    for (const [col, op, val] of negate(cs)) {
      if (!(col in c)) continue;
      const [f, v] = sqlCondition(col, op, val, c[col]);
      frags.push(f); vals.push(v);
    }
    if (frags.length) { where.push("(" + frags.join(" OR ") + ")"); args.push(...vals); }
  }

  let conds = [];
  for (const key of q.sub || []) conds = conds.concat(subConditions(key, q.role) || []);
  conds = conds.concat(roleExclusions(q.role, q.sub));
  for (const [col, op, val] of conds) {
    if (!(col in c)) continue;
    const [frag, v] = sqlCondition(col, op, val, c[col]);
    where.push(frag);
    args.push(v);
  }
  if (q.player) {
    const ids = roleColumns(q.role, c);
    if (ids.length) {
      where.push("(" + ids.map(k => `"${k}" = ?`).join(" OR ") + ")");
      ids.forEach(() => args.push(q.player));
    }
  }
  return [where, args];
}

/* ---------- the measure that picked the play ----------
   The play list shows EPA because EPA is on every play. Any OTHER measure you
   filtered by is invisible: "Air EPA >= 0" returns thirty plays and not one of
   them says what its air EPA was, so the filter can be trusted but not read.
   `show` names the extra columns a row carries, and the same resolution answers
   "sort by that column" -- you cannot rank by a number you may not select.
   Mirrors roles.py. */
const SHOW_MAX = 4;          // four extra measures is already a long meta line

// SQL for one displayable/sortable column, or null if this index has no such
// thing. A merged column reads as its first filled slot, which is what the
// panel shows under that name everywhere else.
function valueSql(col) {
  const g = groups()[col];
  if (g) return `COALESCE(${g.members.map(m => `"${m}"`).join(",")})`;
  return col in cols() ? `"${col}"` : null;
}

function showColumns(wanted) {
  const out = [];
  for (let col of wanted) {
    col = (col || "").trim();
    if (!col || CORE.includes(col) || out.includes(col)) continue;
    if (valueSql(col) === null) continue;
    out.push(col);
    if (out.length >= SHOW_MAX) break;
  }
  return out;
}

/* ORDER BY for the play list. `game` walks the game in play order; `epa` and
   `epa_asc` are the two the panel has always offered; anything else is
   "<column>:desc" or "<column>:asc" for a column the user picked.

   NULLs sort last in both directions. A play with no air EPA is not the
   smallest air EPA, and floating it to the top of "Air EPA low" would bury the
   answer under every play the measure does not apply to. */
function orderSql(order) {
  const fixed = { epa: " ORDER BY epa DESC", epa_asc: " ORDER BY epa ASC" };
  if (order in fixed) return fixed[order];
  const cut = String(order || "").lastIndexOf(":");
  const col = cut < 0 ? "" : String(order).slice(0, cut);
  const dir = cut < 0 ? "" : String(order).slice(cut + 1);
  const expr = col ? valueSql(col) : null;
  if (expr === null || (dir !== "asc" && dir !== "desc"))
    return " ORDER BY old_game_id, play_id";
  return ` ORDER BY ${expr} IS NULL, ${expr} ${dir.toUpperCase()}`;
}

function search(q) {
  const [where, args] = scopeFilters(q);
  // whatever the caller filtered or sorted by, carried on the row so the number
  // that selected the play is visible next to the play
  const show = showColumns(String(q.show || "").split(","));
  const sel = CORE.map(x => `"${x}"`)
    .concat(show.map(c => `${valueSql(c)} AS "${c}"`));
  let sql = "SELECT " + sel.join(",") + " FROM plays";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += orderSql(q.order);
  sql += " LIMIT " + Math.min(Number(q.limit) || 300, 1000);
  const rows = db.selectObjects(sql, args);
  for (const r of rows) r.week_slug = weekSlug(r.season_type, r.week);
  return rows;
}

/* nflverse's own field descriptions, baked by build_dictionary.py and shipped
   with the extension so the panel needs no network to explain a column.
   offscreen.html sits at the extension root, so a relative fetch resolves. */
let _dict = null;
async function describe() {
  if (_dict) return _dict;
  try {
    _dict = await (await fetch("dictionary.json")).json();
  } catch { _dict = {}; }
  return _dict;
}

// A column's values are only worth listing when there are few enough to read.
const LIST_MAX = 25;

/* Whether a column reads as a short enumeration or as a range is a property of
   the column, not of whatever you have filtered down to. Deciding it from the
   filtered rows would morph the control as you narrow: air_epa is a range over
   a season and would turn into a list of six raw floats the moment you pick one
   receiver. Cached per column -- this is the scan profile() used to do before
   it learned to scope. Mirrors server.py. */
const _shape = new Map();
function shapeDistinct(col, arms) {
  if (_shape.has(col)) return _shape.get(col);
  const src = arms.map(m => `SELECT "${m}" v FROM plays`).join(" UNION ALL ");
  const n = db.selectArrays(`SELECT COUNT(DISTINCT v) FROM (${src})`)[0][0];
  _shape.set(col, n);
  return n;
}

/* What a column actually holds. The shape depends on the column: a yes/no gets
   its two counts, a short enumeration gets its values, a number gets its range,
   free text gets a sample plus a distinct count. One size genuinely does not
   fit -- epa's five most common values are noise, pass_location's are the whole
   vocabulary. Mirrors server.py. */
async function profile(col, members, scope) {
  // a merged column has no schema entry of its own; its type is its slots' type,
  // and without this it falls through to the numeric branch and blows up on a
  // player name
  const coltype = cols()[col] || (members ? cols()[members[0]] : null);
  const arms = members || [col];
  const [w, a] = scope || [[], []];
  const tail = w.length ? " WHERE " + w.join(" AND ") : "";
  const src = arms.map(m => `SELECT "${m}" v FROM plays${tail}`).join(" UNION ALL ");
  // every arm of the union carries the same WHERE, so it wants its own copy
  // of the arguments
  const sa = [];
  arms.forEach(() => sa.push(...a));
  const [filled, distinct] =
    db.selectArrays(`SELECT COUNT(v), COUNT(DISTINCT v) FROM (${src})`, sa)[0];
  const dict = await describe();
  // a merged column is ours, not nflverse's, so it has no dictionary entry of its
  // own: borrow the one for the slot it leads with. That it spans several columns
  // is plumbing -- the panel shows it on the badge, not in the wording.
  let d = dict[col] || "";
  if (members && !d) d = dict[members[0]] || "";
  const out = { col, filled, distinct, desc: d };
  if (!filled) { out.kind = "empty"; return out; }
  if (binaryColumns().includes(col)) {
    const yes = db.selectArrays(`SELECT COUNT(*) FROM (${src}) WHERE v IN ('1',1)`, sa)[0][0];
    return Object.assign(out, { kind: "yesno", yes, no: filled - yes });
  }
  if (shapeDistinct(col, arms) <= LIST_MAX) {
    return Object.assign(out, { kind: "list", values: db.selectObjects(
      `SELECT v, COUNT(*) n FROM (${src}) WHERE v IS NOT NULL GROUP BY 1 ORDER BY n DESC`, sa) });
  }
  if (coltype === "REAL" || coltype === "INTEGER") {
    const [min, max, avg] = db.selectArrays(
      `SELECT MIN(v), MAX(v), AVG(v) FROM (${src})`, sa)[0];
    return Object.assign(out, { kind: "number", min, max, avg });
  }
  return Object.assign(out, { kind: "text", values: db.selectObjects(
    `SELECT v, COUNT(*) n FROM (${src}) WHERE v IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 4`, sa) });
}

/* ---------- message API ---------- */
async function handle(op, payload) {
  if (op === "status") return { ready: !!db, meta };
  await ensureDb(p => chrome.runtime.sendMessage({ all22: "progress", ...p }).catch(() => {}),
                 payload.manifestUrl);
  if (op === "meta") {
    const col1 = s => db.selectArrays(s).map(r => r[0]);
    return {
      count: db.selectArrays("SELECT COUNT(*) FROM plays")[0][0],
      columns: Object.keys(cols()).length,
      seasons: col1("SELECT DISTINCT season FROM plays ORDER BY 1"),
      weeks: col1("SELECT DISTINCT week FROM plays ORDER BY week"),
      teams: col1("SELECT DISTINCT posteam FROM plays WHERE posteam IS NOT NULL ORDER BY 1"),
      // columns that arrive days after the play, and how far each one has got
      // -- the panel flags them where they are picked
      late: lateCoverage(),
    };
  }
  if (op === "columns") {
    const dict = await describe(), c = cols();
    return { columns: c, groups: Object.values(groups()), binary: binaryColumns(),
             redundant: redundantFlags(),
             describe: Object.fromEntries(
               Object.keys(c).filter(k => dict[k]).map(k => [k, dict[k]])) };
  }
  if (op === "values") {
    const c = cols(), gs = groups();
    const want = (payload.cols ? String(payload.cols).split(",") : [payload.col])
      .filter(Boolean).slice(0, 40);      // one screenful of dictionary rows
    // the same scope the play list is under, so the range and the counts
    // describe the selection you are looking at rather than the whole index
    const scope = scopeFilters(payload);
    const out = {};
    for (const col of want) {
      const g = gs[col];
      if (!g && !(col in c)) continue;
      out[col] = await profile(col, g ? g.members : null, scope);
    }
    if (payload.cols) return { profiles: out };
    const first = Object.values(out)[0];
    if (!first) return { error: "unknown column" };
    // the hint line has always read .values off this endpoint
    return Object.assign({ values: [] }, first);
  }
  if (op === "players") {
    const t = "%" + String(payload.q || "").trim() + "%";
    return db.selectObjects(
      `SELECT gsis_id, nfl_id, name, short, position, team, jersey, last_season, plays
         FROM players
        WHERE name LIKE ?1 OR short LIKE ?1
        ORDER BY plays DESC, last_season DESC, name
        LIMIT 10`, [t]);
  }
  if (op === "player_roles") {
    const c = cols(), out = [];
    const [rw, ra] = baseFilters(payload);
    for (const [key, label] of ROLES) {
      const ids = roleColumns(key, c);
      if (!ids.length) continue;
      const exF = [], exV = [];
      for (const [col, op2, val] of roleExclusions(key, [])) {
        if (!(col in c)) continue;
        const [f, v] = sqlCondition(col, op2, val, c[col]);
        exF.push(f); exV.push(v);
      }
      const sql = "SELECT COUNT(*) FROM plays WHERE (" + ids.map(k => `"${k}" = ?`).join(" OR ") + ")" +
                  (exF.length ? " AND " + exF.join(" AND ") : "") +
                  (rw.length ? " AND " + rw.join(" AND ") : "");
      const n = db.selectArrays(sql,
        ids.map(() => payload.player).concat(exV, ra))[0][0];
      if (n || key === "any") out.push({ key, label, n });
    }
    // order by what this position actually does
    const prof = POSITION_PROFILES[(payload.position || "").toUpperCase()];
    const promoted = prof ? prof[1] : [];
    out.sort((a, b) => {
      const ia = promoted.indexOf(a.key), ib = promoted.indexOf(b.key);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return 0;
    });
    const def = prof && out.some(r => r.key === prof[0] && r.n) ? prof[0] : "any";
    return { default: def, roles: out };
  }
  if (op === "player_subfilters") {
    const c = cols(), role = payload.role || "any";
    const active = payload.sub || [];
    const nactive = payload.nsub || [];
    const ids = roleColumns(role, c);
    const [bw, ba] = baseFilters(payload);        // same filters the list uses
    let base = "(" + ids.map(k => `"${k}" = ?`).join(" OR ") + ")";
    let bargs = ids.map(() => payload.player);
    if (bw.length) { base += " AND " + bw.join(" AND "); bargs = bargs.concat(ba); }
    const build = conds => {
      const f = [], v = [];
      for (const [col, op2, val] of conds) {
        if (!(col in c)) continue;
        const [fr, vv] = sqlCondition(col, op2, val, c[col]);
        f.push(fr); v.push(vv);
      }
      return [f, v];
    };
    const count = conds => {
      const [f, v] = build(conds);
      return db.selectArrays(
        "SELECT COUNT(*) FROM plays WHERE " + base + (f.length ? " AND " + f.join(" AND ") : ""),
        bargs.concat(v))[0][0];
    };
    // one OR-ed fragment per excluded option
    const exclFrag = keys => {
      const f = [], v = [];
      for (const k of keys) {
        const cs = subConditions(k, role);
        if (!cs) continue;
        const fr = [], vv = [];
        for (const [col, op2, val] of negate(cs)) {
          if (!(col in c)) continue;
          const [a, b] = sqlCondition(col, op2, val, c[col]);
          fr.push(a); vv.push(b);
        }
        if (fr.length) { f.push("(" + fr.join(" OR ") + ")"); v.push(...vv); }
      }
      return [f, v];
    };
    const countWith = (conds, xf, xv) => {
      const [f, v] = build(conds);
      const all = f.concat(xf || []);
      return db.selectArrays(
        "SELECT COUNT(*) FROM plays WHERE " + base + (all.length ? " AND " + all.join(" AND ") : ""),
        bargs.concat(v, xv || []))[0][0];
    };
    let allsub = [];
    for (const k of active) allsub = allsub.concat(subConditions(k, role) || []);
    const [nf, nv] = exclFrag(nactive);
    const total = countWith(allsub.concat(roleExclusions(role, active)), nf, nv);
    const out = [];
    for (const [gname, opts] of SUBS[role] || []) {
      // narrow by the OTHER dimensions only, so the row you just used survives
      let other = [];
      for (const k of active) {
        if (subGroup(k, role) !== gname) other = other.concat(subConditions(k, role) || []);
      }
      const [of_, ov] = exclFrag(nactive.filter(k => subGroup(k, role) !== gname));
      const gtotal = countWith(other.concat(roleExclusions(role, [])), of_, ov);
      const items = [];
      for (const [key, label, oconds] of opts) {
        const frags = [], vals = [];
        let skip = false;
        for (const [col, op2, val] of oconds.concat(other, roleExclusions(role, [key]))) {
          if (!(col in c)) { skip = true; break; }
          const [f, v] = sqlCondition(col, op2, val, c[col]);
          frags.push(f); vals.push(v);
        }
        if (skip || !frags.length) continue;
        const n = db.selectArrays(
          `SELECT COUNT(*) FROM plays WHERE ${base} AND ${frags.concat(of_).join(" AND ")}`,
          bargs.concat(vals, ov))[0][0];
        items.push({ key, label, n });
      }
      const nonzero = items.filter(i => i.n);
      out.push({
        group: gname,
        options: items,
        // worth showing at all: genuinely partitions the set
        useful: nonzero.length >= 2 && Math.max(...items.map(i => i.n)) < gtotal,
      });
    }
    return { total, groups: out };
  }
  if (op === "search") return search(payload);
  return { error: "unknown op " + op };
}

chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  if (msg.target !== "offscreen") return;
  handle(msg.op, msg.payload || {})
    .then(r => respond({ ok: true, data: r }))
    .catch(e => respond({
      ok: false,
      error: "[offscreen] " + String(e && e.message || e),
      where: "offscreen",
      has: { chrome: typeof chrome, storage: typeof (chrome && chrome.storage),
             runtime: typeof (chrome && chrome.runtime) },
      stack: String(e && e.stack || "").split("\n").slice(0, 4).join(" | "),
    }));
  return true;
});
