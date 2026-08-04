# Suede Scan

Public-site discovery and answer-readiness audit from Suede Labs AI.

Product URL: [optimize.suedeai.ai](https://optimize.suedeai.ai/).

## What it does

Enter a public URL and get a weighted audit of access, crawler policy, entity schema, metadata, content structure, internal links, and response weight. The audit follows a bounded set of same-origin, query-free links, requires two dead responses before confirming a 404 or 410 destination, records source and target evidence, and prepares a direct-link replacement only when every redirect hop is permanent and same-origin. It never guesses a replacement for a confirmed dead link.

Each browser gets one free audit. Its result is cached locally for reopening, while Copy report creates a self-contained `/report/<domain>#report=...` link. The URL fragment carries a versioned snapshot of the already-rendered public report, is validated against the path domain, and is removed from the address bar after loading. Fragments are not sent to the server, so a first-time visitor can view the shared report without spending their free audit. The server does not persist report contents.

Shared snapshots are base64url-encoded, not encrypted or signed; anyone who receives the link can read or change the public audit data it contains. Recipient pages therefore present these results as an unverified user-provided snapshot, not as a fresh or Suede-verified audit. Unsigned shared snapshots cannot create a Prospect Lens handoff. Copy report refuses snapshots above the defined 48 KiB encoded limit instead of truncating JSON or silently falling back to a new audit. Older fragmentless `/report/<domain>` links never auto-run an audit: they show a prompt and let the visitor explicitly choose whether to spend their free audit.

## Abuse protection

The free audit is protected by a browser-local result gate, a one-year HttpOnly usage cookie, a bot-trap field, Fetch Metadata checks, in-process burst limiting, and Vercel Firewall challenge and rate-limit rules. The firewall is the durable request boundary; the browser controls make the one-audit policy explicit and preserve the saved result.

The public crawl is capped at 6 pages, 30 unique same-origin links, 40 HTTP requests including redirect hops, depth 1, 12 findings, and 20 seconds. Query-bearing, external-origin, credentialed, private-network, non-HTTP, and unsupported-port targets are not crawled. Redirect destinations are revalidated before a request is sent.

## Operator audit

`POST /api/operator-audit` is a server-to-server endpoint for the authorized Suede workflow. It accepts exactly `{ "url": "https://example.com/" }` and returns `{ "handoff": { ... } }`, where `handoff` is the same fresh, bounded `suede.audit.prospect` contract consumed by Prospect Lens. It requires an exact `Authorization: Bearer ...` match against the production-only `SUEDE_AUDIT_OPERATOR_TOKEN`, compared through fixed-length SHA-256 digests with `timingSafeEqual`. It rate-limits authentication attempts before token comparison, then applies a separate six-request-per-minute authorized-work bucket. The response deadline is 18 seconds, inside Prospect Lens's 20-second client deadline; the crawl within it is capped at 20 pages, 120 links, 150 requests, depth 2, 40 findings, and 16 seconds. It does not set or bypass the public browser cookie through a public header.

Rate-limit identity uses a syntactically valid IP from `X-Forwarded-For`, falling back to the socket address. Production relies on Vercel replacing that header with the client address. A self-hosted reverse proxy must remove any inbound value and set its own trusted forwarding header before this application receives the request.

The token must be at least 32 characters and must be configured in the production Vercel project before release. Do not expose it to browser code, commit it, put it in a URL, or reuse it as a customer credential. This repository creates no email, CRM write, contact scrape, scheduled outreach, or autonomous send.

## Claim boundary

The report inspects bounded same-origin public HTML and links plus `robots.txt`, `llms.txt`, and `sitemap.xml`. It does not run buyer prompts inside ChatGPT, Perplexity, Gemini, or another answer engine. A high readiness score does not guarantee citations, recommendations, or rankings.

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
