// Local development server ONLY.
// On Vercel the /api/*.js files run directly as serverless functions. For local
// dev we wrap those same handlers in a tiny Express server so `npm start` works
// and the Vite proxy can forward /api calls here. Single source of truth: the
// handlers live in ../api/*.js.
import "dotenv/config";
import express from "express";
import cors from "cors";
import solveHandler from "../frontend/api/solve.js";
import healthHandler from "../frontend/api/health.js";

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
// Images arrive as base64 JSON, so allow a generous body size.
app.use(express.json({ limit: "15mb" }));

app.get("/api/health", (req, res) => healthHandler(req, res));
app.post("/api/solve", (req, res) => solveHandler(req, res));

app.listen(PORT, () => {
  console.log(`\n✅ Answer-Bot backend (local dev) on http://localhost:${PORT}`);
  console.log(`   Provider: Google Gemini`);
  console.log(`   Model: ${process.env.MODEL || "gemini-2.5-flash"}`);
  console.log(`   Key loaded: ${Boolean(process.env.GEMINI_API_KEY)}\n`);
});
