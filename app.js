/* Photo Tournament — pairwise photo ranking (Elo), with two modes:
 *
 *   • Local mode (default URL): upload your own photos, ranked privately in your
 *     browser. Photos + progress persist in IndexedDB; nothing is uploaded.
 *
 *   • Shared-set mode (?set=NAME): rank a set the owner curated in the public
 *     repo (folder `sets/NAME/`). Filenames are discovered at runtime via the
 *     GitHub contents API; the images load straight from the Pages site. When
 *     you finish you get a "result code/link" to send back to the owner, who
 *     collects everyone's results in a Combine view (?set=NAME&results) showing
 *     each person's ranking plus a combined ranking (Borda count).
 *
 * Ranking model: adaptive Elo with Swiss-style pairing (closest ratings that
 * haven't met yet). Continuous ratings ⇒ near tie-free order; stop anytime.
 */

// ── config ──
const MAX_PHOTOS = 256;
const START_RATING = 1000;
const K = 32;
const REPO = "chazlambo/photo-tourney";
const OWNER_EMAIL = "charlie.lambert@gmail.com";

const PAGE_URL = location.origin + location.pathname;        // for clean links
const PAGE_DIR = PAGE_URL.replace(/[^/]*$/, "");             // directory of the page

// ── state ──
let photos = [];          // {id,cidx,name,blob,url, rating,games,wins,losses,byes, opponents:Set}
let queue = [];
let currentMatch = null;
let history = [];
let roundNumber = 0;
let matchesPlayed = 0;
let targetRounds = 5;
let estTotalPicks = 1;
let nextId = 1;
let started = false;
let currentScreen = "upload";
let mode = "local";       // 'local' | 'set'
let currentSet = null;

// ── elements ──
const $ = (sel) => document.querySelector(sel);
const screens = {
  upload: $("#upload"),
  "set-intro": $("#set-intro"),
  match: $("#match"),
  results: $("#results"),
  sets: $("#sets"),
  combine: $("#combine"),
};
const fileInput = $("#file-input");
const dropzone = $("#dropzone");
const thumbs = $("#thumbs");
const setupBox = $("#setup");
const chips = $("#chips");
const chipsSet = $("#chips-set");
const estimateEl = $("#estimate");
const estimateSetEl = $("#estimate-set");
const startBtn = $("#start-btn");
const clearBtn = $("#clear-btn");
const uploadHint = $("#upload-hint");
const cards = [...document.querySelectorAll(".half")];
const undoBtn = $("#undo-btn");
const finishBtn = $("#finish-btn");
const fsBtn = $("#fs-btn");
const resetBtn = $("#reset-btn");
const stageEl = document.querySelector(".stage");
const roundInfo = $("#round-info");
const progressFill = $("#progress-fill");
const setResultActions = $("#set-result-actions");
const newBtn = $("#new-btn");
const shareBox = $("#share-box");
const shareLinkEl = $("#share-link");
const combineTabs = $("#combine-tabs");
const combineRanking = $("#combine-ranking");
const importMsg = $("#import-msg");

function show(name) {
  currentScreen = name;
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  window.scrollTo(0, 0);
}

function sessionKey() {
  return mode === "set" && currentSet ? "set:" + currentSet : "current";
}

