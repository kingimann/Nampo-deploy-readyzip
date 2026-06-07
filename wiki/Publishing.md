# Publishing this wiki to GitHub

These pages live in the repo under `wiki/` (so they're version-controlled and reviewable in PRs). GitHub's **Wiki tab** is a *separate* git repo (`<repo>.wiki.git`), so publishing is a quick copy + push.

## One-time: enable the wiki
1. On GitHub: repo → **Settings → Features** → ensure **Wikis** is checked.
2. Repo → **Wiki** tab → **Create the first page** → save anything (e.g. "temp"). This initializes the wiki git repo.

## Publish (copy these pages in and push)
```bash
# from anywhere outside the main repo
git clone https://github.com/kingimann/NamiApp.wiki.git
cp /path/to/NamiApp/wiki/*.md NamiApp.wiki/
cd NamiApp.wiki
git add .
git commit -m "Populate wiki from repo /wiki"
git push
```

## How the files map to wiki pages
- The filename (minus `.md`) becomes the page title; `-` shows as a space — e.g. `Getting-Started.md` → **Getting Started**.
- `Home.md` is the landing page. `_Sidebar.md` is the left nav. `_Footer.md` is the footer.
- `[[Page Name]]` links resolve to the matching page (GitHub maps spaces ↔ `-`).

## Keeping it in sync
Re-run the copy + push whenever the `wiki/` folder changes. Consider a small CI job (on push to `main` touching `wiki/**`) that clones the wiki repo, copies the files, and pushes — using a token with `repo` scope.
