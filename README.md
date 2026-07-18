# Suede Scan

Public-site discovery and answer-readiness audit from Suede Labs AI.

Product URL: [audit.suedeai.ai](https://audit.suedeai.ai/).

## What it does

Enter a public URL and get a weighted audit of access, crawler policy, entity schema, metadata, content structure, internal evidence links, and response weight. The report shows every observed value and prioritizes repairs by impact.

Each browser gets one free audit. Its result is cached locally for reopening, while Copy report creates a self-contained `/report/<domain>#report=...` link. The URL fragment carries a versioned snapshot of the already-rendered public report, is validated against the path domain, and is removed from the address bar after loading. Fragments are not sent to the server, so a first-time visitor can view the shared report and its company offer without spending their free audit. The server does not persist report contents.

Shared snapshots are base64url-encoded, not encrypted or signed; anyone who receives the link can read or change the public audit data it contains. Recipient pages therefore present these results as an unverified user-provided snapshot, not as a fresh or Suede-verified audit. Copy report refuses snapshots above the defined 48 KiB encoded limit instead of truncating JSON or silently falling back to a new audit. Older fragmentless `/report/<domain>` links never auto-run an audit: they show a prompt and let the visitor explicitly choose whether to spend their free audit.

## Abuse protection

The free audit is protected by a browser-local result gate, a one-year HttpOnly usage cookie, a bot-trap field, Fetch Metadata checks, in-process burst limiting, and Vercel Firewall challenge and rate-limit rules. The firewall is the durable request boundary; the browser controls make the one-audit policy explicit and preserve the saved result.

## Claim boundary

The report inspects public HTML, `robots.txt`, `llms.txt`, and `sitemap.xml`. It does not run buyer prompts inside ChatGPT, Perplexity, Gemini, or another answer engine. A high readiness score does not guarantee citations, recommendations, or rankings.

## Stack

Node (`server.mjs`) serves the static HTML, CSS, JavaScript, and crawl files alongside the small audit API. The public assets are loaded through literal file URLs so Vercel includes them in the production function bundle. No framework build step.

## Run locally

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
node --check client.js
git diff --check
```
