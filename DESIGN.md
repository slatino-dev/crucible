# DESIGN: Crucible (Design Loop steps 1-3)

> The system record written BEFORE components (Design Loop gate). Direction, tokens,
> type, motion, and the five required states. Screenshots from a build session are the
> proof-of-work for steps 5-8 and are added as the UI lands (Phase 1.6 chart, Phase 2 SPA).

## Direction — "Signal Path" (lab-wide v2), ember override
Crucible consumes the shared Signal Path token base ratified by Conduit UNCHANGED (see
`src/styles/theme.css` `[LAB BASE]`) and overrides only its accent + display flourish
(`[CRUCIBLE OVERRIDE]`). The aesthetic: professional routing-hardware made digital —
dense-but-calm dark surfaces, precise 1px rules, live telemetry as a first-class design
element, tabular-nums on every figure, OKLCH token scales, Phosphor icons (Regular UI /
Fill active — ONE icon system).

Measurement honesty is the aesthetic, not decoration. The screenshot that travels is a
ranked board whose bars carry 95% confidence intervals and whose top rows overlap into a
tie-band — a category-of-one image next to competitors' naked point-score tables.

## Accent — furnace ember `OKLCH(0.72 0.16 55)`
The crucible metaphor made chromatic: heat = testing/assay. An 11-step OKLCH scale around
that working value (`--color-accent-*`), plus the chart primary series re-pointed to ember
so the CI-whisker leaderboard, the live-narrowing CI, and the assay timeline read as one
system with the brand. **Flagged for the lab-wide coherence pass** to dedupe against the
sibling hues (Conduit cyan 205, and Marginalia / Basilisk / Demiurge TBD). Ember 55 is a
clear >120deg separation from Conduit's cyan; the amber secondary (hue 75) that Conduit
uses only as a readout tint is close, so the coherence pass confirms no collision on any
surface where both appear.

## Display flourish — the "specimen tag"
Headline scores are framed as stamped assay tags: a 1px rule, tabular mono figures, and the
model-version + suite content-hash set in small-caps mono (`--tracking-label`). A score
reads like a labeled specimen, not a spreadsheet cell. Built as a reusable component against
tokens at Phase 1.6 / Phase 2; the token affordances (mono face, label tracking, `radius-md`
chip, hairline border) exist now.

## Type pairing (inherited lab pairing, faces + licenses)
- **Display:** Bricolage Grotesque — OFL 1.1 (characterful engineered grotesque).
- **Body/UI:** Geist — OFL 1.1 (neutral infrastructure sans).
- **Mono:** Geist Mono — OFL 1.1 (scores, CIs, hashes, latencies — tabular-nums).
All three are open-licensed and self-hosted; fallbacks are size-adjusted at load to hold
CLS at zero. No banned display faces (no Inter/Roboto/Arial/Space Grotesk as display type).

## The ONE orchestrated motion moment — the live assay line
During a run, case ticks flow along a 1px signal path, flash at the judge stage, and drop
into pass/fail bins, WHILE the leaderboard bar's 95% CI visibly narrows as cases accumulate
(the CI is bootstrap-resampled over CASES as the primary unit, so it tightens as each case
completes — never trial count inflating precision). Watching a confidence interval tighten
in real time IS the product thesis expressed as motion. Transform/opacity only; timing from
motion tokens; a single orchestrated moment, not scattered micro-animations.
`prefers-reduced-motion` -> static progress counter + final CI, no path animation, no
shimmer (collapsed globally in `theme.css`).

## Signature visuals — hand-built SVG against chart tokens (no library defaults)
The CI-whisker leaderboard, tie-bands, the live-narrowing CI, and the regression/assay
timeline are CUSTOM SVG components driven by the shared chart tokens — NOT a charting
library's defaults. Recharts cannot animate a CI narrowing and its default palette is
anti-slop-banned; it is permitted only for conventional secondary charts (e.g. a plain bar
on a docs page), re-themed through chart tokens. Every untrusted string rendered into an SVG
`<text>` label is escaped at the boundary (SVG is not HTML-escaped for free — see
ARCHITECTURE render-boundary hardening).

## Five designed states per view (constraint)
1. **Loading** — layout-matched skeleton, zero CLS (the board's columns reserve their width).
2. **Empty** — the leaderboard empty state TEACHES how a suite becomes a score (suite ->
   cases -> runs -> judge -> CI). It IS onboarding, not a shrug.
3. **Error** — plain-language message + retry; never a stack trace (stack traces never leave
   the Worker).
4. **Partial / degraded** — some targets `unscoreable` or below calibration threshold, shown
   HONESTLY (labeled), never hidden; the budget-ceiling fallback shows a cached recent real
   run labeled "showing a recent run — live capacity resets 00:00 UTC".
5. **Populated** — the ranked CI-whisker board with tie-bands and click-through provenance.

## Accessibility + performance gates
WCAG AA contrast (checked on changed views with axe; critical/serious findings FAIL the
build). Focus outlines are DESIGNED (`--ring-focus`), never removed. Tabular-nums on all
figures. LCP <=2.5s on the marketing/leaderboard page; the live spotlight run completes
<40s p95. Playwright screenshots at 390 / 768 / 1440px are captured when the UI lands and
are the only acceptable proof that a view is done.

## Anti-slop compliance (DESIGN.md is the opt-in ledger)
No Inter/Roboto/Arial/Space Grotesk display type · no purple-indigo gradients on white · no
three-identical-cards row · role-assigned (non-uniform) radii · designed shadows (not the
0.1-opacity default) · no scattered micro-animations (one orchestrated moment) · no emoji as
UI icons (Phosphor only) · no fake-precision stats (every number carries its CI + n) · no
default Recharts palette (chart tokens only) · designed focus outlines. The ember direction
needs precision, not more effects.
