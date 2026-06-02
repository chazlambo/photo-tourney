/* Living Set — Admin (standalone, password-gated).
 *
 * Talks only to the elo-worker's /admin/* endpoints with a Bearer token (the
 * password). The token is held in memory for the session only — never persisted.
 * Manage the roster: soft-hide / un-hide photos, and add a new photo (upload ->
 * placement session -> publish). No Elo is ever shown to normal rankers; this page
 * is the admin surface.
 */

const LIVE_SET = "charlie-nature-photos";
const ELO_WORKER_URL = "https://photo-tourney-elo.charlie-lambert.workers.dev/";
const API = ELO_WORKER_URL.replace(/\/+$/, "");
const PAGE_DIR = (location.origin + location.pathname).replace(/[^/]*$/, "");

const $ = (s) => document.querySelector(s);
function show(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(name);
  if (el) el.classList.add("active");
  window.scrollTo(0, 0);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function setImageUrl(fn) { return PAGE_DIR + "sets/" + encodeURIComponent(LIVE_SET) + "/" + encodeURIComponent(fn); }
function uuid() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : "x" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

let token = "";
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ""; }, 4000);
}

async function api(path, method, body) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res, data = {};
  try {
    res = await fetch(API + path, { method: method || "GET", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    try { data = await res.json(); } catch (e) {}
  } catch (e) {
    return { res: { status: 0, ok: false }, data: { error: "network error" } };
  }
  return { res, data };
}
// Any admin call returning 401/403/429 means we're no longer authed — bounce to login.
function authGuard(res) {
  if (res.status === 401 || res.status === 403) { token = ""; show("login"); $("#login-msg").textContent = "Session ended — unlock again."; return false; }
  if (res.status === 429) { toast("Too many attempts — wait a few minutes."); return false; }
  return true;
}

// ── login ──
async function login() {
  token = ($("#admin-pass").value || "").trim();
  if (!token) { $("#login-msg").textContent = "Enter the password."; return; }
  const { res } = await api("/admin/roster", "GET");
  if (res.status === 200) { $("#login-msg").textContent = ""; $("#admin-pass").value = ""; show("photos"); loadPhotos(); }
  else if (res.status === 401) { token = ""; $("#login-msg").textContent = "Wrong password."; }
  else if (res.status === 403) { token = ""; $("#login-msg").textContent = "Admin is disabled — ADMIN_TOKEN is not set on the worker."; }
  else if (res.status === 429) { token = ""; $("#login-msg").textContent = "Too many attempts. Wait a few minutes."; }
  else { $("#login-msg").textContent = "Couldn't reach the admin service."; }
}

// ── photos list ──
const previews = {}; // filename -> dataURL (so placement can show a not-yet-propagated image)

async function loadPhotos() {
  const { res, data } = await api("/admin/roster", "GET");
  if (!authGuard(res)) return;
  if (res.status !== 200) { toast(data.error || "Couldn't load roster."); return; }
  $("#photos-meta").textContent = `${data.n} active · ${data.hidden.length} hidden · ${data.pending.length} pending`;

  renderGrid($("#active-grid"), data.active, "active");
  renderGrid($("#hidden-grid"), data.hidden, "hidden");

  const pendWrap = $("#pending-wrap");
  if (data.pending.length) { pendWrap.hidden = false; renderPending($("#pending-list"), data.pending, data.placement); }
  else pendWrap.hidden = true;
}

function card(row, dim) {
  const div = document.createElement("div");
  div.className = "admin-card" + (dim ? " dim" : "");
  const img = document.createElement("img");
  img.src = setImageUrl(row.name); img.alt = escapeHtml(row.name); img.loading = "lazy";
  const cap = document.createElement("div");
  cap.className = "admin-cap";
  return { div, img, cap };
}

function renderGrid(container, rows, kind) {
  container.innerHTML = "";
  if (!rows.length) { container.innerHTML = '<p class="hint">None.</p>'; return; }
  for (const row of rows) {
    const { div, img, cap } = card(row, kind === "hidden");
    const label = document.createElement("span");
    label.textContent = `${row.elo} · ${row.w}–${row.l}`;
    const btn = document.createElement("button");
    btn.className = "pill";
    btn.textContent = kind === "hidden" ? "Un-hide" : "Hide";
    btn.addEventListener("click", () => kind === "hidden" ? unhide(row.name) : hide(row.name));
    cap.appendChild(label); cap.appendChild(btn);
    div.appendChild(img); div.appendChild(cap);
    container.appendChild(div);
  }
}

function renderPending(container, rows, placement) {
  container.innerHTML = "";
  for (const row of rows) {
    const { div, img, cap } = card(row, true);
    if (previews[row.name]) img.src = previews[row.name];
    const label = document.createElement("span");
    label.textContent = row.committed ? "ready to place" : "uploading…";
    cap.appendChild(label);
    const place = document.createElement("button");
    place.className = "pill primary";
    place.textContent = (placement && placement.file === row.name) ? "Resume placement" : "Place";
    place.disabled = !row.committed;
    place.addEventListener("click", () => startPlacement(row.name));
    const cancel = document.createElement("button");
    cancel.className = "pill";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelPending(row.name));
    cap.appendChild(place); cap.appendChild(cancel);
    div.appendChild(img); div.appendChild(cap);
    container.appendChild(div);
  }
}

