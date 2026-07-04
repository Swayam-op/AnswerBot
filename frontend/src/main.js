import "./style.css";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WAIT_SECONDS = 10; // gap between one answer and the next capture

// API base:
// - Localhost/phone-on-LAN (now): leave VITE_API_URL unset -> uses "/api/solve",
//   which the Vite dev server proxies to the Node backend.
// - Later on Vercel: set VITE_API_URL to your backend URL
//   (e.g. https://answer-bot-api.vercel.app) and it will call that directly.
const API_BASE = import.meta.env.VITE_API_URL || "";
const API_URL = `${API_BASE}/api/solve`;

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const capturedImg = document.getElementById("captured-img");
const scanOverlay = document.getElementById("scan-overlay");

const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const statusPill = document.getElementById("status-pill");
const phaseBox = document.getElementById("phase");

const queueEl = document.getElementById("queue");
const queueCount = document.getElementById("queue-count");

const errorModal = document.getElementById("error-modal");
const errorText = document.getElementById("error-text");
const retryBtn = document.getElementById("retry-btn");
const cancelBtn = document.getElementById("cancel-btn");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let stream = null; // active MediaStream
let running = false; // is the exam loop active
let answerNumber = 0; // running count of processed captures
let countdownTimer = null; // setInterval handle
let errorResolver = null; // resolves the modal promise ("retry" | "cancel")

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setStatus(text, cls) {
  statusPill.textContent = text;
  statusPill.className = "pill " + cls;
}

function setPhase(html) {
  phaseBox.innerHTML = html;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      "Camera API not available. On a phone you must open the site over HTTPS or via localhost."
    );
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {}); // some browsers need a manual play; ignore if blocked
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

// Grab a frame from the video and return its base64 JPEG (no data: prefix).
// Throws if the camera frame is not ready yet.
function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) {
    throw new Error("Camera frame not ready yet.");
  }
  // Downscale so the longest side is at most MAX_DIM. Smaller payload =>
  // faster upload and faster model processing, while text stays readable.
  const MAX_DIM = 1280;
  const scale = Math.min(1, MAX_DIM / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  capturedImg.src = dataUrl; // show the captured image to the user
  return dataUrl.split(",")[1]; // strip "data:image/jpeg;base64," prefix
}

// ---------------------------------------------------------------------------
// Backend call — sends the image as base64 JSON (works locally + on Vercel)
// ---------------------------------------------------------------------------
async function solveImage(base64) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64, mimeType: "image/jpeg" }),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    throw new Error(data?.error || `Server error (HTTP ${res.status}).`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Queue rendering
// ---------------------------------------------------------------------------

// Create a "loading" queue item immediately when the request starts.
// It shows a spinner and a live elapsed-seconds timer. Returns a handle whose
// methods turn it into the final answer (or a failure).
function createPendingItem() {
  answerNumber += 1;
  const myNumber = answerNumber;
  queueCount.textContent = String(answerNumber);

  // remove the "empty" placeholder if present
  const empty = queueEl.querySelector(".queue-empty");
  if (empty) empty.remove();

  const li = document.createElement("li");
  li.className = "queue-item pending";

  const started = Date.now();
  const renderLoading = (secs) => {
    li.innerHTML = `
      <div class="qi-top">
        <span class="qi-num qi-num-loading"><span class="spinner"></span></span>
        <span class="qi-answer">Analyzing…</span>
      </div>
      <div class="qi-meta">
        <span>Capture #${myNumber}</span>
        <span class="timer">⏱ ${secs}s</span>
      </div>
    `;
  };
  renderLoading(0);
  queueEl.prepend(li);

  // tick the elapsed timer every second
  const ticker = setInterval(() => {
    const secs = Math.floor((Date.now() - started) / 1000);
    renderLoading(secs);
  }, 1000);

  const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

  return {
    // Replace the loading item with the real answer
    resolve(result) {
      clearInterval(ticker);
      li.className = "queue-item";
      const conf = (result.confidence || "").toLowerCase();
      if (conf === "low" || result.correctOption === 0) {
        li.classList.add("low-confidence");
      }
      const optionLabel =
        result.correctOption && result.correctOption > 0
          ? `#${result.correctOption}`
          : "?";
      li.innerHTML = `
        <div class="qi-top">
          <span class="qi-num">${optionLabel}</span>
          <span class="qi-answer">${escapeHtml(result.correctAnswer || "(no answer)")}</span>
        </div>
        ${
          result.question
            ? `<div class="qi-question">Q: ${escapeHtml(result.question)}</div>`
            : ""
        }
        <div class="qi-meta">
          <span>Capture #${myNumber}</span>
          <span>Confidence: ${escapeHtml(result.confidence || "n/a")}</span>
          <span>Took ${elapsed()}s</span>
        </div>
      `;
    },
    // Mark the loading item as failed (keeps it visible in the queue)
    fail(message) {
      clearInterval(ticker);
      li.className = "queue-item failed";
      li.innerHTML = `
        <div class="qi-top">
          <span class="qi-num qi-num-failed">✕</span>
          <span class="qi-answer">Failed</span>
        </div>
        <div class="qi-question">${escapeHtml(message || "Request failed.")}</div>
        <div class="qi-meta">
          <span>Capture #${myNumber}</span>
          <span>After ${elapsed()}s</span>
        </div>
      `;
    },
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Error modal -> returns "retry" or "cancel"
// ---------------------------------------------------------------------------
function askRetryOrCancel(message) {
  errorText.textContent = message;
  errorModal.classList.remove("hidden");
  setStatus("Error", "pill-error");
  return new Promise((resolve) => {
    errorResolver = resolve;
  });
}

retryBtn.addEventListener("click", () => resolveError("retry"));
cancelBtn.addEventListener("click", () => resolveError("cancel"));

function resolveError(choice) {
  errorModal.classList.add("hidden");
  if (errorResolver) {
    const r = errorResolver;
    errorResolver = null;
    r(choice);
  }
}

// ---------------------------------------------------------------------------
// Countdown between captures
// ---------------------------------------------------------------------------
function runCountdown(seconds) {
  return new Promise((resolve) => {
    let remaining = seconds;
    setStatus("Waiting", "pill-waiting");
    setPhase(
      `Next capture in <span class="timer">${remaining}</span> s`
    );
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (!running) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        resolve();
        return;
      }
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        resolve();
      } else {
        setPhase(`Next capture in <span class="timer">${remaining}</span> s`);
      }
    }, 1000);
  });
}

