---
version: 1
slug: "modules-studio-web-creators-tsx"
primary_target: "modules/studio/web/creators.tsx"
related_targets: []
---

# Creator following extension

Mode: Operate. Route: /admin/studio/creators. Target: modules/studio/web/creators.tsx.

Private account registration and lifecycle management inside existing Following. The user explicitly supplied the news/creator tabs and card composition; inherit the incumbent interface. This finish record captures the shipped implementation, not a new identity or retrospective concept roll.

## Direction contract

THESIS: Make complete-homepage registration, filtering, pause, removal and restoration understandable in the existing Following workspace; avoid adding a separate management shell.

OWN-WORLD: Inherit DESIGN.md and studio.css: system Chinese typography, neutral light ground, white bordered cards, muted sidebar, restrained teal selection/action, existing focus ring and spacing. No new assets or system rules.

STORY: Switch from news to creators, register one of seven supported platforms, inspect saved identity and explicit missing information, then manage its lifecycle. The Bilibili, Weibo, XHS, Zhihu, Tieba, Douyin and Kuaishou extensions submit durable collection and reveal the actual saved publications, changing metrics and bounded comment samples, including acquired Tieba floor numbers. Registration is not evidence of platform connectivity.

FIRST VIEWPORT: Existing five-entry navigation; page title and add action above the two tabs; status notice, wrapping filters and result count; three-column desktop cards, two at the existing intermediate breakpoint, one at 390px. Inline add form opens before filters.

FORM: User-prescribed extension of incumbent tabs and cards; no ranking, concept-seed or generated seed applies. Code-led; no comp or raster ships. Signature interaction: add focuses the URL field, cancel returns focus; removal confirms and restoration returns paused.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## States and boundaries

Missing counts remain null and display 未提供; missing dates show 尚无记录. Preserve input on errors, disable busy commands, distinguish paused, removed, empty and filtered-empty states. Pagination retains filters. The completed, bounded Bilibili collection extension uses the same card controls and an inline disclosure with loading, empty, failure/retry, pagination and nested textual source evidence. Collection requires enabled collection and worker settings; statuses distinguish running, ready, failed, interrupted, login required and rate limiting. Partial pages and bounded first-level comment samples remain explicit. All seven collectors are connected for isolated tests; short links, avatars, media/ASR and real-platform acceptance remain pending. Tieba floor numbers do not imply complete floor pages or nested replies. Project-owned browser installation, disk accounting and crash-cleanup integration remain pending. Source behavior, authorization and history stay intact. Fixture profiles are test material, not actual follows.

## Finish evidence

2026-10-18: independent reviewer disposition ship for this extension; no material fixes. Compared creator-before.png with creators-desktop.png and creators-mobile.png; source and shared CSS agree with the inherited world. Reviewer also inspected creators-mobile-error.png and creators-empty.png. All captures live under .impeccable/review/; creators-actual-desktop.png and creators-actual-mobile.png record the empty real local library. See docs/development/REVIEW-CREATOR-FOLLOWING.md for verification limits. Preserve DESIGN.md and PRODUCT.md; this is not real-platform, user or target-server acceptance.

## Bilibili collection finish evidence

2026-10-18: the fresh independent impeccable_collection_reviewer returned all five review sections with disposition ship and no material fixes for this extension. Evidence: .impeccable/review/creator-collection-desktop.png (1440px, full page), creator-collection-mobile.png (390px, full page) and creator-collection-error.png (390px, read failure/retry), compared with creators-desktop.png and creators-mobile.png. The documenter opened all three new captures and checked the card, disclosure and shared CSS against the incumbent system. Typography, light ground, teal controls, borders and responsive composition remain inherited; no new world or shipping raster assets.

