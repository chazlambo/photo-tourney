/**
 * build-seed.mjs — compute the STARTING Elo for the living "charlie-nature-photos"
 * set from the five existing result files, and emit worker/seed/seed.js.
 *
 * Run once (offline) whenever the set's photos or the source results change:
 *     node scripts/build-seed.mjs
 *
 * Method (decided + adversarially reviewed): a per-photo WEIGHTED AVERAGE of each
 * rater's Elo, with weights Charles=4, Miranda=3, Charlie=2, Laurie=2, Maik=1.
 *  - Raters with stored per-photo Elo (st) use it directly.
 *  - Legacy raters (order `o` only) get a synthesized Elo from their rank order.
 *  - Each rater is normalized to mean 1000 with an EVIDENCE-PROPORTIONAL spread
 *    TARGET_SD = BASE_SD * sqrt(avgGames / maxAvgGames), so a low-data rater's
 *    noise can't masquerade as a high-data rater's signal — i.e. the weights mean
 *    what they're supposed to. (A fixed SD would inflate Maik's ~2.8-games-per-photo
 *    noise to parity with Charles's ~12.)
 *
 * The Durable Object NEVER reads GitHub at runtime — it bootstraps from this file.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── config ──────────────────────────────────────────────────────────────────
const SET = "charlie-nature-photos";
const SEED_VERSION = "2026-06-01a";        // bump on any deliberate re-seed
const MU = 1000;                            // == START_RATING (app.js:19)
const BASE_SD = 120;                        // spread of the max-evidence rater
const LEGACY_GAMES_PROXY = 6;               // a full 138-rank pass ≈ Laurie's 6-game evidence
const WEIGHTS = { charles: 4, miranda: 3, charlie: 2, laurie: 2, maik: 1 };

const RESULTS_DIR = join(ROOT, "results", SET);
const SETS_DIR = join(ROOT, "sets", SET);
const OUT_FILE = join(ROOT, "worker", "seed", "seed.js");

// Canonical filename ordering — KEEP IN SYNC with elo-worker.js sortCmp + app.js:629.
// Locale pinned to "en" so Node, Workers, and browsers agree byte-for-byte.
// NOTE: this seed is the DO's BOOTSTRAP only. Once deployed, the living roster is
// owned by the Durable Object (admin hides/adds); those edits are NOT written back
// here. Regenerating + reseeding resets known photos to these baseline ratings.
const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
function sortNames(names) {
  return names
    .filter((n) => IMG_RE.test(n))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

function die(msg) {
  console.error("build-seed: " + msg);
  process.exit(1);
}

// ── 1. discover the set's photos (cidx = position in this sorted list) ─────────
const names = sortNames(readdirSync(SETS_DIR));
const N = names.length;
if (N === 0) die(`no images found in ${SETS_DIR}`);
console.log(`Set "${SET}": ${N} photos.`);

const fingerprint = createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 16);

// ── 2. load + validate the five expected result files ─────────────────────────
// Map every result file by its embedded name (j.n), then assert that exactly the
// expected set of raters (the WEIGHTS keys) is present — fail loudly on surprise.
const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
const byName = new Map();
for (const f of files) {
  let j;
  try {
    j = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8"));
  } catch (e) {
    die(`cannot parse ${f}: ${e.message}`);
  }
  const key = String(j.n || "").trim().toLowerCase();
  if (!(key in WEIGHTS)) die(`unexpected rater "${j.n}" in ${f} (not in the weight map)`);
  if (byName.has(key)) die(`two files claim rater "${j.n}" (${f})`);
  byName.set(key, { file: f, j });
}
for (const key of Object.keys(WEIGHTS)) {
  if (!byName.has(key)) die(`missing expected rater "${key}" in ${RESULTS_DIR}`);
}

const isPermutation = (arr, n) => {
  if (!Array.isArray(arr) || arr.length !== n) return false;
  const seen = new Uint8Array(n);
  for (const x of arr) {
    if (!Number.isInteger(x) || x < 0 || x >= n || seen[x]) return false;
    seen[x] = 1;
  }
  return true;
};
const validSt = (st, n) =>
  Array.isArray(st) && st.length === n &&
  st.every((e) => Array.isArray(e) && e.length === 3 && e.every((x) => Number.isFinite(x)));

// ── 3. build each rater's raw value vector + its evidence (avgGames) ───────────
// raters[key] = { weight, value:[N], avgGames|null (null => legacy) }
const raters = {};
for (const [key, { file, j }] of byName) {
  if (j.c !== N) die(`${file}: count ${j.c} != set size ${N} (re-rank or rebuild)`);
  const weight = WEIGHTS[key];

  if (validSt(j.st, N)) {
    // Elo rater: value = stored per-photo Elo; evidence = mean games (wins+losses).
    const value = j.st.map((e) => e[2]);
    let totalGames = 0;
    for (const e of j.st) totalGames += e[0] + e[1];
    const avgGames = totalGames / N;
    raters[key] = { weight, value, avgGames };
    console.log(`  ${key.padEnd(8)} w=${weight}  st-rater   avgGames=${avgGames.toFixed(1)}`);
  } else {
    // Legacy rater: only an order `o` (best-first). Must be an exact permutation.
    if (!isPermutation(j.o, N)) die(`${file}: legacy result has no valid st and o is not a permutation of 0..${N - 1}`);
    const rankOf = new Array(N);
    j.o.forEach((cidx, rank) => { rankOf[cidx] = rank; });
    // Linear ramp centered on 0: best photo -> +(N-1)/2, worst -> -(N-1)/2.
    const value = new Array(N);
    for (let c = 0; c < N; c++) value[c] = (N - 1) / 2 - rankOf[c];
    raters[key] = { weight, value, avgGames: null };
    console.log(`  ${key.padEnd(8)} w=${weight}  legacy     (rank-order)`);
  }
}

// ── 4. evidence-proportional target SD per rater ──────────────────────────────
let maxAvgGames = 0;
for (const r of Object.values(raters)) if (r.avgGames != null) maxAvgGames = Math.max(maxAvgGames, r.avgGames);
if (maxAvgGames <= 0) die("no Elo rater with games found; cannot scale (need at least one st rater)");
const LEGACY_SD = BASE_SD * Math.sqrt(LEGACY_GAMES_PROXY / maxAvgGames);

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function popSd(a, m) {
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length;
  const sd = Math.sqrt(v);
  return sd > 0 ? sd : 1; // guard a degenerate (all-equal) vector
}

// ── 5. normalize each rater to (mean MU, target SD) ───────────────────────────
for (const [key, r] of Object.entries(raters)) {
  const targetSd = r.avgGames != null
    ? BASE_SD * Math.sqrt(r.avgGames / maxAvgGames)
    : LEGACY_SD;
  const m = mean(r.value);
  const sd = popSd(r.value, m);
  r.norm = r.value.map((x) => MU + ((x - m) / sd) * targetSd);
  console.log(`  ${key.padEnd(8)} targetSD=${targetSd.toFixed(1)}`);
}

// ── 6. weighted average per photo ─────────────────────────────────────────────
const totalWeight = Object.values(raters).reduce((s, r) => s + r.weight, 0);
const seed = new Array(N);
for (let c = 0; c < N; c++) {
  let acc = 0;
  for (const r of Object.values(raters)) acc += r.weight * r.norm[c];
  const v = Math.round(acc / totalWeight);
  if (!Number.isFinite(v)) die(`computed a non-finite seed for cidx ${c}`);
  seed[c] = v;
}

// ── 7. report + emit ──────────────────────────────────────────────────────────
const sMean = mean(seed);
const sSd = popSd(seed, sMean);
console.log(`Seed: min=${Math.min(...seed)} max=${Math.max(...seed)} mean=${sMean.toFixed(1)} sd=${sSd.toFixed(1)}`);
console.log(`Fingerprint: ${fingerprint}`);

const out =
`/**
 * GENERATED by scripts/build-seed.mjs — do not edit by hand.
 * Starting Elo for the living "${SET}" set (weighted blend of the source results).
 * Regenerate with:  node scripts/build-seed.mjs
 */
export const SEED = {
  version: ${JSON.stringify(SEED_VERSION)},
  set: ${JSON.stringify(SET)},
  n: ${N},
  fingerprint: ${JSON.stringify(fingerprint)},
  weights: ${JSON.stringify(WEIGHTS)},
  names: ${JSON.stringify(names)},
  r: ${JSON.stringify(seed)},
};
`;

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, out);
console.log(`Wrote ${OUT_FILE} (version ${SEED_VERSION}).`);
