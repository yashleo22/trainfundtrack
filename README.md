# Train Fund Tracker

A free, static website to track per-train expenses vs. rent received, profit/loss,
and partner settlement. Hosted on **GitHub Pages**; saving is handled by a tiny
free **Cloudflare Worker** so the GitHub token and passwords never live in the
public code.

```
index.html      the app shell
styles.css      styling (light + dark)
app.js          all app logic
data.json       your data (edited through the app)
worker/         the Cloudflare Worker (login + save proxy)
  worker.js
  wrangler.toml
```

---

## How it works

- **Reads** are public: anyone can load the site; the data is read from the repo.
- **Writes** go through the Worker. You/Mohit log in with a password → the Worker
  checks it → the Worker commits `data.json` to the repo using a token it keeps
  **secretly on the server**. Nobody needs a GitHub account or a token in the browser.
- **Backups** are automatic: every save is a Git commit, so GitHub keeps the full
  version history. You can roll back anytime from the repo's commit history.

**Logins**
| User | Username | Password | Can do |
|------|----------|----------|--------|
| Admin | `admin` | `trainadmin2026` | Everything: trains, both receipt columns, partner amounts, notes |
| Mohit | `mohit` | `mohittrain` | View, and edit the **Received Mohit** column only |

Passwords are set as Worker secrets (below), **not** in the code.

---

## 1. Test locally (optional)

```bash
cd trainfundtrack
python3 -m http.server 8777
```
Open http://localhost:8777. In local mode (`WORKER_URL` empty in `app.js`) login
uses the built-in credentials, and the **Backup** button downloads an updated
`data.json` you can drop back into the folder. The one-click **Save** appears only
once the Worker is wired up.

---

## 2. Put the site on GitHub Pages

1. Create a **public** repo (e.g. `trainfundtrack`) on GitHub.
2. Push these files to it:
   ```bash
   git init && git add . && git commit -m "Train Fund Tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/trainfundtrack.git
   git push -u origin main
   ```
3. Repo **Settings → Pages →** Source = `Deploy from a branch`, Branch = `main` /
   `/root`. Save. Your site goes live at
   `https://YOUR_USERNAME.github.io/trainfundtrack/` within a minute.

---

## 3. Create the GitHub token (for the Worker only)

GitHub → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:
- **Resource owner:** your account
- **Repository access:** *Only select repositories* → pick `trainfundtrack`
- **Permissions:** *Repository permissions → Contents → Read and write*
- Generate and **copy** the token (starts with `github_pat_…`).

This token is only ever pasted into the Worker's secrets — never into the website.

---

## 4. Deploy the Cloudflare Worker

Install the CLI and log in (free Cloudflare account, no card):
```bash
npm install -g wrangler
wrangler login
```

Edit `worker/wrangler.toml` → set `GH_OWNER` to your GitHub username (and
`GH_REPO`/`GH_BRANCH`/`GH_PATH` if different). Leave `ALLOWED_ORIGIN = "*"` for now.

Set the four secrets (you'll be prompted to paste each value):
```bash
cd worker
wrangler secret put GITHUB_TOKEN      # paste the github_pat_… from step 3
wrangler secret put ADMIN_PASSWORD    # e.g. trainadmin2026
wrangler secret put MOHIT_PASSWORD    # e.g. mohittrain
wrangler secret put SESSION_SECRET    # any long random string, e.g. run: openssl rand -hex 32
```

Publish:
```bash
wrangler deploy
```
Wrangler prints your Worker URL, e.g.
`https://trainfundtrack-api.YOURNAME.workers.dev`. Copy it.

---

## 5. Connect the site to the Worker

1. In `app.js`, set the URL from step 4:
   ```js
   const WORKER_URL = "https://trainfundtrack-api.YOURNAME.workers.dev";
   ```
2. For safety, blank the local passwords in `app.js` (they're ignored in Worker
   mode, but this repo is public):
   ```js
   const CREDENTIALS = {
     admin: { password: "", role: "admin" },
     mohit: { password: "", role: "guest" },
   };
   ```
3. Commit & push:
   ```bash
   git add app.js && git commit -m "Wire up Worker" && git push
   ```
4. Lock the Worker to your site: set `ALLOWED_ORIGIN` in `wrangler.toml` to your
   final site URL (e.g. `https://trains.example.com`, or your github.io URL), then
   `wrangler deploy` again.

Now logging in and clicking **Save** commits to GitHub automatically. 🎉

---

## 6. Point your own domain (optional)

**Site (GitHub Pages):** repo **Settings → Pages → Custom domain** → enter e.g.
`trains.example.com`. At your domain registrar add a **CNAME** record for
`trains` → `YOUR_USERNAME.github.io`. GitHub will provision HTTPS automatically.
(Remember to update `ALLOWED_ORIGIN` to this domain and redeploy the Worker.)

---

## Changing passwords later

Just re-run the secret command — no code change, no redeploy of the site:
```bash
cd worker
wrangler secret put ADMIN_PASSWORD
wrangler secret put MOHIT_PASSWORD
```

## Restoring / backup

Every save is a commit. To view history or roll back, open the repo on GitHub →
**History** on `data.json`, or:
```bash
git log -- data.json
git checkout <commit> -- data.json && git commit -m "Restore" && git push
```
The **Backup** button in the app also downloads the current data as a file anytime.

---

## Cost

- GitHub Pages: free (public repo).
- Cloudflare Workers: free tier (100k requests/day — far beyond this use).
- No card required for either. You cannot be charged without explicitly upgrading.