The supplied verification record reports 22/22 related checks with real isolated PostgreSQL/API and the original MediaCrawler Python client; only external platform HTTP used substitutes. Final typecheck and build passed. Saved descriptions, metrics observations and bounded comment samples are distinct from transcription. See docs/development/REVIEW-CREATOR-COLLECTION.md. This is not actual-account, user, target-server or complete seven-platform acceptance; at that Bilibili-only review, the other six collectors, replies, short links and transcription remained pending; later extension scopes are recorded below. DESIGN.md and PRODUCT.md remain unchanged.

## Three-platform and session-settings finish evidence (historical)

2026-10-18: Bilibili, Weibo and XHS use the existing collection controls and disclosures. The notice links to platform-login settings, accurately separates the other four pending collectors, and labels posts, image-text notes and video descriptions separately. Available interaction metrics retain their platform meanings; missing metrics stay unknown. Registration and saved Cookie status do not prove connectivity or completed collection.

Fresh impeccable_platform_reviewer: five sections, ship, no material fixes for the current extension. It inspected all six current screenshots named in the settings surface brief and two prior captures; the documenter opened all six. creator-collection-desktop.png, creator-collection-mobile.png and creator-collection-error.png under .impeccable/review/ show inherited cards, controls, disclosure, wrapping and failure/retry states. PRODUCT.md and DESIGN.md are preserved; no new identity or raster assets.

Supplied verification: 27/27 related checks and final settings browser 2/2, with real isolated PostgreSQL/API and original platform clients behind external HTTP substitutes. See docs/development/REVIEW-CREATOR-MULTIPLATFORM.md for backend review and later verification. Actual accounts, complete seven-platform collection, replies, transcription, user and target-server acceptance remain pending. Model, schedule and Skill settings remain unfinished.

## Zhihu extension finish evidence (historical)

2026-10-18: current adapters are Bilibili, Weibo, XHS and Zhihu; three remain pending. Zhihu adds answer/article body labels, 赞同 metrics and acquired question/column source links inside the existing disclosure. Registration, saved sessions and fixture results do not prove real-platform coverage. Layout, controls, CSS and the code-led light/teal world remain inherited; PRODUCT.md and DESIGN.md are unchanged, with no new comp, assets or system rules.

Fresh impeccable_zhihu_reviewer returned five sections: ship, no material fixes, limited to these labels, metrics and source links. It opened .impeccable/review/zhihu-collection-desktop.png (1440), zhihu-collection-mobile.png (390), creator-collection-error.png, creator-collection-desktop.png and creator-collection-mobile.png. The Bilibili pair is a same-version style comparison already carrying the four-platform notice, not strict historical before evidence. The documenter opened the two Zhihu captures and checked the corresponding JSX.

Subsequent backend-only f909496 preserved source column URLs and corrected signing headers; production UI did not change. zhihu-reviewed.log recaptured the same paths and passed 15/15 (native client 3, PostgreSQL/API 9, browser 3); final typecheck and the existing web build passed. See docs/development/REVIEW-ZHIHU-COLLECTION.md. Actual accounts, remaining three collectors, complete comment replies, media/ASR, user and target-server acceptance remain pending.

## Tieba extension and persistence correction (historical)

2026-10-18, c612dfb/a6ea8ac: current adapters total five, including Tieba; only Douyin and Kuaishou remain unconnected. The original PC client uses one controlled Chromium context and guarded HTTP before queue/private persistence. The UI adds acquired reply floor numbers and updates the capability notice; existing settings metadata exposes five available adapters. No new visual system, CSS, comp or shipping raster assets.

Fresh impeccable_tieba_reviewer returned disposition fix: its sole material finding was the stale four-platform STORY/States contract marking Tieba pending. This documenter pass corrects that persistence item in both briefs, preserves the three-platform/Zhihu evidence as historical, and leaves final fix scoring to the reviewer; no visual-code fix was requested. The documenter opened .impeccable/review/tieba-collection-desktop.png (1440) and tieba-collection-mobile.png (390), checked inherited styles and the floor-number JSX. Reviewer comparisons were zhihu-collection-desktop.png, zhihu-collection-mobile.png and creator-collection-error.png.

