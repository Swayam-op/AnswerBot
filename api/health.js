// Serverless function: GET /api/health
export default function handler(_req, res) {
  res.json({
    ok: true,
    provider: "gemini",
    model: process.env.MODEL || "gemini-2.5-flash",
    hasKey: Boolean(process.env.GEMINI_API_KEY),
  });
}
