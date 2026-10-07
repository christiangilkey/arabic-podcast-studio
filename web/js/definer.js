// Context-aware Arabic word definer. Shared by the desktop app and the Android app.
//
// One request per lookup: the word, its sentence and the neighbouring sentences go to the
// user's chosen AI provider with their own API key, and a schema-constrained JSON answer
// comes back. The HTTP transport is injected (desktop relays through its local server to
// avoid browser CORS limits; Android uses native HTTP), so this file has no platform code.

export const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
  },
  gemini: {
    label: "Gemini (Google)",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-flash-latest",
    models: ["gemini-flash-latest", "gemini-3.8-flash"],
  },
  openai: {
    label: "ChatGPT (OpenAI)",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-6.1-sol",
    models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"],
  },
  grok: {
    label: "Grok (xAI)",
    keyUrl: "https://console.x.ai/",
    defaultModel: "grok-4.7",
    models: ["grok-4.7"],
  },
};

// Every field is required (strict schemas demand it); the model uses "" or [] when n/a.
export const SCHEMA = {
  type: "object",
  properties: {
    word: { type: "string", description: "The target word exactly as it appears in the sentence." },
    vocalized: { type: "string", description: "The word with full tashkeel, as pronounced in this sentence." },
    lemma: { type: "string", description: "Dictionary form, vocalized (past-tense 3ms for verbs, singular for nouns)." },
    root: { type: "string", description: "Root letters separated by spaces, e.g. 'ك ت ب'; empty for particles/loanwords." },
    pos: { type: "string", description: "Part of speech, e.g. verb, noun, adjective, preposition, particle." },
    morphology: { type: "string", description: "Short analysis: verb form/tense/person, attached prefixes and pronouns, etc." },
    meaning: { type: "string", description: "Concise meaning of the word in THIS sentence." },
    explanation: { type: "string", description: "One or two sentences on why it means this here." },
    other_meanings: { type: "array", items: { type: "string" }, description: "Other common meanings out of context." },
    dialect: { type: "string", description: "MSA, Levantine, Egyptian, Gulf, Iraqi, Maghrebi, or similar." },
    dialect_note: { type: "string", description: "Dialect-specific usage note; empty if none." },
    msa_equivalent: { type: "string", description: "MSA equivalent if the word is dialectal; empty otherwise." },
    sentence_translation: { type: "string", description: "Natural translation of the whole sentence." },
  },
  required: ["word", "vocalized", "lemma", "root", "pos", "morphology", "meaning", "explanation",
    "other_meanings", "dialect", "dialect_note", "msa_equivalent", "sentence_translation"],
  additionalProperties: false,
};

const SYSTEM = (lang) => `You are an expert Arabic teacher helping a learner understand words in real podcast audio transcripts, which may be in Modern Standard Arabic or any dialect.

The learner tapped one word (or selected a short phrase). It is marked ⟦like this⟧ in the sentence. Analyze that specific occurrence (for a phrase, treat it as one expression), using the sentence, the surrounding sentences and the podcast details to resolve its meaning: Arabic words are highly context-dependent (unvocalized spelling, attached clitics, dialect usage), so the in-context meaning matters most.

Transcripts come from speech recognition and may contain small errors; if the word looks misrecognized, say what was probably said in the explanation.

Write all explanations, meanings and translations in ${lang}. Keep "meaning" short (a few words). Return only the JSON object.`;

function userPrompt(ctx) {
  const lines = [];
  if (ctx.podcast) lines.push(`Podcast: ${ctx.podcast}`);
  if (ctx.episode) lines.push(`Episode: ${ctx.episode}`);
  if (ctx.before) lines.push(`Previous sentence: ${ctx.before}`);
  lines.push(`Sentence: ${ctx.marked}`);
  if (ctx.after) lines.push(`Next sentence: ${ctx.after}`);
  lines.push(`Target word: ${ctx.word}`);
  return lines.join("\n");
}

/** The sentence with the target word (or phrase, words first..last) wrapped in ⟦⟧. */
export function markWord(words, first, last = first) {
  return words
    .map((w, i) => (i === first ? "⟦" : "") + w + (i === last ? "⟧" : ""))
    .join(" ");
}

