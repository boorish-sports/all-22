/* NFL Pro film-room query layer in panel.js: caching, "too many plays",
 * game-UUID harvesting, and the row drawn for a play the index lacks.
 * Cuts the real functions out of the shipped panel.js and stubs secured()
 * with responses shaped like the live API (probed 2026-10-27).
 *   node tests/test_nfl.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "extension", "panel.js"), "utf8");
const start = src.indexOf("  const NFL_TTL = ");
const end = src.indexOf("  /* ---------------- player ---------------- */", start);
assert.ok(start > 0 && end > start, "NFL query block not found in panel.js");
const block = src.slice(start, end);

function load(respond) {
  const calls = [], posts = [];
  class ApiError extends Error { constructor(m, s) { super(m); this.api = true; this.status = s; } }
  const api = new Function("secured", "post", "uuidCache", "ApiError",
    block + "\nreturn { nflWhen, nflPlays, nflRow, nflCache };")(
    async (path, params) => { calls.push([path, params]); return respond(params); },
    (path, body) => { posts.push([path, body]); return Promise.resolve({ ok: true }); },
    new Map(), ApiError);
  return Object.assign(api, { calls, posts });
}

const play = (g, p, extra) => Object.assign({
  season: 2026, seasonType: "REG", week: 7, weekSlug: "WEEK_7", gameId: g,
  fapiGameId: "uuid-" + g, playId: p, quarter: 1, down: 2, yardsToGo: 10,
  playDescription: "(12:42) 28-J.Taylor right end", gameClock: "12:42",
  homeTeamAbbr: "MIN", homeTeamId: "3000", visitorTeamAbbr: "IND",
  visitorTeamId: "2200", possessionTeamId: "2200", defenseTeamId: "3000",
}, extra || {});

// week mapping
{
  const { nflWhen } = load(() => ({}));
  assert.deepEqual(nflWhen(2026, ""), { season: 2026, seasonType: "REG" });
  assert.deepEqual(nflWhen("2026", "7"), { season: 2026, seasonType: "REG", weekSlug: "WEEK_7" });
  assert.deepEqual(nflWhen(2025, "22"), { season: 2025, seasonType: "POST", weekSlug: "SB" });
  console.log("ok  season and week map to NFL Pro's names");
}

// one request, then cached; UUIDs harvested once, in one batch
{
  const h = load(() => ({ count: 3, plays: [play(2026102505, 40), play(2026102505, 63), play(2026101803, 99)] }));
  const q = { season: 2026, seasonType: "REG", nflId: 46075 };
  const a = await h.nflPlays(q);
  assert.equal(a.count, 3);
  assert.deepEqual(a.keys, ["2026102505/40", "2026102505/63", "2026101803/99"]);
  const b = await h.nflPlays({ nflId: 46075, seasonType: "REG", season: 2026, weekSlug: "" });
  assert.equal(h.calls.length, 1, "same query, any key order, blank params ignored: no second request");
  assert.equal(b.cached, true);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0][1].many, { "2026102505": "uuid-2026102505", "2026101803": "uuid-2026101803" });
  console.log("ok  one request per distinct search, cached after; game UUIDs saved in one batch");
}

// NFL Pro's "too many plays"
{
  const h = load(() => ({ count: 50000, plays: [] }));
  await assert.rejects(h.nflPlays({ season: 2026, seasonType: "REG" }), /too many plays/);
  const h2 = load(() => ({ code: "TOO_MANY" }));
  await assert.rejects(h2.nflPlays({ season: 2026, seasonType: "REG" }), /too many plays/);
  const h3 = load(() => ({ count: 0, plays: [] }));
  assert.equal((await h3.nflPlays({ season: 2026, seasonType: "REG", nflId: 1 })).count, 0);
  console.log("ok  too-many-plays is an error, an empty answer is not");
}

// a play the index does not have yet
{
  const { nflRow } = load(() => ({}));
  const r = nflRow(play(2026102505, 40));
  assert.equal(r.old_game_id, "2026102505");
  assert.equal(r.play_id, 40);
  assert.equal(r.week_slug, "WEEK_7");
  assert.equal(r.posteam, "IND");
  assert.equal(r.defteam, "MIN");
  assert.equal(r.nflOnly, true);
  const k = nflRow(play(2026102505, 41, { down: 0, yardsToGo: 0, possessionTeamId: "3000" }));
  assert.equal(k.down, null);
  assert.equal(k.posteam, "MIN");
  console.log("ok  NFL-only plays become ordinary rows");
}
console.log("all NFL query checks passed");
