// Central keyword map for every indexable static page (meta name="keywords").
// Terms come from measured search research (~/seo keywords report, geo_practice
// group) and match what each page actually covers. Brand terms are appended to
// every list; duplicates are removed case-insensitively.
// test/keywords.test.mjs fails if an indexable page drifts from this map.

export const BRAND_KEYWORDS = ['Suede AI', 'Suede Audit'];

export const PAGE_KEYWORDS = {
  "ai-instructions.html": ["AI instructions", "official sources", "citation guidance"],
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
  'checks/index.html': [
    'SEO audit checklist',
    'AI visibility audit checks',
    'AI readiness score',
    'audit scoring weights',
    'robots.txt',
    'JSON-LD',
    'sitemap.xml',
    'llms.txt',
  ],
  'checks/page-access.html': [
    'HTTP status code SEO',
    'HTTPS',
    'noindex',
    'canonical tag',
    'viewport meta tag',
    'html lang attribute',
    'HTML page size',
  ],
  'checks/crawler-access.html': [
    'AI crawler access',
    'robots.txt AI crawlers',
    'OAI-SearchBot',
    'Claude-SearchBot',
    'PerplexityBot',
    'Googlebot',
    'GPTBot',
    'ClaudeBot',
    'Google-Extended',
    'RFC 9309',
  ],
  'checks/discovery-files.html': [
    'robots.txt',
    'sitemap.xml',
    'llms.txt',
    'XML sitemap',
    'sitemap index',
    'llms.txt checker',
  ],
  'checks/structured-data.html': [
    'JSON-LD',
    'schema markup audit',
    'Organization schema',
    'sameAs',
    'entity schema',
    'structured data',
  ],
  'checks/metadata.html': [
    'title tag length',
    'meta description length',
    'Open Graph tags',
    'twitter:card',
    'favicon',
  ],
  'checks/content-structure.html': [
    'H1 tag',
    'H2 headings',
    'content depth',
    'internal links',
    'image alt text',
    'server-side rendering',
  ],
  'checks/retrieval-chunks.html': [
    'retrieval chunk size',
    'content chunking',
    'passage retrieval',
    'answer engine optimization',
    'generative engine optimization',
    'heading sections',
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
