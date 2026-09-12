#!/usr/bin/env python3
"""Index nflverse play-by-play into SQLite, keeping EVERY column so any pbp field
is filterable (tacklers, fumbles, EPA, CPOE, personnel, win prob, ...).

These are the same files nfl_data_py.import_pbp_data() reads. Stdlib only.
"""
import csv, gzip, hashlib, json, os, re, shutil, sqlite3, sys, urllib.request

csv.field_size_limit(1 << 24)
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
DB = os.path.join(DATA, "plays.db")
PBP = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_%d.csv.gz"
PLAYERS = "https://github.com/nflverse/nflverse-data/releases/download/players_components/players.csv"
# FTN Fantasy's charting layer, published free by nflverse (2022+). Adds the
# things the base feed cannot know: play action, RPO, screen, motion, pressure
# counts, drops, throwaways.
FTN = "https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_%d.csv"

FTN_COLS = ["starting_hash", "qb_location", "n_offense_backfield", "n_defense_box",
            "is_no_huddle", "is_motion", "is_play_action", "is_screen_pass", "is_rpo",
            "is_trick_play", "is_qb_out_of_pocket", "is_interception_worthy",
            "is_throw_away", "read_thrown", "is_catchable_ball", "is_contested_ball",
            "is_created_reception", "is_drop", "is_qb_sneak", "n_blitzers",
            "n_pass_rushers", "is_qb_fault_sack"]
FTN_INT = {"n_offense_backfield", "n_defense_box", "n_blitzers", "n_pass_rushers"}


def load_ftn(season):
    """(game_id, play_id) -> charted values, or {} if that season isn't charted."""
    path = os.path.join(DATA, "ftn_%d.csv" % season)
    try:
        fetch(FTN % season, path)
    except Exception:
        print("  no FTN charting for %d" % season)
        return {}
    out = {}
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for r in csv.DictReader(f):
            key = (r.get("nflverse_game_id"), r.get("nflverse_play_id"))
            row = []
            for c in FTN_COLS:
                v = (r.get(c) or "").strip()
                if v in ("", "NA"):
                    row.append(None)
                elif v == "TRUE":
                    row.append("1")
                elif v == "FALSE":
                    row.append("0")
                elif c in FTN_INT:
                    try: row.append(int(float(v)))
                    except ValueError: row.append(None)
                else:
                    row.append(v)
            out[key] = row
    print("  FTN %d: %d charted plays" % (season, len(out)))
    return out

# identifiers must stay exact -- never floats, or 2025090400 becomes 2025090400.0
FORCE_INT = {"play_id", "season", "week", "qtr", "down"}
FORCE_TEXT = {"game_id", "old_game_id", "nfl_api_id"}

# Columns worth ~40% of the file that nobody filters on: running score/EPA/WP
# totals (derivable), per-outcome probability splits, venue metadata. Dropping
# these takes a season from 101 MB to 61 MB, which is what makes shipping the
# index to a browser practical. Pass --full to keep everything.
SKIP = re.compile(
    r"^(total_(home|away)_|posteam_score|defteam_score|home_score|away_score)"
    r"|_wpa$|^(no_score|opp_fg|opp_safety|opp_td|fg_|safety_|td_)prob$"
    r"|^drive_(start|end)_(yard_line|transition)$|^(away|home)_coach$"
    r"|^(stadium|weather|surface|roof|time_of_day|start_time|nfl_api_id)")


SOURCES = []          # source files this build consumed


