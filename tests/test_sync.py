#!/usr/bin/env python3
"""The sync test.

The index is published as parts (build_index.publish) and the extension keeps
a merged copy, fetching only the parts whose content id moved (db.js
ensureDb). This publishes a small fixture through the real publisher, then
drives the real db.js under Node (tests/sync_side.mjs) through the situations
a season produces -- a first install, a revised week, a new week, an unchanged
manifest, a retyped column, the next season starting, GitHub unreachable --
and checks two things each time: exactly which files were downloaded, and that
the merged copy matches the fixture row for row.

    python3 tests/test_sync.py            # needs data/plays.db (build_index.py)
    python3 tests/test_sync.py -v
"""
import json, os, shutil, sqlite3, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "data", "plays.db")
sys.path.insert(0, ROOT)
import build_index

VERBOSE = "-v" in sys.argv
fails = []


def check(name, got, want):
    ok = got == want
    if not ok or VERBOSE:
        print(("ok    " if ok else "FAIL  ") + name)
    if not ok:
        fails.append(name)
        print("      got:  %s" % json.dumps(got, default=str)[:600])
        print("      want: %s" % json.dumps(want, default=str)[:600])


def make_fixture(path):
    """A small plays.db with the real schema: two 2025 weeks, one 2026 week."""
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path, isolation_level=None)
    con.execute("ATTACH ? AS src", (SRC,))
    for _, sql in build_index.schema_ddl(sqlite3.connect(SRC)):
        con.execute(sql)
    for w in (1, 2):
        con.execute("INSERT INTO plays SELECT * FROM src.plays WHERE season=2025 AND week=?"
                    " ORDER BY game_id, play_id LIMIT 300", (w,))
    con.execute("INSERT INTO plays SELECT * FROM src.plays WHERE season=2026 AND week=1")
    con.execute("INSERT INTO players SELECT * FROM src.players ORDER BY plays DESC LIMIT 500")
    con.execute("DETACH src")
    con.close()


def expected(path):
    con = sqlite3.connect(path)
    counts = [list(r) for r in con.execute(
        "SELECT season, week, COUNT(*), ROUND(SUM(epa), 3), SUM(yards_gained), COUNT(desc)"
        " FROM plays GROUP BY 1, 2 ORDER BY 1, 2")]
    players = list(con.execute("SELECT COUNT(*), SUM(plays) FROM players").fetchone())
    schema = [r[1] + ":" + r[2] for r in con.execute("PRAGMA table_info(plays)")]
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")]
    indexes = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='index' ORDER BY 1")]
    con.close()
    return counts, players, schema, tables, indexes


def publish(work, fixture, seasons, snapshot):
    build_index.DB = fixture
    build_index.DATA = work
    build_index.publish(seasons)
    dst = os.path.join(work, snapshot)
    shutil.copytree(os.path.join(work, "dist"), dst, dirs_exist_ok=True)
    return dst


