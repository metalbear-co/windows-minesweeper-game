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
4. **Add the GitHub secrets** (`KUBECONFIG_DATA`, `MIRRORD_OPERATOR_LICENSE`) — "GitHub secrets" section.
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
| `KUBECONFIG_DATA` | base64 of a kubeconfig authenticating as the `minesweeper-deployer` ServiceAccount (see below) | deploy + preview |
| `MIRRORD_OPERATOR_LICENSE` | Enterprise operator license key | preview |

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
- **Open/update a PR** → `preview.yml`: build+push `:pr-<n>` → `mirrord-preview start` (isolated pod running only the changed server, keyed `pr-<n>`, sharing the real Redis). Reviewers test the preview link — nothing lands in the baseline.
- **Close/merge a PR** → `preview.yml`: `mirrord-preview stop`. TTL is the backstop.

## Prereqs (mirrord preview)

Operator ≥ 3.142.0, CLI ≥ 3.189.0, Enterprise plan, Helm `operator.previewEnv: true`.
