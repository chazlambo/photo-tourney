/* Photo Tournament — client-side ranking by pairwise comparison.
 *
 * Ranking model: adaptive Elo rating with Swiss-style pairing.
 *   - Every photo starts at the same rating; after each matchup the winner's
 *     rating rises and the loser's falls (standard Elo, K-factor).
 *   - Each round pairs photos with the closest ratings that haven't met yet,
 *     so comparisons are informative and rematches are avoided where possible.
 *   - Continuous ratings mean a near-tie-free full ranking, and because the
 *     ranking is just "sort by rating" you can FINISH AT ANY TIME.
 *   - Thoroughness = number of rounds (≈ matches per photo).
 *
 * Persistence: IndexedDB keeps everything across reloads.
 *   - 'blobs' store: each photo's image data, written once when added.
 *   - 'session' store: a single lightweight record (ratings, records, queue,
 *     current match, screen, settings), rewritten after every pick.
 *   On load we recreate object URLs from the blobs and resume in place.
 *   (The undo history is intentionally not persisted.)
 *
 * Everything is local; nothing is uploaded.
 */

// ── tuning ──
const MAX_PHOTOS = 256;
const START_RATING = 1000;
const K = 32; // Elo sensitivity

// ── state ──
let photos = [];          // {id,name,blob,url, rating,games,wins,losses,byes, opponents:Set}
let queue = [];           // pending matches in the current round: [photoA, photoB]
let currentMatch = null;  // [photoA, photoB]
let history = [];         // snapshots for undo (in-memory only)
let roundNumber = 0;
let matchesPlayed = 0;
let targetRounds = 5;
let estTotalPicks = 1;
let nextId = 1;
let started = false;      // has a ranking run begun?
let currentScreen = "upload";

// ── elements ──
const $ = (sel) => document.querySelector(sel);
const screens = { upload: $("#upload"), match: $("#match"), results: $("#results") };
const fileInput = $("#file-input");
const dropzone = $("#dropzone");
const thumbs = $("#thumbs");
const setupBox = $("#setup");
const chips = $("#chips");
const estimateEl = $("#estimate");
const startBtn = $("#start-btn");
const clearBtn = $("#clear-btn");
const uploadHint = $("#upload-hint");
const cards = [...document.querySelectorAll(".card")];
const undoBtn = $("#undo-btn");
const finishBtn = $("#finish-btn");
const roundInfo = $("#round-info");
const progressFill = $("#progress-fill");