async function hide(filename) {
  const { res, data } = await api("/admin/hide", "POST", { filename });
  if (!authGuard(res)) return;
  if (res.status !== 200) { toast(data.error || "Couldn't hide."); return; }
  toast(data.applied ? "Hidden." : "Already hidden.");
  loadPhotos();
}
async function unhide(filename) {
  const { res, data } = await api("/admin/unhide", "POST", { filename });
  if (!authGuard(res)) return;
  if (res.status !== 200) { toast(data.error || "Couldn't un-hide."); return; }
  toast(data.applied ? "Un-hidden." : "Already active.");
  loadPhotos();
}
async function cancelPending(filename) {
  if (!window.confirm("Cancel this pending photo? (The uploaded image file stays in the repo.)")) return;
  const { res, data } = await api("/admin/photo/cancel", "POST", { filename });
  if (!authGuard(res)) return;
  if (res.status !== 200) { toast(data.error || "Couldn't cancel."); return; }
  toast("Cancelled."); loadPhotos();
}

// ── add a photo ──
let pickedFile = null, pickedDataUrl = "", pickedUploadId = "";
function onFile() {
  const f = $("#add-file").files[0];
  $("#add-msg").textContent = "";
  $("#add-upload-btn").disabled = true;
  $("#add-preview-wrap").hidden = true;
  if (!f) return;
  if (!/^image\/(jpeg|png|webp|avif)$/.test(f.type)) { $("#add-msg").textContent = "Unsupported type — use JPEG, PNG, WebP, or AVIF."; return; }
  if (f.size > 8 * 1024 * 1024) { $("#add-msg").textContent = "Too large — must be ≤ 8 MB."; return; }
  const reader = new FileReader();
  reader.onload = () => {
    pickedFile = f; pickedDataUrl = String(reader.result); pickedUploadId = uuid();
    $("#add-preview").src = pickedDataUrl;
    $("#add-preview-wrap").hidden = false;
    $("#add-upload-btn").disabled = false;
  };
  reader.onerror = () => { $("#add-msg").textContent = "Couldn't read that file."; };
  reader.readAsDataURL(f);
}
async function uploadPhoto() {
  if (!pickedDataUrl) return;
  $("#add-upload-btn").disabled = true;
  $("#add-msg").textContent = "Uploading…";
  const { res, data } = await api("/admin/photo", "POST", {
    dataUrl: pickedDataUrl, uploadId: pickedUploadId, filenameHint: ($("#add-hint").value || "").trim(),
  });
  if (!authGuard(res)) return;
  if (res.status !== 200 || !data.ok) { $("#add-msg").textContent = data.error || "Upload failed."; $("#add-upload-btn").disabled = false; return; }
  previews[data.filename] = pickedDataUrl;     // remember for placement display
  toast("Uploaded — now place it.");
  // reset add form
  $("#add-file").value = ""; $("#add-hint").value = ""; pickedDataUrl = ""; pickedFile = null;
  startPlacement(data.filename);
}

