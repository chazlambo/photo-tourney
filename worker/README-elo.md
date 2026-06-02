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
- The DO is the **live source of truth for the roster** — which photos are
  `active` / `hidden` / `pending`, their Elo, and the fingerprint. `live.js` reads
  the active roster from `GET /roster` (it no longer lists GitHub), so the page and
  server can't disagree.
- A 16-hex **fingerprint** of the active filenames + a `seedV#mutationSeq` version
  token are checked on every pick (and the page re-pulls the roster automatically
  on a `409`), so hiding/adding a photo can never silently mis-apply a vote.

## Endpoints

Public (no Elo while ranking):

| Method | Path | Returns | Notes |
| --- | --- | --- | --- |
| `GET` | `/roster` | `{v, fp, n, names:[active]}` | The page boots off this. |
| `GET` | `/pair?sid=…` | `{a, b, v}` (photo ids) | Adaptive: least-played × nearest-rating, avoids session rematches. |
| `POST` | `/pick` | `{ok, applied, totalPicks}` | Body `{sid, winner, loser, pickId, fp, v, device, name}`. Idempotent on `pickId`; `409` if `fp`/`v` stale. |
| `GET` | `/leaderboard` | `{rows:[{cidx,name,elo,w,l,g}], contributors, …}` | The **only** public Elo surface. |
| `GET` | `/meta` | `{v, fp, n, totalPicks}` | Diagnostic. |

Admin (all require `Authorization: Bearer <ADMIN_TOKEN>`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/roster` | List active / hidden / pending (also the login probe). |
| `POST` | `/admin/hide` · `/admin/unhide` | `{filename}` — soft hide / restore. |
| `POST` | `/admin/photo` | `{dataUrl, uploadId, filenameHint}` — upload an image (commits to the repo via `ELO_GH_TOKEN`, registers it `pending`). |
| `POST` | `/admin/placement/{start,pair,pick,finish,publish,abandon}` | Run the placement session, then publish the new photo live. |
| `POST` | `/admin/photo/cancel` | `{filename}` — drop a pending photo (image file stays). |
| `GET` | `/admin/orphans` | Pending photos older than 24h. |
| `POST` | `/admin/reseed` | `{confirm:"<current v token>"}` — reset known photos to seed baseline. |
| `POST` | `/admin/migrate` | One-time v1→v2 schema migration (idempotent). |
| `GET` | `/admin/export` · `POST /admin/restore` | Backup / snapshot restore. |

The admin UI is **`admin.html`** (standalone; enter the password = `ADMIN_TOKEN`).

## One-time setup

1. **Generate the seed** (from the repo root) and commit it:
   ```bash
   node scripts/build-seed.mjs        # writes worker/seed/seed.js
   ```

2. **Deploy the Worker + DO:**
   ```bash
   cd worker
   npx wrangler login                  # opens a browser once
   npx wrangler secret put ADMIN_TOKEN   # required for admin (hide/add); pick a long random string
   npx wrangler secret put ELO_GH_TOKEN  # only for ADDING photos: fine-grained PAT, Contents:R+W on the repo
   npx wrangler deploy                 # the [[migrations]] block creates the DO
   ```
   `ELO_GH_TOKEN` should be a **separate** fine-grained token from the results
   worker's `GH_TOKEN`, scoped to **only** `chazlambo/photo-tourney`, Contents
   Read+Write. Skip it if you never plan to add photos (hide still works).

3. **Migrate (one-time, only if the DO already had v1 data):** the new schema
   migrates automatically on the first request after deploy, but you can force it:
   ```bash
   curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" \
        https://photo-tourney-elo.<your-subdomain>.workers.dev/admin/migrate
   ```
   Confirm `GET /meta` still shows `fp` `39f981b934824afc` and `n` `138`.

4. **Wire the page to it:** ensure `ELO_WORKER_URL` (top of both `live.js` and
   `admin.js`) is your deployed URL, then commit.

5. **Verify:** open `…/live.html`, do a few picks, **See rankings**. Open
   `…/admin.html`, unlock with the password, try hiding/un-hiding a photo.

6. *(Optional)* add a Cloudflare **rate-limit rule** on `/admin/*` (managed
   challenge) and/or `/pick` to cap abuse at the edge.

## Managing photos (admin.html)

Open **`admin.html`**, enter the password (`ADMIN_TOKEN`):

- **Hide / un-hide** — instant and reversible; excludes a photo from pairings,
  the leaderboard, and the fingerprint. The image file stays in the repo.
- **Add a photo** — pick an image (≤ 8 MB, JPEG/PNG/WebP/AVIF). It's committed to
  `sets/charlie-nature-photos/` via `ELO_GH_TOKEN`, then you run a **placement
  session**: rate it head-to-head against ~10 existing photos. A batch
  maximum-likelihood fit (seeded at the active set's median) sets its starting Elo,
  and **Publish** makes it live for everyone. Newly published images can take ~60s
  to propagate on GitHub Pages — the Publish button load-checks first.

## Re-seeding / changing photos in bulk

`POST /admin/reseed` (with `confirm` = the current version token from `/meta`)
resets every photo whose filename is in `seed.js` back to its seed baseline rating,
**keeping** statuses (hidden stays hidden) and any admin-added photos. Snapshots of
the prior state (last 20 mutating ops) are kept in DO storage; restore via
`/admin/restore`. The seed itself is only a bootstrap — live admin edits are never
written back to `seed.js`.

## Notes & limits

- Free tier covers this comfortably: one DO, a ~138-entry blob, a few storage
  writes per pick. Images are served straight from GitHub Pages (not proxied), so
  the Worker only handles small JSON.
- Ranking is open (no login): the only asset is "Elo stays roughly honest."
  Mitigations are proportionate — input validation, idempotency, a non-finite
  guard, and an optional edge rate-limit. Admin actions are gated by `ADMIN_TOKEN`
  (timing-safe compare, best-effort attempt throttle).
- **Never shard** the DO — a single instance is what gives global consistency.
- **Treat the DO storage as precious.** Deleting/recreating the DO (or renaming
  `SET`) re-bootstraps from the stale seed — resurrecting hidden photos, dropping
  added ones, and losing accumulated votes. `GET /admin/export` is your backup.
