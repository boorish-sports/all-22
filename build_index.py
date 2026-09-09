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

# numeric columns get REAL affinity so range filters (epa > 1.5) sort correctly
NUMERIC_HINT = ("epa", "wp", "wpa", "yards", "yardline", "prob", "cpoe", "air",
                "score", "time", "spread", "total", "seconds",
                "count", "ydstogo", "down", "qtr", "week", "temp", "wind")
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


def is_num(col, samples):
    if col in FORCE_TEXT or col.endswith("_id"):
        return False
    vals = [v for v in samples if v not in ("", "NA", None)]
    if not vals:
        return False
    if not any(h in col for h in NUMERIC_HINT):
        return False
    ok = 0
    for v in vals:
        try: float(v); ok += 1
        except ValueError: pass
    return ok / len(vals) > 0.9


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
        sample = [row for _, row in zip(range(400), rd)]
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
            types[col] = "REAL" if is_num(col, [r[src_i] for r in sample if src_i < len(r)]) else "TEXT"
    print("  columns: %d (%d numeric)" % (len(header), sum(v == "REAL" for v in types.values())))

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
                        try: out.append(int(float(v)))
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


def publish(seasons):
    """Emit the gzipped artifact plus a manifest the extension polls."""
    out = os.path.join(DATA, "dist")
    os.makedirs(out, exist_ok=True)
    name = "plays_%s.db.gz" % "-".join(str(s) for s in seasons)
    gz = os.path.join(out, name)
    # mtime=0: gzip stamps the build time into its header by default, which would
    # change the sha256 on every run and make the "publish only when changed"
    # check fire daily -- forcing every consumer to re-download an identical file.
    with open(DB, "rb") as f, open(gz, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw, mtime=0) as g:
            shutil.copyfileobj(f, g)
    h = hashlib.sha256(open(gz, "rb").read()).hexdigest()

    # The gzip/SQLite bytes depend on the zlib and SQLite builds, so the same
    # data hashes differently on a different Python. Fingerprint the SOURCE
    # files instead: that is what "did the data change" actually means, and it
    # survives runner-image updates that would otherwise force a pointless
    # 15 MB re-download for every consumer.
    src = hashlib.sha256()
    for path in sorted(p for p in SOURCES if os.path.exists(p)):
        src.update(os.path.basename(path).encode())
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                src.update(chunk)
    content = src.hexdigest()
    con = sqlite3.connect(DB)
    manifest = {
        "file": name,
        "sha256": h,            # of the .db.gz, for the client to verify
        "content_hash": content,  # of the inputs, for change detection
        "bytes": os.path.getsize(gz),
        "rows": con.execute("SELECT COUNT(*) FROM plays").fetchone()[0],
        "seasons": [int(s) for s in seasons],
        "columns": len(con.execute("SELECT * FROM plays LIMIT 1").description),
    }
    con.close()
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("  artifact: %s (%.1f MB gz)  sha256 %s…  content %s…"
          % (name, manifest["bytes"] / 1e6, h[:10], content[:10]))


if __name__ == "__main__":
    args = sys.argv[1:]
    full = "--full" in args
    yrs = [int(a) for a in args if not a.startswith("--")] or [2025]
    main(yrs, full=full)
