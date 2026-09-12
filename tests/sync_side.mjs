/* Drives the SHIPPED extension/db.js sync (ensureDb) under Node.
 *
 * Same technique as js_side.mjs: the module source is loaded verbatim minus
 * the wasm import, and the two non-SQL things the sync needs from SQLite --
 * open a serialized database, mount a part beside it -- are stood in for by
 * node:sqlite over temp files. fetch() serves a directory of published parts,
 * and the IndexedDB cache is a directory too, so a run can be cold or warm.
 *
 *   node tests/sync_side.mjs <cacheDir> <distDir> [<distDir> ...]
 *
 * The first dist is loaded as a fresh start of the offscreen document; each
 * further one is seen through the in-session recheck (the hourly manifest
 * poll). A dist named "-" is a manifest that cannot be reached. Writes one
 * JSON result per step on stdout. Driven by tests/test_sync.py.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cacheDir, ...dists] = process.argv.slice(2);

let src = readFileSync(join(ROOT, "extension", "db.js"), "utf8");
const importLine = /^import sqlite3InitModule from "\.\/vendor\/sqlite\/sqlite3\.mjs";\s*$/m;
if (!importLine.test(src)) throw new Error("db.js: expected the sqlite3.mjs import line");
src = src.replace(importLine, "const sqlite3InitModule = null;");
src += `
export { handle, planSync };
export function __inject(o) { engine = o.engine; cache = o.cache; sqlite3 = {}; }
export function __expire() { checkedAt = 0; }
export function __db() { return db; }
`;
const dir = mkdtempSync(join(tmpdir(), "all22-sync-"));
writeFileSync(join(dir, "db.test.mjs"), src);

// --- what the harness observes ---------------------------------------------
const progress = [];
globalThis.chrome = {
  runtime: { onMessage: { addListener() {} },
             sendMessage: async m => { if (m.all22 === "progress") progress.push(m.stage); } },
};
let serving = null, fetched = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (serving === "-") throw new TypeError("Failed to fetch");
  const path = join(serving, u.pathname.replace(/^\//, ""));
  if (!existsSync(path)) return { ok: false, status: 404, url };
  fetched.push(u.pathname.replace(/^\//, ""));
  const body = readFileSync(path);
  return { ok: true, status: 200, url,
           json: async () => JSON.parse(body.toString("utf8")),
           arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
};

// --- stand-ins ---------------------------------------------------------------
const conv = a => (typeof a === "number" && Number.isInteger(a)) ? BigInt(a) : a;
let n = 0;
const tmpfile = () => join(dir, "f" + (n++) + ".db");
function wrap(raw) {
  return {
    raw,
    exec(q) { if (typeof q === "string") raw.exec(q); else raw.prepare(q.sql).run(...(q.bind || []).map(conv)); },
    selectObjects: (sql, args = []) => raw.prepare(sql).all(...args.map(conv)).map(r => ({ ...r })),
    selectArrays: (sql, args = []) => raw.prepare(sql).all(...args.map(conv)).map(r => Object.values(r)),
    close() { raw.close(); },
  };
}
const engine = {
  open(bytes) {
    const f = tmpfile();
    if (bytes) writeFileSync(f, bytes);
    return wrap(new DatabaseSync(f));
  },
  attach(h, name, bytes) {
    const f = tmpfile();
    writeFileSync(f, bytes);
    h.raw.exec(`ATTACH '${f}' AS ${name}`);
  },
  detach(h, name) { h.raw.exec(`DETACH ${name}`); },
  export(h) {
    const f = tmpfile();
    h.raw.exec(`VACUUM INTO '${f}'`);
    return new Uint8Array(readFileSync(f));
  },
};
const cache = {
  get: async k => {
    const f = join(cacheDir, k.replace(":", "_"));
    if (!existsSync(f)) return undefined;
    return k === "index" ? new Uint8Array(readFileSync(f)) : JSON.parse(readFileSync(f, "utf8"));
  },
  put: async (k, v) => writeFileSync(join(cacheDir, k.replace(":", "_")),
                                     k === "index" ? v : JSON.stringify(v)),
  keys: async () => readdirSync(cacheDir).map(f => f.replace("_", ":")),
  del: async k => unlinkSync(join(cacheDir, k.replace(":", "_"))),
};

const m = await import(pathToFileURL(join(dir, "db.test.mjs")).href);
m.__inject({ engine, cache });

const out = [];
for (const [i, d] of dists.entries()) {
  serving = d; fetched = []; progress.length = 0;
  if (i) m.__expire();
  const step = { dist: d };
  try {
    step.meta = await m.handle("meta", { manifestUrl: "http://index/manifest.json" });
    const db = m.__db();
    step.counts = db.selectArrays(
      "SELECT season, week, COUNT(*), ROUND(SUM(epa), 3), SUM(yards_gained), COUNT(desc)" +
      " FROM plays GROUP BY 1, 2 ORDER BY 1, 2");
    step.players = db.selectArrays("SELECT COUNT(*), SUM(plays) FROM players")[0];
    step.schema = db.selectObjects("PRAGMA table_info(plays)").map(r => r.name + ":" + r.type);
    step.tables = db.selectArrays("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1").map(r => r[0]);
    step.indexes = db.selectArrays("SELECT name FROM sqlite_master WHERE type='index' ORDER BY 1").map(r => r[0]);
  } catch (e) {
    step.error = String(e && e.message || e);
  }
  step.fetched = fetched.filter(f => f !== "manifest.json");
  step.progress = progress.slice();
  step.cached = await cache.keys();
  out.push(step);
}
rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out, (k, v) => typeof v === "bigint" ? Number(v) : v));
