// Serverless function: POST /api/solve
// Works on Vercel (default export handler) AND is reused by the local Express
// dev server (backend/server.js) so there is a single source of truth.
//
// Provider chain:
//   1) Google Gemini (primary)
//   2) On a Gemini RATE-LIMIT (429), fall back to GitHub Models gpt-4o-mini.
//
// Request body (JSON): { "image": "<base64 without data: prefix>", "mimeType": "image/jpeg" }
// Response (JSON): { question, options, correctOption, correctAnswer, confidence, provider, model, cached?, fallback? }

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config (read from environment; set these in Vercel > Project > Settings > Env)
// ---------------------------------------------------------------------------
const GITHUB_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GITHUB_MODEL = "openai/gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 45000;

// Best-effort in-memory cache (persists only within a warm instance).
const answerCache = new Map();
const CACHE_MAX = 500;

const SYSTEM_PROMPT = `You are an expert exam solver.
You will be given a photo of a multiple-choice question.
Read the question and every option carefully from the image.
Pick the single correct option.

Respond with ONLY a JSON object, no markdown, no extra words, in exactly this shape:
{
  "question": "<the question text you read>",
  "options": ["<option 1 text>", "<option 2 text>", "..."],
  "correctOption": <the 1-based number of the correct option>,
  "correctAnswer": "<the text of the correct option>",
  "confidence": "<high | medium | low>"
}
If the image is unreadable or has no question, use correctOption 0 and explain in correctAnswer.`;

const USER_TEXT =
  "Solve this multiple-choice question from the image. Reply with only the JSON described.";

// A typed error so callers can tell a rate-limit apart from other failures.
class ProviderError extends Error {
  constructor(message, { status, rateLimit } = {}) {
    super(message);
    this.status = status || 502;
    this.rateLimit = Boolean(rateLimit);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseModelJson(raw) {
  if (!raw || typeof raw !== "string") throw new Error("Empty response from model.");
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  if (!text.startsWith("{")) {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) text = braceMatch[0];
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      question: "",
      options: [],
      correctOption: 0,
      correctAnswer: raw.trim(),
      confidence: "low",
    };
  }
}

function buildResult(parsed, { provider, model, raw }) {
  return {
    question: parsed.question || "",
    options: Array.isArray(parsed.options) ? parsed.options : [],
    correctOption: Number(parsed.correctOption) || 0,
    correctAnswer: parsed.correctAnswer || "",
    confidence: parsed.confidence || "unknown",
    provider,
    model,
    raw,
  };
}

// Fetch with a hard timeout (fails fast instead of hanging).
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider 1: Google Gemini
// ---------------------------------------------------------------------------
async function solveWithGemini({ base64, mimeType, apiKey, model }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: USER_TEXT },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };

  const startedAt = Date.now();
  const apiRes = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const data = await apiRes.json().catch(() => ({}));
  console.log(`[gemini] ${model} -> ${apiRes.status} in ${Date.now() - startedAt} ms`);

  if (!apiRes.ok) {
    const msg = data?.error?.message || `HTTP ${apiRes.status}`;
    if (apiRes.status === 429) {
      throw new ProviderError(msg, { status: 429, rateLimit: true });
    }
    if (apiRes.status === 400 && /API key/i.test(msg)) {
      throw new ProviderError("Invalid Gemini API key.", { status: 401 });
    }
    throw new ProviderError(msg, { status: 502 });
  }

  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new ProviderError(
      blocked ? `Blocked by Gemini safety filter (${blocked}).` : "Gemini returned no answer.",
      { status: 502 }
    );
  }
  const raw = (candidate.content?.parts || []).map((p) => p.text || "").join("").trim();
  return buildResult(parseModelJson(raw), { provider: "gemini", model, raw });
}

// ---------------------------------------------------------------------------
// Provider 2 (fallback): GitHub Models gpt-4o-mini
// ---------------------------------------------------------------------------
async function solveWithGithub({ base64, mimeType, token, model }) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const body = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_TEXT },
          { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
        ],
      },
    ],
  };

  const startedAt = Date.now();
  const apiRes = await fetchWithTimeout(GITHUB_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await apiRes.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* GitHub 429 bodies are plain text */
  }
  console.log(`[github] ${model} -> ${apiRes.status} in ${Date.now() - startedAt} ms`);

  if (!apiRes.ok) {
    const msg = data?.error?.message || text || `HTTP ${apiRes.status}`;
    if (apiRes.status === 429 || /too many requests|rate limit/i.test(msg)) {
      throw new ProviderError(msg, { status: 429, rateLimit: true });
    }
    if (/budget limit/i.test(msg)) {
      throw new ProviderError("GitHub Models budget limit reached (account-wide).", {
        status: 429,
      });
    }
    throw new ProviderError(msg, { status: 502 });
  }

  const raw = data?.choices?.[0]?.message?.content ?? "";
  return buildResult(parseModelJson(raw), { provider: "github", model, raw });
}

