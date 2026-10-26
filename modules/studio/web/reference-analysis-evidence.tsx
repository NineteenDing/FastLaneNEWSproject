import type { WritingProject } from "../contracts";
import { externalUrl } from "./external-url";

export function ReferenceAnalysisEvidence({ project }: { project: WritingProject }) {
  const analysis = project.snapshot.referenceAnalysis;
  if (!analysis) return null;
  return <details aria-label="本稿参考视频分析"><summary>本稿参考视频分析（{analysis.result.videos.length} 条）</summary>
    <p className="studio-caption">建稿前完成并冻结 · {analysis.model}。少量抽样帧与转写只作表达参考；可能作用尚未证实，未听原音频。</p>
    {analysis.result.videos.map(video => {
      const material = project.snapshot.materials.find(item => item.id === video.materialId), source = analysis.videos.find(item => item.materialId === video.materialId);
      const url = externalUrl(material?.url ?? null);
      return <section key={video.materialId}><h3>{material?.title ?? "参考视频"}</h3>
        {url && <a href={url} target="_blank" rel="noreferrer">查看原作品</a>}
        {video.observations.map((observation, index) => { const frame = source?.frames.find(item => item.assetId === observation.assetId && item.timeSeconds === observation.timeSeconds);
          return <div key={index} className="studio-reference-observation">{frame && <img src={frame.url} alt={`参考视频 ${frame.timeSeconds} 秒抽样帧`} loading="lazy" />}
            <p>{observation.timeSeconds} 秒：{observation.observation}<br /><span className="studio-caption">可能作用：{observation.possibleEffect}</span></p></div>;
        })}
        <p>文字语气：“{video.textualTone.quote}” · {video.textualTone.observation}</p>
        <p className="studio-caption">可能作用：{video.textualTone.possibleEffect}</p>
        <p className="studio-caption">观察局限：{video.limitations.join("；")}</p>
      </section>;
    })}
  </details>;
}
