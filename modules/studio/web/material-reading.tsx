import { useEffect, useState, type ReactNode } from "react";
import { Link, useRevalidator, useSearchParams } from "react-router";
import { CommentSamples } from "./comment-samples";
import { sourceInitial } from "../../../apps/web/app/lib/format";
import { num } from "../../../apps/web/app/features/admin/format";
import type { CreatorWork, IntelligenceDetail, IntelligenceRow, MediaProcessingStatus, MediaRhythm } from "../contracts";
import { CreatorWorkPanel } from "./creator-works";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { creatorMetrics } from "./creator-metrics";
import { isManagedImageUrl } from "../image-references";
import { MaterialAnalysisReadingPanel } from "./material-analysis-reading";
import { MaterialInsightsEvidence } from "./material-insights";
import { MetricHistory } from "./metric-history";
import { SourceImagesEvidence, SourceImagesPanel } from "./source-images";
import { externalUrl } from "./external-url";
import { SearchText } from "./intelligence-search";
import { searchSnippet } from "../intelligence-search";
export { externalUrl } from "./external-url";

const platforms = { news: "新闻源", bilibili: "B站", weibo: "微博", xhs: "小红书", zhihu: "知乎", tieba: "百度贴吧", douyin: "抖音", kuaishou: "快手" };
const kinds = { news: "新闻", video: "视频简介", post: "帖子", image_text: "图文笔记", answer: "回答", article: "文章" };
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "short" });
const date = (value: string | null) => value ? clock.format(new Date(value)) : "发布时间未提供";
function metrics(row: Pick<IntelligenceRow, "metrics" | "kind">) {
  if (!row.metrics) return "新闻未提供互动指标";
  return creatorMetrics(row.metrics, row.kind === "news" ? undefined : row.kind);
}
const mediaTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const measuredSeconds = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function RhythmEvidence({ rhythm }: { rhythm?: MediaRhythm }) {
  if (!rhythm) return <p className="studio-caption">该记录尚无本地节奏观察；不能从转写断句推算停顿或切镜。</p>;
  const { audio, visual } = rhythm;
  const seconds = (value: number) => `${measuredSeconds.format(value)} 秒`;
  return <div className="studio-rhythm" aria-label="本地节奏观察">
    <p>{audio ? `音轨观测 ${seconds(audio.observedSeconds)} · 低能量 ${num(audio.quietIntervalCount)} 处，共 ${seconds(audio.quietSeconds)}` : "未取得音轨观察，不能判断说话停顿。"}<br />
      {visual ? `画面采样 ${num(visual.sampleCount)} 次，至 ${seconds(visual.sampledUntilSeconds)} · 采样变化 ${num(visual.changeCount)} 次` : "未取得画面变化观察，不能判断切镜节奏。"}</p>
    <details aria-label="节奏方法与时间记录"><summary>查看节奏方法与时间记录</summary>
      <p className="studio-caption">这是本地信号观察，不能据此确认完播率、留存或博主动机；开头与结尾的可能作用仍需结合内容判断。</p>
      {audio && <><p className="studio-caption">音频从解码音轨起点计时；每 20 毫秒测量，低于 {audio.quietThresholdDbfs} dBFS 且持续至少 {seconds(audio.minimumQuietSeconds)} 记一处低能量。低能量不等于说话停顿，音乐可能掩盖停顿；音轨结束后的画面不计为已测静音。</p>
        <p>低能量区间：{audio.quietIntervals.length ? audio.quietIntervals.map(range => `${seconds(range.start)}–${seconds(range.end)}`).join("；") : "本次未观察到符合阈值的区间"}。{audio.truncated && `仅列出前 ${num(audio.quietIntervals.length)} 处，总计 ${num(audio.quietIntervalCount)} 处。`}</p></>}
      {visual && <><p className="studio-caption">画面从首帧起计时，每 {seconds(visual.sampleIntervalSeconds)} 最多采一次，RGB 平均差阈值 {visual.changeThreshold}。运动、字幕或闪光也可触发变化，短镜头可能漏掉；采样变化不等于精确切镜。</p>
        <p>变化时间：{visual.changeTimes.length ? visual.changeTimes.map(seconds).join("；") : "本次未观察到达到阈值的变化"}。{visual.truncated && `仅列出前 ${num(visual.changeTimes.length)} 次，总计 ${num(visual.changeCount)} 次。`}</p></>}
    </details>
  </div>;
}

