"""Which participant columns mean a player actually DID a thing.

nflverse spreads one stat across several columns (two forced-fumble slots, four
assist-tackle slots, a full sack plus two half-sack slots). Filtering on
`fumble_forced = 1` only says a forced fumble happened somewhere on the play --
to say *this player* forced it you have to match their id against that stat's
own columns. That is what this maps.
"""
import collections
import re

OPS = {"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<=",
       "like": "LIKE", "notnull": "IS NOT NULL", "isnull": "IS NULL"}

ROLES = [
    ("any",             "Any",               None),          # every id column
    ("passer",          "Passing",           ["passer_player_id"]),
    ("rusher",          "Rushing",           ["rusher_player_id", "lateral_rusher_player_id"]),
    ("receiver",        "Receiving",         ["receiver_player_id", "lateral_receiver_player_id"]),
    ("touchdown",       "Touchdown",         ["td_player_id"]),
    ("sack",            "Sack",              ["sack_player_id", "half_sack_1_player_id",
                                              "half_sack_2_player_id", "lateral_sack_player_id"]),
    ("qb_hit",          "QB hit",            ["qb_hit_1_player_id", "qb_hit_2_player_id"]),
    ("tackle_for_loss", "Tackle for loss",   ["tackle_for_loss_1_player_id",
                                              "tackle_for_loss_2_player_id"]),
    ("tackle",          "Tackle (any)",      ["solo_tackle_1_player_id", "solo_tackle_2_player_id",
                                              "assist_tackle_1_player_id", "assist_tackle_2_player_id",
                                              "assist_tackle_3_player_id", "assist_tackle_4_player_id",
                                              "tackle_with_assist_1_player_id",
                                              "tackle_with_assist_2_player_id",
                                              "tackle_for_loss_1_player_id",
                                              "tackle_for_loss_2_player_id"]),
    ("solo_tackle",     "Solo tackle",       ["solo_tackle_1_player_id", "solo_tackle_2_player_id"]),
    ("interception",    "Interception",      ["interception_player_id",
                                              "lateral_interception_player_id"]),
    ("pass_defense",    "Pass defensed",     ["pass_defense_1_player_id", "pass_defense_2_player_id"]),
    ("forced_fumble",   "Forced fumble",     ["forced_fumble_player_1_player_id",
                                              "forced_fumble_player_2_player_id"]),
    ("fumbled",         "Fumble",            ["fumbled_1_player_id", "fumbled_2_player_id"]),
    ("fumble_recovery", "Fumble recovery",   ["fumble_recovery_1_player_id",
                                              "fumble_recovery_2_player_id"]),
    ("penalty",         "Penalty",           ["penalty_player_id"]),
    ("returner",        "Return",            ["punt_returner_player_id", "kickoff_returner_player_id",
                                              "lateral_punt_returner_player_id",
                                              "lateral_kickoff_returner_player_id"]),
    ("kicking",         "Kick / punt",       ["kicker_player_id", "punter_player_id"]),
    ("safety",          "Safety",            ["safety_player_id"]),
]


def role_columns(role, schema_cols):
    """Resolve a role to the id columns that actually exist in this index."""
    allc = [c for c in schema_cols if c.endswith("_player_id")]
    if not role or role == "any":
        return allc
    for key, _label, cols in ROLES:
        if key == role:
            return [c for c in (cols or allc) if c in allc]
    return allc


