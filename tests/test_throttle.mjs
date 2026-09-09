/* The request gate and the selection coalescer in panel.js, run as shipped.
 *
 * panel.js is an IIFE that needs a DOM, so the three blocks under test are
 * cut out of the real source by regex (HANDOFF §9) and evaluated with fakes
 * for nuxt().$api, backend() and the handful of DOM calls they touch. GAP and
 * WINDOW are scaled down so the run takes a second, not an hour.
 *
 *   node tests/test_throttle.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "extension", "panel.js"), "utf8");

function cut(startRe, endMarker) {
  const m = src.match(startRe);
  if (!m) throw new Error("could not find " + startRe);
  const start = m.index;
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error("could not find end of block for " + startRe);
  return src.slice(start, end + endMarker.length);
}
let gate = cut(/  const GAP = 1000, CEILING = 400/, "\n    return p;\n  }\n");
gate = gate.replace("const GAP = 1000, CEILING = 400, WINDOW = 3600e3, COOLDOWN = 5 * 60e3;",
                    "const GAP = 20, CEILING = 8, WINDOW = 400, COOLDOWN = 150;");
const clip = cut(/  const uuidCache = new Map\(\);/, "\n    }));\n  }\n");
const sel  = cut(/  let lastRows = \[\], selIdx = -1;/, "\n    } finally {\n      fetching = false;\n    }\n  }\n");

const sleep = ms => new Promise(r => setTimeout(r, ms));

function harness() {
  const log = [];            // every $get the gate lets through
  let respond = async () => ({ items: [{ cameraSource: "Sideline", mcpPlaybackId: "x", description: "d", id: 1 }] });
  const st = { textContent: "", innerHTML: "" };
  const fakeEl = { classList: { add() {}, remove() {} }, scrollIntoView() {} };
  const env = {
    nuxt: () => ({ $api: { $get: async (path, o) => { log.push({ path, t: Date.now(), params: o.params }); return respond(); } } }),
    backend: async () => ({ fapi_game_id: "uuid-1" }),   // every game already cached
    post: async () => ({}),
    mount: pl => { env.mounted.push(pl); },
    mounted: [],
    q: sel => sel === "#all22-st" ? st : { querySelectorAll: () => [fakeEl], querySelector: () => fakeEl },
    esc: s => s,
    ANGLES: ["Sideline", "Endzone"],
    st, log, setRespond: f => { respond = f; },
  };
  const body = gate + clip + sel + "\n  return { secured, clipFor, selectPlay, setRows: r => { lastRows = r; } };";
  const api = new Function("nuxt", "backend", "post", "mount", "q", "esc", "ANGLES", body)(
    env.nuxt, env.backend, env.post, env.mount, env.q, env.esc, env.ANGLES);
  return Object.assign(env, api);
}

const row = i => ({ old_game_id: "2025090700", play_id: i, season: 2025, season_type: "REG", week_slug: "WEEK_1" });

// 1. serialised and spaced: a burst of calls goes out one at a time, >= GAP apart
{
  const h = harness();
  await Promise.all([1, 2, 3, 4].map(i => h.secured("/api/secured/videos/coaches", { playId: i })));
  assert.equal(h.log.length, 4);
  for (let i = 1; i < h.log.length; i++) assert.ok(h.log[i].t - h.log[i - 1].t >= 18, "gap " + (h.log[i].t - h.log[i - 1].t));
  console.log("ok  serialised, spaced");
}

// 2. a 403 stops everything for the page: no further $get, readable message
{
  const h = harness();
  h.setRespond(async () => { const e = new Error("Request failed with status code 403"); e.response = { status: 403 }; throw e; });
  await assert.rejects(h.secured("/api/secured/videos/coaches", {}), e => /no longer serving.*403/.test(e.message));
  h.setRespond(async () => ({ items: [] }));
  await assert.rejects(h.secured("/api/secured/videos/coaches", {}), e => /no longer serving/.test(e.message));
  assert.equal(h.log.length, 1, "no request after the 403");
  console.log("ok  403 is terminal, no retry");
}

// 3. a 429 pauses for COOLDOWN, then lets the next user action through
{
  const h = harness();
  h.setRespond(async () => { const e = new Error("429"); e.response = { status: 429 }; throw e; });
  await assert.rejects(h.secured("/x", {}), e => /slow down.*429/.test(e.message));
  h.setRespond(async () => ({}));
  await assert.rejects(h.secured("/x", {}), e => /Paused/.test(e.message));
  assert.equal(h.log.length, 1);
  await sleep(170);
  await h.secured("/x", {});
  assert.equal(h.log.length, 2, "one request after the cooldown, on demand");
  console.log("ok  429 pauses, no automatic retry");
}

// 4. the rolling ceiling
{
  const h = harness();
  for (let i = 0; i < 8; i++) await h.secured("/x", {});
  await assert.rejects(h.secured("/x", {}), e => /Clip limit reached \(8 per hour\)/.test(e.message));
  assert.equal(h.log.length, 8);
  await sleep(420);
  await h.secured("/x", {});
  assert.equal(h.log.length, 9, "window rolls");
  console.log("ok  ceiling");
}

// 5. selection coalesces: holding "n" through 20 plays costs 2 requests
{
  const h = harness();
  h.setRespond(async () => { await sleep(40); return { items: [{ cameraSource: "Sideline", mcpPlaybackId: "x", description: "d", id: 1 }] }; });
  h.setRows(Array.from({ length: 20 }, (_, i) => row(i)));
  // key auto-repeat: 20 selections faster than one response
  for (let i = 0; i < 20; i++) h.selectPlay(i);
  await sleep(300);
  assert.equal(h.log.length, 2, "requests for a 20-play burst: " + h.log.length);
  assert.equal(h.log[1].params.playId, 19, "the last selection is the one fetched");
  assert.equal(h.mounted.length, 1, "only the final clip mounts");
  assert.equal(h.mounted[0][0].videoView, "sideline");
  assert.match(h.st.textContent, /2025090700\/19$/);
  console.log("ok  coalesced selection, latest wins, stale response never mounts");
}

// 5b. a burst that outlasts one response: one request per response time, never one per key
{
  const h = harness();
  h.setRespond(async () => { await sleep(40); return { items: [{ cameraSource: "Endzone", mcpPlaybackId: "x", description: "d", id: 1 }] }; });
  h.setRows(Array.from({ length: 20 }, (_, i) => row(i)));
  for (let i = 0; i < 20; i++) { h.selectPlay(i); await sleep(4); }   // ~80 ms of key repeat
  await sleep(300);
  assert.ok(h.log.length <= 4, "requests for a slow 20-play burst: " + h.log.length);
  assert.equal(h.log[h.log.length - 1].params.playId, 19);
  assert.equal(h.mounted.length, 1);
  console.log("ok  slow burst: " + h.log.length + " requests for 20 keypresses");
}

// 6. a dead endpoint surfaces in the status line and stops the drain
{
  const h = harness();
  h.setRespond(async () => { const e = new Error("403"); e.response = { status: 403 }; throw e; });
  h.setRows([row(1), row(2), row(3)]);
  h.selectPlay(0); h.selectPlay(1); h.selectPlay(2);
  await sleep(200);
  assert.equal(h.log.length, 1);
  assert.match(h.st.innerHTML, /no longer serving this endpoint \(HTTP 403\)/);
  assert.match(h.st.innerHTML, /#e0736b/);
  h.selectPlay(0);
  await sleep(100);
  assert.equal(h.log.length, 1, "a later click makes no request");
  assert.match(h.st.innerHTML, /no longer serving/);
  console.log("ok  graceful 403 in the panel");
}
console.log("all throttle checks passed");
