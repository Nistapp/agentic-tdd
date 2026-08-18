# Release Process

This project uses a strict GitFlow-inspired branching strategy combined with automated
releases.

- `main` is the production branch. It contains only released code.
- `dev` is the active development branch.
- CI (`ci.yml`) guards every push/PR to `main` and `dev` — broken code is never merged.
- Release automation (`release-and-sync.yml`) handles version bumps, changelog generation,
  GitHub releases, **npm publishing**, and the back-merge to `dev`.
- Direct PRs to `main` may only originate from `dev` (enforced by `enforce-dev-base.yml`).

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
