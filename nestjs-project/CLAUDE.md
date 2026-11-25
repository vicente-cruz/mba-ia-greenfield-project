# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, storage, Redis) — **never** start the NestJS API server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app"). `docker compose up -d` also starts the `nestjs-api` container, but it only runs `tail -f /dev/null`; the API server is started on demand.

**Exception — `video-worker`:** `docker compose up -d` also starts the `video-worker` service, which runs application code (`npm run start:worker:dev`, watch mode). This is intentional (`phase-03-videos/TD-10`, Q-07, D-11): the integration and e2e suites need storage, queue and worker running (R-10, `phase-03-videos/TD-15`). Consequences:

- it recompiles and restarts on every change under `src/` (bind mount);
- before mutating sources for a red check, stop it with `docker compose stop video-worker`, which is graceful: SIGTERM and up to 200 s for the current job. Restore the sources before starting it again with `docker compose start video-worker`;
- do not start a second worker by hand next to it.

After starting the environment, always confirm the containers are up before proceeding:

```bash
docker compose ps      # db, mailpit, storage, redis: "running (healthy)"; nestjs-api and video-worker: "running"
docker compose ps -a storage-init   # one-shot: must show "Exited (0)"
```

Then verify each service is actually ready — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Storage (S3 API):** `docker compose exec storage curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:9000/minio/health/ready` — expect `200`
- **Bucket and application credential:** `docker compose ps -a storage-init` — expect `Exited (0)` (it creates the bucket `S3_BUCKET` and the credential restricted to it)
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`; and `docker compose exec redis redis-cli config get maxmemory-policy` — expect `noeviction` (required by BullMQ)
- **Video worker:** `docker compose logs video-worker | grep 'video-worker started'` — expect `video-worker started (pid N)`, after the three `video-maintenance.scheduler-registered` events

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services (all from `compose.yaml`; `nestjs-api` and `video-worker` share the image `streamtube-nestjs-dev`, built from `Dockerfile.dev`):
- `nestjs-api` — NestJS API, port `3000` (server started on demand)
- `video-worker` — video processing and maintenance worker (`src/worker.ts`, output in `dist-worker/`); no HTTP port; starts with `docker compose up` (see the exception above)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture used by the auth flows and tests, SMTP port `1025`, web UI port `8025`
- `storage` — S3-compatible object storage (`pgsty/silo`, community fork of MinIO, pinned by tag and digest), S3 API port `9000`, console port `9001`, volume `storage-data`
- `storage-init` — one-shot (`pgsty/mc`): creates the private bucket and the application credential, then exits
- `redis` — Redis 8.8.4 for the BullMQ queues `video-processing` and `video-maintenance`, with `--maxmemory-policy noeviction`, volume `redis-data`; no published port (`redis:6379` inside the Compose network)
- `proof-browser` — Playwright image for the browser proofs (V-08, V-09); profile `proofs` only, never started with the environment

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running, after start:dev (expect 200 + "Hello World!")
curl --noproxy '*' http://localhost:3000

# Readiness of the infrastructure (see "Environment Startup Verification")
docker compose exec db pg_isready -U streamtube
docker compose exec storage curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:9000/minio/health/ready
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Tear down the entire environment (keeps the named volumes storage-data and redis-data; -v also removes volumes)
docker compose down
```

The host uses a corporate proxy that does not exclude `localhost`: host-side `curl` to published ports needs `--noproxy '*'`, otherwise the proxy answers `503`. Containers do not use the proxy.

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Video worker commands

The `video-worker` service runs `npm run start:worker:dev` (`docker/worker-dev.sh`: `nest start --watch -p tsconfig.worker.json`). Compiled build, inside the container: `npm run build:worker` (emits `dist-worker/worker.js`) and `npm run start:worker`. Lifecycle, on the host: `docker compose stop video-worker` (graceful), `docker compose start video-worker`, and `docker compose kill video-worker` (SIGKILL, only for the manual T-12 check in `README.md`).

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec storage curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:9000/minio/health/ready
docker compose exec redis redis-cli ping
curl --noproxy '*' http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e -- --runInBand
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
