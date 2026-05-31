# Shared photo sets

Each **subfolder** in here is a rankable photo set. To add one:

1. Drop a folder of images in here, e.g. `sets/beach-2026/` with your `.jpg`/`.png`/`.webp` files.
2. Commit & push (or ask Claude to). GitHub Pages serves the images; the app discovers
   the filenames automatically via the GitHub API — **no manifest to maintain**.
3. Share the link: `https://chazlambo.github.io/photo-tourney/?set=beach-2026`
   (the folder name is the `?set=` value).

Friends open the link, enter their name, and rank the set. **When anyone finishes, their
ranking saves automatically** to `results/<set>/<name>.json` (via the Cloudflare Worker —
see `../worker/README.md`). Nobody sends or pastes anything. View everyone's rankings plus
the combined order in the **Combine** view.

Entry points:
- The home screen's **"Rank a shared set →"** button lists every set here to pick from
  (equivalent to `?browse`).
- `?set=NAME` — rank a set directly (this is the link you send friends).
- `?set=NAME&results` — the Combine/results view for a set.

Managing results: each person's ranking is a file in `results/<set>/`. To remove one,
delete its file in the repo (only you can — the write token lives in the Worker, not in
anyone's browser). Share/combine controls only ever appear for shared sets — someone who
just ranks their own uploaded photos locally sees no sharing option.

Notes:
- Folder names become the share id and may contain spaces (e.g. `Charlie Nature Photos`);
  just avoid slashes. Each ranker enters a name and gets one entry per device, so two
  different people with the same name don't overwrite each other.
- `sample/` is a demo set; delete it whenever you like.
