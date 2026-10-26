import { useEffect } from "react";
import { useLocation } from "react-router";

/** First-party anonymous statistics; page text, queries, accounts and IPs are not sent. */
export function PublicVisitorTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname.startsWith("/admin") || pathname.startsWith("/api") || navigator.doNotTrack === "1") return;
    const now = () => Date.now(); let visitorId: string, sessionId: string;
    try {
      visitorId = localStorage.getItem("fl.visitor") ?? crypto.randomUUID(); localStorage.setItem("fl.visitor", visitorId);
      const stored = JSON.parse(localStorage.getItem("fl.visit.session") ?? "null") as { id: string; at: number } | null;
      sessionId = stored && now() - stored.at < 30 * 60000 ? stored.id : crypto.randomUUID();
    } catch { visitorId = crypto.randomUUID(); sessionId = crypto.randomUUID(); }
    const id = crypto.randomUUID(); let activeMs = 0, lastTick = now(), activity = now(), ticks = 0, disposed = false, wasActive = !document.hidden && document.hasFocus();
    const send = () => { void fetch("/api/site/visits", { method: "POST", credentials: "omit", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ id, visitorId, sessionId, path: pathname, activeMs }) }).catch(() => {}); };
    const interact = () => { activity = now(); };
    const tick = () => {
      const at = now();
      if (wasActive) activeMs += Math.min(5000, Math.max(0, Math.min(at, activity + 60000) - lastTick));
      wasActive = !document.hidden && document.hasFocus();
      lastTick = at;
      try { localStorage.setItem("fl.visit.session", JSON.stringify({ id: sessionId, at: activity })); } catch {}
    };
    const flush = () => { if (!disposed) { tick(); send(); } };
    send(); const timer = setInterval(() => { tick(); if (++ticks % 3 === 0) send(); }, 5000);
    for (const event of ["pointerdown", "keydown", "scroll", "focus"]) window.addEventListener(event, interact, { passive: true });
    window.addEventListener("pagehide", flush); window.addEventListener("blur", flush); window.addEventListener("focus", flush); document.addEventListener("visibilitychange", flush);
    return () => { flush(); disposed = true; clearInterval(timer); for (const event of ["pointerdown", "keydown", "scroll", "focus"]) window.removeEventListener(event, interact); window.removeEventListener("pagehide", flush); window.removeEventListener("blur", flush); window.removeEventListener("focus", flush); document.removeEventListener("visibilitychange", flush); };
  }, [pathname]);
  return null;
}