function prettify(name) {
  return String(name).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

// ── persistence (IndexedDB) ──
const DB_NAME = "photo-tournament";
let db = null;
let persistenceReady = false;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
      if (!d.objectStoreNames.contains("session")) d.createObjectStore("session", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function ostore(name, mode) {
  return db.transaction(name, mode).objectStore(name);
}
function putBlob(id, name, blob) {
  if (!persistenceReady) return;
  try { ostore("blobs", "readwrite").put({ id, name, blob }); } catch (e) {}
}
function deleteBlob(id) {
  if (!persistenceReady) return;
  try { ostore("blobs", "readwrite").delete(id); } catch (e) {}
}
function clearBlobs() {
  if (!persistenceReady) return;
  try { ostore("blobs", "readwrite").clear(); } catch (e) {}
}

function saveState() {
  if (!persistenceReady) return;
  try {
    ostore("session", "readwrite").put({
      key: sessionKey(),
      mode,
      set: currentSet,
      screen: currentScreen,
      started,
      nextId,
      targetRounds,
      roundNumber,
      matchesPlayed,
      photos: photos.map((p) => ({
        id: p.id, cidx: p.cidx, name: p.name,
        url: p.blob ? undefined : p.url,
        rating: p.rating, games: p.games, wins: p.wins, losses: p.losses, byes: p.byes,
        opponents: [...p.opponents],
      })),
      queue: queue.map((m) => [m[0].id, m[1].id]),
      current: currentMatch ? [currentMatch[0].id, currentMatch[1].id] : null,
    });
  } catch (e) {}
}

async function restoreSession(key) {
  if (!persistenceReady) return false;
  const blobRecords = await idbReq(ostore("blobs", "readonly").getAll());
  const blobById = new Map(blobRecords.map((b) => [b.id, b.blob]));
  const rec = await idbReq(ostore("session", "readonly").get(key));
  if (!rec || !rec.photos || rec.photos.length === 0) return false;

  photos = rec.photos
    .map((p) => {
      let blob = null;
      let url;
      if (blobById.has(p.id)) {
        blob = blobById.get(p.id);
        url = URL.createObjectURL(blob);
      } else if (p.url) {
        url = p.url;
      } else {
        return null;
      }
      return {
        id: p.id, cidx: p.cidx, name: p.name, blob, url,
        rating: p.rating, games: p.games, wins: p.wins,
        losses: p.losses, byes: p.byes, opponents: new Set(p.opponents || []),
      };
    })
    .filter(Boolean);
  if (photos.length === 0) return false;

  mode = rec.mode || "local";
  currentSet = rec.set || null;
  nextId = rec.nextId || photos.length + 1;
  targetRounds = rec.targetRounds || 5;
  roundNumber = rec.roundNumber || 0;
  matchesPlayed = rec.matchesPlayed || 0;
  started = !!rec.started;
  history = [];

  const byId = new Map(photos.map((p) => [p.id, p]));
  queue = (rec.queue || [])
    .map((m) => [byId.get(m[0]), byId.get(m[1])])
    .filter((m) => m[0] && m[1]);
  currentMatch =
    rec.current && byId.get(rec.current[0]) && byId.get(rec.current[1])
      ? [byId.get(rec.current[0]), byId.get(rec.current[1])]
      : null;

  syncChips();
  if (mode === "local") renderThumbs();

  if (rec.screen === "results") finish();
  else if (rec.screen === "match") {
    show("match");
    if (currentMatch) renderMatch();
    else advance();
  } else if (rec.screen === "set-intro") showSetIntro();
  else show(mode === "set" ? "set-intro" : "upload");
  return true;
}

// ── thoroughness ──
function syncChips() {
  [chips, chipsSet].forEach((group) => {
    if (!group) return;
    [...group.children].forEach((c) =>
      c.classList.toggle("active", Number(c.dataset.rounds) === targetRounds)
    );
  });
}
function setTargetRounds(r) {
  targetRounds = r;
  syncChips();
  updateEstimate();
  saveState();
}
function updateEstimate() {
  const n = photos.length;
  const txt = n < 2 ? "" :
    `≈ ${targetRounds * Math.floor(n / 2)} picks (about ${targetRounds} per photo). You can stop early anytime.`;
  estTotalPicks = n < 2 ? 1 : targetRounds * Math.floor(n / 2);
  if (estimateEl) estimateEl.textContent = txt;
  if (estimateSetEl) estimateSetEl.textContent = txt;
}

// ── uploads (local mode) ──
function addFiles(fileList) {
  let skipped = 0;
  for (const file of fileList) {
    if (!file.type.startsWith("image/")) continue;
    if (photos.length >= MAX_PHOTOS) { skipped++; continue; }
    const id = nextId++;
    photos.push({
      id, cidx: null, name: file.name, blob: file, url: URL.createObjectURL(file),
      rating: START_RATING, games: 0, wins: 0, losses: 0, byes: 0, opponents: new Set(),
    });
    putBlob(id, file.name, file);
  }
  renderThumbs(skipped);
  saveState();
}

function renderThumbs(skipped = 0) {
  thumbs.innerHTML = "";
  for (const p of photos) {
    const div = document.createElement("div");
    div.className = "thumb";
    div.innerHTML = `<img src="${p.url}" alt="${escapeHtml(p.name)}" />
      <button class="remove" title="Remove" data-id="${p.id}">×</button>`;
    thumbs.appendChild(div);
  }
  const n = photos.length;
  startBtn.disabled = n < 2;
  clearBtn.hidden = n === 0;
  setupBox.hidden = n < 2;
  if (skipped > 0) uploadHint.textContent = `Reached the ${MAX_PHOTOS}-photo limit — ${skipped} not added.`;
  else if (n < 2) uploadHint.textContent = "Add at least 2 photos to begin.";
  else uploadHint.textContent = `${n} photos ready.`;
  updateEstimate();
}

function removePhoto(id) {
  const p = photos.find((x) => x.id === id);
  if (p) URL.revokeObjectURL(p.url);
  photos = photos.filter((x) => x.id !== id);
  deleteBlob(id);
  renderThumbs();
  saveState();
}

function clearAll() {
  photos.forEach((p) => p.blob && URL.revokeObjectURL(p.url));
  photos = [];
  started = false;
  queue = [];
  currentMatch = null;
  history = [];
  clearBlobs();
  renderThumbs();
  saveState();
}

// ── ranking engine ──
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
}
function applyResult(winner, loser) {
  const ew = expected(winner, loser);
  winner.rating += K * (1 - ew);
  loser.rating += K * (0 - (1 - ew));
  winner.wins++; loser.losses++;
  winner.games++; loser.games++;
  winner.opponents.add(loser.id);
  loser.opponents.add(winner.id);
}
function buildRound() {
  queue = [];
  let pool = [...photos];
  if (pool.length % 2 === 1) {
    pool.sort((a, b) => b.games - a.games || Math.random() - 0.5);
    pool.shift().byes++;
  }
  pool = roundNumber === 0 ? shuffle(pool) : pool.sort((a, b) => b.rating - a.rating || Math.random() - 0.5);
  const used = new Set();
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (used.has(a.id)) continue;
    let partner = null, fallback = null;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (used.has(b.id)) continue;
      if (fallback === null) fallback = b;
      if (!a.opponents.has(b.id)) { partner = b; break; }
    }
    const b = partner || fallback;
    if (b) { used.add(a.id); used.add(b.id); queue.push([a, b]); }
  }
  queue = shuffle(queue);
  roundNumber++;
}

