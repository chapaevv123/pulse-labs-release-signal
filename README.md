# Pulse Labs GitHub Release Signal

Local Express API for one public GitHub release. Status: **BLOCKED for paid operation** until the live facilitator capability response, owner payout, and a real authorized payment preflight are confirmed. Nothing is deployed or listed.

## Operation

`GET /v1/github/release-signal?owner=example&repo=project&tag=v1.2.3`

The server validates the three parameters, reads `GET https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}`, checks the returned source URL and tag, and computes a fixed keyword-based classification. The JSON includes `source_url`, `retrieved_at`, release metadata, `verdict`, `signals`, evidence excerpts, rule version, and limitations. Verdict `INVESTIGATE` means the release notes mention security or breaking changes, not that an incident or investment opportunity is verified. `WATCH` covers other documented changes and prereleases; `UNKNOWN` means no rule matched.

If the release is unavailable, invalid, or rate limited, the server returns an error before offering payment. The result is cached for two minutes and charged only through the official x402 middleware. The middleware buffers the handler response and releases it only after its facilitator verification and successful settlement. A `200` status alone is not accepted as payment evidence.

## Local quickstart

Requires Node.js 22 and the locked dependencies (`npm ci` in an environment allowed to reach npm). Copy `.env.example` to `.env` and set `X402_PAY_TO` to an owner-controlled Base address. Keep `.env` private. The price is fixed at `$0.005` USDC. Keep `X402_ENABLE_PAYMENTS=0` until the owner separately authorizes a real paid preflight; only `1` enables the payment route after all capability checks. Start with `node --env-file=.env server.js` or set variables in PowerShell and run `npm.cmd start`. The server binds only to `127.0.0.1:8402` by default. For a read-only local HTTP check against the live facilitator and GitHub, run `node tools/local-preflight.js` with `X402_PAY_TO` set only in that PowerShell process.

`GET /health` reports `payment_ready`, meaning the local challenge path is configured, not that a real payment has settled. The service probes `https://facilitator.xpay.sh/supported` at startup using the official `HTTPFacilitatorClient`. It requires a `kinds[]` entry for x402 v2 `exact` on `eip155:8453`. That entry may omit `extra.asset`; an explicitly conflicting asset is rejected. Separately, the installed `ExactEvmScheme` must resolve the configured price to the canonical Base USDC asset `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, which is pinned in the payment requirements. Network support alone does not establish support for arbitrary tokens. If a condition fails, the paid route returns `503 payment_unavailable` and never serves the analysis. Do not treat documentation or test stubs as proof of settlement.

With a confirmed facilitator and payout, an unpaid valid request should return `402` with `PAYMENT-REQUIRED`. A paid request must pass the official `@x402/express` verify and settle flow before its response is released. **Do not send a real paid request without the owner's separate approval.**

Run `npm.cmd test` for application tests and `npm.cmd run lint` for syntax checks. No typecheck or build script exists because this is plain JavaScript. The prepared Render Free Blueprint is `render.yaml`; HTTPS, public preflight and vAPI registration steps are in `deployment/README.md`.

## Limits and errors

Input is restricted to GitHub owner, repository, and tag characters and bounded lengths. Only `api.github.com` is fetched. GitHub requests time out after six seconds, responses are capped at 256 KiB, and upstream calls are capped at 40 per hour per process with a two-minute cache. Clients are limited to 30 requests per minute per IP. Requests longer than 512 URL characters or with oversized declared body or payment headers return 413. These limits are process-local and must be replaced with shared limits before multi-instance deployment. GitHub may apply its own unauthenticated rate limits. No tokens, Pulse data, or vault data are loaded.

HTTP errors: 400 invalid query, 404 missing public release, 413 oversized request, 429 local budget, 502 malformed GitHub response, 503 GitHub/facilitator unavailable. A malformed payment proof cannot yield the paid result.

## vAPI Add your API (after separate deployment approval)

Use the public HTTPS URL of the exact GET operation, not localhost: `https://<host>/v1/github/release-signal?owner=example&repo=project&tag=v1.2.3`. Select method **GET** and describe required query fields `owner`, `repo`, `tag`. Description: “Fetches a public GitHub release and returns source-linked, deterministic release-note signals and limitations.” Alternative: manually read GitHub release notes and apply the documented keyword rules. Price: **$0.005 USDC**. Network: **Base Mainnet `eip155:8453`**. Scheme: **exact**. Asset: canonical Base USDC. `payTo`: the same owner-controlled address configured on the server and used for payout authorization. Verify the live HTTP 402 challenge, then separately authorize payout and publication. See `PROJECT_STATUS.md` for remaining release gates.
