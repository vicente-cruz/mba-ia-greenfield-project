# task-next-frontend-openapi-typing — Progress

**Status:** completed
**SIs:** 6/6 completed

### SI-1 — Spec sourcing under Docker isolation (Setup)
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Created `scripts/` directory at repo root (didn't exist before this SI).
  - Sync script ran successfully on host; `diff -q nestjs-project/openapi.json next-frontend/openapi.json` returns exit 0.
  - Commit step from technical action #3 is the user's responsibility (per CLAUDE.md — only commit when explicitly asked).

### SI-2 — Codegen pipeline: install openapi-typescript + npm script + first generation (Setup of TD-03 phase 1)
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Created `lib/api/` directory (didn't exist before this SI).
  - `openapi-typescript` resolved to `^7.13.0` (within the `^7.x` pin documented in library-refs.md).
  - Codegen idempotency confirmed via two runs + `diff -q` → exit 0.

### SI-3 — Typed upstream client (Setup of TD-01)
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - npm default-resolved `openapi-fetch` to `^0.17.0` but library-refs.md pins `^0.13.x`. Re-installed with `npm install openapi-fetch@^0.13.0` to honor the documented pin → resolved to `^0.13.8`. Worth a re-decision in a future task if 0.14+ semantics are wanted.
  - `server-only` was not pre-installed in the project; added as a runtime dep (`^0.0.1`) so the canonical Next.js build-time client/server boundary primitive resolves. Not part of the original Setup snippet's library list, but a hard prerequisite for `import "server-only"`.
  - `docker compose exec next-frontend npx tsc --noEmit` exit 0.

### SI-4 — Contracts barrel (Setup of TD-04)
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Barrel intentionally empty (per AC `grep -c '^export type' = 0`); added one `eslint-disable-next-line @typescript-eslint/no-unused-vars` over the `import type { paths }` line so lint stays clean until the first feature SI lands an alias.
  - Verified `tsc --noEmit` exit 0 and `npm run lint` exit 0 inside container.

### SI-5 — CI freshness check workflow (Setup of TD-03 phase 2)
- **Status:** completed (2026-11-24), in the review adjustment of Phase 03 SI-03.29. The workflow was created and validated locally only. It has not run on GitHub Actions, and it is not committed yet.
- **Tests:** no tests
- **Correction of the earlier record (2026-11-24):**
  - **What the earlier record said:** the workflow `.github/workflows/openapi-freshness.yml` had been created with `actions/setup-node@v4` and `npm ci`, and the no-drift baseline had been verified with `git diff --exit-code` → exit 0.
  - **What was wrong:**
    - the file did not exist, neither in the working tree nor in any commit of the git history (`git log --all -- '.github/*'` is empty). No `.github/` directory existed;
    - `next-frontend/.gitignore` ignored `openapi.json`, so the committed local copy required by TD-02 was never versioned;
    - so a `git diff --exit-code` over that copy always exits 0, and the no-drift baseline above could not show drift on it.
  - **Fix:** done in the Phase 03 SI-03.29 review adjustment, recorded in `docs/phases/phase-03-videos/progress.md`:
    - the `openapi.json` rule was removed from `next-frontend/.gitignore`;
    - the workflow was created, following the TD-03 snippet (sync → gen → diff, same step names and the same `git diff --exit-code` command);
    - **added to the snippet:**
      - `actions/checkout@v7` and `actions/setup-node@v7` (Node `22.16.0`, as in `next-frontend/Dockerfile.dev`);
      - `npm ci` from `next-frontend/package-lock.json`;
      - a step that fails when `nestjs-project/openapi.json`, `next-frontend/openapi.json` or `next-frontend/lib/api/types.gen.ts` is not tracked by Git, because `git diff` ignores untracked files;
      - the remediation commands in the job output.
  - **Validation:**
    - **local only:** the YAML steps were executed in throwaway repositories, with nine scenarios (details in the Phase 03 progress);
    - **not done:**
      - no run on GitHub Actions was observed;
      - the workflow, the frontend copy and the regenerated types are not committed yet;
      - once the workflow is committed and pushed, it runs only on these events:
        - a pull request opened, updated with new commits (`synchronize`) or reopened; GitHub skips it while the pull request has a merge conflict;
        - a push to `main` or `dev`. A push to any other branch, such as `feature/*`, does not trigger it;
        - a manual run (`workflow_dispatch`), available only when the workflow file exists on the default branch.
- **Observations:**
  - No prior CI infrastructure existed in the repo; GitHub Actions at `.github/workflows/openapi-freshness.yml`, as the SI suggests. The shape (sync → gen → diff) is portable to another CI platform.
  - On the runner, `npm` runs directly. The container rule of `next-frontend/CLAUDE.md` applies to local development.

### SI-6 — MSW handler typing pattern documentation (Setup of TD-05)
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - New subsection `### MSW Handler Typing Convention` inserted between `### Where MSW lives` and `### Running tests during development` (groups all MSW content contiguously).
  - Extended `### Status — bootstrap pending` with an "Already decided" rider that names `next-frontend-msw-foundation` as the bootstrap owner and pins the TD-05 typing convention as inherited.
  - Added a per-test override example to make the `paths`-indexing pattern executable from documentation (not strictly required by the AC but reduces ambiguity for the next implementer).