// ---------------------------------------------------------------------------
// Build the ordered provider chain from environment variables:
//   1) Gemini  (GEMINI_API_KEY  + MODEL)
//   2) Gemini  (GEMINI_API_KEY2 + MODEL2)
//   3) GitHub  (GITHUB_TOKEN    + FALLBACK_MODEL)
//   4) GitHub  (GITHUB_TOKEN2   + FALLBACK_MODEL2)
// Only entries whose key/token is present are included. Each is tried in order.
// ---------------------------------------------------------------------------
function buildProviderChain() {
  const env = process.env;
  const chain = [];

  const geminiSlots = [
    { key: env.GEMINI_API_KEY, model: env.MODEL },
    { key: env.GEMINI_API_KEY2, model: env.MODEL2 },
  ];
  for (const slot of geminiSlots) {
    if (!slot.key) continue;
    const model = slot.model || DEFAULT_GEMINI_MODEL;
    chain.push({
      label: `gemini:${model}`,
      run: (img) => solveWithGemini({ ...img, apiKey: slot.key, model }),
    });
  }

  const githubSlots = [
    { token: env.GITHUB_TOKEN, model: env.FALLBACK_MODEL },
    { token: env.GITHUB_TOKEN2, model: env.FALLBACK_MODEL2 },
  ];
  for (const slot of githubSlots) {
    if (!slot.token) continue;
    const model = slot.model || DEFAULT_GITHUB_MODEL;
    chain.push({
      label: `github:${model}`,
      run: (img) => solveWithGithub({ ...img, token: slot.token, model }),
    });
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const chain = buildProviderChain();
  if (chain.length === 0) {
    return res.status(500).json({
      error:
        "Server has no API keys configured. Set GEMINI_API_KEY (and optionally GEMINI_API_KEY2 / GITHUB_TOKEN / GITHUB_TOKEN2) in the environment.",
    });
  }

  try {
    // Body may arrive parsed (Vercel/Express json) or as a raw string.
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const base64 = body?.image;
    const mimeType = body?.mimeType || "image/jpeg";

    if (!base64 || typeof base64 !== "string") {
      return res
        .status(400)
        .json({ error: "No image received. Send JSON { image: <base64>, mimeType }." });
    }

    // Cache lookup on the exact image bytes.
    const cacheKey = crypto.createHash("sha256").update(base64).digest("hex");
    if (answerCache.has(cacheKey)) {
      return res.json({ ...answerCache.get(cacheKey), cached: true });
    }

    // Try each provider in order; advance to the next one on ANY failure.
    let result;
    let lastError;
    const attempts = [];
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      try {
        result = await provider.run({ base64, mimeType });
        if (i > 0) result.fallback = true; // a backup provider answered
        break;
      } catch (err) {
        lastError = err;
        const reason = err?.message || "failed";
        attempts.push(`${provider.label}: ${reason}`);
        console.warn(
          `[chain] ${provider.label} failed (${i + 1}/${chain.length}): ${reason}` +
            (i + 1 < chain.length ? " — trying next" : "")
        );
      }
    }

    if (!result) {
      // Every provider in the chain failed.
      const status = lastError instanceof ProviderError ? lastError.status : 502;
      console.error("[chain] all providers failed:", attempts.join(" | "));
      return res.status(status).json({
        error: `All ${chain.length} model(s) failed. ${attempts.join(" | ")}`,
      });
    }

    // Cache good answers (evict oldest if full).
    if (result.correctOption > 0) {
      if (answerCache.size >= CACHE_MAX) {
        answerCache.delete(answerCache.keys().next().value);
      }
      answerCache.set(cacheKey, result);
    }

    return res.json(result);
  } catch (err) {
    if (err?.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "The model took too long to respond (timed out). Please rerun." });
    }
    console.error("[/api/solve] error:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Unknown server error while solving the image." });
  }
}
