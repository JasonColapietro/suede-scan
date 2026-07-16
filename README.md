# Suede Scan

Public-site discovery and answer-readiness audit from Suede Labs AI.

Product URL: [audit.suedeai.ai](https://audit.suedeai.ai/).

## What it does

Enter a public URL and get a weighted audit of access, crawler policy, entity schema, metadata, content structure, internal evidence links, and response weight. The report shows every observed value and prioritizes repairs by impact.

Shareable `/report/<domain>` routes run a fresh audit when opened. Reports do not store client data.

## Claim boundary

The report inspects public HTML, `robots.txt`, `llms.txt`, and `sitemap.xml`. It does not run buyer prompts inside ChatGPT, Perplexity, Gemini, or another answer engine. A high readiness score does not guarantee citations, recommendations, or rankings.

## Stack

Node (`server.mjs`), a small `api/` layer, and a static HTML, CSS, and JavaScript front end. No framework build step.

## Run locally

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
node --check app.js
git diff --check
```
