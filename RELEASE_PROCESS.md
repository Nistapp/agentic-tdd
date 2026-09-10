# Release Process

This project uses a strict GitFlow-inspired branching strategy combined with automated
releases.

- `main` is the production branch. It contains only released code.
- `dev` is the active development branch.
- CI (`ci.yml`) guards every push/PR to `main` and `dev` — broken code is never merged.
- Release automation (`release-and-sync.yml`) handles version bumps, changelog generation,
  GitHub releases, **npm publishing**, and the back-merge to `dev`.
- Direct PRs to `main` may only originate from `dev` (enforced by `enforce-dev-base.yml`).
- `main` and `dev` are protected by **repository rulesets** — every change must arrive via a PR
  (see [Branch Protection](#branch-protection-repository-rulesets)).
- Stale branches are pruned automatically by the local janitor, `npm run git:clean`
  (see [Branch Hygiene & Automated Cleanup](#branch-hygiene--automated-cleanup)).

> **One-time prerequisite:** the automated npm publish uses **npm Trusted Publishing** (GitHub
> OIDC — no stored token). On <https://npmjs.com> open the `agentic-tdd` package →
> **Settings → Trusted Publishing**, enable it for source **GitHub** / owner **Nistapp** /
> repository **agentic-tdd**, and restrict it to the workflow **`release-and-sync.yml`**.
> The publish job signs with `--provenance` and authenticates via `id-token: write`; no
> `NPM_TOKEN` secret is required.

## The Step-by-Step Release Process

1. **Develop:** All features and fixes are PR'd into `dev`.
2. **Stage for Release:** When ready to release, a maintainer opens a PR from `dev` to `main`.
3. **Merge to Main:** Once CI passes, merge `dev` into `main`.
4. **Release Please:** GitHub Actions will automatically open a new "Release PR" against `main`.
   This PR contains the version bump (in `package.json`) and the updated `CHANGELOG.md`.
5. **Publish:** The maintainer reviews and merges the Release PR. The GitHub Release is
   automatically published, and the new version is **automatically published to npm**
   (`npm publish --provenance` in the same workflow, signed with GitHub OIDC).
6. **⚠️ THE BACK-MERGE (DO NOT FORGET):** Because Release Please updated the version and
   changelog directly on `main`, `main` is now exactly one commit ahead of `dev`.
   **You MUST immediately back-merge `main` into `dev`** or open a PR from `main` to `dev`.
   If this is skipped, the next release will result in severe Git merge conflicts on
   `package.json` and `CHANGELOG.md`.

> **Note on versioning:** Release Please determines the next version from your commit
> messages (Conventional Commits — see `AGENTS.md` § 11). To lock a version instead of
> bumping it (e.g. keep `0.1.x` instead of `0.2.0`), edit the Release PR title and
> `package.json` inside the PR before merging; Release Please respects the override.

---

## Branch Protection (Repository Rulesets)

Both `main` and `dev` are protected by **repository rulesets** (the modern successor to
classic branch protection). These rules are active and have **no bypass actors** — direct
pushes, force-pushes, and branch deletion are blocked for everyone, including maintainers.

| Ruleset | Targets | Rules |
|---|---|---|
| `Protect main branch` | `refs/heads/main` | require PR, block deletion, block force-push, require status checks (`check-source-branch`) |
| `Protect dev branch` | `refs/heads/dev` | require PR, block deletion, block force-push |
| `protection-rules` | `refs/heads/main`, `refs/heads/dev` | require PR, block deletion, block force-push, require status checks (CI on all 3 OS) |

Consequences:

- **Every change to `dev` or `main` must arrive via a pull request.** `required_approving_review_count`
  is `0`, so a PR is required but a human approval is not.
- **`main` only accepts PRs from `dev` or `release-please--*`.** The `check-source-branch` status
  (emitted by `.github/workflows/enforce-dev-base.yml`) fails any other head branch.
- Merges must pass CI: `Build, Lint, and Test` on `ubuntu-latest`, `macos-latest`, and `windows-latest`.

> These rules are the enforcement behind the convention "never commit directly to `main`"
> (AGENTS.md § 11). They are configured in the GitHub UI (Settings → Rules → Rulesets), not in
> the repository files.

## Branch Hygiene & Automated Cleanup

Feature, release, and back-merge PRs leave head branches behind after merge. This section
keeps local and remote branches at the clean two-branch state (`main` and `dev`).

### 1. Delete remote head branches automatically (one-time GitHub setting)

Enable **"Automatically delete head branches"** in
`Settings → General → Pull Requests`, or set it via the API:

```bash
gh api -X PATCH repos/Nistapp/agentic-tdd -f delete_branch_on_merge=true
```

GitHub then deletes a PR's head branch the moment it is merged. Release Please PRs
(`release-please--...`) are covered by this; the back-merge PR uses `main` as its head, so it
creates no transient branch to delete (`main` is never deleted — it is the default branch).

### 2. Prune remote-tracking references locally

```bash
git config --global fetch.prune true   # or drop --global for this repo only
```

Every `git fetch`/`git pull` then marks deleted remotes as `[gone]` instead of leaving
stale `origin/<branch>` pointers.

### 3. Delete stale local branches (`npm run git:clean`)

The janitor (`scripts/clean-branches.mjs`) is a cross-platform Node script that deletes local
branches whose upstream is gone — without touching `main`, `dev`, or the current branch.

```bash
npm run git:clean:dry   # dry run — list what would be deleted (safe default)
npm run git:clean       # delete stale branches
```

Options: pass `--protected=main,dev,release` to override the protected allowlist.

> **Why `-D` and not `-d`:** squash-merges make `git branch -d` refuse to delete a branch
> (it cannot see the merge), so the janitor force-deletes. It only targets branches whose
> upstream is already gone; a purely local branch with no upstream is never touched.

### 4. Keep `main` synced locally

```bash
git fetch origin main:main   # fast-forward local main without checkout (refuses non-FF)
```

If `main` is currently checked out, use `git pull --ff-only` instead.

### Recovery

If a branch was deleted by mistake, restore it from the reflog:

```bash
git reflog --all | grep <branch-name>
git branch <branch-name> <recovered-sha>
```