function startRanking() {
  roundNumber = 0;
  matchesPlayed = 0;
  history = [];
  started = true;
  photos.forEach((p) => {
    p.rating = START_RATING; p.games = 0; p.wins = 0; p.losses = 0; p.byes = 0; p.opponents = new Set();
  });
  updateEstimate();
  show("match");
  advance();
}

function advance() {
  if (queue.length === 0) {
    if (roundNumber >= targetRounds || photos.length < 2) { finish(); return; }
    buildRound();
    if (queue.length === 0) { finish(); return; }
  }
  currentMatch = queue.shift();
  renderMatch();
}

function renderMatch() {
  const [a, b] = currentMatch;
  cards[0].querySelector("img").src = a.url;
  cards[1].querySelector("img").src = b.url;
  cards.forEach((c) => c.classList.remove("flash"));
  roundInfo.textContent = `Round ${roundNumber}/${targetRounds} · pick ${matchesPlayed + 1} of ~${estTotalPicks}`;
  progressFill.style.width = Math.min(99, (matchesPlayed / estTotalPicks) * 100) + "%";
  undoBtn.disabled = history.length === 0;
  saveState();
}

function pick(side) {
  if (!currentMatch) return;
  history.push(snapshot());
  const winner = currentMatch[side];
  const loser = currentMatch[side === 0 ? 1 : 0];
  applyResult(winner, loser);
  matchesPlayed++;
  cards[side].classList.add("flash");
  currentMatch = null;
  setTimeout(advance, 130);
}

function rankedPhotos() {
  return [...photos].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses);
}

