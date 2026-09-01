# Design System: Suede Audit

Reference: Suede Agent Studio (https://agents.suedeai.ai), tokens read from
`suede-agent-studio/src/styles/tokens.css` on 2026-08-31. The earlier
searchfit-derived system it replaced is recorded in git history.

The two surfaces are one product to a visitor who moves between them, so this
page inherits Studio's palette, type trio, radii, and control grammar rather
than keeping a second visual language.

## Product Contract

- Audience: founders, growth leads, SEO operators, and technical marketers checking whether a public site gives search and answer engines enough usable evidence.
- Job: enter a public domain, get a truthful automated audit, understand the score, and leave with a prioritized repair list.
- Primary action: run the audit.
- Register: product.
- Physical scene: a skeptical founder reviews the report on a laptop after seeing a competitor appear in an AI answer. They need evidence and the next repair, not a sales promise.
- Claim boundary: the automated report inspects public site signals and crawler policy. It does not run buyer prompts inside ChatGPT, Perplexity, or Gemini and does not promise citations or rankings.

## Identity

- Color strategy: Restrained base with a full signal palette on the report. Near-white paper and white panels carry the page, indigo marks every action, and green/amber/red/violet stay reserved for verified access, repair priority, blockers, and the overall score.
- Aesthetic tone: refined minimal. A serif display voice over a low-density, hairline-ruled product surface, inherited from Suede Agent Studio.
- Unforgettable factor: the Answer Readiness Field plots every audit lane by
  measured readiness and finding impact, turning the report into an inspectable
  signal map. Every lane bar, pillar bar, and the overall gauge are inked from
  the grade ramp, so the shape of the verdict is legible before a single number
  is read: a red Entity row next to a green Technical row says more at a glance
  than eight identical bars ever did.
- Signature artifact: a live score rail that connects crawler access, entity structure, content, and technical health.

## Reference Translation

Suede Agent Studio contributes the design grammar: near-white paper under white
panels, a serif display face at large sizes with the second clause set in indigo
italic, a mono uppercase eyebrow led by a short rule, mono uppercase control
labels, an 8px radius family, hairline borders doing most of the separation
work, and a faint indigo blueprint grid behind the hero.

It does not contribute content. The audit's own copy, claims, evidence
boundary, scoring method, and report structure are unchanged. Studio's product
claims do not transfer to this page.

## Typography

- Personality font: Instrument Serif, regular and italic. It ships a single
  weight, so display type never asks for 600 or 700; the browser would
  synthesize a fake bold and smear the thin strokes the face is chosen for.
  Emphasis comes from size and from the italic, not from weight.
- Utility font: Geist, 400 to 600. Running text, form labels, and any heading
  below roughly 1.4rem, where a serif reads as decoration rather than voice.
- Data font: Geist Mono, 500 to 600. Eyebrows, control labels, timestamps,
  crawler names, and measured values.
- Type scale: hero `clamp(2.35rem, 1.5rem + 3.6vw, 4.15rem)`, H2
  `clamp(1.75rem, 3vw, 2.7rem)`, H3 `clamp(1.05rem, 1.4vw, 1.3rem)`, body
  `clamp(1rem, .95rem + .2vw, 1.0625rem)`, label `0.72rem`.
- Line-height base: 1.58. Hero line-height 1.06.

## Color Tokens

```css
:root {
  --color-bg: #fafbfd;
  --color-surface: #ffffff;
  --color-surface-soft: #f3f4f9;
  --color-text-primary: #111317;
  --color-text-secondary: #475467;
  --color-text-tertiary: #6b7280;
  --color-accent: #4f46e5;
  --color-accent-hover: #4338ca;
  --button-primary-bg: #4f46e5;      /* #fff on it: 6.29:1 */
  --button-primary-bg-hover: #4338ca;
  --color-border: #e6e8ef;           /* quiet dividers */
  --color-border-strong: #818794;    /* sole boundaries, 3.60:1 on white */
  --color-success: #047857;
  --color-warning: #92400e;
  --color-error: #b91c1c;
  --color-score: #7c3aed;            /* 5.70:1 on white, large score text */

  /* Grade ramp. Thresholds mirror grade() in lib/engine.mjs. */
  --grade-a: #10b981;                /* >=90 */
  --grade-b: #0ea5e9;                /* >=80 */
  --grade-c: #f59e0b;                /* >=70 */
  --grade-d: #ea580c;                /* >=55 */
  --grade-f: #dc2626;                /* below 55 */
  --brand-plate: #111317;            /* theme-stable; the mark is a light glyph */
  --font-personality: "Instrument Serif", Georgia, serif;
  --font-utility: "Geist", ui-sans-serif, system-ui, sans-serif;
  --font-data: "Geist Mono", ui-monospace, SFMono-Regular, monospace;
  --text-base: clamp(1rem, .95rem + .2vw, 1.0625rem);
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --shadow-card: 0 1px 3px rgba(17, 19, 23, .08), 0 6px 18px rgba(17, 19, 23, .06);
  --shadow-elevated: 0 4px 8px rgba(17, 19, 23, .1), 0 20px 48px rgba(17, 19, 23, .16);
  --motion-fast: 140ms;
  --motion-base: 240ms;
  --motion-slow: 360ms;
  --motion-easing: cubic-bezier(.16, 1, .3, 1);
}
```

Dark mode is opt-in via the header toggle and is not an inversion: surfaces step
up in lightness (`#101114` page, `#17181d` panel, `#1d1f26` control), separation
leans on borders rather than shadow, and every saturated value is the lighter
twin of its light-theme counterpart. Full set in `styles.css`.

## Spacing And Shape

- Grid: 12 columns, max-width 1240px. Gutter is `clamp(40px, 7.5vw, 96px)`
  total, so 48px per side at 1280px and 20px per side at 390px.
- Section rhythm: report header 1.0, score overview 0.7, readiness field 1.2, findings ledger 1.5, method and next action 0.7.
- Radii: small 6px, medium 8px, large 12px. Studio's 8px family, not the
  16-24px cards this page previously used.
- Card shadow: `0 1px 3px rgba(17, 19, 23, .08), 0 6px 18px rgba(17, 19, 23, .06)`.
- Elevated shadow: `0 4px 8px rgba(17, 19, 23, .1), 0 20px 48px rgba(17, 19, 23, .16)`.
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
- Primary CTA: `Run the audit`. Control labels render mono uppercase.
- Secondary CTA: `Copy report link`.
- Contact: `Contact`, reachable from the nav, a named section, and a control
  fixed to the viewport on every page. Address is `info@suedeai.org`.
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
| Domain input | visible label and example hint | 3px indigo focus ring | value remains readable | normalized domain remains | inline message below field | gated after the browser's first successful audit |
| Run button | indigo, mono uppercase label | darker indigo, no lift | spinner plus `Inspecting` | header becomes `View saved audit` | returns to `Run the audit` | disabled during request; subsequent domains route to the saved-audit message |
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

---

# Landing Reference: Marketing-Agent Site Pattern

Second reference, reviewed 2026-08-12: https://magistermarketing.com/

That site sells a subscription marketing agent. Suede Audit is a free,
no-signup, single-shot diagnostic. Only the structural patterns that survive
that difference were taken. No copy, asset, or visual token came across, and
the page's own type scale, palette, and section rhythm are unchanged.

## Adoption Log

| Pattern | Status | Reason |
| --- | --- | --- |
| Three-step "how it works" strip | ADOPTED | The landing explained method in prose but had no scannable path from URL to repair |
| Populated example of the deliverable | ADAPTED | The reference embeds product screenshots. Suede shows a labelled sample report instead, marked as illustration and built from the real report's own layout |
| Old-way / new-way comparison | ADAPTED | Reframed from competitor comparison to method comparison: a generic checklist assumes a state, this audit reports the measured one |
| Founder credibility block | ADOPTED | The audit's argument is that the method is inspectable. Naming the author and linking the source supports that claim |
| Repeated closing call to action | ADOPTED | The audit form previously appeared only in the hero |
| Trust microcopy beside the call to action | ADOPTED | "No signup, no credit card, no email required" was already true and already policy; it was simply not stated at the point of decision |
| Pricing tier cards | REJECTED | The audit is free with no signup. Tiers would contradict the page's own promise. The paid ladder stays on scan.suedeai.ai |
| Integrations logo grid | REJECTED | The audit has no integrations |
| Multi-tab product interior | REJECTED | There is no product interior to show |
| Terminal / API signup snippet | REJECTED | Verified against production: `/api/audit` requires `sec-fetch-site: same-origin` and returns 403 otherwise. A copy-paste command would not work |
| Persona segmentation | REJECTED | One tool, one job. Segmenting implies variants that do not exist |

## Constraints Observed

- No inline script was added. `script-src` in `vercel.json` pins two inline
  hashes, so any new inline block would need a CSP change to run.
- Every added rule resolves through existing tokens, so the dark theme, the
  reduced-motion block, and the print sheet continue to apply without edits.
- All added sections live inside `#landing-shell`, so a rendered report hides
  them. Sample figures can never appear beside a real audit result.

## Grade Color Contract

`renderReport` writes the engine's grade onto three elements as `data-grade`:
the score card, each pillar card, and each lane row. The stylesheet resolves
`--grade` from that attribute, and the gauge, pillar bars, and lane bars fill
with `var(--grade, var(--color-accent))`.

Rules that keep this honest:

- **Color is never the only carrier.** Every graded element renders its numeric
  score and its letter grade as text beside the fill, so the ramp is redundant
  encoding, not the signal itself. This is what keeps it usable for a reader who
  cannot distinguish the hues.
- **Only `A`-`F` reach the DOM.** `gradeAttr()` in `client.js` rejects anything
  else, so a malformed grade falls back to the accent fill rather than injecting
  an arbitrary attribute value. Covered by a test.
- **The grade letter is not tinted.** `--grade-c` and `--grade-d` are amber and
  orange fills that do not hold 4.5:1 as text on white. The gauge carries the
  color; the letter carries the contrast.
- **Dark mode uses lighter twins**, same hue, chroma pulled back, so the ramp
  reads on `#101114` without going neon.

## Contact Ranks

Contact is a primary action here, not a footer courtesy, and each view carries
the rank that fits it.

| View | Affordance |
| --- | --- |
| Landing | Nav link to `#contact`, the `#contact` section, and the fixed control |
| Report | `Contact` pinned in the sticky report nav, plus the header link as a mailto |
| Both | Footer link |

Two rules make the report case work:

- **The fixed control is hidden on the report.** It was sitting over severity
  chips in the findings table at several scroll offsets. The sticky report nav
  already carries Contact there, so the floating copy was redundant as well as
  in the way. Hidden via `body:has(#report:not([hidden]))`; where `:has()` is
  unsupported the rule is dropped and the control stays, which is the older
  behavior rather than a broken one.
- **The header link swaps to a mailto on the report.** `#contact` lives inside
  `#landing-shell`, which is hidden behind the report, so the header link
  pointed at a hidden element and did nothing. `setReportNavigation` finds it by
  its landing href rather than by position, so reordering the nav cannot
  silently break it again.

Remaining gap, accepted: at the very top of the report on a narrow viewport the
report nav has not scrolled into view yet, so contact is one scroll away there.
From that point down it is pinned. Verified by sweeping the full scroll range at
1280x900 and 390x844, where the fixed control now overlaps no text and no
control anywhere on the report.
