import "./style.css";
import { GlassRenderer, type GlassParams } from "./glass";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import "vanilla-colorful/hex-color-picker.js";
import type { HexColorPicker } from "vanilla-colorful/hex-color-picker.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const dropZone = document.getElementById("dropZone") as HTMLDivElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const slidersEl = document.getElementById("sliders") as HTMLDivElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;
const speedSlider = document.getElementById("speedSlider") as HTMLInputElement;
const speedVal = document.getElementById("speedVal") as HTMLSpanElement;
const formatSelect = document.getElementById("formatSelect") as HTMLSelectElement;
const exportFormatSelect = document.getElementById("exportFormatSelect") as HTMLSelectElement;
const exportResSelect = document.getElementById("exportResSelect") as HTMLSelectElement;
const exportPngBtn = document.getElementById("exportPngBtn") as HTMLButtonElement;
const exportMovBtn = document.getElementById("exportMovBtn") as HTMLButtonElement;
exportPngBtn.disabled = true;
exportMovBtn.disabled = true;

// Export resolution multiplier (1x / 2x / 3x of the on-screen canvas size)
let exportScale = 1;
const exportScaleSeg = document.getElementById("exportScaleSeg") as HTMLDivElement;
exportScaleSeg.querySelectorAll<HTMLButtonElement>("[data-scale]").forEach((btn) => {
  btn.addEventListener("click", () => {
    exportScale = parseInt(btn.dataset.scale ?? "1", 10) || 1;
    exportScaleSeg.querySelectorAll(".surface-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

function setSourceLoaded() {
  exportBtn.disabled = false;
  playBtn.disabled = false;
  exportPngBtn.disabled = false;
  exportMovBtn.disabled = false;
}

const renderer = new GlassRenderer(canvas);

const params: GlassParams = {
  slatWidth: 59,
  strength: 0.82,
  offset: 65,
  curvature: 1.0,
  yCurve: 0.0,
  zoom: 1.23,
  frost: 1.0,
  alternate: true,
  gradientOn: true,
  lumMin: 0,
  lumMax: 1,
  strengthMaskOn: false,
};

// Snapshot for per-slider reset buttons
const INITIAL_PARAMS: GlassParams = { ...params };

type StrengthStop = { pos: number; value: number };
let strengthStops: StrengthStop[] = [
  { pos: 0, value: 0 },
  { pos: 1, value: 1 },
];

function computeLumRange(source: CanvasImageSource): [number, number] {
  const SIZE = 256;
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  // P3 sample canvas matches what the WebGL shader sees
  const ctx = c.getContext("2d", {
    colorSpace: "display-p3",
    willReadFrequently: true,
  } as CanvasRenderingContext2DSettings);
  if (!ctx) return [0, 1];
  ctx.imageSmoothingEnabled = false;
  try {
    ctx.drawImage(source, 0, 0, SIZE, SIZE);
    const data = ctx.getImageData(0, 0, SIZE, SIZE, {
      colorSpace: "display-p3",
    } as ImageDataSettings).data;

    // Build a luminance histogram and stretch using 1st / 99th percentile,
    // so a handful of outlier pixels don't pin the range to 0..1.
    const hist = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      hist[Math.min(255, Math.max(0, Math.round(lum)))]++;
      total++;
    }
    const lowTarget = total * 0.01;
    const highTarget = total * 0.99;
    let cumulative = 0;
    let minBin = 0;
    let maxBin = 255;
    let minSet = false;
    for (let i = 0; i < 256; i++) {
      cumulative += hist[i];
      if (!minSet && cumulative >= lowTarget) {
        minBin = i;
        minSet = true;
      }
      if (cumulative >= highTarget) {
        maxBin = i;
        break;
      }
    }

    let min = minBin / 255;
    let max = maxBin / 255;
    if (max - min < 0.02) max = Math.min(1, min + 0.02);
    console.log("[lumRange]", min.toFixed(3), "→", max.toFixed(3));
    return [min, max];
  } catch (e) {
    console.warn("[lumRange] failed:", e);
    return [0, 1];
  }
}

type Stop = { pos: number; color: string };
let gradientStops: Stop[] = [
  { pos: 0.0, color: "#FF00CA" },
  { pos: 0.59, color: "#BE2940" },
  { pos: 1.0, color: "#700030" },
];

function normalizeHex(input: string): string | null {
  let s = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s.split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return "#" + s.toUpperCase();
  return null;
}

type SliderDef = {
  key: keyof Omit<GlassParams, "alternate" | "gradientOn" | "strengthMaskOn">;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
};

const sliderDefs: SliderDef[] = [
  { key: "slatWidth", label: "Slat width", min: 4, max: 300, step: 1, format: (v) => `${v.toFixed(0)}px` },
  { key: "strength", label: "Refraction", min: 0, max: 2, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "offset", label: "Offset", min: 0, max: 600, step: 1, format: (v) => `${v.toFixed(0)}px` },
  { key: "curvature", label: "Curvature", min: 0.1, max: 2.0, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "yCurve", label: "Vertical curve", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "zoom", label: "Zoom", min: 1, max: 5, step: 0.01, format: (v) => `${(v * 100).toFixed(0)}%` },
  { key: "frost", label: "Frost", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
];

const sliderInputs: Partial<Record<keyof GlassParams, HTMLInputElement>> = {};
const sliderValEls: Partial<Record<keyof GlassParams, HTMLSpanElement>> = {};
let alternateInput: HTMLInputElement | null = null;

function renderSliderRow(def: SliderDef): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "slider";
  wrap.innerHTML = `
    <div class="slider-head">
      <span class="slider-label">${def.label}</span>
      <span class="slider-val"></span>
    </div>
    <div class="slider-row">
      <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${params[def.key]}" />
      <button type="button" class="reset-btn" title="Reset to default">reset</button>
    </div>
  `;
  const input = wrap.querySelector('input[type="range"]') as HTMLInputElement;
  const val = wrap.querySelector(".slider-val") as HTMLSpanElement;
  const resetBtn = wrap.querySelector(".reset-btn") as HTMLButtonElement;
  sliderInputs[def.key] = input;
  sliderValEls[def.key] = val;
  const updateLabel = () => {
    const v = parseFloat(input.value);
    val.textContent = def.format ? def.format(v) : v.toString();
  };
  updateLabel();
  input.addEventListener("input", () => {
    params[def.key] = parseFloat(input.value);
    updateLabel();
    schedule();
  });
  resetBtn.addEventListener("click", () => {
    const defaultVal = INITIAL_PARAMS[def.key];
    params[def.key] = defaultVal;
    input.value = String(defaultVal);
    updateLabel();
    schedule();
  });
  return wrap;
}

function renderAlternateCheckbox(): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "check-row";
  wrap.innerHTML = `
    <input type="checkbox" />
    <span class="check-box"></span>
    <span>Alternate Slats</span>
  `;
  const input = wrap.querySelector("input") as HTMLInputElement;
  input.checked = params.alternate;
  input.addEventListener("change", () => {
    params.alternate = input.checked;
    schedule();
  });
  alternateInput = input;
  return wrap;
}

function buildSliders() {
  for (const def of sliderDefs) {
    slidersEl.appendChild(renderSliderRow(def));
    if (def.key === "slatWidth") {
      slidersEl.appendChild(renderAlternateCheckbox());
    }
  }
}

let frame = 0;
function schedule() {
  if (frame || playing) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderer.render(params);
  });
}

// ---- Animation loop ----
let playing = false;
let speedPxPerSec = 60;
let lastFrameTime = 0;

function setOffsetUI(v: number) {
  const inp = sliderInputs.offset;
  const val = sliderValEls.offset;
  if (inp) inp.value = String(v);
  if (val) val.textContent = `${v.toFixed(0)}px`;
}

function tick(time: number) {
  if (!playing) return;
  const dt = lastFrameTime === 0 ? 0 : (time - lastFrameTime) / 1000;
  lastFrameTime = time;
  // Pattern repeats every slatWidth normally, but every 2*slatWidth when
  // alternating slats (because dir flips per slat → odd/even slats differ).
  const period = Math.max(params.slatWidth, 1) * (params.alternate ? 2 : 1);
  let next = params.offset + speedPxPerSec * dt;
  next = ((next % period) + period) % period;
  params.offset = next;
  setOffsetUI(next);
  renderer.render(params);
  requestAnimationFrame(tick);
}

function setPlaying(p: boolean) {
  playing = p;
  playBtn.textContent = playing ? "Pause" : "Play";
  playBtn.classList.toggle("playing", playing);
  if (currentVideo) {
    if (playing) currentVideo.play().catch(() => {});
    else currentVideo.pause();
  }
  if (playing) {
    lastFrameTime = 0;
    requestAnimationFrame(tick);
  }
}

playBtn.addEventListener("click", () => {
  if (!renderer || exportBtn.disabled) return; // no image loaded yet
  setPlaying(!playing);
});

// Spacebar toggles play/pause (unless user is typing in a text field)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName ?? "";
  const type = (t as HTMLInputElement | null)?.type;
  const typing =
    t?.isContentEditable ||
    tag === "TEXTAREA" ||
    (tag === "INPUT" && type !== "range" && type !== "checkbox" && type !== "button");
  if (typing) return;
  if (exportBtn.disabled) return; // no source yet
  e.preventDefault();
  setPlaying(!playing);
});

