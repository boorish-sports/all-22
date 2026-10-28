/* The dictionary's category map in panel.js: every option has a tab and a
 * section, and no rule is dead.
 *
 * The map is cut out of the shipped panel.js, and the merged columns come from
 * db.js's own groups(), run on the real column list (HANDOFF §9: no
 * reimplementations). The columns checked are everything nflverse documents
 * (extension/dictionary.json), everything in data/plays.db when it is there,
 * and NFL Pro's filters. A new nflverse field fails here until it is placed.
 *
 *   node tests/test_dict_cats.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const panel = readFileSync(join(ROOT, "extension", "panel.js"), "utf8");
const dbjs = readFileSync(join(ROOT, "extension", "db.js"), "utf8");

// from the first marker up to the second; keep the second only when it is code
const cut = (src, from, to, what, keepEnd = true) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, what + " not found");
  return src.slice(a, keepEnd ? b + to.length : b);
};
const map = new Function(cut(panel, "  const DICT_TABS = [", "/* ---- end of the category map ---- */", "category map") +
  "\nreturn { DICT_TABS, DICT_RULES, DICT_SECS, DICT_OTHER, dictPlace };")();
const NFLF = new Function(cut(panel, "  const YN = [", "  const NFLF_BY = ", "NFL Pro filters", false) +
  "\nreturn NFLF;")();
const dbGroups = cut(dbjs, "const SLOT = ", "\n  return _groups;\n}\n", "db.js groups()");

// the columns: what nflverse documents, plus the index's own schema if it is here
const cols = {};
Object.keys(JSON.parse(readFileSync(join(ROOT, "extension", "dictionary.json"), "utf8")))
  .forEach(k => { cols[k] = "TEXT"; });
const dbPath = join(ROOT, "data", "plays.db");
let fromIndex = 0;
if (existsSync(dbPath)) {
  try {
    const rows = JSON.parse(execFileSync("sqlite3", ["-json", dbPath, "PRAGMA table_info(plays)"]).toString() || "[]");
    rows.forEach(r => { if (!(r.name in cols)) fromIndex++; cols[r.name] = r.type; });
  } catch (e) {
    console.log("  (sqlite3 CLI not available; checking dictionary.json only)");
  }
}
const { groups, REDUNDANT_FLAGS } = new Function("cols", "db",
  dbGroups + "\nreturn { groups, REDUNDANT_FLAGS };")(() => cols, null);
const gs = groups();
const members = new Set(Object.values(gs).flatMap(g => g.members));

// what the dictionary can list: merged columns stand in for their slots
const keys = Object.keys(cols).filter(k => !members.has(k))
  .concat(Object.keys(gs))
  .concat(NFLF.map(d => "nfl:" + d.key));

// 1. every option has a named home
const other = keys.filter(k => map.dictPlace(k) === map.DICT_OTHER);
assert.deepEqual(other, [], "no tab or section for: " + other.join(", ") +
  " -- add them to DICT_RULES in panel.js");

// 2. every rule places something (a typo'd key or regex shows up as dead)
const used = new Set(keys.map(k => map.dictPlace(k).join("|")));
const dead = map.DICT_RULES.filter(r => !used.has(r[0] + "|" + r[1])).map(r => r[0] + " / " + r[1]);
assert.deepEqual(dead, [], "rules that place nothing: " + dead.join(", "));

// 3. rules only name tabs that exist, and "all" is never a home
const tabIds = new Set(map.DICT_TABS.map(t => t[0]));
map.DICT_SECS.forEach(([t]) => assert.ok(tabIds.has(t) && t !== "all", "bad tab id: " + t));

// 4. a section name is unique within its tab (the section chips key on it)
const seen = new Set();
map.DICT_SECS.forEach(([t, s]) => {
  assert.ok(!seen.has(t + "|" + s), "duplicate section: " + t + " / " + s);
  seen.add(t + "|" + s);
});

// 5. spot checks of the calls most likely to be argued about
const at = k => map.dictPlace(k).join(" / ");
assert.equal(at("air_yards"), "off / Passing");
assert.equal(at("is_play_action"), "off / Play design");
assert.equal(at("@sack_player_name"), "def / Pass rush");
assert.equal(at("defense_coverage_type"), "def / Coverage");
assert.equal(at("nfl:def_alignment"), "def / Personnel & alignment");
assert.equal(at("kickoff_returner_player_name"), "st / Kickoffs");
assert.equal(at("down"), "sit / Down & distance");
assert.equal(at("fixed_drive_result"), "sit / Drive & series");
assert.equal(at("epa"), "res / EPA & success");
assert.equal(at("penalty_type"), "res / Penalties");
assert.equal(at("posteam"), "game / Teams");

const redundant = Object.keys(REDUNDANT_FLAGS || {}).length;
console.log(`ok - ${keys.length} options placed (${fromIndex} only in the index, ` +
  `${Object.keys(gs).length} merged, ${NFLF.length} NFL Pro; ${redundant} redundant flags placed too)`);
