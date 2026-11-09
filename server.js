const { createApp } = require('./src/app');

createApp().then(({ app, state }) => {
  const port = Number(process.env.PORT || 8402);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Invalid HOST');
  if (host === '0.0.0.0' && !process.env.RENDER_EXTERNAL_HOSTNAME && !process.env.PUBLIC_HOST) {
    throw new Error('Public binding requires PUBLIC_HOST');
  }
  app.listen(port, host, () => {
    console.log(`Listening on ${host}:${port}; payment_ready=${state.payment_ready}`);
  });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