function finish() {
  const ranked = rankedPhotos();
  renderResults(ranked);
  const isSet = mode === "set";
  setResultActions.hidden = !isSet;
  newBtn.hidden = isSet;
  shareBox.hidden = true;
  show("results");
  saveState();
}

function renderResults(ranked) {
  $("#results-sub").textContent =
    `Based on ${matchesPlayed} pick${matchesPlayed === 1 ? "" : "s"} across ${roundNumber} round${roundNumber === 1 ? "" : "s"}.`;
  const wrap = $("#ranking");
  wrap.innerHTML = "";
  ranked.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "rank-item" + (i === 0 ? " winner" : "");
    item.innerHTML = `<span class="rank-badge">${i === 0 ? "🏆 #1" : "#" + (i + 1)}</span>
      <img src="${p.url}" alt="${escapeHtml(p.name)}" />
      <span class="rank-record">${p.wins}–${p.losses}</span>`;
    wrap.appendChild(item);
  });
}

function resetToStart() {
  if (started && !confirm("Start over? Your photos stay loaded, but the current picks will be cleared.")) return;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  started = false; queue = []; currentMatch = null; history = [];
  roundNumber = 0; matchesPlayed = 0;
  photos.forEach((p) => {
    p.rating = START_RATING; p.games = 0; p.wins = 0; p.losses = 0; p.byes = 0; p.opponents = new Set();
  });
  if (mode === "set") showSetIntro();
  else { show("upload"); renderThumbs(); }
  saveState();
}

function refine() {
  targetRounds += 3;
  updateEstimate();
  show("match");
  advance();
}

// ── undo ──
function snapshot() {
  return {
    state: photos.map((p) => ({
      id: p.id, rating: p.rating, games: p.games, wins: p.wins,
      losses: p.losses, byes: p.byes, opponents: [...p.opponents],
    })),
    queue: queue.map((m) => [m[0].id, m[1].id]),
    current: currentMatch ? [currentMatch[0].id, currentMatch[1].id] : null,
    roundNumber, matchesPlayed,
  };
}
function undo() {
  const snap = history.pop();
  if (!snap) return;
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const s of snap.state) {
    const p = byId.get(s.id);
    p.rating = s.rating; p.games = s.games; p.wins = s.wins;
    p.losses = s.losses; p.byes = s.byes; p.opponents = new Set(s.opponents);
  }
  queue = snap.queue.map((m) => [byId.get(m[0]), byId.get(m[1])]);
  currentMatch = snap.current ? [byId.get(snap.current[0]), byId.get(snap.current[1])] : null;
  roundNumber = snap.roundNumber;
  matchesPlayed = snap.matchesPlayed;
  show("match");
  if (currentMatch) renderMatch();
  else advance();
}

// ── fullscreen ──
const canFullscreen = !!(stageEl.requestFullscreen || stageEl.webkitRequestFullscreen);
if (!canFullscreen) fsBtn.style.display = "none";
function toggleFullscreen() {
  if (!canFullscreen) return;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (!active) (stageEl.requestFullscreen || stageEl.webkitRequestFullscreen).call(stageEl);
  else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
}
function syncFsBtn() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  fsBtn.textContent = on ? "⤢ Exit" : "⛶ Fullscreen";
}

