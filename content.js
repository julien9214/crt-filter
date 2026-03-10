(() => {
  'use strict';

  // ── Default settings ──────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,
    scanlines: 30, curvature: 20, chromatic: 15,
    bloom: 20, noise: 10, flicker: 5,
    phosphor: 15, interlace: 0, colorbleed: 10,
  };

  let settings = { ...DEFAULTS };
  let filterEnabled = true;
  let crtMode = null;           // 'full' | 'overlay'
  let video = null;
  let canvas = null;
  let gl = null;
  let program = null;
  let uniforms = {};
  let videoTexture = null;
  let quadVAO = null;
  let quadVBO = null;
  let animFrameId = null;
  let startTime = 0;
  let frameCount = 0;
  let drmChecked = false;
  let drmCache = {};            // domain → 'full' | 'overlay'
  let resizeObserver = null;

  const LOG_PREFIX = 'CRT:';
  function log(...args) { console.log(LOG_PREFIX, ...args); }

  log('Content script loaded on', location.href);

  // ── Shaders ───────────────────────────────────────────────────────
  const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_video;
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_mode;           // 0 = full, 1 = overlay
uniform float u_scanlineCount; // video native height for consistent scanlines
uniform float u_frame;        // frame counter for interlacing

uniform float u_scanlines;
uniform float u_curvature;
uniform float u_chromatic;
uniform float u_bloom;
uniform float u_noise;
uniform float u_flicker;
uniform float u_phosphor;
uniform float u_interlace;
uniform float u_colorbleed;

// ── Barrel distortion ──────────────────────────────────────────
vec2 barrelDistort(vec2 uv, float amt) {
  vec2 cc = uv - 0.5;
  float dist = dot(cc, cc);
  return uv + cc * dist * amt;
}

// ── Pseudo-random hash ─────────────────────────────────────────
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ── Shadow mask (phosphor grid) ────────────────────────────────
vec3 shadowMask(vec2 fragCoord, float strength) {
  // Aperture grille: vertical RGB stripes
  int subpx = int(mod(fragCoord.x, 3.0));
  vec3 mask = vec3(0.25);
  if (subpx == 0) mask.r = 1.0;
  else if (subpx == 1) mask.g = 1.0;
  else mask.b = 1.0;
  // Subtle horizontal gap between pixel rows
  float rowGap = 1.0 - 0.15 * step(0.85, fract(fragCoord.y / 2.0));
  mask *= rowGap;
  return mix(vec3(1.0), mask, strength);
}

// ── Color bleeding (composite video chroma blur) ───────────────
vec3 applyColorBleed(vec2 uv, vec3 baseCol, float amount) {
  float blurW = amount * 0.004;

  // YIQ conversion
  const mat3 rgb2yiq = mat3(
    0.299,  0.596,  0.211,
    0.587, -0.274, -0.523,
    0.114, -0.322,  0.312
  );
  const mat3 yiq2rgb = mat3(
    1.0,  1.0,  1.0,
    0.956, -0.272, -1.106,
    0.621, -0.647,  1.703
  );

  // Keep luma from base color (which may have chromatic aberration)
  vec3 centerYIQ = rgb2yiq * baseCol;

  // Blur I and Q channels horizontally (5 taps)
  float weights[5] = float[](0.1, 0.25, 0.3, 0.25, 0.1);
  vec2 chromaSum = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    float offset = float(i - 2) * blurW;
    vec3 sampleYIQ = rgb2yiq * texture(u_video, uv + vec2(offset, 0.0)).rgb;
    chromaSum += sampleYIQ.yz * weights[i];
  }

  return yiq2rgb * vec3(centerYIQ.x, chromaSum);
}

