/* Isolated-world half. Translates the panel's requests into extension messages.
 *
 * The panel must run in the page world (it needs window.$nuxt and NFL's React
 * globals). That world has no chrome.* APIs and is bound by nfl.com's CSP, so
 * everything privileged happens here and travels by postMessage.
 */
const UUID_KEY = "gameUuids";
const PREFS_KEY = "prefs";
const NOTES_KEY = "notes";        // "old_game_id/play_id" -> { t, at }
const CUTS_KEY = "cutups";        // id -> { id, name, at, plays: [row] }
const PENDING_KEY = "pendingImport";

/* A shared cutup arrives as pro.nfl.com/#all22=<payload>. Taken here, at
   document_start, before NFL's router can rewrite the URL and drop the
   fragment; the panel asks for it once it is up. The fragment never reaches
   NFL's servers. */
if (location.hash.startsWith("#all22=")) {
  chrome.storage.local.set({ [PENDING_KEY]: location.hash.slice(1) });
  try { history.replaceState(history.state, "", location.pathname + location.search); } catch {}
}

const getKey = async k => (await chrome.storage.local.get(k))[k] || {};

async function uuidMap() {
  return (await chrome.storage.local.get(UUID_KEY))[UUID_KEY] || {};
}

async function route(url, init) {
  const u = new URL(url, "http://x");
  const p = u.pathname;
  const qs = u.searchParams;

  // UI preferences (first-run notice dismissal). Local only, never sent anywhere.
  if (p === "/api/prefs") {
    const cur = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] || {};
    if (init && init.method === "POST") {
      const next = Object.assign({}, cur, JSON.parse(init.body));
      await chrome.storage.local.set({ [PREFS_KEY]: next });
      return next;
    }
    return cur;
  }

  /* Notes and cutups: local only, never sent anywhere. Each write touches one
     note or one cutup, read-modify-write here, so two NFL Pro tabs editing
     different cutups cannot overwrite each other's work. */
  if (p === "/api/library") {
    return { notes: await getKey(NOTES_KEY), cutups: await getKey(CUTS_KEY) };
  }
  if (p === "/api/note" && init && init.method === "POST") {
    const b = JSON.parse(init.body);
    const m = await getKey(NOTES_KEY);
    const t = String(b.text || "").slice(0, 4000);
    if (t.trim()) m[b.key] = { t, at: Date.now() };
    else delete m[b.key];
    await chrome.storage.local.set({ [NOTES_KEY]: m });
    return { ok: true };
  }
  if (p === "/api/cutup" && init && init.method === "POST") {
    const b = JSON.parse(init.body);
    const m = await getKey(CUTS_KEY);
    if (b.delete) delete m[b.delete];
    else if (b.cutup && b.cutup.id) m[b.cutup.id] = b.cutup;
    await chrome.storage.local.set({ [CUTS_KEY]: m });
    return { ok: true };
  }
  if (p === "/api/pending_import") {
    const v = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || null;
    if (v) await chrome.storage.local.remove(PENDING_KEY);
    return { link: v };
  }

  // nflverse old_game_id -> NFL Pro fapiGameId, learned at runtime, kept locally
  if (p === "/api/game_uuid") {
    const m = await uuidMap();
    if (init && init.method === "POST") {
      const b = JSON.parse(init.body);
      if (b.many && typeof b.many === "object") {
        for (const [k, v] of Object.entries(b.many))
          if (/^\d{10}$/.test(k) && typeof v === "string") m[k] = v;
      } else {
        m[String(b.old_game_id)] = b.fapi_game_id;
      }
      await chrome.storage.local.set({ [UUID_KEY]: m });
      return { ok: true };
    }
    return { fapi_game_id: m[qs.get("old_game_id")] || null };
  }

  const op = { "/api/meta": "meta", "/api/columns": "columns",
               "/api/values": "values", "/api/search": "search",
               "/api/players": "players", "/api/player_roles": "player_roles",
               "/api/player_subfilters": "player_subfilters",
               "/api/status": "status", "/api/plays": "plays", "/api/known": "known" }[p];
  if (!op) throw new Error("no route " + p);

  // Object.fromEntries keeps only the LAST value of a repeated key, which would
  // silently drop every facet but one. Repeatable params must use getAll.
  const payload = (op === "search" || op === "player_subfilters" ||
                   op === "player_roles" || op === "values")
    ? Object.assign(Object.fromEntries(qs.entries()),
                    { f: qs.getAll("f"), q: qs.getAll("q"),
                      sub: qs.getAll("sub"), nsub: qs.getAll("nsub") })
    : Object.fromEntries(qs.entries());

  const r = await chrome.runtime.sendMessage({ op, payload });
  if (!r) throw new Error("[iso] no response from extension");
  if (!r.ok) {
    const detail = [r.error || "query failed",
                    r.has ? "ctx=" + JSON.stringify(r.has) : "",
                    r.stack || ""].filter(Boolean).join(" · ");
    throw new Error(detail);
  }
  return r.data;
}

window.addEventListener("message", async (ev) => {
  if (ev.source !== window) return;
  const m = ev.data;
  if (!m || m.__all22 !== "req") return;
  let reply;
  try {
    reply = { ok: true, json: await route(m.url, m.init) };
  } catch (e) {
    reply = { ok: false, error: (String(e && e.message || e).startsWith("[") ? "" : "[iso] ")
                              + String(e && e.message || e) };
  }
  window.postMessage({ __all22: "res", id: m.id, reply }, "*");
});

// relay load progress to the panel so a 14 MB first run isn't a blank box
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.all22 === "progress") {
    window.postMessage({ __all22: "progress", ...msg }, "*");
  }
});
