import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import type { PlatformSession } from "../contracts";
import { Dialog } from "./dialog";

type Login = { id: string; state: "waiting" | "saved" | "failed" | "conflict" | "expired" | "cancelled"; collection: "paused" | "scheduled" | "pending"; expiresAt: string };
export function PlatformLogin({ session, name }: { session: PlatformSession; name: string }) {
  const action = useAdminAction("studio-layout"), revalidator = useRevalidator();
  const [login, setLogin] = useState<Login | null>(null), [text, setText] = useState(""), [error, setError] = useState(""), [frame, setFrame] = useState(0);
  const pointer = useRef<{ x: number; y: number } | null>(null), id = login?.id;
  const latest = useRef(login); latest.current = login;
  async function close() {
    const current = latest.current;
    if (current?.state === "waiting" && !await action.run("DELETE", `/api/admin/studio/platform-logins/${current.id}`, undefined, { revalidate: false })) return;
    setLogin(null); setText(""); revalidator.revalidate();
  }
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/admin/studio/platform-logins/${id}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
        if (!response.ok) throw new Error();
        const value = await response.json() as Login;
        if (controller.signal.aborted) return;
        setLogin(value); setError(""); setFrame(value => value + 1);
        if (value.state !== "waiting") { setText(""); revalidator.revalidate(); return; }
      } catch { if (controller.signal.aborted) return; setError("连接暂时中断，正在重试；也可关闭后重新登录。"); }
      timer = setTimeout(() => { void poll(); }, 1300);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, revalidator]);
  const operate = (body: unknown) => id ? action.run("POST", `/api/admin/studio/platform-logins/${id}/actions`, body, { revalidate: false }).then(() => setFrame(value => value + 1)) : Promise.resolve();
  return <><button type="button" className="studio-primary" disabled={action.busy} onClick={async () => {
    setError(""); const result = await action.run<Login>("POST", "/api/admin/studio/platform-logins", { platform: session.platform, version: session.version }, { revalidate: false });
    if (result) setLogin(result);
  }}>{action.busy && !login ? "正在打开…" : "登录平台"}</button>
    {login && <Dialog title={`${name}登录`} onClose={() => { void close(); }} wide>
      {login.state === "waiting" ? <>
        <p>直接点击下方平台页面操作，或用手机扫描页面中的二维码。登录窗口最多保留 4 分钟，成功后自动保存。</p>
        <div className="studio-login-screen" tabIndex={0} role="group" aria-label={`${name}登录画面`} onKeyDown={event => {
          if (["Enter", "Tab", "Backspace", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) && event.key !== "Escape") { event.preventDefault(); void operate({ type: "key", key: event.key }); }
        }}>
          <img src={`/api/admin/studio/platform-logins/${login.id}/frame?frame=${frame}`} alt={`${name}服务器登录页面，可点击或拖动验证滑块`} draggable={false}
            onPointerDown={event => { if (action.busy) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const r = event.currentTarget.getBoundingClientRect(); pointer.current = { x: Math.min(899, Math.max(0, Math.round((event.clientX - r.left) * 900 / r.width))), y: Math.min(649, Math.max(0, Math.round((event.clientY - r.top) * 650 / r.height))) }; }}
            onPointerUp={event => { if (!pointer.current) return; const r = event.currentTarget.getBoundingClientRect(), start = pointer.current; pointer.current = null;
              const end = { toX: Math.min(899, Math.max(0, Math.round((event.clientX - r.left) * 900 / r.width))), toY: Math.min(649, Math.max(0, Math.round((event.clientY - r.top) * 650 / r.height))) };
              void operate(Math.hypot(start.x - end.toX, start.y - end.toY) > 5 ? { type: "drag", ...start, ...end } : { type: "click", ...start }); }}
            onPointerCancel={() => { pointer.current = null; }} onError={() => setError("画面暂时未就绪，正在刷新；持续失败时请重新打开。现在尚未保存登录信息。")}/>
        </div>
        <form className="studio-login-input" onSubmit={event => { event.preventDefault(); if (!text) return; void operate({ type: "text", text }).then(() => setText("")); }}>
          <label>向平台输入文字<input type="password" autoComplete="off" maxLength={300} value={text} onChange={event => setText(event.target.value)} placeholder="先点击平台输入框，再填入手机号、验证码或密码" /></label>
          <button disabled={!text || action.busy}>输入到平台</button>
        </form>
        <div className="studio-actions"><button disabled={action.busy} onClick={() => void operate({ type: "key", key: "Enter" })}>回车确认</button><button disabled={action.busy} onClick={() => void operate({ type: "key", key: "Backspace" })}>删除一字</button><button disabled={action.busy} onClick={() => void operate({ type: "scroll", delta: 450 })}>页面下移</button><button disabled={action.busy} onClick={() => void operate({ type: "scroll", delta: -450 })}>页面上移</button></div>
        {error && <p role="status">{error}</p>}<p className="studio-caption">输入仅发送到本次平台窗口，不保存输入记录。关闭窗口会取消本次登录；已收录的内容不受影响。</p>
      </> : <p role="status">{login.state === "saved" ? `登录会话已加密保存。${login.collection === "scheduled" ? "已接续已关注博主的采集，实际状态请查看关注管理。" : login.collection === "pending" ? "采集暂未排入，后台会按原计划继续。" : "当前采集关闭，开启采集后将按原计划继续。"}`
        : login.state === "conflict" ? "登录信息已在其他窗口更新，本窗口没有覆盖它。请关闭后重新操作。"
        : login.state === "expired" ? "登录窗口已到期，未保存会话。请关闭后重新登录。" : "本次登录未完成，未覆盖已保存信息。请关闭后重试或手动保存 Cookie。"}</p>}
    </Dialog>}
  </>;
}
