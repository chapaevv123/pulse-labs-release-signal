const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, supported, validPrice, malformedPaymentHeader, USDC } = require('../src/app');
const { validateQuery, analyzeRelease } = require('../src/signal');
const { createGitHubReader } = require('../src/github');

const payTo = '0x1111111111111111111111111111111111111111';
const enabledEnv = { X402_PAY_TO: payTo, X402_ENABLE_PAYMENTS: '1' };
const release = {
  id: 123, tag_name: 'v1.2.3', name: 'Version 1.2.3', published_at: '2026-11-08T12:00:00Z',
  draft: false, prerelease: false, body: 'Security fix for CVE-2026-12345. Added a new feature.',
  html_url: 'https://github.com/example/project/releases/tag/v1.2.3'
};
const response = () => new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
const capabilities = { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: { 'eip155:*': ['0x2222222222222222222222222222222222222222'] } };
const capabilityStub = { getSupported: async () => capabilities, verify: async () => { throw new Error('Must not verify'); }, settle: async () => { throw new Error('Must not settle'); } };

async function withServer(options, fn) {
  const { app, state } = await createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`, state); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const path = '/v1/github/release-signal?owner=example&repo=project&tag=v1.2.3';

test('validates bounded owner, repo and tag', () => {
  assert.deepEqual(validateQuery({ owner: 'example', repo: 'project', tag: 'v1.2.3' }), { owner: 'example', repo: 'project', tag: 'v1.2.3' });
  for (const bad of [
    { owner: '..', repo: 'project', tag: 'v1.2.3' },
    { owner: 'example', repo: '../vault', tag: 'v1.2.3' },
    { owner: 'example', repo: 'project', tag: 'https://evil.test' },
    { owner: 'example', repo: 'project', tag: ['v1', 'v2'] }
  ]) assert.throws(() => validateQuery(bad), { status: 400 });
});

test('deterministic source-linked evidence and limits', () => {
  const result = analyzeRelease(release, { owner: 'example', repo: 'project', tag: 'v1.2.3' }, '2026-11-09T00:00:00Z');
  assert.equal(result.verdict, 'INVESTIGATE');
  assert.equal(result.source_url, release.html_url);
  assert.ok(result.evidence.some((item) => item.signal === 'security_fix'));
  assert.ok(result.limitations.length > 0);
});

test('rejects mismatched GitHub source', () => {
  assert.throws(() => analyzeRelease({ ...release, html_url: 'https://evil.test/release' }, { owner: 'example', repo: 'project', tag: 'v1.2.3' }, 'now'), { status: 502 });
});

test('strict facilitator capability check', () => {
  assert.equal(supported(capabilities), true);
  assert.equal(supported({ supportedNetworks: [{ networkId: 'eip155:8453', version: 'v2' }] }), false);
  assert.equal(supported({ kinds: [{ x402Version: 1, scheme: 'exact', network: 'eip155:8453' }] }), false);
  assert.equal(supported({ kinds: [{ x402Version: 2, scheme: 'upto', network: 'eip155:8453' }] }), false);
  assert.equal(supported({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }] }), false);
  assert.equal(supported({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: { asset: '0x0000000000000000000000000000000000000001' } }] }), false);
});

test('price is pinned to 0.005 USDC', () => {
  assert.equal(validPrice('$0.005'), true);
  for (const price of ['$0.001', '$0.05', '$0.005001', '0.005']) assert.equal(validPrice(price), false);
});

test('malformed payment signatures are identified without logging their content', () => {
  assert.equal(malformedPaymentHeader('invalid'), true);
  assert.equal(malformedPaymentHeader(Buffer.from('{"secret":"SENSITIVE_PROOF_MARKER"').toString('base64')), true);
  assert.equal(malformedPaymentHeader(Buffer.from('{}').toString('base64')), false);
});

test('missing payout keeps paid output closed', async () => {
  await withServer({ env: {}, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base, state) => {
    assert.equal(state.payment_ready, false);
    const result = await fetch(base + path);
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error, 'payment_unavailable');
  });
});

test('payments remain disabled by default even with payout configured', async () => {
  await withServer({ env: { X402_PAY_TO: payTo }, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base, state) => {
    assert.equal(state.payment_ready, false);
    assert.equal((await fetch(base + path)).status, 503);
  });
});

test('unavailable facilitator keeps paid output closed', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: { getSupported: async () => { throw new Error('offline'); } } }, async (base) => {
    const result = await fetch(base + path);
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error, 'payment_unavailable');
    assert.equal((await fetch(base + '/ready')).status, 503);
  });
});

test('official middleware responds 402 without payment when capabilities are supplied by test stub', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base, state) => {
    assert.equal(state.payment_ready, true);
    assert.equal((await fetch(base + '/ready')).status, 200);
    const result = await fetch(base + path);
    assert.equal(result.status, 402);
    const header = result.headers.get('payment-required');
    assert.ok(header);
    const challenge = JSON.parse(Buffer.from(header, 'base64').toString());
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts[0].scheme, 'exact');
    assert.equal(challenge.accepts[0].network, 'eip155:8453');
    assert.equal(challenge.accepts[0].asset.toLowerCase(), USDC);
    assert.equal(challenge.accepts[0].amount, '5000');
    assert.equal(challenge.accepts[0].payTo, payTo);
    assert.equal(challenge.accepts[0].maxTimeoutSeconds, 60);
    assert.equal((await result.text()).includes('source_url'), false);
  });
});

test('HTTPS reverse proxy scheme is reflected in the payment resource', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base) => {
    const result = await fetch(base + path, { headers: { Host: 'api.example.com', 'X-Forwarded-Proto': 'https' } });
    assert.equal(result.status, 402);
    const challenge = JSON.parse(Buffer.from(result.headers.get('payment-required'), 'base64').toString());
    assert.equal(challenge.resource.url, `https://${new URL(base).host}${path}`);
  });
});

