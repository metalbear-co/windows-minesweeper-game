# Deploy

Two components in the `minesweeper` namespace:

- **minesweeper-server** — one container serving the game UI (`web/`) **and** the API on port 3001.
- **redis** — its own deployment + service, backed by a 1Gi PVC (`--appendonly yes`) so the leaderboard survives restarts.

> **Status (not yet wired to a cluster).** We don't have Playground cluster access yet, so
> CI/CD is written but inactive. The manifests, workflows, and RBAC are all in place and validated
> locally on minikube. Everything below is the runbook for whoever has cluster access to turn it on.

## Wiring CI/CD to the cluster (do this once you have kubeconfig access)

Whoever has admin access to the Playground cluster runs these, in order. No app code changes needed.

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
| `KUBECONFIG_DATA` | base64 of a kubeconfig authenticating as the `minesweeper-deployer` ServiceAccount (see below) | deploy |

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

This token can only `get`/`patch` deployments in `minesweeper` — it cannot touch anything else in the cluster.

## How CI/CD works

- **Push to `main`** → `deploy.yml`: test → build+push `:sha-<gitsha>` → `kubectl set image` → `rollout status`. Automatic, no manual step.

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
