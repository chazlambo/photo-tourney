/* Living Nature-Photo Ranking — standalone page (separate from app.js).
 *
 * Everyone ranks the same "charlie-nature-photos" set into ONE global, living Elo
 * held by a Cloudflare Worker + Durable Object (worker/elo-worker.js). Each pick is
 * sent immediately and fire-and-forget; the page NEVER shows Elo while ranking
 * (no bias). The leaderboard is a separate, deliberately terminal view.
 *
 * No app.js, no IndexedDB, no results/ commit — this page is fully independent.
 */

// ── config ──
const LIVE_SET = "charlie-nature-photos";
const REPO = "chazlambo/photo-tourney";
// Point this at the deployed Worker (see worker/README-elo.md). Trailing slash ok.
const ELO_WORKER_URL = "https://photo-tourney-elo.charlie-lambert.workers.dev/";
const PREFETCH = 3; // pairs buffered ahead so fast taps never stall

const API = ELO_WORKER_URL.replace(/\/+$/, "");
const PAGE_DIR = (location.origin + location.pathname).replace(/[^/]*$/, "");
const OUTBOX_KEY = "pt-live-outbox";
// Drop un-sent picks older than this so a long-stranded outbox can't replay a
// pickId the server has already aged out of its idempotency set (server TTL 6h).
const OUTBOX_MAX_AGE_MS = 5 * 60 * 60 * 1000;

