#!/usr/bin/env python3
"""Local search backend for the All-22 panel.

    python3 server.py        # http://localhost:8722

Search runs entirely against the local nflverse SQLite index -- all 372 pbp
columns are filterable. Video never touches this server: the browser extension
renders NFL Pro's own player in-page, on nfl.com, under your subscription.
"""
import json, os, sqlite3, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nflpro
import roles as roles_mod

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "data", "plays.db")
DICT = os.path.join(HERE, "extension", "dictionary.json")
PORT = int(os.environ.get("PORT", "8722"))

OPS = roles_mod.OPS

# columns surfaced as the result row; everything else is still filterable
CORE = ["play_id", "old_game_id", "season", "season_type", "week", "home_team",
        "away_team", "posteam", "defteam", "qtr", "time", "down", "ydstogo",
        "desc", "play_type", "epa"]

_schema = {}
_groups = {}
_binary = None
_dict = None
_redundant = None


def describe():
    """nflverse's own field descriptions, baked by build_dictionary.py."""
    global _dict
    if _dict is None:
        try:
            with open(DICT, encoding="utf-8") as f:
                _dict = json.load(f)
        except Exception:
            _dict = {}
    return _dict


# A column's values are only worth listing when there are few enough to read.
# Past that a count and a couple of samples say more than a truncated list.
LIST_MAX = 25


_SHAPE = {}


def shape_distinct(con, col, arms):
    """Whether a column reads as a short enumeration or as a range is a property
    of the column, not of whatever you have filtered down to. Deciding it from
    the filtered rows would morph the control as you narrow: air_epa is a range
    over a season and would turn into a list of six raw floats the moment you
    pick one receiver. Cached per column -- this is the scan profile() used to
    do before it learned to scope. Mirrors db.js."""
    if col not in _SHAPE:
        union = " UNION ALL ".join('SELECT "%s" v FROM plays' % m for m in arms)
        _SHAPE[col] = con.execute(
            "SELECT COUNT(DISTINCT v) FROM (%s)" % union).fetchone()[0]
    return _SHAPE[col]


def profile(con, col, cols, members=None, scope=None):
    """What a column actually holds -> {kind, filled, distinct, ...}.

    The shape depends on the column: a yes/no gets its two counts, a short
    enumeration gets its values, a number gets its range, and free text gets a
    sample plus how many distinct values there are. One size genuinely does not
    fit -- epa's five most common values are noise, pass_location's are the
    entire vocabulary.
    """
    # a merged column has no schema entry of its own; its type is its slots'
    # type, and without this it falls through to the numeric branch
    coltype = cols.get(col) or (cols.get(members[0]) if members else None)
    src = members or [col]
    where, args = scope or ([], [])
    tail = (" WHERE " + " AND ".join(where)) if where else ""
    union = " UNION ALL ".join('SELECT "%s" v FROM plays%s' % (m, tail) for m in src)
    # every arm of the union carries the same WHERE, so it wants its own copy
    # of the arguments
    sa = list(args) * len(src)
    filled, distinct = con.execute(
        "SELECT COUNT(v), COUNT(DISTINCT v) FROM (%s)" % union, sa).fetchone()
    # a merged column is ours, not nflverse's, so it has no dictionary entry of
    # its own: borrow the one for the slot it leads with. That it spans several
    # columns is plumbing -- the panel shows it on the badge, not in the wording.
    d = describe().get(col, "")
    if members and not d:
        d = describe().get(members[0], "")
    out = {"col": col, "filled": filled, "distinct": distinct, "desc": d}
    if not filled:
        out["kind"] = "empty"
        return out
    if col in binary_columns(con, cols):
        yes = con.execute(
            "SELECT COUNT(*) FROM (%s) WHERE v IN ('1',1)" % union, sa).fetchone()[0]
        out.update(kind="yesno", yes=yes, no=filled - yes)
        return out
    if shape_distinct(con, col, src) <= LIST_MAX:
        out.update(kind="list", values=[
            {"v": r[0], "n": r[1]} for r in con.execute(
                "SELECT v, COUNT(*) n FROM (%s) WHERE v IS NOT NULL "
                "GROUP BY 1 ORDER BY n DESC" % union, sa)])
        return out
    if coltype in ("REAL", "INTEGER"):
        lo, hi, avg = con.execute(
            "SELECT MIN(v), MAX(v), AVG(v) FROM (%s)" % union, sa).fetchone()
        out.update(kind="number", min=lo, max=hi, avg=avg)
        return out
    out.update(kind="text", values=[
        {"v": r[0], "n": r[1]} for r in con.execute(
            "SELECT v, COUNT(*) n FROM (%s) WHERE v IS NOT NULL "
            "GROUP BY 1 ORDER BY n DESC LIMIT 4" % union, sa)])
    return out



