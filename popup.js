const PRESETS = {
  subtle:    { scanlines: 30, curvature: 20, chromatic: 15, bloom: 20, noise: 10, flicker: 5,  phosphor: 15, interlace: 0,  colorbleed: 10 },
  heavy:     { scanlines: 70, curvature: 50, chromatic: 40, bloom: 50, noise: 30, flicker: 20, phosphor: 40, interlace: 30, colorbleed: 25 },
  vhs:       { scanlines: 50, curvature: 10, chromatic: 60, bloom: 30, noise: 50, flicker: 40, phosphor: 0,  interlace: 20, colorbleed: 60 },
  arcade:    { scanlines: 80, curvature: 30, chromatic: 20, bloom: 35, noise: 15, flicker: 10, phosphor: 70, interlace: 0,  colorbleed: 15 },
  retro:     { scanlines: 60, curvature: 40, chromatic: 35, bloom: 40, noise: 25, flicker: 15, phosphor: 30, interlace: 45, colorbleed: 45 },
  latenight: { scanlines: 45, curvature: 25, chromatic: 20, bloom: 55, noise: 20, flicker: 25, phosphor: 20, interlace: 15, colorbleed: 20 },
};

const PARAMS = ['scanlines', 'curvature', 'chromatic', 'bloom', 'noise', 'flicker', 'phosphor', 'interlace', 'colorbleed'];
const FULL_ONLY = ['chromatic', 'bloom', 'colorbleed']; // Need video pixel data

let currentMode = null;
let saveTimeout = null;

function updateUI(settings) {
  document.getElementById('toggle').checked = settings.enabled !== false;
  for (const p of PARAMS) {
    const slider = document.getElementById(p);
    const val = document.getElementById('val-' + p);
    slider.value = settings[p] ?? PRESETS.subtle[p];
    val.textContent = slider.value;
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
}

function getSettings() {
  const settings = { enabled: document.getElementById('toggle').checked };
  for (const p of PARAMS) {
    settings[p] = parseInt(document.getElementById(p).value, 10);
  }
  return settings;
}

function save(settings) {
  chrome.storage.sync.set({ crt: settings });
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
  for (const p of PARAMS) {
    from[p] = parseInt(document.getElementById(p).value, 10);
  }

  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const ease = t * (2 - t); // ease-out quad
    for (const p of PARAMS) {
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

// Sliders
for (const p of PARAMS) {
  const slider = document.getElementById(p);
  slider.addEventListener('input', () => {
    document.getElementById('val-' + p).textContent = slider.value;
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

// Load saved settings
chrome.storage.sync.get('crt', (data) => {
  updateUI(data.crt || PRESETS.subtle);
  queryMode();
});
