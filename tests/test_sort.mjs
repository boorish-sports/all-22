/* The "show the measure, sort by the measure" logic in panel.js, run as shipped.
 *
 * Filtering by air EPA and then not printing it is the bug this replaced, so
 * the rules about WHICH filters earn a column on the row -- and which of them
 * can be sorted by -- are worth pinning down. The block is cut out of the real
 * source by regex (HANDOFF §9).
 *
 * The one reimplementation here is a stand-in <select>, because there is no DOM
 * under Node and this project has no dependencies. It understands exactly the
 * two <option> shapes drawSort() writes and nothing else; if drawSort starts
 * emitting different markup this harness must be taught about it rather than
 * quietly passing (HANDOFF §9's half-filled-harness trap).
 *
 *   node tests/test_sort.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "extension", "panel.js"), "utf8");

const start = src.indexOf('  const NUMERIC = c => COLTYPE[c]');
const endMark = '\n    sel.value = [...sel.options].some(o => o.value === was) ? was : "game";\n  }\n';
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error("could not cut the sort block out of panel.js");
const block = src.slice(start, end + endMark.length);

// --- stand-in <select> ----------------------------------------------------
const OPTION = /<option(?: data-col="1")? value="([^"]*)">([^<]*)<\/option>/g;
function makeSelect(initial) {
  const sel = {
    value: initial[0].value,
    options: initial.map(o => Object.assign({}, o)),
    querySelectorAll(q) {
      assert.equal(q, 'option[data-col]', "the harness only knows this selector");
      return sel.options.filter(o => o.dyn)
        .map(o => ({ remove: () => { sel.options = sel.options.filter(x => x !== o); } }));
    },
    insertAdjacentHTML(where, html) {
      assert.equal(where, "beforeend");
      let m, n = 0;
      while ((m = OPTION.exec(html))) { sel.options.push({ value: m[1], label: m[2], dyn: true }); n++; }
      OPTION.lastIndex = 0;
      assert.ok(n, "the harness did not recognise the markup drawSort wrote: " + html);
    },
  };
  return sel;
}
const FIXED = [{ value: "game", label: "By game" }, { value: "epa", label: "EPA high" },
                { value: "epa_asc", label: "EPA low" }];

// --- the state panel.js has when these run --------------------------------
const COLTYPE = { air_epa: "REAL", cp: "REAL", cpoe: "REAL", wp: "REAL", epa: "REAL",
                  n_blitzers: "INTEGER", yardline_100: "INTEGER", ydstogo: "INTEGER",
                  desc: "TEXT", is_play_action: "INTEGER",
                  "@sack_player_name": "TEXT" };
const BINARY = new Set(["is_play_action"]);
const HUMAN = { air_epa: "Air EPA", cp: "CP", cpoe: "CPOE", wp: "WP",
                n_blitzers: "# blitzers", yardline_100: "Yardline 100",
                ydstogo: "Ydstogo", epa: "EPA",
                "@sack_player_name": "Sack player name", is_play_action: "Play action" };
const esc = s => (s || "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// one array, mutated in place: panel.js closes over `extra` and never rebinds it
const extra = [];
const setExtra = (...fs) => { extra.length = 0; extra.push(...fs); };
let order = makeSelect(FIXED);
const q = s => { assert.equal(s, "#a-order", "the block reads only the sort menu"); return order; };
const { showCols, sortCol, drawSort } = new Function(
  "COLTYPE", "BINARY", "extra", "humanCol", "esc", "q",
  block + "\nreturn { showCols, sortCol, drawSort };"
)(COLTYPE, BINARY, extra, c => HUMAN[c] || c, esc, q);

const values = () => order.options.map(o => o.value);
const labels = () => order.options.filter(o => o.dyn).map(o => o.label);

// --- what lands on the row ------------------------------------------------
setExtra({ col: "air_epa", op: "gte", val: "0" });
assert.deepEqual(showCols(), ["air_epa"], "a range filter is worth printing");

setExtra({ col: "posteam", op: "eq", val: "SF" });
assert.deepEqual(showCols(), [], "an = filter already tells you its value");

setExtra({ col: "is_play_action", op: "eq", val: "1" });
assert.deepEqual(showCols(), [], "a yes/no pinned to one state says nothing new");

setExtra({ col: "cp", op: "isnull" });
assert.deepEqual(showCols(), [], "is-empty is a column of blanks");

setExtra({ col: "air_epa", op: "gte", val: "0" }, { col: "air_epa", op: "lte", val: "3" });
assert.deepEqual(showCols(), ["air_epa"], "a column bounded on both sides prints once");

setExtra({ col: "air_epa", op: "gt", val: "0" }, { col: "cp", op: "gt", val: "0" },
         { col: "cpoe", op: "gt", val: "0" }, { col: "wp", op: "gt", val: "0" },
         { col: "n_blitzers", op: "gt", val: "0" });
assert.equal(showCols().length, 4, "SHOW_MAX in roles.py / db.js is 4");

// a measure the row already spells out is not printed twice
setExtra({ col: "epa", op: "gt", val: "2" }, { col: "ydstogo", op: "gt", val: "10" });
assert.deepEqual(showCols(), [], "EPA and the down-and-distance are already there");

// the sort column rides along even when nothing filtered it, and leads
setExtra({ col: "cp", op: "gt", val: "0" });
order = makeSelect(FIXED.concat([{ value: "air_epa:desc", label: "Air EPA high", dyn: true }]));
order.value = "air_epa:desc";
assert.equal(sortCol(), "air_epa");
assert.deepEqual(showCols(), ["air_epa", "cp"], "you are reading down the sort column");
order.value = "game";
assert.equal(sortCol(), null, "the fixed sorts name no column");
order.value = "epa_asc";
assert.equal(sortCol(), null, "and epa_asc is not the column 'epa_'");

// --- what the Sort menu offers --------------------------------------------
order = makeSelect(FIXED);
setExtra({ col: "air_epa", op: "gte", val: "0" });
drawSort();
assert.deepEqual(values(), ["game", "epa", "epa_asc", "air_epa:desc", "air_epa:asc"]);
assert.deepEqual(labels(), ["Air EPA high", "Air EPA low"]);

setExtra({ col: "desc", op: "like", val: "sack" },
         { col: "@sack_player_name", op: "notnull" },
         { col: "is_play_action", op: "eq", val: "1" },
         { col: "epa", op: "gt", val: "1" });
drawSort();
assert.deepEqual(labels(), [], "text, a pinned flag and EPA itself add nothing");
assert.equal(order.value, "game", "the air EPA sort went with its filter");

// ...but ranking by one is still on the menu: longest-to-go first is a question
setExtra({ col: "ydstogo", op: "gt", val: "10" });
drawSort();
assert.deepEqual(labels(), ["Ydstogo high", "Ydstogo low"],
                 "sortable even though it is on the row");
order.value = "ydstogo:desc";
assert.deepEqual(showCols(), [], "and still not printed twice");

// a sort that survives its redraw stays put
setExtra({ col: "air_epa", op: "gte", val: "0" });
drawSort();
order.value = "air_epa:asc";
setExtra({ col: "air_epa", op: "gte", val: "0" }, { col: "n_blitzers", op: "gt", val: "4" });
drawSort();
assert.equal(order.value, "air_epa:asc", "adding a filter must not reset the sort");
assert.deepEqual(labels(),
  ["Air EPA high", "Air EPA low", "# blitzers high", "# blitzers low"]);
assert.equal(order.options.filter(o => o.value === "air_epa:desc").length, 1,
             "redrawing must not duplicate options");

console.log("row measures and sort menu: all checks ok");
