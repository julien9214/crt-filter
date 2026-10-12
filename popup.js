// mask: 0 aperture grille, 1 slot mask, 2 shadow mask. lines: 0 = auto.
const PRESETS = {
  subtle:    { scanlines: 35, phosphor: 30, mask: 0, lines: 0,   interlace: 0,  curvature: 15, persistence: 15, sharpness: 60, colorbleed: 20, chromatic: 10, bloom: 25, glow: 20, colortemp: 20, noise: 5,  flicker: 5 },
  heavy:     { scanlines: 75, phosphor: 60, mask: 1, lines: 240, interlace: 0,  curvature: 45, persistence: 35, sharpness: 40, colorbleed: 40, chromatic: 35, bloom: 50, glow: 45, colortemp: 50, noise: 20, flicker: 20 },
  vhs:       { scanlines: 45, phosphor: 25, mask: 2, lines: 0,   interlace: 25, curvature: 20, persistence: 30, sharpness: 15, colorbleed: 80, chromatic: 50, bloom: 35, glow: 30, colortemp: 30, noise: 55, flicker: 30 },
  arcade:    { scanlines: 85, phosphor: 70, mask: 2, lines: 240, interlace: 0,  curvature: 35, persistence: 20, sharpness: 80, colorbleed: 10, chromatic: 20, bloom: 40, glow: 35, colortemp: 10, noise: 5,  flicker: 5 },
  retro:     { scanlines: 55, phosphor: 50, mask: 1, lines: 0,   interlace: 40, curvature: 40, persistence: 25, sharpness: 45, colorbleed: 50, chromatic: 30, bloom: 35, glow: 40, colortemp: 70, noise: 15, flicker: 10 },
  latenight: { scanlines: 50, phosphor: 40, mask: 0, lines: 0,   interlace: 10, curvature: 25, persistence: 40, sharpness: 50, colorbleed: 30, chromatic: 20, bloom: 65, glow: 70, colortemp: 40, noise: 15, flicker: 25 },
};

const SLIDERS = ['scanlines', 'phosphor', 'interlace', 'curvature', 'persistence', 'sharpness', 'colorbleed', 'chromatic', 'bloom', 'glow', 'colortemp', 'noise', 'flicker'];
const SELECTS = ['mask', 'lines'];
const PARAMS = [...SELECTS, ...SLIDERS];

let currentMode = null;
let saveTimeout = null;
let activeDomain = null;

function updateUI(settings) {
  document.getElementById('toggle').checked = settings.enabled !== false;
  for (const p of PARAMS) {
    document.getElementById(p).value = settings[p] ?? PRESETS.subtle[p];
  }
  for (const p of SLIDERS) {
    document.getElementById('val-' + p).textContent = document.getElementById(p).value;
  }
  updatePresetButtons(settings);
  updateModeUI();
}

function updatePresetButtons(settings) {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    const preset = PRESETS[btn.dataset.preset];
    const match = PARAMS.every(p => String(settings[p] ?? PRESETS.subtle[p]) === String(preset[p]));
    btn.classList.toggle('active', match);
  });
}

function updateModeUI() {
  const badge = document.getElementById('modeBadge');
  if (currentMode === 'full') {
    badge.textContent = 'Full';
    badge.className = 'mode-badge full';
  } else if (currentMode === 'overlay') {
    badge.textContent = 'Overlay';
    badge.className = 'mode-badge overlay';
  } else {
    badge.textContent = '\u2014';
    badge.className = 'mode-badge';
  }

  // Show hint on signal section when in overlay mode
  const isOverlay = currentMode === 'overlay';
  document.getElementById('section-signal').classList.toggle('show-overlay-hint', isOverlay);
  document.getElementById('section-glass').classList.toggle('show-overlay-hint', isOverlay);
}

function getSettings() {
  const settings = { enabled: document.getElementById('toggle').checked };
  for (const p of PARAMS) {
    settings[p] = parseInt(document.getElementById(p).value, 10);
  }
  return settings;
}

function save(settings) {
  // Save slider values globally (shared across sites)
  const { enabled, ...sliders } = settings;
  chrome.storage.sync.set({ crt: sliders });

  // Save enabled state per-site
  if (activeDomain) {
    chrome.storage.local.get('enabledSites', (data) => {
      const sites = data.enabledSites || {};
      if (enabled) {
        sites[activeDomain] = true;
      } else {
        delete sites[activeDomain];
      }
      chrome.storage.local.set({ enabledSites: sites });
    });
  }
}

// Debounced save — batches rapid slider changes
function debouncedSave(settings) {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => save(settings), 50);
}

// Animated preset transitions
function animateToPreset(preset) {
  const duration = 180;
  const start = performance.now();
  const from = {};
  for (const p of SLIDERS) {
    from[p] = parseInt(document.getElementById(p).value, 10);
  }
  for (const p of SELECTS) {
    document.getElementById(p).value = preset[p];
  }

  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const ease = t * (2 - t); // ease-out quad
    for (const p of SLIDERS) {
      const val = Math.round(from[p] + (preset[p] - from[p]) * ease);
      document.getElementById(p).value = val;
      document.getElementById('val-' + p).textContent = val;
    }
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      const settings = getSettings();
      updatePresetButtons(settings);
      save(settings);
    }
  }
  requestAnimationFrame(tick);
}

// Toggle
document.getElementById('toggle').addEventListener('change', () => save(getSettings()));

// Sliders and selects
for (const p of PARAMS) {
  const el = document.getElementById(p);
  el.addEventListener(SELECTS.includes(p) ? 'change' : 'input', () => {
    if (!SELECTS.includes(p)) document.getElementById('val-' + p).textContent = el.value;
    const settings = getSettings();
    updatePresetButtons(settings);
    debouncedSave(settings);
  });
}

// Presets — animated
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    // Immediately highlight the button
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    animateToPreset(preset);
  });
});

// Query the active tab for its current CRT mode
async function queryMode() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'getCRTMode' });
      if (response?.mode) {
        currentMode = response.mode;
        updateModeUI();
      }
    }
  } catch (_) { /* tab might not have content script */ }
}

// Load saved settings + per-site enabled state
async function init() {
  // Get active tab domain
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      try { activeDomain = new URL(tab.url).hostname; } catch (_) {}
    }
  } catch (_) {}

  // Load global slider settings
  chrome.storage.sync.get('crt', (syncData) => {
    const sliders = syncData.crt || PRESETS.subtle;

    // Load per-site enabled state
    chrome.storage.local.get('enabledSites', (localData) => {
      const sites = localData.enabledSites || {};
      const enabled = activeDomain ? !!sites[activeDomain] : false;
      updateUI({ ...sliders, enabled });
      queryMode();
    });
  });
}

init();