// ── tiny helpers (mirrors of app.js) ──
const $ = (sel) => document.querySelector(sel);
function show(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(name);
  if (el) el.classList.add("active");
  window.scrollTo(0, 0);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function setImageUrl(fn) {
  return PAGE_DIR + "sets/" + encodeURIComponent(LIVE_SET) + "/" + encodeURIComponent(fn);
}
function uuid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : "x" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// stable per-device id + name (shared keys with the main app)
let deviceId = "";
try {
  deviceId = localStorage.getItem("pt-device") || "";
  if (!deviceId) { deviceId = uuid(); localStorage.setItem("pt-device", deviceId); }
} catch (e) { deviceId = uuid(); }
let participantName = "";
try { participantName = localStorage.getItem("pt-name") || ""; } catch (e) {}

// ── state ──
let names = [];        // sorted filenames; index == cidx (must match the DO's seed)
let fp = "";           // 16-hex fingerprint of `names`
let seedV = "";        // store version, echoed on each pick
let sid = "";          // this session's id
let buffer = [];       // queued {a, b} pairs from /pair
let topping = false;   // guard against concurrent topUp()
let picksThisSession = 0;
let busy = false;      // mid-animation lock
let starting = false;  // re-entrancy guard for startSession()

// ── elements ──
const gateMsg = $("#gate-msg");
const nameInput = $("#live-name");
const startBtn = $("#live-start-btn");
const cards = [...document.querySelectorAll(".half")];
const countEl = $("#live-count");
const statusEl = $("#live-status");
const kbHint = $("#kb-hint");
const stageEl = document.querySelector(".stage");

// ── canonical filename ordering — KEEP IN SYNC with app.js:626-629 ──
const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
async function fetchSetFilenames(set) {
  const api = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent("sets/" + set)}`;
  const res = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) throw new Error(`No set named "${set}" was found.`);
  if (res.status === 403) throw new Error("GitHub rate limit hit — please try again in a few minutes.");
  if (!res.ok) throw new Error("Couldn't load that set (network error).");
  const items = await res.json();
  return items
    .filter((i) => i.type === "file" && IMG_RE.test(i.name))
    .map((i) => i.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
async function computeFingerprint(list) {
  const data = new TextEncoder().encode(list.join("\n"));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// ── boot ──
async function boot() {
  if (nameInput) nameInput.value = participantName;
  syncStart();
  if (!API) {
    gateFatal("Ranking service not configured: set ELO_WORKER_URL in live.js (see worker/README-elo.md).");
    return;
  }
  try {
    names = await fetchSetFilenames(LIVE_SET);
    if (names.length < 2) throw new Error("This set needs at least 2 photos.");
    fp = await computeFingerprint(names);
    const meta = await fetchJSON(API + "/meta");
    if (meta.fp && meta.fp !== fp) {
      gateFatal("This set's photos changed since the ranking was set up. The owner needs to re-seed before ranking can continue.");
      return;
    }
    seedV = meta.v || "";
    gateMsg.textContent = meta.totalPicks
      ? `${meta.totalPicks.toLocaleString()} picks so far across everyone. Add yours →`
      : "Be the first to start shaping the ranking →";
  } catch (e) {
    gateFatal((e && e.message) || "Couldn't reach the ranking service. Please try again.");
    return;
  }
  // try to drain anything stranded in the outbox from a previous visit
  flushOutbox();
}
function gateFatal(msg) {
  gateMsg.textContent = msg;
  if (startBtn) startBtn.disabled = true;
  if (nameInput) nameInput.disabled = true;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  let body = {};
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error(body.error || ("HTTP " + res.status));
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

// ── gate ──
function syncStart() {
  if (startBtn) startBtn.disabled = !(nameInput && nameInput.value.trim()) || !names.length;
}
function captureName() {
  const v = (nameInput && nameInput.value || "").trim().slice(0, 40);
  if (v) { participantName = v; try { localStorage.setItem("pt-name", v); } catch (e) {} }
  return v;
}

async function startSession() {
  if (starting) return;
  if (!captureName()) return;
  starting = true;
  try {
    sid = uuid();
    buffer = [];
    picksThisSession = 0;
    setChangedShown = false;
    updateCount();
    updateStatus();
    show("match");
    await topUp();
    if (!buffer.length) {
      // transient blip (not the hard fingerprint gate) — let the user retry.
      show("gate");
      gateMsg.textContent = "Couldn't load matchups just now. Press Start to try again.";
      syncStart();
      return;
    }
    renderHead();
  } finally {
    starting = false;
  }
}

// ── pairing buffer ──
async function getPair() {
  const p = await fetchJSON(API + "/pair?sid=" + encodeURIComponent(sid));
  return { a: p.a, b: p.b };
}
async function topUp() {
  if (topping) return;
  topping = true;
  try {
    while (buffer.length < PREFETCH) {
      let pair;
      try { pair = await getPair(); } catch (e) { break; }
      buffer.push(pair);
      // preload its images so the next render is instant
      [pair.a, pair.b].forEach((c) => { const im = new Image(); im.src = setImageUrl(names[c]); });
    }
  } finally { topping = false; }
}

function renderHead() {
  const cur = buffer[0];
  if (!cur) {
    // Buffer drained — never leave `busy` stuck; keep retrying while on #match.
    busy = false;
    showSpinner();
    topUp().then(() => {
      if (buffer.length) renderHead();
      else if ($("#match").classList.contains("active")) setTimeout(renderHead, 1000);
    });
    return;
  }
  const imgA = cards[0].querySelector("img");
  const imgB = cards[1].querySelector("img");
  imgA.src = setImageUrl(names[cur.a]);
  imgB.src = setImageUrl(names[cur.b]);
  cards.forEach((c) => c.classList.remove("flash"));
  busy = false;
}
function showSpinner() {
  const imgA = cards[0].querySelector("img");
  const imgB = cards[1].querySelector("img");
  imgA.removeAttribute("src"); imgB.removeAttribute("src");
}

// ── a pick: optimistic advance + fire-and-forget vote ──
function pick(side) {
  if (busy) return;
  const cur = buffer.shift();
  if (!cur) { showSpinner(); topUp().then(renderHead); return; }
  busy = true;
  const winner = side === 0 ? cur.a : cur.b;
  const loser = side === 0 ? cur.b : cur.a;
  cards[side].classList.add("flash");
  picksThisSession++;
  updateCount();
  outboxPush({
    sid, winner, loser, pickId: uuid(), fp, v: seedV,
    device: deviceId, name: participantName,
  });
  flushOutbox();
  topUp();
  setTimeout(renderHead, 240);
}

// ── outbox (durable, fire-and-forget; survives reload) ──
function outboxRead() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch (e) { return []; }
}
function outboxWrite(arr) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(arr)); } catch (e) {}
}
function outboxPush(entry) {
  const arr = outboxRead();
  arr.push({ ...entry, ts: Date.now() });
  outboxWrite(arr);
  updateStatus();
}

let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    let arr = outboxRead();
    // drop entries too old to safely retry (past the server's idempotency window)
    const fresh = Date.now() - OUTBOX_MAX_AGE_MS;
    const trimmed = arr.filter((e) => (e.ts || 0) >= fresh);
    if (trimmed.length !== arr.length) { arr = trimmed; outboxWrite(arr); }
    while (arr.length) {
      const entry = arr[0];
      let res;
      try {
        res = await fetch(API + "/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      } catch (e) {
        break; // network down — keep the entry, retry later
      }
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // success OR terminal client error (incl. 409 set-changed, bad pick):
        // drop it — retrying won't help, and votes are global so nothing's "lost".
        arr.shift();
        outboxWrite(arr);
        if (res.status === 409) handleSetChanged();
      } else {
        break; // 5xx — server hiccup, retry later
      }
    }
  } finally {
    flushing = false;
    updateStatus();
  }
}
// best-effort final flush when the page goes away
function beaconFlush() {
  const fresh = Date.now() - OUTBOX_MAX_AGE_MS;
  const arr = outboxRead().filter((e) => (e.ts || 0) >= fresh);
  if (!arr.length || !navigator.sendBeacon) return;
  // beacon each remaining entry; the server is idempotent on pickId
  for (const entry of arr) {
    const blob = new Blob([JSON.stringify(entry)], { type: "text/plain" });
    navigator.sendBeacon(API + "/pick", blob);
  }
}

let setChangedShown = false;
function handleSetChanged() {
  if (setChangedShown) return;
  setChangedShown = true;
  statusEl.textContent = "⚠ photo set updated — reload";
}

// ── status + count ──
function updateCount() {
  countEl.textContent = picksThisSession === 1
    ? "1 pick this session"
    : picksThisSession + " picks this session";
}
function updateStatus() {
  if (setChangedShown) return;
  const q = outboxRead().length;
  statusEl.textContent = q ? "saving… (" + q + ")" : "";
}

// ── leaderboard (terminal) ──
async function showBoard(skipConfirm) {
  if (!skipConfirm && picksThisSession > 0) {
    const ok = window.confirm(
      "Seeing the rankings will bias your future picks, so this ends your ranking session.\n\nView the rankings now?");
    if (!ok) return;
  }
  flushOutbox();
  show("board");
  $("#board-ranking").innerHTML = "";
  $("#board-sub").textContent = "Loading…";
  $("#board-meta").textContent = "";
  let data;
  try { data = await fetchJSON(API + "/leaderboard"); }
  catch (e) { $("#board-sub").textContent = "Couldn't load the rankings — tap Refresh."; return; }
  renderBoard(data);
}
function renderBoard(data) {
  $("#board-sub").textContent =
    `${(data.totalPicks || 0).toLocaleString()} picks from everyone${picksThisSession ? ` · ${picksThisSession} from you this session` : ""}.`;
  const contrib = (data.contributors || []);
  $("#board-meta").textContent = contrib.length
    ? "Contributors: " + contrib.map((c) => `${c.name} (${c.n})`).join(" · ")
    : "";
  const grid = $("#board-ranking");
  grid.innerHTML = "";
  (data.rows || []).forEach((row, i) => {
    const item = document.createElement("div");
    item.className = "rank-item" + (i === 0 ? " winner" : "");
    item.innerHTML =
      `<span class="rank-badge">${i === 0 ? "🏆 #1" : "#" + (i + 1)}</span>
       <img src="${setImageUrl(row.name)}" alt="${escapeHtml(row.name)}" loading="lazy" />
       <span class="rank-record" title="Elo rating · win–loss">${row.elo} · ${row.w}–${row.l}</span>`;
    grid.appendChild(item);
  });
}

// ── fullscreen (mirrors app.js) ──
const canFullscreen = !!(stageEl && (stageEl.requestFullscreen || stageEl.webkitRequestFullscreen));
const fsBtn = $("#live-fs-btn");
if (!canFullscreen && fsBtn) fsBtn.style.display = "none";
function toggleFullscreen() {
  if (!canFullscreen) return;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (!active) (stageEl.requestFullscreen || stageEl.webkitRequestFullscreen).call(stageEl);
  else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
}
function syncFsBtn() {
  if (!fsBtn) return;
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  fsBtn.textContent = on ? "⤢ Exit" : "⛶ Fullscreen";
}

// ── wiring ──
if (nameInput) {
  nameInput.addEventListener("input", syncStart);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !startBtn.disabled) startSession(); });
}
startBtn.addEventListener("click", startSession);
$("#gate-board-btn").addEventListener("click", () => showBoard(true));
cards.forEach((c) => c.addEventListener("click", () => pick(Number(c.dataset.side))));
$("#live-board-btn").addEventListener("click", () => showBoard(false));
if (fsBtn) fsBtn.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", syncFsBtn);
document.addEventListener("webkitfullscreenchange", syncFsBtn);
$("#board-again-btn").addEventListener("click", () => { setChangedShown = false; show("gate"); boot(); });
$("#board-refresh-btn").addEventListener("click", () => showBoard(true));

document.addEventListener("keydown", (e) => {
  if (!$("#match").classList.contains("active")) return;
  if (e.key === "1" || e.key === "ArrowLeft") { e.preventDefault(); pick(0); }
  else if (e.key === "2" || e.key === "ArrowRight") { e.preventDefault(); pick(1); }
  else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
});

window.addEventListener("online", () => {
  flushOutbox();
  // recover a match stalled by an earlier failed prefetch
  if ($("#match").classList.contains("active") && !buffer.length) renderHead();
});
window.addEventListener("pagehide", beaconFlush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") beaconFlush(); });

// desktop keyboard hint (mirrors app.js spirit)
if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
  kbHint.textContent = "1 / ← · 2 / → · F fullscreen";
}

boot();
