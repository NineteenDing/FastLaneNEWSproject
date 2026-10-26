---
version: 1
slug: "modules-studio-web-topic-columns-tsx"
primary_target: "modules/studio/web/topic-columns.tsx"
related_targets: ["modules/studio/web/layout.tsx","modules/studio/web/studio.css","modules/studio/web/topic-tabs.tsx","modules/studio/web/topic-rule-text.tsx"]
---

# Topic column rules and immutable history

Mode: Operate. This is the next functional section of the existing private workspace; inherit PRODUCT.md and DESIGN.md. The user has already specified the audience, four main columns plus Other, editable criteria, required custom questions/video forms, and historical protection, and authorized implementation. No new aesthetic or task decision is pending.

## Direction contract

THESIS: Make the editorial criteria inspectable and editable before recommendation generation, while preserving every prior rule version. Never fill the page with invented directions or counts.

OWN-WORLD: Existing light neutral workspace, muted sidebar, restrained teal, Chinese system typography and existing form/button/notice styles. No new world, comp, raster, QUALITY BAR or extra icon language.

STORY: Open Column Rules at /admin/studio/topics/columns through the shared Current/History/Column Rules tabs, see the fixed audience and four main columns plus the reserved Other, inspect concise questions/video forms, add or edit criteria, set order/active state, save, and read an immutable version. Current preview and saved batch history are available through the shared tabs; recommendation generation remains explicitly pending. Rule updates apply to future work and cannot overwrite history.

FIRST VIEWPORT: Existing five-entry sidebar and Topic Desk title, Add Column action; labelled column-rules section and a short audience/capability note. User-requested column cards use two desktop columns and one on mobile, with Other last. Each shows name, active state/version, concise questions, desired video form and maximum directions; detailed criteria are folded. The editor opens inline above the cards, with required name/questions/video forms, optional must/exclude, order and enable fields, save/cancel, and preserved inputs on failure. History is a separate readable address with return and previous-version navigation.

FORM: User-specified workspace expansion, code-led inherited Operate form. Signature interaction: versioned save reports a multi-window conflict instead of overwriting another window; an earlier saved rule remains readable after rename or disable. No model is called from reads or ordinary rule editing.

FINISH: Unreviewed and undocumented is unfinished; complete scoped independent code and screenshot review plus documentation, preserve incumbent PRODUCT/DESIGN, and reload only the project-owned local instance. P4.2a is limited to rules; full batches, generated recommendations and historical batch application remain incomplete.

## P4.2a finish evidence

2026-10-18, 816b1d0: the limited rules slice is implemented: fixed audience, four default main columns plus reserved Other, custom creation/editing, enable/disable and order fields, append-only historical rule versions and multi-window conflict protection. Other retains its fixed name, enabled state and final position. Inline editing focuses the first field, preserves unsaved input on failure/conflict and returns focus on close. Rule history remains a separate readable address; these rules are not generated recommendations or proof that batch application is implemented.

Fresh topic_columns_finish returned disposition ship with no material fixes after inspecting seven captures under .impeccable/review/: topic-columns-desktop.png, topic-columns-tablet.png, topic-columns-mobile.png, topic-columns-editor-mobile.png, topic-columns-history-desktop.png, topic-columns-conflict-mobile.png and topic-columns-error-mobile.png. The documenter opened desktop/mobile list, mobile editor and mobile conflict captures and checked topic-columns.tsx/studio.css against PRODUCT.md and DESIGN.md. The inherited light ground, teal actions/focus, Chinese system typography, white bordered cards, inline forms and disclosure language remain intact. Two desktop columns become one on mobile, with Other spanning the final row; long summaries remain bounded while complete criteria are expandable. No new world, comp, raster or shipping assets; PRODUCT.md and DESIGN.md are unchanged.

Supplied verification: topic-columns-related-ready.log 23/23 (column API 3, browser 3, architecture 8, migration safety 9), final typecheck/build passed, both independent code-review axes zero. Earlier browser-context/locator fixture failures remain recorded; original conflict, preserved-input and version assertions passed after fixture corrections. See docs/development/REVIEW-TOPIC-COLUMNS.md. Migration, formal local reload and its verification belong to the build thread; this documenter made no service/test changes. Full batches, classification, scoring, generated recommendations, model review, historical batch application and real-platform/user/Server2022 acceptance remain outside this delivery. Existing DESIGN formatting drift is preserved rather than promoted into new system rules.

## P4.1b navigation and shared-rule extension

2026-10-18: the rules entry now lives at /admin/studio/topics/columns; Topic Desk defaults to Current and provides shared Current/History/Column Rules tabs. Rule-history return and error links target the dedicated rules address. TopicRuleText is shared with frozen batch criteria using the same definition-list markup/styles; editing, version preservation and conflict behavior retain their P4.2a scope.

The batch surface brief records topic_batches_finish scoped ship/clear verification, nine screenshots and reviewed related 28/28 plus typecheck/build; later backend-only attribution boundary checks passed 18/18 without changing UI. See docs/development/REVIEW-TOPIC-BATCHES-WEB.md. This pass read the rules source, shared rule component and related batch views; PRODUCT.md/DESIGN.md remain intact. Full recommendation generation, scoring, review, adoption/writing and real acceptance remain pending; earlier P4.2a evidence is preserved at its original scope. Formal reload/verification belongs to the build thread.
