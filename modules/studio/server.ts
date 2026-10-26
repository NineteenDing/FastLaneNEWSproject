import { PUBLIC_HOT_VERSION, calculatePublicHot, publicHeatSeries } from "./backend/public-hot.ts";
import { refreshTrendEventLinks } from "./backend/trend-links.ts";
import { trendNewsQueue, scheduleTrendNews } from "./backend/trend-news.ts";
import { newsTitleQueue, scheduleNewsTitles } from "./backend/news-titles.ts";
import { filmMetadataQueue, scheduleFilmMetadata } from "./backend/film-metadata.ts";
import { recordVisit, visitorStats, allowVisit } from "./backend/visitors.ts";
import type { ServerModule } from "@aihot/backend/modules";
import { fileURLToPath } from "node:url";
import { sendFile } from "../../apps/api/src/routes/static.ts";
import { siteManagement, saveSiteManagement, publicSiteAbout, publicSiteChangelog, CONTACT_FILES } from "./backend/site-management.ts";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { filmTranslationQueue, submitFilmTranslation, scheduleFilmTranslations } from "./backend/film-translation.ts";
import { dailyEditionQueue, dailyEditions, retryDailyEdition, scheduleDailyEditions } from "./backend/daily-editions.ts";
import { filmBoards, minimizeLegacyFilmBoards, saveFilmBoard, filmBoardQueue, submitFilmBoard, scheduleFilmBoards, filmBoardImageAllowed } from "./backend/film-boards.ts";
import { config } from "@aihot/backend/config";
import { publicNewsCondition, publicReportCondition, publicNewsJudgement, publicNewsImageAllowed, reconcilePublicNews } from "./backend/public-news.ts";
import { adminHandler } from "../../apps/api/src/routes/admin-auth.ts";
import { newsSources } from "./backend/news-sources.ts";
import { trendBoards, connectTrendBoard, trendSourcePlatform } from "./backend/trend-sources.ts";
import { trendQueue, enqueueTrend, trendSignals, scheduleTrends } from "./backend/trend-collection.ts";
import { trendRelevanceQueue, submitTrendRelevance, scheduleTrendRelevance } from "./backend/trend-relevance.ts";
import { contentImports, submitContentImport, contentImportQueue } from "./backend/content-imports.ts";
import { trendDeepReadSettings, saveTrendDeepReadSettings, submitTrendDeepRead, scheduleTrendDeepRead } from "./backend/trend-deep-read.ts";
import { writingRevisionQueue, writingRevisions, submitWritingRevision, applyWritingRevision, retryWritingRevision } from "./backend/writing-revisions.ts";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";
import { importNewsSources } from "./backend/import-news.ts";
import { actorOf } from "@aihot/backend/admin/auth";
import { saveNewsProfile } from "./backend/news-profile.ts";
import { assertNewsSourceReady, createNewsSource, newsSourceSettings, updateNewsSource } from "./backend/news-setup.ts";
import { sendProblem } from "../../apps/api/src/http/respond.ts";
import { updateSource } from "@aihot/backend/admin/sources";
import { z } from "zod";
import { newsSourceAvatar, refreshNewsMetadata } from "./backend/news-metadata.ts";
import { newsMetadataQueue, scheduleNewsMetadata } from "./backend/news-metadata-jobs.ts";
import { newsImport, submitNewsImport, newsImportQueue, NEWS_REFERENCE_SOURCE_ID, assertNewsReferenceNotSubscription } from "./backend/news-imports.ts";
import { newsBridgeSettings, saveNewsBridge } from "./backend/news-bridge.ts";
import { readNewsBridge } from "./backend/rsshub-collection.ts";
import { bridgeQueue, enqueueNewsBridge, scheduleNewsBridges } from "./backend/rsshub-jobs.ts";
import { createStorageWorkspaces } from "./backend/storage-workspaces.ts";
import { createHostResourceMonitor } from "./backend/host-resources.ts";
import { createDiskResourceMonitor } from "./backend/disk-resources.ts";
import { createDatabaseResourceMonitor } from "./backend/database-resources.ts";
import { createCollectionAdmission } from "./backend/collection-admission.ts";
import { createImageAssets } from "./backend/image-assets.ts";
import { createImageStorage } from "./backend/image-storage.ts";
import { pruneStorageUnderPressure } from "./backend/storage-maintenance.ts";
import { withImageProcessingAdmission } from "@aihot/backend/media/processing";
import { creatorAccounts, followCreator, updateCreator, updateCreators, creatorSubjects, linkCreatorSubject } from "./backend/creator-following.ts";
import { creatorAvatar } from "./backend/creator-avatar.ts";
import { creatorQueue, creatorContents, enqueueCreator, scheduleCreators } from "./backend/creator-collection.ts";
import { platformSessions, savePlatformSession } from "./backend/platform-sessions.ts";
import { createPlatformLogins, type LoginBrowserFactory } from "./backend/platform-logins.ts";
import { openPlatformLogin } from "./backend/platform-login-browser.ts";
import { acceptanceExamples, seedAcceptanceExamples, clearAcceptanceExamples } from "./backend/acceptance-examples.ts";
import { modelConnection, saveModelConnection } from "./backend/model-connection.ts";
import { prepareReferenceAnalysis, referenceAnalysis, referenceVisionQueue } from "./backend/reference-vision.ts";
import { modelOperations, saveModelOperations } from "./backend/model-operations.ts";
import { modelBudgetSettings, saveModelBudgetSettings } from "./backend/model-budget-settings.ts";
import { collectionOperations, saveCollectionOperations } from "./backend/collection-operations.ts";
import { runtimeComponents } from "./backend/runtime-components.ts";
import { studioBackupQueue, studioBackupStatus, submitStudioBackup, studioBackupConfigured, scheduledStudioBackup } from "./backend/studio-backup.ts";
import { collectionRuntimeAllowed } from "@aihot/backend/operations/collection-control";
import { intelligenceDates, intelligenceDetail, intelligenceList } from "./backend/intelligence.ts";
import { creatorWorkForMaterial, saveCreatorWork } from "./backend/creator-works.ts";
import { saveTopicColumn, topicColumns, topicColumnVersion } from "./backend/topic-columns.ts";
import { filterSettings, saveFilterSettings, filterPolicyVersion } from "./backend/filter-settings.ts";
import { materialScoring, previewFilterSettings } from "./backend/filter-scoring.ts";
import { currentTopicBatch, currentTopicMaterials, currentWindow, freezeTopicBatch, topicBatch, topicBatches, topicBatchMaterials, topicBatchMaterial, topicPresentation } from "./backend/topic-batches.ts";
import { currentTopicPreview, topicPreviewMaterial, submitTopicPreview, topicPreviewQueue, scheduleTopicPreview, pruneTopicPreviews } from "./backend/topic-preview.ts";
import { supplementTopicBatch, supplementCurrentTopic, scheduleTopicSupplementPreviews } from "./backend/topic-supplements.ts";
import { submitTopicSupplementImports, topicSupplementImports, retryTopicSupplementImport, scheduleTopicSupplementImports } from "./backend/topic-supplement-imports.ts";
import { currentSourceCoverage, frozenSourceCoverage } from "./backend/topic-source-coverage.ts";
import { topicPlan, saveTopicPlan } from "./backend/topic-plan.ts";
import { topicFreezeQueue, scheduleTopicBatches } from "./backend/topic-jobs.ts";
import { topicAnalysisQueue, submitTopicAnalysis, topicMaterialAnalyses, scheduleTopicMaterialAnalyses } from "./backend/topic-material-analysis.ts";
import { topicGenerationQueue, submitTopicGeneration, topicRecommendations, scheduleTopicGenerations } from "./backend/topic-directions.ts";
import { topicReviewQueue, submitTopicReview, scheduleTopicReviews } from "./backend/topic-review.ts";
import { topicReview } from "./backend/topic-review-state.ts";
import { topicFeedback, saveTopicFeedback } from "./backend/topic-feedback.ts";
import { createTopicRuleVersion, topicRuleVersions } from "./backend/topic-rule-versions.ts";
import { createWritingProject, copyWritingProject, writingProject, writingProjects, saveWritingProject, writingVersion, writingVersions, changeWritingVersion } from "./backend/writing-projects.ts";
import { writingSkills, saveWritingSkill, writingSkillVersions, writingSkillVersion, restoreWritingSkill } from "./backend/writing-skills.ts";
import { writingGenerationQueue, submitWritingGeneration, writingGeneration, applyGeneratedWriting } from "./backend/writing-generation.ts";
import { writingImages, uploadWritingImage, removeWritingImage } from "./backend/writing-images.ts";
import { exportWriting } from "./backend/writing-export.ts";
import { mediaProcessingQueue, mediaProcessingStatus, enqueueMediaProcessing, maintainMediaWorkspaces } from "./backend/media-jobs.ts";
import { modelUsage } from "./backend/model-usage.ts";
import { languageSamples } from "./backend/language-samples.ts";
import { historySearch, indexHistoryMaterial } from "./backend/history-index.ts";
import { requestMaterialAnalysis } from "./backend/material-analysis-pending.ts";
import { liveMaterialAnalysis, retryLiveMaterialAnalysis } from "./backend/live-material-analysis.ts";
import { retryCurrentMaterialClassification } from "./backend/current-material-classification.ts";
import { materialEvent } from "./backend/shared-events.ts";
import { requestSourceImages, sourceImages, submitSourceImages, sourceImagesQueue, scheduleSourceImages } from "./backend/source-images.ts";
import { historyRebuildQueue, historyIndexStatus, submitHistoryRebuild, scheduleHistoryRebuild } from "./backend/history-rebuild.ts";
import { topicHistory } from "./backend/topic-history.ts";
import { historySettings, saveHistorySettings } from "./backend/history-settings.ts";
import { styleLearningQueue, styleLearning, submitStyleLearning, styleLearningSettings, saveStyleLearningSettings, scheduleStyleLearning } from "./backend/style-learning.ts";
import { creatorExpressionQueue, creatorExpressions, submitCreatorExpressions, scheduleCreatorExpressions } from "./backend/creator-expressions.ts";
import { creatorAccount } from "./backend/creator-following.ts";

