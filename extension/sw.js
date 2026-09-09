/* Service worker: owns the offscreen document's lifecycle and relays queries.
   MV3 service workers are killed aggressively, so the offscreen doc (which holds
   the ~61 MB database in memory) is created on demand and left running. */
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Runs the local play-by-play database (SQLite/WASM) off the page.",
  });
  try { await creating; } finally { creating = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.all22 === "progress") {
    // runtime.sendMessage reaches extension contexts only, so fan progress out
    // to the content scripts explicitly
    chrome.tabs.query({ url: "https://pro.nfl.com/*" }).then(tabs =>
      tabs.forEach(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
    return;
  }
  if (!msg.op) return;
  (async () => {
    await ensureOffscreen();
    // chrome.storage is not exposed inside an offscreen document, so read the
    // dev override here and pass it along.
    const { manifestUrl } = await chrome.storage.local.get("manifestUrl");
    const payload = Object.assign({}, msg.payload, manifestUrl ? { manifestUrl } : null);
    const r = await chrome.runtime.sendMessage({ target: "offscreen", op: msg.op, payload });
    respond(r);
  })().catch(e => respond({
    ok: false,
    error: "[sw] " + String(e && e.message || e),
    where: "service-worker",
    has: { offscreen: typeof (chrome && chrome.offscreen),
           storage: typeof (chrome && chrome.storage) },
  }));
  return true;
});
