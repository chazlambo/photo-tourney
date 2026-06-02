/**
 * Photo Tournament — LIVING shared-Elo endpoint (Cloudflare Worker + Durable Object).
 *
 * A SEPARATE service from the git-commit results worker (worker/results-worker.js).
 * Backs the standalone live.html page: anyone ranks photos from the
 * "charlie-nature-photos" set into one GLOBAL, living Elo. Every pick updates the
 * shared rating immediately and atomically. Rankers never receive Elo — only the
 * deliberate, terminal /leaderboard view (and admin views) expose numbers.
 *
 * The Durable Object is the LIVE SOURCE OF TRUTH for the roster (which photos are
 * active / hidden / pending), their Elo, and the fingerprint. It bootstraps from the
 * baked-in SEED (worker/seed/seed.js) on first run, then evolves via admin actions.
 *
 * Admin (password-gated, Bearer ADMIN_TOKEN, timing-safe):
 *   - soft hide / un-hide photos (reversible; no repo write)
 *   - add a photo: upload image -> committed to the repo via ELO_GH_TOKEN ->
 *     placement session (rate it vs N actives) -> batch MLE fit -> publish.
 *
 * Secrets (npx wrangler secret put …):
 *   ADMIN_TOKEN    — bearer token for all /admin/* (admin disabled if unset)
 *   ELO_GH_TOKEN   — fine-grained PAT, Contents:R+W on the repo (only for photo upload)
 * Plain vars (wrangler.toml): ALLOWED_ORIGIN, SET, REPO
 *
 * Public endpoints (NO Elo): GET /pair, POST /pick, GET /meta, GET /roster.
 * Elo-bearing: GET /leaderboard (terminal) + all /admin/*.
 */

import { SEED } from "./seed/seed.js";

// ── Elo constants (verbatim from app.js:19-20,331-339) ──
const START_RATING = 1000;
const K = 32;
function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