/** Stable cache key for one lookup (same word in the same sentence → same answer). */
export async function cacheKey(word, marked, lang) {
  const data = new TextEncoder().encode(`${word}\u0000${marked}\u0000${lang}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// ---------- provider requests ----------

function geminiSchema(s) {
  // Gemini's responseSchema uses an OpenAPI subset: uppercase types, no additionalProperties.
  const out = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]));
    out.required = s.required;
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.items) out.items = geminiSchema(s.items);
  return out;
}

function buildRequest(provider, model, key, system, user, lite = false) {
  switch (provider) {
    case "claude": {
      const body = {
        model,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      };
      const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
      if (!lite && !model.startsWith("claude-haiku")) {
        body.output_config.effort = "low"; // fast lookups; thinking stays adaptive
        if (/^claude-(opus|sonnet)-5-5/.test(model)) {
          // Re-run on a fallback model if a safety classifier declines (rare for vocabulary).
          body.fallbacks = "default";
          headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
        }
      }
      return { url: "https://api.anthropic.com/v1/messages", headers, body };
    }
    case "gemini": {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(SCHEMA) },
      };
      if (!lite) body.generationConfig.thinkingConfig = { thinkingLevel: "low" };
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body,
      };
    }
    case "openai":
    case "grok": {
      const body = {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: lite
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: "word_definition", strict: true, schema: SCHEMA } },
      };
      if (!lite) body.reasoning_effort = "low";
      const base = provider === "openai" ? "https://api.openai.com/v1" : "https://api.x.ai/v1";
      return { url: `${base}/chat/completions`, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body };
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

function extractText(provider, data) {
  if (provider === "claude") {
    if (data.stop_reason === "refusal") throw new DefinerError("The model declined to define this word.");
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) throw new DefinerError(data.stop_reason === "max_tokens" ? "The answer was cut off." : "Empty answer.");
    return block.text;
  }
  if (provider === "gemini") {
    const cand = (data.candidates || [])[0];
    const parts = cand && cand.content && cand.content.parts;
    const text = parts ? parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("") : "";
    if (!text) throw new DefinerError(cand && cand.finishReason ? `No answer (${cand.finishReason}).` : "Empty answer.");
    return text;
  }
  const choice = (data.choices || [])[0];
  const msg = choice && choice.message;
  if (msg && msg.refusal) throw new DefinerError("The model declined to define this word.");
  if (!msg || !msg.content) throw new DefinerError("Empty answer.");
  return msg.content;
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
}

function normalize(obj, fallbackWord) {
  const s = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  return {
    word: s(obj.word) || fallbackWord,
    vocalized: s(obj.vocalized),
    lemma: s(obj.lemma),
    root: s(obj.root),
    pos: s(obj.pos),
    morphology: s(obj.morphology),
    meaning: s(obj.meaning),
    explanation: s(obj.explanation),
    other_meanings: Array.isArray(obj.other_meanings) ? obj.other_meanings.map(s).filter(Boolean) : [],
    dialect: s(obj.dialect),
    dialect_note: s(obj.dialect_note),
    msa_equivalent: s(obj.msa_equivalent),
    sentence_translation: s(obj.sentence_translation),
  };
}

export class DefinerError extends Error {}

function friendlyHttpError(provider, status, bodyText) {
  let detail = "";
  try {
    const j = JSON.parse(bodyText);
    // OpenAI/Anthropic/Gemini: {error: {message}}; xAI: {error: "..."}; others: {message}.
    detail = (typeof j.error === "string" ? j.error : j.error && (j.error.message || j.error.type)) || j.message || "";
  } catch { detail = (bodyText || "").slice(0, 200); }
  const name = PROVIDERS[provider].label;
  if (status === 401 || status === 403 || /api[ _-]?key/i.test(detail)) {
    return `${name} rejected the API key. Check it in Settings.`;
  }
  if (status === 404) return `${name} doesn't recognize that model name. Check it in Settings.${detail ? ` (${detail})` : ""}`;
  if (status === 429) return `${name} rate limit or quota reached. Try again shortly, or check your billing.`;
  if (status >= 500) return `${name} is having problems right now (HTTP ${status}). Try again.`;
  return `${name} error (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

/**
 * Define one word in context.
 * @param {{provider:string, model:string, key:string, language:string}} cfg
 * @param {{word:string, marked:string, before?:string, after?:string, podcast?:string, episode?:string}} ctx
 * @param {(req:{url:string, headers:object, body:object}) => Promise<{status:number, text:string}>} transport
 */
export async function define(cfg, ctx, transport) {
  if (!cfg.key) throw new DefinerError("No API key set. Add one in Settings → Word definitions.");
  const model = cfg.model || PROVIDERS[cfg.provider].defaultModel;
  const system = SYSTEM(cfg.language || "English");
  const user = userPrompt(ctx);

  let req = buildRequest(cfg.provider, model, cfg.key, system, user);
  let res = await transport(req);
  // Older/other models may reject the optional speed knobs (effort, thinking level, strict
  // schema). Retry once with a minimal request before giving up.
  if (res.status === 400) {
    req = buildRequest(cfg.provider, model, cfg.key, system, user, true);
    res = await transport(req);
  }
  if (res.status < 200 || res.status >= 300) throw new DefinerError(friendlyHttpError(cfg.provider, res.status, res.text));
  let data;
  try { data = JSON.parse(res.text); } catch { throw new DefinerError("The provider returned an unreadable response."); }
  const text = extractText(cfg.provider, data);
  try {
    return { ...normalize(parseJson(text), ctx.word), provider: cfg.provider, model };
  } catch {
    throw new DefinerError("The answer wasn't valid JSON. Try again, or pick a different model.");
  }
}
