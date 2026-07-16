# Design System: Suede Audit

Extracted from: https://searchfit.ai/report/suedeai.ai?vertical=saas on 2026-07-15

## Product Contract

- Audience: founders, growth leads, SEO operators, and technical marketers checking whether a public site gives search and answer engines enough usable evidence.
- Job: enter a public domain, get a truthful automated audit, understand the score, and leave with a prioritized repair list.
- Primary action: run the audit.
- Register: product.
- Physical scene: a skeptical founder reviews the report on a laptop after seeing a competitor appear in an AI answer. They need evidence and the next repair, not a sales promise.
- Claim boundary: the automated report inspects public site signals and crawler policy. It does not run buyer prompts inside ChatGPT, Perplexity, or Gemini and does not promise citations or rankings.

## Identity

- Color strategy: Full palette. Cobalt marks action, green marks verified access, coral marks blockers, amber marks repair priority, and violet carries the overall score.
- Aesthetic tone: refined minimal with product-utilitarian density.
- Unforgettable factor: the Answer Readiness Field plots every audit lane by measured readiness and finding impact, turning the report into an inspectable signal map.
- Signature artifact: a live score rail that connects crawler access, entity structure, content, and technical health.

## Reference Translation

The reference contributes the report hierarchy, white-space rhythm, floating score summary, platform cards, data-rich middle sections, and shareable closing state. Suede keeps those structural strengths while replacing proprietary copy, assets, scores, and gated-report mechanics with its own live audit data.

The target rejects the reference's unsupported implication that a crawler-policy check is the same as an AI recommendation test. Suede labels every measured signal and publishes the method inside the report.

## Typography

- Personality font: Space Grotesk, 500 to 700. Its broad geometric forms make the score and report headings feel direct without copying the reference wordmark.
- Utility font: IBM Plex Sans, 400 to 600. It stays readable in dense findings and pairs with the display face through a technical, humanist contrast.
- Data font: IBM Plex Mono, 500 to 600. It is reserved for timestamps, crawler names, labels, and measured values.
- Type scale: H1 `clamp(2.5rem, 5vw, 5.75rem)`, H2 `clamp(1.65rem, 2.6vw, 2.5rem)`, H3 `clamp(1.05rem, 1.2vw, 1.3rem)`, body `clamp(1rem, .96rem + .2vw, 1.08rem)`, label `0.72rem`.
- Line-height base: 1.58.

## Color Tokens

```css
:root {
  --color-bg: #f5f6fa;
  --color-surface: #ffffff;
  --color-surface-soft: #f0f2f7;
  --color-text-primary: #12151b;
  --color-text-secondary: #626977;
  --color-text-tertiary: #59616e;
  --color-accent: #3156ff;
  --color-accent-hover: #2444d5;
  --color-border: #dde1e8;
  --color-border-strong: #c7ccd6;
  --color-success: #08734a;
  --color-warning: #914800;
  --color-error: #b92f32;
  --color-score: #b83fcf;
  --font-personality: "Space Grotesk", sans-serif;
  --font-utility: "IBM Plex Sans", sans-serif;
  --font-data: "IBM Plex Mono", monospace;
  --text-base: clamp(1rem, .96rem + .2vw, 1.08rem);
  --text-scale-ratio: 1.28;
  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 24px;
  --shadow-card: 0 10px 32px -24px rgba(25, 31, 45, .34);
  --shadow-elevated: 0 24px 70px -34px rgba(49, 86, 255, .34);
  --motion-fast: 140ms;
  --motion-base: 240ms;
  --motion-slow: 360ms;
  --motion-easing: cubic-bezier(.16, 1, .3, 1);
}
```

## Spacing And Shape

- Grid: 12 columns, max-width 1240px, 24px desktop gutters, 16px mobile gutters.
- Section rhythm: report header 1.0, score overview 0.7, readiness field 1.2, findings ledger 1.5, method and next action 0.7.
- Radii: small 10px, medium 16px, large 24px.
- Card shadow: `0 10px 32px -24px rgba(25, 31, 45, .34)`.
- Elevated score shadow: `0 24px 70px -34px rgba(49, 86, 255, .34)`.
- Borders provide most hierarchy. Shadows are limited to the score summary and transient states.

## Motion