export function SourceAvatar({ source }: { source: IntelligenceRow["source"] }) {
  const [failed, setFailed] = useState(false);
  const avatar = source.avatarUrl?.startsWith("/api/admin/studio/") && !failed
    ? <img className="studio-avatar" src={source.avatarUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <span className="studio-avatar" aria-hidden="true">{sourceInitial(source.name)}</span>;
  const homepage = externalUrl(source.homepage);
  return homepage ? <a href={homepage} target="_blank" rel="noopener noreferrer" aria-label={`打开${source.name}的主页`}>{avatar}</a> : avatar;
}

function MediaProcessing({ postId, initial }: { postId: string; initial: MediaProcessingStatus }) {
  const [status, setStatus] = useState(initial), [readFailed, setReadFailed] = useState(false);
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  useEffect(() => { setStatus(initial); }, [initial]);
  useEffect(() => {
    if (!["queued", "running"].includes(status.state)) return;
    let active = true, timer: ReturnType<typeof setTimeout>, pending: AbortController | undefined;
    async function check() {
      if (!document.hidden) {
        const controller = new AbortController(); pending = controller;
        const deadline = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(`/api/admin/studio/media-processing/${postId}`, { signal: controller.signal, cache: "no-store", credentials: "same-origin" });
          if (!response.ok) throw new Error("status unavailable");
          const next: MediaProcessingStatus = await response.json();
          if (active) { setStatus(next); setReadFailed(false); if (next.state === "ready") revalidator.revalidate(); }
        } catch { if (active) setReadFailed(true); }
        finally { clearTimeout(deadline); pending = undefined; }
      }
      if (active) timer = setTimeout(check, 5000);
    }
    timer = setTimeout(check, 5000);
    return () => { active = false; clearTimeout(timer); pending?.abort(); };
  }, [postId, status.state, revalidator]);
  const labels = { not_queued: "视频尚未排队处理", queued: "视频已排队，等待处理", running: "正在读取字幕、转写或保存画面", ready: "视频正文已保存", failed: "视频处理未完成" };
  return <section className="studio-notice" aria-label="视频处理状态">
    <p role="status">{labels[status.state]}</p>
    {status.error && <p>{status.error}</p>}
    {readFailed && <p className="studio-caption">状态暂时无法读取，将自动重试。</p>}
    {!status.enabled && status.state !== "ready" && <p className="studio-caption">本地媒体处理尚未启用，当前不会启动视频下载。</p>}
    {status.enabled && ["not_queued", "failed"].includes(status.state) && <button disabled={action.busy} onClick={() => action.run("POST", `/api/admin/studio/media-processing/${postId}`, { retryFailed: status.state === "failed" }, { success: "视频已提交处理" })}>
      {action.busy ? "正在提交…" : status.state === "failed" ? "重试视频处理" : "处理视频"}</button>}
  </section>;
}