# Second-level splits, offered only when they actually divide a player's plays
# for the chosen role.
#
# Each option carries a list of conditions (column, op, value); "eq" is a plain
# match, "ne" is NULL-safe not-equal. Multiple conditions are ANDed, which is
# what makes the run-type split mutually exclusive: over half of a QB's
# "designed runs" are actually kneeldowns, and another chunk are sneaks.
SUBS = {
    "rusher": [
        ("Run type", [
            ("scramble", "Scramble", [("qb_scramble", "eq", "1")]),
            ("sneak", "QB sneak", [("is_qb_sneak", "eq", "1")]),
            ("designed", "Designed run", [("qb_scramble", "ne", "1"),
                                          ("qb_kneel", "ne", "1"),
                                          ("is_qb_sneak", "ne", "1")]),
            ("kneel", "Kneeldown", [("qb_kneel", "eq", "1")]),
        ]),
        ("Direction", [
            ("run_left", "Left", [("run_location", "eq", "left")]),
            ("run_middle", "Middle", [("run_location", "eq", "middle")]),
            ("run_right", "Right", [("run_location", "eq", "right")]),
        ]),
        ("Gap", [
            ("gap_end", "End", [("run_gap", "eq", "end")]),
            ("gap_guard", "Guard", [("run_gap", "eq", "guard")]),
            ("gap_tackle", "Tackle", [("run_gap", "eq", "tackle")]),
        ]),
        ("Play call", [("rpo", "RPO", [("is_rpo", "eq", "1")])]),
    ],
    "passer": [
        ("Result", [
            ("complete", "Complete", [("complete_pass", "eq", "1")]),
            ("incomplete", "Incomplete", [("incomplete_pass", "eq", "1")]),
            ("intercepted", "Intercepted", [("interception", "eq", "1")]),
        ]),
        ("Depth", [("short", "Short", [("pass_length", "eq", "short")]),
                   ("deep", "Deep", [("pass_length", "eq", "deep")])]),
        ("Side", [("pl_left", "Left", [("pass_location", "eq", "left")]),
                  ("pl_middle", "Middle", [("pass_location", "eq", "middle")]),
                  ("pl_right", "Right", [("pass_location", "eq", "right")])]),
        ("Formation", [("shotgun", "Shotgun", [("shotgun", "eq", "1")]),
                       ("under_center", "Under center", [("shotgun", "eq", "0")])]),
        ("Play call", [("play_action", "Play action", [("is_play_action", "eq", "1")]),
                       ("rpo", "RPO", [("is_rpo", "eq", "1")]),
                       ("screen", "Screen", [("is_screen_pass", "eq", "1")])]),
        ("Pocket", [("out_of_pocket", "Out of pocket", [("is_qb_out_of_pocket", "eq", "1")]),
                    ("in_pocket", "In pocket", [("is_qb_out_of_pocket", "eq", "0")])]),
        ("Ball", [("throw_away", "Throwaway", [("is_throw_away", "eq", "1")]),
                  ("int_worthy", "Interception-worthy", [("is_interception_worthy", "eq", "1")])]),
    ],
    "receiver": [
        ("Result", [("caught", "Caught", [("complete_pass", "eq", "1")]),
                    ("incomplete", "Incomplete", [("incomplete_pass", "eq", "1")])]),
        ("Depth", [("short", "Short", [("pass_length", "eq", "short")]),
                   ("deep", "Deep", [("pass_length", "eq", "deep")])]),
        ("Side", [("pl_left", "Left", [("pass_location", "eq", "left")]),
                  ("pl_middle", "Middle", [("pass_location", "eq", "middle")]),
                  ("pl_right", "Right", [("pass_location", "eq", "right")])]),
        ("Play call", [("play_action", "Play action", [("is_play_action", "eq", "1")]),
                       ("screen", "Screen", [("is_screen_pass", "eq", "1")]),
                       ("rpo", "RPO", [("is_rpo", "eq", "1")])]),
        ("Catch", [("contested", "Contested", [("is_contested_ball", "eq", "1")]),
                   ("drop", "Drop", [("is_drop", "eq", "1")]),
                   ("created", "Created reception", [("is_created_reception", "eq", "1")])]),
    ],
    "touchdown": [
        ("Type", [("td_rush", "Rushing", [("rush_attempt", "eq", "1")]),
                  ("td_pass", "Receiving", [("pass_attempt", "eq", "1")])]),
    ],
    "any": [
        ("Phase", [("on_pass", "Pass play", [("pass_attempt", "eq", "1")]),
                   ("on_run", "Run play", [("rush_attempt", "eq", "1")])]),
        ("Charting", [("motion", "Pre-snap motion", [("is_motion", "eq", "1")]),
                      ("play_action", "Play action", [("is_play_action", "eq", "1")]),
                      ("no_huddle_ftn", "No huddle", [("is_no_huddle", "eq", "1")]),
                      ("trick", "Trick play", [("is_trick_play", "eq", "1")])]),
    ],
}

