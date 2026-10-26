import { useEffect, useState, useCallback, type ReactNode } from "react";

export function RemotePanel<T>({ url, children }: { url: string; children(value: T, refresh: () => void): ReactNode }) {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(); setValue(null); setError("");
    void fetch(url, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(async response => { if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录后重试。" : "读取失败，请重试。"); return response.json() as Promise<T>; })
      .then(result => { if (!controller.signal.aborted) setValue(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取失败"); });
    return () => controller.abort();
  }, [url, retry]);
  if (error) return <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>;
  return value === null ? <p role="status">正在读取…</p> : children(value, refresh);
}
