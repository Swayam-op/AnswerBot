// Serverless function: POST /api/solve
// Works on Vercel (default export handler) AND is reused by the local Express
// dev server (backend/server.js) so there is a single source of truth.
//
// Request body (JSON): { "image": "<base64 without data: prefix>", "mimeType": "image/jpeg" }
// Response (JSON): { question, options, correctOption, correctAnswer, confidence, model, cached? }

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Config (read from environment; set these in Vercel > Project > Settings > Env)
// ---------------------------------------------------------------------------
const MODEL = process.env.MODEL || "gemini-2.5-flash";
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const requestBody = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Solve this multiple-choice question from the image. Reply with only the JSON described.",
            },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();
    let apiRes;
    try {
      apiRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    console.log(`[/api/solve] ${MODEL} responded in ${Date.now() - startedAt} ms`);

    const data = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      const apiMsg = data?.error?.message || `HTTP ${apiRes.status}`;
      console.error("[Gemini error]", apiMsg);
      if (apiRes.status === 429) {
        return res.status(429).json({
          error:
            "Gemini rate limit reached (free tier: per-minute or daily cap). Wait a moment and rerun.",
        });
      }
      if (apiRes.status === 400 && /API key/i.test(apiMsg)) {
        return res
          .status(401)
          .json({ error: "Invalid Gemini API key. Check the GEMINI_API_KEY setting." });
      }
      return res.status(502).json({ error: apiMsg });
    }

    const candidate = data?.candidates?.[0];
    if (!candidate) {
      const blocked = data?.promptFeedback?.blockReason;
      throw new Error(
        blocked ? `Blocked by Gemini safety filter (${blocked}).` : "Gemini returned no answer."
      );
    }

    const raw = (candidate.content?.parts || [])
      .map((p) => p.text || "")
      .join("")
      .trim();
    const parsed = parseModelJson(raw);

    const result = {
      question: parsed.question || "",
      options: Array.isArray(parsed.options) ? parsed.options : [],
      correctOption: Number(parsed.correctOption) || 0,
      correctAnswer: parsed.correctAnswer || "",
      confidence: parsed.confidence || "unknown",
      model: MODEL,
      raw,
    };

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
