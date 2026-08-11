# MetalBear Minesweeper

Classic Minesweeper with a live leaderboard, running on Kubernetes and built to be developed and validated against the cluster with mirrord. Launch-week game: clear the board, climb the leaderboard, win swag.

## Structure

```
web/           Vanilla HTML/CSS/JS frontend (no framework), served by the backend
server/        Node 20 + TypeScript + Hono backend (also serves web/)
deploy/
  k8s/         Kubernetes manifests (Linux, namespace "minesweeper")
  .mirrord/    mirrord config for local dev against the cluster
.github/
  workflows/   CI/CD: deploy.yml (build + deploy on push to main),
               preview-env-pr.yml (mirrord preview env per PR)
```

Deployment, CI/CD, and cluster-access setup live in **[`deploy/README.md`](deploy/README.md)**.

## Running locally

### Backend (serves the API and the frontend)

```sh
cd server
npm install
npm run dev      # tsx watch, hot reload on :3001
```

Requires Redis on `localhost:6379` (or set `REDIS_URL`). The server serves `web/` too, so `http://localhost:3001` gives you the full app.

### Frontend only

Open `web/index.html` directly, or serve `web/` with any static server -- `api.js` auto-detects `localhost` and points the API at `:3001`.

### Environment variables

| Variable | Default (dev) | Required in prod |
|---|---|---|
| `GAME_SECRET` | `dev-game-secret-change-in-prod` | YES |
| `SHARE_SECRET` | `dev-secret-change-in-prod` | YES |
| `REDIS_URL` | `redis://localhost:6379` | YES |
| `PORT` | `3001` | no |
| `WEB_ROOT` | `./web` | no (path to static files) |

## Testing

```sh
cd server
npm install
npm test
```

Tests need no Redis or running server -- they cover the board state machine, the
scoring function, and token signing in isolation (Redis is faked, see
`server/test/board.test.ts`).

`timing-integrity.test.mjs` (repo root) is a separate live-server smoke test --
point it at a running local/staging instance (never production) to confirm the
board stays server-authoritative end to end: `node timing-integrity.test.mjs`.

## Developing against the cluster with mirrord

```sh
cd server
mirrord exec --config-file ../deploy/.mirrord/mirrord.json -- npm run dev
```

Your local server steals incoming traffic from the cluster pod and routes outgoing connections (Redis, etc.) through the pod's network -- no need to run the cluster's dependencies locally.

## Preview environments (PRs)

Every PR gets an isolated [mirrord Preview Environment](https://metalbear.com/mirrord/docs/using-mirrord/preview-environments) in the cluster: the PR's image runs as its own pod behind the live URL, and only requests carrying the `X-MS-Tenant: pr-<n>` header reach it. The bot comment on the PR has the link and header to use. Details in [`deploy/README.md`](deploy/README.md#preview-environments-prs).

## How the game works

The board is server-authoritative -- the server never hands out the mine layout,
so there's nothing to solve offline from a public seed (see `server/src/board.ts`).

1. Browser loads -> `POST /game/start` gets back a bare `gameId`, no board data.
2. Every click -> `POST /game/reveal {gameId, x, y}`. The server places mines on
   the very first call (safe zone centred on that click) and replies with only
   the cells that click actually opened -- never the rest of the board.
3. Game over (win or loss) -> `POST /game/submit {gameId, handle, ...}`. The
   server already knows the outcome and elapsed time from its own tracked
   reveals and timestamps, so there's no client-supplied score, time, or move
   data left to trust.
4. Score added to a Redis sorted set (`ZADD GT`, so each name keeps only its best); rank returned.

## Scoring & leaderboard

- **Every session scores** (win or loss). Score = cells cleared, plus a completion + speed bonus on a full clear, weighted by difficulty (Beginner 1x, Intermediate 2x, Expert 3x). Higher is better.
- **One running leaderboard per difficulty** for the whole event -- no daily reset. Each name appears once, keeping its highest score.
- **Prizes** go to the top score on Intermediate (the only difficulty exposed in the UI). Winners claim by sharing their high-score image on LinkedIn tagging MetalBear, or posting it in the community Slack.
