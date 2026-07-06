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

Tests need no Redis or running server -- they cover the replay verifier, the scoring function, and token signing in isolation.

## Developing against the cluster with mirrord

```sh
cd server
mirrord exec --config-file ../deploy/.mirrord/mirrord.json -- npm run dev
```

Your local server steals incoming traffic from the cluster pod and routes outgoing connections (Redis, etc.) through the pod's network -- no need to run the cluster's dependencies locally.

## Preview environments (PRs)

Every PR gets an isolated [mirrord Preview Environment](https://metalbear.com/mirrord/docs/using-mirrord/preview-environments) in the cluster: the PR's image runs as its own pod behind the live URL, and only requests carrying the `X-MS-Tenant: pr-<n>` header reach it. The bot comment on the PR has the link and header to use. Details in [`deploy/README.md`](deploy/README.md#preview-environments-prs).

## How the game works

1. Browser loads -> fetches a seed from `POST /game/start`.
2. First click -> mines placed client-side with a mulberry32 PRNG seeded from the server seed.
3. Moves recorded as `{type, x, y, t}` where `t` = ms since first reveal.
4. Game over (win or loss) -> `POST /game/submit` with the move list.
5. Server replays the moves against the same seeded board to verify the session and compute the score authoritatively.
6. Score added to a Redis sorted set (`ZADD GT`, so each name keeps only its best); rank returned.

## Scoring & leaderboard

- **Every session scores** (win or loss). Score = cells cleared, plus a completion + speed bonus on a full clear, weighted by difficulty (Beginner 1x, Intermediate 2x, Expert 3x). Higher is better.
- **One running leaderboard per difficulty** for the whole event -- no daily reset. Each name appears once, keeping its highest score.
- **Prizes** go to the top score in each category (Beginner, Intermediate, Expert). Winners claim by sharing their high-score image on LinkedIn tagging MetalBear, or posting it in the community Slack.