// ---------------------------------------------------------------------------
// One full cycle: capture -> send -> (retry loop) -> queue
// Returns true if it produced a result, false if user cancelled this capture.
// ---------------------------------------------------------------------------
async function processOneCapture() {
  // 1. Capture
  setStatus("Capturing", "pill-capturing");
  setPhase("📸 Capturing image…");
  scanOverlay.classList.remove("hidden");
  await sleep(350); // brief visible scan effect
  scanOverlay.classList.add("hidden");

  let imageB64;
  try {
    imageB64 = captureFrame();
  } catch (err) {
    const choice = await askRetryOrCancel(err.message);
    return choice === "retry" ? await processOneCapture() : false;
  }

  // 2. Insert a loading item into the queue right away (with live timer)
  const pending = createPendingItem();

  // 3. Send with retry loop
  while (running) {
    setStatus("Analyzing", "pill-loading");
    setPhase(`<span class="spinner"></span> Sending to Gemini and waiting for answer…`);
    try {
      const result = await solveImage(imageB64);
      pending.resolve(result); // loading item becomes the answer
      return true;
    } catch (err) {
      const message = err.message || "Request failed.";
      const choice = await askRetryOrCancel(message);
      if (choice === "cancel") {
        pending.fail(message); // keep the failed item visible in the queue
        return false;
      }
      // else loop again and retry the SAME image (pending timer keeps running)
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main exam loop
// ---------------------------------------------------------------------------
async function examLoop() {
  while (running) {
    const produced = await processOneCapture();
    if (!running) break;

    // If the user cancelled this capture, ask whether to keep the exam going
    if (!produced) {
      const choice = await askRetryOrCancel(
        "Capture cancelled. Rerun to try again, or Cancel to stop the exam."
      );
      if (choice === "cancel") {
        stopExam();
        return;
      }
      continue; // retry -> loop again immediately
    }

    if (!running) break;
    await runCountdown(WAIT_SECONDS); // wait before next capture
  }
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------
async function startExam() {
  if (running) return;
  try {
    setStatus("Starting", "pill-capturing");
    setPhase("Opening camera…");
    await startCamera();
  } catch (err) {
    setPhase("Could not open camera.");
    await askRetryOrCancel(err.message || "Camera access denied.");
    resetIdle();
    return;
  }

  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  examLoop().catch((err) => {
    console.error("Exam loop crashed:", err);
    setPhase("The exam loop stopped unexpectedly.");
    stopExam();
  });
}

function stopExam() {
  running = false;
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  // If an error modal is open, close it
  resolveError("cancel");
  stopCamera();
  resetIdle();
}

function resetIdle() {
  running = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Idle", "pill-idle");
  setPhase("Exam stopped. Press <b>Start Exam</b> to begin again.");
  scanOverlay.classList.add("hidden");
}

startBtn.addEventListener("click", startExam);
stopBtn.addEventListener("click", stopExam);

// Clean up camera if the tab is closed
window.addEventListener("beforeunload", stopCamera);
