// Read-only local HTTP preflight. Never constructs or submits a payment authorization.
const { createApp, USDC, NETWORK } = require('../src/app');

async function main() {
  if (!process.env.X402_PAY_TO) throw new Error('Set X402_PAY_TO only in this PowerShell session');
  const { app, state } = await createApp({ env: {
    X402_PAY_TO: process.env.X402_PAY_TO,
    X402_ENABLE_PAYMENTS: '1',
    X402_PRICE: '$0.005'
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/v1/github/release-signal?owner=nodejs&repo=node&tag=v22.0.0`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    const unpaid = await fetch(endpoint);
    const body = await unpaid.text();
    const encoded = unpaid.headers.get('payment-required');
    const challenge = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : null;
    const accepted = challenge?.accepts?.[0];
    const invalid = await fetch(endpoint, { headers: { 'PAYMENT-SIGNATURE': 'invalid' } });
    const invalidBody = await invalid.text();
    const result = {
      endpoint, health, unpaid_status: unpaid.status,
      challenge: accepted && {
        version: challenge.x402Version, scheme: accepted.scheme, network: accepted.network,
        asset: accepted.asset, amount: accepted.amount, payTo: accepted.payTo,
        maxTimeoutSeconds: accepted.maxTimeoutSeconds
      },
      invalid_proof_status: invalid.status,
      paid_data_leaked: body.includes('source_url') || invalidBody.includes('source_url')
    };
    console.log(JSON.stringify(result, null, 2));
    if (!state.payment_ready || unpaid.status !== 402 || !accepted || result.paid_data_leaked ||
        challenge.x402Version !== 2 || accepted.scheme !== 'exact' || accepted.network !== NETWORK ||
        accepted.asset.toLowerCase() !== USDC || accepted.amount !== '5000' ||
        accepted.payTo.toLowerCase() !== process.env.X402_PAY_TO.toLowerCase() || invalid.status === 200) {
      process.exitCode = 1;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
