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
const GEMINI_MODEL = process.env.MODEL || "gemini-2.5-flash";
const GITHUB_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const GITHUB_MODEL = process.env.FALLBACK_MODEL || "openai/gpt-4o-mini";
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
async function solveWithGemini({ base64, mimeType, apiKey }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
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
  console.log(`[gemini] ${GEMINI_MODEL} -> ${apiRes.status} in ${Date.now() - startedAt} ms`);

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
  return buildResult(parseModelJson(raw), { provider: "gemini", model: GEMINI_MODEL, raw });
}

// ---------------------------------------------------------------------------
// Provider 2 (fallback): GitHub Models gpt-4o-mini
// ---------------------------------------------------------------------------
async function solveWithGithub({ base64, mimeType, token }) {
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const body = {
    model: GITHUB_MODEL,
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
  console.log(`[github] ${GITHUB_MODEL} -> ${apiRes.status} in ${Date.now() - startedAt} ms`);

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
  return buildResult(parseModelJson(raw), { provider: "github", model: GITHUB_MODEL, raw });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN; // optional fallback
  if (!geminiKey) {
    return res.status(500).json({
      error:
        "Server is missing GEMINI_API_KEY. Set it in the backend .env (local) or Vercel env vars (production).",
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

    // 1) Try Gemini. 2) On rate-limit, fall back to GitHub gpt-4o-mini.
    let result;
    try {
      result = await solveWithGemini({ base64, mimeType, apiKey: geminiKey });
    } catch (err) {
      const isRateLimit = err instanceof ProviderError && err.rateLimit;

      if (isRateLimit && githubToken) {
        console.warn("[fallback] Gemini rate-limited -> trying GitHub gpt-4o-mini");
        try {
          result = await solveWithGithub({ base64, mimeType, token: githubToken });
          result.fallback = true;
        } catch (err2) {
          const msg2 = err2?.message || "Fallback failed.";
          console.error("[fallback] GitHub also failed:", msg2);
          return res.status(429).json({
            error: `Both providers are unavailable. Gemini hit its rate limit and the GitHub gpt-4o-mini fallback failed: ${msg2}`,
          });
        }
      } else if (err?.name === "AbortError") {
        return res
          .status(504)
          .json({ error: "The model took too long to respond (timed out). Please rerun." });
      } else {
        const status = err instanceof ProviderError ? err.status : 502;
        const message = isRateLimit
          ? "Gemini rate limit reached (free tier). Set GITHUB_TOKEN to enable the gpt-4o-mini fallback, or wait and rerun."
          : err?.message || "Model request failed.";
        return res.status(status).json({ error: message });
      }
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
