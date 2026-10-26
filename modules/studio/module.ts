import { defineModule } from "@aihot/contracts/modules";

export const studio = defineModule({
  name: "studio",
  pages: [{ path: "film/:region", file: "web/film-boards.tsx", id: "film-boards" }, { layout: "web/layout.tsx", id: "studio-layout", pages: [
    { path: "admin/studio/following", file: "web/following.tsx", id: "studio-following" },
    { path: "admin/studio/creators", file: "web/creators.tsx", id: "studio-creators" },
    { path: "admin/studio/trends", file: "web/trend-boards.tsx", id: "studio-trends" },
    { path: "admin/studio/creators/:id", file: "web/creator-profile.tsx", id: "studio-creator-profile" },
    { path: "admin/studio/settings/:section?", file: "web/settings.tsx", id: "studio-settings" },
    { path: "admin/studio/writing", file: "web/writing.tsx", id: "studio-writing" },
    { path: "admin/studio/writing/:id", file: "web/writing.tsx", id: "studio-writing-project" },
    { path: "admin/studio/topics", file: "web/topic-batches.tsx", id: "studio-topic-batches" },
    { path: "admin/studio/topics/batches/:id", file: "web/topic-batches.tsx", id: "studio-topic-batch" },
    { path: "admin/studio/topics/columns", file: "web/topic-columns.tsx", id: "studio-topic-columns" },
    { path: "admin/studio/topics/columns/:id/versions/:version", file: "web/topic-columns.tsx", id: "studio-topic-column-history" },
    { path: "admin/studio/intelligence", file: "web/intelligence.tsx", id: "studio-intelligence" },
    { path: "admin/studio/intelligence/:id", file: "web/intelligence.tsx", id: "studio-intelligence-detail" },
    { path: "admin/studio/news-sources/new", file: "web/news-source-editor.tsx", id: "studio-news-source-new" },
    { path: "admin/studio/news-sources/:id/edit", file: "web/news-source-editor.tsx", id: "studio-news-source-edit" },
    { path: "admin/studio/news-sources/:id/bridge", file: "web/news-bridge-editor.tsx", id: "studio-news-bridge-edit" },
  ] }],
});