export function MaterialDetail({ item, media, work, embedded = false }: { item: IntelligenceDetail; media: MediaProcessingStatus | null; work: CreatorWork | null; embedded?: boolean }) {
  const [search] = useSearchParams();
  const returnQuery = new URLSearchParams(search);
  return <>
    {!embedded && <div className="studio-page-header"><div><h1>情报详情</h1><p>{kinds[item.kind]} · {platforms[item.source.platform]}</p></div>
      <Link className="studio-button" to={`/admin/studio/intelligence?${returnQuery}`}>返回情报库</Link></div>}
    {media && <MediaProcessing key={item.id} postId={item.id.slice(8)} initial={media} />}
    {item.kind !== "news" && <CreatorWorkPanel key={`${item.id}:${work?.id}:${work?.version}`} material={item} initial={work} />}
    <MaterialEvidence item={item} analysis={<MaterialAnalysisReadingPanel key={`${item.id}:${item.analysis?.sourceKey}:${item.analysis?.state}:${item.analysis?.updatedAt}`} materialId={item.id} initial={item.analysis ?? null} />}
      searchQuery={(search.get("q") ?? "").trim().slice(0, 200)}
      images={item.kind === "news" ? <SourceImagesPanel key={`${item.id}:${item.sourceImages?.versionKey}`} materialId={item.id} initial={item.sourceImages} /> : undefined} />
  </>;
}