// ── shared sets (GitHub-backed) ──
async function fetchSetFilenames(set) {
  const api = `https://api.github.com/repos/${REPO}/contents/${encodeURIComponent("sets/" + set)}`;
  const res = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) throw new Error(`No set named "${set}" was found.`);
  if (res.status === 403) throw new Error("GitHub rate limit hit — please try again in a few minutes.");
  if (!res.ok) throw new Error("Couldn't load that set (network error).");
  const items = await res.json();
  return items
    .filter((i) => i.type === "file" && /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i.test(i.name))
    .map((i) => i.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function listSets() {
  const api = `https://api.github.com/repos/${REPO}/contents/sets`;
  const res = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return [];
  if (res.status === 403) throw new Error("GitHub rate limit hit — please try again in a few minutes.");
  if (!res.ok) throw new Error("Couldn't load the set list.");
  const items = await res.json();
  return items.filter((i) => i.type === "dir").map((i) => i.name).sort((a, b) => a.localeCompare(b));
}

function setImageUrl(set, fn) {
  return PAGE_DIR + "sets/" + encodeURIComponent(set) + "/" + encodeURIComponent(fn);
}

function loadSetAsPhotos(set, filenames) {
  photos = filenames.map((fn, idx) => ({
    id: "s" + idx, cidx: idx, name: fn, blob: null, url: setImageUrl(set, fn),
    rating: START_RATING, games: 0, wins: 0, losses: 0, byes: 0, opponents: new Set(),
  }));
  nextId = filenames.length;
}

function showSetIntro() {
  $("#set-title").textContent = prettify(currentSet);
  $("#set-meta").textContent = `${photos.length} photos in this set.`;
  updateEstimate();
  syncChips();
  show("set-intro");
  saveState();
}

async function startSetFlow(set) {
  mode = "set";
  currentSet = set;
  $("#set-title").textContent = prettify(set);
  $("#set-meta").textContent = "Loading set…";
  show("set-intro");
  try {
    const filenames = await fetchSetFilenames(set);
    if (filenames.length < 2) {
      $("#set-meta").textContent = "This set needs at least 2 images.";
      return;
    }
    loadSetAsPhotos(set, filenames);
    showSetIntro();
  } catch (e) {
    $("#set-meta").textContent = e.message || "Couldn't load this set.";
  }
}

// ── result encoding ──
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(s)));
}
function buildPayload(name) {
  const order = rankedPhotos().map((p) => p.cidx);
  return b64urlEncode(JSON.stringify({ v: 1, s: currentSet, n: name || "Anonymous", c: photos.length, o: order }));
}
function shareLinkForSet(set) {
  return PAGE_URL + "?set=" + encodeURIComponent(set);
}
function resultLink(payload) {
  return PAGE_URL + "?import=" + payload;
}
function extractPayload(input) {
  const s = input.trim();
  const m = s.match(/[?&]import=([^&\s]+)/);
  return m ? m[1] : s;
}

// ── combine storage ──
function combineKey(set) { return "pt-combine:" + set; }
function loadResults(set) {
  try { return JSON.parse(localStorage.getItem(combineKey(set))) || []; } catch (e) { return []; }
}
function saveResults(set, arr) {
  try { localStorage.setItem(combineKey(set), JSON.stringify(arr)); } catch (e) {}
}
function addResultPayload(payload) {
  const data = JSON.parse(b64urlDecode(payload));
  if (!data || !data.s || !Array.isArray(data.o)) throw new Error("invalid");
  const arr = loadResults(data.s);
  const entry = { n: data.n || "Anonymous", o: data.o, c: data.c || data.o.length };
  const i = arr.findIndex((x) => x.n.toLowerCase() === entry.n.toLowerCase());
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  saveResults(data.s, arr);
  return data.s;
}

function computeCombined(results, N) {
  const score = new Array(N).fill(0);
  for (const r of results) {
    r.o.forEach((cidx, pos) => {
      if (cidx < N) score[cidx] += (N - 1 - pos);
    });
  }
  return [...Array(N).keys()].sort((a, b) => score[b] - score[a]);
}

function renderRankingGrid(container, orderOfCidx) {
  container.innerHTML = "";
  orderOfCidx.forEach((cidx, i) => {
    const p = photos[cidx];
    if (!p) return;
    const item = document.createElement("div");
    item.className = "rank-item" + (i === 0 ? " winner" : "");
    item.innerHTML = `<span class="rank-badge">${i === 0 ? "🏆 #1" : "#" + (i + 1)}</span>
      <img src="${p.url}" alt="${escapeHtml(p.name)}" />`;
    container.appendChild(item);
  });
}

let combineResultsCache = [];
function renderCombine(activeIdx) {
  const results = combineResultsCache;
  combineTabs.innerHTML = "";
  const labels = ["Combined", ...results.map((r) => r.n)];
  labels.forEach((label, i) => {
    const tab = document.createElement("button");
    tab.className = "tab" + (i === activeIdx ? " active" : "");
    tab.textContent = label;
    tab.addEventListener("click", () => renderCombine(i));
    combineTabs.appendChild(tab);
  });
  const N = photos.length;
  const order = activeIdx === 0
    ? computeCombined(results, N)
    : (results[activeIdx - 1].o || []).filter((c) => c < N);
  renderRankingGrid(combineRanking, order);
}

