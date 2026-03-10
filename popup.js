const PRESETS = {
  subtle:  { scanlines: 30, curvature: 20, chromatic: 15, bloom: 20, noise: 10, flicker: 5 },
  heavy:   { scanlines: 70, curvature: 50, chromatic: 40, bloom: 50, noise: 30, flicker: 20 },
  vhs:     { scanlines: 50, curvature: 10, chromatic: 60, bloom: 30, noise: 50, flicker: 40 },
};

const PARAMS = ['scanlines', 'curvature', 'chromatic', 'bloom', 'noise', 'flicker'];
const FULL_ONLY = ['chromatic', 'bloom']; // These need video pixel data

let currentMode = null;

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
    badge.textContent = '—';
    badge.className = 'mode-badge';
  }

  for (const p of FULL_ONLY) {
    const ctrl = document.getElementById('ctrl-' + p);
    ctrl.classList.toggle('disabled', currentMode === 'overlay');
  }
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

// Toggle
document.getElementById('toggle').addEventListener('change', () => save(getSettings()));

// Sliders
for (const p of PARAMS) {
  const slider = document.getElementById(p);
  slider.addEventListener('input', () => {
    document.getElementById('val-' + p).textContent = slider.value;
    const settings = getSettings();
    updatePresetButtons(settings);
    save(settings);
  });
}

// Presets
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    for (const p of PARAMS) {
      document.getElementById(p).value = preset[p];
      document.getElementById('val-' + p).textContent = preset[p];
    }
    const settings = getSettings();
    updatePresetButtons(settings);
    save(settings);
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
