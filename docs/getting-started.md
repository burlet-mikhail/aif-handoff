[Back to README](../README.md) · [Architecture →](architecture.md)

# Getting Started

## Prerequisites

- **Docker** — Docker Desktop or compatible runtime
- **Node.js** 22+ and **npm** 10+ — only needed if running without Docker
- **Claude Code CLI** — only needed if running without Docker (`npm i -g @anthropic-ai/claude-code`). The Agent SDK spawns Claude Code as a subprocess, so the CLI must be installed globally
- **Claude subscription** or Anthropic API key (for agent features)

## Quick Start with Docker

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff

# 1. Prepare environment
cp .env.example .env       # required: docker-compose.yml uses `env_file: .env`
mkdir -p projects          # default PROJECTS_DIR - must exist before first
                           # `docker compose up`, otherwise Docker creates it
                           # as root and the container user cannot write to it

# 2. Bring the stack up
docker compose up --build

# 3. Authenticate Claude (one-time, see Docker Authentication below)
docker compose exec agent claude login
docker compose restart agent
```

This builds and starts API (port 3009), Web UI (port 5180), Agent, and MCP (port 3100) in one command. Uses Angie as a reverse proxy — Web UI at `localhost:5180` proxies all API and WebSocket requests automatically.

SQLite database and auth state are persisted in Docker volumes. Project files
live in the host `PROJECTS_DIR` bind mount.

### Docker Project Paths

When you create a project in the UI, the **Root Path** field expects a host
path, for example `/Users/you/projects/my-app`. The dev compose mounts the host
directory `PROJECTS_DIR` into each container at `PROJECTS_MOUNT` (default
`/home/www`). The API translates matching host paths to container paths when it
persists them, so agents can access the same project as `/home/www/my-app`.

The default `PROJECTS_DIR` is `${PWD}/projects`, relative to the compose file.
To use a different host directory:

```bash
PROJECTS_DIR=/srv/aif-projects docker compose up --build
```

Create the host directory before `docker compose up`. If the bind-mount target
is missing, Docker creates it as root-owned and the container's `node` user
cannot write project files there.

### Resetting Docker State

Containers persist data in named Docker volumes (`db-data`, `claude-auth`,
`codex-auth`):

```bash
docker compose down       # stops containers, keeps database and auth state
docker compose down -v    # also removes named volumes - fresh slate
                          # (you will need to `claude login` again)
```

Project files in `PROJECTS_DIR` live on the host filesystem and are not deleted
by `down -v`. Remove them manually if you need to reset project files too.

### Docker Authentication

Two options:

**Option A — API key:** Create `.env` with `ANTHROPIC_API_KEY=sk-ant-xxxxx` before running.

**Option B — Claude subscription:** Log in inside the container after first start:

```bash
docker compose exec agent claude login
docker compose restart
```

Copy the URL and open it in your browser. **Important:** the terminal wraps long URLs across lines — remove any line breaks and spaces before pasting, otherwise OAuth will fail with `invalid code_challenge`. Then restart to apply. Credentials are stored in a persistent `claude-auth` Docker volume and survive restarts.

### Production

```bash
docker compose -f docker-compose.production.yml up --build
```

Only ports 80/443 exposed. Security hardening, healthchecks, resource limits, and log rotation included. Authentication works the same as in development — see [Docker Authentication](#docker-authentication) above.

Docker-specific environment variables:

| Variable             | Default      | Description                                                  |
| -------------------- | ------------ | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`  | —            | API key (or use `claude login`)                              |
| `DOMAIN`             | `localhost`  | Domain for SSL certificate (ACME)                            |
| `PORT`               | `3009`       | Host port for API                                            |
| `WEB_PORT`           | `5180`       | Host port for Web UI (dev)                                   |
| `WEB_HOST`           | `localhost`  | Web UI dev server host (Vite)                                |
| `HTTP_PORT`          | `80`         | Host port for Web UI (production)                            |
| `HTTPS_PORT`         | `443`        | HTTPS port (production)                                      |
| `PROJECTS_DIR`       | `./projects` | Host directory for project files (dev)                       |
| `PROJECTS_MOUNT`     | `/home/www`  | Project files path inside containers                         |
| `PROJECTS_HOST_ROOT` | `${PWD}`     | Compose-internal repo root for relative `PROJECTS_DIR` (dev) |

When running the dev Docker Compose setup, `PROJECTS_DIR` is the host directory
mounted into the containers at `PROJECTS_MOUNT`. If you create a project with a
host path under `PROJECTS_DIR` (for example `/Users/me/projects/app`), the API
stores the container path automatically (for example `/home/www/app`) so agents
can access the files from inside the container. Relative `PROJECTS_DIR` values
are resolved from `PROJECTS_HOST_ROOT`, which `docker-compose.yml` sets from the
repository directory; leave it unset unless you are replacing the compose wiring.

Production Compose uses a named Docker volume at `PROJECTS_MOUNT` instead of
the dev bind mount. In production, create and select projects by their
in-container path, for example `/home/www/app`.

## Installation without Docker

