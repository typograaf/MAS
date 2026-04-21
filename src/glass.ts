const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Flip Y here instead of relying on UNPACK_FLIP_Y_WEBGL — Safari's
  // ImageBitmap path doesn't honor it reliably. v_uv.y = 0 at canvas top.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_imageSize;
uniform vec2 u_canvasSize;
uniform float u_slatWidth;
uniform float u_strength;
uniform float u_offset;
uniform float u_curvature;
uniform float u_yCurve;
uniform float u_zoom;
uniform float u_frost;
uniform float u_alternate;
uniform sampler2D u_gradient;
uniform float u_gradientOn;
uniform float u_lumMin;
uniform float u_lumMax;
uniform sampler2D u_strengthMask;
uniform float u_strengthMaskOn;

varying vec2 v_uv;

const float PI = 3.14159265359;

// "cover" fit — source fills the canvas, axis with excess gets cropped.
vec2 fitUV(vec2 cuv) {
  float canvasAR = u_canvasSize.x / u_canvasSize.y;
  float imageAR = u_imageSize.x / u_imageSize.y;
  vec2 uv = cuv;
  if (canvasAR > imageAR) {
    // canvas wider than image -> crop top/bottom
    float scale = imageAR / canvasAR;
    uv.y = (cuv.y - 0.5) * scale + 0.5;
  } else {
    // canvas taller than image -> crop left/right
    float scale = canvasAR / imageAR;
    uv.x = (cuv.x - 0.5) * scale + 0.5;
  }
  return uv;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec3 sampleSource(vec2 uv, float frost) {
  if (frost < 0.002) {
    return texture2D(u_image, clamp(uv, 0.0, 1.0)).rgb;
  }
  vec3 sum = vec3(0.0);
  float radius = frost * 0.025;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = hash(uv * 13.7 + fi) * 6.2831;
    float r = sqrt(hash(uv * 7.3 + fi * 2.1)) * radius;
    vec2 off = vec2(cos(a), sin(a)) * r;
    sum += texture2D(u_image, clamp(uv + off, 0.0, 1.0)).rgb;
  }
  return sum / 12.0;
}

