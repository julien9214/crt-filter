(() => {
  'use strict';

  // ── Default settings ──────────────────────────────────────────────
  // All sliders are 0-100. `mask` is a type (0 aperture grille, 1 slot mask,
  // 2 shadow mask) and `lines` is the simulated line count (0 = auto).
  const DEFAULTS = {
    scanlines: 35, phosphor: 30, mask: 0, lines: 0, interlace: 0,
    curvature: 15, persistence: 15,
    chromatic: 10, colorbleed: 20, sharpness: 60,
    bloom: 25, glow: 20, colortemp: 20,
    noise: 5, flicker: 5,
  };

  let settings = { ...DEFAULTS };
  let filterEnabled = false;  // disabled by default, per-site opt-in
  const siteDomain = location.hostname;
  let crtMode = null;           // 'full' | 'overlay'
  let video = null;
  let canvas = null;
  let gl = null;
  let progs = null;             // compiled shader programs
  let targets = {};             // render targets for the full pipeline
  let hdrFormat = null;         // internal format for linear-light targets
  let videoTexture = null;
  let quadVAO = null;
  let quadVBO = null;
  let animFrameId = null;
  let startTime = 0;
  let lastTime = 0;
  let frameCount = 0;
  let newVideoFrame = true;
  let drmChecked = false;
  let drmCache = {};            // domain → 'full' | 'overlay'
  let resizeObserver = null;

  const LOG_PREFIX = 'CRT:';
  function log(...args) { console.log(LOG_PREFIX, ...args); }

  log('Content script loaded on', location.href);

  // ── Shaders ───────────────────────────────────────────────────────
  //
  // The full pipeline models the physical chain of a CRT TV:
  //
  //   SIGNAL     composite video: resample to N lines, band-limit luma and
  //              chroma (YIQ), sharpness peaking, RF snow, sync jitter.
  //   BEAM       one gaussian electron spot per scanline per gun, in linear
  //              light. Spot width grows with brightness (bright lines bloom
  //              into each other, dark lines show gaps). Misconvergence,
  //              interlaced fields, and phosphor persistence via feedback.
  //   GLOW       blur pyramid of the beam image: bloom + glass halation.
  //   COMPOSITE  phosphor mask at native display pixels, light diffusion,
  //              P22 phosphor primaries, white point, hum bar, rounded
  //              screen edge with bezel reflection, gamma encode + dither.
  //
  // Overlay mode (DRM video, no pixel access) can only darken the page, so it
  // draws a black alpha mask approximating scanlines, mask and screen edge.

  const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const COMMON = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(float x) {
  float i = floor(x), f = fract(x);
  return mix(hash12(vec2(i, 7.1)), hash12(vec2(i + 1.0, 7.1)), f * f * (3.0 - 2.0 * f));
}

// Screen-space position -> picture position on a curved faceplate.
// Edge midpoints stay put; corners are pulled in, so the picture bulges.
vec2 warp(vec2 p, float curv, float aspect) {
  vec2 c = p * 2.0 - 1.0;
  float k = curv * 0.09;
  c.x *= 1.0 + k * c.y * c.y;
  c.y *= 1.0 + k * aspect * c.x * c.x;
  return c * 0.5 + 0.5;
}

// Signed distance to the rounded-rectangle screen edge (<0 inside),
// in units of half the screen height.
float screenEdge(vec2 uv, float curv, float aspect) {
  vec2 hs = vec2(aspect, 1.0);
  vec2 q = abs(uv * 2.0 - 1.0) * hs;
  float r = 0.04 + curv * 0.14;
  vec2 d = q - (hs - r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
`;

  const SIGNAL_SRC = COMMON + `
uniform sampler2D u_src;
uniform vec4 u_srcRect;    // picture rect inside the screen (x, y, w, h), top-down
uniform vec2 u_sigSize;    // (samples per line, lines)
uniform float u_frame;
uniform float u_time;
uniform float u_sharp;
uniform float u_bleed;
uniform float u_noise;

const mat3 RGB2YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);

// Source pixel averaged over the vertical footprint of one scanline.
vec3 fetchYIQ(float sx, float sy, float dy) {
  vec2 uv = (vec2(sx, sy) - u_srcRect.xy) / u_srcRect.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
  vec3 c = texture(u_src, uv + vec2(0.0, -dy)).rgb
         + texture(u_src, uv).rgb
         + texture(u_src, uv + vec2(0.0, dy)).rgb;
  return RGB2YIQ * (c / 3.0);
}

void main() {
  float line = floor(gl_FragCoord.y);          // counted from the bottom
  float x = gl_FragCoord.x;
  float fr = mod(u_frame, 4096.0);

  // Sync instability: per-line horizontal jitter, plus a rolling tracking
  // tear that shoves a band of lines sideways at high noise levels.
  float n2 = u_noise * u_noise;
  x += (hash12(vec2(line, fr)) - 0.5) * n2 * 1.2;
  float band = fract(u_time * 0.05) * (u_sigSize.y + 60.0) - 30.0;
  float tear = max(u_noise - 0.5, 0.0) * 16.0;
  x += tear * smoothstep(10.0, 0.0, abs(line - band)) * (0.6 + 0.4 * hash12(vec2(line, fr + 3.0)));

  float sy = 1.0 - (line + 0.5) / u_sigSize.y;  // top-down source coordinate
  float dy = 0.33 / (u_sigSize.y * u_srcRect.w);

  // Luma bandwidth from sharpness; chroma is far narrower and lags behind.
  float sigY = mix(1.1, 0.4, u_sharp);
  float sigC = mix(sigY * 1.5, 3.0, u_bleed);
  float delay = u_bleed * 0.9;
  float sigW = sigY * 2.5;

  vec3 yiq = vec3(0.0);
  float wy = 0.0, wc = 0.0, yWide = 0.0, ww = 0.0;
  for (int i = -12; i <= 12; i++) {
    float o = float(i) * 0.5;                  // half-sample taps
    vec3 s = fetchYIQ((x + o) / u_sigSize.x, sy, dy);
    float a = exp(-0.5 * o * o / (sigY * sigY));
    float oc = o + delay;
    float b = exp(-0.5 * oc * oc / (sigC * sigC));
    float c = exp(-0.5 * o * o / (sigW * sigW));
    yiq.x += s.x * a; wy += a;
    yiq.yz += s.yz * b; wc += b;
    yWide += s.x * c; ww += c;
  }
  yiq.x /= wy; yiq.yz /= wc; yWide /= ww;

  // Sharpness peaking: overshoot/ringing around edges, like a TV's
  // sharpness control drawing halos around outlines.
  yiq.x += (yiq.x - yWide) * max(u_sharp - 0.35, 0.0) * 1.2;

  // RF snow: horizontally smeared because the signal is scanned serially.
  float sn = hash12(vec2(floor(x * 0.6), line * 1.37 + fr * 17.0)) - 0.5;
  yiq.x += sn * u_noise * 0.25;
  yiq.yz += (vec2(hash12(vec2(x, line + fr)), hash12(vec2(line, x - fr))) - 0.5) * u_noise * 0.08;

  fragColor = vec4(clamp(YIQ2RGB * yiq, 0.0, 1.0), 1.0);
}`;

  const BEAM_SRC = COMMON + `
uniform sampler2D u_sig;
uniform sampler2D u_prev;
uniform vec2 u_sigSize;
uniform float u_aspect;
uniform float u_curv;
uniform float u_conv;
uniform float u_scan;
uniform float u_interlace;
uniform float u_field;
uniform float u_decay;

void main() {
  vec2 uv = warp(v_uv, u_curv, u_aspect);
  vec3 col = vec3(0.0);

  if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    vec2 cc = uv * 2.0 - 1.0;
    float r2 = dot(cc, cc);
    // Misconvergence: a static offset plus an error that grows toward the
    // edges. x is in picture units, y in scanlines.
    vec2 conv = u_conv * vec2(0.0016 * (0.3 + r2), 0.35 * r2 * cc.y);

    float y = uv.y * u_sigSize.y - 0.5;
    float k0 = floor(y);
    // Spot size (sigma, in lines) for dark and bright signal.
    float sMin = mix(0.50, 0.14, u_scan);
    float sMax = mix(0.56, 0.30, u_scan);

    for (int j = 0; j < 2; j++) {
      float k = k0 + float(j);
      float v = (k + 0.5) / u_sigSize.y;
      vec3 s = vec3(texture(u_sig, vec2(uv.x + conv.x, v)).r,
                    texture(u_sig, vec2(uv.x, v)).g,
                    texture(u_sig, vec2(uv.x - conv.x, v)).b);
      vec3 l = pow(s, vec3(2.4));               // CRT gamma -> linear light
      vec3 sig = mix(vec3(sMin), vec3(sMax), sqrt(l));
      vec3 d = vec3(y + conv.y, y, y - conv.y) - k;
      // Normalised gaussian: energy per line is constant, so thin dark
      // lines and fat bright lines keep the same average brightness.
      vec3 w = exp(-0.5 * d * d / (sig * sig)) * (0.3989 / sig);
      float fw = 1.0;
      if (u_interlace > 0.0 && abs(mod(k, 2.0) - u_field) > 0.5) fw = 1.0 - u_interlace * 0.8;
      col += l * w * fw;
    }
    col /= 1.0 - u_interlace * 0.4;
  }

  // Phosphor persistence: the previous frame decays rather than vanishing.
  col = max(col, texture(u_prev, v_uv).rgb * u_decay);
  fragColor = vec4(col, 1.0);
}`;

  // 2x2 bilinear taps = 4x4 box downsample.
  const DOWN_SRC = COMMON + `
uniform sampler2D u_tex;
uniform vec2 u_texel;
void main() {
  vec3 c = texture(u_tex, v_uv + u_texel * vec2(-1.0, -1.0)).rgb
         + texture(u_tex, v_uv + u_texel * vec2( 1.0, -1.0)).rgb
         + texture(u_tex, v_uv + u_texel * vec2(-1.0,  1.0)).rgb
         + texture(u_tex, v_uv + u_texel * vec2( 1.0,  1.0)).rgb;
  fragColor = vec4(c * 0.25, 1.0);
}`;

  const BLUR_SRC = COMMON + `
uniform sampler2D u_tex;
uniform vec2 u_step;
void main() {
  vec3 c = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float f = float(i);
    float w = exp(-f * f / 12.5);
    c += texture(u_tex, v_uv + u_step * f).rgb * w;
    wsum += w;
  }
  fragColor = vec4(c / wsum, 1.0);
}`;

  const MASK_GLSL = `
uniform float u_mask;
uniform float u_maskType;
uniform float u_maskPx;

// Phosphor layout at native display pixels. Returns per-channel transmission.
vec3 maskPattern(vec2 fc) {
  float lo = 1.0 - u_mask;
  vec2 c = floor(fc / u_maskPx);
  float idx;
  if (u_maskType < 0.5) {
    // Aperture grille: continuous vertical stripes.
    idx = mod(c.x, 3.0);
  } else if (u_maskType < 1.5) {
    // Slot mask: stripes broken into slots, staggered per triad column.
    idx = mod(c.x, 3.0);
    float row = mod(c.y + mod(floor(c.x / 3.0), 2.0) * 2.0, 4.0);
    if (row > 2.5) return vec3(lo);
  } else {
    // Shadow mask: 2x2 phosphor dots, alternate rows offset by half a triad.
    float row = mod(floor(c.y / 2.0), 2.0);
    idx = mod(floor((c.x + row * 3.0) / 2.0), 3.0);
  }
  vec3 m = vec3(lo);
  if (idx < 0.5) m.r = 1.0; else if (idx < 1.5) m.g = 1.0; else m.b = 1.0;
  return m;
}

float maskMean() {
  float lo = 1.0 - u_mask;
  float stripe = (1.0 + 2.0 * lo) / 3.0;
  return u_maskType > 0.5 && u_maskType < 1.5 ? stripe * 0.75 + lo * 0.25 : stripe;
}
`;

  const COMPOSITE_SRC = COMMON + MASK_GLSL + `
uniform sampler2D u_beam;
uniform sampler2D u_bloomTex;
uniform sampler2D u_haloTex;
uniform vec2 u_outSize;
uniform float u_aspect;
uniform float u_curv;
uniform float u_bloom;
uniform float u_glow;
uniform float u_flicker;
uniform float u_temp;
uniform float u_time;

// SMPTE-C (close to P22 phosphors) -> Rec.709 primaries, linear light.
const mat3 P22_TO_709 = mat3(
   0.9395, 0.0178, -0.0016,
   0.0502, 0.9658, -0.0044,
   0.0103, 0.0164,  1.0060);

vec2 mirror01(vec2 u) {
  return 1.0 - abs(1.0 - abs(u));
}

void main() {
  vec2 p = v_uv;
  vec2 uv = warp(p, u_curv, u_aspect);

  vec3 beam = texture(u_beam, p).rgb;
  vec3 bloom = texture(u_bloomTex, p).rgb;
  vec3 halo = texture(u_haloTex, p).rgb;

  // Phosphor mask, partly compensated: a real tube was driven harder to
  // make up for the light the mask blocks.
  vec3 col = beam;
  if (u_mask > 0.0) col *= maskPattern(gl_FragCoord.xy) / mix(1.0, maskMean(), 0.8);

  // Diffusion in the glass: some light is scattered sideways (energy is
  // moved, not created), plus a soft additive glow around highlights.
  float aB = u_bloom * 0.30;
  float aH = u_glow * 0.25;
  col = col * (1.0 - aB - aH) + bloom * aB + halo * aH;
  col += bloom * bloom * u_bloom * 0.25;

  // Gentle brightness falloff toward the edges of the tube.
  vec2 vv = uv * (1.0 - uv);
  col *= pow(clamp(vv.x * vv.y * 16.0, 0.0, 1.0), 0.1 + u_curv * 0.15);

  // Mains interference: a slow rolling hum bar and brightness wobble.
  float hum = pow(0.5 + 0.5 * sin(6.2832 * (uv.y * 0.6 - u_time * 0.09)), 4.0);
  col *= (1.0 - u_flicker * 0.08 * hum) * (1.0 + u_flicker * 0.05 * (vnoise(u_time * 11.0) - 0.5));

  // Phosphor primaries and white point (0 = D65, 1 = ~9300K like Japanese sets).
  col = P22_TO_709 * col;
  col *= mix(vec3(1.0), vec3(0.88, 1.0, 1.17), u_temp);

  // Glass is never truly black: a little ambient light reflects off it.
  col += vec3(0.0008, 0.0009, 0.001) * (0.5 + u_glow);

  // Screen edge, with the tube's glow reflected on the inner bezel.
  float sd = screenEdge(uv, u_curv, u_aspect);
  float px = 2.0 / u_outSize.y;
  float inside = smoothstep(px, -px, sd);
  vec2 pr = p + (mirror01(uv) - uv);
  vec3 refl = (texture(u_haloTex, pr).rgb * 0.6 + texture(u_bloomTex, pr).rgb * 0.4) * exp(-max(sd, 0.0) * 25.0) * (0.08 + u_glow * 0.25);
  col = mix(refl, col, inside);

  // Light from a saturated phosphor spills over into its neighbours.
  vec3 over = max(col - 1.0, 0.0);
  col = min(col, 1.0) + (over.r + over.g + over.b) * 0.33;

  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy + fract(u_time) * 97.0) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

  const OVERLAY_SRC = COMMON + MASK_GLSL + `
uniform vec2 u_outSize;
uniform float u_lines;
uniform float u_aspect;
uniform float u_curv;
uniform float u_scan;
uniform float u_interlace;
uniform float u_field;
uniform float u_noise;
uniform float u_flicker;
uniform float u_frame;
uniform float u_time;

void main() {
  vec2 uv = v_uv;

  // Fixed-width beam profile (no pixel access, so it can't follow brightness).
  float y = uv.y * u_lines - 0.5;
  float f = fract(y);
  float s = mix(0.5, 0.22, u_scan);
  float prof = exp(-0.5 * f * f / (s * s)) + exp(-0.5 * (1.0 - f) * (1.0 - f) / (s * s));
  prof /= 1.0 + exp(-0.5 / (s * s));
  float b = mix(1.0, prof, u_scan * 0.7);

  if (u_interlace > 0.0 && abs(mod(floor(y + 0.5), 2.0) - u_field) > 0.5) b *= 1.0 - u_interlace * 0.4;
  if (u_mask > 0.0) {
    vec3 m = maskPattern(gl_FragCoord.xy);
    b *= mix(1.0, (m.r + m.g + m.b) / 3.0, 0.5);
  }

  vec2 vv = uv * (1.0 - uv);
  b *= pow(clamp(vv.x * vv.y * 16.0, 0.0, 1.0), 0.12 + u_curv * 0.25);

  float hum = pow(0.5 + 0.5 * sin(6.2832 * (uv.y * 0.6 - u_time * 0.09)), 4.0);
  b *= (1.0 - u_flicker * 0.08 * hum) * (1.0 + u_flicker * 0.05 * (vnoise(u_time * 11.0) - 0.5));

  b -= hash12(vec2(floor(gl_FragCoord.x * 0.5), floor(y) + mod(u_frame, 4096.0) * 13.0)) * u_noise * 0.15;

  float alpha = clamp(1.0 - b, 0.0, 0.6);
  float sd = screenEdge(uv, u_curv, u_aspect);
  alpha = max(alpha, smoothstep(-2.0 / u_outSize.y, 2.0 / u_outSize.y, sd));
  fragColor = vec4(0.0, 0.0, 0.0, alpha);
}`;

  // ── WebGL helpers ─────────────────────────────────────────────────
  function compileShader(src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('CRT shader compile error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function createProgram(fragSrc) {
    const vs = compileShader(VERT_SRC, gl.VERTEX_SHADER);
    const fs = compileShader(fragSrc, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('CRT program link error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }

    // Uniform setter cache: p.set('u_x', a, b) picks uniform1f/2f/... by arity.
    const locs = {};
    const fns = [null, gl.uniform1f, gl.uniform2f, gl.uniform3f, gl.uniform4f];
    return {
      prog,
      use() { gl.useProgram(prog); return this; },
      set(name, ...v) {
        if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name);
        if (locs[name]) fns[v.length].call(gl, locs[name], ...v);
        return this;
      },
      tex(name, unit, texture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name);
        if (locs[name]) gl.uniform1i(locs[name], unit);
        return this;
      },
    };
  }

  function createPrograms() {
    const p = {
      signal: createProgram(SIGNAL_SRC),
      beam: createProgram(BEAM_SRC),
      down: createProgram(DOWN_SRC),
      blur: createProgram(BLUR_SRC),
      composite: createProgram(COMPOSITE_SRC),
      overlay: createProgram(OVERLAY_SRC),
    };
    return Object.values(p).every(Boolean) ? p : null;
  }

  function setupGeometry() {
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);

    quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  function makeTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  // Render target, (re)allocated only when its size changes.
  function target(name, w, h, hdr) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    let t = targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (!t) {
      t = targets[name] = { tex: makeTexture(), fb: gl.createFramebuffer(), w: 0, h: 0 };
    }
    t.w = w;
    t.h = h;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (hdr && hdrFormat === gl.RGBA16F) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return t;
  }

  function deleteTargets() {
    for (const t of Object.values(targets)) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    targets = {};
  }

  function drawTo(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    if (t) gl.viewport(0, 0, t.w, t.h);
    else gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── DRM detection ─────────────────────────────────────────────────
  function detectDRM(callback, retryCount) {
    retryCount = retryCount || 0;
    const domain = location.hostname;
    if (drmCache[domain]) {
      callback(drmCache[domain]);
      return;
    }

    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);

      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, videoTexture, 0);

      // Check framebuffer completeness
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
        if (video.videoWidth > 0 && video.readyState >= 2) {
          log('DRM detected (framebuffer incomplete on loaded video), using overlay mode');
          drmCache[domain] = 'overlay';
          chrome.storage.local.set({ drmCache });
        } else {
          log('Video not ready yet, using overlay mode temporarily');
        }
        callback('overlay');
        return;
      }

      // Read a region from the center
      const tw = video.videoWidth || 64;
      const th = video.videoHeight || 64;
      const sampleSize = 8;
      const sx = Math.max(0, Math.floor(tw / 2) - sampleSize / 2);
      const sy = Math.max(0, Math.floor(th / 2) - sampleSize / 2);
      const pixels = new Uint8Array(sampleSize * sampleSize * 4);
      gl.readPixels(sx, sy, sampleSize, sampleSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);

      // Check if all pixels are black (DRM protected)
      let allBlack = true;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 2 || pixels[i + 1] > 2 || pixels[i + 2] > 2) {
          allBlack = false;
          break;
        }
      }

      // If all black but video is playing, could be a dark scene — retry
      if (allBlack && retryCount < 3 && !video.paused) {
        setTimeout(() => detectDRM(callback, retryCount + 1), 300);
        return;
      }

      const mode = allBlack ? 'overlay' : 'full';
      drmCache[domain] = mode;
      chrome.storage.local.set({ drmCache });
      callback(mode);
    } catch (e) {
      console.warn('CRT: DRM detection error, falling back to overlay', e);
      drmCache[domain] = 'overlay';
      callback('overlay');
    }
  }

  // ── Canvas overlay ────────────────────────────────────────────────
  let positionCanvas = () => {};

  function watchVideoFrames(v) {
    if (!('requestVideoFrameCallback' in v)) return;
    const onFrame = () => {
      if (v !== video) return;
      newVideoFrame = true;
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  function initOverlay() {
    if (canvas) return;
    log('Initializing overlay for video', video.videoWidth, 'x', video.videoHeight, 'readyState:', video.readyState);

    canvas = document.createElement('canvas');
    canvas.id = 'crt-filter-canvas';

    const parent = video.parentElement || document.documentElement;
    if (window.getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    canvas.style.cssText = `
      position: absolute;
      z-index: 2147483647;
      pointer-events: none;
      image-rendering: auto;
    `;

    if (video.nextSibling) {
      parent.insertBefore(canvas, video.nextSibling);
    } else {
      parent.appendChild(canvas);
    }

    // The canvas is rendered at native device pixels so the phosphor mask
    // maps 1:1 onto the physical display.
    positionCanvas = () => {
      if (!video || !canvas) return;
      canvas.style.left = video.offsetLeft + 'px';
      canvas.style.top = video.offsetTop + 'px';
      canvas.style.width = video.offsetWidth + 'px';
      canvas.style.height = video.offsetHeight + 'px';

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min(dpr, 3840 / Math.max(video.offsetWidth, 1));
      const w = Math.max(1, Math.round(video.offsetWidth * scale));
      const h = Math.max(1, Math.round(video.offsetHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      console.error('CRT: WebGL2 not available');
      return;
    }

    // Linear light needs more than 8 bits, or dark gradients band badly.
    hdrFormat = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.RGBA8;

    progs = createPrograms();
    if (!progs) return;

    setupGeometry();

    videoTexture = makeTexture();

    positionCanvas();
    startTime = performance.now() / 1000;
    lastTime = startTime;
    frameCount = 0;
    newVideoFrame = true;
    watchVideoFrames(video);

    // Resize tracking
    resizeObserver = new ResizeObserver(positionCanvas);
    resizeObserver.observe(video);
    if (video.parentElement) resizeObserver.observe(video.parentElement);
    resizeObserver.observe(document.documentElement);
    window.addEventListener('resize', positionCanvas);
    document.addEventListener('fullscreenchange', () => {
      positionCanvas();
      setTimeout(positionCanvas, 50);
      setTimeout(positionCanvas, 200);
      setTimeout(positionCanvas, 500);
    });

    // Wait for video data, then detect DRM
    function onVideoReady() {
      if (video.readyState >= 2 && !drmChecked) {
        drmChecked = true;
        detectDRM(mode => {
          crtMode = mode;
          if (mode === 'full') {
            video.style.opacity = '0';
          }
          console.log(`CRT: Running in ${mode} mode`);
          startRenderLoop();
        });
      }
    }

    if (video.readyState >= 2) {
      onVideoReady();
    } else {
      video.addEventListener('loadeddata', onVideoReady, { once: true });
      video.addEventListener('canplay', onVideoReady, { once: true });
      setTimeout(() => {
        if (!drmChecked) {
          drmChecked = true;
          crtMode = 'overlay';
          console.log('CRT: Timeout waiting for video data, using overlay mode');
          startRenderLoop();
        }
      }, 3000);
    }
  }

  // ── Render loop ───────────────────────────────────────────────────
  function startRenderLoop() {
    if (animFrameId) return;
    render();
  }

  // Simulated line count. Auto picks 480 only when there are enough device
  // pixels per line for the beam profile to resolve; otherwise 240p.
  function lineCount() {
    if (settings.lines > 0) return settings.lines;
    return canvas.height / 480 >= 3.5 ? 480 : 240;
  }

  // Where the picture sits inside the video element (object-fit: contain).
  function pictureRect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const ew = video.offsetWidth, eh = video.offsetHeight;
    if (!vw || !vh || !ew || !eh) return [0, 0, 1, 1];
    const fit = getComputedStyle(video).objectFit;
    if (fit === 'fill') return [0, 0, 1, 1];
    const s = fit === 'cover' ? Math.max(ew / vw, eh / vh) : Math.min(ew / vw, eh / vh);
    const w = (vw * s) / ew, h = (vh * s) / eh;
    return [(1 - w) / 2, (1 - h) / 2, w, h];
  }

  function renderFull(t, dt) {
    const s = settings;
    const W = canvas.width, H = canvas.height;
    const aspect = W / H;
    const L = lineCount();
    const curv = s.curvature / 100;

    if (newVideoFrame && video.readyState >= 2) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
      // Without requestVideoFrameCallback, upload every frame.
      newVideoFrame = !('requestVideoFrameCallback' in video);
    }

    // 1. Composite video signal at the simulated resolution.
    const sig = target('sig', Math.min(2048, L * aspect * 1.5), L, false);
    progs.signal.use()
      .tex('u_src', 0, videoTexture)
      .set('u_srcRect', ...pictureRect())
      .set('u_sigSize', sig.w, sig.h)
      .set('u_frame', frameCount)
      .set('u_time', t)
      .set('u_sharp', s.sharpness / 100)
      .set('u_bleed', s.colorbleed / 100)
      .set('u_noise', s.noise / 100);
    drawTo(sig);

    // 2. Electron beams onto phosphor, with persistence feedback.
    const cur = target(frameCount % 2 ? 'beamA' : 'beamB', W, H, true);
    const prev = target(frameCount % 2 ? 'beamB' : 'beamA', W, H, true);
    const persistence = (s.persistence / 100) * 0.88;
    progs.beam.use()
      .tex('u_sig', 0, sig.tex)
      .tex('u_prev', 1, prev.tex)
      .set('u_sigSize', sig.w, sig.h)
      .set('u_aspect', aspect)
      .set('u_curv', curv)
      .set('u_conv', s.chromatic / 100)
      .set('u_scan', s.scanlines / 100)
      .set('u_interlace', s.interlace / 100)
      .set('u_field', frameCount % 2)
      .set('u_decay', Math.pow(persistence, Math.min(dt, 0.1) * 60));
    drawTo(cur);

    // 3. Glow pyramid: bloom at 1/4 resolution, halation at 1/16.
    const q1 = target('q1', W / 4, H / 4, true);
    const q1b = target('q1b', W / 4, H / 4, true);
    const q2 = target('q2', W / 16, H / 16, true);
    const q2b = target('q2b', W / 16, H / 16, true);

    progs.down.use().tex('u_tex', 0, cur.tex).set('u_texel', 1 / W, 1 / H);
    drawTo(q1);
    progs.blur.use().tex('u_tex', 0, q1.tex).set('u_step', 0.7 / q1.w, 0);
    drawTo(q1b);
    progs.blur.tex('u_tex', 0, q1b.tex).set('u_step', 0, 0.7 / q1.h);
    drawTo(q1);

    progs.down.use().tex('u_tex', 0, q1.tex).set('u_texel', 1 / q1.w, 1 / q1.h);
    drawTo(q2);
    progs.blur.use().tex('u_tex', 0, q2.tex).set('u_step', 1.4 / q2.w, 0);
    drawTo(q2b);
    progs.blur.tex('u_tex', 0, q2b.tex).set('u_step', 0, 1.4 / q2.h);
    drawTo(q2);

    // 4. Mask, diffusion, colour, screen edge → canvas.
    progs.composite.use()
      .tex('u_beam', 0, cur.tex)
      .tex('u_bloomTex', 1, q1.tex)
      .tex('u_haloTex', 2, q2.tex)
      .set('u_outSize', W, H)
      .set('u_aspect', aspect)
      .set('u_curv', curv)
      .set('u_mask', s.phosphor / 100)
      .set('u_maskType', s.mask)
      .set('u_maskPx', Math.max(1, Math.round(W / 1920)))
      .set('u_bloom', s.bloom / 100)
      .set('u_glow', s.glow / 100)
      .set('u_flicker', s.flicker / 100)
      .set('u_temp', s.colortemp / 100)
      .set('u_time', t);
    drawTo(null);
  }

  function renderOverlay(t) {
    const s = settings;
    const W = canvas.width, H = canvas.height;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clear(gl.COLOR_BUFFER_BIT);
    progs.overlay.use()
      .set('u_outSize', W, H)
      .set('u_lines', lineCount())
      .set('u_aspect', W / H)
      .set('u_curv', s.curvature / 100)
      .set('u_scan', s.scanlines / 100)
      .set('u_interlace', s.interlace / 100)
      .set('u_field', frameCount % 2)
      .set('u_mask', s.phosphor / 100)
      .set('u_maskType', s.mask)
      .set('u_maskPx', Math.max(1, Math.round(W / 1920)))
      .set('u_noise', s.noise / 100)
      .set('u_flicker', s.flicker / 100)
      .set('u_frame', frameCount)
      .set('u_time', t);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
  }

  function render() {
    if (!filterEnabled || document.hidden) {
      if (canvas) canvas.style.display = 'none';
      if (video && video.style.opacity === '0' && !filterEnabled) {
        video.style.opacity = '1';
      }
      animFrameId = requestAnimationFrame(render);
      return;
    }

    if (canvas && canvas.style.display === 'none') {
      canvas.style.display = '';
    }

    if (!video || !gl || !progs) {
      animFrameId = requestAnimationFrame(render);
      return;
    }

    if (crtMode === 'full' && video.style.opacity !== '0') {
      video.style.opacity = '0';
    }

    positionCanvas();

    const now = performance.now() / 1000;
    const t = now - startTime;
    const dt = now - lastTime;
    lastTime = now;

    gl.bindVertexArray(quadVAO);
    if (crtMode === 'full') renderFull(t, dt);
    else renderOverlay(t);
    gl.bindVertexArray(null);

    frameCount++;
    animFrameId = requestAnimationFrame(render);
  }

  // ── Video detection ───────────────────────────────────────────────
  function findLargestVideo() {
    const videos = document.querySelectorAll('video');
    if (videos.length === 0) return null;

    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.width < 10 || rect.height < 10) continue;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function tryAttach() {
    if (video && !document.contains(video)) {
      log('Current video removed from DOM, cleaning up');
      cleanup();
    }

    const v = findLargestVideo();
    if (v && v !== video) {
      cleanup();
      video = v;
      initOverlay();
    }
  }

  function cleanup() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (video && video.style.opacity === '0') {
      video.style.opacity = '1';
    }
    if (canvas && canvas.parentNode) {
      canvas.parentNode.removeChild(canvas);
    }
    if (gl) {
      deleteTargets();
      if (videoTexture) gl.deleteTexture(videoTexture);
      if (quadVBO) gl.deleteBuffer(quadVBO);
      if (quadVAO) gl.deleteVertexArray(quadVAO);
      if (progs) for (const p of Object.values(progs)) gl.deleteProgram(p.prog);
    }
    canvas = null;
    gl = null;
    progs = null;
    videoTexture = null;
    quadVAO = null;
    quadVBO = null;
    drmChecked = false;
    crtMode = null;
    video = null;
    frameCount = 0;
  }

  // ── Observe DOM for dynamically inserted videos ───────────────────
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
          tryAttach();
          return;
        }
      }
      for (const node of m.removedNodes) {
        if (node === video || (node.contains && video && node.contains(video))) {
          cleanup();
          setTimeout(tryAttach, 500);
          return;
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial check + periodic retry
  tryAttach();
  let retryInterval = setInterval(() => {
    if (video && document.contains(video)) return;
    tryAttach();
  }, 2000);
  setTimeout(() => clearInterval(retryInterval), 60000);

  // ── Settings sync ─────────────────────────────────────────────────
  chrome.storage.sync.get('crt', (data) => {
    if (data.crt) {
      const { enabled, ...rest } = data.crt;  // ignore legacy enabled flag
      settings = { ...DEFAULTS, ...rest };
    }
  });

  // Load per-site enabled state + cached DRM results
  chrome.storage.local.get(['enabledSites', 'drmCache'], (data) => {
    if (data.drmCache) drmCache = data.drmCache;
    if (data.enabledSites && data.enabledSites[siteDomain]) {
      filterEnabled = true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.crt) {
      const { enabled, ...rest } = changes.crt.newValue || DEFAULTS;
      settings = { ...DEFAULTS, ...rest };
    }
    if (area === 'local' && changes.enabledSites) {
      const sites = changes.enabledSites.newValue || {};
      filterEnabled = !!sites[siteDomain];
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getCRTMode') {
      sendResponse({ mode: crtMode || 'none', enabled: filterEnabled });
    } else if (msg.type === 'toggleCRT') {
      filterEnabled = !filterEnabled;
      chrome.storage.local.get('enabledSites', (data) => {
        const sites = data.enabledSites || {};
        if (filterEnabled) {
          sites[siteDomain] = true;
        } else {
          delete sites[siteDomain];
        }
        chrome.storage.local.set({ enabledSites: sites });
      });
    }
    return false;
  });
})();
