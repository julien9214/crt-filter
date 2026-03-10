(() => {
  'use strict';

  // ── Default settings ──────────────────────────────────────────────
  const DEFAULTS = {
    enabled: true,
    scanlines: 30, curvature: 20, chromatic: 15,
    bloom: 20, noise: 10, flicker: 5,
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

uniform float u_scanlines;
uniform float u_curvature;
uniform float u_chromatic;
uniform float u_bloom;
uniform float u_noise;
uniform float u_flicker;

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

    // Bloom (box blur approximation)
    if (u_bloom > 0.0) {
      float blurSize = u_bloom * 0.002;
      vec3 blurred = vec3(0.0);
      float total = 0.0;
      for (float x = -2.0; x <= 2.0; x += 1.0) {
        for (float y = -2.0; y <= 2.0; y += 1.0) {
          vec2 off = vec2(x, y) * blurSize;
          float w = 1.0 - length(vec2(x, y)) * 0.15;
          blurred += texture(u_video, uv + off).rgb * w;
          total += w;
        }
      }
      blurred /= total;
      col = mix(col, max(col, blurred), u_bloom * 0.008);
    }

    // Scanlines
    float scanFreq = u_scanlineCount * 0.8;
    float scanline = sin(uv.y * scanFreq * 3.14159) * 0.5 + 0.5;
    scanline = pow(scanline, 1.5);
    float scanStr = u_scanlines * 0.008;
    col *= 1.0 - scanStr * (1.0 - scanline);

    // Noise
    float n = hash(uv * u_resolution + u_time * 1000.0);
    col += (n - 0.5) * u_noise * 0.003;

    // Flicker
    float flickerAmt = u_flicker * 0.003;
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
    // Use original UVs so effects always cover the full video area.
    // Curvature is expressed through enhanced vignette instead of
    // barrel distortion, so there are no transparent gaps at edges.
    vec2 uv = v_uv;

    // Scanlines — reduced multiplier to avoid heavy dimming
    float scanFreq = u_scanlineCount * 0.8;
    float scanline = sin(uv.y * scanFreq * 3.14159) * 0.5 + 0.5;
    scanline = pow(scanline, 1.5);
    float scanStr = u_scanlines * 0.004;

    // Noise
    float n = hash(uv * u_resolution + u_time * 1000.0);
    float noiseAmt = u_noise * 0.0015;

    // Flicker
    float flickerAmt = u_flicker * 0.002;
    float flicker = 1.0 + (sin(u_time * 8.0) * sin(u_time * 13.7) * sin(u_time * 27.3)) * flickerAmt;

    // Vignette — only at edges, much lighter in the center
    vec2 vigUV = uv * (1.0 - uv);
    float vig = vigUV.x * vigUV.y * 15.0;
    float vigPow = 0.25 - u_curvature * 0.001;
    vig = pow(vig, max(vigPow, 0.08));

    // Build alpha mask — lighter overall to preserve brightness
    float alpha = 0.0;
    alpha += scanStr * (1.0 - scanline);
    alpha += abs(n - 0.5) * noiseAmt;
    alpha += (1.0 - flicker) * 0.3;
    alpha += (1.0 - vig) * 0.35;

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
      'u_video', 'u_resolution', 'u_time', 'u_mode', 'u_scanlineCount',
      'u_scanlines', 'u_curvature', 'u_chromatic',
      'u_bloom', 'u_noise', 'u_flicker',
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
          // Video has data but texture upload failed → DRM protected
          log('DRM detected (framebuffer incomplete on loaded video), using overlay mode');
          drmCache[domain] = 'overlay';
          chrome.storage.local.set({ drmCache });
        } else {
          log('Video not ready yet, using overlay mode temporarily');
        }
        callback('overlay');
        return;
      }

      // Read a larger region from the center for better accuracy
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

      // If all black but video is playing, could be a dark scene — retry a few times
      if (allBlack && retryCount < 3 && !video.paused) {
        setTimeout(() => detectDRM(callback, retryCount + 1), 500);
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
    if (canvas) return; // already initialized
    log('Initializing overlay for video', video.videoWidth, 'x', video.videoHeight, 'readyState:', video.readyState);

    canvas = document.createElement('canvas');
    canvas.id = 'crt-filter-canvas';

    // Insert canvas as a sibling right after the video, inside the same parent.
    // This ensures the canvas is within the fullscreen element's subtree.
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

    // Insert right after the video
    if (video.nextSibling) {
      parent.insertBefore(canvas, video.nextSibling);
    } else {
      parent.appendChild(canvas);
    }

    // Position canvas to exactly overlay the video within its parent
    positionCanvas = () => {
      if (!video || !canvas) return;
      // Use video's offset within its parent
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

    // Enable alpha blending for overlay mode
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    positionCanvas();
    startTime = performance.now() / 1000;

    // Resize tracking — multiple strategies for cross-iframe reliability
    resizeObserver = new ResizeObserver(positionCanvas);
    resizeObserver.observe(video);
    if (video.parentElement) resizeObserver.observe(video.parentElement);
    // Also observe the documentElement (catches iframe resize from fullscreen)
    resizeObserver.observe(document.documentElement);
    window.addEventListener('resize', positionCanvas);
    document.addEventListener('fullscreenchange', () => {
      // Fullscreen transitions take time; reposition multiple times
      positionCanvas();
      setTimeout(positionCanvas, 50);
      setTimeout(positionCanvas, 200);
      setTimeout(positionCanvas, 500);
    });

    // Wait for video to have data, then detect DRM
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
      }, 5000);
    }
  }

  // ── Render loop ───────────────────────────────────────────────────
  function startRenderLoop() {
    if (animFrameId) return;
    render();
  }

  function render() {
    if (!filterEnabled || !settings.enabled || document.hidden) {
      // Hide canvas and restore video when disabled
      if (canvas) canvas.style.display = 'none';
      if (video && video.style.opacity === '0' && (!filterEnabled || !settings.enabled)) {
        video.style.opacity = '1';
      }
      animFrameId = requestAnimationFrame(render);
      return;
    }

    // Show canvas when re-enabled
    if (canvas && canvas.style.display === 'none') {
      canvas.style.display = '';
    }

    if (!video || !gl || !program) {
      animFrameId = requestAnimationFrame(render);
      return;
    }

    // Re-hide video in full mode when re-enabled
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

    gl.uniform1f(uniforms.u_scanlines, settings.scanlines);
    gl.uniform1f(uniforms.u_curvature, settings.curvature);
    gl.uniform1f(uniforms.u_chromatic, settings.chromatic);
    gl.uniform1f(uniforms.u_bloom, settings.bloom);
    gl.uniform1f(uniforms.u_noise, settings.noise);
    gl.uniform1f(uniforms.u_flicker, settings.flicker);

    if (mode === 0) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.bindVertexArray(quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

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
      // Skip videos with no visible dimensions (placeholders)
      if (rect.width < 10 || rect.height < 10) continue;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function tryAttach() {
    // If our current video was removed from the DOM, clean up
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

  // Initial check + periodic retry (some players add video late or replace elements)
  tryAttach();
  let retryInterval = setInterval(() => {
    // Keep retrying if no video, or if current video was removed from DOM
    if (video && document.contains(video)) return;
    tryAttach();
  }, 2000);
  // Stop retrying after 60 seconds
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
