import { Link } from "react-router";
import type { SiteAbout } from "@aihot/contracts/site";
import { ABOUT, SITE } from "@aihot/site";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { PhoneBar } from "../../components/shell/PhoneBar";

/** Public text and original QR bytes; never rewrite a platform-specific code. */
export function PublishedAbout({ profile }: { profile: SiteAbout }) {
  return <>
    <PhoneBar title="关于" back={{ to: "/more", label: "我的" }} />
    <div className="mx-auto max-w-[1120px] px-5 pb-20 pt-8 sm:px-8 sm:pt-12">
      <header className="border-b border-line pb-8 sm:pb-10">
        <Wordmark size={32} />
        <h1 data-page-title="" className="mt-7 text-[34px] font-bold leading-[1.25] [overflow-wrap:anywhere] sm:text-[48px]">{profile.title}</h1>
        <p className="mt-4 max-w-[65ch] text-[17px] leading-[1.8] text-ink-2 [overflow-wrap:anywhere]">{profile.subtitle}</p>
        <div className="mt-6 flex flex-wrap gap-3"><Link className="chip" to="/">看精选</Link><Link className="chip" to="/daily">读日报</Link></div>
      </header>
      <section aria-label="工作室介绍" className="space-y-4 py-8 text-[16px] leading-[1.9] text-ink-2">
        {profile.paragraphs.map((paragraph, i) => <p key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{paragraph}</p>)}
      </section>
      <section aria-labelledby="studio-contact" className="border-t border-line pt-8">
        <h2 id="studio-contact" className="text-[22px] font-semibold">关注工作室，或与我们联系</h2>
        <ul className="mt-6 grid gap-x-8 gap-y-8 sm:grid-cols-2 xl:grid-cols-4">
          {profile.codes.map(code => <li key={code.label} className="min-w-0">
            <a href={code.imageUrl} target="_blank" rel="noopener noreferrer" aria-label={`查看${code.label}二维码大图`} className="inline-flex max-w-full rounded-card bg-white p-3">
              <img src={code.imageUrl} alt={`${code.label}二维码`} width={220} height={220} className="aspect-square w-[196px] max-w-full object-contain" />
            </a>
            <h3 className="mt-3 font-semibold">{code.label}</h3><p className="mt-1 text-[13px] leading-[1.7] text-ink-3">{code.note}</p>
          </li>)}
        </ul>
      </section>
      <footer className="mt-10 border-t border-line pt-5 text-[13px] leading-[1.9] text-ink-3">
        <p>{ABOUT.copyright[0]}<Link to="/feedback" className="text-accent underline">反馈页</Link>{ABOUT.copyright[1]}</p>
        <p className="mt-2">{SITE.name} · 原始信息以来源发布为准。</p>
      </footer>
    </div>
  </>;
}