```bash
npm i -g @anthropic-ai/claude-code   # required — Agent SDK uses Claude Code CLI
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install
```

## Database Setup

The project uses SQLite via `better-sqlite3` + `drizzle-orm`. DB access in runtime services is centralized in `@aif/data` (lint-enforced boundary for `api` and `agent`). Initialize the database:

```bash
npm run db:setup
```

This builds `@aif/shared`, creates `data/aif.sqlite`, and applies runtime migrations/index bootstrap.

To apply schema changes later:

```bash
npm run db:push
```

## Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

`npm run dev`, `api`, and `agent` automatically read env from root `.env` (`.env.local` overrides when present), so no extra export step is required.

| Variable                          | Default             | Description                                                                                              |
| --------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`               | _(optional)_        | API key. Agent SDK uses `~/.claude/` auth by default                                                     |
| `PORT`                            | `3009`              | API server port                                                                                          |
| `MCP_PORT`                        | _(optional)_        | When set to a valid integer port (`1-65535`), `npm run dev` also starts the MCP HTTP server on this port |
| `WEB_PORT`                        | `5180`              | Web UI dev server port                                                                                   |
| `WEB_HOST`                        | `localhost`         | Web UI dev server host                                                                                   |
| `POLL_INTERVAL_MS`                | `30000`             | Agent coordinator polling interval (ms)                                                                  |
| `AGENT_STAGE_STALE_TIMEOUT_MS`    | `5400000`           | Stale-stage watchdog timeout (ms) before auto-recovery                                                   |
| `AGENT_STAGE_STALE_MAX_RETRY`     | `3`                 | Max stale auto-recover attempts before quarantine in `blocked_external`                                  |
| `AGENT_STAGE_RUN_TIMEOUT_MS`      | `3600000`           | Per-stage timeout (ms) before coordinator marks run as failed                                            |
| `AGENT_FIRST_ACTIVITY_TIMEOUT_MS` | `60000`             | First-activity watchdog: kill + restart agent if no tool call within this window after start             |
| `API_RUNTIME_START_TIMEOUT_MS`    | `60000`             | Timeout waiting for first output from API one-shot runtime calls                                         |
| `API_RUNTIME_RUN_TIMEOUT_MS`      | `120000`            | Hard timeout for API one-shot runtime calls                                                              |
| `AGENT_USE_SUBAGENTS`             | `false`             | Default for per-task "Use subagents" toggle. `true`: custom subagents, `false`: aif-\* skills            |
| `DATABASE_URL`                    | `./data/aif.sqlite` | SQLite database path                                                                                     |
| `AGENT_QUERY_AUDIT_ENABLED`       | `true`              | Enable/disable query audit logs in `logs/*.log`                                                          |
| `LOG_LEVEL`                       | `debug`             | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`                                            |
| `ACTIVITY_LOG_MODE`               | `sync`              | Activity logging strategy: `sync` or `batch`                                                             |

You can set planner/plan-checker/implementer/review budgets per project in the project edit dialog. Leave any budget field empty for unlimited.

See [Configuration](configuration.md) for details.

## Running

Start all services with hot reload:

```bash
npm run dev
```

This runs three processes in parallel via Turborepo by default. If `MCP_PORT` is set to a valid integer port, it starts a fourth process for MCP over HTTP. Invalid values are ignored here and the local MCP install flow falls back to `stdio`.

| Service   | URL                         | Description                                               |
| --------- | --------------------------- | --------------------------------------------------------- |
| **API**   | `http://localhost:3009`     | REST + WebSocket server                                   |
| **Web**   | `http://localhost:5180`     | Kanban board UI                                           |
| **Agent** | _(background)_              | Polls every 30s + event-driven wake, dispatches subagents |
| **MCP**   | `http://localhost:3100/mcp` | Optional MCP HTTP endpoint                                |

## Verify It Works

1. Open `http://localhost:5180` — you should see the Kanban board
2. Create a project (top-left selector)
3. Add a task to the Backlog column
4. If Claude auth is missing, the UI will show a warning banner with setup guidance
5. If agent is running with valid credentials, the task will automatically move through stages

Optional readiness check:

```bash
curl -s http://localhost:3009/agent/readiness
```

## Available Scripts

| Command            | Description                        |
| ------------------ | ---------------------------------- |
| `npm run dev`      | Start all services with hot reload |
| `npm run build`    | Build all packages                 |
| `npm test`         | Run all tests (Vitest)             |
| `npm run db:setup` | Build shared and initialize SQLite |
| `npm run db:push`  | Push schema changes                |

## Next Steps

- [Architecture](architecture.md) — understand the agent pipeline and module structure
- [API Reference](api.md) — explore the REST and WebSocket API

## Dev Container

The project includes a `.devcontainer/devcontainer.json` for JetBrains and VS Code. Open the project in your IDE — it will offer to reopen in a Dev Container with Node 22, ports forwarded, and dependencies pre-installed.

## See Also

- [Architecture](architecture.md) — project structure and agent pipeline
- [API Reference](api.md) — endpoints and WebSocket events
- [Configuration](configuration.md) — environment variables in detail
