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
const RESULTS_DIR = "results"; // shared-set rankings are committed as results/<set>/<name>.json
// Auto-save endpoint (Cloudflare Worker) that commits results to the repo. The
// write token lives only in the Worker, never in the browser.
const WORKER_URL = "https://photo-tourney-results-worker.charlie-lambert.workers.dev/";

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
let participantName = "";  // name used for shared-set rankings (per device)
try { participantName = localStorage.getItem("pt-name") || ""; } catch (e) {}

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
const combinePerson = $("#combine-person");
const combineRanking = $("#combine-ranking");
const nameInput = $("#participant-name");

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
function ostore(name, txMode) {
  return db.transaction(name, txMode).objectStore(name);
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

  photos.forEach((p) => p.blob && URL.revokeObjectURL(p.url));
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
// Pairing cost: prefer close Elo, strongly penalise a rematch. Minimising the
// total of this over the round gives close-rated matchups while avoiding repeats
// whenever the set is large enough to allow it.
const REMATCH_PENALTY = 1e6;
function pairCost(a, b) {
  return Math.abs(a.rating - b.rating) + (a.opponents.has(b.id) ? REMATCH_PENALTY : 0);
}

function buildRound() {
  queue = [];
  let pool = [...photos];
  if (pool.length % 2 === 1) {
    // odd one out gets a bye; give it to whoever has played most (and fewest byes)
    pool.sort((a, b) => b.games - a.games || a.byes - b.byes || Math.random() - 0.5);
    pool.shift().byes++;
  }
  pool = roundNumber === 0 ? shuffle(pool) : pool.sort((a, b) => b.rating - a.rating || Math.random() - 0.5);

  // Seed: pair each photo (high rating first) with its lowest-cost partner.
  const pairs = [];
  const rest = [...pool];
  while (rest.length >= 2) {
    const a = rest.shift();
    let bestIdx = 0, bestCost = Infinity;
    for (let k = 0; k < rest.length; k++) {
      const c = pairCost(a, rest[k]);
      if (c < bestCost) { bestCost = c; bestIdx = k; }
    }
    pairs.push([a, rest.splice(bestIdx, 1)[0]]);
  }

  // 2-opt local search: swap partners between any two pairs whenever it lowers
  // the total cost. This both removes avoidable rematches and tightens Elo
  // closeness (a far-apart pairing gets swapped for two closer ones).
  let improved = true, guard = 0;
  while (improved && guard++ < 16) {
    improved = false;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [a, b] = pairs[i];
        const [c, d] = pairs[j];
        const cur = pairCost(a, b) + pairCost(c, d);
        const s1 = pairCost(a, c) + pairCost(b, d);
        const s2 = pairCost(a, d) + pairCost(c, b);
        if (s1 < cur && s1 <= s2) { pairs[i] = [a, c]; pairs[j] = [b, d]; improved = true; }
        else if (s2 < cur) { pairs[i] = [a, d]; pairs[j] = [c, b]; improved = true; }
      }
    }
  }

  queue = shuffle(pairs);
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
  const imgA = cards[0].querySelector("img");
  const imgB = cards[1].querySelector("img");
  imgA.src = a.url; imgA.alt = a.name;
  imgB.src = b.url; imgB.alt = b.name;
  cards[0].setAttribute("aria-label", "Pick left photo: " + a.name);
  cards[1].setAttribute("aria-label", "Pick right photo: " + b.name);
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
  setTimeout(advance, 240);
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
  if (isSet) autoAddOwnResult();
  show("results");
  saveState();
}

// When you finish ranking a shared set, your ranking is saved automatically:
// cached locally and (if the owner's token is connected) committed to the repo.
function autoAddOwnResult() {
  if (mode !== "set" || !currentSet) return;
  const entry = { n: participantName || "Me", o: rankedPhotos().map((p) => p.cidx), c: photos.length };
  ingestResult(currentSet, entry).catch((e) => {
    alert("Couldn't save your ranking automatically (" + e.message + "). It's kept on this device — try finishing again when you're online.");
  });
}

