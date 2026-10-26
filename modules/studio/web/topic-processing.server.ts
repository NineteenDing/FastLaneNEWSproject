import { adminGet } from "../../../apps/web/app/lib/admin.server";
import type { CurrentTopicPreview, TopicBatch, TopicBatchPage, TopicMaterialPage, TopicMaterialAnalysisPage, TopicRecommendations, TopicReview } from "../contracts";
export async function loadFrozenProcessing(request: Request, id: string, query: URLSearchParams) {
  const prefix = `/api/admin/studio/topic-batches/${encodeURIComponent(id)}`;
  const [detail, materials, analysis, recommendations, review] = await Promise.all([
    adminGet<{ batch: TopicBatch }>(request, prefix), adminGet<TopicMaterialPage>(request, `${prefix}/materials?${query}`),
    adminGet<TopicMaterialAnalysisPage>(request, `${prefix}/analysis?${query}`),
    adminGet<TopicRecommendations>(request, `${prefix}/recommendations`), adminGet<TopicReview>(request, `${prefix}/review`),
  ]);
  return { ...detail, materials, analysis, recommendations, review };
}

export async function loadTopicProcessing(request: Request) {
  const search = new URL(request.url).searchParams, id = search.get("batch");
  const list = await adminGet<TopicBatchPage>(request, "/api/admin/studio/topic-batches?limit=30");
  const query = new URLSearchParams({ limit: "30", page: search.get("materialPage") ?? "1" });
  if (id) return { view: "frozen" as const, list, ...await loadFrozenProcessing(request, id, query) };
  const [preview, materials] = await Promise.all([
    adminGet<CurrentTopicPreview>(request, "/api/admin/studio/topic-batches/current/preview"),
    adminGet<TopicMaterialPage>(request, "/api/admin/studio/topic-batches/current/materials?" + query),
  ]);
  return { view: "current" as const, list, preview, materials };
}

