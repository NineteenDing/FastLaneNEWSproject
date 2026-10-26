# TopicEye scoring adaptation

Copyright 2026 fxbin. Apache License, Version 2.0; full license in LICENSE.

Source: https://github.com/fxbin/TopicEye
Commit: 70e3a86f987e7ab9e4b632c9a4bc63d64f4ad963.
Files: backend/app/services/scoring_engine.py (_compute_base_score),
backend/app/services/scoring_caliber.py (CONFIG, single scoring policy).

Modified for FastLaneNEWS, 2026-10-18: port the six-dimension weighted
contribution calculation and shared policy/breakdown structure to TypeScript
in backend/topic-scoring.ts. Use audience/practical/evidence/freshness/demand/
distinctiveness weights 25/25/20/10/10/10. Keep unknown dimensions null and
their unearned contribution at zero without renormalizing. Preserve real zero.
Hard audience/evidence/benefit eligibility is separate from the numeric score.
This score applies to initial material triage, not a generated direction.

Do not carry over default-50 dimensions, blend/fallback scores, source bonus,
percentile quota, category penalties or inferred feedback. Time decay, diversity,
direction synthesis and feedback calibration remain separate later work.

2026-10-19 direction ranking: topic-ranking.ts also adapts _compute_time_decay
and _compute_diversity_order from the same pinned commit. Use a 72-hour
half-life with a 0.3 floor only on the freshness contribution. Greedily rank
within each column; explicit source/person/work overlap and the same event+angle
can reduce at most 6 points. No category penalty, percent quota, default-50,
inferred feedback or source bonus. A nullable persisted ranking context preserves
old tasks and fixes the cutoff across generation/review/retries. User feedback
and prior adopted-work calibration remain separate work.

2026-10-19 explicit feedback: adapt the same pinned _compute_base_score feedback
clamp and small contribution to topic-ranking.ts. Only explicit saved same-column
feedback is eligible; use bounded Chinese keyword/exact-angle matching and a
five-sample prior, maximum +/-3 points. No inference from unchosen directions.
Freeze bounded feedback metadata at submission and reuse it in both review rounds.
Prior adopted angles use the existing writing snapshots, exact event+angle and
fact-quote comparison, with a separate maximum 3-point repeat reduction. This
limited repeat check is project-specific, not an upstream semantic novelty model.

2026-10-24 phase two: filter-scoring.ts reuses the weighted-contribution approach
with separate editable public and internal policies prescribed by the project.
event-propagation.ts combines configurable bands with the existing exponential
decay pattern and AIHOT's independent-participant time basis. Unknown semantics
remain unearned; no extra model calls for metrics, time or numeric changes.
Configured direction scores include event freshness already, so topic-ranking.ts
does not apply the legacy 72-hour freshness adjustment a second time. The
versioning, current/frozen evidence projection and grounded date resolution are
project adaptations, not features attributed to upstream TopicEye.