// Scroll on the preview to visually zoom the canvas (CSS scale, not shader zoom).
// Max zoom-in is when canvas boundaries touch the stage (scale 1); scrolling
// down shrinks the preview within the stage.
const stageEl = document.getElementById("stage") as HTMLElement;
const PREVIEW_MIN = 0.1;
const PREVIEW_MAX = 1;
let previewScale = 1;
function applyPreviewScale() {
  // Use a CSS var that scales max-width/height, not `transform: scale()`,
  // so the 12px border-radius stays the same regardless of zoom.
  canvas.style.setProperty("--preview-scale", String(previewScale));
}
stageEl.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.002; // scroll up → zoom in
    const next = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, previewScale + delta));
    if (next === previewScale) return;
    previewScale = next;
    applyPreviewScale();
  },
  { passive: false }
);

const updateSpeedLabel = () => {
  speedPxPerSec = parseFloat(speedSlider.value);
  speedVal.textContent = `${speedPxPerSec.toFixed(0)} px/s`;
};
speedSlider.addEventListener("input", updateSpeedLabel);
updateSpeedLabel();

const SPEED_DEFAULT = parseFloat(speedSlider.value);
const speedResetBtn = document.getElementById("speedResetBtn") as HTMLButtonElement | null;
speedResetBtn?.addEventListener("click", () => {
  speedSlider.value = String(SPEED_DEFAULT);
  updateSpeedLabel();
});

// Canvas size inputs (left sidebar) drive the on-screen working canvas
const canvasWInp = document.getElementById("canvasW") as HTMLInputElement;
const canvasHInp = document.getElementById("canvasH") as HTMLInputElement;
function applyCanvasSize() {
  const w = parseInt(canvasWInp.value, 10);
  const h = parseInt(canvasHInp.value, 10);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    renderer.setOutputSize({ w, h });
    schedule();
  }
}
applyCanvasSize();
canvasWInp.addEventListener("input", applyCanvasSize);
canvasHInp.addEventListener("input", applyCanvasSize);

