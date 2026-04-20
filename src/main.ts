import "./style.css";
import { GlassRenderer, type GlassParams } from "./glass";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

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

const renderer = new GlassRenderer(canvas);

const params: GlassParams = {
  slatWidth: 60,
  strength: 0.6,
  offset: 0,
  curvature: 1.0,
  yCurve: 0.0,
  zoom: 1.0,
  frost: 0.0,
  alternate: true,
};

type SliderDef = {
  key: keyof Omit<GlassParams, "alternate">;
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
  { key: "zoom", label: "Zoom", min: 0.5, max: 5, step: 0.01, format: (v) => `${(v * 100).toFixed(0)}%` },
  { key: "frost", label: "Frost", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
];

const sliderInputs: Partial<Record<keyof GlassParams, HTMLInputElement>> = {};
const sliderValEls: Partial<Record<keyof GlassParams, HTMLSpanElement>> = {};

function buildSliders() {
  for (const def of sliderDefs) {
    const wrap = document.createElement("div");
    wrap.className = "slider";
    wrap.innerHTML = `
      <div class="row">
        <label>${def.label}</label>
        <span class="val"></span>
      </div>
      <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" value="${params[def.key]}" />
    `;
    const input = wrap.querySelector("input") as HTMLInputElement;
    const val = wrap.querySelector(".val") as HTMLSpanElement;
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
    slidersEl.appendChild(wrap);
  }

  const altWrap = document.createElement("div");
  altWrap.className = "slider";
  altWrap.innerHTML = `
    <div class="row">
      <label>Alternate slats</label>
    </div>
    <input type="checkbox" />
  `;
  const altInput = altWrap.querySelector("input") as HTMLInputElement;
  altInput.checked = params.alternate;
  altInput.addEventListener("change", () => {
    params.alternate = altInput.checked;
    schedule();
  });
  slidersEl.appendChild(altWrap);
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

const updateSpeedLabel = () => {
  speedPxPerSec = parseFloat(speedSlider.value);
  speedVal.textContent = `${speedPxPerSec.toFixed(0)} px/s`;
};
speedSlider.addEventListener("input", updateSpeedLabel);
updateSpeedLabel();

formatSelect.addEventListener("change", () => {
  const raw = formatSelect.value;
  renderer.setOutputAspect(raw === "" ? null : parseFloat(raw));
  schedule();
});

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
      canvas.classList.add("has-image");
      exportBtn.disabled = false;
      playBtn.disabled = false;
      schedule();
    }).catch(() => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        renderer.setSource(img);
        canvas.classList.add("has-image");
        exportBtn.disabled = false;
        playBtn.disabled = false;
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
      canvas.classList.add("has-image");
      exportBtn.disabled = false;
      playBtn.disabled = false;
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
  renderer.render(params);
  canvas.toBlob((blob) => {
    if (blob) downloadBlob(blob, "mas-overlay.png");
  }, "image/png");
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
  // Cap to chosen resolution and align to multiples of 16 — most H.264 encoders
  // fail silently on non-16-aligned dimensions or sizes above their hw limit.
  const MAX_DIM = parseInt(exportResSelect.value, 10) || 1920;
  const sourceMax = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, MAX_DIM / sourceMax);
  const outW = Math.max(16, Math.floor(canvas.width * scale / 16) * 16);
  const outH = Math.max(16, Math.floor(canvas.height * scale / 16) * 16);
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

  const recorder = new MediaRecorder(stream, { mimeType: fmt.mime });
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

  // Restore previous play state
  if (currentVideo && !wasPlaying) currentVideo.pause();
  if (wasPlaying) setPlaying(true);
  document.body.removeChild(mirrorCanvas);

  const outMime = fmt.container === "mov" ? "video/quicktime" : fmt.mime;
  const blob = new Blob(chunks, { type: outMime });
  console.log("[export] final blob bytes:", blob.size, "chunks:", chunks.length);
  downloadBlob(blob, `mas-loop.${fmt.ext}`);

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
  return "avc1.640033";                                 // High 5.1 — 4K60
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

  const MAX_DIM = parseInt(exportResSelect.value, 10) || 1920;
  const sourceMax = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, MAX_DIM / sourceMax);
  const outW = Math.max(16, Math.floor(canvas.width * scale / 16) * 16);
  const outH = Math.max(16, Math.floor(canvas.height * scale / 16) * 16);

  const mirror = document.createElement("canvas");
  mirror.width = outW;
  mirror.height = outH;
  const ctx = mirror.getContext("2d");
  if (!ctx) return;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: outW, height: outH, frameRate: FPS },
    fastStart: "in-memory",
  });

  let encoderErrored = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { console.error("[encoder]", e); encoderErrored = true; },
  });

  encoder.configure({
    codec: pickH264Codec(outW, outH),
    width: outW,
    height: outH,
    framerate: FPS,
    bitrate: Math.round(outW * outH * FPS * 0.1),  // ~0.1 bits/pixel/frame
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
      encoder.encode(frame, { keyFrame: i === 0 || i % (FPS * 2) === 0 });
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
    downloadBlob(blob, `mas-loop.${fmt.ext}`);
  } catch (err) {
    console.error("[export] failed", err);
    alert("Export failed. Try a lower resolution or check the console.");
  } finally {
    params.offset = originalOffset;
    setOffsetUI(originalOffset);
    renderer.render(params);
    if (wasPlaying) setPlaying(true);
    exportBtn.disabled = false;
    exportBtn.textContent = "Export";
  }
}

exportBtn.addEventListener("click", async () => {
  const fmtId = exportFormatSelect.value;
  const fmt = exportFormats.find((f) => f.id === fmtId);
  if (!fmt) return;
  if (fmt.id === "png") return exportPng();
  // Offline WebCodecs path: guarantees 60fps at any resolution
  if (supportsWebCodecs() && fmt.container !== "webm") {
    return exportViaWebCodecs(fmt);
  }
  await exportLoop(fmt);
});

buildSliders();
schedule();
