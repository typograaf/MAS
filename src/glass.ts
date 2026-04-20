const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_imageSize;
uniform vec2 u_canvasSize;
uniform float u_slatWidth;     // pixels per slat
uniform float u_strength;      // refraction offset, fraction of slat width
uniform float u_offset;        // horizontal phase, pixels
uniform float u_edgeSoft;      // 0..1 — softens slat seam
uniform float u_alternate;     // 0 or 1 — flip every other slat

varying vec2 v_uv;

const float PI = 3.14159265359;

void main() {
  // pixel-space coordinates
  vec2 px = v_uv * u_canvasSize;

  float sw = max(u_slatWidth, 1.0);
  float slatPos = (px.x + u_offset) / sw;
  float idx = floor(slatPos);
  float local = fract(slatPos) - 0.5;        // -0.5 .. 0.5

  // Half-cylinder lens: refraction offset is ~ sin(angle).
  // local maps to angle in (-pi/2, pi/2). Surface normal slope -> sin(angle).
  float angle = local * PI;
  float dir = (u_alternate > 0.5 && mod(idx, 2.0) >= 1.0) ? -1.0 : 1.0;
  float refractPx = sin(angle) * u_strength * sw * dir;

  // sample
  vec2 sampleUV = vec2((px.x + refractPx) / u_canvasSize.x, v_uv.y);

  // map canvas-uv (0..1) to image-uv with "contain" fit
  float canvasAR = u_canvasSize.x / u_canvasSize.y;
  float imageAR = u_imageSize.x / u_imageSize.y;
  vec2 imgUV = sampleUV;
  if (canvasAR > imageAR) {
    // canvas wider than image -> letterbox left/right
    float scale = imageAR / canvasAR;
    imgUV.x = (sampleUV.x - 0.5) / scale + 0.5;
  } else {
    float scale = canvasAR / imageAR;
    imgUV.y = (sampleUV.y - 0.5) / scale + 0.5;
  }

  // outside image -> transparent
  if (imgUV.x < 0.0 || imgUV.x > 1.0 || imgUV.y < 0.0 || imgUV.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec4 col = texture2D(u_image, imgUV);

  // subtle dark seam at slat boundary
  float seam = abs(local) * 2.0;          // 0 center, 1 edges
  float seamMask = smoothstep(1.0 - u_edgeSoft, 1.0, seam);
  col.rgb *= 1.0 - seamMask * 0.25;

  gl_FragColor = col;
}
`;

export interface GlassParams {
  slatWidth: number;
  strength: number;
  offset: number;
  edgeSoft: number;
  alternate: boolean;
}

export class GlassRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture | null = null;
  private imageSize: [number, number] = [1, 1];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;
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
      "u_edgeSoft",
      "u_alternate",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }

  setImage(img: HTMLImageElement) {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.texture = tex;
    this.imageSize = [img.naturalWidth, img.naturalHeight];

    // resize canvas to match image (capped to viewport later by CSS)
    this.canvas.width = img.naturalWidth;
    this.canvas.height = img.naturalHeight;
  }

  resizeToImage() {
    if (!this.texture) return;
    this.canvas.width = this.imageSize[0];
    this.canvas.height = this.imageSize[1];
  }

  render(params: GlassParams) {
    const gl = this.gl;
    if (!this.texture) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
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
    gl.uniform1f(this.uniforms.u_edgeSoft!, params.edgeSoft);
    gl.uniform1f(this.uniforms.u_alternate!, params.alternate ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