def fetch(url, path):
    if path not in SOURCES:
        SOURCES.append(path)
    if os.path.exists(path):
        print("  cached  %s" % os.path.basename(path)); return
    print("  fetching %s" % os.path.basename(path))
    req = urllib.request.Request(url, headers={"User-Agent": "all-22/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)


def column_type(col, samples):
    """INTEGER / REAL / TEXT, from what the column actually holds.

    This used to also require the column NAME to contain one of twenty
    substrings ("epa", "prob", "yards", ...). Anything else was TEXT however
    numeric its values, which is how cp, ep, xpass, pass_oe and the whole
    xyac_* family ended up as text: `cp <= 0.6` became a string comparison and
    the panel refused the filter outright. What a column holds is the only
    thing that can answer this. Identifiers are the exception and are named.
    """
    if col in FORCE_TEXT or col.endswith("_id"):
        return "TEXT"
    vals = [v for v in samples if v not in ("", "NA", None)]
    if not vals:
        return "TEXT"
    ok = whole = 0
    for v in vals:
        try: f = float(v)
        except ValueError: continue
        ok += 1
        whole += f.is_integer()
    if ok / len(vals) <= 0.9:
        return "TEXT"
    # an integral column stays integral: a jersey number or a drive number
    # offered as 12.0 in a filter box is worse than useless
    return "INTEGER" if whole == ok else "REAL"


def main(seasons, full=False):
    os.makedirs(DATA, exist_ok=True)
    players_csv = os.path.join(DATA, "players.csv")
    fetch(PLAYERS, players_csv)
    paths = []
    for s in seasons:
        p = os.path.join(DATA, "pbp_%d.csv.gz" % s)
        fetch(PBP % s, p); paths.append(p)

    # schema from the first file's header, typed from a sample of rows
    with gzip.open(paths[0], "rt", newline="", encoding="utf-8", errors="replace") as f:
        rd = csv.reader(f)
        raw_header = next(rd)
        # typing is decided from these rows, so read enough of them that a
        # column which is whole-numbered early but fractional later is not
        # mistaken for an integer one
        sample = [row for _, row in zip(range(20000), rd)]
    keep_idx = [i for i, c in enumerate(raw_header) if full or not SKIP.search(c)]
    header = [raw_header[i] for i in keep_idx] + FTN_COLS
    if not full:
        print("  dropping %d low-value columns (--full keeps them)"
              % (len(raw_header) - len(keep_idx)))
    types = {}
    for col in FTN_COLS:
        types[col] = "INTEGER" if col in FTN_INT else "TEXT"
    for col, src_i in zip(header, keep_idx):
        if col in FORCE_INT:
            types[col] = "INTEGER"
        else:
            types[col] = column_type(col, [r[src_i] for r in sample if src_i < len(r)])
    print("  columns: %d (%d real, %d integer, %d text)"
          % (len(header), sum(v == "REAL" for v in types.values()),
             sum(v == "INTEGER" for v in types.values()),
             sum(v == "TEXT" for v in types.values())))

    con = sqlite3.connect(DB)
    con.execute("PRAGMA journal_mode=OFF"); con.execute("PRAGMA synchronous=OFF")
    con.executescript("DROP TABLE IF EXISTS plays_fts; DROP TABLE IF EXISTS plays; DROP TABLE IF EXISTS players; DROP TABLE IF EXISTS games;")
    con.execute("CREATE TABLE plays (%s)" % ",".join('"%s" %s' % (c, types[c]) for c in header))
    con.execute("""CREATE TABLE players (
        gsis_id TEXT PRIMARY KEY, nfl_id TEXT, name TEXT, short TEXT,
        position TEXT, team TEXT, jersey TEXT, last_season TEXT, plays INTEGER DEFAULT 0)""")
    # old_game_id -> NFL Pro fapiGameId (UUID); filled in by the extension on demand
    con.execute("CREATE TABLE games (old_game_id TEXT PRIMARY KEY, fapi_game_id TEXT)")

    with open(players_csv, newline="", encoding="utf-8") as f:
        rows = []
        for r in csv.DictReader(f):
            if not r.get("gsis_id"):
                continue
            # play descriptions use "W.Anderson"; older rows have no short_name,
            # so synthesise it the same way
            short = (r.get("short_name") or "").strip()
            if not short and r.get("first_name") and r.get("last_name"):
                short = "%s.%s" % (r["first_name"][0], r["last_name"])
            rows.append((r["gsis_id"], r.get("nfl_id") or "", r.get("display_name", ""),
                         short, r.get("position", ""), r.get("latest_team", ""),
                         r.get("jersey_number", ""), r.get("last_season", ""), 0))
    con.executemany("INSERT OR REPLACE INTO players VALUES (?,?,?,?,?,?,?,?,?)", rows)
    print("  players: %d" % len(rows))

    ins = "INSERT INTO plays VALUES (%s)" % ",".join("?" * len(header))
    numidx = {header.index(c) for c in header if types[c] == "REAL"}
    intidx = {header.index(c) for c in header if types[c] == "INTEGER"}
    total = 0
    gid_i = raw_header.index("game_id")
    pid_i = raw_header.index("play_id")
    blank = [None] * len(FTN_COLS)
    for season, p in zip(seasons, paths):
        ftn = load_ftn(int(season))
        n = matched = 0
        with gzip.open(p, "rt", newline="", encoding="utf-8", errors="replace") as f:
            rd = csv.reader(f)
            head = next(rd)
            if head != raw_header:
                print("  !! schema differs in %s, skipping" % os.path.basename(p)); continue
            batch = []
            for full_row in rd:
                if len(full_row) != len(raw_header):
                    continue
                row = [full_row[i] for i in keep_idx]
                chart = ftn.get((full_row[gid_i], full_row[pid_i]))
                if chart:
                    matched += 1
                row = row + (chart or blank)
                out = []
                for i, v in enumerate(row):
                    if v is None or v in ("", "NA"):
                        out.append(None)
                    elif i in intidx:
                        # INTEGER affinity is a hint, not a promise: if a
                        # fractional value turns up in a column the sample said
                        # was whole, keep it rather than truncating it
                        try:
                            f = float(v)
                            out.append(int(f) if f.is_integer() else f)
                        except ValueError: out.append(None)
                    elif i in numidx:
                        try: out.append(float(v))
                        except ValueError: out.append(None)
                    else:
                        out.append(v)
                batch.append(out)
                if len(batch) >= 4000:
                    con.executemany(ins, batch); n += len(batch); batch = []
            if batch:
                con.executemany(ins, batch); n += len(batch)
        print("  %s: %d rows (%d with FTN charting)" % (os.path.basename(p), n, matched))
        total += n

    for idx, col in [("idx_game", "old_game_id"), ("idx_sw", "season"), ("idx_pos", "posteam"),
                     ("idx_def", "defteam"), ("idx_pt", "play_type")]:
        con.execute('CREATE INDEX %s ON plays("%s")' % (idx, col))

    # How often each player actually appears in the indexed plays, across every
    # participant column (passer, rusher, receiver, tacklers, sacks, ...). Search
    # ranks by this so you get the guy who is in your data, not a 1987 namesake.
    pid = [c for c in header if c.endswith("_player_id")]
    if pid:
        # count DISTINCT plays: one play can name the same player in several
        # columns (sack + tackle-for-loss + solo tackle), which would treble-count
        union = " UNION ALL ".join(
            'SELECT rowid AS rid, "%s" AS id FROM plays WHERE "%s" IS NOT NULL' % (c, c)
            for c in pid)
        con.execute("""UPDATE players SET plays = COALESCE((
              SELECT COUNT(DISTINCT t.rid) FROM (%s) t WHERE t.id = players.gsis_id), 0)"""
                    % union)
        print("  participation counted across %d id columns" % len(pid))
    con.execute("CREATE INDEX idx_pl_name ON players(name)")
    con.execute("CREATE INDEX idx_pl_short ON players(short)")
    # No FTS index: it roughly doubles the file for a speedup nobody can feel,
    # and fts5 chokes on "." so player names like T.Kelce error out.
    con.commit()
    con.execute("VACUUM")
    con.commit()
    con.close()
    print("  total: %d plays, %d columns -> %s (%.0f MB)"
          % (total, len(header), DB, os.path.getsize(DB) / 1e6))
    publish(seasons)


def gzip_file(path, gz):
    # mtime=0: gzip stamps the build time into its header by default, which would
    # change the sha256 on every run and make "publish only when changed" fire
    # daily -- forcing every consumer to re-download an identical file.
    with open(path, "rb") as f, open(gz, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as g:
            shutil.copyfileobj(f, g)
    return hashlib.sha256(open(gz, "rb").read()).hexdigest()


def schema_ddl(con):
    """(table, CREATE statement) for every table and index, in a fixed order."""
    return con.execute(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type IN ('table','index')"
        " AND sql IS NOT NULL ORDER BY type DESC, name").fetchall()


def content_id(con, schema_hash, table, where, args, order):
    """Fingerprint of what a part HOLDS, independent of the bytes it is stored in.

    The gzip/SQLite bytes depend on the zlib and SQLite builds, so the same rows
    hash differently on a different runner, and a hash of the source files is no
    use once a season is split by week (nflverse ships one file per season).
    The rows themselves, in a fixed order, are what "did this part change"
    actually means. The schema goes in too: retyping a column changes every
    consumer's index while leaving the rows untouched.
    """
    h = hashlib.sha256(schema_hash.encode())
    cur = con.execute('SELECT * FROM "%s"%s ORDER BY %s' % (table, where, order), args)
    for row in cur:
        h.update(repr(row).encode())
        h.update(b"\n")
    return h.hexdigest()


def publish(seasons):
    """Emit the index as PARTS plus a manifest the extension polls.

    One whole-season file per completed season, one file per week of the
    newest season, and one for the players table. Consumers keep a merged copy
    and fetch only the parts whose content id moved: a completed season is
    downloaded once and never again, and a mid-week revision costs one week's
    file rather than the whole index. Every part carries the same schema, so
    the client can copy rows between them with a plain INSERT ... SELECT.
    """
    out = os.path.join(DATA, "dist")
    os.makedirs(out, exist_ok=True)
    for old in os.listdir(out):
        if old.endswith(".db.gz"):
            os.remove(os.path.join(out, old))

    src = sqlite3.connect(DB)
    ddl = schema_ddl(src)
    schema = hashlib.sha256("\n".join(s for _, s in ddl).encode()).hexdigest()
    ddl_for = lambda table: [s for t, s in ddl if t == table]
    present = [s for s in seasons
               if src.execute("SELECT 1 FROM plays WHERE season=? LIMIT 1", (s,)).fetchone()]
    specs = []           # (key, file, table, where, args, order, scope)
    for s in present[:-1]:
        specs.append(("%d" % s, "plays_%d.db.gz" % s, "plays", " WHERE season=?", (s,),
                      "game_id, play_id", {"season": s}))
    if present:
        s = present[-1]
        for (w,) in src.execute("SELECT DISTINCT week FROM plays WHERE season=? ORDER BY 1", (s,)):
            specs.append(("%d-w%02d" % (s, w), "plays_%d_w%02d.db.gz" % (s, w), "plays",
                          " WHERE season=? AND week=?", (s, w), "game_id, play_id",
                          {"season": s, "week": w}))
    specs.append(("players", "players.db.gz", "players", "", (), "gsis_id", {}))
    src.close()

    parts, total = [], 0
    tmp = os.path.join(out, "part.db")
    for key, name, table, where, args, order, scope in specs:
        if os.path.exists(tmp):
            os.remove(tmp)
        con = sqlite3.connect(tmp, isolation_level=None)
        con.execute("PRAGMA journal_mode=OFF")
        con.execute("ATTACH ? AS src", (DB,))
        for s in ddl_for(table):
            con.execute(s)
        if table == "players":
            # the extension fills games on demand; it rides with the smallest part
            for s in ddl_for("games"):
                con.execute(s)
        con.execute('INSERT INTO "%s" SELECT * FROM src."%s"%s' % (table, table, where), args)
        rows = con.execute('SELECT COUNT(*) FROM "%s"' % table).fetchone()[0]
        con.execute("DETACH src")
        con.execute("VACUUM")
        con.close()
        gz = os.path.join(out, name)
        sha = gzip_file(tmp, gz)
        con = sqlite3.connect(DB)
        cid = content_id(con, schema, table, where, args, order)
        con.close()
        part = {"key": key, "file": name, "table": table, "sha256": sha, "id": cid,
                "bytes": os.path.getsize(gz), "rows": rows}
        part.update(scope)
        parts.append(part)
        total += part["bytes"]
        print("  part %-10s %-24s %6d rows %6.2f MB gz  id %s…" % (key, name, rows, part["bytes"] / 1e6, cid[:10]))
    os.remove(tmp)

    content = hashlib.sha256("\n".join(p["key"] + ":" + p["id"] for p in parts).encode()).hexdigest()
    con = sqlite3.connect(DB)
    manifest = {
        "version": 2,
        "content_hash": content,  # of every part's id, for change detection
        "schema": schema,         # of the DDL; a change here rebuilds every consumer's index
        "bytes": total,
        "rows": con.execute("SELECT COUNT(*) FROM plays").fetchone()[0],
        "seasons": [int(s) for s in seasons],
        "columns": len(con.execute("SELECT * FROM plays LIMIT 1").description),
        "parts": parts,
    }
    con.close()
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("  manifest: %d parts, %.1f MB gz in all, content %s…" % (len(parts), total / 1e6, content[:10]))


if __name__ == "__main__":
    args = sys.argv[1:]
    full = "--full" in args
    yrs = [int(a) for a in args if not a.startswith("--")] or [2025]
    main(yrs, full=full)