void main() {
  vec2 px = v_uv * u_canvasSize;

  // Per-pixel effect strength multiplier — horizontal grayscale mask
  float mul = 1.0;
  if (u_strengthMaskOn > 0.5) {
    mul = texture2D(u_strengthMask, vec2(v_uv.x, 0.5)).r;
  }
  float effStrength  = u_strength  * mul;
  float effCurvature = u_curvature * mul;
  float effYCurve    = u_yCurve    * mul;
  float effFrost     = u_frost     * mul;

  float sw = max(u_slatWidth, 1.0);
  float yMix = clamp(effYCurve, 0.0, 1.0);

  float slatPosX = (px.x + u_offset) / sw;
  float idxX = floor(slatPosX);
  float localX = fract(slatPosX) - 0.5;
  float localY = v_uv.y - 0.5;

  float halfFov = clamp(effCurvature, 0.05, 2.0) * PI * 0.5;
  float angleX = localX * 2.0 * halfFov;
  float angleY = localY * 2.0 * halfFov;
  float dir = (u_alternate > 0.5 && mod(idxX, 2.0) >= 1.0) ? -1.0 : 1.0;
  float sinHalf = max(sin(halfFov), 0.01);

  float refractPx = sin(angleX) / sinHalf * effStrength * sw * dir;

  float yShape = (u_alternate > 0.5) ? sin(slatPosX * PI) : cos(angleX);
  float refractPy = -sin(angleY) * yShape / sinHalf
                    * u_canvasSize.y * 0.15 * yMix;

  // refracted UV in canvas space
  vec2 cuv = vec2(
    (px.x + refractPx) / u_canvasSize.x,
    (px.y + refractPy) / u_canvasSize.y
  );
  vec2 iuv = fitUV(cuv);

  // Zoom: scale UV around image center (>1 zooms in, <1 zooms out)
  float z = max(u_zoom, 0.05);
  iuv = (iuv - 0.5) / z + 0.5;
  iuv = clamp(iuv, 0.0, 1.0);

  vec3 col = sampleSource(iuv, effFrost);

  if (u_gradientOn > 0.5) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    // Stretch the image's actual luminance range to fill 0..1
    float range = max(u_lumMax - u_lumMin, 0.001);
    lum = clamp((lum - u_lumMin) / range, 0.0, 1.0);
    vec4 g = texture2D(u_gradient, vec2(lum, 0.5));
    col = mix(col, g.rgb, g.a);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface GlassParams {
  slatWidth: number;
  strength: number;
  offset: number;
  curvature: number;
  yCurve: number;
  zoom: number;
  frost: number;
  alternate: boolean;
  gradientOn: boolean;
  lumMin: number;
  lumMax: number;
  strengthMaskOn: boolean;
}

type Source = HTMLImageElement | HTMLVideoElement | ImageBitmap;

export class GlassRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private source: Source | null = null;
  private imageSize: [number, number] = [1, 1];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private gradientTex: WebGLTexture | null = null;
  private strengthMaskTex: WebGLTexture | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const attrs: WebGLContextAttributes & { colorSpace?: string } = {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      colorSpace: "display-p3",
    };
    const gl = canvas.getContext("webgl", attrs);
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;
    // Prefer P3 output buffer if the browser supports the attribute
    try {
      const glAny = gl as unknown as { drawingBufferColorSpace?: string };
      if ("drawingBufferColorSpace" in glAny) glAny.drawingBufferColorSpace = "display-p3";
    } catch {}
    this.program = this.buildProgram();
    this.setupGeometry();
    this.cacheUniforms();
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
    const compile = (src: string, type: number) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("Shader compile: " + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(VERT, gl.VERTEX_SHADER));
    gl.attachShader(prog, compile(FRAG, gl.FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("Program link: " + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    return prog;
  }

  private setupGeometry() {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    const loc = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private cacheUniforms() {
    const gl = this.gl;
    for (const name of [
      "u_image",
      "u_imageSize",
      "u_canvasSize",
      "u_slatWidth",
      "u_strength",
      "u_offset",
      "u_curvature",
      "u_yCurve",
      "u_zoom",
      "u_frost",
      "u_alternate",
      "u_gradient",
      "u_gradientOn",
      "u_lumMin",
      "u_lumMax",
      "u_strengthMask",
      "u_strengthMaskOn",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }

  setSource(source: Source) {
    const gl = this.gl;
    this.source = source;
    if (this.texture) gl.deleteTexture(this.texture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.texture = tex;
    let w: number, h: number;
    if (source instanceof HTMLVideoElement) { w = source.videoWidth; h = source.videoHeight; }
    else if (source instanceof HTMLImageElement) { w = source.naturalWidth; h = source.naturalHeight; }
    else { w = source.width; h = source.height; }
    this.imageSize = [w, h];
    this.uploadFrame();
    this.applyFormat();
  }

  private uploadFrame() {
    if (!this.source || !this.texture) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
  }

  setGradient(canvas: HTMLCanvasElement) {
    const gl = this.gl;
    if (!this.gradientTex) this.gradientTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.gradientTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  setStrengthMask(canvas: HTMLCanvasElement) {
    const gl = this.gl;
    if (!this.strengthMaskTex) this.strengthMaskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.strengthMaskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  private outputSize: { w: number; h: number } | null = null;

  setOutputSize(size: { w: number; h: number } | null) {
    this.outputSize = size;
    this.applyFormat();
  }

  private applyFormat() {
    if (this.outputSize) {
      this.canvas.width = this.outputSize.w;
      this.canvas.height = this.outputSize.h;
    } else {
      this.canvas.width = this.imageSize[0];
      this.canvas.height = this.imageSize[1];
    }
  }

  render(params: GlassParams) {
    const gl = this.gl;
    if (!this.texture || !this.source) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    if (this.source instanceof HTMLVideoElement && this.source.readyState >= 2) {
      this.uploadFrame();
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.u_image!, 0);
    gl.uniform2f(this.uniforms.u_imageSize!, this.imageSize[0], this.imageSize[1]);
    gl.uniform2f(this.uniforms.u_canvasSize!, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.u_slatWidth!, params.slatWidth);
    gl.uniform1f(this.uniforms.u_strength!, params.strength);
    gl.uniform1f(this.uniforms.u_offset!, params.offset);
    gl.uniform1f(this.uniforms.u_curvature!, params.curvature);
    gl.uniform1f(this.uniforms.u_yCurve!, params.yCurve);
    gl.uniform1f(this.uniforms.u_zoom!, params.zoom);
    gl.uniform1f(this.uniforms.u_frost!, params.frost);
    gl.uniform1f(this.uniforms.u_alternate!, params.alternate ? 1 : 0);

    if (this.gradientTex && params.gradientOn) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.gradientTex);
      gl.uniform1i(this.uniforms.u_gradient!, 1);
      gl.uniform1f(this.uniforms.u_gradientOn!, 1);
    } else {
      gl.uniform1f(this.uniforms.u_gradientOn!, 0);
    }
    gl.uniform1f(this.uniforms.u_lumMin!, params.lumMin);
    gl.uniform1f(this.uniforms.u_lumMax!, params.lumMax);

    if (this.strengthMaskTex && params.strengthMaskOn) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.strengthMaskTex);
      gl.uniform1i(this.uniforms.u_strengthMask!, 2);
      gl.uniform1f(this.uniforms.u_strengthMaskOn!, 1);
    } else {
      gl.uniform1f(this.uniforms.u_strengthMaskOn!, 0);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
