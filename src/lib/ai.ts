import { env } from "../env.ts";

/**
 * Server-side gateway to the AI backend (ai.njakasoa.xyz). Games call this to get
 * generative content; the Bearer token never leaves the server. The upstream
 * `/api/v1/chat` is SSE — we accumulate the assistant text, extract the first JSON
 * object and parse it. Any failure (no token, timeout, bad output) returns `null`
 * so callers degrade to their own defaults — the game must never block on the AI.
 */
export async function aiGenerateJSON(opts: {
  system: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<unknown | null> {
  if (!env.AI_API_TOKEN) return null; // feature disabled
  const timeoutMs = opts.timeoutMs ?? env.AI_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${env.AI_BASE_URL}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.AI_API_TOKEN}` },
      body: JSON.stringify({ prompt: opts.prompt, systemPrompt: opts.system, maxTurns: 1, timeoutMs }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let streamed = ""; // accumulated delta text
    let finalText = ""; // a complete `message` or `result` payload
    let curEvent = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) curEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (curEvent === "delta" && typeof j.text === "string") streamed += j.text;
            else if (curEvent === "message" && typeof j.text === "string") finalText = j.text;
            else if (curEvent === "result" && typeof j.result === "string") finalText = j.result;
            else if (curEvent === "error") return null;
          } catch { /* keep-alive / partial line */ }
        }
      }
    }
    const text = finalText || streamed;
    const jsonStr = extractJsonObject(text);
    if (!jsonStr) return null;
    return JSON.parse(jsonStr);
  } catch {
    return null; // network error / abort / parse failure
  } finally {
    clearTimeout(timer);
  }
}

/** First balanced JSON object in a string (fenced block, prose-wrapped, or bare). */
export function extractJsonObject(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fence?.[1]?.trim().startsWith("{") ? fence[1]!.trim() : trimmed;
  const start = src.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
