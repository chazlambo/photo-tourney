# Living shared-Elo endpoint (Cloudflare Worker + Durable Object)

This backs **`live.html`** — the standalone page where anyone ranks the
`charlie-nature-photos` set into a single **global, living Elo**. Every pick
updates one shared rating immediately; rankers never see Elo, only the separate
(terminal) leaderboard does.

It is a **separate service** from the git-commit results worker
(`worker/results-worker.js`) and does not touch it, the main app, or any data in
`results/` or `sets/`.

> **Heads-up — this one needs the CLI.** Unlike `results-worker.js` (which you
> paste into the dashboard), a Durable Object requires a migration that only the
> **Wrangler CLI** can apply. There's still **no browser build step** — the page
> is plain static files. You'll need [Node.js](https://nodejs.org) installed.

## How it works

- One **Durable Object** (`SharedElo`, a single instance keyed by the set name) is
  the only writer. Each pick is applied inside `blockConcurrencyWhile`, so
  concurrent rankers can never lose an update. State is durable — an eviction or
  redeploy never resets the accumulated Elo.
- Starting Elo is **baked in** at `worker/seed/seed.js` (generated offline by
  `scripts/build-seed.mjs` from the five existing results, weighted
  Charles=4, Miranda=3, Charlie=2, Laurie=2, Maik=1). The DO bootstraps from it on
  first run and **never reads GitHub at runtime**.
- A 16-hex **fingerprint** of the set's sorted filenames is checked on every pick
  and on page load, so changing the set's photos can never silently corrupt Elo —
  it fails closed with `409 set changed; reload` until you re-seed.

## Endpoints

| Method | Path | Returns | Notes |
| --- | --- | --- | --- |
| `GET` | `/pair?sid=…` | `{a, b}` (photo ids) | No Elo. Adaptive: least-played × nearest-rating, avoids session rematches. |
| `POST` | `/pick` | `{ok, applied, totalPicks}` | Body `{sid, winner, loser, pickId, fp, v, device, name}`. No Elo. Idempotent on `pickId`. |
| `GET` | `/leaderboard` | `{rows:[{cidx,name,elo,w,l,g}], contributors, …}` | The **only** Elo surface. |
| `GET` | `/meta` | `{v, fp, n, totalPicks}` | No Elo. Page-load integrity gate. |
| `POST` | `/admin/reseed` | `{ok, carried, fresh, …}` | `Authorization: Bearer <ADMIN_TOKEN>`, body `{confirm:"<currentSeedV>"}`. |

## One-time setup

1. **Generate the seed** (from the repo root) and commit it:
   ```bash
   node scripts/build-seed.mjs        # writes worker/seed/seed.js
   ```

2. **Deploy the Worker + DO:**
   ```bash
   cd worker
   npx wrangler login                 # opens a browser once
   npx wrangler secret put ADMIN_TOKEN  # optional; pick any long random string
   npx wrangler deploy                # the [[migrations]] block creates the DO
   ```

3. **Wire the page to it:** copy the deployed URL
   (`https://photo-tourney-elo.<your-subdomain>.workers.dev`) into `ELO_WORKER_URL`
   at the top of `live.js`, then commit.

4. **Verify:** open `…/live.html`, do a few picks, then **See rankings**. Or hit
   `…/workers.dev/meta` and `…/workers.dev/leaderboard` directly.

5. *(Optional)* add one Cloudflare **WAF rate-limit rule** on `/pick` to cap
   volumetric abuse at the edge (no Durable Object cost).

## Changing the set's photos later

If you add/remove/rename photos in `sets/charlie-nature-photos/`:

```bash
# edit worker/seed/seed.js's version by bumping SEED_VERSION in build-seed.mjs first
node scripts/build-seed.mjs
cd worker && npx wrangler deploy
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" \
     -d '{"confirm":"<OLD seedV>"}' \
     https://photo-tourney-elo.<your-subdomain>.workers.dev/admin/reseed
```

Reseed **preserves living votes** for photos whose filename survived (joined by
name); only genuinely-new photos start from the fresh seed. The last 5 pre-reseed
states are snapshotted in DO storage.

## Notes & limits

- Free tier covers this comfortably: one DO, a ~138-entry blob, a few storage
  writes per pick. Images are served straight from GitHub Pages (not proxied), so
  the Worker only handles small JSON.
- No login: the only asset is "Elo stays roughly honest." Mitigations are
  proportionate — input validation, idempotency, a non-finite-result guard, and an
  optional edge rate-limit. A determined friend with rotating IPs can still nudge
  it; that's the accepted trade for an open, link-only page.
- **Never shard** the DO — a single instance is what gives global consistency.
