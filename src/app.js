const express = require('express');
const { paymentMiddleware } = require('@x402/express');
const { x402ResourceServer, HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { validateQuery } = require('./signal');
const { createGitHubReader } = require('./github');

const NETWORK = 'eip155:8453';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const FACILITATOR = 'https://facilitator.xpay.sh';

function validPayout(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
}

function validPrice(value) {
  return value === '$0.005';
}

function supported(response) {
  return Array.isArray(response?.kinds) && response.kinds.some((kind) =>
    kind.x402Version === 2 && kind.scheme === 'exact' && kind.network === NETWORK &&
    (kind.extra?.asset === undefined ||
      (typeof kind.extra.asset === 'string' && kind.extra.asset.toLowerCase() === USDC)));
}

function malformedPaymentHeader(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return true;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return !decoded || typeof decoded !== 'object' || Array.isArray(decoded);
  } catch {
    return true;
  }
}

async function createApp({ env = process.env, fetchImpl = fetch, facilitatorClient, now = () => Date.now() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const publicHost = env.PUBLIC_HOST || env.RENDER_EXTERNAL_HOSTNAME;
  if (publicHost && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(publicHost)) throw new Error('Invalid PUBLIC_HOST');
  app.set('trust proxy', publicHost ? 1 : 'loopback');
  const payTo = env.X402_PAY_TO;
  const price = env.X402_PRICE || '$0.005';
  const state = { payment_ready: false, reason: 'Facilitator capability not confirmed' };
  if (env.X402_ENABLE_PAYMENTS !== '1') state.reason = 'Payments disabled by server configuration';
  else if (!validPayout(payTo)) state.reason = 'Valid X402_PAY_TO is required';
  else if (!validPrice(price)) state.reason = 'Invalid X402_PRICE';
  const client = facilitatorClient || new HTTPFacilitatorClient({ url: FACILITATOR, timeoutMs: 7000 });
  let resourceServer;
  let pricedAsset;
  if (env.X402_ENABLE_PAYMENTS === '1' && validPayout(payTo) && validPrice(price)) {
    try {
      const capabilities = await client.getSupported();
      if (!supported(capabilities)) state.reason = 'Facilitator did not confirm x402 v2 exact Base';
      else {
        const scheme = new ExactEvmScheme();
        pricedAsset = await scheme.parsePrice(price, NETWORK);
        if (pricedAsset.asset.toLowerCase() !== USDC || !/^[1-9][0-9]*$/.test(pricedAsset.amount)) {
          state.reason = 'SDK did not resolve canonical Base USDC';
        } else {
          resourceServer = new x402ResourceServer(client).register(NETWORK, scheme);
          await resourceServer.initialize();
          state.payment_ready = true;
          state.reason = null;
        }
      }
    } catch {
      state.reason = 'Facilitator unavailable or incompatible';
    }
  }
  const github = createGitHubReader({ fetchImpl, now });
  const limits = new Map();
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (publicHost && req.headers.host !== publicHost) return res.status(400).json({ error: 'invalid_host' });
    if (publicHost && req.path === '/v1/github/release-signal' && req.get('x-forwarded-proto') !== 'https') {
      return res.status(400).json({ error: 'https_required' });
    }
    const declaredSize = Number(req.get('content-length') || 0);
    if (req.originalUrl.length > 512 || !Number.isSafeInteger(declaredSize) || declaredSize > 1024 ||
        (req.path === '/v1/github/release-signal' && req.get('transfer-encoding')) ||
        (req.get('payment-signature') || '').length > 16384 || (req.get('x-payment') || '').length > 16384) {
      return res.status(413).json({ error: 'request_too_large' });
    }
    // The SDK logs JSON decode errors, which can echo attacker-controlled proof bytes.
    // Treat malformed headers as absent so its normal unpaid 402 path handles the request.
    if (req.headers['payment-signature'] && malformedPaymentHeader(req.headers['payment-signature'])) {
      delete req.headers['payment-signature'];
    }
    if (req.path === '/v1/github/release-signal' && req.method === 'GET') {
      const key = req.ip;
      const entry = limits.get(key) || { start: now(), count: 0 };
      if (now() - entry.start >= 60000) { entry.start = now(); entry.count = 0; }
      entry.count++;
      limits.set(key, entry);
      if (limits.size > 10000) limits.clear();
      if (entry.count > 30) return res.status(429).json({ error: 'client_rate_limited' });
    }
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', payment_ready: state.payment_ready, reason: state.reason }));
  app.get('/ready', (_req, res) => res.status(state.payment_ready ? 200 : 503).json({ payment_ready: state.payment_ready }));
  app.get('/v1/github/release-signal', async (req, res, next) => {
    try {
      req.releaseInput = validateQuery(req.query);
      // Confirm availability before offering a charge; cache the exact result for this request.
      req.releaseResult = await github.read(req.releaseInput);
      next();
    } catch (error) { next(error); }
  });
  app.get('/v1/github/release-signal', (req, res, next) => {
    if (!state.payment_ready) return res.status(503).json({ error: 'payment_unavailable', detail: state.reason });
    next();
  });
  if (state.payment_ready) {
    app.use(paymentMiddleware({
      'GET /v1/github/release-signal': {
        accepts: [{ scheme: 'exact', network: NETWORK, price: pricedAsset, payTo, maxTimeoutSeconds: 60 }],
        description: 'Source-linked analysis of one public GitHub release', mimeType: 'application/json'
      }
    }, resourceServer, undefined, undefined, false));
  }
  app.get('/v1/github/release-signal', (req, res) => {
    // The official middleware buffers this response until its verify and settle complete.
    res.json(req.releaseResult);
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal_error' : error.message });
  });
  return { app, state };
}

module.exports = { createApp, supported, validPayout, validPrice, malformedPaymentHeader, NETWORK, USDC };
