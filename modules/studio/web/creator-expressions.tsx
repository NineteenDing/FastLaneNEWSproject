import { Link } from "react-router";
import type { CreatorExpressionLibrary } from "../contracts";
import { externalUrl } from "./external-url";

const dimensions = { title: "标题", opening: "开头", development: "信息展开", rhythm: "节奏", tone: "语气", ending: "结尾" };
export function CreatorExpressionEvidence({ library }: { library: CreatorExpressionLibrary }) {
  return <section aria-label={`${library.creatorName}的表达参考`}>
    <p className="studio-caption">{library.creatorName} · {library.sources.length} 份具体作品 · 保存于 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", dateStyle: "medium" }).format(new Date(library.createdAt))}。只借鉴表达，效果推断仍需验证。</p>
    <ul className="studio-batch-list">{library.patterns.map((pattern, index) => <li key={index}>
      <h3>{dimensions[pattern.dimension]}：{pattern.observation}</h3>
      <p>怎么借鉴：{pattern.application}</p>
      <section><h4>依据与限制（{new Set(pattern.evidence.map(ref => ref.materialId)).size} 份作品）</h4>
        <p>可能作用：{pattern.possibleEffect}</p><p>限制：{pattern.limitations}</p>
        {new Set(pattern.evidence.map(ref => ref.materialId)).size < 2 && <p className="studio-caption">仅单作品依据，暂不能认定为稳定习惯。</p>}
        <ul>{pattern.evidence.map((reference, item) => {
          const source = library.sources.find(row => row.materialId === reference.materialId), url = source && externalUrl(source.url);
          return <li key={item}><blockquote>{reference.quote}</blockquote>{source && <p><Link to={`/admin/studio/intelligence/${encodeURIComponent(reference.materialId)}`}>{source.title}</Link>
            {url && <> · <a href={url} target="_blank" rel="noopener noreferrer">原作品</a></>}</p>}</li>;
        })}</ul>
      </section>
    </li>)}</ul>
  </section>;
}