- Character: considered.
- Fast: 140ms. Base: 240ms. Slow: 360ms.
- Easing: `cubic-bezier(.16, 1, .3, 1)`.
- Stagger: first six report groups enter in 40ms increments after a scan completes.
- Motion explains loading, result arrival, and expanded findings only.
- Reduced motion removes translation and sets all transition duration to 0ms.

## Voice

- Register: technical 70 / casual 30. Functional 85 / aspirational 15.
- Median sentence length: 13 to 17 words.
- Stance: second-person imperative for actions, third-person factual for measured results.
- Claim type: measured artifact and direct next step.
- Vocabulary anchors: inspect, evidence, repair.
- Primary CTA: `Run the audit`.
- Secondary CTA: `Copy report link`.
- Loading: `Inspecting public site signals`.
- Success: `Audit complete`.
- Error: `We could not inspect that public URL. Check the address and try again.`

### Hero and CTA variants

- Outcome-led, selected: `See what answer engines can actually read.`
- Problem-led: `Your site may be public. Its evidence may still be invisible.`
- Mechanism-led: `One public-site audit. Every discovery signal, scored.`
- Primary CTA, selected: `Run the audit`.
- Alternate CTA: `Inspect my public site`.

## Component State Matrix

| Component | Default | Focus or hover | Loading | Success | Error | Disabled |
| --- | --- | --- | --- | --- | --- | --- |
| Domain input | visible label and example hint | 3px cobalt focus ring | value remains readable | normalized domain remains | inline message below field | never disabled by default |
| Run button | cobalt, action label | darker cobalt and 1px lift | spinner plus `Inspecting` | returns to `Run another audit` | returns to `Run the audit` | disabled only during request |
| Report shell | empty-state proof preview | section links underline and weight | skeleton rails with status copy | full report visible | hidden, error stays near form | not applicable |
| Finding row | summary, measured value, priority | row background changes | not applicable | pass uses icon plus text | fail shows repair copy | not applicable |
| Share control | `Copy report link` | outline strengthens | `Copying` | `Link copied` for two seconds | `Copy this URL` fallback | disabled until a report route exists |

## Screenshot Contract

- `root-desktop`: 1280 by 900, empty form, proof preview, no result data.
- `root-mobile`: 390 by 844, labeled form and first report preview visible.
- `report-desktop`: 1280 by 900, completed audit at `/report/<domain>`, score summary and first platform row visible.
- `report-mobile`: 390 by 844, completed audit with no horizontal overflow and the score card fully visible.
- `report-error`: 1280 by 900, rejected or unreachable URL with inline recovery copy.

## Accessibility Pass

- Body text targets at least 7:1 contrast. Secondary text targets at least 4.5:1.
- Every control has a visible label, keyboard focus ring, and a minimum 44px touch target.
- Score colors never carry meaning without a grade, label, or status word.
- Findings use semantic table and list markup with mobile row labels.
- The live status region announces loading, success, and errors.
- `prefers-reduced-motion` removes non-essential movement.

## Migration Notes

- The existing audit API fields remain compatible while the engine adds crawler, entity, lane-score, and recommendation data.
- Existing `/api/scan` and `/api/audit` routes remain. The report route is a static-shell rewrite that loads the same API.
- The old dark single-column interface is replaced as one surface. There are no shared components to preserve.
- The approved Suede mark is loaded from the pinned public asset. It must not be redrawn or recolored.

## Token Adoption Log

| Token or pattern | Reference | Status | Reason |
| --- | --- | --- | --- |
| Light report canvas | white and cool gray | ADOPTED | Report data benefits from paper-like clarity |
| Electric blue CTA | bright blue | ADAPTED | Shifted to Suede cobalt for contrast and identity |
| Violet score ring | pink to violet | ADAPTED | Kept as a score-only semantic role |
| Rounded report cards | 12 to 16px | ADOPTED | Supports independently scannable result groups |
| Floating score summary | elevated score card | ADOPTED | It is the fastest route to report comprehension |
| Locked full report modal | blurred and gated | REJECTED | The public audit should show measured findings and route paid implementation separately |
| Brand positioning quadrant | unsupported competitive plot | REJECTED | Replaced by the measured Answer Readiness Field |
| Platform recommendation scores | proprietary query data | REJECTED | Replaced by crawler-access and site-signal evidence |

## Fidelity Level

Close visual match for hierarchy, density, score presentation, section cadence, and mobile composition. Suede-specific copy, assets, data, and product behavior remain original.