function renderResults(ranked) {
  const picks = `Based on ${matchesPlayed} pick${matchesPlayed === 1 ? "" : "s"} across ${roundNumber} round${roundNumber === 1 ? "" : "s"}.`;
  const ctx = mode === "set"
    ? `Your ranking for “${prettify(currentSet)}” as ${participantName || "Me"}. `
    : "Your personal ranking. ";
  $("#results-sub").textContent = ctx + picks;
  const wrap = $("#ranking");
  wrap.innerHTML = "";
  ranked.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "rank-item" + (i === 0 ? " winner" : "");
    item.innerHTML = `<span class="rank-badge">${i === 0 ? "🏆 #1" : "#" + (i + 1)}</span>
      <img src="${p.url}" alt="${escapeHtml(p.name)}" />
      <span class="rank-record" title="Elo rating · win–loss">${Math.round(p.rating)} · ${p.wins}–${p.losses}</span>`;
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
    if (!p) continue;
    p.rating = s.rating; p.games = s.games; p.wins = s.wins;
    p.losses = s.losses; p.byes = s.byes; p.opponents = new Set(s.opponents);
  }
  queue = snap.queue
    .map((m) => [byId.get(m[0]), byId.get(m[1])])
    .filter((m) => m[0] && m[1]);
  currentMatch =
    snap.current && byId.get(snap.current[0]) && byId.get(snap.current[1])
      ? [byId.get(snap.current[0]), byId.get(snap.current[1])]
      : null;
  roundNumber = snap.roundNumber;
  matchesPlayed = snap.matchesPlayed;
  show("match");
  if (currentMatch) renderMatch();
  else advance();
  saveState();
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
  photos.forEach((p) => p.blob && URL.revokeObjectURL(p.url));
  photos = filenames.map((fn, idx) => ({
    id: "s" + idx, cidx: idx, name: fn, blob: null, url: setImageUrl(set, fn),
    rating: START_RATING, games: 0, wins: 0, losses: 0, byes: 0, opponents: new Set(),
  }));
  nextId = filenames.length;
}

function showSetIntro() {
  $("#set-title").textContent = prettify(currentSet);
  $("#set-meta").textContent = `${photos.length} photos in this set.`;
  if (nameInput) nameInput.value = participantName;
  updateEstimate();
  syncChips();
  show("set-intro");
  if (nameInput && !participantName) nameInput.focus();
  saveState();
}

// capture the typed name (persisted per device) before a shared-set ranking
function captureName() {
  const v = (nameInput && nameInput.value || "").trim();
  participantName = v || participantName || "Me";
  try { localStorage.setItem("pt-name", participantName); } catch (e) {}
}

async function startSetFlow(set) {
  mode = "set";
  currentSet = set;
  $("#set-title").textContent = prettify(set);
  $("#set-meta").innerHTML = '<span class="pulse">Loading set…</span>';
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

// ── share link (invite people to rank a set) ──
function shareLinkForSet(set) {
  return PAGE_URL + "?set=" + encodeURIComponent(set);
}

// ── combine storage ──
// Source of truth is the repo (results/<set>/<name>.json), written with the owner's
// token. A localStorage cache mirrors it so things appear instantly and still work
// without a token (e.g. a friend's own ranking before they share it).
function combineKey(set) { return "pt-combine:" + set; }
function loadResults(set) {
  try { return JSON.parse(localStorage.getItem(combineKey(set))) || []; } catch (e) { return []; }
}
function saveResults(set, arr) {
  try { localStorage.setItem(combineKey(set), JSON.stringify(arr)); } catch (e) {}
}
function saveResultLocal(set, entry) {
  const arr = loadResults(set);
  const i = arr.findIndex((x) => x.n.toLowerCase() === entry.n.toLowerCase());
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  saveResults(set, arr);
}
// Save a ranking: cache locally for instant display, and POST to the Worker,
// which commits it to the repo as results/<set>/<name>.json. No secret lives in
// the browser — this is what makes every finish auto-save with no further action.
async function ingestResult(set, entry) {
  saveResultLocal(set, entry);
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ set, name: entry.n, order: entry.o, count: entry.c }),
  });
  if (!res.ok) {
    let msg = "save failed (" + res.status + ")";
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
}
function mergeResults(primary, secondary) {
  const map = new Map();
  for (const r of primary) map.set(r.n.toLowerCase(), r);
  for (const r of secondary) if (!map.has(r.n.toLowerCase())) map.set(r.n.toLowerCase(), r);
  return [...map.values()];
}

