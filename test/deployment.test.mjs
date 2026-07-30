import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps the canonical audit intent on the root URL', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const auditRedirect = config.redirects?.find((entry) => entry.source === '/audit');
  const auditSlashRedirect = config.redirects?.find((entry) => entry.source === '/audit/');

  assert.deepEqual(auditRedirect, {
    source: '/audit',
    destination: '/',
    permanent: true,
  });
  assert.deepEqual(auditSlashRedirect, {
    source: '/audit/',
    destination: '/',
    permanent: true,
  });

  const sitemap = await readFile(new URL('../sitemap.xml', import.meta.url), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/optimize\.suedeai\.ai\/<\/loc>/);
  assert.doesNotMatch(sitemap, /optimize\.suedeai\.ai\/audit/);
});

test('traces every public asset into the Vercel root function', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

  assert.equal(pkg.scripts.dev, 'node server.mjs');
  await access(new URL('../server.mjs', import.meta.url));

  for (const asset of ['index.html', 'styles.css', 'client.js', 'robots.txt', 'llms.txt', 'sitemap.xml']) {
    const body = await readFile(new URL(`../${asset}`, import.meta.url), 'utf8');
    assert.ok(body.length > 20, `${asset} should be a non-empty production asset`);
    assert.match(server, new RegExp(`new URL\\('\\./${asset.replace('.', '\\.')}\\', import\\.meta\\.url\\)`));
  }

  const ogImage = await readFile(new URL('../og-suede-audit.png', import.meta.url));
  assert.deepEqual(ogImage.subarray(0, 8), Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));
  assert.equal(ogImage.readUInt32BE(16), 1200);
  assert.equal(ogImage.readUInt32BE(20), 630);
  assert.ok(ogImage.byteLength < 250_000, 'OG image should stay compressed below 250 KB');
  assert.match(server, /new URL\('\.\/og-suede-audit\.png', import\.meta\.url\)/);
  assert.match(server, /\['\/og-suede-audit\.png', \[OG_IMAGE_PNG, 'image\/png'\]\]/);
});

test('serves HEAD requests through the same public routes as GET', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

  assert.match(server, /req\.method === 'GET' \|\| req\.method === 'HEAD'/);
  assert.match(server, /req\.method === 'HEAD' \? undefined : body/);
});

test('uses one local 1200x630 social card across every public audit document', async () => {
  const imageUrl = 'https://optimize.suedeai.ai/og-suede-audit.png';
  const legacyLogoUrl = 'https://raw.githubusercontent.com/JasonColapietro/suede-creator-skills/cbd192309580a32da375881e0eeb4b2450a554c2/docs/assets/suede-ai-logo-transparent.png';

  for (const page of ['index.html', 'method.html', 'privacy.html']) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');

    assert.match(html, new RegExp(`<meta property="og:image" content="${imageUrl.replaceAll('.', '\\.')}">`));
    assert.match(html, /<meta property="og:image:width" content="1200">/);
    assert.match(html, /<meta property="og:image:height" content="630">/);
    assert.match(html, /<meta property="og:image:type" content="image\/png">/);
    assert.match(html, new RegExp(`<meta name="twitter:image" content="${imageUrl.replaceAll('.', '\\.')}">`));
    assert.match(html, new RegExp(`<link rel="icon" href="${legacyLogoUrl.replaceAll('.', '\\.')}">`));
    assert.match(html, new RegExp(`<img src="${legacyLogoUrl.replaceAll('.', '\\.')}" alt="" width="36" height="36">`));
  }
});
