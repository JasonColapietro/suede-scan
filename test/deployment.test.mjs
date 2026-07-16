import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('keeps the canonical audit intent on the root URL', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const auditRedirect = config.redirects?.find((entry) => entry.source === '/audit');

  assert.deepEqual(auditRedirect, {
    source: '/audit',
    destination: '/',
    permanent: true,
  });

  const sitemap = await readFile(new URL('../sitemap.xml', import.meta.url), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/audit\.suedeai\.ai\/<\/loc>/);
  assert.doesNotMatch(sitemap, /audit\.suedeai\.ai\/audit/);
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
});
