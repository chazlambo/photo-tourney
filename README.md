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
- Tap a photo to pick it (or press <kbd>1</kbd>/<kbd>←</kbd> and <kbd>2</kbd>/<kbd>→</kbd>
  on desktop). <kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd> or **Undo** reverts a pick.
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
| `index.html` | Page structure and the three screens (upload / match / results). |
| `style.css` | Styling (dark theme, responsive). |
| `app.js` | Tournament logic, uploads, undo, and rendering. |

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
