import { useEffect, useRef, useState } from "react";

export function SourceAvatar({ name, src }: { name: string; src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (src && image.current?.complete && image.current.naturalWidth === 0) setFailed(src);
  }, [src]);
  return src && failed !== src ? <img ref={image} className="studio-avatar" src={src} alt="" width={42} height={42} loading="lazy" decoding="async" onError={() => setFailed(src)} />
    : <span className="studio-avatar" aria-hidden="true">{Array.from(name).slice(0, 2).join("")}</span>;
}
