import { useState, type FormEvent } from "react";
import { Link, useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { CreatorWork, IntelligenceDetail } from "../contracts";
import { ReferencePicker } from "./reference-picker";
import { creatorMetrics } from "./creator-metrics";
import { externalUrl } from "./external-url";

const platforms = { bilibili: "B站", weibo: "微博", xhs: "小红书", zhihu: "知乎", tieba: "百度贴吧", douyin: "抖音", kuaishou: "快手" };
function publicationOf(item: IntelligenceDetail): CreatorWork["publications"][number] {
  const kind = item.kind, platform = item.source.platform, metrics = item.metrics;
  if (kind === "news" || platform === "news" || !metrics) throw new Error("请选择博主的具体发布，新闻讨论相同事件不等于同一作品。");
  return { id: item.id, title: item.title, url: item.url, platform, kind, creatorName: item.source.name, publishedAt: item.publishedAt, metrics };
}

export function CreatorWorkPanel({ material, initial }: { material: IntelligenceDetail; initial: CreatorWork | null }) {
  const action = useAdminAction("studio-layout"), refresh = useRevalidator(), [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(initial?.title ?? material.title.slice(0, 200));
  const [selected, setSelected] = useState<CreatorWork["publications"]>(initial?.publications ?? [publicationOf(material)]);
  function add(item: IntelligenceDetail) {
    const publication = publicationOf(item);
    if (item.source.work && item.source.work.id !== initial?.id) throw new Error("这条发布已关联其他作品，请先在对应情报详情解除关联。");
    if (selected.some(row => row.id === item.id)) return;
    if (selected.length >= 100) throw new Error("一组最多关联100条发布，请先移除不需要的内容。");
    setSelected(current => [...current, publication]);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(initial ? "PUT" : "POST", `/api/admin/studio/creator-works${initial ? '/' + initial.id : ''}`,
      { title, materialIds: selected.map(row => row.id), ...(initial ? { version: initial.version } : {}) }, { success: "同作品关联已保存，历史批次保持原记录" });
    if (result) setEditing(false);
  }
  function reset() { setTitle(initial?.title ?? material.title.slice(0, 200)); setSelected(initial?.publications ?? [publicationOf(material)]); setEditing(false); }
  return <section className="studio-work-panel" aria-label="同作品跨平台关联">
    <h2>同作品的跨平台发布</h2>
    <p className="studio-caption">{initial ? `${initial.title} · 已关联 ${initial.publications.length} 条发布` : "尚未关联其他发布。相同作品可放在一起比较，各平台的原文、热度和评论仍分别保留。"}</p>
    {initial && <details><summary>展开各平台表现（{initial.publications.length} 条）</summary>
      <ul className="studio-discovery-list">{initial.publications.map(item => <li key={item.id}><div><strong>{platforms[item.platform]} · {item.creatorName}</strong><p>{item.title}</p>
        <p className="studio-caption">{creatorMetrics(item.metrics, item.kind)}</p></div><div className="studio-actions">
          <Link to={`/admin/studio/intelligence/${encodeURIComponent(item.id)}`}>查看情报</Link>
          {externalUrl(item.url) && <a href={externalUrl(item.url)!} target="_blank" rel="noopener noreferrer">打开原作品</a>}</div></li>)}</ul>
      <p className="studio-caption">关联不等于多位独立博主或多份事实验证，不合计跨平台播放量。</p>
    </details>}
    {!editing ? <div className="studio-actions"><button type="button" onClick={() => setEditing(true)}>{initial ? "管理同作品关联" : "关联同作品发布"}</button>
      <button type="button" disabled={refresh.state !== "idle"} onClick={() => refresh.revalidate()}>刷新关联</button></div> : <form onSubmit={save}>
      <label htmlFor="creator-work-title">作品名称</label><input id="creator-work-title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} disabled={action.busy} />
      <ul className="studio-discovery-list" aria-label="准备关联的发布">{selected.map(item => <li key={item.id}><div><strong>{item.title}</strong><p className="studio-caption">{platforms[item.platform]} · {item.creatorName}</p></div>
        <button type="button" disabled={action.busy || !initial && item.id === material.id} onClick={() => setSelected(current => current.filter(row => row.id !== item.id))} aria-label={`移除关联：${item.title}`}>移除</button></li>)}</ul>
      <fieldset className="studio-work-picker" disabled={action.busy}><ReferencePicker purpose="work" onAdd={add} /></fieldset>
      <p className="studio-caption">修改只在保存后生效。新建至少选择两条；移除仅解除关联，不删除情报或改变历史稿件。</p>
      <div className="studio-actions"><button className="studio-primary" disabled={action.busy || !title.trim() || !initial && selected.length < 2}>{action.busy ? "正在保存…" : "保存同作品关联"}</button>
        <button type="button" disabled={action.busy} onClick={reset}>取消</button>
        <button type="button" disabled={action.busy || refresh.state !== "idle"} onClick={() => { if (window.confirm("刷新会放弃这里尚未保存的关联修改，继续吗？")) { reset(); refresh.revalidate(); } }}>放弃修改并刷新</button></div>
    </form>}
  </section>;
}