Supplied verification: related 31/31; pagination Spec red 2/3 followed by green 11/11 (native 3, architecture 8); browser 4/4; typecheck/build passed. actual-tieba-runtime.log records private 200/visitor 401/no-store, seven missing sessions/five adapters, empty creator library/62 news sources, no overflow at 1440/390 and no account/session writes or upstream/model requests; worker remains disabled. See docs/development/REVIEW-TIEBA-COLLECTION.md. Actual platform/user/Server2022 acceptance, remaining two collectors, nested replies, avatar/media/ASR and project browser installation/storage lifecycle remain incomplete. PRODUCT.md and DESIGN.md are preserved.

## Douyin extension finish evidence (historical)

2026-10-18, implementation 81e9aa1: six adapters are connected in isolated tests; only Kuaishou remains pending. Production UI changes only the capability notice, retaining existing image-text/video labels, content disclosure, metrics, comment samples and controls. No CSS, layout, visual-world, comp or shipping-asset change; PRODUCT.md and DESIGN.md remain intact. Historical counts above retain their original stage.

Fresh impeccable_douyin_reviewer opened .impeccable/review/douyin-collection-desktop.png (1440), douyin-collection-mobile.png (390), the inherited tieba-collection-desktop.png/mobile.png pair and creator-collection-error.png. Its five-section review returned disposition ship with no material fixes, limited to this UI extension. The documenter opened both Douyin captures; inherited light ground, teal actions, system type and responsive cards match the existing world.

Supplied verification: douyin-related-final.log 44/44 after the earlier combined run's API login-fixture failure was corrected through public-session reuse and the existing 303 response; that earlier run's five passing browser checks alone were not an overall pass. Typecheck/build passed. Subsequent 2506a99 shared fixed-signature VM loading without UI changes; both native signing platforms passed 6/6, full typecheck passed and both code-review axes ended at zero. actual-douyin-runtime.log records the same UI on 81e9aa1: visitor 401/private 200/no-store, seven missing sessions/six adapters, zero creators/62 news sources, normal 1440/390 layouts, no production writes or upstream/model requests, worker disabled. See docs/development/REVIEW-DOUYIN-COLLECTION.md. Actual-platform/user/Server2022 acceptance, Kuaishou, replies, avatar/media/ASR and browser installation/storage lifecycle remain pending.

## Kuaishou extension finish evidence

2026-10-18, implementation 7249fcd: all seven collectors are connected for isolated tests. This Operate extension updates the six-to-seven capability notice; existing cards, video descriptions, disclosures, metrics and bounded comment samples remain unchanged. Acquisition still depends on platform sessions, verification and interface availability. No CSS, layout, visual-world, comp or shipping-raster change; PRODUCT.md and DESIGN.md are preserved, as are all historical stage records.

Fresh impeccable_kuaishou_reviewer inspected .impeccable/review/kuaishou-collection-desktop.png (1440), kuaishou-collection-mobile.png (390), douyin-collection-desktop.png, douyin-collection-mobile.png and creator-collection-error.png. Its persistence/fidelity/ceiling/material_fixes/keep sections were complete: disposition ship, no material fixes, TYPE/MATERIAL/GROUND match. This verdict covers the narrow UI extension. The documenter opened both new captures and checked the creator notice and unchanged settings controls against source; neither capture is evidence of a real followed account.

Supplied verification: kuaishou-browser-native-final.log 9/9 (browser 6/native 3), including actual reload recovery after the initial 15-second SDK wait; browser protection/architecture 15/15; initial API/client/protection 20/20; final typecheck/build passed. First-stage full-seven-platform-collection.log was 1032/1033, not a pass; its sole admission fixture used the obsolete 7GiB threshold. Updating that input for the established 4.7GB rule passed the isolated 2/2, with final full regression still outstanding at this record. Backend business-rate-limit Spec work and subsequent results belong to docs/development/REVIEW-KUAISHOU-COLLECTION.md, not this UI verdict.