test('public host rejects wrong host and non-HTTPS requests', async () => {
  await withServer({ env: { ...enabledEnv, PUBLIC_HOST: 'api.example.com' }, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base) => {
    assert.equal((await fetch(base + path)).status, 400);
    const request = (proto) => new Promise((resolve, reject) => {
      const outbound = http.get(base + path, { headers: { Host: 'api.example.com', 'X-Forwarded-Proto': proto } }, (incoming) => {
        incoming.resume();
        incoming.on('end', () => resolve(incoming));
      });
      outbound.on('error', reject);
    });
    assert.equal((await request('http')).statusCode, 400);
    const secure = await request('https');
    assert.equal(secure.statusCode, 402);
    const challenge = JSON.parse(Buffer.from(secure.headers['payment-required'], 'base64').toString());
    assert.equal(challenge.resource.url, `https://api.example.com${path}`);
  });
});

test('malformed proof never returns paid result', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base) => {
    const result = await fetch(base + path, { headers: { 'PAYMENT-SIGNATURE': 'invalid' } });
    assert.notEqual(result.status, 200);
    assert.equal((await result.text()).includes('source_url'), false);
  });
});

test('malformed proof bytes do not reach SDK logs', async () => {
  const marker = 'SENSITIVE_PROOF_MARKER';
  const badHeader = Buffer.from(`{"secret":"${marker}"`).toString('base64');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base) => {
      const result = await fetch(base + path, { headers: { 'PAYMENT-SIGNATURE': badHeader } });
      assert.equal(result.status, 402);
      assert.equal((await result.text()).includes('source_url'), false);
    });
  } finally { console.warn = originalWarn; }
  assert.equal(warnings.join(' ').includes(marker), false);
});

test('HEAD cannot bypass the GET payment gate', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base) => {
    const result = await fetch(base + path, { method: 'HEAD' });
    assert.notEqual(result.status, 200);
    assert.equal(result.headers.get('payment-response'), null);
  });
});

test('facilitator verify failure after startup never returns paid result', async () => {
  const failingClient = {
    getSupported: async () => capabilities,
    verify: async () => { throw new Error('facilitator offline'); },
    settle: async () => { throw new Error('settle must not run'); }
  };
  await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: failingClient }, async (base) => {
    const unpaid = await fetch(base + path);
    const challenge = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString());
    const payment = { x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { signature: '0x00', authorization: {} } };
    const denied = await fetch(base + path, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') } });
    assert.notEqual(denied.status, 200);
    assert.equal((await denied.text()).includes('source_url'), false);
  });
});

test('settlement failure cannot release buffered paid JSON', async () => {
  let verifyCalls = 0;
  let settleCalls = 0;
  const client = {
    getSupported: async () => capabilities,
    verify: async () => { verifyCalls++; return { isValid: true }; },
    settle: async () => { settleCalls++; throw new Error('settlement unavailable'); }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await withServer({ env: enabledEnv, fetchImpl: async () => response(), facilitatorClient: client }, async (base) => {
      const unpaid = await fetch(base + path);
      const challenge = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString());
      const payment = { x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { signature: '0x00', authorization: {} } };
      const denied = await fetch(base + path, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') } });
      assert.notEqual(denied.status, 200);
      assert.equal((await denied.text()).includes('source_url'), false);
    });
  } finally { console.error = originalError; }
  assert.equal(verifyCalls, 1);
  assert.equal(settleCalls, 1);
});

test('validation and GitHub errors occur before payment', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => new Response('{}', { status: 404 }), facilitatorClient: capabilityStub }, async (base) => {
    assert.equal((await fetch(base + path.replace('owner=example', 'owner=..'))).status, 400);
    assert.equal((await fetch(base + path)).status, 404);
  });
});

test('GitHub upstream failures never expose the result or issue a payment challenge', async () => {
  for (const [upstream, expected] of [[403, 503], [429, 503], [500, 503]]) {
    await withServer({ env: enabledEnv, fetchImpl: async () => new Response('{}', { status: upstream }), facilitatorClient: capabilityStub }, async (base) => {
      const result = await fetch(base + path);
      assert.equal(result.status, expected);
      assert.equal(result.headers.get('payment-required'), null);
      assert.equal((await result.text()).includes('source_url'), false);
    });
  }
});

test('client and GitHub request budgets limit abuse', async () => {
  await withServer({ env: {}, fetchImpl: async () => response(), facilitatorClient: capabilityStub }, async (base) => {
    let last;
    for (let i = 0; i < 31; i++) last = await fetch(base + path);
    assert.equal(last.status, 429);
  });
  let calls = 0;
  const reader = createGitHubReader({ maxCallsPerHour: 1, fetchImpl: async () => { calls++; return new Response('{}', { status: 404 }); } });
  await assert.rejects(reader.read({ owner: 'a', repo: 'b', tag: 'v1' }), { status: 404 });
  await assert.rejects(reader.read({ owner: 'a', repo: 'b', tag: 'v1' }), { status: 429 });
  assert.equal(calls, 1);
});

test('oversized GitHub response fails before payment', async () => {
  await withServer({ env: enabledEnv, fetchImpl: async () => new Response('x'.repeat(262145)), facilitatorClient: capabilityStub }, async (base) => {
    assert.equal((await fetch(base + path)).status, 502);
  });
});