// ---- Source loading (image or video) ----
let currentVideo: HTMLVideoElement | null = null;

function cleanupSource() {
  if (currentVideo) {
    currentVideo.pause();
    URL.revokeObjectURL(currentVideo.src);
    currentVideo = null;
  }
}

function loadFile(file: File) {
  if (file.type.startsWith("image/")) {
    cleanupSource();
    // colorSpaceConversion: "none" preserves P3 / wide-gamut source pixels
    createImageBitmap(file, { colorSpaceConversion: "none" }).then((bitmap) => {
      renderer.setSource(bitmap);
      [params.lumMin, params.lumMax] = computeLumRange(bitmap);
      canvas.classList.add("has-image");
      setSourceLoaded();
      schedule();
    }).catch(() => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        renderer.setSource(img);
        [params.lumMin, params.lumMax] = computeLumRange(img);
        canvas.classList.add("has-image");
        setSourceLoaded();
        URL.revokeObjectURL(url);
        schedule();
      };
      img.src = url;
    });
  } else if (file.type.startsWith("video/")) {
    cleanupSource();
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    video.addEventListener("loadeddata", () => {
      currentVideo = video;
      renderer.setSource(video);
      [params.lumMin, params.lumMax] = computeLumRange(video);
      canvas.classList.add("has-image");
      setSourceLoaded();
      schedule();
    }, { once: true });
  }
}

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
});
["dragenter", "dragover"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  })
);
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ---- Export ----
type ExportFormat = {
  id: string;
  label: string;
  ext: string;
  mime?: string;          // undefined = PNG still
  container?: "mp4" | "mov" | "webm";
};

function buildExportFormats(): ExportFormat[] {
  const out: ExportFormat[] = [{ id: "png", label: "PNG (current frame)", ext: "png" }];
  const mp4 = "video/mp4;codecs=avc1";
  const mp4Plain = "video/mp4";
  const webmVp9 = "video/webm;codecs=vp9";
  const webmVp8 = "video/webm;codecs=vp8";
  const supportsMp4 = "MediaRecorder" in window &&
    (MediaRecorder.isTypeSupported(mp4) || MediaRecorder.isTypeSupported(mp4Plain));
  const mp4Mime = MediaRecorder.isTypeSupported(mp4) ? mp4 : mp4Plain;
  if (supportsMp4) {
    out.push({ id: "mp4", label: "MP4 (one loop)", ext: "mp4", mime: mp4Mime, container: "mp4" });
    // MOV container shares the H.264 bitstream; QuickTime opens .mov-wrapped MP4 fine.
    out.push({ id: "mov", label: "MOV (one loop)", ext: "mov", mime: mp4Mime, container: "mov" });
  }
  if ("MediaRecorder" in window && MediaRecorder.isTypeSupported(webmVp9)) {
    out.push({ id: "webm", label: "WebM (one loop)", ext: "webm", mime: webmVp9, container: "webm" });
  } else if ("MediaRecorder" in window && MediaRecorder.isTypeSupported(webmVp8)) {
    out.push({ id: "webm", label: "WebM (one loop)", ext: "webm", mime: webmVp8, container: "webm" });
  }
  return out;
}

const exportFormats = buildExportFormats();
for (const f of exportFormats) {
  const opt = document.createElement("option");
  opt.value = f.id;
  opt.textContent = f.label;
  exportFormatSelect.appendChild(opt);
}