// ── reading result files from the repo (public; no auth needed) ──
function ghContentsUrl(path) {
  return `https://api.github.com/repos/${REPO}/contents/` + path.split("/").map(encodeURIComponent).join("/");
}
async function fetchRepoResults(set) {
  const res = await fetch(ghContentsUrl(`${RESULTS_DIR}/${set}`), { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error("Couldn't read results from the repo.");
  const items = await res.json();
  const files = items.filter((i) => i.type === "file" && /\.json$/i.test(i.name));
  const loaded = await Promise.all(files.map(async (f) => {
    try {
      const r = await fetch(f.download_url);
      if (!r.ok) return null;
      const d = await r.json();
      if (d && Array.isArray(d.o)) return { n: d.n || "Anonymous", o: d.o, c: d.c || d.o.length };
    } catch (e) {}
    return null;
  }));
  return loaded.filter(Boolean);
}

// Borda points per photo (cidx): a photo gets (N-1-position) points from each ranking.
function bordaScores(results, N) {
  const score = new Array(N).fill(0);
  for (const r of results) {
    r.o.forEach((cidx, pos) => {
      if (cidx < N) score[cidx] += (N - 1 - pos);
    });
  }
  return score;
}

// badgeByCidx (optional): map of cidx -> short text shown in the corner badge.
function renderRankingGrid(container, orderOfCidx, badgeByCidx) {
  container.innerHTML = "";
  orderOfCidx.forEach((cidx, i) => {
    const p = photos[cidx];
    if (!p) return;
    const item = document.createElement("div");
    item.className = "rank-item" + (i === 0 ? " winner" : "");
    const badge = badgeByCidx && cidx in badgeByCidx
      ? `<span class="rank-record">${badgeByCidx[cidx]}</span>` : "";
    item.innerHTML = `<span class="rank-badge">${i === 0 ? "🏆 #1" : "#" + (i + 1)}</span>
      <img src="${p.url}" alt="${escapeHtml(p.name)}" />${badge}`;
    container.appendChild(item);
  });
}

let combineResultsCache = [];

// The combined ranking is its own button; the dropdown holds ONLY individuals
// (so a participant's name — even "Combined" — can never collide with it).
function populatePersonSelect(results) {
  combinePerson.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.disabled = true;
  ph.selected = true;
  ph.textContent = results.length ? "View an individual ranking…" : "No individual rankings yet";
  combinePerson.appendChild(ph);
  results.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = r.n;
    combinePerson.appendChild(o);
  });
  combinePerson.disabled = results.length === 0;
}
function renderCombined() {
  const N = photos.length;
  const score = bordaScores(combineResultsCache, N);
  const order = [...Array(N).keys()].sort((a, b) => score[b] - score[a]);
  const badge = {};
  order.forEach((c) => (badge[c] = score[c] + " pts"));
  renderRankingGrid(combineRanking, order, badge);
  $("#combine-overall-btn").classList.add("active");
  combinePerson.value = "";
}
function renderPerson(i) {
  const r = combineResultsCache[i];
  if (!r) return;
  const N = photos.length;
  renderRankingGrid(combineRanking, (r.o || []).filter((c) => c < N));
  $("#combine-overall-btn").classList.remove("active");
}

async function showCombine(set) {
  mode = "set";
  currentSet = set;
  $("#combine-title").textContent = prettify(set);
  $("#combine-meta").innerHTML = '<span class="pulse">Loading set…</span>';
  combinePerson.innerHTML = "";
  combineRanking.innerHTML = "";
  show("combine");
  try {
    const filenames = await fetchSetFilenames(set);
    loadSetAsPhotos(set, filenames);
  } catch (e) {
    $("#combine-meta").textContent = e.message || "Couldn't load this set's images.";
    return;
  }
  let repoResults = [];
  try { repoResults = await fetchRepoResults(set); } catch (e) { /* fall back to local cache */ }
  const mine = loadResults(set); // this device's own submissions for this set
  combineResultsCache = mergeResults(repoResults, mine);
  const n = combineResultsCache.length;
  $("#combine-meta").textContent = n === 0
    ? "No rankings yet — be the first to rank this set."
    : `${n} ranking${n === 1 ? "" : "s"} so far.`;
  // Whether THIS person has ranked it (never imply a ranking they don't have).
  $("#combine-you").textContent = mine.length
    ? `You ranked this as ${mine[mine.length - 1].n}.`
    : "You haven't ranked this set yet.";
  populatePersonSelect(combineResultsCache);
  renderCombined();
}

// ── browse sets ──
async function showBrowse() {
  show("sets");
  const list = $("#sets-list");
  list.innerHTML = `<p class="empty-state pulse">Loading sets…</p>`;
  let sets;
  try { sets = await listSets(); }
  catch (e) { list.innerHTML = `<p class="empty-state">${escapeHtml(e.message)}</p>`; return; }
  if (sets.length === 0) {
    list.innerHTML = `<p class="empty-state">No sets yet. Paste a folder of images into <code>sets/</code> in the repo, then push.</p>`;
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
      window.history.pushState({}, "", shareLinkForSet(name));
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
  window.history.replaceState({}, "", PAGE_URL);
  restoreSession("current").then((restored) => {
    if (!restored) {
      photos = [];
      queue = [];
      currentMatch = null;
      history = [];
      roundNumber = 0;
      matchesPlayed = 0;
      started = false;
      show("upload");
    }
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
$("#set-start-btn").addEventListener("click", () => { captureName(); startRanking(); });
$("#set-results-btn").addEventListener("click", () => showCombine(currentSet));
$("#set-copylink-btn").addEventListener("click", (e) => copyText(shareLinkForSet(currentSet), e.target));

// ── events: results (shared set) ──
$("#view-combined-btn").addEventListener("click", () => showCombine(currentSet));

// ── events: combine ──
$("#combine-overall-btn").addEventListener("click", renderCombined);
combinePerson.addEventListener("change", () => {
  if (combinePerson.value !== "") renderPerson(Number(combinePerson.value));
});
$("#combine-rank-btn").addEventListener("click", () => startSetFlow(currentSet));
$("#combine-copylink-btn").addEventListener("click", (e) => copyText(shareLinkForSet(currentSet), e.target));
$("#combine-home-btn").addEventListener("click", goHome);

// ── events: browse (sets browser — "Rank a shared set" on home, or the ?browse URL) ──
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
    if (params.has("set")) {
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
