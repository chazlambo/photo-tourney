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

The shared-sets UI is intentionally hidden from the normal local flow (someone who just
ranks their own uploaded photos sees no sharing/sets option). Reach it only via URLs:
- `?browse` — list every set in this folder (your owner entry point).
- `?set=NAME` — rank a set. `?set=NAME&results` — the Combine/results view for a set.
- `?import=CODE` — add a friend's pasted result and open that set's Combine view.

Notes:
- Folder names become the share id — keep them simple (lowercase, hyphens), no spaces.
- `sample/` is a demo set; delete it whenever you like.