function getLoopSeconds(): number {
  if (currentVideo && isFinite(currentVideo.duration) && currentVideo.duration > 0) {
    return currentVideo.duration;
  }
  if (speedPxPerSec === 0) return 0;
  const period = Math.max(params.slatWidth, 1) * (params.alternate ? 2 : 1);
  return period / Math.abs(speedPxPerSec);
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportPng() {
  const origW = canvas.width;
  const origH = canvas.height;
  const targetW = origW * exportScale;
  const targetH = origH * exportScale;
  // Pixel-unit params must scale with the canvas so slat geometry looks identical
  const origSlat = params.slatWidth;
  const origOffset = params.offset;
  if (exportScale > 1) {
    renderer.setOutputSize({ w: targetW, h: targetH });
    params.slatWidth = origSlat * exportScale;
    params.offset = origOffset * exportScale;
  }
  renderer.render(params);

  const mirror = document.createElement("canvas");
  mirror.width = targetW;
  mirror.height = targetH;
  const ctx = mirror.getContext(
    "2d",
    { colorSpace: "display-p3" } as CanvasRenderingContext2DSettings
  );
  const target = ctx ? mirror : canvas;
  if (ctx) ctx.drawImage(canvas, 0, 0);

  await new Promise<void>((resolve) => {
    target.toBlob((blob) => {
      if (blob) downloadBlob(blob, `mas-overlay@${exportScale}x.png`);
      resolve();
    }, "image/png");
  });

  if (exportScale > 1) {
    params.slatWidth = origSlat;
    params.offset = origOffset;
    renderer.setOutputSize({ w: origW, h: origH });
    renderer.render(params);
  }
}

const LOOP_COUNT = 10;

async function exportLoop(fmt: ExportFormat) {
  const loopSec = getLoopSeconds();
  if (loopSec <= 0) {
    alert("Can't determine a loop length. Set a non-zero speed, or load a video.");
    return;
  }
  const duration = loopSec * LOOP_COUNT;
  if (!fmt.mime) return;

  // Disable the global tick so the record loop fully owns animation state
  const wasPlaying = playing;
  setPlaying(false);

  // Reset to start-of-loop
  params.offset = 0;
  setOffsetUI(0);
  if (currentVideo) {
    currentVideo.currentTime = 0;
    await new Promise((r) => setTimeout(r, 80));
    try { await currentVideo.play(); } catch {}
  }

  // Safari's captureStream() on a WebGL canvas silently produces no frames.
  // Workaround: copy the WebGL canvas to a 2D canvas each frame.
  // Render at exportScale × canvas size, aligned to multiples of 16 (H.264).
  const baseW = canvas.width;
  const baseH = canvas.height;
  const outW = Math.max(16, Math.floor((baseW * exportScale) / 16) * 16);
  const outH = Math.max(16, Math.floor((baseH * exportScale) / 16) * 16);
  // Save and scale pixel-unit params so slat geometry matches the higher-res canvas
  const origSlat = params.slatWidth;
  const origOffsetVal = params.offset;
  const origSpeed = speedPxPerSec;
  if (exportScale > 1) {
    renderer.setOutputSize({ w: outW, h: outH });
    params.slatWidth = origSlat * exportScale;
    speedPxPerSec = origSpeed * exportScale;
  }
  const mirrorCanvas = document.createElement("canvas");
  mirrorCanvas.width = outW;
  mirrorCanvas.height = outH;
  // Some browsers need the captured canvas to be in the DOM
  mirrorCanvas.style.cssText = "position:fixed;left:-99999px;top:0;pointer-events:none";
  document.body.appendChild(mirrorCanvas);
  const ctx = mirrorCanvas.getContext("2d");
  if (!ctx) {
    alert("Cannot create 2D context for recording.");
    document.body.removeChild(mirrorCanvas);
    exportBtn.disabled = false;
    exportBtn.textContent = "Export";
    return;
  }
  // Paint one frame so the stream has something to start with
  renderer.render(params);
  ctx.drawImage(canvas, 0, 0, outW, outH);

  const stream = mirrorCanvas.captureStream(60);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & {
    requestFrame?: () => void;
  };
  console.log("[export] mirror size", mirrorCanvas.width, "x", mirrorCanvas.height,
              "tracks:", stream.getVideoTracks().length, "track state:", track?.readyState);

  const recorder = new MediaRecorder(stream, {
    mimeType: fmt.mime,
    videoBitsPerSecond: Math.min(120_000_000, Math.round(outW * outH * 60 * 0.25)),
  });
  console.log("[export] recorder mime:", recorder.mimeType, "state:", recorder.state);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    console.log("[export] dataavailable size:", e.data.size);
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => console.error("[export] recorder error", e);
  recorder.onstart = () => console.log("[export] recorder started");

  exportBtn.disabled = true;
  exportBtn.textContent = `Recording… 0.0s / ${duration.toFixed(1)}s`;

  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();

    const startT = performance.now();
    let lastT = startT;
    let stopped = false;

    const recordTick = (time: number) => {
      if (stopped) return;
      const elapsed = (time - startT) / 1000;
      if (elapsed >= duration) {
        stopped = true;
        recorder.stop();
        return;
      }
      const dt = (time - lastT) / 1000;
      lastT = time;

      const period = Math.max(params.slatWidth, 1) * (params.alternate ? 2 : 1);
      let next = params.offset + speedPxPerSec * dt;
      next = ((next % period) + period) % period;
      params.offset = next;
      setOffsetUI(next);

      renderer.render(params);
      ctx.drawImage(canvas, 0, 0, outW, outH);
      if (typeof track.requestFrame === "function") track.requestFrame();
      exportBtn.textContent = `Recording… ${elapsed.toFixed(1)}s / ${duration.toFixed(1)}s`;
      requestAnimationFrame(recordTick);
    };

    // Timeslice 200ms forces progressive ondataavailable so we don't lose
    // the recording if anything goes wrong at the end.
    recorder.start(200);
    requestAnimationFrame(recordTick);
  });

  // Restore previous play state and pixel-unit params
  if (currentVideo && !wasPlaying) currentVideo.pause();
  if (wasPlaying) setPlaying(true);
  document.body.removeChild(mirrorCanvas);
  if (exportScale > 1) {
    params.slatWidth = origSlat;
    params.offset = origOffsetVal;
    speedPxPerSec = origSpeed;
    renderer.setOutputSize({ w: baseW, h: baseH });
    renderer.render(params);
  }

  const outMime = fmt.container === "mov" ? "video/quicktime" : fmt.mime;
  const blob = new Blob(chunks, { type: outMime });
  console.log("[export] final blob bytes:", blob.size, "chunks:", chunks.length);
  downloadBlob(blob, `mas-loop@${exportScale}x.${fmt.ext}`);

  exportBtn.disabled = false;
  exportBtn.textContent = "Export";
}

function supportsWebCodecs(): boolean {
  return "VideoEncoder" in window && "VideoFrame" in window;
}

function pickH264Codec(w: number, h: number): string {
  const px = w * h;
  if (px <= 1280 * 720) return "avc1.64001F";          // High 3.1
  if (px <= 1920 * 1088) return "avc1.640028";         // High 4.0 — 1080p60
  if (px <= 2560 * 1440) return "avc1.640032";         // High 5.0 — 1440p60
  if (px <= 3840 * 2160) return "avc1.640033";         // High 5.1 — 4K60
  if (px <= 4096 * 2160) return "avc1.640034";         // High 5.2
  return "avc1.640040";                                 // High 6.0 — 8K
}