async function showCombine(set) {
  mode = "set";
  currentSet = set;
  $("#combine-title").textContent = prettify(set);
  $("#combine-meta").textContent = "Loading set…";
  combineTabs.innerHTML = "";
  combineRanking.innerHTML = "";
  importMsg.textContent = "";
  show("combine");
  try {
    const filenames = await fetchSetFilenames(set);
    loadSetAsPhotos(set, filenames);
  } catch (e) {
    $("#combine-meta").textContent = e.message || "Couldn't load this set's images.";
    return;
  }
  combineResultsCache = loadResults(set);
  const n = combineResultsCache.length;
  $("#combine-meta").textContent = n === 0
    ? "No results yet — paste a friend's result below, or rank it yourself."
    : `${n} ranking${n === 1 ? "" : "s"} submitted. Showing the combined order; tap a name to see theirs.`;
  renderCombine(0);
}

// ── browse sets ──
async function showBrowse() {
  show("sets");
  const list = $("#sets-list");
  list.innerHTML = `<p class="hint">Loading…</p>`;
  let sets;
  try { sets = await listSets(); }
  catch (e) { list.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; return; }
  if (sets.length === 0) {
    list.innerHTML = `<p class="hint">No sets yet. Paste a folder of images into <code>sets/</code> in the repo, then push.</p>`;
    return;
  }
  list.innerHTML = "";
  for (const name of sets) {
    const row = document.createElement("div");
    row.className = "set-row";
    row.innerHTML = `<span class="set-name">${escapeHtml(prettify(name))}</span>`;
    const rank = document.createElement("button");
    rank.className = "btn primary small";
    rank.textContent = "Rank";
    rank.addEventListener("click", () => {
      history.pushState({}, "", shareLinkForSet(name));
      startSetFlow(name);
    });
    const copy = document.createElement("button");
    copy.className = "btn ghost small";
    copy.textContent = "Copy link";
    copy.addEventListener("click", () => copyText(shareLinkForSet(name), copy));
    const res = document.createElement("button");
    res.className = "btn ghost small";
    res.textContent = "Results";
    res.addEventListener("click", () => showCombine(name));
    row.append(rank, copy, res);
    list.appendChild(row);
  }
}

// ── clipboard ──
async function copyText(text, btn) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else throw new Error("no clipboard");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e2) {}
    document.body.removeChild(ta);
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = old), 1400);
  }
}

function goHome() {
  mode = "local";
  currentSet = null;
  history.replaceState({}, "", PAGE_URL);
  restoreSession("current").then((restored) => {
    if (!restored) { photos = []; show("upload"); }
    renderThumbs();
  });
}

// ── utils ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ── events: local upload ──
fileInput.addEventListener("change", (e) => { addFiles(e.target.files); fileInput.value = ""; });
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
thumbs.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove");
  if (btn) removePhoto(Number(btn.dataset.id));
});

// ── events: thoroughness chips (both groups) ──
[chips, chipsSet].forEach((group) => {
  if (!group) return;
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) setTargetRounds(Number(chip.dataset.rounds));
  });
});

// ── events: ranking controls ──
startBtn.addEventListener("click", startRanking);
clearBtn.addEventListener("click", clearAll);
undoBtn.addEventListener("click", undo);
finishBtn.addEventListener("click", finish);
fsBtn.addEventListener("click", toggleFullscreen);
resetBtn.addEventListener("click", resetToStart);
document.addEventListener("fullscreenchange", syncFsBtn);
document.addEventListener("webkitfullscreenchange", syncFsBtn);
cards.forEach((card, i) => card.addEventListener("click", () => pick(i)));

// ── events: results ──
$("#refine-btn").addEventListener("click", refine);
$("#rematch-btn").addEventListener("click", startRanking);
newBtn.addEventListener("click", () => { clearAll(); goHome(); });

