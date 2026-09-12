/* The late-data notices in panel.js, run as shipped.
 *
 * FTN's charting reaches the index days after the play does, so a filter on a
 * charting column can come back empty simply because nobody has charted the
 * week yet. panel.js says so. The wording is the feature -- it is the only
 * thing standing between "not charted yet" and a user reading 0 plays as an
 * honest zero -- so it is cut out of the real source by regex (HANDOFF §9) and
 * driven through every state the coverage can be in.
 *
 *   node tests/test_late.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "extension", "panel.js"), "utf8");

const start = src.indexOf("  const LATEOF = new Map();");
const endMark = "\n                 : `. `) + s.note };\n  }\n";
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error("could not cut the late-data block out of panel.js");
const block = src.slice(start, end + endMark.length);

// the block reads the two scope selects and nothing else
let scope = { season: "", week: "" };
const q = sel => ({ value: scope[sel.replace("#a-", "")] });
const { setLate, lateNote } =
  new Function("q", block + "\nreturn { setLate, lateNote };")(q);

// one source, shaped exactly as /api/meta emits it
const ftn = over => Object.assign({
  key: "ftn", label: "FTN charting", weekday: "Wednesday",
  note: "FTN charts each game within about 48 hours, so a week is usually complete by Wednesday.",
  marker: "qb_location", cols: ["qb_location", "is_play_action"],
  season: 2026, week: 1, games: 16, charted: 16,
}, over);

const note = (cov, sc) => { scope = sc; setLate([cov]); return lateNote("qb_location"); };
const ALL = { season: "", week: "" };

// a column that arrives with the play is never annotated
setLate([ftn({})]);
assert.equal(lateNote("epa"), null, "a normal column gets no notice");
assert.equal(lateNote("desc"), null);

// complete: the cadence is worth knowing, but nothing is missing
{
  const n = note(ftn({ charted: 16 }), ALL);
  assert.equal(n.warn, undefined, "a complete source must not shout");
  assert.match(n.text, /complete through 2026 week 1/);
  assert.match(n.text, /usually land Wednesday/);
}

// nothing charted at the frontier, and the user is looking at it
{
  const n = note(ftn({ charted: 0, through: { season: 2025, week: 22 } }), ALL);
  assert.equal(n.warn, true, "a missing week must be flagged");
  assert.match(n.text, /Not charted yet for 2026 week 1/);
  assert.match(n.text, /stops at 2025 week 22/);
  assert.match(n.text, /48 hours/);
}

// ... and the same index with no charting at all, so there is no edge to name
{
  const n = note(ftn({ charted: 0 }), ALL);
  assert.equal(n.warn, true);
  assert.doesNotMatch(n.text, /stops at/, "no through: nothing to point at");
  assert.match(n.text, /Wednesday/);
}

// half the week in: say how much, because "0 plays" is not the failure here
{
  const n = note(ftn({ charted: 9 }), ALL);
  assert.equal(n.warn, true);
  assert.match(n.text, /9 of 16 games in 2026 week 1/);
}

// the gap only matters if the selection reaches it. A user reading 2025 while
// 2026 waits on FTN is looking at complete data and must not be warned.
const gap = ftn({ charted: 0, through: { season: 2025, week: 22 } });
for (const [sc, warn, why] of [
  [{ season: "2025", week: "" },   undefined, "an earlier season is complete"],
  [{ season: "2025", week: "9" },  undefined, "an earlier season, one week"],
  [{ season: "2026", week: "" },   true,      "the season holding the gap"],
  [{ season: "2026", week: "1" },  true,      "the very week that is missing"],
  [{ season: "",     week: "" },   true,      "every season includes the gap"],
]) {
  const n = note(gap, sc);
  assert.equal(n.warn, warn, why + " -> warn " + warn);
  assert.match(n.text, /Wednesday/, "the weekday is named in every state");
}

// a week BEFORE the gap in the gap's own season is still complete data
{
  const n = note(ftn({ season: 2026, week: 3, charted: 0, through: { season: 2026, week: 2 } }),
                 { season: "2026", week: "2" });
  assert.equal(n.warn, undefined, "week 2 is charted; week 3 is the gap");
  assert.match(n.text, /charted by hand/);
}

console.log("late-data notices: all states ok");
