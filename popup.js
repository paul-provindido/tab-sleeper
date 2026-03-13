const autoSleepToggle = document.getElementById('autoSleepToggle');
const timeoutInput    = document.getElementById('timeoutInput');
const timeoutRow      = document.getElementById('timeoutRow');
const sleepingCount   = document.getElementById('sleepingCount');
const saveStatus      = document.getElementById('saveStatus');
const sleepTabBtn     = document.getElementById('sleepTabBtn');
const sleepAllBtn     = document.getElementById('sleepAllBtn');

let saveTimer = null;

// ─── Load settings on popup open ─────────────────────────────────────────────

async function loadSettings() {
  const { autoSleepEnabled = true, timeoutMinutes = 30 } =
    await chrome.storage.sync.get(['autoSleepEnabled', 'timeoutMinutes']);

  autoSleepToggle.checked       = autoSleepEnabled;
  timeoutInput.value            = timeoutMinutes;
  timeoutRow.style.display      = autoSleepEnabled ? 'flex' : 'none';
}

// ─── Load sleeping tab count ──────────────────────────────────────────────────

async function loadSleepingCount() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSleepingCount' });
    sleepingCount.textContent = response?.count ?? 0;
  } catch {
    sleepingCount.textContent = '0';
  }
}

// ─── Save settings ────────────────────────────────────────────────────────────

async function saveSettings() {
  const enabled = autoSleepToggle.checked;
  let minutes   = parseInt(timeoutInput.value, 10);

  if (isNaN(minutes) || minutes < 1)  minutes = 1;
  if (minutes > 480)                  minutes = 480;
  timeoutInput.value = minutes;

  await chrome.storage.sync.set({
    autoSleepEnabled: enabled,
    timeoutMinutes:   minutes
  });

  saveStatus.textContent = 'Saved.';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveStatus.textContent = ''; }, 1500);
}

// ─── Sleep buttons ────────────────────────────────────────────────────────────

sleepTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await chrome.runtime.sendMessage({ action: 'sleepCurrentTab', tabId: tab.id });
  window.close();
});

sleepAllBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'sleepAllTabs' });
  window.close();
});

// ─── Event listeners ──────────────────────────────────────────────────────────

autoSleepToggle.addEventListener('change', () => {
  timeoutRow.style.display = autoSleepToggle.checked ? 'flex' : 'none';
  saveSettings();
});

timeoutInput.addEventListener('change', saveSettings);

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSettings();
loadSleepingCount();
