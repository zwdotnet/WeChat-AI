export interface GeneratedImage {
  mime: string;
  data: Buffer;
}

export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function normalizeBase(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

/**
 * OpenAI-compatible images/generations call. Supports both `b64_json` and
 * `url` result styles (downloads the latter). gpt-image-2-1k via Sub2API
 * returns b64_json.
 */
export async function generateImageViaApi(
  cfg: ImageGenConfig,
  prompt: string,
  size?: string,
): Promise<GeneratedImage> {
  const base = normalizeBase(cfg.baseUrl);
  if (!base) throw new Error("image API base URL is empty");
  if (!cfg.apiKey) throw new Error("image API key is empty");
  if (!cfg.model) throw new Error("IMAGE_GEN_MODEL is empty");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let resp: Response;
  let text: string;
  try {
    resp = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        prompt,
        n: 1,
        size: size || DEFAULT_IMAGE_SIZE,
      }),
      signal: ctrl.signal,
    });
    text = await resp.text();
  } catch (err: unknown) {
    if (ctrl.signal.aborted) {
      throw new Error(`image generation timed out after ${cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`image API failed HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  let payload: { data?: Array<{ b64_json?: string; url?: string }> };
  try {
    payload = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }> };
  } catch {
    throw new Error("image API returned non-JSON response");
  }
  const first = payload.data?.[0];
  if (!first) throw new Error("image API returned no image");

  if (first.b64_json) {
    const data = Buffer.from(first.b64_json, "base64");
    if (!data.length || data.length > MAX_IMAGE_BYTES) {
      throw new Error("generated image out of size bounds");
    }
    return { mime: "image/png", data };
  }
  if (first.url) {
    const dl = await fetch(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!dl.ok) throw new Error(`image download failed HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
      throw new Error("downloaded image out of size bounds");
    }
    const mime = dl.headers.get("content-type")?.split(";")[0] || "image/png";
    return { mime: mime.startsWith("image/") ? mime : "image/png", data: buf };
  }
  throw new Error("image API returned neither b64_json nor url");
}
