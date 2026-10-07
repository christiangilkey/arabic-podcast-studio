// Desktop glue for the definer: settings, the local answer cache, and the HTTPS relay.
// (The Android app provides its own version of this file with native HTTP and local storage.)

import { api, state } from "./app.js";
import { define, cacheKey, PROVIDERS, DefinerError } from "./definer.js";

export function definerConfig() {
  const s = (state.status && state.status.settings) || {};
  const provider = PROVIDERS[s.definer_provider] ? s.definer_provider : "claude";
  return {
    provider,
    key: s[`llm_key_${provider}`] || "",
    model: s[`definer_model_${provider}`] || PROVIDERS[provider].defaultModel,
    language: s.definer_language || "English",
  };
}

export function hasKey() {
  return !!definerConfig().key;
}

const relay = async (req) => api("/llm/relay", { method: "POST", body: req });

/**
 * Definition for ctx (see definer.define), from the cache when possible.
 * @param {boolean} refresh ignore the cache and ask the model again
 */
export async function getDefinition(ctx, refresh = false) {
  const cfg = definerConfig();
  const key = await cacheKey(ctx.word, ctx.marked, cfg.language);
  if (!refresh) {
    try { return await api(`/definitions/${key}`); } catch { /* not cached */ }
  }
  if (!cfg.key) throw new DefinerError("NO_KEY");
  const data = await define(cfg, ctx, relay);
  api(`/definitions/${key}`, {
    method: "PUT",
    body: { key, word: ctx.word, sentence: ctx.marked, data, provider: data.provider, model: data.model },
  }).catch(() => {});
  return data;
}
