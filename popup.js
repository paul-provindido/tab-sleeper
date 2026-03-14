const autoSleepToggle      = document.getElementById('autoSleepToggle');
const timeoutInput         = document.getElementById('timeoutInput');
const timeoutRow           = document.getElementById('timeoutRow');
const sleepingCount        = document.getElementById('sleepingCount');
const wakeAllBtn           = document.getElementById('wakeAllBtn');
const saveStatus           = document.getElementById('saveStatus');
const neverSleepToggle     = document.getElementById('neverSleepToggle');
const sleepTabBtn          = document.getElementById('sleepTabBtn');
const sleepAllBtn          = document.getElementById('sleepAllBtn');
const sleepingTabsList     = document.getElementById('sleepingTabsList');
const exclusionTextarea    = document.getElementById('exclusionTextarea');
const saveExclusionsBtn    = document.getElementById('saveExclusionsBtn');

let saveTimer = null;

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const { autoSleepEnabled = true, timeoutMinutes = 30 } =
    await chrome.storage.sync.get(['autoSleepEnabled', 'timeoutMinutes']);

  autoSleepToggle.checked  = autoSleepEnabled;
  timeoutInput.value       = timeoutMinutes;
  timeoutRow.style.display = autoSleepEnabled ? 'flex' : 'none';
}

async function saveSettings() {
  let minutes = parseInt(timeoutInput.value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = 1;
  if (minutes > 480) minutes = 480;
  timeoutInput.value = minutes;

  await chrome.storage.sync.set({
    autoSleepEnabled: autoSleepToggle.checked,
    timeoutMinutes:   minutes
  });
  saveStatus.textContent = 'Saved.';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveStatus.textContent = ''; }, 1500);
}

// ─── Sleeping tabs list ───────────────────────────────────────────────────────

async function loadSleepingTabs() {
  try {
    const { tabs = [] } = await chrome.runtime.sendMessage({ action: 'getSleepingTabs' });
    sleepingCount.textContent = tabs.length;
    wakeAllBtn.style.display  = tabs.length > 0 ? '' : 'none';

    sleepingTabsList.innerHTML = '';
    for (const t of tabs) {
      const li    = document.createElement('li');
      li.className = 'sleeping-tab-item';

      const title = document.createElement('span');
      title.className   = 'sleeping-tab-title';
      title.textContent = t.title || t.originalUrl || 'Sleeping tab';
      title.title       = t.originalUrl;

      const btn = document.createElement('button');
      btn.className   = 'sleeping-tab-wake';
      btn.textContent = 'Wake';
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'wakeTab', tabId: t.tabId });
        loadSleepingTabs();
      });

      li.append(title, btn);
      sleepingTabsList.appendChild(li);
    }
  } catch {
    sleepingCount.textContent = '0';
  }
}

// ─── Never-sleep toggle ───────────────────────────────────────────────────────

async function loadNeverSleep() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const stored = await chrome.storage.local.get(`tab_${tab.id}`);
  const entry  = stored[`tab_${tab.id}`] || {};
  neverSleepToggle.checked = !!entry.neverSleep;
}

neverSleepToggle.addEventListener('change', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const key    = `tab_${tab.id}`;
  const stored = await chrome.storage.local.get(key);
  const entry  = stored[key] || {};
  await chrome.storage.local.set({ [key]: { ...entry, neverSleep: neverSleepToggle.checked } });
});

// ─── Exclusions ───────────────────────────────────────────────────────────────

async function loadExclusions() {
  const { exclusions = [] } = await chrome.storage.sync.get('exclusions');
  exclusionTextarea.value = exclusions.join('\n');
}

async function saveExclusions() {
  const exclusions = exclusionTextarea.value
    .split('\n')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .filter(s => s.length <= 253)
    .slice(0, 100);
  await chrome.storage.sync.set({ exclusions });
  saveStatus.textContent = 'Saved.';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveStatus.textContent = ''; }, 1500);
}

saveExclusionsBtn.addEventListener('click', saveExclusions);

// ─── Sleep / wake buttons ─────────────────────────────────────────────────────

sleepTabBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await chrome.runtime.sendMessage({ action: 'sleepCurrentTab', tabId: tab.id });
  window.close();
});

sleepAllBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'sleepAllTabs' });
  window.close();
});

wakeAllBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'wakeAllTabs' });
  loadSleepingTabs();
});

// ─── Event listeners ──────────────────────────────────────────────────────────

autoSleepToggle.addEventListener('change', () => {
  timeoutRow.style.display = autoSleepToggle.checked ? 'flex' : 'none';
  saveSettings();
});

timeoutInput.addEventListener('change', saveSettings);

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSettings();
loadSleepingTabs();
loadNeverSleep();
loadExclusions();
