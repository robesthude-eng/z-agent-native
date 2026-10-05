import assert from 'node:assert/strict';
import test from 'node:test';

const { decodeHtmlEntities, htmlToReadableText, looksLikeHtml } = await import('../server/native/html-text.mjs');

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Node.js &mdash; Download</title>
<meta name="description" content="Get Node.js &amp; npm"><link rel="preload" href="/font.woff2"><script>window.secret = "x"</script>
<style>body { color: red }</style></head><body><header><nav><a href="/en">Home</a></nav></header>
<main><h1>Download Node.js&reg;</h1><p>Get the <strong>LTS</strong> version: <a href="/dist/v24.21.0/">v24.21.0</a> &lt;Krypton&gt;</p>
<ul><li>Linux</li><li>macOS</li><li></li></ul>
<table><tr><th>Version</th><th>Date</th></tr><tr><td>v24.21.0</td><td>2026-09-07</td></tr></table>
<pre><code>fnm install 24
node -v</code></pre><pre></pre>
<p>Literal &amp;lt; stays escaped, emoji &#x1F600; and dash &#8212; decode. This paragraph is long enough for the main element to be preferred over the page chrome.</p>
<button>Copy</button></main><footer>© OpenJS</footer></body></html>`;

test('HTML pages become readable text with structure, links and no head boilerplate', () => {
  const page = htmlToReadableText(PAGE, { baseUrl: 'https://nodejs.org/en/download' });
  assert.equal(page.title, 'Node.js — Download');
  assert.equal(page.description, 'Get Node.js & npm');
  assert.match(page.text, /^# Download Node\.js®/);
  assert.match(page.text, /\[v24\.21\.0\]\(https:\/\/nodejs\.org\/dist\/v24\.21\.0\/\) <Krypton>/);
  assert.match(page.text, /- Linux\n- macOS\n/);
  assert.match(page.text, /Version \| Date\nv24\.21\.0 \| 2026-09-07/);
  assert.match(page.text, /```\nfnm install 24\nnode -v\n```/);
  assert.match(page.text, /Literal &lt; stays escaped, emoji 😀 and dash — decode/);
  assert.doesNotMatch(page.text, /window\.secret|color: red|font\.woff2|Copy|OpenJS|Home/);
  assert.doesNotMatch(page.text, /```\n\n```/, 'empty <pre> blocks are dropped');
  assert.doesNotMatch(page.text, /\n-\n/, 'empty list items are dropped');
});

test('content type decides whether webfetch extracts text', () => {
  assert.equal(looksLikeHtml('text/html; charset=utf-8', ''), true);
  assert.equal(looksLikeHtml('application/xhtml+xml', ''), true);
  assert.equal(looksLikeHtml('application/json', '<!doctype html>'), false);
  assert.equal(looksLikeHtml('', '  <!DOCTYPE html><html>'), true);
  assert.equal(looksLikeHtml('', '{"version":"v24"}'), false);
  assert.equal(decodeHtmlEntities('&amp;lt; &unknown; &#0; &#x41;'), '&lt; &unknown;  A');
});

test('webfetch returns extracted text for HTML, raw markup on request and JSON as-is', async () => {
  const previousNetworkPolicy = process.env.Z_AGENT_NETWORK_POLICY;
  process.env.Z_AGENT_NETWORK_POLICY = 'public';
  const { setExternalTransportForTests } = await import('../server/native/security.mjs');
  const { executeWebFetch } = await import('../server/native/tools/web.mjs');
  const bodies = {
    '/page': { type: 'text/html; charset=utf-8', text: PAGE },
    '/spa': { type: 'text/html', text: `<!doctype html><html><head><title>App</title>${'<link rel="preload" href="/x.js">'.repeat(300)}</head><body><div id="root"></div></body></html>` },
    '/data.json': { type: 'application/json', text: '{"lts":"v24"}' },
  };
  setExternalTransportForTests(async ({ url }) => {
    const body = bodies[new URL(String(url)).pathname];
    return { url, status: 200, headers: { 'content-type': body.type }, text: body.text, truncated: false };
  });
  try {
    const page = await executeWebFetch({ url: 'https://1.1.1.1/page' });
    assert.equal(page.title, 'Node.js — Download');
    assert.match(page.output, /^# Node\.js — Download\n\n> Get Node\.js & npm\n\n# Download Node\.js®/);
    assert.doesNotMatch(page.output, /<script|<link|window\.secret/);

    const raw = await executeWebFetch({ url: 'https://1.1.1.1/page', format: 'html' });
    assert.match(raw.output, /^<!DOCTYPE html>/);

    const spa = await executeWebFetch({ url: 'https://1.1.1.1/spa' });
    assert.match(spa.output, /rendered by JavaScript/);

    const json = await executeWebFetch({ url: 'https://1.1.1.1/data.json' });
    assert.equal(json.output, '{"lts":"v24"}');

    const short = await executeWebFetch({ url: 'https://1.1.1.1/page', maxChars: 1000 });
    assert.ok(short.output.length < 1200);
  } finally {
    setExternalTransportForTests(null);
    if (previousNetworkPolicy == null) delete process.env.Z_AGENT_NETWORK_POLICY; else process.env.Z_AGENT_NETWORK_POLICY = previousNetworkPolicy;
  }
});
