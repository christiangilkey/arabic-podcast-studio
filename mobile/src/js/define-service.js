// Phone glue for the shared definer: settings, the synced answer cache, and native HTTPS.

import { api } from "./app.js";
import { define, cacheKey, PROVIDERS, DefinerError } from "./definer.js";
import { settings } from "./store.js";
import { isNative } from "./native.js";
import { registerPlugin } from "./vendor/capacitor-core.js";

const CapacitorHttp = isNative ? registerPlugin("CapacitorHttp") : null;

export function definerConfig() {
  const provider = PROVIDERS[settings.definer_provider] ? settings.definer_provider : "claude";
  return {
    provider,
    key: settings[`llm_key_${provider}`] || "",
    model: settings[`definer_model_${provider}`] || PROVIDERS[provider].defaultModel,
    language: settings.definer_language || "English",
  };
}

/** Send a provider request. Native HTTP on the phone avoids browser cross-site (CORS) limits. */
export async function transport(req) {
  if (CapacitorHttp) {
    const r = await CapacitorHttp.request({ url: req.url, method: "POST", headers: req.headers, data: req.body,
                                            responseType: "text" });
    return { status: r.status, text: typeof r.data === "string" ? r.data : JSON.stringify(r.data) };
  }
  const r = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  return { status: r.status, text: await r.text() };
}

export async function getDefinition(ctx, refresh = false) {
  const cfg = definerConfig();
  const key = await cacheKey(ctx.word, ctx.marked, cfg.language);
  if (!refresh) {
    const cached = await api(`/definitions/${key}`);
    if (cached) return cached;
  }
  if (!cfg.key) throw new DefinerError("NO_KEY");
  const data = await define(cfg, ctx, transport);
  await api(`/definitions/${key}`, {
    method: "PUT",
    body: { word: ctx.word, sentence: ctx.marked, data, provider: data.provider, model: data.model },
  });
  return data;
}
