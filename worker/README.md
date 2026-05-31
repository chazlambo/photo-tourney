# Results endpoint (Cloudflare Worker)

This tiny Worker lets the site **auto-save every finished ranking** to the repo
(`results/<set>/<name>.json`) with no action from anyone. It holds the GitHub
write token as a **server-side secret**, so the credential is never exposed to
browsers and only this endpoint can write. You manage results by deleting files
in the repo. Free tier covers this many times over.

## One-time setup (~5 minutes)

1. **Create a GitHub token** (do NOT paste it into the site or share it):
   GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new.
   - Resource owner: `chazlambo` · Repository access: **Only** `photo-tourney`
   - Repository permissions → **Contents: Read and write**
   - Generate and copy it (you'll paste it into Cloudflare, below).

2. **Create the Worker:**
   - Sign in at <https://dash.cloudflare.com> (free account).
   - **Workers & Pages → Create application → Create Worker** → name it
     `photo-tourney-results` → **Deploy** (deploys a placeholder).
   - **Edit code** → delete the template → paste the contents of
     `results-worker.js` → **Deploy**.

3. **Add the secret:**
   - Worker → **Settings → Variables and Secrets → Add**:
     - Type **Secret**, name `GH_TOKEN`, value = the token from step 1. Save.
   - (Optional) add plain variables `REPO` = `chazlambo/photo-tourney` and
     `ALLOWED_ORIGIN` = `https://chazlambo.github.io` (these are the defaults).

4. **Copy the Worker URL** (looks like
   `https://photo-tourney-results.<your-subdomain>.workers.dev`) and send it to
   Claude. The **URL is safe to share**; the **token is not**.

That's it. Once the site is pointed at the URL, finishing a ranking POSTs it
here and a `results/<set>/<name>.json` commit appears in the repo automatically.

## Notes
- Writes are only accepted for sets that actually exist (`sets/<set>/`), and the
  payload is validated (name length, order size/values). The token never leaves
  the Worker.
- Each save is one commit (a normal Pages rebuild) — fine for typical use.
- To remove a result, delete its file in `results/<set>/`.