async function exportViaWebCodecs(fmt: ExportFormat) {
  const loopSec = getLoopSeconds();
  if (loopSec <= 0) {
    alert("Can't determine a loop length. Set a non-zero speed, or load a video.");
    return;
  }
  if (fmt.container === "webm") return exportLoop(fmt);

  const FPS = 60;
  const totalFrames = Math.max(1, Math.round(loopSec * LOOP_COUNT * FPS));

  // Render at exportScale × canvas size, aligned to multiples of 16
  const baseW = canvas.width;
  const baseH = canvas.height;
  const outW = Math.max(16, Math.floor((baseW * exportScale) / 16) * 16);
  const outH = Math.max(16, Math.floor((baseH * exportScale) / 16) * 16);
  // Save and scale pixel-unit params so geometry + animation match higher-res canvas
  const origSlatWebcodec = params.slatWidth;
  const origSpeedWebcodec = speedPxPerSec;
  if (exportScale > 1) {
    renderer.setOutputSize({ w: outW, h: outH });
    params.slatWidth = origSlatWebcodec * exportScale;
    speedPxPerSec = origSpeedWebcodec * exportScale;
  }

  const mirror = document.createElement("canvas");
  mirror.width = outW;
  mirror.height = outH;
  // P3 mirror canvas so drawImage from the P3 WebGL canvas doesn't convert to sRGB
  const ctx = mirror.getContext(
    "2d",
    { colorSpace: "display-p3" } as CanvasRenderingContext2DSettings
  );
  if (!ctx) return;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: outW, height: outH, frameRate: FPS },
    fastStart: "in-memory",
  });

  // P3 color space tag — mp4-muxer writes the 'colr' box when decoderConfig
  // has colorSpace. smpte432 = Display P3 primaries, iec61966-2-1 = sRGB transfer.
  // `smpte432` isn't in lib.dom's restrictive type yet, so cast.
  const p3ColorSpace = {
    primaries: "smpte432",
    transfer: "iec61966-2-1",
    matrix: "bt709",
    fullRange: true,
  } as unknown as VideoColorSpaceInit;

  let encoderErrored = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const tagged = {
        ...(meta ?? {}),
        decoderConfig: {
          ...(meta?.decoderConfig ?? { codec: pickH264Codec(outW, outH) }),
          colorSpace: p3ColorSpace,
        },
      };
      muxer.addVideoChunk(chunk, tagged);
    },
    error: (e) => { console.error("[encoder]", e); encoderErrored = true; },
  });

  encoder.configure({
    codec: pickH264Codec(outW, outH),
    width: outW,
    height: outH,
    framerate: FPS,
    // Higher BPP for clean output. Cap at ~150 Mbps to stay encoder-friendly.
    bitrate: Math.min(150_000_000, Math.round(outW * outH * FPS * 0.3)),
    bitrateMode: "variable",
    avc: { format: "avc" },
  });

  const wasPlaying = playing;
  setPlaying(false);
  if (currentVideo) currentVideo.pause();

  const period = Math.max(params.slatWidth, 1) * (params.alternate ? 2 : 1);
  const videoDur = currentVideo?.duration ?? 0;
  const originalOffset = params.offset;

  exportBtn.disabled = true;

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (encoderErrored) throw new Error("Encoder failed");
      const t = i / FPS;

      // Offset for this time — identical math to tick, guaranteed loop
      let next = speedPxPerSec * t;
      next = ((next % period) + period) % period;
      params.offset = next;

      if (currentVideo && videoDur > 0) {
        const targetTime = (t % videoDur);
        if (Math.abs(currentVideo.currentTime - targetTime) > 1 / FPS / 2) {
          currentVideo.currentTime = targetTime;
          await new Promise<void>((resolve) => {
            const onSeeked = () => {
              currentVideo!.removeEventListener("seeked", onSeeked);
              resolve();
            };
            currentVideo!.addEventListener("seeked", onSeeked);
          });
        }
      }

      renderer.render(params);
      ctx.drawImage(canvas, 0, 0, outW, outH);

      const frame = new VideoFrame(mirror, {
        timestamp: Math.round(i * 1_000_000 / FPS),
        duration: Math.round(1_000_000 / FPS),
      });
      encoder.encode(frame, { keyFrame: i === 0 || i % FPS === 0 });
      frame.close();

      // Throttle to prevent encoder queue from blowing up
      while (encoder.encodeQueueSize > 20) {
        await new Promise((r) => setTimeout(r, 8));
      }

      if (i % 6 === 0) {
        const pct = ((i / totalFrames) * 100).toFixed(0);
        exportBtn.textContent = `Encoding ${pct}%…`;
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    await encoder.flush();
    muxer.finalize();

    const buffer = muxer.target.buffer;
    const outMime = fmt.container === "mov" ? "video/quicktime" : "video/mp4";
    const blob = new Blob([buffer], { type: outMime });
    console.log("[export] final blob bytes:", blob.size);
    downloadBlob(blob, `mas-loop@${exportScale}x.${fmt.ext}`);
  } catch (err) {
    console.error("[export] failed", err);
    alert("Export failed. Try a lower resolution or check the console.");
  } finally {
    params.offset = originalOffset;
    setOffsetUI(originalOffset);
    if (exportScale > 1) {
      params.slatWidth = origSlatWebcodec;
      speedPxPerSec = origSpeedWebcodec;
      renderer.setOutputSize({ w: baseW, h: baseH });
    }
    renderer.render(params);
    if (wasPlaying) setPlaying(true);
    exportBtn.disabled = false;
    exportBtn.textContent = "Export";
  }
}

