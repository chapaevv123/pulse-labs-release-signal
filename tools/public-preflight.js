// Read-only public HTTPS preflight. Never sends a payment authorization.
const dns = require('node:dns/promises');
const { NETWORK, USDC, validPayout } = require('../src/app');

async function main() {
  const endpoint = new URL(process.argv[2]);
  if (endpoint.protocol !== 'https:' || !endpoint.searchParams.has('owner') ||
      !endpoint.searchParams.has('repo') || !endpoint.searchParams.has('tag')) {
    throw new Error('Pass the exact public HTTPS release-signal URL with owner, repo and tag');
  }
  const expectedPayTo = process.env.X402_PAY_TO;
  if (!validPayout(expectedPayTo)) throw new Error('Set the expected X402_PAY_TO in this process environment');
  const addresses = await dns.lookup(endpoint.hostname, { all: true });
  const started = Date.now();
  const healthResponse = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(90000) });
  const healthMs = Date.now() - started;
  const health = await healthResponse.json();
  const unpaid = await fetch(endpoint, { signal: AbortSignal.timeout(90000) });
  const unpaidBody = await unpaid.text();
  const encoded = unpaid.headers.get('payment-required');
  const challenge = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : null;
  const accepted = challenge?.accepts?.[0];
  const invalid = await fetch(endpoint, {
    headers: { 'PAYMENT-SIGNATURE': 'invalid' }, signal: AbortSignal.timeout(90000)
  });
  const invalidBody = await invalid.text();
  const result = {
    endpoint: endpoint.href, dns_addresses: addresses.map((item) => item.address),
    health_status: healthResponse.status, health, health_ms: healthMs,
    unpaid_status: unpaid.status, invalid_proof_status: invalid.status,
    paid_data_leaked: unpaidBody.includes('source_url') || invalidBody.includes('source_url'),
    challenge: accepted && {
      version: challenge.x402Version, resource_url: challenge.resource?.url,
      scheme: accepted.scheme, network: accepted.network, asset: accepted.asset,
      amount: accepted.amount, payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds
    }
  };
  console.log(JSON.stringify(result, null, 2));
  if (healthResponse.status !== 200 || health.payment_ready !== true || unpaid.status !== 402 ||
      invalid.status !== 402 || result.paid_data_leaked || !accepted ||
      challenge.x402Version !== 2 || challenge.resource?.url !== endpoint.href ||
      accepted.scheme !== 'exact' || accepted.network !== NETWORK ||
      accepted.asset?.toLowerCase() !== USDC || accepted.amount !== '5000' ||
      accepted.payTo?.toLowerCase() !== expectedPayTo.toLowerCase() ||
      accepted.maxTimeoutSeconds !== 60) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
