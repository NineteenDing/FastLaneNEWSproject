import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { TopicBatch, TopicDirection, TopicRecommendations } from "../contracts";
import { SourceAvatar } from "./intelligence";
import { ReferencePicker } from "./reference-picker";

type Reference = { materialId: string; role: "fact" | "expression" | "counterpoint" };
const roles = { fact: "事实依据", expression: "表达参考", counterpoint: "反例与限制" } as const;

export function AdoptTopic({ batch, directions, references, initial, onClose }: { batch: TopicBatch; directions: TopicDirection[];
  references: TopicRecommendations["referenceMaterials"]; initial: TopicDirection; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), navigate = useNavigate(), action = useAdminAction("studio-layout");
  const [ids, setIds] = useState([initial.id]), [title, setTitle] = useState(initial.titles[initial.preferredTitle]!);
  const [selected, setSelected] = useState<Reference[]>(initial.references.map(ref => ({ materialId: ref.materialId, role: ref.role })));
  const [available, setAvailable] = useState(references);
  const [referencePending, setReferencePending] = useState(false);
  const [deepAnalysis, setDeepAnalysis] = useState(false), [visionIds, setVisionIds] = useState<string[] | null>(null);
  const [preparing, setPreparing] = useState(false), [visionError, setVisionError] = useState("");
  const preparation = useRef<AbortController | null>(null), submitting = useRef(false), retryVision = useRef(false);
  const videos = available.filter(material => material.kind === "video" && selected.some(ref => ref.materialId === material.id && ref.role === "expression"));
  const analyzedIds = visionIds === null ? videos.slice(0, 2).map(video => video.id) : visionIds.filter(id => videos.some(video => video.id === id));
  const [instructions, setInstructions] = useState(""), requestId = useRef<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); requestId.current = crypto.randomUUID(); return () => { preparation.current?.abort(); requestId.current = null; }; }, []);
  function close() { preparation.current?.abort(); onClose(); }
  function toggleDirection(direction: TopicDirection, checked: boolean) {
    setIds(current => checked ? [...current, direction.id] : current.filter(id => id !== direction.id));
    if (checked) setSelected(current => [...current, ...direction.references.filter(ref => !current.some(item => item.materialId === ref.materialId && item.role === ref.role))
      .map(ref => ({ materialId: ref.materialId, role: ref.role }))]);
  }
  function toggleReference(materialId: string, role: Reference["role"], checked: boolean) {
    setSelected(current => checked ? [...current, { materialId, role }] : current.filter(item => item.materialId !== materialId || item.role !== role));
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!requestId.current || referencePending || submitting.current) return;
    const generate = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === "generate";
    const controller = new AbortController(); preparation.current = controller; submitting.current = true; setVisionError("");
    try {
      let referenceAnalysisId: string | undefined;
      if (deepAnalysis) {
        if (!analyzedIds.length || analyzedIds.length > 2) throw new Error("请选择一至两条需要分析的表达参考视频。");
        setPreparing(true);
        const pending = await action.run<{id: string; state: string}>("POST", "/api/admin/studio/reference-analyses",
          {enabled: true, batchId: batch.id, materialIds: analyzedIds, retryFailed: retryVision.current}, {revalidate: false});
        if (!pending || controller.signal.aborted) return;
        const deadline = Date.now() + 15 * 60_000;
        while (!controller.signal.aborted) {
          const response = await fetch(`/api/admin/studio/reference-analyses/${pending.id}`, {credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])});
          if (!response.ok) throw new Error("暂时无法读取分析进度，可以关闭后重新提交，已有结果会复用。");
          const ready = await response.json() as {state: string; error: string | null};
          if (ready.state === "completed") { referenceAnalysisId = pending.id; break; }
          if (ready.state === "failed") { retryVision.current = true; throw new Error(ready.error || "参考分析未完成，请检查配置后重试，或关闭分析继续文本写稿。"); }
          if (Date.now() >= deadline) throw new Error("分析仍在后台排队，可关闭后再提交查看；不会重复分析已完成的相同参考。");
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      if (controller.signal.aborted || !requestId.current) return;
      const result = await action.run<{ id: string }>("POST", "/api/admin/studio/drafts", { requestId: requestId.current, batchId: batch.id, directionIds: ids, title, references: selected, instructions,
        ...(referenceAnalysisId ? {referenceAnalysisId} : {}) });
      if (result && !controller.signal.aborted) {
        if (generate) await action.run("POST", `/api/admin/studio/drafts/${result.id}/generation`, { version: 1 });
        if (!controller.signal.aborted) navigate(`/admin/studio/writing/${result.id}`);
      }
    } catch (error) { if (!controller.signal.aborted) setVisionError(error instanceof Error ? error.message : "参考分析未完成，请稍后重试。"); }
    finally { submitting.current = false; if (!controller.signal.aborted) setPreparing(false); }
  }
  return <dialog ref={dialog} className="studio-adopt-dialog" aria-labelledby="adopt-title" onCancel={close}>
    <form onSubmit={submit}><header><h2 id="adopt-title">采纳选题，建立独立稿件</h2><button type="button" onClick={close}>关闭</button></header>
      <fieldset className="studio-adopt-fields" disabled={preparing}>
      <p className="studio-caption">确认标题、事实来源与表达样本后进入写稿台。每次新建都是一篇独立稿件。</p>
      <label>稿件标题<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={240} required list="adopt-titles" /></label>
      <datalist id="adopt-titles">{directions.filter(direction => ids.includes(direction.id)).flatMap(direction => direction.titles).map((item, i) => <option key={i} value={item} />)}</datalist>
      <details><summary>组合相关方向（已选 {ids.length} 个）</summary><div className="studio-adopt-directions">{directions.map(direction => <label key={direction.id}>
        <input type="checkbox" checked={ids.includes(direction.id)} onChange={event => toggleDirection(direction, event.target.checked)} />{direction.titles[direction.preferredTitle]}</label>)}</div></details>
      <ReferencePicker onPendingChange={setReferencePending} onAdd={(material, role) => { setAvailable(current => current.some(item => item.id === material.id) ? current : [...current, material]);
        setSelected(current => current.some(item => item.materialId === material.id && item.role === role) ? current : [...current, { materialId: material.id, role }]); }} />
      <fieldset><legend>事实来源与表达参考</legend><p className="studio-caption">事实回答“依据是什么”；表达样本只学习结构和语气。至少保留一份完整事实原稿才能生成；新补充视频需先完成转写。</p>
        <ul className="studio-adopt-references">{available.map(material => <li key={material.id}>
          <div className="studio-material-source"><SourceAvatar source={material.source} /><div><strong>{material.source.name}</strong><p>{material.title}</p></div></div>
          <div className="studio-reference-options">{Object.entries(roles).map(([role, name]) => <label key={role}><input type="checkbox"
            checked={selected.some(item => item.materialId === material.id && item.role === role)} onChange={event => toggleReference(material.id, role as Reference["role"], event.target.checked)} />{name}</label>)}</div>
        </li>)}</ul>
      </fieldset>
      <section aria-label="参考视频深度分析" className="studio-reference-analysis-option">
        <div className="studio-actions"><span id="reference-analysis-label">参考视频深度分析</span><button type="button" className="studio-slide-switch" role="switch" aria-labelledby="reference-analysis-label" aria-checked={deepAnalysis} onClick={() => setDeepAnalysis(value => !value)}><span aria-hidden="true" /></button></div>
        <p className="studio-caption">{deepAnalysis ? "建稿前分析所选视频，每条最多3帧，最多2条；估算超过2元不发请求，同时遵守总预算。" : "默认关闭，沿用文本与已保存的节奏记录，不发送图像请求。"}</p>
        {deepAnalysis && <><p className="studio-caption">需要配置支持图片的模型及单价。只读取已存转写和关键帧，不重新下载视频；语气分析仅依据文字，不代表听过原音频。</p>
          {videos.length ? videos.map(video => <label key={video.id} className="studio-reference-video-choice"><input type="checkbox" checked={analyzedIds.includes(video.id)} disabled={!analyzedIds.includes(video.id) && analyzedIds.length >= 2}
            onChange={event => { setVisionIds(event.target.checked ? [...analyzedIds, video.id] : analyzedIds.filter(id => id !== video.id)); retryVision.current = false; }} />{video.title}</label>)
            : <p className="studio-caption">请先把已收录视频勾为“表达参考”。缺少转写或关键帧时会提示，关闭分析仍可按原条件建稿。</p>}</>}
      </section>
      <label>自定义要求<textarea rows={3} maxLength={5000} value={instructions} onChange={event => setInstructions(event.target.value)} placeholder="例如：面向新手，先讲适用条件，再给演示步骤；不要写成亲测。" /></label>
      </fieldset>
      {referencePending && <p className="studio-caption" role="status">参考材料正在读取，完成后再建立稿件。</p>}
      {preparing && <p className="studio-caption" role="status">正在准备参考分析，完成后自动建稿。关闭弹窗不会删除后台任务。</p>}
      {visionError && <p role="alert">{visionError}</p>}
      <div className="studio-actions"><button className="studio-primary" name="operation" value="generate" disabled={preparing || referencePending || action.busy || !ids.length || ids.length > 6 || !title.trim()}>{preparing ? "正在分析参考…" : action.busy ? "正在创建…" : "建立并生成口播"}</button>
        <button name="operation" value="create" disabled={preparing || referencePending || action.busy || !ids.length || ids.length > 6 || !title.trim()}>建立稿件并进入写稿台</button></div>
    </form>
  </dialog>;
}