async function runExport(id: "png" | "mov") {
  if (id === "png") return exportPng();
  // Button is labelled "MOV" but we output an .mp4 file (same H.264 bitstream).
  const fmt =
    exportFormats.find((f) => f.id === "mp4") ??
    exportFormats.find((f) => f.id === "mov");
  if (!fmt) {
    alert("Video export isn't supported in this browser.");
    return;
  }
  if (supportsWebCodecs() && fmt.container !== "webm") {
    return exportViaWebCodecs(fmt);
  }
  await exportLoop(fmt);
}

exportPngBtn.addEventListener("click", () => {
  if (!exportPngBtn.disabled) runExport("png");
});
exportMovBtn.addEventListener("click", () => {
  if (!exportMovBtn.disabled) runExport("mov");
});

buildSliders();

// Auto-load default image
(async () => {
  try {
    const res = await fetch("/default.png");
    if (!res.ok) return;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
    renderer.setSource(bitmap);
    [params.lumMin, params.lumMax] = computeLumRange(bitmap);
    canvas.classList.add("has-image");
    setSourceLoaded();
    schedule();
  } catch {}
})();

// ---- Gradient map editor ----
const gradientToggle = document.getElementById("gradientToggle") as HTMLInputElement;
const gradientBar = document.getElementById("gradientBar") as HTMLDivElement;
const gradientStopsEl = document.getElementById("gradientStops") as HTMLDivElement;
const addStopBtn = document.getElementById("addStopBtn") as HTMLButtonElement;

const gradientCanvas = document.createElement("canvas");
gradientCanvas.width = 256;
gradientCanvas.height = 1;
const gradientCtx = gradientCanvas.getContext("2d")!;

