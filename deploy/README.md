# Deploy

Two components in the `minesweeper` namespace:

- **minesweeper-server** — one container serving the game UI (`web/`) **and** the API on port 3001.
- **redis** — its own deployment + service, backed by a 1Gi PVC (`--appendonly yes`) so the leaderboard survives restarts.

> **Status (wired to the Civo cluster).** The `KUBECONFIG_DATA` GitHub secret is set (deployer SA
> token from the Civo cluster), so `deploy.yml` and `preview-env-pr.yml` are live. Note: the cluster
> currently runs a manually pushed Dockerhub image (`rinkiyakedad/minesweeper-server`); the next push
> to `main` switches it to CI-built GHCR images — make sure the `minesweeper-server` GHCR package is
> **public** first (see "Preview environments" below).

## Wiring CI/CD to the cluster (already done for the Civo cluster)

Whoever has admin access to the cluster runs these, in order. No app code changes needed.

1. **Bootstrap the namespace, RBAC, and Redis** — the "One-time bootstrap" block below.
2. **Create the app secrets** (`minesweeper-secrets`) — also in that block.
3. **Mint `KUBECONFIG_DATA`** from the `minesweeper-deployer` ServiceAccount — see "Building KUBECONFIG_DATA".
4. **Add the GitHub secret** (`KUBECONFIG_DATA`) — "GitHub secrets" section.
5. Push to `main` → `deploy.yml` builds, deploys, and verifies the rollout automatically.

That's the whole change: **no code edits, just the bootstrap commands + two GitHub secrets.** The CI already
references `secrets.KUBECONFIG_DATA`, so once the secret exists the pipeline is live.

## One-time bootstrap (needs cluster admin)

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/rbac-deployer.yaml
kubectl apply -f deploy/k8s/rbac-preview.yaml   # mirrord preview envs (needs the operator installed)
kubectl apply -f deploy/k8s/redis.yaml

# App secrets (NOT committed) -- generate strong random values:
kubectl -n minesweeper create secret generic minesweeper-secrets \
  --from-literal=game-secret="$(openssl rand -hex 32)" \
  --from-literal=share-secret="$(openssl rand -hex 32)"

kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

`REDIS_URL` is a plain env (`redis://redis:6379`) in the deployment — no secret needed.

## GitHub secrets (repo → Settings → Secrets)

| Secret | What | Used by |
|--------|------|---------|
| `KUBECONFIG_DATA` | base64 of a kubeconfig authenticating as the `minesweeper-deployer` ServiceAccount (see below) | deploy, preview |

`GITHUB_TOKEN` (GHCR push) is automatic — no setup.

### Building KUBECONFIG_DATA from the deployer SA

```bash
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl -n minesweeper get secret minesweeper-deployer-token -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl -n minesweeper get secret minesweeper-deployer-token -o jsonpath='{.data.token}' | base64 -d)

cat > deployer.kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
- cluster: { server: ${SERVER}, certificate-authority-data: ${CA} }
  name: cl
contexts:
- context: { cluster: cl, user: deployer, namespace: minesweeper }
  name: ctx
current-context: ctx
users:
- name: deployer
  user: { token: ${TOKEN} }
EOF

base64 -w0 deployer.kubeconfig   # paste into the KUBECONFIG_DATA secret
```

This token can `get`/`patch` deployments in `minesweeper`, plus manage mirrord preview sessions
(via the `mirrord-operator-ci` ClusterRole, bound in `rbac-preview.yaml`) — nothing else in the cluster.

## How CI/CD works

- **Push to `main`** → `deploy.yml`: test → build+push `:sha-<gitsha>` → `kubectl set image` → `rollout status`. Automatic, no manual step.
- **PR opened / pushed** → `preview-env-pr.yml`: build+push `:preview-pr-<n>-<sha>` → `mirrord preview start` → PR comment with the URL + header. **PR merged / closed** → `mirrord preview stop`.

## Preview environments (PRs)