At this handoff the formal local runtime remained the older six-platform 2506a99 and awaited normal reload; worker/external actions stayed disabled, with no production test sessions or follows inserted. Seven isolated adapters do not imply real-platform, user, Server2022 or complete-product acceptance. Full replies, avatar/media/ASR and project browser installation/storage lifecycle remain unverified.

## P3.2c actual metric history scoped finish (2026-10-19)

A fresh generic Documenter substitutes for the unavailable named role. It individually opened all five current .impeccable/review/metric-history-{desktop,mobile,single-mobile,exact-mobile,frozen-mobile}.png captures and checked metric-history.tsx, creator-metrics.ts, studio.css, MaterialEvidence, topic-batches and creators against PRODUCT.md/DESIGN.md. This code-led ordinary Operate extension inherits the neutral light/teal palette, Chinese system type and five-entry navigation; no new world, comp, QUALITY BAR, seed round, dependency or design raster applies.

The observed story is source and saved body first, then the existing heat-history section: select an available metric, inspect actual observation points, and optionally expand exact Hong Kong times/counts. The plot uses a bounded180px grid, lightweight decorative SVG line/grid, HTML axes and6px points; native select/details preserve keyboard behavior. At1440 the established reading column remains; at390 long values, dates and expanded records wrap without horizontal overflow. One valid point retains its exact zero and explicitly declines a trend; a missing value breaks the line, never becomes zero. The caption rejects continuous-measurement/completion-rate claims and cross-platform comparison. Shared creatorMetricNames keeps likes versus answer/article endorsements consistent.

Sorted display rows are limited to the latest100 valid-time observations; this is a reading window, not a change to the full frozen evidence. The frozen capture uses its own saved metrics and never reads live analysis status; the shared component also serves creator disclosures and manuscript evidence. The supplied real-API/PG/browser pressure case preserves120 observations in current/frozen API evidence while showing100 in either chart. No additional collection/model request or migration is introduced.

Supplied review evidence: both fresh five-section visual rounds returned ship/zero material fixes, with all five same-path captures reopened after8d4f55e. Initial nested SVG img semantics and intrinsic grid overflow blocking the exact-record summary were corrected without forced clicking or relaxed assertions. Independent Standards P3 duplicate metric labels and Spec P2 missing100-row window were resolved and independently rechecked, final axes zero. Final metric-history-window-green-related16/16, zero failed/cancelled/skipped, exit0/26.578s; whole-project types/build passed. The first related14/15 failure remains recorded. Per the user's simple-UI authorization no new full-stage run was repeated; previous P3.2b1270/1271 retains the unresolved old ownership-fixture rename EPERM, so P1.3u/P7.4 remain incomplete.

Supplied formal checks normally stopped95814 and started98211/backend-web8d4f55e/PG0146 with worker/collection/media/models off. actual-metric-history-window-runtime.log records401/missing404/invalid400/model-disabled POST409/private no-store, current completed0/pending0,62 sources/empty business library,4.7GB floor/zero reservations,1440/390 without overflow,21 assets all200 and zero business writes/paid calls. Positive data exists only in isolated real-PG/platform-boundary/browser tests, not real platform or DeepSeek quality acceptance. Job50%CPU/5GiB excludes PostgreSQL/launcher/controller; it does not prove the complete server budget.

Only these three authorized matching briefs are appended through official surface-brief read/write/read; temporary body files remain. This Documenter ran no browsers/tests/services/migrations/commits or deletions. PRODUCT/DESIGN, existing metadata/frontmatter/sidecar/config drift and original seed are preserved, neither repaired nor canonized. Full P3.2/product, real-platform/model semantics, user and Windows Server2022 acceptance remain outside this scoped finish.