export function MaterialEvidence({ item, snapshot = false, analysis, images, searchQuery = "" }: { item: IntelligenceDetail; snapshot?: boolean; analysis?: ReactNode; images?: ReactNode; searchQuery?: string }) {
  const original = externalUrl(item.url), parent = externalUrl(item.parent?.url ?? null);
  const transcript = item.transcript, suffix = transcript ? `\n\n[本地转写]\n${transcript.text}` : "";
  const description = snapshot && suffix && item.body.endsWith(suffix) ? item.body.slice(0, -suffix.length) : item.body;
  const match = !snapshot && searchQuery ? ([["title", item.title], ["source", item.source.name], ["body", description], ["excerpt", item.excerpt], ["transcript", transcript?.text ?? ""]] as const)
    .find(([, text]) => searchSnippet(text, searchQuery) !== null)?.[0] : undefined;
  return <article className="studio-evidence">
      {!!searchQuery && !snapshot && <p className="studio-notice">搜索“{searchQuery}”：{match ? <a href="#intelligence-search-match">跳到首个匹配位置</a> : "当前保存的内容中未找到匹配，来源可能已更新。"}</p>}
      <header><h2><SearchText text={item.title} query={searchQuery} anchor={match === "title"} /></h2>{item.originalTitle && <p className="studio-caption" lang="en">{item.originalTitle}</p>}<div className="studio-material-source"><SourceAvatar key={item.source.avatarUrl} source={item.source} /><span><SearchText text={item.source.name} query={searchQuery} anchor={match === "source"} /></span></div>
        <p className="studio-caption">发布：{date(item.publishedAt)}<br />收录：{date(item.collectedAt)} · 香港时间</p>
        <p className="studio-caption">{metrics(item)}</p>
        <p className="studio-caption">最近更新：{date(item.observations.at(-1)?.observedAt ?? item.updatedAt)} · 热度只保存实际取得的观察</p>
        {item.source.work && <p className="studio-caption">{snapshot ? "当时关联作品" : "已关联作品"}：{item.source.work.title} · {item.source.work.publicationCount} 条发布；各平台指标分别保留。</p>}
        {original ? <a href={original} target="_blank" rel="noopener noreferrer">打开原文或原作品</a> : <p className="studio-caption">原文地址暂不可用</p>}
        {item.parent && parent && <p><a href={parent} target="_blank" rel="noopener noreferrer">{item.parent.kind === "question" ? "所属问题" : "所属专栏"}：{item.parent.title}</a></p>}
      </header>
      {analysis}
      {!!item.trends?.length && <section><details><summary>热榜发现时的记录（{item.trends.length} 条）</summary>
        <p className="studio-caption">以下为取得作品时保存的榜单观察，不随之后榜单刷新。排名与原始热度仅作发现线索，不代表事实核实、作品播放量或多个独立作者。</p>
        {item.trends.map((trend, index) => <div key={`${trend.id}:${index}`}><h3>{trend.platform === "baidu" ? "百度" : platforms[trend.platform]} · {trend.title}</h3>
          {trend.method === "search_representative" && <p className="studio-caption">从话题搜索取得的一条候选原文；是否相关需结合正文判断，不代表全部讨论。</p>}
          {externalUrl(trend.url) && <a href={externalUrl(trend.url)!} target="_blank" rel="noopener noreferrer">查看原榜单线索</a>}
          <ul>{trend.observations.map((observation, index) => <li key={index}>{date(observation.observedAt)} · 第 {observation.rank} 名{observation.rawHeat ? ` · 原始热度 ${observation.rawHeat}` : ""}</li>)}</ul>
        </div>)}
      </details></section>}
      <section><h3>{item.kind === "video" ? "作品简介" : "已取得的正文"}</h3>
        {match === "excerpt" && <p className="studio-caption">来源简介：<SearchText text={item.excerpt} query={searchQuery} anchor /></p>}
        {item.bodyState === "not_transcribed" && <p className="studio-caption">尚未取得字幕或转写，当前仅有视频简介。</p>}
        {["pending", "unconfirmed", "none"].includes(item.bodyState) && <p className="studio-caption">新闻全文尚未确认取得，以下为当前保存的内容。</p>}
        <p className="studio-evidence-body"><SearchText text={description || "来源尚未提供可阅读的正文或简介，可打开原文查看。"} query={searchQuery} anchor={match === "body"} /></p></section>
      {item.kind === "news" && (images ?? <section><SourceImagesEvidence value={item.sourceImages} snapshot={snapshot} /></section>)}
      {transcript && <section className="studio-transcript"><h3>{transcript.method === "platform_subtitle" ? "平台字幕与画面证据" : "本地转写与画面证据"}</h3>
        <p className="studio-caption">{transcript.mediaState === "cleaned" ? "原媒体已清理" : "正文已保存，原媒体清理待重试"} · 时长 {mediaTime(transcript.durationSeconds)} · {transcript.language}<br />{transcript.method === "platform_subtitle" ? "字幕来源" : "识别模型"}：{transcript.model}</p>
        <p className="studio-caption">{transcript.visualEvidence === "keyframes_saved" ? transcript.rhythm ? "已保存少量关键帧及下方实际节奏观察。" : "已保存少量关键帧，尚未完成画面与节奏分析。" : "未保存视频关键帧。"} 时间点用于定位证据，本页不提供原视频回放。</p>
        <RhythmEvidence rhythm={transcript.rhythm} />
        <details open={match === "transcript"}><summary>展开完整转写与关键帧（{num(transcript.segments.length)} 段）</summary>
          {match === "transcript" && <p>转写匹配片段：<SearchText text={searchSnippet(transcript.text, searchQuery)!} query={searchQuery} anchor /></p>}
          <ol className="studio-transcript-segments">{transcript.segments.map((segment, index) => <li key={index}><span className="studio-caption">{mediaTime(segment.start)}–{mediaTime(segment.end)}</span><p>{segment.text}</p></li>)}</ol>
          {!!transcript.frames?.length && <div className="studio-keyframes" aria-label="已保存的关键帧">{transcript.frames.filter(frame => isManagedImageUrl(frame.url)).map((frame, index) => <figure key={index}>
            <a href={frame.url} target="_blank" rel="noopener noreferrer" aria-label={`查看 ${mediaTime(frame.timeSeconds)} 的关键帧`}><img src={frame.url} alt={`${mediaTime(frame.timeSeconds)} 的视频画面`} loading="lazy" /></a><figcaption>{mediaTime(frame.timeSeconds)}</figcaption>
          </figure>)}</div>}
        </details></section>}
      {item.kind !== "news" && <section><h3>热度记录</h3>
        <MetricHistory observations={item.observations} kind={item.kind} snapshot={snapshot} />
        <h3>评论样本</h3><CommentSamples comments={item.comments} coverage={item.commentCoverage} />
      </section>}
      {!analysis && <MaterialInsightsEvidence insights={snapshot ? undefined : item.analysis?.result?.insights} />}
    </article>;
}