Every PR against `main` gets a [mirrord Preview Environment](https://metalbear.com/mirrord/docs/using-mirrord/preview-environments):
an isolated pod in the cluster running the PR's image, sharing the live Redis and ingress. Only requests
carrying the PR's header reach the preview pod; everyone else keeps hitting the live game.

- **Config:** [`deploy/.mirrord/mirrord-preview.json`](.mirrord/mirrord-preview.json) — targets
  `deployment/minesweeper-server`. Uses the operator's default key-derived traffic filter
  (`baggage: mirrord-session=pr-<n>`); no custom filter, which is what makes share links possible
  (previews with a custom `http_filter` don't get a share host).
- **Workflow:** [`.github/workflows/preview-env-pr.yml`](../.github/workflows/preview-env-pr.yml) — builds
  the image, runs `mirrord preview start -k pr-<n>` (with `--force` so new pushes replace the pod), and
  posts/updates a PR comment. On close/merge it runs `mirrord preview stop`.
- **Trying it:** click the **share link** in the PR comment (`https://<slug>.preview.minesweeper.metalbear.com`) —
  works in any browser, nothing to install. If share links aren't enabled on the cluster (see below), the
  comment falls back to header instructions: set `baggage: mirrord-session=pr-<n>` on
  https://minesweeper.metalbear.com via the
  [mirrord Browser Extension](https://metalbear.com/mirrord/docs/using-mirrord/browser-extension) or
  `curl -H "baggage: mirrord-session=pr-<n>" https://minesweeper.metalbear.com/health`.
- Previews also expire on their own after 2h (`ttl_mins`), so a stuck workflow can't leak pods.

### Cluster prerequisites (already set up on the Civo cluster)

1. mirrord operator installed with `operator.previewEnv: true` (Enterprise license).
2. `deploy/k8s/rbac-preview.yaml` applied — binds the deployer SA to the operator's `mirrord-operator-ci` ClusterRole.
3. The `ghcr.io/metalbear-co/minesweeper-server` package set to **public** (GitHub → org packages → package
   settings → Danger Zone → change visibility). The package is created private on the first CI push; the
   cluster pulls anonymously, so previews (and deploys) fail with a 401 until it's flipped. One-time step.

### Shareable preview links

Share links let reviewers open a preview at `https://<slug>.preview.minesweeper.metalbear.com` with no
browser extension — the in-cluster `mirrord-share-ingress` injects the session header server-side. See
[the docs](https://metalbear.com/mirrord/docs/use-cases/preview-environments#sharing-a-preview-via-a-link).

**Cluster side: done** (operator 3.183.0 upgraded with
`operator.shareIngress.shareDomain=preview.minesweeper.metalbear.com`, `mirrord-operator-share-ingress`
chart installed with matching `shareDomain` + `appDomain=minesweeper.metalbear.com`, and
`deploy/k8s/mirrord-share-ingress-ingress.yaml` applied). Verified end-to-end by resolving a share host
against the ingress LB directly.

**Still needed before links work publicly:**

1. Wildcard DNS record `*.preview.minesweeper.metalbear.com` pointing at the same
   load balancer as `minesweeper.metalbear.com` (the ingress-nginx LB, currently `212.2.252.71`).
2. Wildcard TLS cert for `*.preview.minesweeper.metalbear.com` as the `share-ingress-tls`
   secret in the `mirrord` namespace (wildcards need DNS-01 validation — the cluster has no
   cert-manager, so either issue manually or install cert-manager with a DNS-01 solver):
   ```bash
   kubectl create secret tls share-ingress-tls --cert=wildcard.crt --key=wildcard.key -n mirrord
   ```

**Config gotchas** (both verified against the operator source, 3.183.0):

- A share host is only minted for previews using the **default key-derived filter**: incoming
  `mode: steal` with **no** custom `http_filter`. Omitting the whole `network` section silently
  defaults to *mirror* mode, which gets no share host at all.
- `incoming.ports` must pin the app port (`[3001]`): `mirrord-share-ingress` forwards to the target
  Service on the first pinned port and **defaults to port 80** when none is set — which hangs, since
  our Service listens on 3001. It also assumes the Service is named exactly like the target
  deployment (true here: `minesweeper-server`).

`mirrord preview start` prints the share link as a `preview URL` line, and the PR comment
automatically shows the clickable link (falling back to header instructions if it's ever missing).

## Resource sizing & instance recommendations

Target: leaderboards up to ~500 entries each (3 difficulties, so ~1,500 rows total) and 50 to 100 concurrent players. This is a **small** workload, the current manifest values already cover it.

### Data footprint (Redis / PVC)

- ~1,500 sorted-set members. Each is `{claimToken}:{handle}` (~105 bytes) plus score and sorted-set overhead, roughly 200 bytes/entry, so **~300 KB of leaderboard data**.
- Transient keys (per-game hashes with a 24h TTL, rate-limit counters, claim records) add a few MB even on a busy day. AOF is compacted on rewrite.
- **Total stays well under 100 MB.** The **1Gi PVC is ample** (10x+ headroom), no need to grow it. Redis `maxmemory` isn't a concern at this scale.

### Compute / memory

Gameplay is client-side, the server is only hit on `POST /game/start` and `POST /game/submit`, so request rate is low (single-digit req/s at 50–100 concurrent). The heaviest op is replay verification on submit (an Expert board flood-fill, sub-millisecond).

| Component | Requests | Limits | Replicas | Notes |
|-----------|----------|--------|----------|-------|
| minesweeper-server | 256Mi / 100m | 512Mi / 500m | 1 | Current values, comfortable for 50–100 concurrent. |
| redis | 128Mi / 50m | 256Mi / 250m | 1 | Single replica (single writer), do not scale horizontally. |

The whole stack runs steady in **under ~1 GiB RAM and under ~0.5 vCPU**.

### Instances

- Fits on a **single small node**: AWS `t3.small`/`t3.medium` (2 vCPU / 2–4 GiB), GCP `e2-small`/`e2-medium`, or equivalent.
- **No pre-provisioning needed.** Because pod requests are small, deploy onto a **cluster-autoscaler node pool** (nodes scale in/out with demand) or a **serverless-node platform** (GKE Autopilot, EKS Fargate), where you pay per pod request and there's nothing to size up front.

### Elasticity (optional)

- Add a **HorizontalPodAutoscaler** on `minesweeper-server` for burst headroom, e.g. min 2 / max 5 replicas targeting ~70% CPU. The server is stateless (all state is in Redis), so it scales cleanly.
- **Do not autoscale Redis** (it's the single stateful writer). If Redis ever becomes a bottleneck at much larger scale, move to a managed Redis and point `REDIS_URL` at it, rather than adding replicas.
