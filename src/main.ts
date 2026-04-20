import "./style.css";
import { GlassRenderer, type GlassParams } from "./glass";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const dropZone = document.getElementById("dropZone") as HTMLDivElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const slidersEl = document.getElementById("sliders") as HTMLDivElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;

const renderer = new GlassRenderer(canvas);

const params: GlassParams = {
  slatWidth: 60,
  strength: 0.5,
  offset: 0,
  edgeSoft: 0.2,
  alternate: false,
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
  { key: "offset", label: "Offset", min: -300, max: 300, step: 1, format: (v) => `${v.toFixed(0)}px` },
  { key: "edgeSoft", label: "Edge softness", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
];

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
      <span class="val"></span>
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
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    renderer.render(params);
  });
}

function loadFile(file: File) {
  if (!file.type.startsWith("image/")) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    renderer.setImage(img);
    canvas.classList.add("has-image");
    exportBtn.disabled = false;
    URL.revokeObjectURL(url);
    schedule();
  };
  img.src = url;
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

// drop anywhere on the page too
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

exportBtn.addEventListener("click", () => {
  renderer.render(params); // ensure latest frame
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mas-overlay.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
});

buildSliders();
schedule();
