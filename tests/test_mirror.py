#!/usr/bin/env python3
"""The mirror test.

server.py + roles.py and extension/db.js are two hand-written implementations
of one query layer, and users only ever run db.js. This runs BOTH over
data/plays.db -- the Python side over HTTP against a real server.py process,
the JavaScript side by loading the shipped db.js under Node (tests/js_side.mjs)
-- and diffs every endpoint. Exits non-zero on any divergence.

    python3 tests/test_mirror.py            # needs data/plays.db (build_index.py)
    python3 tests/test_mirror.py -v         # print every case, not just failures

Also lints the package: manifest sanity, node --check on the content scripts,
and the structural load of db.js (a brace closing handle() early fails here).
"""
import json, math, os, sqlite3, subprocess, sys, time, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DB = os.path.join(ROOT, "data", "plays.db")
sys.path.insert(0, ROOT)
import roles

VERBOSE = "-v" in sys.argv
PORT = 8799


# ------------------------------------------------------------ cases --------
def build_cases(con):
    """Every case is a query string; each side parses it with its own code."""
    pick = lambda pos: con.execute(
        "SELECT gsis_id FROM players WHERE position=? ORDER BY plays DESC, gsis_id LIMIT 1",
        (pos,)).fetchone()[0]
    qb, rb, de, lb, wr = pick("QB"), pick("RB"), pick("DE"), pick("LB"), pick("WR")
    cols = [r[1] for r in con.execute("PRAGMA table_info(plays)")]
    season = con.execute("SELECT MAX(season) FROM plays").fetchone()[0]
    gkeys = [g["key"] for g in roles.column_groups(
        {r[1]: r[2] for r in con.execute("PRAGMA table_info(plays)")})]

    cases = []
    op = lambda id_, o, qs: cases.append({"id": id_, "kind": "op", "op": o, "qs": qs})

    op("meta", "meta", "")
    op("columns", "columns", "")
    op("players", "players", "q=ander")

    # profiles: every merged column, every 6th raw column, and the ones with a
    # story (play_clock all-zero, epa numeric, desc free text, sack flag)
    sample = gkeys + cols[::6] + ["play_clock", "epa", "desc", "sack", "run_location",
                                  "pass_length", "posteam", "qtr", "yardline_100"]
    sample = list(dict.fromkeys(c for c in sample if c in cols or c in gkeys))
    for i in range(0, len(sample), 40):
        op("values_%d" % (i // 40), "values", "cols=" + ",".join(sample[i:i + 40]))
    op("values_one", "values", "col=@sack_player_name")
    op("values_bad", "values", "col=no_such_column")

    # a profile is read under the same scope as the play list, so the range it
    # reports describes the selection. The shape (list vs number) must NOT move
    # with the scope: air_epa narrowed to one QB's deep throws is a handful of
    # distinct floats, and rendering those as a clickable value list would be a
    # different control than the range the same column shows unfiltered.
    op("values_scoped_season", "values", "col=air_epa&f=season:eq:%s" % season)
    op("values_scoped_player", "values",
       "col=air_epa&player=%s&role=passer&f=season:eq:%s" % (qb, season))
    op("values_scoped_narrow", "values",
       "col=air_epa&player=%s&role=passer&sub=deep&f=season:eq:%s" % (qb, season))
    op("values_scoped_empty", "values", "col=epa&f=season:eq:1999")
    op("values_scoped_group", "values",
       "col=@sack_player_name&f=season:eq:%s" % season)
    op("values_scoped_many", "values",
       "cols=epa,air_epa,down,qtr,pass_length,desc,wind&player=%s&role=passer" % qb)
    op("values_scoped_text", "values", "col=desc&f=posteam:eq:SEA&q=touchdown")

    # searches. limit=1000 everywhere: two SQLite builds may break ORDER BY ties
    # differently, and a LIMIT that cuts through a tie would look like a diff.
    S = lambda id_, qs: op("search_" + id_, "search", qs + "&limit=1000")
    S("merged_eq", "f=@sack_player_name:eq:W.Anderson")
    S("merged_ne", "f=@sack_player_name:ne:W.Anderson&f=week:eq:1")
    S("merged_isnull_flag", "f=@sack_player_name:isnull&f=sack:eq:1")
    S("merged_notnull", "f=@forced_fumble_player_player_name:notnull&f=week:eq:2")
    S("merged_like", "f=@assist_tackle_player_name:like:Ander&order=epa")
    S("merged_gt_real", "f=@fumble_recovery_yards:gt:10")
    S("like_anchored", "f=desc:like:(Shotgun)%25&f=week:eq:1&f=qtr:eq:1")
    S("like_contains", "f=desc:like:scramble&f=week:eq:3")
    S("team_text_order", "q=touchdown&f=__team:eq:HOU&f=play_type:eq:pass&order=epa_asc")
    S("numeric_gt", "f=epa:gt:2&f=qtr:eq:4")
    S("numeric_lte_notnull", "f=play_clock:notnull&f=epa:lte:-3")
    S("binary_yes", "f=is_play_action:eq:1&f=week:eq:1&f=down:eq:3")
    S("binary_no", "f=shotgun:eq:0&f=week:eq:1&f=down:eq:3&f=play_type:eq:pass")
    S("bad_numeric", "f=epa:gt:abc&f=week:eq:1")
    S("bad_op_ignored", "f=epa:bogus:1&f=week:eq:1&f=qtr:eq:1&f=down:eq:4")
    S("unknown_col_ignored", "f=nope:eq:1&f=week:eq:1&f=qtr:eq:1&f=down:eq:4")
    S("qb_passer_subs", "player=%s&role=passer&sub=play_action&sub=deep&nsub=intercepted" % qb)
    S("qb_rusher_designed", "player=%s&role=rusher&sub=designed" % qb)
    S("qb_rusher_kneel", "player=%s&role=rusher&sub=kneel" % qb)
    S("rb_rusher_default", "player=%s&role=rusher" % rb)
    S("rb_receiver_nsub", "player=%s&role=receiver&nsub=screen&nsub=incomplete" % rb)
    S("de_sack", "player=%s&role=sack" % de)
    S("lb_tackle_week", "player=%s&role=tackle&f=week:eq:5" % lb)
    S("wr_any_text", "player=%s&q=pass" % wr)
    S("player_any_role", "player=%s&role=any&f=play_type:eq:pass" % de)

    R = lambda id_, qs: op("roles_" + id_, "player_roles", qs)
    R("qb", "player=%s&position=QB" % qb)
    R("de_week", "player=%s&position=DE&f=week:eq:1" % de)
    R("rb", "player=%s&position=RB" % rb)
    R("lb_nopos", "player=%s" % lb)

    F = lambda id_, qs: op("subs_" + id_, "player_subfilters", qs)
    F("qb_passer", "player=%s&role=passer" % qb)
    F("qb_passer_active", "player=%s&role=passer&sub=play_action&sub=deep&nsub=intercepted" % qb)
    F("qb_rusher", "player=%s&role=rusher" % qb)
    F("rb_rusher_kneel", "player=%s&role=rusher&sub=kneel" % rb)
    F("wr_receiver_week", "player=%s&role=receiver&f=week:eq:4" % wr)
    F("de_any", "player=%s&role=any" % de)

    for v in ["Anderson", "%A", "A%", "", "W.Anderson"]:
        cases.append({"id": "like_" + repr(v), "kind": "like", "val": v})
    for key in gkeys:
        num = key.endswith("_yards")
        for o in ["eq", "ne", "like", "gt", "lte", "isnull", "notnull"]:
            cases.append({"id": "gsql_%s_%s" % (key, o), "kind": "group_sql", "key": key,
                          "op": o, "val": "3" if num else "W.Anderson"})
        if num:
            cases.append({"id": "gsql_%s_eq_bad" % key, "kind": "group_sql", "key": key,
                          "op": "eq", "val": "abc"})
    return cases


# ------------------------------------------------------- python side -------
def start_server():
    env = dict(os.environ, PORT=str(PORT))
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/api/meta" % PORT, timeout=1).read()
            return p
        except Exception:
            if p.poll() is not None:
                sys.exit("server.py exited: " + p.stderr.read().decode())
            time.sleep(0.1)
    p.kill()
    sys.exit("server.py did not come up on :%d" % PORT)


def py_side(cases):
    out = {}
    gcache = None
    for c in cases:
        try:
            if c["kind"] == "op":
                url = "http://127.0.0.1:%d/api/%s?%s" % (PORT, c["op"], c["qs"])
                with urllib.request.urlopen(url, timeout=60) as r:
                    out[c["id"]] = json.loads(r.read().decode())
            elif c["kind"] == "like":
                out[c["id"]] = roles.like_pattern(c["val"])
            elif c["kind"] == "group_sql":
                if gcache is None:
                    con = sqlite3.connect(DB)
                    cols = {r[1]: r[2] for r in con.execute("PRAGMA table_info(plays)")}
                    gcache = {g["key"]: g for g in roles.column_groups(cols)}
                g = gcache[c["key"]]
                frag, vals = roles.group_sql(g["members"], c["op"], c["val"], g["type"])
                out[c["id"]] = [frag, vals]
        except Exception as e:
            out[c["id"]] = {"error": str(e)}
    return out


# ------------------------------------------------------------- js side -----
def js_side(cases):
    r = subprocess.run(["node", "--no-warnings", os.path.join(HERE, "js_side.mjs")],
                       input=json.dumps(cases).encode(), capture_output=True)
    if r.returncode != 0:
        print("FAIL  db.js did not load or run under Node:\n" + r.stderr.decode())
        sys.exit(1)
    return json.loads(r.stdout.decode())


# ------------------------------------------------------------ compare ------
def norm(x):
    """Numbers compare by value (Python 2025.0 == JS 2025), keys sorted."""
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, dict):
        return {k: norm(v) for k, v in sorted(x.items())}
    if isinstance(x, list):
        return [norm(v) for v in x]
    return x


def same(a, b, path=""):
    """First difference as a string, or None."""
    if isinstance(a, float) and isinstance(b, float):
        if math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9):
            return None
        return "%s: %r != %r" % (path, a, b)
    if type(a) != type(b):
        return "%s: %s %r != %s %r" % (path, type(a).__name__, a, type(b).__name__, b)
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return "%s: keys %s != %s" % (path, sorted(a.keys() - b.keys()), sorted(b.keys() - a.keys()))
        for k in a:
            d = same(a[k], b[k], path + "." + str(k))
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return "%s: length %d != %d" % (path, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            d = same(x, y, "%s[%d]" % (path, i))
            if d:
                return d
        return None
    return None if a == b else "%s: %r != %r" % (path, a, b)


def compare(case, py, js):
    if case["kind"] == "op" and case["op"] == "search":
        for side, rows in (("py", py), ("js", js)):
            if isinstance(rows, dict) and "error" in rows and side == "py" and isinstance(js, dict) and "error" in js:
                return None  # both erred; message wording is allowed to differ
            if isinstance(rows, list) and len(rows) >= 1000:
                return "%s returned 1000 rows: tighten this case, LIMIT can split a tie" % side
        if isinstance(py, list) and isinstance(js, list):
            # order matters only through the sort key: the sequence of epa values
            # (or game/play ids) must match; within a tie the engines may differ
            key = "epa" if "order=epa" in case["qs"] else None
            if key:
                d = same([norm(r.get(key)) for r in py], [norm(r.get(key)) for r in js], "order")
                if d:
                    return d
            sk = lambda r: (str(r.get("old_game_id")), float(r.get("play_id") or 0))
            return same(norm(sorted(py, key=sk)), norm(sorted(js, key=sk)))
    return same(norm(py), norm(js))


# --------------------------------------------------------------- lint ------
def lint():
    fails = []
    man = json.load(open(os.path.join(ROOT, "extension", "manifest.json")))
    for k, v in man.get("icons", {}).items():
        if not os.path.exists(os.path.join(ROOT, "extension", v)):
            fails.append("manifest icon missing: " + v)
    if not man.get("icons"):
        fails.append("manifest has no icons (CWS rejects the package)")
    for h in man.get("host_permissions", []):
        if "localhost" in h or "127.0.0.1" in h:
            fails.append("dev host permission in manifest: " + h)
    if "web_accessible_resources" in man:
        fails.append("web_accessible_resources present; nothing uses chrome.runtime.getURL")
    for f in ("panel.js", "iso.js", "sw.js"):
        r = subprocess.run(["node", "--check", os.path.join(ROOT, "extension", f)], capture_output=True)
        if r.returncode:
            fails.append("node --check %s: %s" % (f, r.stderr.decode().strip()))
    # LATE_SOURCES names FTN's columns so the panel can flag them; build_index.py
    # decides which ones the index actually carries. A column added to one and
    # not the other is filterable but never flagged, or flagged but absent.
    import build_index
    for late in roles.LATE_SOURCES:
        if late["key"] == "ftn" and late["cols"] != build_index.FTN_COLS:
            fails.append("roles.LATE_SOURCES['ftn'] has drifted from "
                         "build_index.FTN_COLS")
        if late["marker"] not in late["cols"]:
            fails.append("%s: marker %r is not one of its own columns"
                         % (late["key"], late["marker"]))

    src = open(os.path.join(ROOT, "extension", "panel.js")).read()
    # the argument that keeps the project alive: every NFL request goes through secured()
    if src.count("$api.$get(") != 1 or "function secured(" not in src:
        fails.append("panel.js: every /api/secured call must go through secured()")
    for word in ("prefetch", "warmCache", "Promise.all(", "setInterval(() => secured"):
        if word in src.replace("no prefetching", ""):
            fails.append("panel.js mentions %r -- no prefetching, ever" % word)
    return fails


def main():
    if not os.path.exists(DB):
        sys.exit("no data/plays.db -- run: python3 build_index.py 2025")
    fails = lint()
    for f in fails:
        print("FAIL  lint: " + f)

    con = sqlite3.connect(DB)
    cases = build_cases(con)
    srv = start_server()
    try:
        py = py_side(cases)
    finally:
        srv.kill()
    js = js_side(cases)

    n_ok = 0
    for c in cases:
        a, b = py.get(c["id"], {"error": "no python result"}), js.get(c["id"], {"error": "no js result"})
        d = compare(c, a, b)
        if d:
            fails.append(c["id"])
            print("FAIL  %-32s %s" % (c["id"], d))
            if VERBOSE:
                print("      py:", json.dumps(a)[:400])
                print("      js:", json.dumps(b)[:400])
        else:
            n_ok += 1
            if VERBOSE:
                print("ok    %s" % c["id"])
    print("\n%d cases, %d ok, %d failed" % (len(cases), n_ok, len(fails)))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