const IDEMP_TTL_MS = 6 * 60 * 60 * 1000;   // remember pickIds this long (retry window)
const SESSION_TTL_MS = 30 * 60 * 1000;     // prune idle in-memory sessions after this
const MAX_SESSIONS = 2000;
const MAX_SEEN_PER_SESSION = 4000;
const MAX_SNAPSHOTS = 20;
const MAX_CONTRIB = 200;
const MAX_ACTIVE = 256;                     // cap on ACTIVE photos in the DO roster
                                            // (results-worker.js MAX_PHOTOS=256 bounds a
                                            // different quantity: a ranking's size vs the
                                            // on-disk file count, which includes hidden)
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;   // decoded image size cap
const MAX_BODY_BYTES = 11 * 1024 * 1024;    // base64 + JSON envelope cap
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_MIME = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
function pairKey(a, b) { return a < b ? a + "-" + b : b + "-" + a; }
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Canonical filename order — KEEP IN SYNC with app.js:629, live.js, build-seed.mjs.
function sortCmp(a, b) { return a.localeCompare(b, "en", { numeric: true }); }
function insertSorted(arr, entry) {
  let i = 0;
  while (i < arr.length && sortCmp(arr[i].name, entry.name) < 0) i++;
  arr.splice(i, 0, entry);
}
async function fingerprintOf(names) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(names.join("\n")));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
// Version token clients echo on /pick. Bumps whenever the active roster changes.
function tokenOf(meta) { return meta.seedV + "#" + (meta.mutationSeq || 0); }
function slugForName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}
function median(arr) {
  if (!arr.length) return START_RATING;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Batch maximum-likelihood Elo fit over placement matchups (order-independent).
// L(r)=Σ y·ln p + (1-y)·ln(1-p), p=expected(r,oR); dL/dr ∝ Σ(y-p) is monotone → bisect.
function mleFit(log, lo, hi) {
  const wins = log.reduce((s, e) => s + (e.win ? 1 : 0), 0);
  if (wins === 0) return lo;
  if (wins === log.length) return hi;
  let a = lo, b = hi;
  for (let it = 0; it < 40; it++) {
    const m = (a + b) / 2;
    let d = 0;
    for (const e of log) d += (e.win ? 1 : 0) - expected(m, e.oR);
    if (d > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}
// Placement opponents: even-stride spread across the rating range, then nearest distinct.
function selectOpponents(active, startRating, targetN) {
  const byR = [...active].sort((x, y) => x.r - y.r);
  const N = byR.length, want = Math.min(targetN, N);
  const chosen = [], used = new Set();
  const phaseA = Math.ceil(want / 2);
  for (let i = 0; i < phaseA; i++) {
    const nm = byR[Math.floor(i * N / phaseA)].name;
    if (!used.has(nm)) { used.add(nm); chosen.push(nm); }
  }
  const byClose = [...active].sort((x, y) => Math.abs(x.r - startRating) - Math.abs(y.r - startRating));
  for (const x of byClose) {
    if (chosen.length >= want) break;
    if (!used.has(x.name)) { used.add(x.name); chosen.push(x.name); }
  }
  return chosen;
}
function sniffOk(mime, b) {
  if (mime === "image/jpeg") return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  if (mime === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
    b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
  if (mime === "image/webp") return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (mime === "image/avif") {
    if (!(b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)) return false; // 'ftyp'
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]); // major brand
    return ["avif", "avis", "mif1", "msf1", "mia1"].includes(brand);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker: CORS, the /admin/photo upload boundary (holds ELO_GH_TOKEN), else route
// everything to the single Durable Object instance.
// ─────────────────────────────────────────────────────────────────────────────
function getStub(env) {
  const id = env.SHARED_ELO.idFromName(env.SET || SEED.set);
  return env.SHARED_ELO.get(id);
}
async function doCall(env, path, method, bodyObj, authHeader) {
  const headers = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;
  return getStub(env).fetch(new Request("https://do" + path, {
    method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  }));
}

export default {
  async fetch(request, env) {
    const ORIGIN = env.ALLOWED_ORIGIN || "https://chazlambo.github.io";
    const cors = {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The ONLY route handled in the (stateless) outer Worker: image upload, because
    // it holds ELO_GH_TOKEN and streams an 8 MB body that must never reach the DO.
    if (request.method === "POST" && path === "/admin/photo") {
      return handlePhotoUpload(request, env, cors);
    }

    let res;
    try {
      res = await getStub(env).fetch(request);
    } catch (e) {
      return new Response(JSON.stringify({ error: "store unavailable" }), {
        status: 502, headers: { "Content-Type": "application/json", ...cors },
      });
    }
    const headers = new Headers(res.headers);
    for (const k in cors) headers.set(k, cors[k]);
    return new Response(res.body, { status: res.status, headers });
  },
};

async function handlePhotoUpload(request, env, cors) {
  const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", ...cors } });
  // 1. auth FIRST
  if (!env.ADMIN_TOKEN) return J({ error: "admin disabled (no ADMIN_TOKEN set)" }, 403);
  const auth = request.headers.get("Authorization") || "";
  if (!timingSafeEqual(auth.replace(/^Bearer\s+/i, ""), env.ADMIN_TOKEN)) return J({ error: "unauthorized" }, 401);
  if (!env.ELO_GH_TOKEN) return J({ error: "upload not configured (no ELO_GH_TOKEN set)" }, 500);
  // 2. size pre-check BEFORE reading the body
  const clen = Number(request.headers.get("Content-Length") || 0);
  if (clen > MAX_BODY_BYTES) return J({ error: "payload too large" }, 413);
  // 3. parse
  let data;
  try { data = await request.json(); } catch (e) { return J({ error: "bad json" }, 400); }
  const uploadId = String(data.uploadId || "").slice(0, 64);
  if (!uploadId) return J({ error: "uploadId required" }, 400);
  const mm = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(data.dataUrl || ""));
  if (!mm) return J({ error: "bad dataUrl" }, 400);
  const mime = mm[1].toLowerCase();
  const content = mm[2]; // already-valid base64; passed straight to GitHub
  if (!ALLOWED_MIME[mime]) return J({ error: "unsupported image type" }, 400);
  // Cap the raw base64 string too — the Content-Length header is client-controlled
  // and may be missing/understated, which would otherwise let a huge body through.
  if (content.length > MAX_BODY_BYTES) return J({ error: "payload too large" }, 413);
  // 4. decode head for magic-byte sniff + size
  let head, declen;
  try {
    const bin = atob(content);
    declen = bin.length;
    head = new Uint8Array(Math.min(declen, 16));
    for (let i = 0; i < head.length; i++) head[i] = bin.charCodeAt(i);
  } catch (e) { return J({ error: "bad base64" }, 400); }
  if (declen < 100 || declen > MAX_UPLOAD_BYTES) return J({ error: "image size out of range" }, 413);
  if (!sniffOk(mime, head)) return J({ error: "content does not match declared type" }, 400);
  // 5. claim a filename in the DO (serialized, idempotent on uploadId)
  const claimRes = await doCall(env, "/admin/photo/claim", "POST", { uploadId, mime, hint: data.filenameHint || "" }, auth);
  if (!claimRes.ok) return new Response(await claimRes.text(), { status: claimRes.status, headers: { "Content-Type": "application/json", ...cors } });
  const claim = await claimRes.json();
  const filename = claim.filename;
  // 6. path safety — hard-prefix to the one allowed directory
  const dir = "sets/" + (env.SET || SEED.set) + "/";
  const path = dir + filename;
  if (!path.startsWith(dir) || filename.includes("/") || filename.includes("..")) return J({ error: "bad filename" }, 400);
  // 7. commit to the repo (outside any DO lock)
  const repo = env.REPO || "chazlambo/photo-tourney";
  const gh = { Authorization: "Bearer " + env.ELO_GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "photo-tourney-elo-worker" };
  const apiUrl = `https://api.github.com/repos/${repo}/contents/` + path.split("/").map(encodeURIComponent).join("/");
  let sha;
  const gr = await fetch(apiUrl, { headers: gh });
  if (gr.ok) { try { sha = (await gr.json()).sha; } catch (e) {} }
  const cbody = { message: `photo: add ${filename} (admin)`, content, branch: "main" };
  if (sha) cbody.sha = sha;
  let put = await fetch(apiUrl, { method: "PUT", headers: gh, body: JSON.stringify(cbody) });
  if (put.status === 409) {
    const rg = await fetch(apiUrl, { headers: gh });
    if (rg.ok) { try { cbody.sha = (await rg.json()).sha; } catch (e) {} }
    put = await fetch(apiUrl, { method: "PUT", headers: gh, body: JSON.stringify(cbody) });
  }
  if (!put.ok) return J({ error: "github write failed", status: put.status, filename, registered: true, committed: false }, 502);
  let commitSha;
  try { commitSha = ((await put.json()).content || {}).sha; } catch (e) {}
  // 8. mark committed in the DO (idempotent). Retry once; if it still fails, do NOT
  //    report success — the image is in the repo but unplaceable until registered.
  //    Re-running the upload with the same uploadId recovers (claim + PUT idempotent).
  let cd = await doCall(env, "/admin/photo/commit-done", "POST", { filename, uploadId, commitSha }, auth);
  if (!cd.ok) cd = await doCall(env, "/admin/photo/commit-done", "POST", { filename, uploadId, commitSha }, auth);
  if (!cd.ok) {
    return J({ ok: false, error: "image saved but registration failed — re-click Upload to retry", filename, committed: true, registered: false }, 502);
  }
  return J({ ok: true, filename, committed: true, registered: true, commitSha, startElo: claim.startElo }, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable Object: the single living-Elo store + serialized writer.
// ─────────────────────────────────────────────────────────────────────────────
export class SharedElo {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();   // sid -> { seen:Set(pairKey), last }
    this._authFails = new Map(); // ip -> { n, until }  (best-effort throttle)
    this.ready = state.blockConcurrencyWhile(() => this.init());
  }

  async init() {
    this.meta = await this.state.storage.get("meta");
    this.elo = await this.state.storage.get("elo");
    this.roster = await this.state.storage.get("roster");
    this.placement = (await this.state.storage.get("placement")) || null;
    this.seen = new Map((await this.state.storage.get("seen")) || []);

    let changed = false;
    if (!this.meta && !this.elo && !this.roster) { this.bootstrapFromSeed(); changed = true; }
    else if (this.meta && this.meta.schemaV < 2) { changed = await this.migrateV1toV2(); }
    else if (this.meta && this.meta.schemaV >= 2 && !this.roster && this.elo) { this.synthRosterFromElo(); changed = true; }

    await this.rebuildActive();
    if (changed) {
      await this.state.storage.put("roster", this.roster);
      await this.state.storage.put("meta", this.meta);
    }
  }

  bootstrapFromSeed() {
    this.roster = {
      schemaV: 2,
      photos: SEED.names.map((name, i) => ({ name, status: "active", r: SEED.r[i], g: 0, w: 0, l: 0 })),
    };
    this.meta = {
      schemaV: 2, seedV: SEED.version, mutationSeq: 0, set: SEED.set,
      n: SEED.n, fingerprint: SEED.fingerprint, names: SEED.names.slice(),
      createdAt: Date.now(), lastWriteAt: 0, totalPicks: 0, contrib: {}, placement: null,
    };
  }

  // Migrate the deployed v1 layout (top-level `elo` arrays + meta.names) to the v2
  // roster. PRESERVE the existing name order (no re-sort — avoids cross-runtime
  // localeCompare drift). Keep the `elo` key as a rollback backup (never deleted).
  async migrateV1toV2() {
    if (!this.meta || !this.elo) return false;
    const old = this.elo;
    this.roster = {
      schemaV: 2,
      photos: this.meta.names.map((name, i) => ({ name, status: "active", r: old.r[i], g: old.g[i], w: old.w[i], l: old.l[i] })),
    };
    // Sanity-check the fingerprint, but DON'T throw — rebuildActive() recomputes
    // meta.fingerprint from the active names right after this, so a completed
    // migration self-corrects. Throwing here would reject `ready` and brick the
    // DO (including the admin recovery endpoints). Record a warning instead.
    const checkFp = await fingerprintOf(this.roster.photos.map((p) => p.name));
    if (checkFp !== this.meta.fingerprint) {
      this.meta.migrationFpWarn = { expected: this.meta.fingerprint, got: checkFp, at: Date.now() };
    }
    this.meta.schemaV = 2;
    this.meta.mutationSeq = this.meta.mutationSeq || 0;
    if (this.meta.placement === undefined) this.meta.placement = null;
    return true;
  }

  // Defensive rebuild of the roster from the legacy projection. Only ever runs if
  // schemaV>=2 but the roster key is missing (a partial write). Build ONLY aligned,
  // finite entries — never produce NaN ratings, never throw (which would brick init).
  synthRosterFromElo() {
    const names = (this.meta && this.meta.names) || [];
    const r = (this.elo && this.elo.r) || [];
    const n = Math.min(names.length, r.length);
    const photos = [];
    for (let i = 0; i < n; i++) {
      const e = { name: names[i], status: "active", r: this.elo.r[i], g: this.elo.g[i], w: this.elo.w[i], l: this.elo.l[i] };
      if ([e.r, e.g, e.w, e.l].every(Number.isFinite)) photos.push(e);
    }
    this.roster = { schemaV: 2, photos };
    this.meta.schemaV = 2;
    this.meta.mutationSeq = this.meta.mutationSeq || 0;
    if (this.meta.placement === undefined) this.meta.placement = null;
  }

  // Project the active subset into the dense `this.elo` arrays the hot paths use.
  async rebuildActive() {
    const active = this.roster.photos.filter((p) => p.status === "active");
    this.activeRef = active;
    this.elo = { r: active.map((p) => p.r), g: active.map((p) => p.g), w: active.map((p) => p.w), l: active.map((p) => p.l) };
    const names = active.map((p) => p.name);
    const fp = await fingerprintOf(names);            // single await, then sync assignment group
    this.meta.names = names; this.meta.n = names.length; this.meta.fingerprint = fp;
    if (this.activeRef.length !== this.elo.r.length || this.elo.r.length !== this.meta.n) {
      throw new Error("rebuildActive invariant violated");
    }
  }
  // Mirror the two touched ratings back into the roster records before persisting.
  writeBackElo(...idx) {
    for (const i of idx) {
      const p = this.activeRef[i];
      if (p) { p.r = this.elo.r[i]; p.g = this.elo.g[i]; p.w = this.elo.w[i]; p.l = this.elo.l[i]; }
    }
  }
  // The single roster-mutation primitive. CALLER must already hold the DO lock.
  async _applyRosterChange(reason, { snapshot } = {}) {
    if (snapshot) {
      const key = `snapshot:${this.meta.seedV}:${Date.now()}:${crypto.randomUUID()}`;
      await this.state.storage.put(key, JSON.parse(JSON.stringify({ roster: this.roster, meta: this.meta })));
      await this.pruneSnapshots();
    }
    this.meta.mutationSeq = (this.meta.mutationSeq || 0) + 1;
    this.meta.lastWriteAt = Date.now();
    await this.rebuildActive();
    await this.state.storage.put("roster", this.roster);
    await this.state.storage.put("meta", this.meta);
    return { ok: true, reason, v: tokenOf(this.meta), fp: this.meta.fingerprint, n: this.meta.n };
  }
  // Batch MLE rating for a placement log, then REGRESS toward the active median.
  // A placement is provisional (≈10 self-judged matchups, no other voters), so the
  // raw MLE runs hot — a near-sweep returns the range bound and vaults a newcomer
  // above the field. Shrink it like a chess/Glicko prelim: weight = n/(n+PRIOR),
  // so ~10 games ≈ 0.6 toward the fit and 0.4 toward the median. Live votes then
  // carry it the rest of the way. Bounded + clamped to the active range as before.
  fitPlacement(log) {
    const ratings = this.elo.r;
    const lo = Math.min(...ratings) - 400, hi = Math.max(...ratings) + 400;
    const fit = mleFit(log, lo, hi);
    const anchor = median(ratings);
    const PLACEMENT_PRIOR = 7;                          // pseudo-matchups pulling to median
    const shrink = log.length / (log.length + PLACEMENT_PRIOR);
    const r = anchor + shrink * (fit - anchor);
    return Math.max(Math.min(...ratings) - 50, Math.min(Math.max(...ratings) + 50, r));
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = request.method;
    // public
    if (m === "GET" && path === "/pair") return this.handlePair(url);
    if (m === "POST" && path === "/pick") return this.handlePick(request);
    if (m === "GET" && path === "/leaderboard") return this.handleLeaderboard();
    if (m === "GET" && path === "/meta") return this.handleMeta();
    if (m === "GET" && path === "/roster") return this.handleRoster();
    // admin
    if (m === "POST" && path === "/admin/reseed") return this.handleReseed(request);
    if (m === "GET" && path === "/admin/roster") return this.handleAdminRoster(request);
    if (m === "POST" && path === "/admin/hide") return this.handleHide(request, true);
    if (m === "POST" && path === "/admin/unhide") return this.handleHide(request, false);
    if (m === "POST" && path === "/admin/setrating") return this.handleSetRating(request);
    if (m === "POST" && path === "/admin/migrate") return this.handleMigrate(request);
    if (m === "GET" && path === "/admin/export") return this.handleExport(request);
    if (m === "POST" && path === "/admin/restore") return this.handleRestore(request);
    if (m === "GET" && path === "/admin/orphans") return this.handleOrphans(request);
    if (m === "POST" && path === "/admin/photo/claim") return this.handleClaim(request);
    if (m === "POST" && path === "/admin/photo/commit-done") return this.handleCommitDone(request);
    if (m === "POST" && path === "/admin/photo/cancel") return this.handleCancel(request);
    if (m === "POST" && path === "/admin/placement/start") return this.handlePlacementStart(request);
    if (m === "GET" && path === "/admin/placement/pair") return this.handlePlacementPair(request);
    if (m === "POST" && path === "/admin/placement/pick") return this.handlePlacementPick(request);
    if (m === "POST" && path === "/admin/placement/finish") return this.handlePlacementFinish(request);
    if (m === "POST" && path === "/admin/placement/publish") return this.handlePlacementPublish(request);
    if (m === "POST" && path === "/admin/placement/abandon") return this.handlePlacementAbandon(request);
    return json({ error: "not found" }, 404);
  }

  adminAuth(request) {
    if (!this.env.ADMIN_TOKEN) return { err: json({ error: "admin disabled (no ADMIN_TOKEN set)" }, 403) };
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    const now = Date.now();
    const rec = this._authFails.get(ip);
    if (rec && rec.until > now && rec.n >= 20) return { err: json({ error: "too many attempts; wait a few minutes" }, 429) };
    const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(tok, this.env.ADMIN_TOKEN)) {
      const r = (rec && rec.until > now) ? rec : { n: 0, until: now + 10 * 60 * 1000 };
      r.n++; this._authFails.set(ip, r);
      return { err: json({ error: "unauthorized" }, 401) };
    }
    if (rec) this._authFails.delete(ip);
    return { ok: true };
  }

  // ── sessions (in-memory, non-durable) ──
  session(sid) {
    sid = String(sid || "anon").slice(0, 64) || "anon";
    let s = this.sessions.get(sid);
    if (!s) {
      s = { seen: new Set(), last: Date.now() };
      this.sessions.set(sid, s);
      if (this.sessions.size > MAX_SESSIONS) this.evictSessions();
    }
    s.last = Date.now();
    return s;
  }
  evictSessions() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [k, v] of this.sessions) if (v.last < cutoff) this.sessions.delete(k);
    if (this.sessions.size > MAX_SESSIONS) {
      const arr = [...this.sessions.entries()].sort((a, b) => a[1].last - b[1].last);
      for (let i = 0; i < arr.length - MAX_SESSIONS; i++) this.sessions.delete(arr[i][0]);
    }
  }

  choosePair(sess) {
    const n = this.meta.n, r = this.elo.r, g = this.elo.g;
    let total = 0;
    for (let i = 0; i < n; i++) total += 1 / (g[i] + 1);
    let t = Math.random() * total, a = 0;
    for (let i = 0; i < n; i++) { t -= 1 / (g[i] + 1); if (t <= 0) { a = i; break; } a = i; }
    let b = -1, best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === a || sess.seen.has(pairKey(a, j))) continue;
      const d = Math.abs(r[a] - r[j]);
      if (d < best) { best = d; b = j; }
    }
    if (b < 0) { sess.seen.clear(); do { b = Math.floor(Math.random() * n); } while (b === a); }
    return [a, b];
  }

  handlePair(url) {
    if (this.meta.n < 2) return json({ error: "set too small" }, 409);
    const sess = this.session(url.searchParams.get("sid"));
    const [a, b] = this.choosePair(sess);
    sess.seen.add(pairKey(a, b));
    if (sess.seen.size > MAX_SEEN_PER_SESSION) sess.seen.clear();
    return json({ a, b, v: tokenOf(this.meta) });
  }

  async handlePick(request) {
    let data;
    try { data = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    return this.state.blockConcurrencyWhile(async () => {
      const n = this.meta.n;
      const pickId = String(data.pickId || "").slice(0, 64);
      if (pickId && this.seen.has(pickId)) {
        return json({ ok: true, applied: false, totalPicks: this.meta.totalPicks });
      }
      if (data.fp !== this.meta.fingerprint || String(data.v) !== tokenOf(this.meta)) {
        return json({ error: "set changed; reload", v: tokenOf(this.meta), fp: this.meta.fingerprint }, 409);
      }
      const win = data.winner, los = data.loser;
      if (!Number.isInteger(win) || !Number.isInteger(los) ||
          win < 0 || los < 0 || win >= n || los >= n || win === los) {
        return json({ error: "bad pick" }, 400);
      }
      const r = this.elo.r;
      const ew = expected(r[win], r[los]);
      const rWin = r[win] + K * (1 - ew);
      const rLos = r[los] - K * (1 - ew);
      if (!Number.isFinite(rWin) || !Number.isFinite(rLos)) return json({ error: "non-finite result" }, 400);
      r[win] = rWin; r[los] = rLos;
      this.elo.w[win]++; this.elo.l[los]++;
      this.elo.g[win]++; this.elo.g[los]++;
      this.meta.totalPicks++;
      this.meta.lastWriteAt = Date.now();
      if (pickId) this.seen.set(pickId, Date.now());

      const dev = String(data.device || "").slice(0, 64);
      const nm = String(data.name || "").trim().slice(0, 40);
      if (dev && nm) {
        const c = this.meta.contrib[dev] || { name: nm, n: 0 };
        c.n++; c.name = nm;
        this.meta.contrib[dev] = c;
        const keys = Object.keys(this.meta.contrib);
        if (keys.length > MAX_CONTRIB) {
          let drop = null, min = Infinity;
          for (const k of keys) { if (k === dev) continue; if (this.meta.contrib[k].n < min) { min = this.meta.contrib[k].n; drop = k; } }
          if (drop) delete this.meta.contrib[drop];
        }
      }
      this.session(data.sid).seen.add(pairKey(win, los));

      this.writeBackElo(win, los);
      await this.state.storage.put("roster", this.roster);
      await this.state.storage.put("meta", this.meta);
      await this.persistSeen();
      return json({ ok: true, applied: true, totalPicks: this.meta.totalPicks });
    });
  }

  async persistSeen() {
    const cutoff = Date.now() - IDEMP_TTL_MS;
    for (const [k, ts] of this.seen) if (ts < cutoff) this.seen.delete(k);
    await this.state.storage.put("seen", [...this.seen.entries()]);
  }

  handleLeaderboard() {
    const n = this.meta.n, e = this.elo, names = this.meta.names;
    const rows = [];
    for (let c = 0; c < n; c++) rows.push({ cidx: c, name: names[c], _r: e.r[c], elo: Math.round(e.r[c]), w: e.w[c], l: e.l[c], g: e.g[c] });
    rows.sort((a, b) => b._r - a._r || b.w - a.w || a.l - b.l);
    rows.forEach((row) => { delete row._r; });
    const contributors = Object.values(this.meta.contrib || {})
      .filter((c) => c.name).map((c) => ({ name: c.name, n: c.n })).sort((a, b) => b.n - a.n);
    return json({
      ok: true, v: tokenOf(this.meta), fp: this.meta.fingerprint, n,
      totalPicks: this.meta.totalPicks, updatedAt: this.meta.lastWriteAt, contributors, rows,
    });
  }

  handleMeta() {
    return json({ ok: true, v: tokenOf(this.meta), fp: this.meta.fingerprint, n: this.meta.n, totalPicks: this.meta.totalPicks });
  }
  // Public: the live page boots off this (active roster only; NO Elo).
  handleRoster() {
    return json({ ok: true, v: tokenOf(this.meta), fp: this.meta.fingerprint, n: this.meta.n, names: this.meta.names });
  }

  // ── admin: roster views + management ──
  handleAdminRoster(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    const active = [], hidden = [], pending = [];
    for (const p of this.roster.photos) {
      if (p.status === "active") active.push({ name: p.name, elo: Math.round(p.r), w: p.w, l: p.l, g: p.g });
      else if (p.status === "hidden") hidden.push({ name: p.name, elo: Math.round(p.r), w: p.w, l: p.l, g: p.g, hiddenAt: p.hiddenAt });
      else pending.push({ name: p.name, elo: Math.round(p.r), addedAt: p.addedAt, committed: !!p.committed });
    }
    return json({ ok: true, v: tokenOf(this.meta), fp: this.meta.fingerprint, n: this.meta.n, active, hidden, pending, placement: this.meta.placement || null });
  }

  async handleHide(request, hide) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const fn = String(body.filename || "");
    return this.state.blockConcurrencyWhile(async () => {
      const p = this.roster.photos.find((x) => x.name === fn);
      if (!p) return json({ error: "unknown photo" }, 404);
      if (hide) {
        if (p.status === "pending") return json({ error: "cannot hide a pending photo" }, 409);
        if (this.meta.placement && this.meta.placement.file === fn) return json({ error: "photo is in placement" }, 409);
        if (p.status === "hidden") return json({ ok: true, applied: false, n: this.meta.n, fp: this.meta.fingerprint, v: tokenOf(this.meta) });
        const activeCount = this.roster.photos.filter((x) => x.status === "active").length;
        if (activeCount - 1 < 2) return json({ error: "would leave fewer than 2 active photos" }, 409);
        p.status = "hidden"; p.hiddenAt = Date.now();
      } else {
        if (p.status !== "hidden") return json({ ok: true, applied: false, n: this.meta.n, fp: this.meta.fingerprint, v: tokenOf(this.meta) });
        p.status = "active"; delete p.hiddenAt;
      }
      const res = await this._applyRosterChange(hide ? "hide" : "unhide", { snapshot: false });
      return json({ ok: true, applied: true, n: res.n, fp: res.fp, v: res.v });
    });
  }

  // Manual Elo override — correct a mis-placed photo (e.g. a placement that ran hot).
  // Works on active OR hidden photos; pending ones must be placed first. Snapshots so
  // the change is restorable, and bumps the version token so live clients reload.
  async handleSetRating(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const fn = String(body.filename || "");
    const elo = Number(body.elo);
    if (!Number.isFinite(elo)) return json({ error: "elo must be a finite number" }, 400);
    const clamped = Math.max(0, Math.min(4000, Math.round(elo)));
    return this.state.blockConcurrencyWhile(async () => {
      const p = this.roster.photos.find((x) => x.name === fn);
      if (!p) return json({ error: "unknown photo" }, 404);
      if (p.status === "pending") return json({ error: "cannot set Elo on a pending photo; place it first" }, 409);
      const prev = Math.round(p.r);
      p.r = clamped;
      const res = await this._applyRosterChange("setrating", { snapshot: true });
      return json({ ok: true, filename: fn, elo: clamped, prev, n: res.n, fp: res.fp, v: res.v });
    });
  }

  async handleMigrate(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    return this.state.blockConcurrencyWhile(async () => {
      if (this.meta.schemaV >= 2 && this.roster) return json({ ok: true, migrated: false, n: this.meta.n, fp: this.meta.fingerprint });
      if (this.meta.schemaV < 2) { if (!(await this.migrateV1toV2())) return json({ error: "migration failed" }, 500); }
      else if (!this.roster && this.elo) { this.synthRosterFromElo(); }
      await this.rebuildActive();
      await this.state.storage.put("roster", this.roster);
      await this.state.storage.put("meta", this.meta);
      return json({ ok: true, migrated: true, n: this.meta.n, fp: this.meta.fingerprint });
    });
  }

  async handleExport(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    return json({ ok: true, roster: this.roster, meta: this.meta, elo: (await this.state.storage.get("elo")) || null });
  }

  async handleRestore(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const key = String(body.snapshotKey || "");
    return this.state.blockConcurrencyWhile(async () => {
      const snap = await this.state.storage.get(key);
      if (!snap || !snap.roster || !snap.meta) return json({ error: "snapshot not found" }, 404);
      // Preserve LIVE counters and force the version token strictly forward, so a
      // restore never rolls back totalPicks/contrib or collides with a token that
      // stale clients still hold (which would wrongly accept their picks).
      const liveSeq = this.meta.mutationSeq || 0;
      const livePicks = this.meta.totalPicks;
      const liveContrib = this.meta.contrib;
      this.roster = JSON.parse(JSON.stringify(snap.roster));
      this.meta = JSON.parse(JSON.stringify(snap.meta));
      this.meta.mutationSeq = Math.max(liveSeq, this.meta.mutationSeq || 0); // _applyRosterChange bumps to +1
      this.meta.totalPicks = livePicks;
      this.meta.contrib = liveContrib;
      const res = await this._applyRosterChange("restore", { snapshot: false });
      return json({ ok: true, n: res.n, fp: res.fp, v: res.v });
    });
  }

  handleOrphans(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    const cutoff = Date.now() - ORPHAN_AGE_MS;
    const pending = this.roster.photos
      .filter((p) => p.status === "pending" && (p.addedAt || 0) < cutoff)
      .map((p) => ({ name: p.name, addedAt: p.addedAt, committed: !!p.committed }));
    return json({ ok: true, pending });
  }

  // ── add-photo: claim (reserve filename) / commit-done (mark committed) / cancel ──
  async handleClaim(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const uploadId = String(body.uploadId || "").slice(0, 64);
    if (!uploadId) return json({ error: "uploadId required" }, 400);
    const ext = ALLOWED_MIME[String(body.mime || "")];
    if (!ext) return json({ error: "bad mime" }, 400);
    return this.state.blockConcurrencyWhile(async () => {
      const existing = this.roster.photos.find((p) => p.uploadId === uploadId);
      if (existing) return json({ ok: true, filename: existing.name, startElo: Math.round(existing.r) });
      if (this.roster.photos.filter((p) => p.status === "active").length >= MAX_ACTIVE) return json({ error: "set is full" }, 409);
      const startElo = Math.round(median(this.elo.r));
      let base = "add-" + Date.now().toString(36) + "-" + uploadId.replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase();
      const hint = slugForName(body.hint || "");
      if (hint) base += "-" + hint;
      let filename = base + "." + ext, k = 1;
      while (this.roster.photos.some((p) => p.name === filename)) filename = base + "-" + (k++) + "." + ext;
      insertSorted(this.roster.photos, { name: filename, status: "pending", r: startElo, g: 0, w: 0, l: 0, addedAt: Date.now(), uploadId, committed: false });
      await this.state.storage.put("roster", this.roster);
      return json({ ok: true, filename, startElo });
    });
  }

  async handleCommitDone(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const fn = String(body.filename || ""), uid = String(body.uploadId || "");
    return this.state.blockConcurrencyWhile(async () => {
      const p = this.roster.photos.find((x) => x.name === fn && x.uploadId === uid);
      if (!p) return json({ error: "unknown pending photo" }, 404);
      p.committed = true;
      if (body.commitSha) p.commitSha = String(body.commitSha).slice(0, 64);
      await this.state.storage.put("roster", this.roster);
      return json({ ok: true, status: "pending" });
    });
  }

  async handleCancel(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const fn = String(body.filename || "");
    return this.state.blockConcurrencyWhile(async () => {
      const i = this.roster.photos.findIndex((x) => x.name === fn);
      if (i < 0) return json({ error: "unknown photo" }, 404);
      if (this.roster.photos[i].status !== "pending") return json({ error: "can only cancel a pending photo" }, 409);
      if (this.meta.placement && this.meta.placement.file === fn) {
        await this.state.storage.delete("placement"); this.placement = null; this.meta.placement = null;
      }
      this.roster.photos.splice(i, 1);
      await this.state.storage.put("roster", this.roster);
      await this.state.storage.put("meta", this.meta);
      return json({ ok: true });
    });
  }

  // ── placement session (admin rates the newcomer vs N actives) ──
  async handlePlacementStart(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    const file = String(body.file || "");
    return this.state.blockConcurrencyWhile(async () => {
      if (this.placement) return json({ error: "a placement is already in progress", file: this.placement.file }, 409);
      const p = this.roster.photos.find((x) => x.name === file);
      if (!p || p.status !== "pending") return json({ error: "not a pending photo" }, 404);
      if (!p.committed) return json({ error: "photo image not committed yet" }, 409);
      const active = this.roster.photos.filter((x) => x.status === "active");
      if (active.length < 3) return json({ error: "need at least 3 active photos to place against" }, 409);
      const startRating = Math.round(median(active.map((x) => x.r)));
      let targetN = Number(body.targetN) || 10;
      targetN = Math.max(5, Math.min(30, Math.min(targetN, active.length)));
      const oppSnapshot = {};
      for (const x of active) oppSnapshot[x.name] = x.r;
      const oppList = selectOpponents(active, startRating, targetN);
      this.placement = {
        schemaV: 1, file, startedAt: Date.now(), startV: tokenOf(this.meta),
        r: startRating, targetN: oppList.length, oppSnapshot, oppList, log: [], curPair: null, ready: false,
      };
      this.meta.placement = { file };
      await this.state.storage.put("placement", this.placement);
      await this.state.storage.put("meta", this.meta);
      return json({ ok: true, file, startRating, targetN: oppList.length, n: active.length });
    });
  }

  async handlePlacementPair(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    return this.state.blockConcurrencyWhile(async () => {
      const pl = this.placement;
      if (!pl) return json({ error: "no placement in progress" }, 409);
      if (pl.startV !== tokenOf(this.meta)) return json({ error: "set changed; restart placement" }, 409);
      if (pl.curPair) {
        return json({ ok: true, file: pl.file, aName: pl.file, bName: pl.curPair.oName, token: pl.curPair.token, game: pl.log.length + 1, targetN: pl.targetN, done: false, log: pl.log });
      }
      const idx = pl.log.length;
      if (idx >= pl.oppList.length) return json({ ok: true, file: pl.file, done: true, game: idx, targetN: pl.targetN, log: pl.log });
      const oName = pl.oppList[idx], token = crypto.randomUUID();
      pl.curPair = { oName, token };
      await this.state.storage.put("placement", pl);
      return json({ ok: true, file: pl.file, aName: pl.file, bName: oName, token, game: idx + 1, targetN: pl.targetN, done: false, log: pl.log });
    });
  }

  async handlePlacementPick(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    return this.state.blockConcurrencyWhile(async () => {
      const pl = this.placement;
      if (!pl) return json({ error: "no placement" }, 409);
      if (pl.startV !== tokenOf(this.meta)) return json({ error: "set changed; restart placement" }, 409);
      const done = () => pl.log.length >= pl.oppList.length;
      if (!pl.curPair) return json({ ok: true, games: pl.log.length, targetN: pl.targetN, done: done() });
      if (String(body.token || "") !== pl.curPair.token) return json({ ok: true, games: pl.log.length, targetN: pl.targetN, done: done() });
      const oName = pl.curPair.oName;
      pl.log.push({ oName, oR: pl.oppSnapshot[oName], win: !!body.newcomerWon, ts: Date.now() });
      pl.curPair = null;
      pl.ready = false; // a new pick invalidates any earlier finish/fit
      await this.state.storage.put("placement", pl);
      return json({ ok: true, games: pl.log.length, targetN: pl.targetN, done: done() });
    });
  }

  async handlePlacementFinish(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    return this.state.blockConcurrencyWhile(async () => {
      const pl = this.placement;
      if (!pl) return json({ error: "no placement" }, 409);
      if (pl.startV !== tokenOf(this.meta)) return json({ error: "set changed; restart placement" }, 409);
      if (String(body.confirm || "") !== pl.file) return json({ error: "confirm must equal the filename" }, 409);
      if (pl.log.length < 3) return json({ error: "need at least 3 placement picks" }, 409);
      const r = this.fitPlacement(pl.log);
      if (!Number.isFinite(r)) return json({ error: "non-finite fit" }, 500);
      pl.r = Math.round(r); pl.ready = true;
      await this.state.storage.put("placement", pl);
      return json({ ok: true, rating: pl.r, games: pl.log.length });
    });
  }

  async handlePlacementPublish(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    return this.state.blockConcurrencyWhile(async () => {
      const pl = this.placement;
      const confirm = String(body.confirm || "");
      if (!pl) {
        // Idempotent retry: if this file is already active, the publish succeeded.
        const done = this.roster.photos.find((x) => x.name === confirm && x.status === "active");
        if (done) return json({ ok: true, n: this.meta.n, fp: this.meta.fingerprint, v: tokenOf(this.meta), rating: Math.round(done.r), replayed: true });
        return json({ error: "no placement" }, 409);
      }
      if (pl.startV !== tokenOf(this.meta)) return json({ error: "set changed; restart placement" }, 409);
      if (confirm !== pl.file) return json({ error: "confirm must equal the filename" }, 409);
      if (!pl.ready) return json({ error: "call finish first" }, 409);
      const p = this.roster.photos.find((x) => x.name === pl.file);
      if (!p) return json({ error: "photo vanished" }, 404);
      if (!p.committed) return json({ error: "photo not committed" }, 409);
      // Recompute the fit from the FULL log (don't trust pl.r — more picks may have
      // arrived after finish), with the same active-rating bounds + finite guard.
      const fit = this.fitPlacement(pl.log);
      if (!Number.isFinite(fit)) return json({ error: "non-finite fit" }, 500);
      p.status = "active"; p.r = Math.round(fit); p.g = Math.round(median(this.elo.g)); p.w = 0; p.l = 0;
      await this.state.storage.delete("placement");
      this.placement = null; this.meta.placement = null;
      const res = await this._applyRosterChange("placement-publish", { snapshot: true });
      return json({ ok: true, n: res.n, fp: res.fp, v: res.v, rating: p.r });
    });
  }

  async handlePlacementAbandon(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    return this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.delete("placement");
      this.placement = null;
      if (this.meta.placement) { this.meta.placement = null; await this.state.storage.put("meta", this.meta); }
      return json({ ok: true });
    });
  }

  // ── admin: reseed known photos to the baked SEED baseline (roster-as-spine) ──
  async handleReseed(request) {
    const a = this.adminAuth(request); if (a.err) return a.err;
    let body; try { body = await request.json(); } catch (e) { body = {}; }
    return this.state.blockConcurrencyWhile(async () => {
      if (String(body.confirm || "") !== tokenOf(this.meta)) {
        return json({ error: "confirm must equal current version token", v: tokenOf(this.meta) }, 409);
      }
      const seedIdx = new Map(SEED.names.map((nm, i) => [nm, i]));
      let carried = 0, fresh = 0;
      for (const p of this.roster.photos) {
        if (p.status !== "active") continue; // leave hidden/pending photos' Elo intact
        const si = seedIdx.get(p.name);
        if (si != null) { p.r = SEED.r[si]; p.g = 0; p.w = 0; p.l = 0; carried++; }
        else fresh++;
      }
      this.meta.seedV = SEED.version;
      const res = await this._applyRosterChange("reseed", { snapshot: true });
      return json({ ok: true, v: res.v, fp: res.fp, n: res.n, carried, kept: fresh });
    });
  }

  async pruneSnapshots() {
    const keys = [...(await this.state.storage.list({ prefix: "snapshot:" })).keys()];
    if (keys.length > MAX_SNAPSHOTS) {
      keys.sort((a, b) => Number(a.split(":")[2] || 0) - Number(b.split(":")[2] || 0)); // by timestamp
      for (let i = 0; i < keys.length - MAX_SNAPSHOTS; i++) await this.state.storage.delete(keys[i]);
    }
  }
}