// ── events: set intro ──
$("#set-start-btn").addEventListener("click", startRanking);
$("#set-results-btn").addEventListener("click", () => showCombine(currentSet));
$("#set-copylink-btn").addEventListener("click", (e) => copyText(shareLinkForSet(currentSet), e.target));

// ── events: sharing a result ──
$("#share-result-btn").addEventListener("click", () => {
  const name = (prompt("Your name (so the owner knows whose ranking this is):", "") || "").trim();
  if (name === null) return;
  const payload = buildPayload(name || "Anonymous");
  shareLinkEl.value = resultLink(payload);
  shareBox.hidden = false;
  shareBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
$("#copy-link-btn").addEventListener("click", (e) => copyText(shareLinkEl.value, e.target));
$("#copy-code-btn").addEventListener("click", (e) => copyText(extractPayload(shareLinkEl.value), e.target));
$("#email-link-btn").addEventListener("click", () => {
  const subject = encodeURIComponent(`My ranking for "${prettify(currentSet)}"`);
  const body = encodeURIComponent(`Here's my ranking — open this link to add it:\n\n${shareLinkEl.value}`);
  location.href = `mailto:${OWNER_EMAIL}?subject=${subject}&body=${body}`;
});
$("#add-mine-btn").addEventListener("click", () => {
  const name = (prompt("Save your ranking under what name?", "Me") || "").trim();
  if (!name) return;
  addResultPayload(buildPayload(name));
  showCombine(currentSet);
});
$("#view-combined-btn").addEventListener("click", () => showCombine(currentSet));

// ── events: combine ──
$("#import-btn").addEventListener("click", () => {
  const raw = $("#import-box").value;
  if (!raw.trim()) return;
  try {
    const set = addResultPayload(extractPayload(raw));
    $("#import-box").value = "";
    importMsg.textContent = "Added ✓";
    if (set === currentSet) { combineResultsCache = loadResults(set); renderCombine(0); }
    else showCombine(set);
  } catch (e) {
    importMsg.textContent = "That didn't look like a valid result code or link.";
  }
});
$("#combine-rank-btn").addEventListener("click", () => startSetFlow(currentSet));
$("#combine-copylink-btn").addEventListener("click", (e) => copyText(shareLinkForSet(currentSet), e.target));
$("#combine-clear-btn").addEventListener("click", () => {
  if (!confirm("Delete all collected results for this set? (Only clears them on this device.)")) return;
  saveResults(currentSet, []);
  combineResultsCache = [];
  renderCombine(0);
  $("#combine-meta").textContent = "No results yet — paste a friend's result below, or rank it yourself.";
});
$("#combine-home-btn").addEventListener("click", goHome);

// ── events: browse ──
$("#browse-btn").addEventListener("click", showBrowse);
$("#sets-home-btn").addEventListener("click", goHome);

// ── events: keyboard ──
document.addEventListener("keydown", (e) => {
  if (!screens.match.classList.contains("active")) return;
  if (e.key === "1" || e.key === "ArrowLeft") pick(0);
  else if (e.key === "2" || e.key === "ArrowRight") pick(1);
  else if (e.key.toLowerCase() === "f") toggleFullscreen();
  else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
});

// ── init / router ──
async function init() {
  try {
    db = await openDB();
    persistenceReady = true;
  } catch (e) {
    console.warn("Persistence unavailable — running without saved progress.", e);
  }

  const params = new URLSearchParams(location.search);
  try {
    if (params.has("import")) {
      const set = addResultPayload(params.get("import"));
      history.replaceState({}, "", shareLinkForSet(set) + "&results");
      await showCombine(set);
    } else if (params.has("set")) {
      currentSet = params.get("set");
      mode = "set";
      if (params.has("results")) {
        await showCombine(currentSet);
      } else {
        const resumed = await restoreSession("set:" + currentSet);
        if (!resumed) await startSetFlow(currentSet);
      }
    } else if (params.has("browse")) {
      await showBrowse();
    } else {
      mode = "local";
      const restored = await restoreSession("current");
      if (!restored) show("upload");
      renderThumbs();
    }
  } catch (e) {
    console.warn("Routing error", e);
    mode = "local";
    show("upload");
    renderThumbs();
  }
}

init();