def run(cache, *dists):
    r = subprocess.run(["node", "--no-warnings", os.path.join(HERE, "sync_side.mjs"), cache] + list(dists),
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit("sync_side.mjs failed:\n" + r.stderr)
    return json.loads(r.stdout)


def verify(name, step, fixture, fetched):
    counts, players, schema, tables, indexes = expected(fixture)
    check(name + ": no error", step.get("error"), None)
    check(name + ": files fetched", sorted(step["fetched"]), sorted(fetched))
    check(name + ": plays match", step.get("counts"), counts)
    check(name + ": players match", step.get("players"), players)
    check(name + ": schema match", step.get("schema"), schema)
    check(name + ": tables", step.get("tables"), tables)
    check(name + ": indexes", step.get("indexes"), indexes)
    check(name + ": cache holds only the merged copy", sorted(step["cached"]), ["index", "index:meta"])


def main():
    if not os.path.exists(SRC):
        sys.exit("no data/plays.db -- run: python3 build_index.py 2025 2026")
    work = tempfile.mkdtemp(prefix="all22-sync-")
    fixture = os.path.join(work, "plays.db")
    cache = os.path.join(work, "cache")
    os.makedirs(cache)
    quiet = open(os.devnull, "w")
    real_stdout = sys.stdout
    if not VERBOSE:
        sys.stdout = quiet
    try:
        make_fixture(fixture)
        d1 = publish(work, fixture, [2025, 2026], "d1")
        man1 = json.load(open(os.path.join(d1, "manifest.json")))

        # week 2 of 2026 lands, and nflverse revises a play in week 1
        con = sqlite3.connect(fixture, isolation_level=None)
        con.execute("ATTACH ? AS src", (SRC,))
        con.execute("INSERT INTO plays SELECT * FROM src.plays WHERE season=2025 AND week=3 LIMIT 120")
        con.execute("UPDATE plays SET season=2026, week=2 WHERE season=2025 AND week=3")
        con.execute("UPDATE plays SET desc='revised' WHERE rowid = (SELECT MIN(rowid) FROM plays WHERE season=2026 AND week=1)")
        con.execute("DETACH src"); con.close()
        shutil.copy(fixture, fixture + ".2")
        d2 = publish(work, fixture, [2025, 2026], "d2")
        man2 = json.load(open(os.path.join(d2, "manifest.json")))

        # a column is retyped: the schema hash moves, every part id moves
        con = sqlite3.connect(fixture, isolation_level=None)
        ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='plays'").fetchone()[0]
        assert '"epa" REAL' in ddl
        con.execute("ALTER TABLE plays RENAME TO plays_old")
        con.execute(ddl.replace('"epa" REAL', '"epa" TEXT'))
        con.execute("INSERT INTO plays SELECT * FROM plays_old")
        con.execute("DROP TABLE plays_old")
        for _, sql in build_index.schema_ddl(sqlite3.connect(SRC)):
            if sql.startswith("CREATE INDEX") and "plays(" in sql or ' ON "plays"' in sql or " ON plays" in sql:
                try: con.execute(sql)
                except sqlite3.OperationalError: pass
        con.close()
        shutil.copy(fixture, fixture + ".3")
        d3 = publish(work, fixture, [2025, 2026], "d3")

        # the next season starts: 2026 becomes a completed season, one file
        con = sqlite3.connect(fixture, isolation_level=None)
        con.execute("INSERT INTO plays SELECT * FROM plays WHERE season=2026 AND week=1")
        con.execute("UPDATE plays SET season=2027 WHERE rowid IN (SELECT rowid FROM plays WHERE season=2026 AND week=1 ORDER BY rowid DESC LIMIT (SELECT COUNT(*)/2 FROM plays WHERE season=2026 AND week=1))")
        con.close()
        shutil.copy(fixture, fixture + ".4")
        d4 = publish(work, fixture, [2025, 2026, 2027], "d4")
    finally:
        sys.stdout = real_stdout

    # --- the publisher ------------------------------------------------------
    check("manifest: parts", [p["key"] for p in man1["parts"]], ["2025", "2026-w01", "players"])
    check("manifest: content hash moves with the rows", man1["content_hash"] != man2["content_hash"], True)
    check("manifest: schema hash does not", man1["schema"], man2["schema"])
    ids1 = {p["key"]: p["id"] for p in man1["parts"]}
    ids2 = {p["key"]: p["id"] for p in man2["parts"]}
    check("manifest: completed season keeps its id", ids1["2025"], ids2["2025"])
    check("manifest: revised week gets a new id", ids1["2026-w01"] != ids2["2026-w01"], True)
    check("manifest: players untouched keep their id", ids1["players"], ids2["players"])
    man3 = json.load(open(os.path.join(d3, "manifest.json")))
    check("manifest: retyped column moves the schema hash", man3["schema"] != man2["schema"], True)
    check("manifest: ...and every part id", all(p["id"] != ids2[p["key"]] for p in man3["parts"]), True)
    man4 = json.load(open(os.path.join(d4, "manifest.json")))
    check("manifest: rollover parts", [p["key"] for p in man4["parts"]], ["2025", "2026", "2027-w01", "players"])

    # --- the client ---------------------------------------------------------
    # 1: first install, 2: an in-session recheck sees the revised and new week
    steps = run(cache, d1, d2)
    make_fixture(os.path.join(work, "plays.db.1"))
    verify("first install", steps[0], os.path.join(work, "plays.db.1"),
           ["plays_2025.db.gz", "plays_2026_w01.db.gz", "players.db.gz"])
    check("first install: stages", steps[0]["progress"][:1] + steps[0]["progress"][-1:], ["downloading", "opening"])
    verify("revised + new week", steps[1], fixture + ".2", ["plays_2026_w01.db.gz", "plays_2026_w02.db.gz"])
    check("revised week: panel told to refresh", steps[1]["progress"][-1], "refreshed")

    # 3: a cold start with a warm cache and nothing new downloads nothing
    steps = run(cache, d2)
    verify("cold start, unchanged", steps[0], fixture + ".2", [])
    check("cold start, unchanged: no download stage", steps[0]["progress"], [])

    # 4: GitHub unreachable on a cold start: the cached copy is used
    steps = run(cache, "-")
    verify("offline cold start", steps[0], fixture + ".2", [])

    # 5: a retyped column rebuilds from scratch
    steps = run(cache, d3)
    verify("schema change", steps[0], fixture + ".3",
           ["plays_2025.db.gz", "plays_2026_w01.db.gz", "plays_2026_w02.db.gz", "players.db.gz"])

    # 6: the season after: 2026's weekly parts are dropped for one season file
    steps = run(cache, d4)
    verify("season rollover", steps[0], fixture + ".4", ["plays_2026.db.gz", "plays_2027_w01.db.gz"])

    # 7: the single-file publication (manifest version 1) still loads -- as one
    # part owning every table -- so the extension and the index repo can ship
    # in either order; and moving from it to parts is a rebuild
    v1 = os.path.join(work, "v1")
    os.makedirs(v1)
    sha = build_index.gzip_file(fixture + ".2", os.path.join(v1, "plays_2025-2026.db.gz"))
    json.dump({"file": "plays_2025-2026.db.gz", "sha256": sha, "content_hash": "abc",
               "bytes": os.path.getsize(os.path.join(v1, "plays_2025-2026.db.gz")), "rows": 0},
              open(os.path.join(v1, "manifest.json"), "w"))
    steps = run(cache, v1, d2)
    verify("single-file manifest", steps[0], fixture + ".2", ["plays_2025-2026.db.gz"])
    verify("single-file to parts", steps[1], fixture + ".2",
           ["plays_2025.db.gz", "plays_2026_w01.db.gz", "plays_2026_w02.db.gz", "players.db.gz"])

    # 8: a manifest that names nothing is refused with a readable message
    bad = os.path.join(work, "bad")
    os.makedirs(bad)
    json.dump({"rows": 1}, open(os.path.join(bad, "manifest.json"), "w"))
    steps = run(cache, bad)
    check("empty manifest: refused", "neither parts nor a file" in (steps[0].get("error") or ""), True)

    shutil.rmtree(work)
    print("all sync checks passed" if not fails else "%d sync checks FAILED" % len(fails))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
