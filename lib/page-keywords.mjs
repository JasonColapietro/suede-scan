// Central keyword map for every indexable static page (meta name="keywords").
// Terms come from measured search research (~/seo keywords report, geo_practice
// group) and match what each page actually covers. Brand terms are appended to
// every list; duplicates are removed case-insensitively.
// test/keywords.test.mjs fails if an indexable page drifts from this map.

export const BRAND_KEYWORDS = ['Suede AI', 'Suede Audit'];

export const PAGE_KEYWORDS = {
  'index.html': [
    'ai visibility audit',
    'free AI SEO audit',
    'AI search visibility checker',
    'generative engine optimization',
    'answer engine optimization',
    'GEO audit',
    'AI crawler access',
    'robots.txt AI crawlers',
    'llms.txt checker',
    'schema markup audit',
    'SEO readiness score',
  ],
  'method.html': [
    'ai visibility audit methodology',
    'AI readiness score',
    'SEO audit scoring',
    'generative engine optimization',
    'answer engine optimization',
    'AI crawler access',
    'robots.txt',
    'llms.txt',
    'sitemap.xml',
    'entity schema',
  ],
  'privacy.html': [
    'Suede Audit privacy policy',
    'ai visibility audit privacy',
    'website audit data handling',
    'SEO audit privacy',
  ],
};

export function keywordsFor(page) {
  const terms = PAGE_KEYWORDS[page];
  if (!terms) throw new Error(`No keyword list for ${page}`);
  const seen = new Set();
  return [...terms, ...BRAND_KEYWORDS].filter((term) => {
    const key = term.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function keywordsContent(page) {
  return keywordsFor(page).join(', ');
}