# Kneeldowns and spikes carry a rusher_player_id and rush_attempt=1, so they show
# up as "rushes" -- 30 of Drake Maye's 58 designed runs were kneels. Drop them
# from the rushing role unless the user explicitly asks for them.
ROLE_EXCLUDE = {
    "rusher": {"conds": [("qb_kneel", "ne", "1"), ("qb_spike", "ne", "1")],
               "unless": {"kneel"}},
}


def sub_conditions(key, role):
    """key -> [(column, op, value), ...] or None."""
    for _group, opts in SUBS.get(role or "any", []):
        for k, _label, conds in opts:
            if k == key:
                return conds
    return None


def role_exclusions(role, chosen_subs):
    """Default exclusions for a role, skipped when the user asked for them."""
    rule = ROLE_EXCLUDE.get(role or "")
    if not rule or (set(chosen_subs or []) & rule["unless"]):
        return []
    return rule["conds"]


def sql_condition(col, op, val, coltype):
    """Render one condition; 'ne' is NULL-safe so missing charting still passes."""
    v = float(val) if coltype in ("REAL", "INTEGER") else val
    if op == "ne":
        return '("%s" IS NULL OR "%s" <> ?)' % (col, col), v
    return '"%s" = ?' % col, v


# Which role a position most likely wants first, and which stat roles to promote
# in the menu. Keeps a DE from opening on "Passing" and a QB from opening on
# "Tackle". Position strings come from nflverse players.position.
POSITION_PROFILES = {
    "QB":  ("passer",   ["passer", "rusher", "touchdown"]),
    "RB":  ("rusher",   ["rusher", "receiver", "touchdown"]),
    "FB":  ("rusher",   ["rusher", "receiver", "touchdown"]),
    "WR":  ("receiver", ["receiver", "rusher", "touchdown"]),
    "TE":  ("receiver", ["receiver", "touchdown"]),
    "DE":  ("sack",     ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]),
    "DT":  ("sack",     ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]),
    "DL":  ("sack",     ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]),
    "EDGE":("sack",     ["sack", "qb_hit", "tackle_for_loss", "tackle", "forced_fumble"]),
    "LB":  ("tackle",   ["tackle", "sack", "tackle_for_loss", "pass_defense", "forced_fumble"]),
    "OLB": ("sack",     ["sack", "qb_hit", "tackle", "tackle_for_loss"]),
    "MLB": ("tackle",   ["tackle", "tackle_for_loss", "pass_defense"]),
    "CB":  ("pass_defense", ["pass_defense", "interception", "tackle", "solo_tackle"]),
    "SAF": ("tackle",   ["tackle", "pass_defense", "interception", "solo_tackle"]),
    "S":   ("tackle",   ["tackle", "pass_defense", "interception", "solo_tackle"]),
    "FS":  ("tackle",   ["tackle", "pass_defense", "interception"]),
    "SS":  ("tackle",   ["tackle", "pass_defense", "interception"]),
    "K":   ("kicking",  ["kicking"]),
    "P":   ("kicking",  ["kicking"]),
}


def position_profile(position):
    """position -> (default role, promoted role keys)."""
    return POSITION_PROFILES.get((position or "").upper(), ("any", []))


def sub_group(key, role):
    """Which dimension a sub-filter key belongs to."""
    for group, opts in SUBS.get(role or "any", []):
        for k, _label, _conds in opts:
            if k == key:
                return group
    return None


def negate(conds):
    """NOT (a AND b AND c)  ==  (NOT a) OR (NOT b) OR (NOT c).

    Flipping eq<->ne keeps it NULL-safe, which is the whole point: "no play
    action" must still return the ~1,500 plays FTN never charted, not drop them
    because NULL <> '1' is NULL in SQL.
    """
    return [(col, "eq" if op == "ne" else "ne", val) for col, op, val in conds]


