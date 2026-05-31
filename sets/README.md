# Shared photo sets

Each **subfolder** in here is a rankable photo set. To add one:

1. Drop a folder of images in here, e.g. `sets/beach-2026/` with your `.jpg`/`.png`/`.webp` files.
2. Commit & push (or ask Claude to). GitHub Pages serves the images; the app discovers
   the filenames automatically via the GitHub API — **no manifest to maintain**.
3. Share the link: `https://chazlambo.github.io/photo-tourney/?set=beach-2026`
   (the folder name is the `?set=` value).

Friends open the link, rank the set, and send you back a "result link". You collect
everyone's results in the **Combine** view (the *Results* button on the set screen, or
`?set=beach-2026&results`), which shows each person's ranking plus a combined ranking.

Entry points:
- The home screen's **"Rank a shared set →"** button lists every set here to pick from
  (equivalent to `?browse`).
- `?set=NAME` — rank a set directly (this is the link you send friends).
- `?set=NAME&results` — the Combine/results view for a set.
- `?import=CODE` — add a friend's pasted result and open that set's Combine view.

Share/combine controls only ever appear for shared sets — someone who just ranks their
own uploaded photos locally sees no sharing option.

Notes:
- Folder names become the share id — keep them simple (lowercase, hyphens), no spaces.
- `sample/` is a demo set; delete it whenever you like.
