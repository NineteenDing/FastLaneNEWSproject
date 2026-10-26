// Shared IPC contract. Both peers still validate unknown messages before using them.
export type RsshubChildMessage = {
  type: "fetch"; id: number; url: string; method: string; headers: Record<string, string>;
  body?: string; redirect: "follow" | "manual" | "error";
} | { type: "result"; status: number; headers: Record<string, string>; body: string } | { type: "error" };

export type RsshubParentMessage = { type: "response"; id: number } & (
  { error: string } | { status: number; url: string; redirected: boolean; headers: Record<string, string>; body: string }
);

function headers(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length <= 100
    && Object.entries(value).every(([key, entry]) => key.length <= 200 && typeof entry === "string" && entry.length <= 16_384);
}
const status = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 599;
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function readChildMessage(raw: unknown): RsshubChildMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  if (message.type === "error") return { type: "error" };
  if (message.type === "fetch" && id(message.id) && typeof message.url === "string" && message.url.length <= 16_384
    && typeof message.method === "string" && message.method.length <= 100 && headers(message.headers)
    && (message.body === undefined || typeof message.body === "string" && message.body.length <= 1_398_104)
    && ["follow", "manual", "error"].includes(String(message.redirect))) return message as RsshubChildMessage;
  if (message.type === "result" && status(message.status) && headers(message.headers)
    && typeof message.body === "string" && message.body.length <= 5_592_408) return message as RsshubChildMessage;
  return null;
}

export function readParentMessage(raw: unknown): RsshubParentMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  if (message.type !== "response" || !id(message.id)) return null;
  if (typeof message.error === "string") return { type: "response", id: message.id, error: message.error };
  if (status(message.status) && headers(message.headers) && typeof message.url === "string" && message.url.length <= 16_384
    && typeof message.redirected === "boolean" && typeof message.body === "string" && message.body.length <= 11_184_812) return message as RsshubParentMessage;
  return null;
}