def q1(con, sql, args=()):
    cur = con.execute(sql, args)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]


def schema(con):
    global _schema
    if not _schema:
        for r in con.execute("PRAGMA table_info(plays)"):
            _schema[r[1]] = r[2]
    return _schema


def binary_columns(con, cols):
    """Columns whose every non-null value is 0 or 1, and where both actually
    occur -- the nflverse event flags.

    Requiring both states is what keeps play_clock out: it is a real number
    column that happens to hold nothing but '0' this season, and offering it as
    a yes/no would be a lie about the data. Costs one table scan, cached.

    Three cheap counting aggregates rather than COUNT(DISTINCT), which would
    build a hash set per column -- 337 of them, some with 48k distinct values.
    """
    global _binary
    if _binary is not None:
        return _binary
    keys = list(cols)
    sel = ", ".join('SUM("{0}" IN (\'0\',0)), SUM("{0}" IN (\'1\',1)), COUNT("{0}")'.format(k)
                    for k in keys)
    row = con.execute("SELECT " + sel + " FROM plays").fetchone()
    _binary = []
    for i, k in enumerate(keys):
        n0, n1, n = row[i * 3] or 0, row[i * 3 + 1] or 0, row[i * 3 + 2]
        if n and n0 and n1 and n0 + n1 == n:
            _binary.append(k)
    return _binary


def redundant_flags(con, cols):
    """Flags that say nothing their merged column does not -> hidden from the
    picker. Confirmed against this index rather than assumed, so a flag that
    stops agreeing simply reappears on the next rebuild."""
    global _redundant
    if _redundant is not None:
        return _redundant
    _redundant = []
    gs = groups(cols)
    for flag, key in roles_mod.REDUNDANT_FLAGS.items():
        g = gs.get(key)
        if not g or flag not in cols:
            continue
        named = " OR ".join('"%s" IS NOT NULL' % m for m in g["members"])
        set_ = '("%s" = \'1\' OR "%s" = 1)' % (flag, flag)
        diff = con.execute(
            "SELECT COUNT(*) FROM plays WHERE (%s AND NOT (%s)) OR (NOT %s AND (%s))"
            % (set_, named, set_, named)).fetchone()[0]
        if not diff:
            _redundant.append(flag)
    return _redundant


def groups(cols):
    """key -> merged column, built once; the schema does not change under us."""
    global _groups
    if not _groups:
        _groups = {g["key"]: g for g in roles_mod.column_groups(cols)}
    return _groups


def base_filters(cols, qs):
    """The season/team/column/text filters, shared by the search and the facet
    counts. Without this the chip labels report a player's whole season while
    the result list shows the handful that survive the other filters."""
    where, args = [], []

    # f=<column>:<op>[:<value>]  -- repeatable, ANDed
    for spec in qs.get("f", []):
        parts = spec.split(":", 2)
        col, op = parts[0], parts[1] if len(parts) > 1 else "eq"
        val = parts[2] if len(parts) > 2 else None
        if op == "like":
            val = roles_mod.like_pattern(val)
        if col == "__team":     # either side of the ball, not just the offense
            where.append('("posteam" = ? OR "defteam" = ?)')
            args.extend([val, val])
            continue
        g = groups(cols).get(col)
        if g:                   # merged column: one filter, every slot
            frag, vals = roles_mod.group_sql(g["members"], op, val, g["type"])
            if frag:
                where.append(frag)
                args.extend(vals)
            continue
        if col not in cols or op not in OPS:
            continue
        if op in ("notnull", "isnull"):
            where.append('"%s" %s' % (col, OPS[op]))
        else:
            where.append('"%s" %s ?' % (col, OPS[op]))
            if cols[col] in ("REAL", "INTEGER"):
                # a non-number against a numeric column matches nothing, as in
                # db.js where Number("abc") is NaN and binds as NULL. It used
                # to `continue` here, leaving the fragment without its value.
                try: val = float(val)
                except (TypeError, ValueError): val = None
            args.append(val)

    for text in qs.get("q", []):
        text = text.strip()
        if text:
            where.append('"desc" LIKE ?')
            args.append("%" + text + "%")
    return where, args


