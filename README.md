# 🟢 Answer Bot

Point your phone/camera at a multiple-choice question. The app captures a photo,
sends it to **Google Gemini (vision)**, and shows the correct answer in an
always-visible queue. It repeats automatically on a timer.

- **Backend** — Node.js + Express. `POST /api/solve` takes an image, asks Gemini to
  read the question and return the correct option as JSON.
- **Frontend** — Vite (vanilla JS). Camera capture, loading spinner, countdown timer,
  answer queue (with a live loading item), error → "Rerun / Cancel" dialog,
  green mobile-friendly UI.

## Requirements
- Node.js v22+ (you have v22.19.0 ✅)
- A **free** Google Gemini API key: https://aistudio.google.com/apikey

## 1. Backend

```bash
cd backend
npm install
npm start
```

Runs on http://localhost:3001. Put your Gemini key in `backend/.env`:
```
GEMINI_API_KEY=your_key_here
MODEL=gemini-2.0-flash
```
> The free Gemini tier (gemini-2.0-flash) easily covers 60 questions/day.
> ⚠️ Keep the key private; regenerate it before any public deploy.

## 2. Frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 and press **Start Exam**.

## Using it on your phone (same Wi-Fi)
The dev server already runs over **HTTPS** (self-signed cert) so the phone camera works.

1. PC and phone must be on the **same Wi-Fi**.
2. Start the backend and frontend as above. Vite prints a **Network** URL like:
   `https://192.168.1.6:5173/` — use your own IP.
3. On the phone, open that `https://<PC-IP>:5173` URL.
4. You'll see a **"Your connection is not private"** warning (expected — it's a
   self-signed cert). Tap **Advanced → Proceed / Visit anyway**.
5. Allow camera access when prompted, then press **Start Exam**.

Notes:
- If it can't connect, allow Node/Vite through **Windows Firewall** (Private network),
  or temporarily allow ports 5173 on the private profile.
- The backend stays plain HTTP on `localhost:3001`; the phone never talks to it
  directly — the Vite server proxies `/api` calls to it.

## Project layout
```
/api            → serverless functions (run on Vercel; reused by local dev)
  solve.js      → POST /api/solve  (Gemini vision)
  health.js     → GET  /api/health
/backend        → local dev server that wraps the /api handlers (npm start)
/frontend       → Vite app (camera UI)
vercel.json     → Vercel build config (builds frontend, serves /api functions)
```
The frontend calls `/api/solve` in both environments: locally the Vite proxy
forwards it to the dev server; on Vercel it's the same-origin serverless function.

## Deploying to Vercel (one project)
1. Push this repo to GitHub (see below).
2. In Vercel → **Add New → Project → Import** your GitHub repo.
3. Vercel reads `vercel.json` automatically (build = frontend, functions = /api).
   Leave the framework/preset as detected.
4. Add **Environment Variables** (Project → Settings → Environment Variables):
   - `GEMINI_API_KEY` = your key
   - `MODEL` = `gemini-2.5-flash`
5. **Deploy.** Your app is live at `https://<project>.vercel.app` — camera works
   because Vercel serves it over HTTPS.

> No `VITE_API_URL` needed: frontend and API share the same origin on Vercel.

## How it works
1. Start Exam → opens the rear camera.
2. Captures a frame → shows it → sends it as base64 JSON to `/api/solve`.
3. Gemini reads the image and returns `{ correctOption, correctAnswer, ... }`.
4. A loading card (with live timer) in the queue becomes the answer.
5. A countdown runs, then it captures again — looping automatically.
6. Any API/camera error opens a dialog: **Rerun** retries the same image, **Cancel** stops.
