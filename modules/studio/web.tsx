import { defineWebModule } from "@aihot/web/modules";
import { PublicVisitorTracker } from "./web/public-visitors";
import { IconGrid } from "../../apps/web/app/components/icons.tsx";

const entry = { to: "/admin/studio/topics", label: "工作台登录" };

export const studioWeb = defineWebModule({
  name: "studio",
  root: { Bottom: PublicVisitorTracker },
  sidebarFooter: [entry],
  sidebar: { section: "影视榜", items: [
    { to: "/film/domestic", label: "国内AI影视榜", icon: IconGrid },
    { to: "/film/overseas", label: "国外AI影视榜", icon: IconGrid },
  ] },
  tools: [{ to: "/film/domestic", label: "国内AI影视榜", icon: <IconGrid size={20} /> },
    { to: "/film/overseas", label: "国外AI影视榜", icon: <IconGrid size={20} /> }, { ...entry, icon: <IconGrid size={20} /> }],
});