def scope_filters(con, qs):
    """Everything that narrows the play list: the base filters, the facet
    selection and the player's own participation columns. profile() needs the
    very same scope -- without it the dictionary describes the whole index
    while the list under it shows one player's afternoon. Mirrors db.js.

    Fragments come back unqualified, which resolves against `FROM plays` and
    against `FROM plays p` alike."""
    cols = schema(con)
    role = (qs.get("role") or ["any"])[0]
    subs = qs.get("sub", [])
    where, args = base_filters(cols, qs)

    if qs.get("player"):
        ids = roles_mod.role_columns(role, cols)
        if ids:
            where.append("(" + " OR ".join('"%s" = ?' % c for c in ids) + ")")
            args.extend([qs["player"][0]] * len(ids))

    for key in qs.get("nsub", []):
        frag, vals = roles_mod.sub_exclusion_sql(key, role, cols)
        if frag:
            where.append(frag)   # unqualified names resolve against FROM plays p
            args.extend(vals)

    conds = []
    for key in subs:
        conds += roles_mod.sub_conditions(key, role) or []
    # kneels/spikes are not rushing plays; drop them unless asked for
    conds += roles_mod.role_exclusions(role, subs)
    for col, op, val in conds:
        if col not in cols:
            continue
        frag, v = roles_mod.sql_condition(col, op, val, cols[col])
        where.append(frag)
        args.append(v)

    return where, args