def sub_exclusion_sql(key, role, schema_cols):
    """One OR-ed fragment excluding a sub-filter, plus its bound values."""
    conds = sub_conditions(key, role)
    if not conds:
        return None, []
    frags, vals = [], []
    for col, op, val in negate(conds):
        if col not in schema_cols:
            continue
        fr, v = sql_condition(col, op, val, schema_cols[col])
        frags.append(fr)
        vals.append(v)
    if not frags:
        return None, []
    return "(" + " OR ".join(frags) + ")", vals


# --------------------------------------------------------------- groups -----
# nflverse numbers the slots of a multi-participant stat: two forced-fumble
# columns, four assist-tackle ones, two half-sacks. Filtering
# forced_fumble_player_1_player_name quietly misses whoever landed in slot 2 --
# and that is not a rounding error: 8,177 plays have a second assist tackler,
# 150 a second QB hitter, 159 a split sack. These groups publish one merged
# column per stat and OR the slots underneath it.
_SLOT = re.compile(r"(^|_)\d+(_|$)")

# stat stem -> what the merged column is called. Stems match the ROLES labels
# above wherever the two describe the same thing.
GROUP_LABELS = {
    "tackle_for_loss":      "Tackle for loss",
    "qb_hit":               "QB hit",
    "forced_fumble_player": "Forced fumble",
    "solo_tackle":          "Solo tackle",
    "assist_tackle":        "Assist tackle",
    "tackle_with_assist":   "Tackle with assist",
    "pass_defense":         "Pass defensed",
    "fumbled":              "Fumbled",
    "fumble_recovery":      "Fumble recovery",
    "half_sack":            "Sack",
}
SUFFIX_LABELS = {"player_name": "", "player_id": " player ID",
                 "team": " team", "yards": " yards"}

# A full sack and a split sack live in differently-named columns, so the slot
# rule on its own leaves "Sack" (1,184 plays) and "Half sack" (159) as two
# separate lookups -- ask for Anderson's sacks and the split ones never appear.
# Fold them together: a sack is a sack.
GROUP_ABSORB = {
    "half_sack_#_player_id":   ("@sack_player_id",   ["sack_player_id"]),
    "half_sack_#_player_name": ("@sack_player_name", ["sack_player_name"]),
}


def column_groups(schema_cols):
    """[{key, label, type, members}] -- one entry per multi-slot stat.

    Derived from the schema rather than listed by hand, so a family that gains a
    slot upstream (assist_tackle already has four) picks it up on the next index
    build instead of silently dropping it.
    """
    fams = collections.OrderedDict()
    for col in schema_cols:
        if not _SLOT.search(col):
            continue
        fam = _SLOT.sub(lambda m: m.group(1) + "#" + m.group(2), col)
        fams.setdefault(fam, []).append(col)

    out = []
    for fam, members in fams.items():
        stem, mark, suffix = fam.partition("_#_")
        # one member is not a group, and yardline_100 is not a slot
        if len(members) < 2 or not mark or not suffix:
            continue
        key = "@" + stem + "_" + suffix
        extra = []
        if fam in GROUP_ABSORB:
            key, absorb = GROUP_ABSORB[fam]
            extra = [c for c in absorb if c in schema_cols]
        label = (GROUP_LABELS.get(stem, stem.replace("_", " ").capitalize())
                 + SUFFIX_LABELS.get(suffix, " " + suffix.replace("_", " ")))
        out.append({"key": key, "label": label,
                    "type": schema_cols[members[0]],
                    "members": extra + members})
    return out


def like_pattern(val):
    """What "Contains" has to send.

    LIKE without wildcards is a case-insensitive equals, so a fragment typed
    into the panel -- "Anderson" against a column holding "W.Anderson" --
    matched 0 plays and read as "he never did this" rather than as a mistake.
    A value that already carries a % is passed through untouched, so an
    anchored pattern like "(Shotgun)%" still means starts-with.
    """
    if val is None or "%" in val:
        return val
    return "%" + val + "%"


