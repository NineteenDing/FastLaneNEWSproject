// One shared, accessible FL lockup; the supplied studio logo remains unchanged.
import { SITE } from "../site.ts";
import mark from "./fl-mark.png?url&no-inline";

export function Wordmark({ size = 24, className = "", title = SITE.name }: { size?: number; className?: string; title?: string }) {
  return (
    <span className={`fl-wordmark ${className}`} style={{ fontSize: size }} aria-label={title} role="img">
      <img src={mark} alt="" width="256" height="256" aria-hidden="true" />
      <span aria-hidden="true">FastLane<span className="fl-wordmark-news">NEWS</span></span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