def search(con, qs):
    where, args = scope_filters(con, qs)
    sql = "SELECT %s FROM plays p" % ",".join('p."%s"' % c for c in CORE)
    if where:
        sql += " WHERE " + " AND ".join(where)
    order = (qs.get("order") or ["game"])[0]
    sql += {"epa": " ORDER BY p.epa DESC",
            "epa_asc": " ORDER BY p.epa ASC"}.get(
        order, " ORDER BY p.old_game_id, p.play_id")
    sql += " LIMIT ?"
    args.append(min(int((qs.get("limit") or ["300"])[0]), 1000))

    cur = con.execute(sql, args)
    names = [d[0] for d in cur.description]
    rows = [dict(zip(names, r)) for r in cur.fetchall()]
    for r in rows:
        r["week_slug"] = nflpro.week_slug(r["season_type"], r["week"])
    return rows


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(n).decode())
        except Exception as e:
            return self._send(400, json.dumps({"error": str(e)}))
        if u.path == "/api/game_uuid":       # extension caches the numeric -> UUID map
            con = sqlite3.connect(DB)
            con.execute("INSERT OR REPLACE INTO games VALUES (?,?)",
                        (str(payload.get("old_game_id")), payload.get("fapi_game_id")))
            con.commit(); con.close()
            return self._send(200, json.dumps({"ok": True}))
        return self._send(404, json.dumps({"error": "not found"}))

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        one = {k: v[0] for k, v in qs.items()}
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "static", "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if u.path.startswith("/dist/"):
            # lets the extension load a locally built index before a GitHub
            # release exists; the shipped default points at Releases instead
            fn = os.path.basename(u.path)
            fp = os.path.join(HERE, "data", "dist", fn)
            if not os.path.exists(fp):
                return self._send(404, json.dumps({"error": "no such artifact"}))
            ctype = "application/json" if fn.endswith(".json") else "application/octet-stream"
            with open(fp, "rb") as f:
                return self._send(200, f.read(), ctype)
        if u.path == "/panel.js":
            with open(os.path.join(HERE, "extension", "panel.js"), "rb") as f:
                return self._send(200, f.read(), "application/javascript")
        con = sqlite3.connect(DB)
        try:
            if u.path == "/api/search":
                return self._send(200, json.dumps(search(con, qs)))
            if u.path == "/api/values":
                cs = schema(con)
                gs = groups(cs)
                want = [x for x in (one.get("cols", "").split(",") if one.get("cols")
                                    else [one.get("col", "")]) if x]
                want = want[:40]          # one screenful of dictionary rows
                # the same scope the play list is under, so the range and the
                # counts describe the selection you are looking at
                scope = scope_filters(con, qs)
                out = {}
                for col in want:
                    g = gs.get(col)
                    if not g and col not in cs:
                        continue
                    out[col] = profile(con, col, cs, g["members"] if g else None, scope)
                if one.get("cols"):
                    return self._send(200, json.dumps({"profiles": out}))
                if not out:
                    return self._send(200, json.dumps({"error": "unknown column"}))
                pr = list(out.values())[0]
                # the hint line has always read .values off this endpoint
                return self._send(200, json.dumps(dict(pr, values=pr.get("values", []))))
            if u.path == "/api/players":
                t = "%" + one.get("q", "").strip() + "%"
                return self._send(200, json.dumps(q1(con,
                    "SELECT gsis_id, nfl_id, name, short, position, team, jersey, "
                    "last_season, plays FROM players WHERE name LIKE ? OR short LIKE ? "
                    "ORDER BY plays DESC, last_season DESC, name LIMIT 10", (t, t))))
            if u.path == "/api/player_roles":
                pid = one.get("player", "")
                allc = list(schema(con))
                out = []
                sch = schema(con)
                rw, ra = base_filters(sch, qs)
                for key, label, _ in roles_mod.ROLES:
                    ids = roles_mod.role_columns(key, allc)
                    if not ids:
                        continue
                    # the count must match what clicking the role returns, so
                    # apply the same default exclusions (kneels are not rushes)
                    exf, exv = [], []
                    for col, op, val in roles_mod.role_exclusions(key, []):
                        if col in sch:
                            fr, v = roles_mod.sql_condition(col, op, val, sch[col])
                            exf.append(fr); exv.append(v)
                    sql = "SELECT COUNT(*) FROM plays WHERE (" + \
                          " OR ".join('"%s" = ?' % c for c in ids) + ")" + \
                          ("" if not exf else " AND " + " AND ".join(exf)) + \
                          ("" if not rw else " AND " + " AND ".join(rw))
                    n = con.execute(sql, [pid] * len(ids) + exv + ra).fetchone()[0]
                    if n or key == "any":
                        out.append({"key": key, "label": label, "n": n})
                # order by what this position actually does, and open on its
                # default role -- the shape db.js returns and panel.js reads
                default, promoted = roles_mod.position_profile(one.get("position"))
                rank = lambda r: (promoted.index(r["key"]) if r["key"] in promoted else 99)
                out.sort(key=rank)
                if not any(r["key"] == default and r["n"] for r in out):
                    default = "any"
                return self._send(200, json.dumps({"default": default, "roles": out}))
            if u.path == "/api/player_subfilters":
                pid = one.get("player", "")
                role = one.get("role", "any")
                active = qs.get("sub", [])
                nactive = qs.get("nsub", [])
                allc = schema(con)
                ids = roles_mod.role_columns(role, list(allc))
                bw, ba = base_filters(allc, qs)      # same filters the list uses
                base = "(" + " OR ".join('"%s" = ?' % c for c in ids) + ")"
                bargs = [pid] * len(ids)
                if bw:
                    base += " AND " + " AND ".join(bw)
                    bargs += ba
                allsub = []
                for k in active:
                    allsub += roles_mod.sub_conditions(k, role) or []
                ex = allsub + roles_mod.role_exclusions(role, active)
                nfrag, nval = [], []
                for k in nactive:
                    fr, vs = roles_mod.sub_exclusion_sql(k, role, allc)
                    if fr:
                        nfrag.append(fr); nval.extend(vs)
                exf, exv = [], []
                for col, op, val in ex:
                    if col in allc:
                        fr, v = roles_mod.sql_condition(col, op, val, allc[col])
                        exf.append(fr); exv.append(v)
                exf = exf + nfrag; exv = exv + nval
                total = con.execute(
                    "SELECT COUNT(*) FROM plays WHERE " + base +
                    ("" if not exf else " AND " + " AND ".join(exf)), bargs + exv).fetchone()[0]
                out = []
                for gname, opts in roles_mod.SUBS.get(role, []):
                    # narrow by the OTHER dimensions, so counts reflect the
                    # current view while staying switchable within this row
                    other = []
                    for k in active:
                        if roles_mod.sub_group(k, role) != gname:
                            other += roles_mod.sub_conditions(k, role) or []
                    # excluded options from OTHER dimensions narrow this one too
                    ofrag, oval = [], []
                    for k in nactive:
                        if roles_mod.sub_group(k, role) == gname:
                            continue
                        fr, vs = roles_mod.sub_exclusion_sql(k, role, allc)
                        if fr:
                            ofrag.append(fr); oval.extend(vs)
                    # this group is judged against the total narrowed by the OTHER
                    # dimensions only -- otherwise the row you just clicked, whose
                    # own option now equals the total, would disappear
                    gf, gv = [], []
                    for col, op, val in other + roles_mod.role_exclusions(role, []):
                        if col in allc:
                            fr, v = roles_mod.sql_condition(col, op, val, allc[col])
                            gf.append(fr); gv.append(v)
                    gf = gf + ofrag; gv = gv + oval
                    gtotal = con.execute(
                        "SELECT COUNT(*) FROM plays WHERE %s%s"
                        % (base, "" if not gf else " AND " + " AND ".join(gf)),
                        bargs + gv).fetchone()[0]
                    items = []
                    for key, label, conds in opts:
                        frags, vals = [], []
                        skip = False
                        for col, op, val in conds + other + roles_mod.role_exclusions(role, [key]):
                            if col not in allc:
                                skip = True
                                break
                            fr, v = roles_mod.sql_condition(col, op, val, allc[col])
                            frags.append(fr)
                            vals.append(v)
                        if skip or not frags:
                            continue
                        n = con.execute(
                            "SELECT COUNT(*) FROM plays WHERE %s AND %s"
                            % (base, " AND ".join(frags + ofrag)),
                            bargs + vals + oval).fetchone()[0]
                        items.append({"key": key, "label": label, "n": n})
                    nonzero = [i for i in items if i["n"]]
                    out.append({
                        "group": gname,
                        "options": items,
                        # worth showing at all: genuinely partitions the set
                        "useful": len(nonzero) >= 2 and max(i["n"] for i in items) < gtotal,
                    })
                return self._send(200, json.dumps({"total": total, "groups": out}))
            if u.path == "/api/columns":
                return self._send(200, json.dumps({
                    "columns": schema(con),
                    "groups": list(groups(schema(con)).values()),
                    "binary": binary_columns(con, schema(con)),
                    "describe": {k: v for k, v in describe().items() if k in schema(con)},
                    "redundant": redundant_flags(con, schema(con))}))
            if u.path == "/api/game_uuid":
                r = con.execute("SELECT fapi_game_id FROM games WHERE old_game_id=?",
                                (one.get("old_game_id", ""),)).fetchone()
                return self._send(200, json.dumps({"fapi_game_id": r[0] if r else None}))
            if u.path == "/api/meta":
                return self._send(200, json.dumps({
                    "count": con.execute("SELECT COUNT(*) FROM plays").fetchone()[0],
                    "columns": len(schema(con)),
                    "seasons": [r[0] for r in con.execute("SELECT DISTINCT season FROM plays ORDER BY 1")],
                    "weeks": [r[0] for r in con.execute("SELECT DISTINCT week FROM plays ORDER BY week")],
                    "teams": [r[0] for r in con.execute("SELECT DISTINCT posteam FROM plays WHERE posteam IS NOT NULL ORDER BY 1")],
                }))
        except Exception as e:
            return self._send(500, json.dumps({"error": str(e)}))
        finally:
            con.close()
        self._send(404, json.dumps({"error": "not found"}))


if __name__ == "__main__":
    if not os.path.exists(DB):
        sys.exit("no index -- run: python3 build_index.py 2025")
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    except OSError as e:
        if e.errno != 48:
            raise
        # already serving: say so plainly instead of dumping a traceback
        import urllib.request
        try:
            with urllib.request.urlopen("http://localhost:%d/api/meta" % PORT, timeout=2) as r:
                m = json.loads(r.read().decode())
            sys.exit("all-22 is already running on :%d (%s plays, %d columns) -- nothing to do.\n"
                     "To restart it:  lsof -ti tcp:%d | xargs kill && python3 server.py"
                     % (PORT, format(m["count"], ","), m["columns"], PORT))
        except Exception:
            sys.exit("port %d is in use by something else.\n"
                     "Free it with:  lsof -ti tcp:%d | xargs kill" % (PORT, PORT))
    print("all-22 backend -> http://localhost:%d" % PORT)
    srv.serve_forever()
