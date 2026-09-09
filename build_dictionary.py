#!/usr/bin/env python3
"""Bake nflverse's own field dictionaries into extension/dictionary.json.

    python3 build_dictionary.py

nflverse documents every pbp column and every FTN charting column, so the panel
does not have to invent definitions for 337 fields -- and cannot get them
subtly wrong. Two files, because the FTN charting columns (is_play_action,
n_blitzers, read_thrown, ...) live in a separate dictionary with its own
column names.

Run this again when nflverse adds fields; the output is committed so the
extension works offline and needs no network at runtime.
"""
import csv, io, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "extension", "dictionary.json")

SOURCES = [
    ("https://raw.githubusercontent.com/nflverse/nflreadr/main/data-raw/dictionary_pbp.csv",
     "Field", "Description"),
    ("https://raw.githubusercontent.com/nflverse/nflreadr/main/data-raw/dictionary_ftn_charting.csv",
     "field_name", "description"),
]


# nflverse writes for the person reading the schema: almost every entry opens by
# restating the storage type ("Binary indicator for if...", "String abbreviation
# for..."), which the panel already shows as a badge beside the name. Strip it --
# 238 of 337 entries start with one of these -- so the definition leads with what
# the column actually means.
STRIP = [
    r"^binary indicator(?:s)?\s*(?:for|of)?\s*(?:if|whether|that)?(?:\s+or\s+not)?[:,]?\s+",
    r"^binary indicator[:,]?\s+",
    r"^string indicator\s*(?:for|of)\s+(?:if|whether)?\s*",
    r"^numeric (?:value|indicator)s?\s*(?:for|of)\s+",
    r"^string (?:name|abbreviation)s?\s*(?:for|of)\s+",
    r"^unique identifiers?\s*(?:of|for)\s+",
    r"^(?:numeric|string)\s+(?:value\s+)?",
]

# Where the mechanical strip leaves something clumsy, or where nflverse's own
# wording describes the implementation ("Play description contains ran ob") or
# leaks a column name, say the thing instead. Same meaning, fewer words.
OVERRIDES = {
    "quarter_end":       "Marks the end of a quarter.",
    "no_huddle":         "Play was run with no huddle.",
    "punt_attempt":      "Play was a punt.",
    "aborted_play":      "Play was aborted.",
    "out_of_bounds":     "Play ended out of bounds.",
    "success":           "EPA was positive on the play.",
    "series_success":    "Series ended in a touchdown or a first down.",
    "special":           "Play was an extra point, field goal, kickoff, or punt.",
    "tackle_with_assist": "Tackle with assist occurred.",
    "special_teams_play": "Play is a special teams play, per the NFL feed.",
    # these name a raw column where a plain noun does the job
    "passing_yards":   "Yards by the passer, including yards gained in pass plays with laterals.",
    "receiving_yards": "Yards by the receiver, excluding yards gained in pass plays with laterals.",
    "rushing_yards":   "Yards by the rusher, excluding yards gained in rush plays with laterals.",
    "lateral_receiving_yards": "Yards by the player who received the lateral on a pass play.",
    "lateral_rushing_yards":   "Yards by the player who received the lateral on a run play.",
}


def clean(text):
    """nflverse's wording, minus the schema talk."""
    s = " ".join((text or "").replace("`", "").split())
    for rx in STRIP:
        n = re.sub(rx, "", s, flags=re.I)
        if n != s and n:
            s = n
            break
    s = re.sub(r"^1[:.]?\s+", "", s)             # "1 if ...", "1: scored ..."
    s = re.sub(r"^if\s+", "", s, flags=re.I)
    s = re.sub(r",?\s*0 otherwise\.?$", ".", s, flags=re.I)
    s = re.sub(r"^(the|a|an)\s+", "", s, flags=re.I)
    s = re.sub(r"(\w)\(", r"\1 (", s)            # "ball(defined by" -> "ball (defined by"
    s = s[:1].upper() + s[1:] if s else s
    if s and not s.endswith((".", "!", "?")):
        s += "."
    return s


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8")


def main():
    out = {}
    for url, kf, vf in SOURCES:
        text = fetch(url)
        n = 0
        for row in csv.DictReader(io.StringIO(text)):
            key = (row.get(kf) or "").strip()
            desc = " ".join((row.get(vf) or "").split())
            # first source wins: pbp is the authority where the two overlap
            if key and desc and key not in out:
                out[key] = OVERRIDES.get(key) or clean(desc)
                n += 1
        print("  %-64s %4d fields" % (url.rsplit("/", 1)[-1], n))

    for k, v in OVERRIDES.items():
        out.setdefault(k, v)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=True)
    print("wrote %s -- %d fields, %.1f KB" % (OUT, len(out), os.path.getsize(OUT) / 1024))

    db = os.path.join(HERE, "data", "plays.db")
    if os.path.exists(db):
        import sqlite3
        cols = [r[1] for r in sqlite3.connect(db).execute("PRAGMA table_info(plays)")]
        miss = [c for c in cols if c not in out]
        print("index coverage: %d/%d%s" % (len(cols) - len(miss), len(cols),
                                           "  MISSING: " + ", ".join(miss) if miss else ""))


if __name__ == "__main__":
    sys.exit(main())
