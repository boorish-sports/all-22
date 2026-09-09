/* All-22 Film Search — runs in the page on pro.nfl.com (manifest world: "MAIN").
 *
 * Why it lives here rather than in a localhost page: NFL's clips are Widevine /
 * FairPlay DRM, played through THEOplayer under a domain-locked license. They can
 * only decrypt on nfl.com. So the search panel comes to the video, not the other
 * way round -- one tab, no popups, NFL's own player, your own subscription.
 *
 * Search itself is local (http://localhost:8722, nflverse SQLite, 372 columns).
 * Nothing is downloaded, cached or re-hosted.
 */
(() => {
  if (window.__all22) return;
  window.__all22 = true;

  const API = "http://localhost:8722";
  const ANGLES = ["Sideline", "Endzone"];     // All-22 coaches angles; Broadcast excluded
  // localhost calls go through the isolated-world content script (CSP-immune)
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", ev => {
    const m = ev.data;
    if (ev.source !== window || !m) return;
    if (m.__all22 === "progress") {
      const st = document.getElementById("all22-st");
      if (!st || st.dataset.loaded) return;
      st.textContent = {
        downloading: "downloading play index (" + Math.round((m.bytes || 0) / 1e6) + " MB, one time)…",
        decompressing: "unpacking index…",
        opening: "opening database…",
      }[m.stage] || "loading…";
      return;
    }
    if (m.__all22 !== "res") return;
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m.reply); }
  });
  function backend(path, init) {
    return new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, reply => {
        if (!reply || reply.error) return rej(new Error(reply ? reply.error : "no reply"));
        if (!reply.ok) return rej(new Error("backend HTTP " + reply.status));
        res(reply.json);
      });
      window.postMessage({ __all22: "req", id, url: API + path, init }, "*");
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); rej(new Error("index did not load — check the extension's service worker console")); }
      }, 120000);
    });
  }
  const post = (path, body) => backend(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const $ = (t, css, html) => {
    const e = document.createElement(t);
    if (css) e.style.cssText = css;
    if (html != null) e.innerHTML = html;
    return e;
  };
  // nflverse column names are snake_case with a lot of domain acronyms; render
  // them as a human would write them rather than making people read raw keys.
  const ACRONYMS = new Set(["epa","wpa","wp","cpoe","yac","td","qb","rb","wr","te","fg","xp",
    "id","nfl","pff","rpo","ypa","ol","dl","lb","db","cb","ko","pat","gsis","ngs","ftn","ep"]);
  /* Names the generic snake_case rule gets wrong or leaves as machine talk.
     nflverse names a column for the code that writes it, not for the person
     reading it -- "is_qb_fault_sack", "sp", "ydsnet", "xyac_fd". Anything a
     human would not say out loud gets spelled out here. */
  const COL_NAMES = {
    // core row
    desc: "Play description", posteam: "Offense", defteam: "Defense",
    old_game_id: "Game ID", play_id: "Play ID", ydstogo: "Yards to go",
    qtr: "Quarter", yardline_100: "Yards from end zone",
    yrdln: "Yard line", ydsnet: "Drive net yards",
    posteam_type: "Offense home/away",
    posteam_timeouts_remaining: "Offense timeouts left",
    defteam_timeouts_remaining: "Defense timeouts left",
    play_type_nfl: "Play type (NFL)", st_play_type: "Special teams play type",
    // both are game keys; only old_game_id is the numeric one the panel uses
    game_id: "Game key",

    // models: expected points, win probability, completion probability
    ep: "Expected points", epa: "EPA", qb_epa: "QB EPA",
    air_epa: "Air EPA", yac_epa: "YAC EPA",
    comp_air_epa: "Completed air EPA", comp_yac_epa: "Completed YAC EPA",
    wp: "Win probability", wpa: "Win probability added",
    def_wp: "Defense win probability",
    home_wp: "Home win probability", away_wp: "Away win probability",
    home_wp_post: "Home win probability (after)",
    away_wp_post: "Away win probability (after)",
    vegas_wp: "Vegas win probability", vegas_home_wp: "Vegas home win probability",
    cp: "Completion probability", cpoe: "CPOE",
    no_score_prob: "No score probability", opp_fg_prob: "Opponent FG probability",
    opp_safety_prob: "Opponent safety probability", opp_td_prob: "Opponent TD probability",
    extra_point_prob: "Extra point probability",
    two_point_conversion_prob: "Two-point conversion probability",
    xyac_epa: "xYAC EPA", xyac_mean_yardage: "xYAC mean yardage",
    xyac_median_yardage: "xYAC median yardage",
    xyac_success: "xYAC success probability",
    xyac_fd: "xYAC first-down probability",
    xpass: "Pass probability (xPass)", pass_oe: "Pass rate over expected",

    // spelled-out abbreviations
    sp: "Scoring play", div_game: "Divisional game",
    drive_inside20: "Drive reached inside 20",
    fixed_drive: "Drive number", fixed_drive_result: "Drive result",
    two_point_conv_result: "Two-point conversion result",
    defensive_two_point_attempt: "Defensive two-point attempt",
    defensive_two_point_conv: "Defensive two-point conversion",
    defensive_extra_point_conv: "Defensive extra point conversion",
    quarter_end: "Quarter ended",
    // success is exactly epa > 0; say so rather than leaving it to be guessed
    success: "Successful play (EPA > 0)",
    // nflverse's own convenience flag, not the same set as special_teams_play
    special: "Special teams flag",
    n_blitzers: "# Blitzers", n_pass_rushers: "# Pass rushers",
    n_defense_box: "# In the box", n_offense_backfield: "# In the backfield",
    name: "Primary player", id: "Primary player ID",

    // 0/1 event flags whose plain name is now taken by the merged player
    // column: "Sack = W.Anderson" is a person, "Sack occurred: Yes" is a fact
    sack: "Sack occurred", qb_hit: "QB hit occurred",
    solo_tackle: "Solo tackle occurred", assist_tackle: "Assist tackle occurred",
    tackle_with_assist: "Tackle with assist occurred",

    /* FTN charting. Every one of these is a yes/no, so the "is_" prefix the
       schema carries is noise the value already says: "Play action: Yes".
       Labels match the Did menu's sub-filters so the same thing is called the
       same thing in both places. */
    is_play_action: "Play action", is_rpo: "RPO", is_screen_pass: "Screen pass",
    is_motion: "Pre-snap motion", is_trick_play: "Trick play",
    is_no_huddle: "No huddle (FTN)", is_qb_sneak: "QB sneak",
    is_qb_out_of_pocket: "QB out of pocket", is_throw_away: "Throwaway",
    is_interception_worthy: "Interception-worthy",
    is_catchable_ball: "Catchable ball", is_contested_ball: "Contested ball",
    is_created_reception: "Created reception", is_drop: "Drop",
    is_qb_fault_sack: "Sack was QB's fault",
    read_thrown: "Read thrown to", qb_location: "QB alignment",
  };
  /* Merged columns, published by the backend: one "Forced fumble" instead of
     the two numbered slots nflverse actually stores. GROUPS is keyed by the
     synthetic "@..." column, MEMBER maps each real slot back to its group so a
     raw key typed in full still reads as a name rather than a schema dump. */
  let GROUPS = {}, MEMBER = {};
  function humanCol(c) {
    if (!c) return "";
    if (GROUPS[c]) return GROUPS[c].label;
    if (MEMBER[c] && MEMBER[c].slot) return `${MEMBER[c].label} (slot ${MEMBER[c].slot})`;
    if (COL_NAMES[c]) return COL_NAMES[c];
    const parts = String(c).split("_");
    if (parts[0] === "n" && parts.length > 1) parts[0] = "#";
    return parts.map((w, i) => {
      if (!w) return w;
      if (w === "#") return w;
      if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : w;
    }).join(" ");
  }
  const OPSYM = { eq: "=", ne: "\u2260", gt: ">", gte: "\u2265", lt: "<", lte: "\u2264",
                  like: "contains", notnull: "is set", isnull: "is empty" };

  const esc = s => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const nuxt = () => window.$nuxt;

  /* ---------------- NFL Pro API (via the app's authed axios) ---------------- */

  // nflverse old_game_id (2025090705) -> NFL Pro fapiGameId (UUID).
  // The coaches endpoint only accepts the UUID: pass the numeric id and it
  // returns 200 with zero items.
  const uuidCache = new Map();
  async function gameUuid(row) {
    const key = String(row.old_game_id);
    if (uuidCache.has(key)) return uuidCache.get(key);
    try {
      const c = await backend(`/api/game_uuid?old_game_id=${key}`);
      if (c && c.fapi_game_id) { uuidCache.set(key, c.fapi_game_id); return c.fapi_game_id; }
    } catch {}
    const d = await nuxt().$api.$get("/api/secured/videos/filmroom/plays", {
      params: { season: row.season, seasonType: row.season_type, weekSlug: row.week_slug, gameId: key },
    });
    const uuid = d.plays && d.plays.length ? d.plays[0].fapiGameId : null;
    if (uuid) {
      uuidCache.set(key, uuid);
      post("/api/game_uuid", { old_game_id: key, fapi_game_id: uuid }).catch(() => {});
    }
    return uuid;
  }

  async function clipFor(row) {
    const uuid = await gameUuid(row);
    if (!uuid) throw new Error("no NFL Pro game for " + row.old_game_id);
    const d = await nuxt().$api.$get("/api/secured/videos/coaches",
      { params: { gameId: uuid, playId: row.play_id } });
    const items = d.items || [];
    const list = ANGLES.map(a => items.find(i => i.cameraSource === a)).filter(Boolean);
    if (!list.length) throw new Error("no Sideline/Endzone clip for this play");
    return list.map(t => ({
      videoView: t.cameraSource.toLowerCase(), title: t.description, id: t.id,
      mcpID: t.mcpPlaybackId,
      posterImage: t.thumbnail && t.thumbnail.thumbnailUrl,
      imageSrc: t.thumbnail && t.thumbnail.thumbnailUrl,
    }));
  }

  /* ---------------- player ---------------- */
  let root = null, curList = [], curIdx = 0, syncTimer = null, vpCache = null;

  // Find NFL's player instance by walking the React fiber off the mounted node.
  // Breadth-first: the instance is not on the first-child chain, and a passed
  // ref is not reliable here.
  function livePlayer() {
    if (vpCache && vpCache.state && document.contains(vpCache._a22box)) return vpCache;
    const box = document.querySelector("#all22-video .a22box");
    if (!box) return null;
    let fiber = null;
    for (const k in box) if (k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$")) { fiber = box[k]; break; }
    const q = [fiber];
    let n = 0;
    while (q.length && n < 4000) {
      const f = q.shift(); n++;
      if (!f) continue;
      const si = f.stateNode;
      const cand = si && si.videoPlayer && si.videoPlayer.props ? si.videoPlayer
                 : (si && si.props && Array.isArray(si.props.playlist) && typeof si.loadVideoFromProps === "function" ? si : null);
      if (cand) { cand._a22box = box; vpCache = cand; return cand; }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }
    return null;
  }

  function drawAngles() {
    const bar = document.getElementById("all22-ang");
    if (!curList.length) { bar.innerHTML = ""; return; }
    bar.innerHTML = curList.map((c, i) =>
      `<button class="${i === curIdx ? "on" : ""}" data-i="${i}">${esc(c.videoView)}</button>`).join("") +
      '<span class="khint" title="Keyboard shortcuts">? Keys · \u2190 \u2192 Frame step</span>';
    bar.querySelectorAll("button").forEach(b => b.onclick = () => setAngle(+b.dataset.i));
    const kh = bar.querySelector(".khint");
    if (kh) kh.onclick = () => toggleHelp();
  }

  function setAngle(i) {
    if (!curList[i]) return;
    const vp = livePlayer();
    if (vp && vp.props && typeof vp.loadVideoFromProps === "function") {
      try {
        vp.props.currentVideoIndex = i;   // playlist is in canonical order, so no offset
        vp.loadVideoFromProps();
        curIdx = i; drawAngles();
        return;
      } catch {}
    }
    render(curList);                       // fallback: remount, then switch
    curIdx = i; drawAngles();
    setTimeout(() => { const v = livePlayer(); if (v && i) { try { v.props.currentVideoIndex = i; v.loadVideoFromProps(); } catch {} } }, 700);
  }

  // The live angle lives in state.currentVideo.videoView. props.currentVideoIndex
  // is only the initial value and never updates, so it cannot be used here.
  /* NFL's player records its container width when it mounts and pins a pixel
     max-width on its wrappers. Widening the panel therefore leaves the video at
     its original size, and a window resize event alone does NOT dislodge it
     (measured: box 1395 / video 639 before and after). Rewriting those pinned
     max-widths to the current box, then firing resize, does. */
  function relayoutVideo() {
    const box = document.querySelector("#all22-video .a22box");
    const el = document.querySelector("#all22-video video");
    // only touch a player that has finished mounting -- poking its DOM mid-init
    // leaves it spinning forever
    if (!box || !el) return;
    const w = Math.round(box.getBoundingClientRect().width);
    if (!w) return;
    let touched = 0;
    box.querySelectorAll("*").forEach(el => {
      const m = getComputedStyle(el).maxWidth;
      // only the stale pins that are now too small; leave everything else alone
      if (m && m !== "none" && m.endsWith("px") && parseFloat(m) < w - 1) {
        el.style.maxWidth = w + "px";
        touched++;
      }
    });
    if (touched) window.dispatchEvent(new Event("resize"));
  }

  // one pass, once the resize has settled -- repeated passes during init
  // are what broke playback
  let relayoutTimer = null;
  function relayoutSoon(attempt) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      const ready = !!document.querySelector("#all22-video video");
      if (ready) return relayoutVideo();
      // resized while the clip was still loading: wait for it, but only twice
      if ((attempt || 0) < 2) relayoutSoon((attempt || 0) + 1);
    }, 260 + (attempt || 0) * 900);
  }

  // A width change resizes the player's container; THEOplayer stops on that.
  // The element is never remounted, so just restore the previous state.
  function preservePlayback(fn) {
    let wasPlaying = false;
    const v = document.querySelector("#all22-video video");
    try { wasPlaying = !!(v && !v.paused && !v.ended); } catch {}
    fn();
    if (!wasPlaying) return;
    let tries = 0;
    const tick = setInterval(() => {
      const el = document.querySelector("#all22-video video");
      if (!el || ++tries > 12) return clearInterval(tick);
      if (el.paused && !el.ended) {
        const vp = livePlayer();
        try {
          if (vp && typeof vp.resume === "function") vp.resume();
          else el.play();
        } catch {}
      } else {
        clearInterval(tick);
      }
    }, 120);
  }

  function currentAngleIndex() {
    const vp = livePlayer();
    const view = vp && vp.state && vp.state.currentVideo && vp.state.currentVideo.videoView;
    if (!view) return null;
    const k = curList.findIndex(c => c.videoView === String(view).toLowerCase());
    return k === -1 ? null : k;
  }

  function startSync() {
    clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      const host = document.getElementById("all22-video");
      if (!host || !host.firstChild) { clearInterval(syncTimer); return; }
      const i = currentAngleIndex();
      if (i != null && i !== curIdx) { curIdx = i; drawAngles(); }
    }, 400);
  }

  function render(playlist) {
    const host = document.getElementById("all22-video");
    host.innerHTML = "";
    vpCache = null;
    const box = $("div");
    box.className = "a22box";
    host.appendChild(box);
    const U = window.NflRnUmdComponents;
    if (!U || !U.Video || !window.React || !window.ReactDOM) {
      host.innerHTML = '<div style="padding:18px;color:#e0a86b">NFL player not loaded on this page — open the Film Room once, then retry.</div>';
      return;
    }
    root = window.ReactDOM.createRoot(box);
    root.render(window.React.createElement(U.Video.Video, {
      playlist, currentVideoIndex: 0,
      autoplay: true, autoDocking: false, enableTheoPlayer: true,
      enablePlaybackRateControls: true, loop: false, defaultMuted: false,
      startWithControlsVisible: true, withoutBgLayer: true,
      staging: false, env: "PROD", analytics: {},
    }));
    startSync();
  }

  function mount(playlist) {
    fps = 30;
    bare = false;
    setTimeout(() => measureFps(vid()), 600);
    curList = playlist;
    curIdx = 0;
    drawAngles();
    render(playlist);
  }

  /* ---------------- keyboard ----------------
   * Built on the raw <video> element rather than NFL's player, because the one
   * thing film study needs -- stepping a single frame -- has no API there.
   * Seeking to currentTime ± 1/fps lands on the adjacent frame.
   */
  const vid = () => document.querySelector("#all22-video video");
  let fps = 30;                       // refined per clip by measurement below

  // Derive the real frame rate from presentation timestamps instead of assuming
  // 30: coaches film is not always 30, and a wrong step drifts or double-steps.
  function measureFps(v) {
    if (!v || typeof v.requestVideoFrameCallback !== "function") return;
    const deltas = [];
    let last = null;
    const cb = (_now, meta) => {
      if (last != null) {
        const d = meta.mediaTime - last;
        if (d > 0.004 && d < 0.2) deltas.push(d);
      }
      last = meta.mediaTime;
      if (deltas.length < 10) { try { v.requestVideoFrameCallback(cb); } catch {} return; }
      deltas.sort((a, b) => a - b);
      const med = deltas[deltas.length >> 1];
      if (med > 0) fps = Math.min(120, Math.max(10, Math.round(1 / med)));
    };
    try { v.requestVideoFrameCallback(cb); } catch {}
  }

  /* NFL's controls are emotion-hashed (css-g5y9jx r-13awgt0...), so they cannot
     be targeted by class. Find them structurally instead: the shallowest element
     that holds the control buttons but does NOT wrap the <video>. That is the
     whole UI layer painted over the picture. */
  function controlLayer() {
    const box = document.querySelector("#all22-video .a22box");
    const v = box && box.querySelector("video");
    if (!v) return null;
    const tagged = box.querySelector(".a22-ui");
    if (tagged && tagged.isConnected) return tagged;
    let best = null, bestDepth = 1e9, maxBtns = 0;
    box.querySelectorAll("div").forEach(el => {
      if (el.contains(v)) return;
      const n = el.querySelectorAll('button,[role="button"],[aria-label]').length;
      if (!n) return;
      let d = 0;
      for (let x = el; x && x !== box; x = x.parentElement) d++;
      if (n > maxBtns || (n === maxBtns && d < bestDepth)) { maxBtns = n; bestDepth = d; best = el; }
    });
    if (best) best.classList.add("a22-ui");

    // NFL dims the picture while paused with a translucent black layer plus a
    // gradient. Those survive their controls auto-hiding, so tag them too.
    box.querySelectorAll("div").forEach(el => {
      if (el.contains(v) || el.classList.contains("a22-scrim")) return;
      const r = el.getBoundingClientRect();
      if (r.width < box.clientWidth * 0.8 || r.height < box.clientHeight * 0.8) return;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor || "";
      const bi = cs.backgroundImage || "";
      const m = bg.match(/rgba\(0,\s*0,\s*0,\s*([\d.]+)\)/);
      const dimBg = m && parseFloat(m[1]) > 0.02;
      const dimGrad = bi.includes("gradient") && bi.includes("rgba(0, 0, 0");
      if (dimBg || dimGrad) el.classList.add("a22-scrim");
    });
    return best;
  }

  let bare = false;
  function setBare(on) {
    const box = document.querySelector("#all22-video .a22box");
    if (!box) return;
    controlLayer();                       // tag it before toggling
    bare = !!on;
    box.classList.toggle("bare", bare);
    if (!bare) { const t = document.getElementById("a-tc"); if (t) t.remove(); }
    else timecode();
  }

  // In bare mode the controls are gone, so show a small frame/time readout in a
  // corner instead -- enough to know where you are without covering the play.
  function timecode() {
    const v = vid();
    if (!v || !bare) return;
    let el = document.getElementById("a-tc");
    if (!el) {
      el = $("div");
      el.id = "a-tc";
      el.setAttribute("data-a22", "");
      (document.querySelector("#all22-video .a22box") || p).appendChild(el);
    }
    const t = v.currentTime;
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(Math.floor(t % 60)).padStart(2, "0");
    const ff = String(Math.floor((t % 1) * fps)).padStart(2, "0");
    el.textContent = `${mm}:${ss}.${ff}  ·  ${fps}fps`;
  }

  function stepFrames(n) {
    const v = vid();
    if (!v) return;
    v.pause();
    const d = isFinite(v.duration) ? v.duration : 1e9;
    v.currentTime = Math.max(0, Math.min(d - 1e-4, v.currentTime + n / fps));
    setBare(true);            // stepping means studying: get the chrome out of the way
    setTimeout(timecode, 30);
  }

  function seekBy(sec) {
    const v = vid();
    if (!v) return;
    const d = isFinite(v.duration) ? v.duration : 1e9;
    v.currentTime = Math.max(0, Math.min(d - 1e-4, v.currentTime + sec));
    flash((sec > 0 ? "+" : "") + sec + "s");
  }

  function setRate(mult) {
    const v = vid();
    if (!v) return;
    v.playbackRate = Math.min(4, Math.max(0.1, +(v.playbackRate * mult).toFixed(2)));
    flash(v.playbackRate + "×");
  }

  let flashTimer = null;
  function flash(txt) {
    let el = document.getElementById("a-flash");
    if (!el) {
      el = $("div");
      el.id = "a-flash";
      el.setAttribute("data-a22", "");
      (document.getElementById("all22-video") || p).appendChild(el);
    }
    el.textContent = txt;
    el.style.opacity = "1";
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.style.opacity = "0"; }, 700);
  }

  const HELP = [
    ["Space / K", "Play · pause"],
    ["← →", "Step one frame"],
    ["Shift ← →", "Step 10 frames"],
    ["J / L", "Back / forward 1s"],
    ["Shift J / L", "Back / forward 5s"],
    ["0 / Home", "Restart clip"],
    ["1 / 2", "Sideline / endzone"],
    ["N / P", "Next / previous play"],
    ["[ ]", "Slower / faster"],
    ["H", "Hide / show controls"],
    ["M", "Mute"],
    ["F", "Fullscreen"],
    ["?", "Toggle this help"],
  ];

  function toggleHelp(force) {
    let el = document.getElementById("a-help");
    if (el && force !== true) { el.remove(); return; }
    if (el) return;
    el = $("div");
    el.id = "a-help";
    el.setAttribute("data-a22", "");
    el.innerHTML = "<b>Keyboard</b>" + HELP.map(([k, v]) =>
      `<div><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join("");
    el.onclick = () => el.remove();
    (document.getElementById("all22-video") || p).appendChild(el);
  }

  function keyHandler(e) {
    if (p.classList.contains("hid")) return;
    if (e.key === "Escape" && !document.getElementById("a-dict").hidden) {
      showDict(false);
      e.preventDefault();
      return;
    }
    const t = e.target;
    // never steal keys from the filter inputs
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = vid();
    const k = e.key;
    let handled = true;

    switch (k) {
      case " ": case "k":
        if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); }
        setBare(false);
        break;
      case "h": setBare(!bare); break;
      case "ArrowLeft":  stepFrames(e.shiftKey ? -10 : -1); break;
      case "ArrowRight": stepFrames(e.shiftKey ? 10 : 1); break;
      case ",":          stepFrames(-1); break;
      case ".":          stepFrames(1); break;
      case "j":          seekBy(e.shiftKey ? -5 : -1); break;
      case "l":          seekBy(e.shiftKey ? 5 : 1); break;
      case "0": case "Home":
        if (v) { v.currentTime = 0; flash("restart"); }
        break;
      case "1": setBare(false); setAngle(0); break;
      case "2": setBare(false); setAngle(1); break;
      case "n": if (selIdx + 1 < lastRows.length) selectPlay(selIdx + 1); break;
      case "p": if (selIdx > 0) selectPlay(selIdx - 1); break;
      case "[": setRate(1 / 1.25); break;
      case "]": setRate(1.25); break;
      case "m": if (v) { v.muted = !v.muted; flash(v.muted ? "muted" : "unmuted"); } break;
      case "f":
        try {
          const host = document.getElementById("all22-video");
          document.fullscreenElement ? document.exitFullscreen() : host.requestFullscreen();
        } catch {}
        break;
      case "?": toggleHelp(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();   // keep NFL's own handlers from firing twice
    }
  }
  // capture phase so the page cannot swallow the key first
  window.addEventListener("keydown", keyHandler, true);
  // A click on the picture brings the controls back. Deliberately NOT mousemove:
  // the mouse sits idle over the video while you work the keyboard, and the
  // slightest drift was cancelling bare mode instantly.
  document.addEventListener("click", e => {
    if (!bare) return;
    const host = document.getElementById("all22-video");
    if (host && host.contains(e.target)) setBare(false);
  }, true);

  /* ---------------- UI ---------------- */
  const CSS = `
  #all22{position:fixed;top:0;right:0;width:640px;height:100vh;z-index:2147483000;
    background:#121212;color:#e6e6e6;font:13px/1.45 "All-ProSans-Regular",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    border-left:1px solid #282828;display:flex;flex-direction:column;box-shadow:-8px 0 30px #0008}
  #all22.hid{transform:translateX(100%)}
  #all22.wide{width:calc(100% - 30px)}
  #all22 h2{margin:0;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#b1924f;font-family:"AllProDisplayC-Bold","All-ProSans-Medium",sans-serif}
  #all22 .hd{padding:11px 14px;border-bottom:1px solid #282828;display:flex;justify-content:space-between;align-items:center}
  #all22 .fl{padding:10px 14px;border-bottom:1px solid #282828;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  /* Scope every control style to our own toolbars. A bare "#all22 button" rule
     also hits NFL's player controls, which mount inside this panel -- that paints
     the play/pause/scrubber gold and buries the video. */
  #all22 .fl input,#all22 .fl select{background:#1e1e1e;border:1px solid #282828;color:#e6e6e6;padding:5px 7px;border-radius:4px;font:inherit;font-size:12px}
  #all22 .fl input:focus,#all22 .fl select:focus{outline:none;border-color:#b1924f}
  #all22 .fl [hidden]{display:none!important}
  #all22 .fl button,#all22 .hd button{background:#b1924f;color:#17130a;border:0;padding:6px 13px;border-radius:4px;font:600 12px inherit;cursor:pointer}
  #all22 .fl button.g,#all22 .hd button.g{background:transparent;color:#adadad;border:1px solid #282828;padding:4px 9px;font-weight:500}
  #all22 .fl button.g:hover,#all22 .hd button.g:hover{color:#b1924f;border-color:#b1924f}
  /* icon buttons: square, quiet until hovered, gold like everything else */
  #all22 .hd .btns{display:flex;gap:6px;align-items:center}
  #all22 .hd button.ib{background:transparent;color:#adadad;border:1px solid #282828;
    padding:0;width:28px;height:28px;border-radius:4px;display:inline-flex;
    align-items:center;justify-content:center;cursor:pointer}
  #all22 .hd button.ib:hover{color:#b1924f;border-color:#b1924f}
  #all22 .hd button.ib svg{width:16px;height:16px;display:block}
  /* hard boundary: nothing of ours reaches into the player subtree */
  #all22-video{contain:layout style}
  /* Everything below the video scrolls as one region. Without min-height:0 a
     flex child refuses to shrink below its content, so it overflows instead of
     scrolling and the wheel falls through to the page underneath. */
  #all22 .body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  #all22 .res{}
  #all22 .dict{flex:1;min-height:0;display:flex;flex-direction:column;background:#121212}
  #all22 .dict[hidden]{display:none}
  #all22 .dhead{display:flex;gap:8px;align-items:center;padding:10px 14px;
    border-bottom:1px solid #282828;background:#191919}
  #all22 .dhead input{flex:1;background:#1e1e1e;border:1px solid #282828;color:#e6e6e6;
    padding:6px 9px;border-radius:4px;font:inherit;font-size:12px}
  #all22 .dhead input:focus{outline:none;border-color:#b1924f}
  #all22 .dhead .dcount{color:#bdbdbd;font-size:11px;white-space:nowrap}
  #all22 .dlist{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  #all22 .dent{padding:10px 14px;border-bottom:1px solid #232323;cursor:pointer}
  #all22 .dent:hover{background:#1e1e1e}
  #all22 .dent .dtop{display:flex;gap:8px;align-items:baseline}
  #all22 .dent .dname{color:#e6e6e6;font-weight:600;font-size:12.5px}
  #all22 .dent .dkind{color:#bdbdbd;font-size:10px;letter-spacing:.06em;
    text-transform:uppercase;margin-left:auto;white-space:nowrap}
  #all22 .dent .dkey{color:#8f8f8f;font-family:ui-monospace,Menlo,monospace;font-size:10px}
  #all22 .dent .ddesc{color:#bdbdbd;font-size:11.5px;line-height:1.4;margin-top:3px}
  #all22 .dval{font-size:11px;color:#a3a3a3;font-family:ui-monospace,Menlo,monospace}
  #all22 .dent .dval{margin-top:4px}
  #all22 .dval b{color:#b1924f;font-weight:600;cursor:pointer}
  #all22 .dval b:hover{color:#c9a961;text-decoration:underline}
  #all22 .dn{color:#8f8f8f}
  #all22 .dempty{padding:16px 14px;color:#bdbdbd;font-size:12px}

  #all22 .row{padding:9px 14px;border-bottom:1px solid #232323;cursor:pointer}
  #all22 .row:hover{background:#1e1e1e}
  #all22 .row.on{background:#282828;border-left:3px solid #b1924f;padding-left:11px}
  #all22 .m{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#adadad}
  #all22 .pos{color:#5cc98a}#all22 .neg{color:#e0736b}
  #all22 .st{padding:9px 14px;color:#adadad;font-size:12px}
  #all22-video{background:#000;width:100%;display:flex;justify-content:center}
  /* Fill the panel width, limited only by the height actually available:
     100vh minus the header, the angle buttons and one filter row. In wide mode
     that is roughly double the old 620px-height cap; in narrow, width:100%
     still governs. */
  #all22-video .a22box{width:100%;max-width:calc((100vh - 210px) * 16 / 9);
    aspect-ratio:16/9;background:#000;position:relative}
  /* NFL's player wraps the <video> in divs that size to their own defaults;
     make the chain fill the box so the picture scales with the panel */
  /* stretch the player's own wrappers, but never our injected overlays --
     :not([data-a22]) matters: without it the timecode badge inherited
     width/height 100% and its translucent background dimmed the whole picture */
  #all22-video .a22box > div:not([data-a22]),
  #all22-video .a22box > div:not([data-a22]) > div{width:100%;height:100%}
  #all22-video video{width:100%;height:100%;object-fit:contain;background:#000}
  #all22 .pwrap{position:relative;display:inline-block}
  #all22 .pmenu{position:absolute;top:100%;left:0;z-index:5;min-width:280px;max-height:260px;
    overflow:auto;background:#1e1e1e;border:1px solid #282828;border-radius:4px;margin-top:3px;
    box-shadow:0 8px 26px #000a}
  #all22 .pmenu div{padding:7px 10px;cursor:pointer;font-size:12px;display:flex;
    justify-content:space-between;gap:10px;align-items:baseline}
  #all22 .pmenu div:hover,#all22 .pmenu div.sel{background:#282828}
  #all22 .pmenu .who{color:#e6e6e6}
  #all22 .pmenu .meta2{color:#adadad;font-size:11px;white-space:nowrap}
  #all22 .ctl{display:inline-flex;flex-direction:column;gap:3px}
  #all22 .ctl > span:first-child{font-size:10px;letter-spacing:.02em;
    color:#adadad;padding-left:2px}
  #all22 #a-role-wrap{display:none}
  #all22 #a-role-wrap.on{display:inline-flex}
  #all22 #a-facethead{display:none;align-items:center;gap:8px;padding:7px 14px;
    background:#191919;border-bottom:1px solid #282828;cursor:pointer;user-select:none}
  #all22 #a-facethead.on{display:flex}
  #all22 #a-facethead:hover{background:#1e1e1e}
  #all22 #a-facethead .cap{font-size:11px;letter-spacing:.02em;color:#adadad;min-width:82px}
  #all22 #a-facethead .sum{font-size:11px;color:#a3a3a3;flex:1;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  #all22 #a-facethead .sum .k{color:#bdbdbd;font-size:10px;letter-spacing:.04em;
    text-transform:uppercase;margin-right:6px}
  #all22 #a-facethead .sum .grp{margin-right:14px}
  #all22 #a-facethead .sum .grp+.grp{border-left:1px solid #303030;padding-left:13px}
  #all22 #a-facethead .sum .v{color:#b1924f;font-weight:600}
  #all22 #a-facethead .sum .x{color:#be6f60;font-weight:600}
  #all22 #a-facethead .sum .v+.v::before,#all22 #a-facethead .sum .x+.x::before{
    content:"\\00b7";color:#7d7d7d;font-weight:400;margin:0 5px}
  #all22 #a-facethead .sum .none{color:#bdbdbd}
  #all22 #a-facethead .chev{color:#a3a3a3;font-size:10px;transition:transform .15s}
  #all22 #a-facethead.shut .chev{transform:rotate(-90deg)}
  #all22 #a-facets{display:none;flex-direction:column;gap:6px;padding:9px 14px;
    border-bottom:1px solid #282828;background:#191919}
  #all22 #a-facets.on{display:flex}
  /* .on and .shut have equal specificity, so this must stay AFTER .on to win */
  #all22 #a-facets.on.shut{display:none}
  #all22 #a-facetrows{display:flex;flex-direction:column;gap:6px}
  #all22 #a-facetrows:empty,#all22 #a-colrow:empty{display:none}
  #all22 #a-facfoot{display:none}
  #all22 #a-facfoot.on{display:flex}
  #all22 .fac{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  #all22 .fac .lab{font-size:11px;letter-spacing:.02em;color:#adadad;min-width:82px}
  #all22 .fac .chip{display:inline-flex;align-items:stretch;border:1px solid #282828;
    border-radius:11px;overflow:hidden;background:#1e1e1e}
  #all22 .fac .chip .inc{background:none;border:0;color:#adadad;padding:4px 9px;
    font:500 11px inherit;cursor:pointer;white-space:nowrap}
  #all22 .fac .chip .exc{background:none;border:0;border-left:1px solid #282828;color:#a3a3a3;
    padding:4px 7px;font:600 11px inherit;cursor:pointer;line-height:1}
  #all22 .fac .chip .inc:hover{color:#e6e6e6}
  #all22 .fac .chip .exc:hover{color:#be6f60;background:#231513}
  #all22 .fac .chip.on{border-color:#b1924f}
  #all22 .fac .chip.on .inc{background:#b1924f;color:#17130a;font-weight:600}
  #all22 .fac .chip.no{border-color:#6d372c}
  #all22 .fac .chip.no .inc{background:#231513;color:#be6f60;text-decoration:line-through}
  #all22 .fac .chip.no .exc{color:#be6f60}
  #all22 .fac .chip.zero .inc{opacity:.38}
  #all22 .fac .allbtn{background:#1e1e1e;color:#adadad;border:1px solid #282828;
    padding:4px 10px;border-radius:11px;font:500 11px inherit;cursor:pointer}
  #all22 .fac .allbtn.on{background:#b1924f;color:#17130a;border-color:#b1924f;font-weight:600}
  #all22 .fac .hint{color:#adadad;font-size:10px;margin-left:2px}
  #all22 #a-hint a{color:#b1924f;text-decoration:none;border-bottom:1px dotted #b1924f80}
  #all22 #a-hint a:hover{color:#c9a961;border-bottom-color:#c9a961}
  #all22 .pchip{background:#b1924f;color:#17130a;border-radius:4px;padding:5px 9px;
    font:600 12px inherit;display:inline-flex;gap:7px;align-items:center;cursor:pointer}
  #all22-video{position:relative}
  #all22-video .a22box.bare .a22-ui{opacity:0!important;pointer-events:none!important}
  /* their paused-state dim outlives the controls, so clear it too */
  #all22-video .a22box.bare .a22-scrim{background:none!important;background-image:none!important}
  /* During a seek the player paints its poster over the picture, which reads as
     a dark flash while scrubbing. Hiding it lets the last decoded frame show
     through instead. These theoplayer-* names are the library's own and stable,
     unlike the emotion hashes on NFL's wrappers. */
  #all22-video .a22box.bare .theoplayer-poster,
  #all22-video .a22box.bare [class*="theoplayer-loading"],
  #all22-video .a22box.bare [class*="theoplayer-spinner"]{opacity:0!important}
  #a-tc{position:absolute;left:10px;bottom:10px;z-index:8;width:auto!important;height:auto!important;background:#000a;color:#b1924f;
    padding:3px 8px;border-radius:4px;font:600 11px ui-monospace,Menlo,monospace;
    letter-spacing:.04em;pointer-events:none}
  #a-flash{position:absolute;left:10px;top:10px;z-index:6;
    background:#000c;color:#b1924f;border:1px solid #b1924f;border-radius:4px;
    padding:4px 9px;font:600 11px "All-ProSans-Medium",sans-serif;letter-spacing:.04em;
    pointer-events:none;opacity:0;transition:opacity .18s}
  #a-help{position:absolute;right:14px;top:14px;z-index:7;background:#121212f2;
    border:1px solid #282828;border-radius:4px;padding:12px 14px;cursor:pointer;
    font:12px "All-ProSans-Regular",sans-serif;color:#e6e6e6;box-shadow:0 10px 34px #000a}
  #a-help b{display:block;color:#b1924f;font-size:10px;letter-spacing:.14em;
    text-transform:uppercase;margin-bottom:8px}
  #a-help div{display:flex;gap:12px;padding:2px 0}
  #a-help kbd{min-width:82px;color:#adadad;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  #all22-ang .khint{margin-left:auto;color:#a3a3a3;font-size:11px;cursor:pointer}
  #all22-ang .khint:hover{color:#b1924f}
  #all22-ang{display:flex;gap:6px;padding:8px 14px;background:#121212;border-bottom:1px solid #282828}
  /* Wide mode covers the page instead of squeezing it into a sliver. This strip
     rides just outside the panel's left edge (translateX(-100%)) and is the way
     back: one click narrows the panel and the page reflows beside it again. */
  #all22 .tray{display:none;position:absolute;left:0;top:0;height:100%;
    box-sizing:border-box;width:30px;transform:translateX(-100%);background:#191919;
    border-left:1px solid #282828;border-right:1px solid #282828;box-shadow:-8px 0 30px #0008;cursor:pointer;
    color:#a3a3a3;flex-direction:column;align-items:center;justify-content:center;
    gap:10px;user-select:none}
  #all22.wide .tray{display:flex}
  #all22 .tray:hover{background:#1e1e1e;color:#b1924f}
  #all22 .tray svg{width:14px;height:14px;display:block;flex:none}
  #all22 .tray span{writing-mode:vertical-rl;font:600 10px "All-ProSans-Medium",sans-serif;
    letter-spacing:.16em;text-transform:uppercase}
  #all22-ang button{background:#1e1e1e;color:#adadad;border:1px solid #282828;padding:5px 14px;
    border-radius:4px;font:600 12px inherit;letter-spacing:.02em;text-transform:capitalize;cursor:pointer}
  #all22-ang button.on{background:#b1924f;color:#17130a;border-color:#b1924f}
  /* Squeeze the NFL Pro page into the remaining width instead of overlaying it.
     The transform on <body> is load-bearing: it makes body the containing block
     for NFL's own position:fixed chrome (score strip, nav), so that reflows too
     rather than staying full-width underneath us. */
  html.a22push body{width:calc(100% - var(--a22w,640px))!important;transform:translateZ(0);min-height:100vh}
  html.a22push{overflow-x:hidden}
  #all22-tab{position:fixed;top:50%;right:0;z-index:2147483000;transform:translateY(-50%);
    background:#b1924f;color:#17130a;writing-mode:vertical-rl;padding:14px 6px;cursor:pointer;
    border-radius:4px 0 0 5px;font:600 11px "All-ProSans-Medium",sans-serif;letter-spacing:.14em}`;
  document.head.appendChild($("style", "", CSS));

  /* Lucide glyphs, inlined. The panel is plain DOM in the page world -- no React,
     no bundler -- so these carry lucide's own path data for chevrons-left,
     chevrons-right and x, with the two subpaths of each chevron joined into one. */
  const ICON = {
    wide:   "m11 17-5-5 5-5M18 17l-5-5 5-5",
    narrow: "m6 17 5-5-5-5M13 17l5-5-5-5",
    hide:   "M18 6 6 18M6 6l12 12",
    book:   "M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
  };
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${d}"/></svg>`;

  const tab = $("div", "", "ALL-22");
  tab.id = "all22-tab";
  // attach to <html>: body gets a transform below, which would otherwise become
  // the containing block for these fixed elements and misplace them
  document.documentElement.appendChild(tab);

  const p = $("div");
  p.id = "all22";
  p.innerHTML = `
    <div class="tray" id="all22-tray" title="Narrow the panel to show NFL Pro">${svg(ICON.narrow)}<span>NFL Pro</span></div>
    <div class="hd"><h2>All-22 Film Search</h2>
      <span class="btns">
        <button class="ib" id="all22-d" title="Filter dictionary" aria-label="Filter dictionary">${svg(ICON.book)}</button>
        <button class="ib" id="all22-w" title="Widen the panel" aria-label="Widen the panel">${svg(ICON.wide)}</button>
        <button class="ib" id="all22-x" title="Hide the panel" aria-label="Hide the panel">${svg(ICON.hide)}</button>
      </span></div>
    <div id="all22-video"></div>
    <div id="all22-ang"></div>
    <div class="body" id="a-body">
    <div class="fl">
      <label class="ctl"><span>Season</span><select id="a-season"></select></label>
      <label class="ctl"><span>Week</span><select id="a-week"><option value="">Any</option></select></label>
      <label class="ctl"><span>Team</span><select id="a-team"><option value="">Any</option></select></label>
      <label class="ctl"><span>Player</span><span class="pwrap"><input id="a-player" placeholder="Any" size="11" autocomplete="off"><div class="pmenu" id="a-pmenu" hidden></div></span></label>
      <label class="ctl" id="a-role-wrap"><span>Did</span><select id="a-role"></select></label>
      <label class="ctl"><span>Play Type</span><select id="a-type"><option value="">Any</option><option value="pass">Pass</option><option value="run">Run</option><option value="punt">Punt</option><option value="field_goal">Field goal</option></select></label>
      <label class="ctl"><span>Sort</span><select id="a-order"><option value="game">By game</option><option value="epa">EPA high</option><option value="epa_asc">EPA low</option></select></label>
    </div>
    <div class="fl">
      <span class="pwrap"><input id="a-col" placeholder="Any pbp column" size="18" autocomplete="off"><div class="pmenu" id="a-colmenu" hidden></div></span>
      <select id="a-op"><option value="eq">=</option><option value="gt">&gt;</option><option value="lt">&lt;</option><option value="gte">&ge;</option><option value="lte">&le;</option><option value="like">Contains</option><option value="notnull">Is set</option></select>
      <input id="a-val" placeholder="Value" size="7">
      <select id="a-bool" hidden><option value="1">Yes</option><option value="0">No</option></select>
      <button class="g" id="a-add">+ Filter</button>
      <input id="a-text" placeholder="Text in description" size="14">
      <button id="a-go">Search</button>
    </div>
    <div id="a-facethead"><span class="cap">Filters</span><span class="sum"></span><span class="chev">&#9660;</span></div>
    <div id="a-facets">
      <div id="a-facetrows"></div>
      <div class="fac" id="a-colrow"></div>
      <div class="fac" id="a-facfoot">
        <span class="lab"></span><span class="hint">&minus; Excludes</span>
        <button class="allbtn" id="a-clear" style="visibility:hidden">Clear all</button>
      </div>
    </div>
    <div class="fl" id="a-hint" style="padding-top:0;border:0;min-height:16px"></div>
    <div class="st" id="all22-st">loading play index…</div>
    <div class="res" id="all22-res"></div>
    </div>
    <div class="dict" id="a-dict" hidden>
      <div class="dhead">
        <input id="a-dsearch" placeholder="Search filter options" autocomplete="off">
        <span class="dcount"></span>
      </div>
      <div class="dlist" id="a-dlist"></div>
    </div>`;
  document.documentElement.appendChild(p);

  const q = s => p.querySelector(s);
  const extra = [];   // active generic filters

  // ---- player autocomplete -------------------------------------------------
  // Descriptions abbreviate names ("51-W.Anderson"), so typing "Will Anderson"
  // never matched. Resolve to a player id instead and filter on participation,
  // which also disambiguates players who share an abbreviation.
  let picked = null, pTimer = null;

  function showPicked() {
    const wrap = q("#a-player").closest(".pwrap");
    let chip = wrap.querySelector(".pchip");
    if (!picked) { if (chip) chip.remove(); q("#a-player").hidden = false; return; }
    q("#a-player").hidden = true;
    if (!chip) {
      chip = $("span");
      chip.className = "pchip";
      wrap.insertBefore(chip, wrap.firstChild);
      chip.onclick = () => {
        picked = null; facets = {}; excl = new Set(); showPicked(); loadRoles(); loadSubs();
        q("#a-player").value = ""; q("#a-player").focus(); run();
      };
    }
    chip.textContent = picked.name + " ✕";
    chip.title = [picked.position, picked.team, picked.plays + " plays"].filter(Boolean).join(" · ");
  }

  function closeMenu() { q("#a-pmenu").hidden = true; }

  // Populate the role menu with this player's real counts, so "Forced fumble (6)"
  // means six plays he forced one -- not six plays where a fumble happened near him.
  // Each dimension is its own row: pick one option within a row, and rows
  // combine. A single dropdown made Direction overwrite Run type, so you could
  // never ask for "designed runs, up the middle".
  // Each chip has three states: off -> include -> exclude -> off.
  // Includes are exclusive within a dimension; excludes stack, so you can ask
  // for "under center, no play action, no screens".
  let facets = {};        // group label -> included option key
  let excl = new Set();   // excluded option keys, across dimensions

  let skeleton = null;     // rows/options fixed for the life of a role selection

  // The facet block can run to seven rows; collapsing it gives the results list
  // the vertical space back while still showing what is active.
  const COLLAPSE_KEY = "all22.filtersShut";
  let filtersShut = false;
  try { filtersShut = localStorage.getItem(COLLAPSE_KEY) === "1"; } catch {}

  function applyCollapse() {
    q("#a-facets").classList.toggle("shut", filtersShut);
    q("#a-facethead").classList.toggle("shut", filtersShut);
    paintSummary();
  }

  // Facet rows and ad-hoc column filters share one panel, and either can be the
  // only thing in it -- so visibility is decided from both, not from the facets.
  function syncPanelVisibility() {
    const rows = !!(skeleton && skeleton.length);
    const any = rows || extra.length > 0;
    q("#a-facets").classList.toggle("on", any);
    q("#a-facethead").classList.toggle("on", any);
    q("#a-facfoot").classList.toggle("on", any);
    // the legend explains the chips' minus buttons, which only facet rows have
    q("#a-facfoot .hint").style.display = rows ? "" : "none";
    const dirty = Object.keys(facets).length || excl.size || extra.length;
    q("#a-clear").style.visibility = dirty ? "visible" : "hidden";
    applyCollapse();
  }

  function paintSummary() {
    const el = q("#a-facethead") && q("#a-facethead").querySelector(".sum");
    if (!el) return;
    const label = k => {
      for (const g of skeleton || []) for (const o of g.options) if (o.key === k) return o.label;
      return k;
    };
    const inc = Object.values(facets).map(label);
    // a column filter narrows the set exactly like an included facet does
    extra.forEach(f => inc.push(colChipText(f)));
    const exc = [...excl].map(label);
    // name the two lists rather than leaving colour to carry the meaning
    const list = (name, items, cls) => !items.length ? "" :
      `<span class="grp"><span class="k">${name}</span>` +
      items.map(t => `<span class="${cls}">${esc(t)}</span>`).join("") + "</span>";
    el.innerHTML = (inc.length || exc.length)
      ? list("Include", inc, "v") + list("Exclude", exc, "x")
      : '<span class="none">none</span>';
  }

  function toggleCollapse() {
    filtersShut = !filtersShut;
    try { localStorage.setItem(COLLAPSE_KEY, filtersShut ? "1" : "0"); } catch {}
    applyCollapse();
  }

  // Redraw numbers and states without touching structure. Rebuilding innerHTML
  // on every click made chips jump under the cursor, which is intolerable when
  // excluding needs a second click on the same target.
  function paintFacets(groups) {
    const box = q("#a-facetrows");
    const byKey = {};
    (groups || []).forEach(g => g.options.forEach(o => { byKey[o.key] = o.n; }));
    box.querySelectorAll(".chip").forEach(chip => {
      const k = chip.dataset.k, g = chip.closest(".fac").dataset.g;
      const n = byKey[k] === undefined ? 0 : byKey[k];
      chip.querySelector(".inc").textContent = chip.dataset.label + " (" + n + ")";
      chip.classList.toggle("on", facets[g] === k);
      chip.classList.toggle("no", excl.has(k));
      chip.classList.toggle("zero", !n && facets[g] !== k && !excl.has(k));
    });
    box.querySelectorAll(".allbtn[data-g]").forEach(b => {
      const g = b.dataset.g;
      const anyExcl = (skeleton.find(x => x.group === g) || { options: [] })
        .options.some(o => excl.has(o.key));
      b.classList.toggle("on", !facets[g] && !anyExcl);
    });
    syncPanelVisibility();
  }

  function renderFacets(groups) {
    const box = q("#a-facetrows");
    skeleton = (groups || []).filter(g => g.useful);
    if (!skeleton.length) { box.innerHTML = ""; syncPanelVisibility(); return; }
    box.innerHTML = skeleton.map(g => `
      <div class="fac" data-g="${esc(g.group)}">
        <span class="lab">${esc(g.group)}</span>
        <button class="allbtn on" data-g="${esc(g.group)}">All</button>
        ${g.options.map(o => `<span class="chip" data-k="${o.key}" data-label="${esc(o.label)}">
            <button class="inc">${esc(o.label)} (${o.n})</button>
            <button class="exc">&minus;</button>
          </span>`).join("")}
      </div>`).join("");
    syncPanelVisibility();

    box.querySelectorAll(".allbtn[data-g]").forEach(b => b.onclick = () => {
      const g = b.dataset.g;
      delete facets[g];
      (skeleton.find(x => x.group === g) || { options: [] }).options
        .forEach(o => excl.delete(o.key));
      apply();
    });
    box.querySelectorAll(".chip").forEach(chip => {
      const g = chip.closest(".fac").dataset.g, k = chip.dataset.k;
      chip.querySelector(".inc").onclick = () => {
        if (facets[g] === k) delete facets[g]; else { facets[g] = k; excl.delete(k); }
        apply();
      };
      chip.querySelector(".exc").onclick = () => {
        if (excl.has(k)) excl.delete(k);
        else { excl.add(k); if (facets[g] === k) delete facets[g]; }
        apply();
      };
    });
    paintFacets(groups);
  }

  // one click -> search + refresh the numbers, structure untouched
  function apply() {
    run();
    refreshCounts();
  }

  function refreshCounts() {
    if (!picked || !skeleton) return;
    const role = q("#a-role").value || "any";
    const u = contextParams();
    u.set("player", picked.gsis_id);
    u.set("role", role);
    Object.values(facets).forEach(k => u.append("sub", k));
    excl.forEach(k => u.append("nsub", k));
    backend("/api/player_subfilters?" + u).then(d => paintFacets(d.groups)).catch(() => {});
  }

  function loadSubs() {
    if (!picked) { skeleton = null; facets = {}; excl = new Set(); renderFacets(null); return; }
    const role = q("#a-role").value || "any";
    // no facet selections here on purpose -- the row/option set must not depend
    // on them -- but the surrounding filters still apply
    const u0 = contextParams();
    u0.set("player", picked.gsis_id);
    u0.set("role", role);
    backend("/api/player_subfilters?" + u0)
      .then(d => renderFacets(d.groups))
      .catch(() => renderFacets(null));
  }

  function loadRoles() {
    const sel = q("#a-role");
    const wrap = q("#a-role-wrap");
    if (!picked) { wrap.classList.remove("on"); sel.innerHTML = ""; return; }
    wrap.classList.add("on");
    sel.innerHTML = '<option value="any">Loading roles…</option>';
    const ur = contextParams();
    ur.set("player", picked.gsis_id);
    ur.set("position", picked.position || "");
    backend("/api/player_roles?" + ur).then(d => {
      const list = d.roles || d;                     // tolerate the older shape
      sel.innerHTML = list.map(r =>
        `<option value="${r.key}">${esc(r.label)}${r.n ? " (" + r.n + ")" : ""}</option>`).join("");
      sel.value = d.default && list.some(r => r.key === d.default) ? d.default : "any";
      facets = {}; excl = new Set();
      loadSubs();
      run();                                          // land on the position's default view
    }).catch(() => { sel.innerHTML = '<option value="any">Any involvement</option>'; });
  }

  function playerLookup(term) {
    const menu = q("#a-pmenu");
    if (!term || term.length < 2) return closeMenu();
    backend("/api/players?q=" + encodeURIComponent(term)).then(list => {
      if (!list || !list.length) return closeMenu();
      menu.hidden = false;
      menu.innerHTML = list.map((p, i) => `
        <div data-i="${i}">
          <span class="who">${esc(p.name)}</span>
          <span class="meta2">${esc([p.position, p.team].filter(Boolean).join(" · "))}${
            p.plays ? " · " + p.plays + " plays" : ""}</span>
        </div>`).join("");
      menu.querySelectorAll("div").forEach(el => el.onclick = () => {
        picked = list[+el.dataset.i];
        closeMenu();
        showPicked();
        loadRoles();
        run();
      });
    }).catch(closeMenu);
  }

  /* The page always shares the screen: NFL Pro lays out in whatever width the
     panel leaves it. Wide is the one exception -- it takes everything but the
     tray strip, so there is no remainder worth reflowing into; the page keeps
     its own full-width layout underneath and the tray is the way back. */
  function applyPush() {
    const root = document.documentElement;
    root.classList.remove("a22push");
    root.style.removeProperty("--a22w");
    if (p.classList.contains("hid") || p.classList.contains("wide")) return;
    root.style.setProperty("--a22w", Math.round(p.getBoundingClientRect().width) + "px");
    root.classList.add("a22push");
  }
  window.addEventListener("resize", () => { applyPush(); relayoutSoon(); });

  tab.onclick = () => { p.classList.toggle("hid"); applyPush(); };
  q("#all22-x").onclick = () => { p.classList.add("hid"); applyPush(); };

  function setWide(on) {
    preservePlayback(() => {
      p.classList.toggle("wide", on);
      const b = q("#all22-w");
      // the click can land on the <svg> or its <path>, so never read e.target here
      b.innerHTML = svg(on ? ICON.narrow : ICON.wide);
      b.title = on ? "Narrow the panel" : "Widen the panel";
      b.setAttribute("aria-label", b.title);
      applyPush();
      relayoutSoon();
    });
  }
  /* ---------------- filter dictionary ----------------
     Every filterable option with nflverse's own definition and what the column
     really holds in this index. Definitions ship with the extension; the values
     are read from the index, so they describe the data you actually have.

     Profiles load only for the rows on screen. Profiling all 275 up front costs
     about four seconds of table scans, which is a long time to stare at a
     spinner for a reference you are going to scroll a screenful of. */
  const PROF = new Map();          // col -> profile, once fetched
  let dictObs = null, dictQueue = new Set(), dictTimer = null;

  function dictFlush() {
    clearTimeout(dictTimer);
    dictTimer = setTimeout(() => {
      const want = [...dictQueue].filter(c => !PROF.has(c)).slice(0, 40);
      dictQueue.clear();
      if (!want.length) return;
      backend("/api/values?cols=" + want.map(encodeURIComponent).join(",")).then(r => {
        Object.entries(r.profiles || {}).forEach(([k, v]) => PROF.set(k, v));
        want.forEach(paintDictRow);
      }).catch(() => {});
    }, 90);
  }

  function paintDictRow(col) {
    const row = [...p.querySelectorAll(".dent")].find(el => el.dataset.k === col);
    const d = PROF.get(col);
    if (!row || !d) return;
    const box = row.querySelector(".dval");
    box.innerHTML = profileHtml(d);
    wireValueClicks(box, col);
    if (!row.querySelector(".ddesc").textContent && d.desc)
      row.querySelector(".ddesc").textContent = d.desc;
    row.querySelector(".dkind").textContent =
      (d.kind === "yesno" ? "yes / no" : d.kind === "number" ? "number"
       : d.kind === "list" ? d.distinct + " values" : d.kind === "empty" ? "empty" : "text")
      + (GROUPS[col] ? ` · ${GROUPS[col].members.length} cols` : "");
  }

  function drawDict(term) {
    const list = q("#a-dlist");
    const t = (term || "").trim().toLowerCase();
    const hits = COLLIST.filter(c => !t || c.name.toLowerCase().includes(t)
      || c.key.toLowerCase().includes(t) || (DESCRIBE[c.key] || "").toLowerCase().includes(t));
    p.querySelector(".dcount").textContent =
      hits.length + (t ? " of " + COLLIST.length : "") + " options";
    if (!hits.length) { list.innerHTML = '<div class="dempty">Nothing matches.</div>'; return; }
    list.innerHTML = hits.map(c => `
      <div class="dent" data-k="${esc(c.key)}">
        <div class="dtop"><span class="dname">${esc(c.name)}</span>
          <span class="dkey">${esc(c.key)}</span>
          <span class="dkind">${BINARY.has(c.key) ? "yes / no"
            : c.type === "TEXT" ? "text" : "number"}${
            GROUPS[c.key] ? ` · ${GROUPS[c.key].members.length} cols` : ""}</span></div>
        <div class="ddesc">${esc(DESCRIBE[c.key] || "")}</div>
        <div class="dval"><span class="dn">…</span></div>
      </div>`).join("");

    // picking a row is the point of the dictionary: it arms the filter box
    list.querySelectorAll(".dent").forEach(el => el.onclick = () => {
      const k = el.dataset.k;
      colPick = k;
      q("#a-col").value = humanCol(k);
      showDict(false);
      syncOpUI(k);
      hint(k);
      q("#a-val").focus();
    });

    if (dictObs) dictObs.disconnect();
    dictObs = new IntersectionObserver(ents => {
      let any = false;
      ents.forEach(e => {
        if (!e.isIntersecting) return;
        const k = e.target.dataset.k;
        if (PROF.has(k)) return paintDictRow(k);
        dictQueue.add(k);
        any = true;
      });
      if (any) dictFlush();
    }, { root: list, rootMargin: "200px" });
    list.querySelectorAll(".dent").forEach(el => {
      dictObs.observe(el);
      if (PROF.has(el.dataset.k)) paintDictRow(el.dataset.k);
    });
  }

  function showDict(on) {
    q("#a-dict").hidden = !on;
    q("#a-body").hidden = on;
    if (on) {
      drawDict(q("#a-dsearch").value);
      q("#a-dsearch").focus();
    } else if (dictObs) {
      dictObs.disconnect();
    }
  }

  q("#all22-d").onclick = () => showDict(q("#a-dict").hidden);
  let dsTimer = null;
  q("#a-dsearch").addEventListener("input", e => {
    clearTimeout(dsTimer);
    const v = e.target.value;
    dsTimer = setTimeout(() => drawDict(v), 120);
  });

  q("#all22-w").onclick = () => setWide(!p.classList.contains("wide"));
  q("#all22-tray").onclick = () => setWide(false);

  backend("/api/meta").then(m => {
    // loading is done; replace whatever progress text was left on screen
    const st = q("#all22-st");
    st.dataset.loaded = "1";
    st.textContent =
      m.columns + " pbp columns are filterable — tacklers, fumbles, EPA, CPOE, personnel…";
    m.seasons.forEach(s => q("#a-season").insertAdjacentHTML("beforeend", `<option>${s}</option>`));
    m.weeks.forEach(w => q("#a-week").insertAdjacentHTML("beforeend", `<option>${w}</option>`));
    m.teams.forEach(t => q("#a-team").insertAdjacentHTML("beforeend", `<option>${t}</option>`));
    q("#a-season").value = m.seasons[m.seasons.length - 1];
  }).catch(e => { q("#all22-st").innerHTML = `<span style="color:#e0736b">${esc(e.message)}</span>`; });

  /* 0/1 event flags. There is nothing to type and only one sensible operator,
     so the value box and the op menu give way to a Yes / No picker. */
  let BINARY = new Set();
  let DESCRIBE = {};         // nflverse's own wording, shipped with the extension
  /* 0/1 flags the backend measured to be exactly "the merged column is set" --
     fumble_forced asks nothing that Forced fumble does not. Hidden rather than
     renamed: two names for one question is the confusion. */
  let REDUNDANT = new Set();
  let COLTYPE = {};
  let COLLIST = [];          // offered in the menu: merged columns, no raw slots
  let COLALL = [];           // everything, so a typed-out slot key still resolves
  backend("/api/columns").then(d => {
    (d.groups || []).forEach(g => {
      GROUPS[g.key] = g;
      g.members.forEach(m => {
        // the absorbed full-sack column carries no number; it falls through to
        // the generic rule rather than being labelled a slot it is not
        const n = (m.match(/(?:^|_)(\d+)(?:_|$)/) || [])[1];
        MEMBER[m] = { label: g.label, slot: n || null };
      });
    });
    BINARY = new Set(d.binary || []);
    REDUNDANT = new Set(d.redundant || []);
    DESCRIBE = d.describe || {};
    COLTYPE = Object.assign({}, d.columns);
    Object.values(GROUPS).forEach(g => { COLTYPE[g.key] = g.type; });
    COLALL = Object.keys(COLTYPE)
      .map(k => ({ key: k, name: humanCol(k), type: COLTYPE[k] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // the merged column stands in for its slots; listing both would put
    // "Forced fumble" next to two near-identical rows that search the same data
    COLLIST = COLALL.filter(x => !MEMBER[x.key] && !REDUNDANT.has(x.key));
  }).catch(() => {});

  // The native <datalist> always renders the raw option value next to the label,
  // so nflverse keys leaked through no matter how the label was written. This
  // menu shows only the readable name and keeps the real column out of sight.
  let colPick = null;        // the actual column key behind what is typed

  function colLookup(term) {
    const menu = q("#a-colmenu");
    const t = term.trim().toLowerCase();
    if (!t) { menu.hidden = true; return; }
    const hits = COLLIST.filter(c =>
      c.name.toLowerCase().includes(t) || c.key.toLowerCase().includes(t)).slice(0, 12);
    if (!hits.length) { menu.hidden = true; return; }
    menu.hidden = false;
    menu.innerHTML = hits.map((c, i) => `
      <div data-i="${i}">
        <span class="who">${esc(c.name)}</span>
        <span class="meta2">${BINARY.has(c.key) ? "yes / no"
          : c.type === "TEXT" ? "text" : "number"}</span>
      </div>`).join("");
    menu.querySelectorAll("div").forEach(el => el.onclick = () => {
      const c = hits[+el.dataset.i];
      colPick = c.key;
      q("#a-col").value = c.name;      // the human name is what stays on screen
      menu.hidden = true;
      syncOpUI(c.key);
      hint(c.key);
    });
  }

  // A binary column has no value to type and no operator worth choosing.
  function syncOpUI(col) {
    const bin = BINARY.has(col);
    q("#a-op").hidden = bin;
    q("#a-val").hidden = bin;
    q("#a-bool").hidden = !bin;
  }

  // typing free-text still works: resolve it back to a real column
  function resolveCol() {
    if (colPick) return colPick;
    const t = q("#a-col").value.trim().toLowerCase();
    if (!t) return null;
    const exact = COLALL.find(c => c.name.toLowerCase() === t || c.key.toLowerCase() === t);
    return exact ? exact.key : null;
  }

  const NUMOPS = ["gt", "gte", "lt", "lte"];

  const nfmt = n => (n == null ? "" : Number(n).toLocaleString());
  /* The hint sits under the filter row and wraps, so it gets the sentence that
     defines the column, not nflverse's caveats -- read_thrown's entry runs 425
     characters. The dictionary shows the whole thing. */
  function oneLine(t) {
    if (!t) return "";
    const cut = t.slice(0, 200);
    const stop = cut.search(/\.(\s|$)/);
    const first = stop > 30 ? cut.slice(0, stop + 1) : cut;
    return first.length < t.length ? first.replace(/\.$/, "") + "…" : first;
  }
  // 3 significant figures is enough to see the shape of a range
  const sig = v => {
    // a merged column's min/max can arrive as text; never assume a number
    const n = typeof v === "number" ? v : Number(v);
    if (v == null || !Number.isFinite(n)) return v == null ? "" : String(v);
    return Math.abs(n) >= 100 || Number.isInteger(n)
      ? Math.round(n).toLocaleString() : Number(n.toPrecision(3)).toString();
  };

  /* One column, rendered from its profile. The shape follows the data: a
     yes/no shows its split, a short enumeration shows every value, a number
     shows its range, free text shows a sample and how much else there is.
     Values carry data-v so they can be clicked into the filter box. */
  function profileHtml(d) {
    if (!d || d.kind === "empty") return '<span class="dn">no values in this index</span>';
    const val = x => `<b data-v="${esc(String(x.v))}">${esc(String(x.v))}</b>` +
                     `<span class="dn"> ${nfmt(x.n)}</span>`;
    if (d.kind === "yesno")
      return `<b data-v="1">Yes</b><span class="dn"> ${nfmt(d.yes)}</span> · ` +
             `<b data-v="0">No</b><span class="dn"> ${nfmt(d.no)}</span>`;
    if (d.kind === "number")
      return `<span class="dn">range</span> ${sig(d.min)} … ${sig(d.max)}` +
             `<span class="dn"> · avg</span> ${sig(d.avg)}` +
             `<span class="dn"> · ${nfmt(d.distinct)} values</span>`;
    const vs = (d.values || []).map(val).join("<span class=\"dn\"> · </span>");
    const more = d.kind === "text" && d.distinct > (d.values || []).length
      ? `<span class="dn"> · ${nfmt(d.distinct)} distinct in all</span>` : "";
    return vs + more;
  }

  // clicking a value in a hint or a dictionary row drops it into the filter
  function wireValueClicks(el, col) {
    el.querySelectorAll("b[data-v]").forEach(b => b.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      if (BINARY.has(col)) { q("#a-bool").value = b.dataset.v; return; }
      q("#a-val").value = b.dataset.v;
      q("#a-op").value = "eq";
    });
  }

  // show what a column actually contains, so you are not guessing
  async function hint(col) {
    const h = q("#a-hint");
    if (!col || !COLTYPE[col]) { h.textContent = ""; return; }
    const name = esc(humanCol(col));
    const desc = DESCRIBE[col] ? ` <span class="dn">— ${esc(oneLine(DESCRIBE[col]))}</span>` : "";
    h.innerHTML = `<span class="m">${name}${desc} · loading…</span>`;
    try {
      const d = await backend(`/api/values?col=${encodeURIComponent(col)}`);
      h.innerHTML = `<span class="m">${name}${
        d.desc ? ` <span class="dn">— ${esc(oneLine(d.desc))}</span>` : desc} · </span>` +
        `<span class="dval">${profileHtml(d)}</span>`;
      wireValueClicks(h, col);
    } catch {
      h.innerHTML = `<span class="m">${name}${desc}</span>`;
    }
  }
  let colTimer = null;
  q("#a-col").addEventListener("input", e => {
    colPick = null;
    clearTimeout(colTimer);
    const v = e.target.value;
    colTimer = setTimeout(() => colLookup(v), 120);
  });
  q("#a-col").addEventListener("blur", () => setTimeout(() => {
    q("#a-colmenu").hidden = true;
    const k = resolveCol();
    syncOpUI(k);
    if (k) hint(k);
  }, 180));

  function colChipText(f) {
    // "Play action: Yes" beats "Play action = 1" in the chip and in the
    // Filters strip, which is the same string
    if (BINARY.has(f.col)) return `${humanCol(f.col)}: ${f.val === "0" ? "No" : "Yes"}`;
    return `${humanCol(f.col)} ${OPSYM[f.op] || f.op} ${f.val || ""}`.trim();
  }

  // Column filters render as chips in the facet panel so every active filter
  // lives in one place. Both halves remove -- unlike a facet chip there is no
  // include/exclude split here.
  function drawChips() {
    const c = q("#a-colrow");
    c.innerHTML = !extra.length ? "" :
      `<span class="lab">Column</span>` + extra.map((f, i) =>
        `<span class="chip on" data-i="${i}">
           <button class="inc">${esc(colChipText(f))}</button>
           <button class="exc" title="Remove">&#10005;</button>
         </span>`).join("");
    c.querySelectorAll(".chip").forEach(chip =>
      chip.querySelectorAll("button").forEach(b => b.onclick = () => {
        extra.splice(+chip.dataset.i, 1); drawChips(); run();
      }));
    syncPanelVisibility();
  }
  q("#a-add").onclick = () => {
    const col = resolveCol();
    if (!col) {
      if (q("#a-col").value.trim())
        q("#a-hint").innerHTML = '<span style="color:#e0736b">Pick a column from the list</span>';
      return;
    }
    if (!COLTYPE[col]) {
      q("#a-hint").innerHTML = `<span style="color:#e0736b">No such column: ${esc(col)}</span>`;
      return;
    }
    const bin = BINARY.has(col);
    const op = bin ? "eq" : q("#a-op").value;
    // >, <, >=, <= against a text column silently matches nothing -- catch it here
    if (!bin && COLTYPE[col] === "TEXT" && NUMOPS.includes(op)) {
      q("#a-hint").innerHTML =
        `<span style="color:#e0a86b">${esc(humanCol(col))} is text, so “${esc(OPSYM[op] || op)}” matches 0 plays. Use = or contains.</span>`;
      hint(col);
      return;
    }
    extra.push({ col, op, val: bin ? q("#a-bool").value : q("#a-val").value.trim() });
    q("#a-col").value = ""; q("#a-val").value = ""; colPick = null;
    syncOpUI(null);
    q("#a-hint").textContent = "";
    drawChips(); run();
  };

  // current result set + selection, shared by clicks and the keyboard
  let lastRows = [], selIdx = -1;

  async function selectPlay(i) {
    const row = lastRows[i];
    if (!row) return;
    selIdx = i;
    const res = q("#all22-res");
    res.querySelectorAll(".row").forEach(x => x.classList.remove("on"));
    const el = res.querySelector(`.row[data-i="${i}"]`);
    if (el) { el.classList.add("on"); el.scrollIntoView({ block: "nearest" }); }
    q("#all22-st").textContent = "loading clip…";
    try {
      const pl = await clipFor(row);
      mount(pl);
      q("#all22-st").textContent =
        pl.map(x => x.videoView).join(" + ") + " · " + row.old_game_id + "/" + row.play_id;
    } catch (e) {
      q("#all22-st").innerHTML = `<span style="color:#e0a86b">${esc(e.message || String(e))}</span>`;
    }
  }

  // Everything except the player/role/facet selection. The facet counts need the
  // very same filters, or a chip claims a player's whole season while the list
  // below shows the four plays that actually match.
  function contextParams() {
    const u = new URLSearchParams();
    const push = (c, o, v) => u.append("f", v === undefined || v === "" ? `${c}:${o}` : `${c}:${o}:${v}`);
    if (q("#a-season").value) push("season", "eq", q("#a-season").value);
    if (q("#a-week").value) push("week", "eq", q("#a-week").value);
    if (q("#a-type").value) push("play_type", "eq", q("#a-type").value);
    if (q("#a-team").value) push("__team", "eq", q("#a-team").value);
    if (!picked) {
      const pl = q("#a-player").value.trim();
      if (pl) u.append("q", pl);          // free text against the description
    }
    const tx = q("#a-text").value.trim();
    if (tx) u.append("q", tx);
    extra.forEach(f => push(f.col, f.op, f.val));
    return u;
  }

  function run() {
    const u = contextParams();
    if (picked) {
      u.set("player", picked.gsis_id);
      const role = q("#a-role").value;
      if (role && role !== "any") u.set("role", role);   // scope the stat to HIM
      Object.values(facets).forEach(k => u.append("sub", k));
      excl.forEach(k => u.append("nsub", k));
    }
    u.set("order", q("#a-order").value);
    u.set("limit", "300");

    q("#all22-st").textContent = "searching…";
    q("#all22-res").innerHTML = "";
    backend(`/api/search?${u}`).then(rows => {
      if (rows.error) { q("#all22-st").innerHTML = `<span style="color:#e0736b">${esc(rows.error)}</span>`; return; }
      if (!rows.length) {
        const sus = extra.filter(f => COLTYPE[f.col] === "TEXT" && NUMOPS.includes(f.op));
        q("#all22-st").innerHTML = "0 plays" + (sus.length
          ? ` — <span style="color:#e0a86b">${esc(humanCol(sus[0].col))} is text; “${esc(OPSYM[sus[0].op] || sus[0].op)}” can’t match</span>`
          : " — try removing a filter");
      } else {
        q("#all22-st").textContent = rows.length + " plays";
      }
      q("#all22-res").innerHTML = rows.map((r, i) => `
        <div class="row" data-i="${i}">
          <div>${esc((r.desc || "").slice(0, 150))}</div>
          <div class="m">${r.away_team} @ ${r.home_team} · wk ${r.week} · Q${r.qtr} ${r.time || ""} ·
            ${r.down ? r.down + "&amp;" + r.ydstogo : "--"} ·
            <span class="${r.epa > 0 ? "pos" : "neg"}">EPA ${r.epa == null ? "--" : (+r.epa).toFixed(2)}</span> ·
            ${r.old_game_id}/${r.play_id}</div>
        </div>`).join("");
      lastRows = rows;
      selIdx = -1;
      q("#all22-res").querySelectorAll(".row").forEach(el =>
        el.onclick = () => selectPlay(+el.dataset.i));
    }).catch(e => { q("#all22-st").innerHTML = `<span style="color:#e0736b">${esc(String(e))}</span>`; });
  }
  applyPush();
  q("#a-player").addEventListener("input", e => {
    picked = null;
    clearTimeout(pTimer);
    const v = e.target.value.trim();
    pTimer = setTimeout(() => playerLookup(v), 180);
  });
  q("#a-player").addEventListener("blur", () => setTimeout(closeMenu, 180));
  q("#a-role").addEventListener("change", () => { facets = {}; excl = new Set(); loadSubs(); run(); });
  q("#a-facethead").onclick = toggleCollapse;
  // wired once: the footer is static markup now, and column filters can be the
  // only thing to clear (renderFacets never runs when there are no facet rows)
  q("#a-clear").onclick = () => {
    facets = {}; excl = new Set(); extra.length = 0;
    drawChips(); apply();
  };
  q("#a-go").onclick = () => { run(); refreshCounts(); };
  ["#a-season", "#a-week", "#a-team", "#a-type"].forEach(sel =>
    q(sel).addEventListener("change", () => { run(); refreshCounts(); }));
  p.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
})();
