# 📷 Photo Tournament

A tiny, zero-dependency, mobile-friendly website that **ranks a set of photos by
pairwise comparison**. It shows you two photos at a time, you tap the one you prefer,
and it builds a full ranking — champion first — from your choices.

Everything happens **locally in your browser**. Your photos are never uploaded to a
server, which also makes it a perfect fit for static hosting like GitHub Pages.

## How it works

- Add up to **256** photos by dragging them onto the page (or tap to browse).
- Pick a **thoroughness** — Quick / Balanced / Thorough — which sets how many rounds
  (roughly how many matchups each photo plays). The page shows a live estimate of how
  many picks that means, so there are no surprises.
- Photos are ranked with an **adaptive Elo rating**: the winner of each matchup gains
  rating and the loser drops, and each round pairs photos with the **closest ratings
  that haven't met yet** — so every pick is informative and rematches are avoided.
  Continuous ratings mean a (near) tie-free ranking.
- Comparisons happen on a full-bleed black **stage** — both photos share one seamless
  canvas (no cards or borders). Selection feedback is purely a frame + a checkmark pop
  (never any dimming or colour shift), so the photos' true look is never altered while
  you judge them. Tap a photo to pick it (or press <kbd>1</kbd>/<kbd>←</kbd> and
  <kbd>2</kbd>/<kbd>→</kbd> on desktop). <kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd> or **Undo**
  reverts a pick. Hit **Fullscreen** (or press <kbd>F</kbd>) to make the images as
  large as possible.
- **Finish & rank** ends whenever you like and shows the ranking; **Refine further**
  adds more rounds to sharpen it. Each photo shows its win–loss record, champion in gold.

## Run it locally

Just open `index.html` in a browser. (No build step, no install.) If your browser is
fussy about local files, serve the folder:

```bash
# Python
python -m http.server 8000
# then visit http://localhost:8000
```

## Shared sets (let friends rank the same photos)

Besides ranking your own local photos, you can publish a **shared set** that anyone
can rank from a link, with results saved automatically.

1. Drop a folder of images into `sets/`, e.g. `sets/beach-2026/`, and push.
2. Share `…/?set=beach-2026`. Each person opens it, enters their name, and ranks it
   (images load from the repo; filenames are discovered at runtime via the GitHub API —
   no manifest to maintain).
3. **When anyone finishes, their ranking is saved automatically** as
   `results/beach-2026/<name>.json` in the repo — nobody sends or pastes anything.
4. Open the **Combine** view (the *View combined results* button, or
   `…/?set=beach-2026&results`) to see every person's ranking (pick a name from the
   dropdown) plus the **combined ranking** (Borda count).

The home screen has a **"Rank a shared set →"** button that lists every set in the repo
to pick from (same as `…/?browse`). **Share/combine controls only ever appear for shared
sets** — someone who just uploads their own photos and ranks them locally sees no sharing
option at all. Only you can create sets (only you can commit to the repo). Note: a shared
set's images **and results** live in the **public** repo.

### How auto-save works (the Cloudflare Worker)

A static site can't write to its own repo, so a tiny **Cloudflare Worker** holds the
GitHub write token as a server-side secret and commits each finished ranking for you.
Set it up once — see **`worker/README.md`** — then point `WORKER_URL` in `app.js` at it.

- Finishing a ranking POSTs `{set, name, ranking}` to the Worker, which writes
  `results/<set>/<name>.json`. The token is **never** in any browser.
- **Only the Worker can write; only you can delete** — remove a result by deleting its
  file in `results/<set>/`. Re-submitting the same name updates that person's file.
- The Combine view reads these files, so results are durable and show on any device.
- Each save is one commit (a normal Pages rebuild) — fine for typical use.

## Deploy to GitHub Pages

1. Create a repo and push these files:
   ```bash
   git init
   git add .
   git commit -m "Photo Tournament"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Build and deployment**.
3. Set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`, and save.
4. Your site goes live at `https://<you>.github.io/<repo>/` within a minute or two.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure and screens (upload / set-intro / match / results / browse / combine). |
| `style.css` | Styling (dark theme, immersive stage, responsive). |
| `app.js` | Ranking engine, local + shared-set modes, persistence, sharing/combine, rendering. |
| `sets/` | Shared photo sets (one folder per set) — see `sets/README.md`. |

## Notes & limits

- Progress is **saved in your browser (IndexedDB)** — photos, ratings, and the current
  matchup all survive a reload or accidental refresh, and you resume right where you
  left off. "New set" clears the saved data. (The undo history is not persisted, so
  Undo is unavailable immediately after a reload.) It's per-browser/per-device — there
  is no cloud sync.
- Works with any number of photos from 2 to 256; odd counts are handled with byes.
- A perfectly tie-free *total* order would need ~N·log₂N comparisons (~1,700 for 256).
  The Elo approach trades a little precision for far fewer picks and a stop-anytime
  ranking; raise the thoroughness (or "Refine further") for a sharper result.
