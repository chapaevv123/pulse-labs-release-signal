# Deployment and vAPI Call runbook

Status: prepared only. No public URL, payment receipt, or listing exists until verified and recorded in `PROJECT_STATUS.md`.

## Render Free temporary stand

`render.yaml` defines one Node web service on the Free plan, `npm ci --omit=dev`, `npm start`, `autoDeployTrigger: off`, and `/ready` as its health check. `HOST=0.0.0.0` and Render's `PORT` let the platform reach Express. Render provides the public `onrender.com` DNS name and managed HTTPS. `RENDER_EXTERNAL_HOSTNAME` is read at runtime to validate the public Host; paid requests require Render's `X-Forwarded-Proto: https`, so the x402 resource URL uses HTTPS. Keep a single instance. The previous `Caddyfile.example` is an optional VPS alternative, not the Render path.

The Blueprint prompts for `X402_PAY_TO` at creation (`sync: false`); enter the owner-controlled receiving address in Render configuration only. Do not put it in Git, client JavaScript, or a URL. `X402_ENABLE_PAYMENTS=1` enables only the challenge and verified settlement gate; it does not initiate payments. `X402_PRICE=$0.005` is fixed. The service must reach GitHub API and `https://facilitator.xpay.sh` during startup and requests. `/health` reports process state; `/ready` returns 503 unless the live SDK/facilitator capability check succeeds. Render should use `/ready` for deployment health checks.

Use a separate GitHub repository for this project after owner approval to publish it. Before pushing, inspect `git status`, `git ls-files`, and a secret scan; `node_modules`, `.env*` except `.env.example`, logs, keys, and local receipts are ignored. In the Render dashboard: New > Blueprint, connect that repository, select Free, enter `X402_PAY_TO` when prompted, and review every setting before creation. This creates a public resource and requires owner approval. Disable any automatic plan upgrade and inspect the workspace's spend limit; do not add a paid service or payment method for this stand.

Render Free is a preview stand, not production hosting. It spins down after 15 minutes idle and takes about a minute to wake; file changes are lost on restart; one instance and 750 free instance hours/month apply. Outbound traffic to GitHub/xpay counts toward limits, and excessive service-initiated traffic can suspend it. If a payment is authorized later, wake the stand with `/health` first and confirm `/ready` and the exact 402 before signing. The app's GitHub budget/cache and client limiter are process-local, so a restart resets them; a durable shared limit and reconciliation store are required before multi-instance or serverless production. No production SLA is claimed. Official conditions: https://render.com/docs/free and https://render.com/docs/web-services .

## Public read-only preflight

1. Record the exact public URL from Render. Run `node tools/public-preflight.js "https://<actual-host>/v1/github/release-signal?owner=nodejs&repo=node&tag=v22.0.0"` with the expected `X402_PAY_TO` in the local process environment. It checks DNS, TLS via HTTPS fetch, health 200, the unpaid 402, canonical x402 v2 `exact` Base USDC at 5000 atomic units, the recipient, malformed-proof rejection, and absence of paid JSON. It never constructs a valid payment. Record its JSON and exit code in `PROJECT_STATUS.md`.
2. After 15 minutes without traffic, rerun the same script to measure cold start and verify the same challenge. Do not run keepalive probes during the idle period.
3. Run `vapi check "https://<actual-host>/v1/github/release-signal?owner=nodejs&repo=node&tag=v22.0.0" --json` (read-only). Save findings. Current discovery/OpenAPI/Bazaar documents are absent, so expect warnings until implemented; a failed payment rule blocks listing.
4. Check a missing tag and an invalid query: each must return a pre-payment error without `PAYMENT-REQUIRED`. Confirm GitHub rate-limit headers from the hosting environment's read-only API request. Check logs for proof bytes, private data, and stack traces.

## First real payment: separate gate

Before any authorization, present the actual HTTPS URL, `eip155:8453`, Circle Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `5000` atomic units, selected payer, configured recipient, xpay facilitator and fee terms, and the transaction/receipt verification plan to the owner. Obtain separate approval. Make one payment only, at most 0.005 USDC. Do not retry on an unknown or unconfirmed settlement. Match the confirmed chain transaction to the exact operation, recipient, token, amount, and payment identifier; record the receipt in `PROJECT_STATUS.md` before calling the service live.

## vAPI Call, after separate approval

1. Open `https://api.vapinetwork.ai/call/my-apis/new` or use `vapi publish`. In Discover, supply the actual HTTPS operation and select `GET /v1/github/release-signal` with `owner`, `repo`, `tag` query fields. Use the public preflight and read-only Check endpoint first.
2. In Describe: name **Pulse Labs GitHub Release Signal**; describe that one call fetches a public GitHub release and returns source-linked, deterministic keyword signals and limitations. Input is owner, repo, tag. The alternative is reading the full release notes directly. Choose the most accurate available developer tools/API category; verify the UI's actual category choices before submission.
3. In Payout, verify `payTo` in every live 402 matches the owner-controlled receiving wallet. The owner signs the registry-bound payout statement only after separate approval. Save the listing and record its slug/status. Saved does not mean Live.
4. After the confirmed E2E receipt and separate activation approval, activate and check Live independently. Request review separately if desired. Open Earn and verify **List your API on vAPI +500 points** on the owner's account. If delayed, preserve evidence and do not create a duplicate listing.

Official vAPI guide: https://github.com/vAPI-Network/vapi-network/blob/main/docs/call.md
