import { Form } from "react-router";

export interface VisitorStats {
  from: string; to: string;
  overview: { visitors: number; visits: number; pageViews: number; activeMs: number; averageVisitMs: number };
  daily: Array<{ day: string; visitors: number; pageViews: number; activeMs: number }>;
  pages: Array<{ path: string; visitors: number; pageViews: number; activeMs: number; averageMs: number }>;
}
const duration = (ms: number) => ms < 60000 ? `${Math.round(ms / 1000)}秒` : `${(ms / 60000).toFixed(1)}分钟`;
const names: Record<string, string> = { "/": "精选", "/all": "全部AI影视动态", "/hot": "AI影视热点榜", "/daily": "AI影视日报", "/film/domestic": "国内AI影视榜", "/film/overseas": "国外AI影视榜", "/starred": "收藏", "/about": "关于", "/changelog": "更新日志", "/feedback": "反馈" };
export function VisitorDashboard({ data }: { data: VisitorStats }) {
  return <section className="studio-visitors studio-fixed-panel"><h2>访问统计</h2>
    <Form className="studio-filters"><label>开始日期<input type="date" name="from" defaultValue={data.from} required /></label><label>结束日期<input type="date" name="to" defaultValue={data.to} required /></label><button>查看统计</button></Form>
    <p className="studio-caption">按匿名浏览器统计，跨设备算不同访客；访问次数是打开页面次数。停留只计算可见、获得焦点且最近一分钟有操作的时间。拒绝统计、浏览器阻止或网络失败会有缺失，不代表准确自然人数。</p>
    <dl className="studio-visitor-overview"><div><dt>访客</dt><dd>{data.overview.visitors}</dd></div><div><dt>访问次数</dt><dd>{data.overview.pageViews}</dd></div><div><dt>访问会话</dt><dd>{data.overview.visits}</dd></div><div><dt>平均每次会话停留</dt><dd>{duration(data.overview.averageVisitMs)}</dd></div></dl>
    <div className="studio-scroll-region"><h3>每日访问</h3>{data.daily.length ? <table><thead><tr><th>日期</th><th>访客</th><th>页面访问</th><th>活跃停留合计</th></tr></thead><tbody>{data.daily.map(row => <tr key={row.day}><th>{row.day}</th><td>{row.visitors}</td><td>{row.pageViews}</td><td>{duration(row.activeMs)}</td></tr>)}</tbody></table> : <p>该日期范围尚无访问记录，从启用本版后开始统计。</p>}
      <h3>页面停留排行</h3><p className="studio-caption">按活跃停留合计显示前50个页面；跨日访问归入打开页面时的香港日期。</p>
      <table><thead><tr><th>页面</th><th>访问</th><th>访客</th><th>平均停留</th><th>总停留</th></tr></thead><tbody>{data.pages.map(row => <tr key={row.path}><td><a href={row.path} target="_blank" rel="noreferrer">{names[row.path] ?? row.path}</a></td><td>{row.pageViews}</td><td>{row.visitors}</td><td>{duration(row.averageMs)}</td><td>{duration(row.activeMs)}</td></tr>)}</tbody></table>
    </div>
  </section>;
}