// ── placement ──
let placeFile = "", placeToken = "";
async function startPlacement(file) {
  const { res, data } = await api("/admin/placement/start", "POST", { file });
  if (!authGuard(res)) return;
  if (res.status === 409 && /already in progress/.test(data.error || "")) {
    // resume the one in progress (must be this file)
    placeFile = data.file || file;
  } else if (res.status !== 200) {
    toast(data.error || "Couldn't start placement."); loadPhotos(); return;
  } else {
    placeFile = file;
  }
  show("place");
  $("#place-finish-btn").hidden = true;
  nextPair();
}
async function nextPair() {
  const { res, data } = await api("/admin/placement/pair", "GET");
  if (!authGuard(res)) return;
  if (res.status !== 200) { toast(data.error || "Placement error."); show("photos"); loadPhotos(); return; }
  if (data.done) { showFinish(data); return; }
  placeFile = data.file; placeToken = data.token;
  $("#place-img-a").src = previews[data.file] || setImageUrl(data.file);
  $("#place-img-b").src = setImageUrl(data.bName);
  document.querySelectorAll("#place .half").forEach((c) => c.classList.remove("flash"));
  $("#place-count").textContent = `Placing ${data.game} of ${data.targetN}`;
  $("#place-finish-btn").hidden = true;
}
async function placePick(side) {
  if (!placeToken) return;
  const tok = placeToken; placeToken = "";
  document.querySelectorAll("#place .half")[side].classList.add("flash");
  const { res, data } = await api("/admin/placement/pick", "POST", { token: tok, newcomerWon: side === 0 });
  if (!authGuard(res)) { if (res.status === 429) setTimeout(nextPair, 800); return; } // don't freeze the loop
  if (res.status !== 200) { toast(data.error || "Pick failed."); nextPair(); return; }
  setTimeout(nextPair, 180);
}
function showFinish(state) {
  $("#place-count").textContent = `Done — ${state.game || (state.log && state.log.length) || ""} matchups`;
  $("#place-finish-btn").hidden = false;
}
async function finishPlacement() {
  const { res, data } = await api("/admin/placement/finish", "POST", { confirm: placeFile });
  if (!authGuard(res)) return;
  if (res.status !== 200) { toast(data.error || "Couldn't finish."); return; }
  $("#publish-img").src = previews[placeFile] || setImageUrl(placeFile);
  $("#publish-rating").textContent = "Elo " + data.rating;
  $("#publish-msg").textContent = `Fitted starting Elo: ${data.rating} (from ${data.games} matchups). Publish to make it live for everyone.`;
  show("publish");
}
async function publishPhoto() {
  $("#publish-msg").textContent = "Checking the image is live…";
  // load-check the committed image (Pages can lag ~60s after the commit)
  const ok = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(true);
    im.onerror = () => resolve(false);
    im.src = setImageUrl(placeFile) + "?t=" + Date.now();
  });
  if (!ok) { $("#publish-msg").textContent = "Image isn't live on the site yet (still propagating). Wait ~30s and try Publish again."; return; }
  const { res, data } = await api("/admin/placement/publish", "POST", { confirm: placeFile });
  if (!authGuard(res)) return;
  if (res.status !== 200) { $("#publish-msg").textContent = data.error || "Publish failed."; return; }
  toast("Published! It's now live for everyone.");
  show("photos"); loadPhotos();
}
async function abandonPlacement() {
  if (!window.confirm("Abandon this placement? The photo stays pending; you can place it later.")) return;
  const { res } = await api("/admin/placement/abandon", "POST", {});
  if (!authGuard(res)) return;
  toast("Placement abandoned."); show("photos"); loadPhotos();
}

// ── wiring ──
$("#login-btn").addEventListener("click", login);
$("#admin-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("#add-photo-btn").addEventListener("click", () => { $("#add-msg").textContent = ""; show("add"); });
$("#photos-refresh-btn").addEventListener("click", loadPhotos);
$("#add-file").addEventListener("change", onFile);
$("#add-upload-btn").addEventListener("click", uploadPhoto);
$("#add-cancel-btn").addEventListener("click", () => { show("photos"); loadPhotos(); });
document.querySelectorAll("#place .half").forEach((c) => c.addEventListener("click", () => placePick(Number(c.dataset.side))));
$("#place-finish-btn").addEventListener("click", finishPlacement);
$("#place-exit").addEventListener("click", abandonPlacement);
$("#publish-btn").addEventListener("click", publishPhoto);
$("#publish-later-btn").addEventListener("click", () => { show("photos"); loadPhotos(); });

show("login");
