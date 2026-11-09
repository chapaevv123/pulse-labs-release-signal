const { analyzeRelease } = require('./signal');

function createGitHubReader({ fetchImpl = fetch, now = () => Date.now(), maxCallsPerHour = 40 } = {}) {
  const cache = new Map();
  const calls = [];
  async function read(input) {
    const key = `${input.owner.toLowerCase()}/${input.repo.toLowerCase()}/${input.tag}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    while (calls.length && calls[0] <= now() - 3600000) calls.shift();
    if (calls.length >= maxCallsPerHour) throw Object.assign(new Error('GitHub request budget exhausted'), { status: 429 });
    calls.push(now());
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/releases/tags/${encodeURIComponent(input.tag)}`;
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pulse-labs-release-signal/1' },
        signal: AbortSignal.timeout(6000), redirect: 'error'
      });
    } catch {
      throw Object.assign(new Error('GitHub unavailable or timed out'), { status: 503 });
    }
    if (response.status === 404) throw Object.assign(new Error('Public release not found'), { status: 404 });
    if (response.status === 403 || response.status === 429) throw Object.assign(new Error('GitHub rate limit reached'), { status: 503 });
    if (!response.ok) throw Object.assign(new Error('GitHub upstream error'), { status: 503 });
    const contentLength = Number(response.headers.get('content-length'));
    if (contentLength > 262144) throw Object.assign(new Error('GitHub release response too large'), { status: 502 });
    if (!response.body) throw Object.assign(new Error('Empty GitHub response'), { status: 502 });
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 262144) throw new Error('too large');
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('GitHub release response too large or interrupted'), { status: 502 });
    }
    let release;
    try { release = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid GitHub JSON'), { status: 502 }); }
    const value = analyzeRelease(release, input, new Date(now()).toISOString());
    cache.set(key, { value, expires: now() + 120000 });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  }
  return { read };
}

module.exports = { createGitHubReader };