/** API monitor ownership is per app; workers keep their separately owned queue admission. */
export const createStudioServer = (resources: {
  host?: ReturnType<typeof createHostResourceMonitor>;
  disk?: ReturnType<typeof createDiskResourceMonitor>;
  database?: ReturnType<typeof createDatabaseResourceMonitor>;
  loginBrowser?: LoginBrowserFactory;
} = {}): ServerModule => ({
  name: "studio",
  changelog: publicSiteChangelog,
  internalNotifications: "disabled",
  admin: { passwordUsername: () => config.adminUsername ?? "admin" },
  editorialPipeline: "disabled",
  publication: { condition: publicNewsCondition, reportCondition: publicReportCondition, reportKinds: ["daily"], revalidate: true, browseWindowHours: 120,
    hot: { ruleVersion: PUBLIC_HOT_VERSION, calculate: calculatePublicHot, series: publicHeatSeries },
    judgement: publicNewsJudgement, imageAllowed: async url => await publicNewsImageAllowed(url) || await filmBoardImageAllowed(url) },
  on: { materialStored: async ({ id }, db) => { await indexHistoryMaterial(db, "news:" + id); await requestMaterialAnalysis(db, "news:" + id); await requestSourceImages(db, id); } },
  sourceKinds: { web_list: { validateCollection: assertNewsSourceReady }, external: {
    validateCollection: async source => assertNewsReferenceNotSubscription(source),
    canCollect: async (source, db) => source.id !== NEWS_REFERENCE_SOURCE_ID && !await trendSourcePlatform(source.id, db),
    read: async source => {
      assertNewsReferenceNotSubscription(source);
      if (await trendSourcePlatform(source.id)) throw new UnsupportedConfig("热榜线索使用专属检查任务，不按新闻正文采集");
      return readNewsBridge(source);
    },
    fetchNow: async source => {
      assertNewsReferenceNotSubscription(source);
      const platform = await trendSourcePlatform(source.id);
      return platform ? (await enqueueTrend(platform, "system:source-fetch"))! : enqueueNewsBridge(source);
    },
  } },
  queues: [trendNewsQueue, filmMetadataQueue, newsTitleQueue, filmBoardQueue, filmTranslationQueue, dailyEditionQueue, studioBackupQueue, bridgeQueue, creatorQueue, contentImportQueue, newsImportQueue, trendQueue, trendRelevanceQueue, mediaProcessingQueue, sourceImagesQueue, newsMetadataQueue, topicFreezeQueue, topicAnalysisQueue, topicGenerationQueue, topicPreviewQueue, topicReviewQueue, writingGenerationQueue, writingRevisionQueue, referenceVisionQueue, styleLearningQueue, creatorExpressionQueue, historyRebuildQueue],
  models: { studioMaterialAnalysis: { label: "创作材料归类与初筛", env: "STUDIO_MATERIAL_ANALYSIS_MODEL", purposes: ["studio_news_title_translation", "studio_film_translation", "studio_material_analysis", "studio_trend_relevance", "studio_style_creator"] },
    studioTopicGeneration: { label: "创作选题综合初版", env: "STUDIO_TOPIC_GENERATION_MODEL", purposes: ["studio_topic_generation", "studio_daily_edition"] },
    studioTopicReview: { label: "创作选题独立审核与裁决", env: "STUDIO_TOPIC_REVIEW_MODEL", purposes: ["studio_topic_review"] },
    studioWriting: { label: "独立中文口播与制作方案", env: "STUDIO_WRITING_MODEL", purposes: ["studio_writing_draft", "studio_writing_polish", "studio_writing_check", "studio_writing_repair", "studio_writing_check_repaired",
      "studio_writing_revision", "studio_writing_revision_check", "studio_style_candidate", "studio_style_baseline_0", "studio_style_trial_0", "studio_style_compare_0", "studio_style_baseline_1", "studio_style_trial_1", "studio_style_compare_1"] } },
  sourceCollectionAdmission: createCollectionAdmission(),
  backup: { configured: studioBackupConfigured, run: scheduledStudioBackup },
  mediaPreparationAdmission: createCollectionAdmission({ heavy: true, enabled: () => true }),
  imageCacheWrite: (bytes, write) => createImageStorage().write(bytes, write),
  imageCachePrune: before => createImageStorage().prune(before),
  retention: async now => ({ studioImageAssetsRemoved: (await createImageAssets().prune(new Date(now.getTime() - 30 * 86400_000))).removed,
    studioTopicPreviewsRemoved: await pruneTopicPreviews(now) }),
  schedules: [
    { name: "studio.film.metadata.schedule", cron: "*/2 * * * *", when: collectionRuntimeAllowed, run: scheduleFilmMetadata },
    { name: "studio.news.titles.schedule", cron: "*/2 * * * *", run: () => scheduleNewsTitles() },
    { name: "studio.trends.news.schedule", cron: "* * * * *", when: collectionRuntimeAllowed, run: scheduleTrendNews },
    { name: "studio.trends.links.schedule", cron: "* * * * *", run: refreshTrendEventLinks },
    { name: "studio.news.publication.schedule", cron: "* * * * *", missed: "once", run: reconcilePublicNews },
    { name: "studio.news.daily.schedule", cron: "* * * * *", missed: "once", run: scheduleDailyEditions },
    { name: "studio.film.translation.schedule", cron: "*/5 * * * *", run: scheduleFilmTranslations },
    { name: "studio.film.schedule", cron: "* * * * *", missed: "once", when: collectionRuntimeAllowed, run: scheduleFilmBoards },
    { name: "studio.news.hot.schedule", cron: "*/5 * * * *", run: () => computeHotRanking() },
    { name: "studio.news.heat.schedule", cron: "2 * * * *", run: () => snapshotHeat() },
    { name: "studio.news.metadata.schedule", cron: "15 * * * *", missed: "once", when: collectionRuntimeAllowed, run: scheduleNewsMetadata },
    { name: "studio.rsshub.schedule", cron: "* * * * *", when: collectionRuntimeAllowed, run: scheduleNewsBridges },
    { name: "studio.trends.schedule", cron: "* * * * *", when: collectionRuntimeAllowed, run: scheduleTrends },
    { name: "studio.trends.relevance.schedule", cron: "* * * * *", run: scheduleTrendRelevance },
    { name: "studio.trends.deep-read.schedule", cron: "* * * * *", run: scheduleTrendDeepRead },
    { name: "studio.creator.schedule", cron: "* * * * *", when: collectionRuntimeAllowed, run: scheduleCreators },
    { name: "studio.storage.pressure", cron: "* * * * *", missed: "once", run: pruneStorageUnderPressure },
    { name: "studio.media.cleanup", cron: "* * * * *", missed: "once", run: maintainMediaWorkspaces },
    { name: "studio.topic.schedule", cron: "* * * * *", missed: "once", run: scheduleTopicBatches },
    { name: "studio.topic.material-analysis.schedule", cron: "* * * * *", missed: "once", run: scheduleTopicMaterialAnalyses },
    { name: "studio.topic.preview.schedule", cron: "*/5 * * * *", missed: "once", run: scheduleTopicPreview },
    { name: "studio.topic.supplements.schedule", cron: "* * * * *", missed: "once", run: scheduleTopicSupplementPreviews },
    { name: "studio.topic.supplement-imports.schedule", cron: "* * * * *", missed: "once", run: scheduleTopicSupplementImports },
    { name: "studio.topic.generate.schedule", cron: "* * * * *", missed: "once", run: scheduleTopicGenerations },
    { name: "studio.topic.review.schedule", cron: "* * * * *", missed: "once", run: scheduleTopicReviews },
    { name: "studio.style.learn.schedule", cron: "0 4 * * 0", missed: "once", run: scheduleStyleLearning },
    { name: "studio.creator.expressions.schedule", cron: "0 3 * * *", missed: "once", run: scheduleCreatorExpressions },
    { name: "studio.history.schedule", cron: "* * * * *", missed: "once", run: scheduleHistoryRebuild },
    { name: "studio.news.images.schedule", cron: "* * * * *", missed: "once", run: scheduleSourceImages },
  ],
  http(app) {
    app.addHook("onReady", minimizeLegacyFilmBoards);
    app.post("/api/site/visits", { bodyLimit: 2048 }, async (req, reply) => {
      const origin = req.headers.origin;
      if (req.headers["sec-fetch-site"] === "cross-site" || origin && origin !== config.siteUrl && origin !== new URL(config.siteUrl).origin && origin !== new URL(`http://${req.headers.host}`).origin && origin !== new URL(`https://${req.headers.host}`).origin) return reply.code(403).send();
      if (!allowVisit(req.ip, req.headers["user-agent"] ?? "")) return reply.code(429).header("Retry-After", "60").send();
      try { if (!/bot|crawler|spider|headless/i.test(req.headers["user-agent"] ?? "")) await recordVisit(req.body); }
      catch (error) { if (error instanceof z.ZodError) return reply.code(400).send({ error: "无效访问记录" }); throw error; }
      return reply.code(204).send();
    });
    app.get("/api/admin/studio/visitors", adminHandler(req => visitorStats(req.query)));
    app.get("/api/site/about", async () => publicSiteAbout());
    app.get("/api/site/studio-contact/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      if (!Object.hasOwn(CONTACT_FILES, file)) return reply.code(404).send();
      return sendFile(req, reply, fileURLToPath(new URL(`./assets/contact/${file}`, import.meta.url)), { cacheControl: "public, max-age=86400" });
    });
    app.get("/api/admin/studio/site-management", adminHandler(async () => siteManagement()));
    app.put("/api/admin/studio/site-management", adminHandler(async (req, _reply, admin) => saveSiteManagement(req.body, actorOf(admin))));
    app.addHook("onSend", async (req, reply, payload) => {
      const path = req.url.split("?")[0]!;
      // Keep prepared server-side bytes; every public request still checks current approval.
      if (/^\/(?:api\/(?:site|v1|mcp|img-proxy)(?:\/|$)|feed(?:\/|\.xml)|og\/|items\/|sitemap\.xml$|llms(?:-full)?\.txt$)/.test(path)) {
        reply.header("Cache-Control", "no-store").header("X-Accel-Expires", "0");
      }
      return payload;
    });
    const hostResources = resources.host ?? createHostResourceMonitor();
    const diskResources = resources.disk ?? createDiskResourceMonitor();
    const databaseResources = resources.database ?? createDatabaseResourceMonitor();
    const platformLogins = createPlatformLogins({ browser: resources.loginBrowser ?? openPlatformLogin,
      canStart: () => hostResources.status().state === "ready" && diskResources.status().heavyTaskAllowed && databaseResources.status().ingestionAllowed });
    app.addHook("onRequest", (_req, _reply, done) => withImageProcessingAdmission(() =>
      hostResources.status().state === "ready" && diskResources.status().heavyTaskAllowed
      && databaseResources.status().ingestionAllowed, done));
    let stopHostMonitor: (() => void) | undefined, stopDiskMonitor: (() => void) | undefined, stopDatabaseMonitor: (() => void) | undefined;
    app.addHook("onReady", async () => {
      stopHostMonitor = hostResources.start(); stopDiskMonitor = diskResources.start();
      stopDatabaseMonitor = databaseResources.start();
    });
    app.addHook("onClose", async () => { await platformLogins.close(); stopHostMonitor?.(); stopDiskMonitor?.(); stopDatabaseMonitor?.(); });
    app.get("/api/admin/studio/daily-editions", adminHandler(async () => dailyEditions()));
    app.get("/api/site/film-boards", async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      try { return await filmBoards(req.query); }
      catch (error) {
        if (error instanceof z.ZodError) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "请选择国内或国外影视榜。" });
        throw error;
      }
    });
    app.get("/api/admin/studio/film-boards", adminHandler(async () => filmBoards({ includeRetired: true })));
    app.post("/api/admin/studio/film-boards/:id/translate", adminHandler(req => submitFilmTranslation((req.params as { id: string }).id, true)));
    app.post("/api/admin/studio/film-boards/:id/collect", adminHandler(async (req, _reply, admin) => submitFilmBoard((req.params as { id: string }).id, actorOf(admin))));
    app.put("/api/admin/studio/film-boards/:id", adminHandler(async (req, _reply, admin) => saveFilmBoard((req.params as { id: string }).id, req.body, actorOf(admin))));
    app.post("/api/admin/studio/daily-editions/:day/retry", adminHandler(async req => retryDailyEdition((req.params as { day: string }).day)));
    app.get("/api/admin/studio/host-resources", adminHandler(async () => hostResources.status()));
    app.get("/api/admin/studio/disk-resources", adminHandler(async () => diskResources.status()));
    app.get("/api/admin/studio/database-resources", adminHandler(async () => databaseResources.status()));
    app.get("/api/admin/studio/storage", adminHandler(async () => createStorageWorkspaces().status()));
    app.get("/api/admin/studio/image-assets", adminHandler(async () => createImageAssets().status()));
    app.get("/api/admin/studio/image-storage", adminHandler(async () => createImageStorage().status()));
    app.get("/api/admin/studio/image-assets/:id", adminHandler(async (req, reply) => {
      const image = await createImageAssets().read((req.params as { id: string }).id);
      if (!image) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "图片素材尚未保存或已失效" });
      return reply.header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox").type(image.type).send(image.body);
    }));
    app.get("/api/admin/studio/news-sources", adminHandler(async (req) => newsSources(req.query)));
    app.post("/api/admin/studio/news-titles/retry", adminHandler(() => scheduleNewsTitles(true)));
    app.get("/api/admin/studio/trends/boards", adminHandler(trendBoards));
    app.post("/api/admin/studio/trends/boards/:platform", adminHandler((req, _reply, admin) =>
      connectTrendBoard((req.params as { platform: string }).platform, req.body, actorOf(admin))));
    app.get("/api/admin/studio/trends/signals", adminHandler(req => trendSignals(req.query)));
    app.post("/api/admin/studio/trends/relevance", adminHandler((req, _reply, admin) => submitTrendRelevance(req.body, actorOf(admin))));
    app.get("/api/admin/studio/trends/deep-read-settings", adminHandler(() => trendDeepReadSettings()));
    app.put("/api/admin/studio/trends/deep-read-settings", adminHandler((req, _reply, admin) => saveTrendDeepReadSettings(req.body, actorOf(admin))));
    app.post("/api/admin/studio/trends/deep-read", adminHandler((req, _reply, admin) => submitTrendDeepRead(req.body, actorOf(admin))));
    app.post("/api/admin/studio/trends/boards/:platform/check", adminHandler(async (req, reply, admin) => {
      z.object({}).strict().parse(req.body ?? {});
      return await enqueueTrend((req.params as { platform: string }).platform, actorOf(admin))
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "热榜尚未接入" });
    }));
    app.get("/api/admin/studio/history", adminHandler(req => historySearch(req.query)));
    app.get("/api/admin/studio/history-settings", adminHandler(() => historySettings()));
    app.put("/api/admin/studio/history-settings", adminHandler((req, _reply, admin) => saveHistorySettings(req.body, actorOf(admin))));
    app.get("/api/admin/studio/history-index", adminHandler(historyIndexStatus));
    app.get("/api/admin/studio/topic-batches/:id/history", adminHandler(async (req, reply) =>
      await topicHistory((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.post("/api/admin/studio/history-index", adminHandler((req, _reply, admin) => submitHistoryRebuild(req.body, actorOf(admin))));
    app.get("/api/admin/studio/platform-sessions", adminHandler(platformSessions));
    app.get("/api/admin/studio/acceptance-examples", adminHandler(acceptanceExamples));
    app.post("/api/admin/studio/acceptance-examples", adminHandler((req, _reply, admin) => seedAcceptanceExamples(req.body, actorOf(admin))));
    app.delete("/api/admin/studio/acceptance-examples", adminHandler((req, _reply, admin) => clearAcceptanceExamples(req.body, actorOf(admin))));
    app.post("/api/admin/studio/platform-logins", adminHandler((req, _reply, admin) => platformLogins.start(req.body, actorOf(admin))));
    app.get("/api/admin/studio/platform-logins/:id", adminHandler(async req => platformLogins.status((req.params as { id: string }).id)));
    app.get("/api/admin/studio/platform-logins/:id/frame", adminHandler(async (req, reply) => reply.type("image/jpeg").header("X-Content-Type-Options", "nosniff")
      .send(await platformLogins.frame((req.params as { id: string }).id))));
    app.post("/api/admin/studio/platform-logins/:id/actions", adminHandler((req) => platformLogins.action((req.params as { id: string }).id, req.body)));
    app.delete("/api/admin/studio/platform-logins/:id", adminHandler((req) => platformLogins.cancel((req.params as { id: string }).id)));
    app.get("/api/admin/studio/model-connection", adminHandler(modelConnection));
    app.get("/api/admin/studio/model-operations", adminHandler(() => modelOperations()));
    app.get("/api/admin/studio/collection-operations", adminHandler(async () => collectionOperations()));
    app.get("/api/admin/studio/runtime-components", adminHandler(runtimeComponents));
    app.get("/api/admin/studio/backup", adminHandler(studioBackupStatus));
    app.post("/api/admin/studio/backup", adminHandler((req, _reply, admin) => submitStudioBackup(req.body, actorOf(admin))));
    app.put("/api/admin/studio/collection-operations", adminHandler((req, _reply, admin) => saveCollectionOperations(req.body, actorOf(admin))));
    app.get("/api/admin/studio/model-usage", adminHandler(modelUsage));
    app.get("/api/admin/studio/model-budget", adminHandler(async () => modelBudgetSettings()));
    app.put("/api/admin/studio/model-budget", adminHandler(async (req, _reply, admin) => saveModelBudgetSettings(req.body, actorOf(admin))));
    app.put("/api/admin/studio/model-operations", adminHandler(async (req, _reply, admin) => saveModelOperations(req.body, actorOf(admin))));
    app.put("/api/admin/studio/model-connection", adminHandler(async (req, _reply, admin) => saveModelConnection(req.body, actorOf(admin))));
    app.put("/api/admin/studio/platform-sessions/:platform", adminHandler(async (req, _reply, admin) =>
      savePlatformSession((req.params as { platform: string }).platform, req.body, actorOf(admin))));
    app.get("/api/admin/studio/creators", adminHandler(async req => creatorAccounts(req.query)));
    app.get("/api/admin/studio/creators/:id", adminHandler(async (req, reply) =>
      await creatorAccount((req.params as { id: string }).id)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主不存在" })));
    app.post("/api/admin/studio/creators/batch", adminHandler(async (req, _reply, admin) => updateCreators(req.body, actorOf(admin))));
    app.get("/api/admin/studio/creator-subjects", adminHandler(req => creatorSubjects(req.query)));
    app.post("/api/admin/studio/creator-subjects", adminHandler((req, _reply, admin) => linkCreatorSubject(req.body, actorOf(admin))));
    app.get("/api/admin/studio/creators/:id/avatar", adminHandler(async (req, reply) => {
      const image = await creatorAvatar((req.params as { id: string }).id, req.query);
      if (!image) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主头像尚未取得" });
      return reply.header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox").type(image.type).send(image.body);
    }));
    app.get("/api/admin/studio/content-imports", adminHandler(contentImports));
    app.post("/api/admin/studio/news-imports", adminHandler((req, _reply, admin) => submitNewsImport(req.body, actorOf(admin))));
    app.get("/api/admin/studio/news-imports/:id", adminHandler(async (req, reply) =>
      await newsImport((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻原稿导入不存在" })));
    app.post("/api/admin/studio/content-imports", adminHandler((req, _reply, admin) => submitContentImport(req.body, actorOf(admin))));
    app.get("/api/admin/studio/media-processing/:id", adminHandler(async (req, reply) =>
      await mediaProcessingStatus((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "视频材料不存在" })));
    app.post("/api/admin/studio/media-processing/:id", adminHandler(async (req, reply, admin) => {
      const options = z.object({ retryFailed: z.boolean().optional() }).strict().parse(req.body ?? {});
      return await enqueueMediaProcessing((req.params as { id: string }).id, actorOf(admin), options)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "视频材料不存在" });
    }));
    app.get("/api/admin/studio/columns", adminHandler(topicColumns));
    app.get("/api/admin/studio/filter-settings", adminHandler(filterSettings));
    app.post("/api/admin/studio/filter-settings/preview", adminHandler(req => previewFilterSettings(req.body)));
    app.get("/api/admin/studio/intelligence/:id/scoring", adminHandler(async (req, reply) =>
      await materialScoring((req.params as { id: string }).id) ?? reply.code(404).send({ error: "未找到材料" })));
    app.put("/api/admin/studio/filter-settings", adminHandler((req, _reply, admin) => saveFilterSettings(req.body, actorOf(admin))));
    app.get("/api/admin/studio/filter-settings/versions/:version", adminHandler(async (req, reply) =>
      await filterPolicyVersion((req.params as { version: string }).version) ?? reply.code(404).send({ error: "未找到该筛选规则版本" })));
    app.get("/api/admin/studio/columns/:id/learning", adminHandler(async (req, reply) =>
      await styleLearning((req.params as { id: string }).id, req.query) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "栏目不存在" })));
    app.get("/api/admin/studio/columns/:id/learning/config", adminHandler(async (req, reply) =>
      await styleLearningSettings((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "栏目不存在" })));
    app.put("/api/admin/studio/columns/:id/learning/config", adminHandler(async (req, reply, admin) =>
      await saveStyleLearningSettings((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "栏目不存在" })));
    app.post("/api/admin/studio/columns/:id/learning", adminHandler(async (req, reply, admin) =>
      await submitStyleLearning((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "栏目不存在" })));
    app.get("/api/admin/studio/writing-skills", adminHandler(writingSkills));
    app.get("/api/admin/studio/writing-skills/:id/versions", adminHandler(async (req, reply) =>
      await writingSkillVersions((req.params as { id: string }).id, req.query) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "写作规则不存在" })));
    app.get("/api/admin/studio/writing-skills/:id/versions/:version", adminHandler(async (req, reply) => {
      const { id, version } = req.params as { id: string; version: string };
      return await writingSkillVersion(id, version) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "写作规则版本不存在" });
    }));
    app.get("/api/admin/studio/language-samples", adminHandler(req => languageSamples(req.query)));
    app.post("/api/admin/studio/writing-skills", adminHandler((req, _reply, admin) => saveWritingSkill(null, req.body, actorOf(admin))));
    app.patch("/api/admin/studio/writing-skills/:id", adminHandler(async (req, reply, admin) =>
      await saveWritingSkill((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "写作规则不存在" })));
    app.post("/api/admin/studio/writing-skills/:id/restore", adminHandler(async (req, reply, admin) =>
      await restoreWritingSkill((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "写作规则版本不存在" })));
    app.get("/api/admin/studio/drafts", adminHandler(req => writingProjects(req.query)));
    app.post("/api/admin/studio/reference-analyses", adminHandler((req, _reply, admin) => prepareReferenceAnalysis(req.body, actorOf(admin))));
    app.get("/api/admin/studio/reference-analyses/:id", adminHandler(async (req, reply) =>
      await referenceAnalysis((req.params as {id: string}).id) ?? sendProblem(req, reply, {status:404,code:"not_found",detail:"参考分析不存在"})));
    app.post("/api/admin/studio/drafts", adminHandler((req, _reply, admin) => createWritingProject(req.body, actorOf(admin))));
    app.post("/api/admin/studio/drafts/:id/copy", adminHandler(async (req, reply, admin) =>
      await copyWritingProject((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.get("/api/admin/studio/drafts/:id/revisions", adminHandler(async (req, reply) =>
      await writingRevisions((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.post("/api/admin/studio/drafts/:id/revisions", adminHandler(async (req, reply, admin) =>
      await submitWritingRevision((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    for (const operation of ["apply", "retry"] as const) app.post(`/api/admin/studio/drafts/:id/revisions/:revisionId/${operation}`, adminHandler(async (req, reply, admin) => {
      const { id, revisionId } = req.params as { id: string; revisionId: string };
      return await (operation === "apply" ? applyWritingRevision : retryWritingRevision)(id, revisionId, req.body, actorOf(admin))
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "这篇稿件没有对应的修改建议" });
    }));
    app.post("/api/admin/studio/drafts/:id/export", adminHandler(async (req, reply, admin) => {
      const result = await exportWriting((req.params as { id: string }).id, req.body, actorOf(admin));
      if (!result) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" });
      return reply.type(result.type).header("Content-Disposition", `attachment; filename="${result.name}"`).header("X-Studio-Writing-Version", String(result.version)).send(result.stream);
    }));
    app.get("/api/admin/studio/drafts/:id", adminHandler(async (req, reply) =>
      await writingProject((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.get("/api/admin/studio/drafts/:id/images", adminHandler(async (req, reply) =>
      await writingImages((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.post("/api/admin/studio/drafts/:id/images", adminHandler(async (req, reply, admin) =>
      await uploadWritingImage((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.delete("/api/admin/studio/drafts/:id/images/:assetId", adminHandler(async (req, reply, admin) => {
      const { id, assetId } = req.params as { id: string; assetId: string };
      return await removeWritingImage(id, assetId, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" });
    }));
    app.get("/api/admin/studio/drafts/:id/generation", adminHandler(async (req, reply) =>
      await writingGeneration((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.post("/api/admin/studio/drafts/:id/generation", adminHandler(async (req, reply, admin) =>
      await submitWritingGeneration((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.post("/api/admin/studio/drafts/:id/generation/:generationId/apply", adminHandler(async (req, reply, admin) => {
      const { id, generationId } = req.params as { id: string; generationId: string };
      return await applyGeneratedWriting(id, generationId, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "这篇稿件没有对应的AI版本" });
    }));
    app.patch("/api/admin/studio/drafts/:id", adminHandler(async (req, reply, admin) =>
      await saveWritingProject((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    for (const [path, mode] of [["finalize", "final"], ["restore", "restore"]] as const) app.post(`/api/admin/studio/drafts/:id/${path}`, adminHandler(async (req, reply, admin) =>
      await changeWritingVersion((req.params as { id: string }).id, req.body, mode, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.get("/api/admin/studio/drafts/:id/versions", adminHandler(async (req, reply) =>
      await writingVersions((req.params as { id: string }).id, req.query) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件不存在" })));
    app.get("/api/admin/studio/drafts/:id/versions/:version", adminHandler(async (req, reply) => {
      const { id, version } = req.params as { id: string; version: string };
      return await writingVersion(id, version) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "稿件版本不存在" });
    }));
    app.get("/api/admin/studio/topic-plan", adminHandler(() => topicPlan()));
    app.put("/api/admin/studio/topic-plan", adminHandler((req, _reply, admin) => saveTopicPlan(req.body, actorOf(admin))));
    app.get("/api/admin/studio/topic-batches/current", adminHandler(currentTopicBatch));
    app.get("/api/admin/studio/topic-supplement-imports", adminHandler(req => topicSupplementImports(req.query)));
    app.post("/api/admin/studio/topic-supplement-imports", adminHandler((req, _reply, admin) => submitTopicSupplementImports(req.body, actorOf(admin))));
    app.post("/api/admin/studio/topic-supplement-imports/:id/retry", adminHandler(async (req, reply, admin) =>
      await retryTopicSupplementImport((req.params as { id: string }).id, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "补充记录不存在" })));
    app.post("/api/admin/studio/topic-batches/current/supplements", adminHandler((req, _reply, admin) => supplementCurrentTopic(req.body, actorOf(admin))));
    app.get("/api/admin/studio/topic-batches/presentation", adminHandler(topicPresentation));
    app.get("/api/admin/studio/topic-batches/current/preview", adminHandler(currentTopicPreview));
    app.get("/api/admin/studio/topic-previews/:id/versions/:version/materials/:materialId", adminHandler(async (req, reply) => {
      const { id, version, materialId } = req.params as { id: string; version: string; materialId: string };
      return await topicPreviewMaterial(id, version, materialId) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "候选保存的材料已不可用，请刷新后查看" });
    }));
    app.post("/api/admin/studio/topic-batches/current/preview", adminHandler((req, _reply, admin) => submitTopicPreview(req.body, actorOf(admin))));
    app.get("/api/admin/studio/topic-batches/current/coverage", adminHandler(async req => currentSourceCoverage(await currentWindow(), req.query)));
    app.get("/api/admin/studio/topic-batches/:id/coverage", adminHandler(async (req, reply) =>
      await frozenSourceCoverage((req.params as { id: string }).id, req.query) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.get("/api/admin/studio/topic-batches/current/materials", adminHandler(req => currentTopicMaterials(req.query)));
    app.get("/api/admin/studio/topic-batches", adminHandler(req => topicBatches(req.query)));
    app.post("/api/admin/studio/topic-batches/:id/supplements", adminHandler(async (req, reply, admin) =>
      await supplementTopicBatch((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.get("/api/admin/studio/topic-batches/:id/directions/:directionId/feedback", adminHandler(async (req, reply) => {
      const { id, directionId } = req.params as { id: string; directionId: string };
      return await topicFeedback(id, directionId) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "已审核的选题方向不存在" });
    }));
    app.put("/api/admin/studio/topic-batches/:id/directions/:directionId/feedback", adminHandler(async (req, reply, admin) => {
      const { id, directionId } = req.params as { id: string; directionId: string };
      return await saveTopicFeedback(id, directionId, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "已审核的选题方向不存在" });
    }));
    app.get("/api/admin/studio/topic-batches/:id/versions", adminHandler(async (req, reply) =>
      await topicRuleVersions((req.params as {id: string}).id) ?? sendProblem(req, reply, {status: 404, code: "not_found", detail: "选题批次不存在"})));
    app.post("/api/admin/studio/topic-batches/:id/versions", adminHandler(async (req, reply, admin) => {
      const result = await createTopicRuleVersion((req.params as {id: string}).id, req.body, actorOf(admin), () => hostResources.status().state === "ready"
        && diskResources.status().heavyTaskAllowed && databaseResources.status().ingestionAllowed);
      if (!result) return sendProblem(req, reply, {status: 404, code: "not_found", detail: "选题批次不存在"});
      if ("waiting" in result) return sendProblem(req, reply, {status: 503, code: "resources_unavailable", detail: "资源尚未就绪，请稍后重试规则重选"});
      const submitted = await submitTopicAnalysis(result.batchId, actorOf(admin));
      return { ...result, queuedCount: submitted?.queuedCount ?? 0 };
    }));
    app.get("/api/admin/studio/topic-batches/:id/review", adminHandler(async (req, reply) =>
      await topicReview((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.post("/api/admin/studio/topic-batches/:id/review", adminHandler(async (req, reply, admin) => {
      const input = z.object({ retryFailed: z.boolean().optional() }).strict().parse(req.body ?? {});
      return await submitTopicReview((req.params as { id: string }).id, actorOf(admin), input)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" });
    }));
    app.get("/api/admin/studio/topic-batches/:id/recommendations", adminHandler(async (req, reply) =>
      await topicRecommendations((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.post("/api/admin/studio/topic-batches/:id/recommendations", adminHandler(async (req, reply, admin) => {
      const input = z.object({ retryFailed: z.boolean().optional() }).strict().parse(req.body ?? {});
      return await submitTopicGeneration((req.params as { id: string }).id, actorOf(admin), input)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" });
    }));
    app.get("/api/admin/studio/topic-batches/:id/analysis", adminHandler(async (req, reply) =>
      await topicMaterialAnalyses((req.params as { id: string }).id, req.query)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.post("/api/admin/studio/topic-batches/:id/analysis", adminHandler(async (req, reply, admin) => {
      const options = z.object({ retryFailed: z.boolean().optional() }).strict().parse(req.body);
      return await submitTopicAnalysis((req.params as { id: string }).id, actorOf(admin), options)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" });
    }));
    app.post("/api/admin/studio/topic-batches", adminHandler(async (req, reply, admin) => {
      const result = await freezeTopicBatch(req.body, actorOf(admin), () => hostResources.status().state === "ready"
        && diskResources.status().heavyTaskAllowed && databaseResources.status().ingestionAllowed);
      return "waiting" in result ? sendProblem(req, reply, { status: 503, code: "resources_unavailable", retryAfter: 60,
        detail: "reason" in result && result.reason === "media_processing" ? "本批视频仍在排队或转写，处理完成后再冻结选题，避免遗漏完整正文"
          : "资源尚未就绪或容量不足，暂缓新批次快照；已有批次仍可查看" }) : result;
    }));
    app.get("/api/admin/studio/topic-batches/:id", adminHandler(async (req, reply) =>
      await topicBatch((req.params as { id: string }).id)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.get("/api/admin/studio/topic-batches/:id/materials", adminHandler(async (req, reply) =>
      await topicBatchMaterials((req.params as { id: string }).id, req.query)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "选题批次不存在" })));
    app.get("/api/admin/studio/topic-batches/:id/materials/:materialId", adminHandler(async (req, reply) => {
      const params = req.params as { id: string; materialId: string };
      return await topicBatchMaterial(params.id, params.materialId)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "这个选题版本未保存该材料，不能用当前原文替代" });
    }));
    app.post("/api/admin/studio/columns", adminHandler(async (req, _reply, admin) => saveTopicColumn(null, req.body, actorOf(admin))));
    app.patch("/api/admin/studio/columns/:id", adminHandler(async (req, reply, admin) =>
      await saveTopicColumn((req.params as { id: string }).id, req.body, actorOf(admin))
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "栏目不存在" })));
    app.get("/api/admin/studio/columns/:id/versions/:version", adminHandler(async (req, reply) => {
      const { id, version } = req.params as { id: string; version: string };
      return await topicColumnVersion(id, version) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "栏目版本不存在" });
    }));
    app.get("/api/admin/studio/intelligence", adminHandler(async req => intelligenceList(req.query)));
    app.post("/api/admin/studio/creator-works", adminHandler(async (req, _reply, admin) => saveCreatorWork(null, req.body, actorOf(admin))));
    app.put("/api/admin/studio/creator-works/:id", adminHandler(async (req, reply, admin) =>
      await saveCreatorWork((req.params as { id: string }).id, req.body, actorOf(admin)) ?? reply.code(404).send({ error: "作品关联不存在" })));
    app.get("/api/admin/studio/intelligence/:id/work", adminHandler(async (req, reply) =>
      await creatorWorkForMaterial((req.params as { id: string }).id) ?? reply.code(404).send({ error: "材料尚未收录" })));
    app.get("/api/admin/studio/intelligence/dates", adminHandler(async req => intelligenceDates(req.query)));
    app.get("/api/admin/studio/intelligence/:id/event", adminHandler(async (req, reply) =>
      await materialEvent((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "材料不存在" })));
    app.get("/api/admin/studio/intelligence/:id/analysis", adminHandler(async (req, reply) =>
      await liveMaterialAnalysis((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "材料不存在" })));
    app.post("/api/admin/studio/intelligence/:id/classification", adminHandler(async (req, _reply, admin) =>
      retryCurrentMaterialClassification((req.params as { id: string }).id, req.body ?? {}, actorOf(admin))));
    app.post("/api/admin/studio/intelligence/:id/analysis", adminHandler(async (req, reply, admin) => {
      z.object({}).strict().parse(req.body ?? {});
      return await retryLiveMaterialAnalysis((req.params as { id: string }).id, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "材料不存在" });
    }));
    app.get("/api/admin/studio/intelligence/:id/images", adminHandler(async (req, reply) =>
      await sourceImages((req.params as { id: string }).id) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻不存在" })));
    app.post("/api/admin/studio/intelligence/:id/images", adminHandler(async (req, reply, admin) =>
      await submitSourceImages((req.params as { id: string }).id, req.body, actorOf(admin)) ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻不存在" })));
    app.get("/api/admin/studio/intelligence/:id", adminHandler(async (req, reply) =>
      await intelligenceDetail((req.params as { id: string }).id)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "这条情报尚未收录或已不存在" })));
    app.post("/api/admin/studio/creators", adminHandler(async (req, _reply, admin) => followCreator(req.body, actorOf(admin))));
    app.post("/api/admin/studio/creators/:id/collect", adminHandler(async (req, reply, admin) => {
      z.object({}).strict().parse(req.body);
      return await enqueueCreator((req.params as { id: string }).id, actorOf(admin))
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主关注不存在" });
    }));
    app.get("/api/admin/studio/creators/:id/contents", adminHandler(async (req, reply) =>
      await creatorContents((req.params as { id: string }).id, req.query)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主关注不存在" })));
    app.get("/api/admin/studio/creators/:id/expressions", adminHandler(async (req, reply) =>
      await creatorExpressions((req.params as { id: string }).id)
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主不存在" })));
    app.post("/api/admin/studio/creators/:id/expressions", adminHandler(async (req, reply, admin) =>
      await submitCreatorExpressions((req.params as { id: string }).id, req.body, actorOf(admin))
        ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主不存在" })));
    for (const operation of ["status", "archive"] as const) app.patch(`/api/admin/studio/creators/:id/${operation}`, adminHandler(async (req, reply, admin) => {
      const input = operation === "status" ? z.object({ version: z.number(), enabled: z.boolean() }).strict().parse(req.body)
        : z.object({ version: z.number(), archived: z.boolean() }).strict().parse(req.body);
      const result = await updateCreator((req.params as { id: string }).id, input, actorOf(admin));
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "博主关注不存在" });
    }));
    app.get("/api/admin/studio/news-sources/:id/bridge", adminHandler(async (req, reply) => {
      const result = await newsBridgeSettings((req.params as { id: string }).id);
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "外部桥接来源不存在" });
    }));
    app.put("/api/admin/studio/news-sources/:id/bridge", adminHandler(async (req, reply, admin) => {
      const result = await saveNewsBridge((req.params as { id: string }).id, req.body, actorOf(admin));
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "外部桥接来源不存在" });
    }));
    app.post("/api/admin/studio/news-sources", adminHandler(async (req, _reply, admin) => createNewsSource(req.body, actorOf(admin))));
    app.post("/api/admin/studio/news-sources/:id/refresh-profile", adminHandler(async (req, reply, admin) => {
      const result = await refreshNewsMetadata((req.params as { id: string }).id, req.body, actorOf(admin));
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻源不存在" });
    }));
    app.get("/api/admin/studio/news-sources/:id/avatar", adminHandler(async (req, reply) => {
      const image = await newsSourceAvatar((req.params as { id: string }).id);
      if (!image) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "头像尚未取得，请补全资料后重试" });
      return reply.header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox").type(image.type).send(image.body);
    }));
    app.get("/api/admin/studio/news-sources/:id/configuration", adminHandler(async (req, reply) => {
      const result = await newsSourceSettings((req.params as { id: string }).id);
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "来源不存在或该类型暂不支持此编辑器" });
    }));
    app.put("/api/admin/studio/news-sources/:id/configuration", adminHandler(async (req, reply, admin) => {
      const result = await updateNewsSource((req.params as { id: string }).id, req.body, actorOf(admin));
      return result ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "来源不存在或该类型暂不支持此编辑器" });
    }));
    app.post("/api/admin/studio/news-sources/import", adminHandler(async (req, _reply, admin) => importNewsSources(req.body, actorOf(admin))));
    app.put("/api/admin/studio/news-sources/:id/profile", adminHandler(async (req, reply, admin) => {
      const saved = await saveNewsProfile((req.params as { id: string }).id, req.body, actorOf(admin));
      return saved ?? sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻源不存在" });
    }));
    app.patch("/api/admin/studio/news-sources/:id/status", adminHandler(async (req, reply, admin) => {
      const input = z.object({ version: z.iso.datetime(), enabled: z.boolean() }).strict().parse(req.body);
      const saved = await updateSource((req.params as { id: string }).id,
        { version: input.version, patch: { enabled: input.enabled } }, actorOf(admin));
      return saved ? { ok: true } : sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻源不存在" });
    }));
    app.patch("/api/admin/studio/news-sources/:id/archive", adminHandler(async (req, reply, admin) => {
      const input = z.object({ version: z.iso.datetime(), archived: z.boolean() }).strict().parse(req.body);
      const saved = await updateSource((req.params as { id: string }).id,
        { version: input.version, patch: { archived: input.archived, enabled: false } }, actorOf(admin));
      return saved ? { ok: true } : sendProblem(req, reply, { status: 404, code: "not_found", detail: "新闻源不存在" });
    }));
  },
});

export const studio = createStudioServer();