function show(name) {
  currentScreen = name;
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  window.scrollTo(0, 0);
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

function store(name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

function putBlob(id, name, blob) {
  if (!persistenceReady) return;
  try { store("blobs", "readwrite").put({ id, name, blob }); } catch (e) { /* ignore */ }
}
function deleteBlob(id) {
  if (!persistenceReady) return;
  try { store("blobs", "readwrite").delete(id); } catch (e) { /* ignore */ }
}
function clearBlobs() {
  if (!persistenceReady) return;
  try { store("blobs", "readwrite").clear(); } catch (e) { /* ignore */ }
}

function saveState() {
  if (!persistenceReady) return;
  try {
    store("session", "readwrite").put({
      key: "current",
      screen: currentScreen,
      started,
      nextId,
      targetRounds,
      roundNumber,
      matchesPlayed,
      photos: photos.map((p) => ({
        id: p.id, name: p.name, rating: p.rating,
        games: p.games, wins: p.wins, losses: p.losses, byes: p.byes,
        opponents: [...p.opponents],
      })),
      queue: queue.map((m) => [m[0].id, m[1].id]),
      current: currentMatch ? [currentMatch[0].id, currentMatch[1].id] : null,
    });
  } catch (e) { /* ignore */ }
}

async function restore() {
  const blobRecords = await idbReq(store("blobs", "readonly").getAll());
  const blobById = new Map(blobRecords.map((b) => [b.id, b.blob]));
  const rec = await idbReq(store("session", "readonly").get("current"));
  if (!rec || !rec.photos || rec.photos.length === 0) return false;

  photos = rec.photos
    .filter((p) => blobById.has(p.id))
    .map((p) => {
      const blob = blobById.get(p.id);
      return {
        id: p.id, name: p.name, blob, url: URL.createObjectURL(blob),
        rating: p.rating, games: p.games, wins: p.wins,
        losses: p.losses, byes: p.byes, opponents: new Set(p.opponents || []),
      };
    });
  if (photos.length === 0) return false;

  nextId = rec.nextId || Math.max(0, ...photos.map((p) => p.id)) + 1;
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

  [...chips.children].forEach((c) =>
    c.classList.toggle("active", Number(c.dataset.rounds) === targetRounds)
  );
  renderThumbs();

  if (started && rec.screen === "results") {
    finish();
  } else if (started && rec.screen === "match") {
    show("match");
    if (currentMatch) renderMatch();
    else advance();
  } else {
    show("upload");
  }
  return true;
}

// ── uploads ──
function addFiles(fileList) {
  let skipped = 0;
  for (const file of fileList) {
    if (!file.type.startsWith("image/")) continue;
    if (photos.length >= MAX_PHOTOS) {
      skipped++;
      continue;
    }
    const id = nextId++;
    photos.push({
      id,
      name: file.name,
      blob: file,
      url: URL.createObjectURL(file),
      rating: START_RATING,
      games: 0,
      wins: 0,
      losses: 0,
      byes: 0,
      opponents: new Set(),
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

  if (skipped > 0) {
    uploadHint.textContent = `Reached the ${MAX_PHOTOS}-photo limit — ${skipped} not added.`;
  } else if (n < 2) {
    uploadHint.textContent = "Add at least 2 photos to begin.";
  } else {
    uploadHint.textContent = `${n} photos ready.`;
  }
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
  photos.forEach((p) => URL.revokeObjectURL(p.url));
  photos = [];
  started = false;
  queue = [];
  currentMatch = null;
  history = [];
  clearBlobs();
  renderThumbs();
  saveState();
}

function updateEstimate() {
  const n = photos.length;
  if (n < 2) {
    estimateEl.textContent = "";
    return;
  }
  estTotalPicks = targetRounds * Math.floor(n / 2);
  estimateEl.textContent = `≈ ${estTotalPicks} picks (about ${targetRounds} per photo). You can stop early anytime.`;
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
  winner.wins++;
  loser.losses++;
  winner.games++;
  loser.games++;
  winner.opponents.add(loser.id);
  loser.opponents.add(winner.id);
}

// Build one Swiss round: pair close-rated photos, avoiding rematches.
function buildRound() {
  queue = [];
  let pool = [...photos];

  // Odd count: give a bye to whoever has played most (keeps games balanced).
  if (pool.length % 2 === 1) {
    pool.sort((a, b) => b.games - a.games || Math.random() - 0.5);
    pool.shift().byes++;
  }

  pool = roundNumber === 0
    ? shuffle(pool)
    : pool.sort((a, b) => b.rating - a.rating || Math.random() - 0.5);

  const used = new Set();
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (used.has(a.id)) continue;
    let partner = null;
    let fallback = null;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      if (used.has(b.id)) continue;
      if (fallback === null) fallback = b;
      if (!a.opponents.has(b.id)) {
        partner = b;
        break;
      }
    }
    const b = partner || fallback;
    if (b) {
      used.add(a.id);
      used.add(b.id);
      queue.push([a, b]);
    }
  }
  queue = shuffle(queue); // vary order within the round
  roundNumber++;
}

function startRanking() {
  roundNumber = 0;
  matchesPlayed = 0;
  history = [];
  started = true;
  photos.forEach((p) => {
    p.rating = START_RATING;
    p.games = 0;
    p.wins = 0;
    p.losses = 0;
    p.byes = 0;
    p.opponents = new Set();
  });
  updateEstimate();
  show("match");
  advance();
}

function advance() {
  if (queue.length === 0) {
    if (roundNumber >= targetRounds || photos.length < 2) {
      finish();
      return;
    }
    buildRound();
    if (queue.length === 0) {
      finish();
      return;
    }
  }
  currentMatch = queue.shift();
  renderMatch();
}

function renderMatch() {
  const [a, b] = currentMatch;
  cards[0].querySelector("img").src = a.url;
  cards[1].querySelector("img").src = b.url;
  cards.forEach((c) => c.classList.remove("flash"));

  roundInfo.textContent =
    `Round ${roundNumber}/${targetRounds} · pick ${matchesPlayed + 1} of ~${estTotalPicks}`;
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

function finish() {
  const ranked = [...photos].sort(
    (a, b) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses
  );
  renderResults(ranked);
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
    const label = i === 0 ? "🏆 #1" : "#" + (i + 1);
    item.innerHTML = `<span class="rank-badge">${label}</span>
      <img src="${p.url}" alt="${escapeHtml(p.name)}" />
      <span class="rank-record">${p.wins}–${p.losses}</span>`;
    wrap.appendChild(item);
  });
}

// Continue refining from current ratings, adding more rounds.
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
      id: p.id,
      rating: p.rating,
      games: p.games,
      wins: p.wins,
      losses: p.losses,
      byes: p.byes,
      opponents: [...p.opponents],
    })),
    queue: queue.map((m) => [m[0].id, m[1].id]),
    current: currentMatch ? [currentMatch[0].id, currentMatch[1].id] : null,
    roundNumber,
    matchesPlayed,
  };
}

function undo() {
  const snap = history.pop();
  if (!snap) return;
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const s of snap.state) {
    const p = byId.get(s.id);
    p.rating = s.rating;
    p.games = s.games;
    p.wins = s.wins;
    p.losses = s.losses;
    p.byes = s.byes;
    p.opponents = new Set(s.opponents);
  }
  queue = snap.queue.map((m) => [byId.get(m[0]), byId.get(m[1])]);
  currentMatch = snap.current ? [byId.get(snap.current[0]), byId.get(snap.current[1])] : null;
  roundNumber = snap.roundNumber;
  matchesPlayed = snap.matchesPlayed;

  show("match");
  if (currentMatch) renderMatch();
  else advance();
}

// ── utils ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ── events ──
fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

thumbs.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove");
  if (btn) removePhoto(Number(btn.dataset.id));
});

chips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  [...chips.children].forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  targetRounds = Number(chip.dataset.rounds);
  updateEstimate();
  saveState();
});

startBtn.addEventListener("click", startRanking);
clearBtn.addEventListener("click", clearAll);
undoBtn.addEventListener("click", undo);
finishBtn.addEventListener("click", finish);
cards.forEach((card, i) => card.addEventListener("click", () => pick(i)));

$("#refine-btn").addEventListener("click", refine);
$("#rematch-btn").addEventListener("click", startRanking);
$("#new-btn").addEventListener("click", () => {
  clearAll();
  show("upload");
});

document.addEventListener("keydown", (e) => {
  if (!screens.match.classList.contains("active")) return;
  if (e.key === "1" || e.key === "ArrowLeft") pick(0);
  else if (e.key === "2" || e.key === "ArrowRight") pick(1);
  else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    undo();
  }
});

// ── init ──
async function init() {
  try {
    db = await openDB();
    persistenceReady = true;
    await restore();
  } catch (e) {
    console.warn("Persistence unavailable — running without saved progress.", e);
  }
  renderThumbs();
}

init();
