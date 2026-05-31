/**
 * Photo Tournament — results endpoint (Cloudflare Worker).
 *
 * Receives a finished ranking from the site and commits it to the repo as
 *   results/<set>/<name>.json
 * using a GitHub token that lives ONLY here as a server-side secret — it is
 * never sent to any browser. Friends' results save automatically on finish;
 * nobody sends links or clicks anything. You manage results by deleting files
 * in the repo.
 *
 * Required secret (Cloudflare → Worker → Settings → Variables and Secrets):
 *   GH_TOKEN  — a GitHub fine-grained token with Contents: Read and write on the repo
 * Optional plain vars (defaults below are fine):
 *   REPO            = "chazlambo/photo-tourney"
 *   ALLOWED_ORIGIN  = "https://chazlambo.github.io"
 */

const DEFAULTS = {
  REPO: "chazlambo/photo-tourney",
  ALLOWED_ORIGIN: "https://chazlambo.github.io",
};
const RESULTS_DIR = "results";
const MAX_PHOTOS = 256;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
function slugForName(name) {
  const base = String(name || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "anon";
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return base.slice(0, 32) + "-" + h.toString(16).slice(0, 6);
}
function b64(str) { return btoa(unescape(encodeURIComponent(str))); }

export default {
  async fetch(request, env) {
    const ORIGIN = env.ALLOWED_ORIGIN || DEFAULTS.ALLOWED_ORIGIN;
    const REPO = env.REPO || DEFAULTS.REPO;
    const cors = corsHeaders(ORIGIN);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!env.GH_TOKEN) return json({ error: "server not configured (missing GH_TOKEN)" }, 500, cors);

    let data;
    try { data = await request.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }

    // ── validate the submission ──
    const set = String(data.set || "").trim();
    const name = (String(data.name || "Anonymous").trim().slice(0, 40)) || "Anonymous";
    const order = Array.isArray(data.order) ? data.order : null;
    const count = Number(data.count) || (order ? order.length : 0);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(set)) return json({ error: "bad set name" }, 400, cors);
    if (!order || order.length === 0 || order.length > MAX_PHOTOS) return json({ error: "bad order" }, 400, cors);
    if (!order.every((n) => Number.isInteger(n) && n >= 0 && n < MAX_PHOTOS)) {
      return json({ error: "bad order values" }, 400, cors);
    }
    // count must be sane and consistent with the order (no oversized count that
    // would make the combine view allocate a huge Borda array, and no indices
    // outside the ranked range).
    if (!Number.isInteger(count) || count < 2 || count > MAX_PHOTOS) {
      return json({ error: "bad count" }, 400, cors);
    }
    if (!order.every((n) => n < count)) {
      return json({ error: "order index out of range" }, 400, cors);
    }
    // No duplicate indices (a valid ranking lists each photo at most once).
    if (new Set(order).size !== order.length) {
      return json({ error: "duplicate order values" }, 400, cors);
    }

    const gh = {
      Authorization: "Bearer " + env.GH_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "photo-tourney-worker",
    };

    // Only allow writing results for a set that actually exists (anti-abuse).
    const setCheck = await fetch(
      `https://api.github.com/repos/${REPO}/contents/sets/${encodeURIComponent(set)}`,
      { headers: gh }
    );
    if (setCheck.status === 404) return json({ error: "unknown set" }, 400, cors);
    if (!setCheck.ok && setCheck.status !== 200) return json({ error: "set check failed" }, 502, cors);

    const path = `${RESULTS_DIR}/${set}/${slugForName(name)}.json`;
    const url = `https://api.github.com/repos/${REPO}/contents/` +
      path.split("/").map(encodeURIComponent).join("/");

    // Update in place if this name already submitted (need the current sha).
    let sha;
    const getRes = await fetch(url, { headers: gh });
    if (getRes.ok) sha = (await getRes.json()).sha;

    const body = {
      message: `result: ${name} for ${set}`,
      content: b64(JSON.stringify({ v: 1, s: set, n: name, c: count, o: order })),
      branch: "main",
    };
    if (sha) body.sha = sha;

    let put = await fetch(url, { method: "PUT", headers: gh, body: JSON.stringify(body) });
    // A 409 means the file's sha changed between our GET and PUT (a concurrent
    // submission under the same name). Re-read the current sha and try once more.
    if (put.status === 409) {
      const reGet = await fetch(url, { headers: gh });
      if (reGet.ok) body.sha = (await reGet.json()).sha;
      put = await fetch(url, { method: "PUT", headers: gh, body: JSON.stringify(body) });
    }
    if (!put.ok) return json({ error: "github write failed", status: put.status }, 502, cors);

    return json({ ok: true }, 200, cors);
  },
};
