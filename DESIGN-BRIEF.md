# DESIGN BRIEF: Crucible (Design Loop step 1)

## Purpose
Make measurement honesty *visible*. Error bars, provenance, and live judging are the aesthetic, not decoration — the leaderboard must communicate "real statistics, real transcripts, real taste" before anyone reads a word of copy. Every leaderboard competitor ships naked point-score tables; Crucible's screenshot is a ranked board where the bars carry confidence intervals and the top rows overlap into a tie-band. That is the thing that travels.

## Audience
AI-infrastructure hiring managers and staff engineers (the 90-second path) and practitioners comparing open-weight models. Both must instantly read: this is measurement science, every number resolves to a stored transcript, and the person who built it understood the papers behind it.

## ONE named direction: "Signal Path" (lab-wide language v2)
Professional routing-hardware aesthetic made digital: dense-but-calm dark surfaces, precise 1px rules, live telemetry as first-class design element, tabular-nums everywhere, OKLCH token scales, Phosphor icons (Regular UI / Fill active). Crucible overrides **only its accent + display flourish**; it inherits the shared token base, type pairing, spacing, radii, and motion tokens unchanged.

> **Ratification dependency (Phase 0).** Patchbay was the original ratifier of Signal Path and the shared type pairing, but it is **set aside** per the master plan, so no built project currently owns the base. **Signal Path ratification, the OKLCH token base, and the type pairing are re-anchored to Conduit** (the first project actually built this pass). Crucible consumes that ratified base; if Conduit has not yet ratified when Crucible's Phase 0 starts, Crucible's Phase 0 does the ratification pass and Conduit inherits — one project owns it, and it is whichever ships first. Recorded as a Phase 0 dependency in BUILD-PLAN.

- **Accent — furnace ember:** molten orange, proposed **OKLCH(0.72 0.16 55)**. The crucible metaphor made chromatic (heat = testing/assay). Distinct from Patchbay's neutral master accent; **flag for the lab-wide coherence pass** to dedupe against Conduit / Marginalia / Basilisk / Demiurge hues.
- **Display flourish — the "specimen tag":** headline scores are framed as stamped assay tags (1px rule, tabular figures, model-version + content-hash in small caps), so a score reads like a labeled specimen, not a cell in a spreadsheet. Refined at step 3.

## The ONE orchestrated motion moment: the live assay line
During a run, case ticks flow along a 1px signal path, flash at the judge stage, and drop into pass/fail bins — while the leaderboard bar's **95% CI visibly narrows as cases accumulate** (the CI is bootstrap-resampled over *cases* as the primary unit, so it tightens as each case completes; the spotlight visitor run is n_trials=1, and for the multi-trial admin/nightly runs the narrowing reflects case-clustered evidence growing, never trial count inflating precision). Watching a confidence interval tighten in real time *is* the product thesis expressed as motion. Transform/opacity only; timing from motion tokens; a single orchestrated moment, not scattered micro-animations. `prefers-reduced-motion` → static progress counter + final CI, no path animation, no shimmer.

## Signature elements
Error bars and tie-bands as first-class, reusable design components (telemetry-as-design) · every number is a click-target to provenance (run → cases → transcripts → judge prompt version) · tabular-nums on all figures · charts obey the dataviz system (zero-baseline bars, direct labels over legends, insight-titled — e.g. "Ranks are only shown where the intervals separate") · TanStack Table for the case/leaderboard grids (right-aligned tabular figures, sticky headers, visible sort state) · judge rationales rendered via Streamdown, never raw markdown.

## Rendering commitment for the signature visuals (Design Loop step 3 — decided now, no default sneaks in)
The flagship elements — the **CI-whisker leaderboard**, **tie-bands**, the **live-narrowing CI**, and the **regression/assay timeline** — are built as **custom SVG components driven by the shared chart tokens**, not by a charting library's defaults. Recharts cannot animate a CI narrowing in real time and its default palette is anti-slop-banned, so it is **not** the renderer for any signature element; it is permitted only for conventional *secondary* charts (e.g. a plain bar on a docs page), and even there only re-themed through chart tokens. The whisker, tie-band, and live-assay-line components are the project's telemetry-as-design primitives and are hand-built against tokens so the screenshot that travels is ours, not a library's.

## Alternates (if Signal Path fails review at step 6)
1. **Blueprint** — drafting-table linework, annotation-driven labels, engineering-drawing calm; error bars read as measurement annotations.
2. **Terminal Luxe** — phosphor-heritage, extreme typographic restraint, zero chrome; the board as a precise instrument readout.

## Constraints
Dark-first with a real token-level light remap · **five designed states per view** — the leaderboard empty state *teaches how a suite becomes a score* (it IS onboarding), plus loading (layout-matched skeleton, zero CLS), error (plain language + retry), partial/degraded (some targets unscoreable — shown honestly, not hidden), populated · WCAG AA, designed focus outlines (never removed) · LCP ≤2.5s on the marketing/leaderboard page · anti-slop bans in full (no Inter/Roboto display, no purple-indigo gradients, no three-identical-cards, no emoji icons, no fake-precision stats, no default Recharts palette) · OG card renders live leaderboard state.

## Differentiation
The competitor set ships bootstrap-grade point-score tables with no uncertainty shown. A ranked board with visible error bars, a live-narrowing CI, and one-click provenance to the actual judge transcript is a category-of-one screenshot. Design the leaderboard to be screenshotted, and design the live-run to be worth watching for 60 seconds.
