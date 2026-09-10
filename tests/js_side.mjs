/* Runs the SHIPPED extension/db.js under Node against data/plays.db.
 *
 * Not a reimplementation: the module source is loaded verbatim except for
 * two mechanical edits (drop the wasm import, export the internals), the
 * sqlite-wasm handle is stood in for by node:sqlite, and chrome.* is stubbed.
 * If db.js does not load as a module -- a stray brace closing handle() early,
 * say -- this script fails, which is the point (HANDOFF §8).
 *
 * Reads a JSON case list on stdin, writes JSON results on stdout. Driven by
 * tests/test_mirror.py; not meant to be run by hand.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.ALL22_DB || join(ROOT, "data", "plays.db");

// --- load the real module -------------------------------------------------
let src = readFileSync(join(ROOT, "extension", "db.js"), "utf8");
const importLine = /^import sqlite3InitModule from "\.\/vendor\/sqlite\/sqlite3\.mjs";\s*$/m;
if (!importLine.test(src)) throw new Error("db.js: expected the sqlite3.mjs import line");
src = src.replace(importLine, "const sqlite3InitModule = null;");
src += `
export { handle, groups, groupSql, likePattern, binaryColumns, redundantFlags,
         profile, search, cols, baseFilters };
export function __setDb(h) { db = h; }
`;
const dir = mkdtempSync(join(tmpdir(), "all22-"));
const modPath = join(dir, "db.test.mjs");
writeFileSync(modPath, src);

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} },
};
// db.js fetches dictionary.json relative to offscreen.html
globalThis.fetch = async () => ({
  json: async () => JSON.parse(readFileSync(join(ROOT, "extension", "dictionary.json"), "utf8")),
});

// --- stand-in for the sqlite-wasm oo1.DB handle ----------------------------
// sqlite-wasm binds a JS integer as INTEGER and a fraction as REAL; node:sqlite
// binds every Number as REAL unless it is a BigInt. Match the browser.
const conv = a => (typeof a === "number" && Number.isInteger(a) && Number.isSafeInteger(a)) ? BigInt(a)
                : (typeof a === "number" && !Number.isFinite(a)) ? null : a;
const raw = new DatabaseSync(DB_PATH, { readOnly: true });
const db = {
  selectObjects: (sql, args = []) => raw.prepare(sql).all(...args.map(conv)).map(r => ({ ...r })),
  selectArrays: (sql, args = []) => raw.prepare(sql).all(...args.map(conv)).map(r => Object.values(r)),
};

const m = await import(pathToFileURL(modPath).href);
m.__setDb(db);

// iso.js's payload shaping, reproduced so the case list can be plain query strings
function payloadFor(op, qs) {
  const u = new URLSearchParams(qs);
  return (op === "search" || op === "player_subfilters" ||
          op === "player_roles" || op === "values")
    ? Object.assign(Object.fromEntries(u.entries()),
                    { f: u.getAll("f"), q: u.getAll("q"), sub: u.getAll("sub"), nsub: u.getAll("nsub") })
    : Object.fromEntries(u.entries());
}

const cases = JSON.parse(readFileSync(0, "utf8"));
const out = {};
for (const c of cases) {
  try {
    if (c.kind === "op") out[c.id] = await m.handle(c.op, payloadFor(c.op, c.qs));
    else if (c.kind === "like") out[c.id] = m.likePattern(c.val);
    else if (c.kind === "group_sql") out[c.id] = m.groupSql(m.groups()[c.key], c.op, c.val);
    else out[c.id] = { error: "unknown case kind " + c.kind };
  } catch (e) {
    out[c.id] = { error: String(e && e.message || e) };
  }
}
process.stdout.write(JSON.stringify(out, (k, v) => typeof v === "bigint" ? Number(v) : v));