void main() {
  float curvAmt = u_curvature * 0.004;

  if (u_mode == 0) {
    // ── FULL CAPTURE MODE ──────────────────────────────────────
    vec2 uv = barrelDistort(v_uv, curvAmt);

    // Black border outside curved screen
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // Chromatic aberration
    float chromAmt = u_chromatic * 0.003;
    vec2 chromOff = vec2(chromAmt, 0.0);
    vec3 col;
    col.r = texture(u_video, uv + chromOff).r;
    col.g = texture(u_video, uv).g;
    col.b = texture(u_video, uv - chromOff).b;

    // Color bleeding
    if (u_colorbleed > 0.0) {
      col = applyColorBleed(uv, col, u_colorbleed);
    }

    // Bloom — 9-sample Gaussian cross (replaces 25-sample box blur)
    if (u_bloom > 0.0) {
      float bs = u_bloom * 0.002;
      vec3 bloom = col * 0.40;
      // Inner ring
      bloom += texture(u_video, uv + vec2(bs, 0.0)).rgb * 0.15;
      bloom += texture(u_video, uv - vec2(bs, 0.0)).rgb * 0.15;
      bloom += texture(u_video, uv + vec2(0.0, bs)).rgb * 0.15;
      bloom += texture(u_video, uv - vec2(0.0, bs)).rgb * 0.15;
      // Outer ring
      float bs2 = bs * 2.5;
      bloom += texture(u_video, uv + vec2(bs2, 0.0)).rgb * 0.05;
      bloom += texture(u_video, uv - vec2(bs2, 0.0)).rgb * 0.05;
      bloom += texture(u_video, uv + vec2(0.0, bs2)).rgb * 0.05;
      bloom += texture(u_video, uv - vec2(0.0, bs2)).rgb * 0.05;
      bloom /= 1.2; // normalize (0.4 + 0.15*4 + 0.05*4)

      col = mix(col, max(col, bloom), u_bloom * 0.01);

      // Screen glow — wider, softer halo
      float gs = u_bloom * 0.008;
      vec3 glow = vec3(0.0);
      glow += texture(u_video, uv + vec2(gs, 0.0)).rgb;
      glow += texture(u_video, uv - vec2(gs, 0.0)).rgb;
      glow += texture(u_video, uv + vec2(0.0, gs)).rgb;
      glow += texture(u_video, uv - vec2(0.0, gs)).rgb;
      glow *= 0.25;
      col += max(glow - col, 0.0) * u_bloom * 0.003;
    }

    // Phosphor shadow mask
    if (u_phosphor > 0.0) {
      vec2 fragCoord = uv * u_resolution;
      col *= shadowMask(fragCoord, u_phosphor * 0.01);
    }

    // Scanlines
    float scanFreq = u_scanlineCount * 0.8;
    float scanline = sin(uv.y * scanFreq * 3.14159) * 0.5 + 0.5;
    scanline = pow(scanline, 1.5);
    float scanStr = u_scanlines * 0.008;
    col *= 1.0 - scanStr * (1.0 - scanline);

    // Interlacing
    if (u_interlace > 0.0) {
      float intStr = u_interlace * 0.008;
      float scanPos = uv.y * u_scanlineCount;
      float lineIdx = floor(scanPos);
      float field = mod(u_frame, 2.0);
      float isEvenLine = step(0.5, mod(lineIdx, 2.0));
      float isEvenField = step(0.5, field);
      float isActive = 1.0 - abs(isEvenLine - isEvenField);
      col *= mix(1.0, isActive * 0.55 + 0.45, intStr);
    }

    // Noise
    float n = hash(uv * u_resolution + u_time * 1000.0);
    col += (n - 0.5) * u_noise * 0.003;

    // Flicker
    float flickerAmt = u_flicker * 0.0015;
    float flicker = 1.0 + (sin(u_time * 8.0) * sin(u_time * 13.7) * sin(u_time * 27.3)) * flickerAmt;
    col *= flicker;

    // Vignette
    vec2 vigUV = uv * (1.0 - uv);
    float vig = vigUV.x * vigUV.y * 15.0;
    vig = pow(vig, 0.4);
    col *= vig;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);

  } else {
    // ── OVERLAY MODE ─────────────────────────────────────────────
    vec2 uv = v_uv;

    // Scanlines — reduced multiplier
    float scanFreq = u_scanlineCount * 0.8;
    float scanline = sin(uv.y * scanFreq * 3.14159) * 0.5 + 0.5;
    scanline = pow(scanline, 1.5);
    float scanStr = u_scanlines * 0.004;

    // Noise
    float n = hash(uv * u_resolution + u_time * 1000.0);
    float noiseAmt = u_noise * 0.0015;

    // Flicker
    float flickerAmt = u_flicker * 0.001;
    float flicker = 1.0 + (sin(u_time * 8.0) * sin(u_time * 13.7) * sin(u_time * 27.3)) * flickerAmt;

    // Vignette
    vec2 vigUV = uv * (1.0 - uv);
    float vig = vigUV.x * vigUV.y * 15.0;
    float vigPow = 0.25 - u_curvature * 0.001;
    vig = pow(vig, max(vigPow, 0.08));

    // Build alpha mask
    float alpha = 0.0;
    alpha += scanStr * (1.0 - scanline);
    alpha += abs(n - 0.5) * noiseAmt;
    alpha += (1.0 - flicker) * 0.3;
    alpha += (1.0 - vig) * 0.35;

    // Interlacing in overlay — darken alternate fields
    if (u_interlace > 0.0) {
      float intStr = u_interlace * 0.005;
      float scanPos = uv.y * u_scanlineCount;
      float lineIdx = floor(scanPos);
      float field = mod(u_frame, 2.0);
      float isEvenLine = step(0.5, mod(lineIdx, 2.0));
      float isEvenField = step(0.5, field);
      float isInactive = abs(isEvenLine - isEvenField);
      alpha += isInactive * intStr;
    }

    // Phosphor mask in overlay — subtle darkening pattern
    if (u_phosphor > 0.0) {
      vec2 fragCoord = uv * u_resolution;
      vec3 mask = shadowMask(fragCoord, u_phosphor * 0.01);
      float maskDim = 1.0 - (mask.r + mask.g + mask.b) / 3.0;
      alpha += maskDim * 0.3;
    }

    fragColor = vec4(0.0, 0.0, 0.0, clamp(alpha, 0.0, 0.55));
  }
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

  function createProgram() {
    const vs = compileShader(VERT_SRC, gl.VERTEX_SHADER);
    const fs = compileShader(FRAG_SRC, gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('CRT program link error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  function setupGeometry() {
    const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);

    quadVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  function cacheUniforms() {
    const names = [
      'u_video', 'u_resolution', 'u_time', 'u_mode', 'u_scanlineCount', 'u_frame',
      'u_scanlines', 'u_curvature', 'u_chromatic',
      'u_bloom', 'u_noise', 'u_flicker',
      'u_phosphor', 'u_interlace', 'u_colorbleed',
    ];
    for (const n of names) {
      uniforms[n] = gl.getUniformLocation(program, n);
    }
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

    positionCanvas = () => {
      if (!video || !canvas) return;
      canvas.style.left = video.offsetLeft + 'px';
      canvas.style.top = video.offsetTop + 'px';
      canvas.style.width = video.offsetWidth + 'px';
      canvas.style.height = video.offsetHeight + 'px';

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.min(Math.round(video.offsetWidth * dpr), video.videoWidth || 1920);
      const h = Math.min(Math.round(video.offsetHeight * dpr), video.videoHeight || 1080);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        if (gl) gl.viewport(0, 0, w, h);
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

    program = createProgram();
    if (!program) return;

    gl.useProgram(program);
    cacheUniforms();
    setupGeometry();

    // Video texture
    videoTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    positionCanvas();
    startTime = performance.now() / 1000;
    frameCount = 0;

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
      }, 3000); // Reduced from 5s to 3s
    }
  }

  // ── Render loop ───────────────────────────────────────────────────
  function startRenderLoop() {
    if (animFrameId) return;
    render();
  }

  function render() {
    if (!filterEnabled || !settings.enabled || document.hidden) {
      if (canvas) canvas.style.display = 'none';
      if (video && video.style.opacity === '0' && (!filterEnabled || !settings.enabled)) {
        video.style.opacity = '1';
      }
      animFrameId = requestAnimationFrame(render);
      return;
    }

    if (canvas && canvas.style.display === 'none') {
      canvas.style.display = '';
    }

    if (!video || !gl || !program) {
      animFrameId = requestAnimationFrame(render);
      return;
    }

    if (crtMode === 'full' && video.style.opacity !== '0') {
      video.style.opacity = '0';
    }

    positionCanvas();

    const mode = crtMode === 'full' ? 0 : 1;

    // Upload video frame in full mode
    if (mode === 0 && !video.paused && video.readyState >= 2) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }

    gl.useProgram(program);
    gl.uniform1i(uniforms.u_video, 0);
    gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.u_time, performance.now() / 1000 - startTime);
    gl.uniform1i(uniforms.u_mode, mode);
    gl.uniform1f(uniforms.u_scanlineCount, video.videoHeight || 480);
    gl.uniform1f(uniforms.u_frame, frameCount);

    gl.uniform1f(uniforms.u_scanlines, settings.scanlines);
    gl.uniform1f(uniforms.u_curvature, settings.curvature);
    gl.uniform1f(uniforms.u_chromatic, settings.chromatic);
    gl.uniform1f(uniforms.u_bloom, settings.bloom);
    gl.uniform1f(uniforms.u_noise, settings.noise);
    gl.uniform1f(uniforms.u_flicker, settings.flicker);
    gl.uniform1f(uniforms.u_phosphor, settings.phosphor);
    gl.uniform1f(uniforms.u_interlace, settings.interlace);
    gl.uniform1f(uniforms.u_colorbleed, settings.colorbleed);

    if (mode === 0) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
      if (videoTexture) gl.deleteTexture(videoTexture);
      if (quadVBO) gl.deleteBuffer(quadVBO);
      if (quadVAO) gl.deleteVertexArray(quadVAO);
      if (program) gl.deleteProgram(program);
    }
    canvas = null;
    gl = null;
    program = null;
    videoTexture = null;
    quadVAO = null;
    quadVBO = null;
    uniforms = {};
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
      settings = { ...DEFAULTS, ...data.crt };
      filterEnabled = settings.enabled !== false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.crt) {
      const newVal = changes.crt.newValue || DEFAULTS;
      settings = { ...DEFAULTS, ...newVal };
      filterEnabled = settings.enabled !== false;
    }
  });

  // Load cached DRM results
  chrome.storage.local.get('drmCache', (data) => {
    if (data.drmCache) drmCache = data.drmCache;
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'getCRTMode') {
      sendResponse({ mode: crtMode || 'none' });
    } else if (msg.type === 'toggleCRT') {
      filterEnabled = !filterEnabled;
      settings.enabled = filterEnabled;
      chrome.storage.sync.set({ crt: settings });
    }
    return false;
  });
})();