function gradientCssString(): string {
  const sorted = [...gradientStops].sort((a, b) => a.pos - b.pos);
  return sorted
    .map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`)
    .join(", ");
}

function rebuildGradient() {
  const sorted = [...gradientStops].sort((a, b) => a.pos - b.pos);
  gradientCtx.clearRect(0, 0, 256, 1);
  const grad = gradientCtx.createLinearGradient(0, 0, 256, 0);
  for (const s of sorted) {
    grad.addColorStop(Math.max(0, Math.min(1, s.pos)), s.color);
  }
  gradientCtx.fillStyle = grad;
  gradientCtx.fillRect(0, 0, 256, 1);
  renderer.setGradient(gradientCanvas);
  gradientBar.innerHTML = "";
  const inner = document.createElement("div");
  inner.style.background = `linear-gradient(to right, ${gradientCssString()})`;
  gradientBar.appendChild(inner);
  schedule();
}

function sortAndRebuildRows() {
  const active = document.activeElement as HTMLInputElement | null;
  let focusedStop: Stop | null = null;
  let focusedKind: "number" | "text" | null = null;
  if (active && active.tagName === "INPUT") {
    const row = active.closest(".stop-row");
    if (row) {
      const idx = Array.from(gradientStopsEl.children).indexOf(row);
      if (idx >= 0) focusedStop = gradientStops[idx];
      focusedKind = active.type === "text" ? "text" : "number";
    }
  }

  const before = gradientStops.slice();
  gradientStops.sort((a, b) => a.pos - b.pos);
  const orderChanged = gradientStops.some((s, i) => s !== before[i]);

  if (orderChanged) {
    buildStopRows();
    if (focusedStop && focusedKind) {
      const newIdx = gradientStops.indexOf(focusedStop);
      if (newIdx >= 0) {
        const newRow = gradientStopsEl.children[newIdx];
        const sel = focusedKind === "text" ? 'input[type="text"]' : 'input[type="number"]';
        const newInput = newRow?.querySelector(sel) as HTMLInputElement | null;
        newInput?.focus();
      }
    }
  }

  rebuildGradient();
}

function buildStopRows() {
  gradientStopsEl.innerHTML = "";
  for (const stop of gradientStops) {
    const row = document.createElement("div");
    row.className = "stop-row";
    row.innerHTML = `
      <input type="number" min="0" max="100" step="1" value="${Math.round(stop.pos * 100)}" />
      <button type="button" class="swatch" style="background:${stop.color}" aria-label="Pick color"></button>
      <input type="text" value="${stop.color.replace(/^#/, "")}" maxlength="7" spellcheck="false" />
      <button type="button" title="Remove" class="remove-stop">×</button>
    `;
    const posInp = row.querySelector('input[type="number"]') as HTMLInputElement;
    const swatchBtn = row.querySelector(".swatch") as HTMLButtonElement;
    const hexInp = row.querySelector('input[type="text"]') as HTMLInputElement;
    const removeBtn = row.querySelector(".remove-stop") as HTMLButtonElement;

    // Live update + reorder on every change
    posInp.addEventListener("input", () => {
      const v = parseFloat(posInp.value);
      if (isFinite(v)) {
        stop.pos = Math.max(0, Math.min(1, v / 100));
        sortAndRebuildRows();
      }
    });
    posInp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const cur = parseFloat(posInp.value) || 0;
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const next = Math.max(0, Math.min(100, cur + step * dir));
      posInp.value = String(next);
      stop.pos = next / 100;
      sortAndRebuildRows();
    });

    const applyHex = () => {
      const norm = normalizeHex(hexInp.value);
      if (norm) {
        stop.color = norm;
        hexInp.value = norm.replace(/^#/, "");
        swatchBtn.style.background = norm;
        rebuildGradient();
      }
    };
    hexInp.addEventListener("change", applyHex);
    hexInp.addEventListener("paste", () => setTimeout(applyHex, 0));

    swatchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openColorPicker(swatchBtn, stop.color, (newColor) => {
        stop.color = newColor;
        hexInp.value = newColor.replace(/^#/, "");
        swatchBtn.style.background = newColor;
        rebuildGradient();
      });
    });

    removeBtn.addEventListener("click", () => {
      if (gradientStops.length <= 2) return;
      gradientStops = gradientStops.filter((s) => s !== stop);
      buildStopRows();
      rebuildGradient();
    });
    gradientStopsEl.appendChild(row);
  }
}

// ---- Color picker popover ----
let activePopover: HTMLDivElement | null = null;
let activePopoverCleanup: (() => void) | null = null;

function closeColorPicker() {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  if (activePopoverCleanup) {
    activePopoverCleanup();
    activePopoverCleanup = null;
  }
}

function openColorPicker(
  anchor: HTMLElement,
  initial: string,
  onChange: (hex: string) => void
) {
  closeColorPicker();
  const pop = document.createElement("div");
  pop.className = "color-popover";
  const picker = document.createElement("hex-color-picker") as HexColorPicker;
  picker.color = initial;
  picker.addEventListener("color-changed", (e) => {
    const hex = (e as CustomEvent<{ value: string }>).detail.value.toUpperCase();
    onChange(hex);
  });
  pop.appendChild(picker);
  document.body.appendChild(pop);

  // Position below anchor
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (left + popRect.width > window.innerWidth - 8) {
    left = window.innerWidth - popRect.width - 8;
  }
  if (top + popRect.height > window.innerHeight - 8) {
    top = rect.top - popRect.height - 6;
  }
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  const onDocClick = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) closeColorPicker();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeColorPicker();
  };
  setTimeout(() => document.addEventListener("click", onDocClick), 0);
  document.addEventListener("keydown", onKey);

  activePopover = pop;
  activePopoverCleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  };
}

addStopBtn.addEventListener("click", () => {
  // Insert a new stop at midpoint between last two stops (or at 0.5)
  const sorted = [...gradientStops].sort((a, b) => a.pos - b.pos);
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const newPos = prev ? (prev.pos + last.pos) / 2 : 0.5;
  gradientStops.push({ pos: newPos, color: "#FFFFFF" });
  buildStopRows();
  rebuildGradient();
});

gradientToggle.checked = params.gradientOn;
gradientToggle.addEventListener("change", () => {
  params.gradientOn = gradientToggle.checked;
  schedule();
});

buildStopRows();
rebuildGradient();

// ---- Strength gradient (effect mask) ----
const strengthToggle = document.getElementById("strengthToggle") as HTMLInputElement;
const strengthBar = document.getElementById("strengthBar") as HTMLDivElement;
const strengthStopsEl = document.getElementById("strengthStops") as HTMLDivElement;
const addStrengthStopBtn = document.getElementById("addStrengthStopBtn") as HTMLButtonElement;

const strengthCanvas = document.createElement("canvas");
strengthCanvas.width = 256;
strengthCanvas.height = 1;
const strengthCtx = strengthCanvas.getContext("2d")!;

function strengthCssString(): string {
  // Preview bar uses theme colors: value 0 → #2C0E23, value 1 → #DFF0FF
  return [...strengthStops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => {
      const t = Math.max(0, Math.min(1, s.value));
      const r = Math.round(0x2c + (0xdf - 0x2c) * t);
      const g = Math.round(0x0e + (0xf0 - 0x0e) * t);
      const b = Math.round(0x23 + (0xff - 0x23) * t);
      return `rgb(${r},${g},${b}) ${(s.pos * 100).toFixed(1)}%`;
    })
    .join(", ");
}

function rebuildStrengthMask() {
  const sorted = [...strengthStops].sort((a, b) => a.pos - b.pos);
  strengthCtx.clearRect(0, 0, 256, 1);
  const grad = strengthCtx.createLinearGradient(0, 0, 256, 0);
  for (const s of sorted) {
    const v = Math.round(Math.max(0, Math.min(1, s.value)) * 255);
    grad.addColorStop(Math.max(0, Math.min(1, s.pos)), `rgb(${v},${v},${v})`);
  }
  strengthCtx.fillStyle = grad;
  strengthCtx.fillRect(0, 0, 256, 1);
  renderer.setStrengthMask(strengthCanvas);
  strengthBar.innerHTML = "";
  const inner = document.createElement("div");
  inner.style.background = `linear-gradient(to right, ${strengthCssString()})`;
  strengthBar.appendChild(inner);
  schedule();
}

function sortAndRebuildStrengthRows() {
  const active = document.activeElement as HTMLInputElement | null;
  let focusedStop: StrengthStop | null = null;
  let focusedField: "pos" | "val" | null = null;
  if (active && active.tagName === "INPUT") {
    const row = active.closest(".stop-row");
    if (row) {
      const idx = Array.from(strengthStopsEl.children).indexOf(row);
      if (idx >= 0) focusedStop = strengthStops[idx];
      const inputs = Array.from(row.querySelectorAll("input"));
      focusedField = inputs.indexOf(active) === 0 ? "pos" : "val";
    }
  }
  const before = strengthStops.slice();
  strengthStops.sort((a, b) => a.pos - b.pos);
  const orderChanged = strengthStops.some((s, i) => s !== before[i]);
  if (orderChanged) {
    buildStrengthRows();
    if (focusedStop && focusedField) {
      const newIdx = strengthStops.indexOf(focusedStop);
      if (newIdx >= 0) {
        const newRow = strengthStopsEl.children[newIdx];
        const inputs = newRow?.querySelectorAll("input");
        const target = inputs?.[focusedField === "pos" ? 0 : 1] as HTMLInputElement | undefined;
        target?.focus();
      }
    }
  }
  rebuildStrengthMask();
}

function buildStrengthRows() {
  strengthStopsEl.innerHTML = "";
  for (const stop of strengthStops) {
    const row = document.createElement("div");
    row.className = "stop-row strength-row";
    row.innerHTML = `
      <input type="number" min="0" max="100" step="1" value="${Math.round(stop.pos * 100)}" />
      <input type="number" min="0" max="100" step="1" value="${Math.round(stop.value * 100)}" />
      <button type="button" class="remove-stop" title="Remove">×</button>
    `;
    const [posInp, valInp] = row.querySelectorAll('input[type="number"]') as NodeListOf<HTMLInputElement>;
    const removeBtn = row.querySelector(".remove-stop") as HTMLButtonElement;

    posInp.addEventListener("input", () => {
      const v = parseFloat(posInp.value);
      if (isFinite(v)) {
        stop.pos = Math.max(0, Math.min(1, v / 100));
        sortAndRebuildStrengthRows();
      }
    });
    posInp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const cur = parseFloat(posInp.value) || 0;
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const next = Math.max(0, Math.min(100, cur + step * dir));
      posInp.value = String(next);
      stop.pos = next / 100;
      sortAndRebuildStrengthRows();
    });

    valInp.addEventListener("input", () => {
      const v = parseFloat(valInp.value);
      if (isFinite(v)) {
        stop.value = Math.max(0, Math.min(1, v / 100));
        rebuildStrengthMask();
      }
    });
    valInp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const cur = parseFloat(valInp.value) || 0;
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const next = Math.max(0, Math.min(100, cur + step * dir));
      valInp.value = String(next);
      stop.value = next / 100;
      rebuildStrengthMask();
    });

    removeBtn.addEventListener("click", () => {
      if (strengthStops.length <= 2) return;
      strengthStops = strengthStops.filter((s) => s !== stop);
      buildStrengthRows();
      rebuildStrengthMask();
    });
    strengthStopsEl.appendChild(row);
  }
}

addStrengthStopBtn.addEventListener("click", () => {
  const sorted = [...strengthStops].sort((a, b) => a.pos - b.pos);
  const last = sorted[sorted.length - 1];
  const prev = sorted[sorted.length - 2];
  const newPos = prev ? (prev.pos + last.pos) / 2 : 0.5;
  strengthStops.push({ pos: newPos, value: 1 });
  buildStrengthRows();
  rebuildStrengthMask();
});

strengthToggle.checked = params.strengthMaskOn;
strengthToggle.addEventListener("change", () => {
  params.strengthMaskOn = strengthToggle.checked;
  schedule();
});

buildStrengthRows();
rebuildStrengthMask();

schedule();

// ---- Copy / paste settings ----
const copySettingsBtn = document.getElementById("copySettingsBtn") as HTMLButtonElement;
const pasteSettingsBtn = document.getElementById("pasteSettingsBtn") as HTMLButtonElement;

function applyParamsString(str: string): boolean {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(str.trim());
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object") return false;

  for (const def of sliderDefs) {
    const v = obj[def.key];
    if (typeof v === "number" && isFinite(v)) {
      const clamped = Math.min(def.max, Math.max(def.min, v));
      params[def.key] = clamped;
      const inp = sliderInputs[def.key];
      const val = sliderValEls[def.key];
      if (inp) inp.value = String(clamped);
      if (val) val.textContent = def.format ? def.format(clamped) : String(clamped);
    }
  }
  if (typeof obj.alternate === "boolean") {
    params.alternate = obj.alternate;
    if (alternateInput) alternateInput.checked = obj.alternate;
  }
  if (typeof obj.gradientOn === "boolean") {
    params.gradientOn = obj.gradientOn;
    gradientToggle.checked = obj.gradientOn;
  }
  if (typeof obj.strengthMaskOn === "boolean") {
    params.strengthMaskOn = obj.strengthMaskOn;
    strengthToggle.checked = obj.strengthMaskOn;
  }
  if (Array.isArray(obj.strengthStops)) {
    const valid: StrengthStop[] = [];
    for (const raw of obj.strengthStops) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as { pos?: unknown; value?: unknown };
      if (typeof r.pos !== "number" || typeof r.value !== "number") continue;
      valid.push({
        pos: Math.max(0, Math.min(1, r.pos)),
        value: Math.max(0, Math.min(1, r.value)),
      });
    }
    if (valid.length >= 2) {
      strengthStops = valid;
      buildStrengthRows();
      rebuildStrengthMask();
    }
  }
  if (Array.isArray(obj.gradientStops)) {
    const valid: Stop[] = [];
    for (const raw of obj.gradientStops) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as { pos?: unknown; color?: unknown };
      if (typeof r.pos !== "number" || typeof r.color !== "string") continue;
      const norm = normalizeHex(r.color);
      if (!norm) continue;
      valid.push({ pos: Math.max(0, Math.min(1, r.pos)), color: norm });
    }
    if (valid.length >= 2) {
      gradientStops = valid;
      buildStopRows();
      rebuildGradient();
    }
  }
  schedule();
  return true;
}

async function flashButton(btn: HTMLButtonElement, msg: string, ms = 900) {
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, ms);
}

copySettingsBtn.addEventListener("click", async () => {
  const str = JSON.stringify({ ...params, gradientStops, strengthStops });
  try {
    await navigator.clipboard.writeText(str);
    flashButton(copySettingsBtn, "Copied!");
  } catch {
    // Clipboard API can be blocked; fall back to prompt
    prompt("Copy settings:", str);
  }
});

pasteSettingsBtn.addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    text = prompt("Paste settings string:") ?? "";
  }
  if (!text) return;
  if (applyParamsString(text)) {
    flashButton(pasteSettingsBtn, "Applied!");
  } else {
    flashButton(pasteSettingsBtn, "Invalid", 1500);
  }
});
