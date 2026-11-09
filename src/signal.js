const RULE_VERSION = 'github-release-signal-1';

function validateQuery(query) {
  const keys = Object.keys(query);
  if (keys.length !== 3 || !['owner', 'repo', 'tag'].every((key) => keys.includes(key))) {
    throw Object.assign(new Error('Expected owner, repo and tag only'), { status: 400 });
  }
  const { owner, repo, tag } = query;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || owner.includes('--')) {
    throw Object.assign(new Error('Invalid GitHub owner'), { status: 400 });
  }
  if (typeof repo !== 'string' || repo.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') {
    throw Object.assign(new Error('Invalid GitHub repository'), { status: 400 });
  }
  if (typeof tag !== 'string' || tag.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(tag) || tag.includes('..') || tag.includes('//')) {
    throw Object.assign(new Error('Invalid release tag'), { status: 400 });
  }
  return { owner, repo, tag };
}

function analyzeRelease(release, requested, retrievedAt) {
  if (!release || !Number.isSafeInteger(release.id) || release.tag_name !== requested.tag ||
      typeof release.html_url !== 'string' || typeof release.published_at !== 'string' ||
      typeof release.body !== 'string') {
    throw Object.assign(new Error('GitHub release response is incomplete'), { status: 502 });
  }
  const source = `https://github.com/${requested.owner}/${requested.repo}/releases/tag/${encodeURIComponent(requested.tag)}`;
  let parsed;
  try { parsed = new URL(release.html_url); }
  catch { throw Object.assign(new Error('Invalid GitHub release source URL'), { status: 502 }); }
  if (parsed.origin !== 'https://github.com' || parsed.pathname.toLowerCase() !== new URL(source).pathname.toLowerCase()) {
    throw Object.assign(new Error('GitHub release source mismatch'), { status: 502 });
  }
  const body = release.body.slice(0, 30000);
  const rules = [
    ['security_fix', /\b(?:security|vulnerabilit(?:y|ies)|CVE-\d{4}-\d{4,})\b/i],
    ['breaking_change', /\b(?:breaking change|migration required|incompatible)\b/i],
    ['deprecation', /\b(?:deprecat(?:ed|ion)|end of support)\b/i],
    ['new_feature', /\b(?:new feature|added|introduc(?:ed|ing))\b/i],
    ['bug_fix', /\b(?:bug fix|fixed|fixes)\b/i],
  ];
  const evidence = rules.flatMap(([signal, pattern]) => {
    const match = pattern.exec(body);
    if (!match) return [];
    const start = Math.max(0, match.index - 70);
    return [{ signal, excerpt: body.slice(start, Math.min(body.length, match.index + match[0].length + 100)).replace(/\s+/g, ' ').trim() }];
  });
  const signals = evidence.map((item) => item.signal);
  let verdict = 'UNKNOWN';
  if (release.draft || release.prerelease) verdict = 'WATCH';
  else if (signals.includes('security_fix') || signals.includes('breaking_change')) verdict = 'INVESTIGATE';
  else if (signals.length) verdict = 'WATCH';
  return {
    source_url: release.html_url,
    retrieved_at: retrievedAt,
    release: { id: release.id, tag: release.tag_name, name: typeof release.name === 'string' ? release.name.slice(0, 200) : '', published_at: release.published_at, draft: Boolean(release.draft), prerelease: Boolean(release.prerelease) },
    verdict, signals, evidence, rule_version: RULE_VERSION,
    limitations: [
      'Keyword matches describe release notes only; they do not establish severity, safety, or financial value.',
      'Absence of a signal does not prove absence of a change.',
      'Only the public GitHub release and the first 30000 characters of its notes were analyzed.'
    ]
  };
}

module.exports = { validateQuery, analyzeRelease };