# nflverse also ships a 0/1 flag beside several of these stats -- fumble_forced
# next to the forced-fumble players, qb_hit next to the QB hitters. Where the
# flag is *exactly* "the merged column is set", it is a second name for the same
# question and only muddies the picker ("Forced fumble" vs "Fumble forced").
# Candidates only: each is checked against the actual index before being hidden,
# because two of them are not redundant at all -- sack is set on 9 plays that
# credit nobody, and tackled_for_loss disagrees with its players on 1,463.
REDUNDANT_FLAGS = {
    "fumble_forced":      "@forced_fumble_player_player_name",
    "sack":               "@sack_player_name",
    "qb_hit":             "@qb_hit_player_name",
    "solo_tackle":        "@solo_tackle_player_name",
    "assist_tackle":      "@assist_tackle_player_name",
    "tackle_with_assist": "@tackle_with_assist_player_name",
    "tackled_for_loss":   "@tackle_for_loss_player_name",
    "fumble":             "@fumbled_player_name",
}


def group_sql(members, op, val, coltype):
    """Expand a merged column into SQL across its slots -> (fragment, values).

    OR is right only for the positive operators. "not W.Anderson" has to mean
    *no* slot is W.Anderson -- an AND of NULL-safe <> -- or it matches nearly
    every play in the table; "is empty" likewise means every slot is empty.
    """
    qs = ['"%s"' % c for c in members]
    if op == "isnull":
        return "(" + " AND ".join(q + " IS NULL" for q in qs) + ")", []
    someset = "(" + " OR ".join(q + " IS NOT NULL" for q in qs) + ")"
    if op == "notnull":
        return someset, []
    if coltype in ("REAL", "INTEGER"):
        try:
            val = float(val)
        except (TypeError, ValueError):
            return None, []
    if op == "ne":
        nomatch = " AND ".join("(%s IS NULL OR %s <> ?)" % (q, q) for q in qs)
        return "(" + nomatch + " AND " + someset + ")", [val] * len(qs)
    frag = " OR ".join("%s %s ?" % (q, OPS[op]) for q in qs)
    return "(" + frag + ")", [val] * len(qs)



# ---------------------------------------------------------------- late data --
# Not every column arrives with the play. nflverse's play-by-play lands within
# hours of a game, but FTN's charting layer is charted BY HAND: nflreadr
# documents it as "charted within 48 hours following each game"
# (nflverse/nflreadr, R/load_ftn_charting.R), and nflverse polls FTN every six
# hours through the season (nflverse/nflverse-ftn, update_ftn.yaml), so it
# appears within hours of FTN finishing. Sunday's games are therefore charted by
# Tuesday and Monday night's by Wednesday -- which is when a *week* is complete.
#
# This matters because the failure is silent. Ask for "Play action: Yes" on
# Monday and the newest week returns nothing, which reads as an honest zero or a
# broken index rather than "not charted yet". The panel says so instead.
#
# `marker` is a column that is non-NULL on exactly the plays the source charted
# (FTN fills every field on the plays it charts, and none on the ones it skips),
# so coverage is measured against the index rather than assumed from a calendar.
# `cols` must stay in step with FTN_COLS in build_index.py; tests/test_mirror.py
# fails if it drifts.
LATE_SOURCES = [{
    "key": "ftn",
    "label": "FTN charting",
    "weekday": "Wednesday",
    "note": "FTN charts each game within about 48 hours, so a week is usually "
            "complete by Wednesday.",
    "marker": "qb_location",
    "cols": ["starting_hash", "qb_location", "n_offense_backfield", "n_defense_box",
             "is_no_huddle", "is_motion", "is_play_action", "is_screen_pass", "is_rpo",
             "is_trick_play", "is_qb_out_of_pocket", "is_interception_worthy",
             "is_throw_away", "read_thrown", "is_catchable_ball", "is_contested_ball",
             "is_created_reception", "is_drop", "is_qb_sneak", "n_blitzers",
             "n_pass_rushers", "is_qb_fault_sack"],
}]


def late_sources(schema_cols):
    """The late sources this index actually carries, marker column and all."""
    return [s for s in LATE_SOURCES
            if s["marker"] in schema_cols and any(c in schema_cols for c in s["cols"])]


def late_columns(schema_cols):
    """column -> source key, for every late column present in this index."""
    return {c: s["key"] for s in late_sources(schema_cols)
            for c in s["cols"] if c in schema_cols}
