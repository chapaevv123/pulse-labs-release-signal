const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

test('PORT binds on 0.0.0.0 even if HOST is set to loopback', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      RENDER_EXTERNAL_HOSTNAME: 'test.onrender.com', X402_ENABLE_PAYMENTS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server startup timeout: ${output}`)), 5000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes(`Listening on 0.0.0.0:${port};`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}: ${output}`));
      });
    });
    assert.match(output, new RegExp(`Listening on 0\\.0\\.0\\.0:${port};`));
  } finally {
    child.kill();
  }
});
