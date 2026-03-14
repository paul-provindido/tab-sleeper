const autoSleepToggle      = document.getElementById('autoSleepToggle');
const timeoutInput         = document.getElementById('timeoutInput');
const timeoutRow           = document.getElementById('timeoutRow');
const autoWakeToggle       = document.getElementById('autoWakeToggle');
const autoWakeInput        = document.getElementById('autoWakeInput');
const autoWakeRow          = document.getElementById('autoWakeRow');
const sleepingCount        = document.getElementById('sleepingCount');
const saveStatus           = document.getElementById('saveStatus');
const neverSleepToggle     = document.getElementById('neverSleepToggle');
const sleepTabBtn          = document.getElementById('sleepTabBtn');
const sleepAllBtn          = document.getElementById('sleepAllBtn');
const wakeAllBtn           = document.getElementById('wakeAllBtn');
const sleepingTabsList     = document.getElementById('sleepingTabsList');
const exclusionTextarea    = document.getElementById('exclusionTextarea');
const domainTimeoutTextarea  = document.getElementById('domainTimeoutTextarea');
const saveDomainTimeoutsBtn  = document.getElementById('saveDomainTimeoutsBtn');

let saveTimer = null;

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const {
    autoSleepEnabled = true,
    timeoutMinutes   = 30,
    autoWakeEnabled  = false,
    autoWakeHours    = 2
  } = await chrome.storage.sync.get(['autoSleepEnabled', 'timeoutMinutes', 'autoWakeEnabled', 'autoWakeHours']);

  autoSleepToggle.checked   = autoSleepEnabled;
  timeoutInput.value        = timeoutMinutes;
  timeoutRow.style.display  = autoSleepEnabled ? 'flex' : 'none';
  autoWakeToggle.checked    = autoWakeEnabled;
  autoWakeInput.value       = autoWakeHours;
  autoWakeRow.style.display = autoWakeEnabled ? 'flex' : 'none';
}

async function saveSettings() {
  let minutes = parseInt(timeoutInput.value, 10);
  if (isNaN(minutes) || minutes < 1) minutes = 1;
  if (minutes > 480) minutes = 480;
  timeoutInput.value = minutes;

  let hours = parseInt(autoWakeInput.value, 10);
  if (isNaN(hours) || hours < 1) hours = 1;
  if (hours > 24) hours = 24;
  autoWakeInput.value = hours;

  await chrome.storage.sync.set({
    autoSleepEnabled: autoSleepToggle.checked,
    timeoutMinutes:   minutes,
    autoWakeEnabled:  autoWakeToggle.checked,
    autoWakeHours:    hours
  });
  showSaveStatus('Saved.');
}

function showSaveStatus(msg) {
  saveStatus.textContent = msg;
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
  showSaveStatus('Saved.');
}

exclusionTextarea.addEventListener('blur', saveExclusions);

// ─── Per-domain timeout ───────────────────────────────────────────────────────

async function loadDomainTimeouts() {
  const { domainTimeouts = {} } = await chrome.storage.sync.get('domainTimeouts');
  domainTimeoutTextarea.value = Object.entries(domainTimeouts)
    .map(([d, m]) => `${d}:${m}`)
    .join('\n');
}

async function saveDomainTimeouts() {
  const domainTimeouts = {};
  for (const line of domainTimeoutTextarea.value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon   = trimmed.lastIndexOf(':');
    if (colon < 1) continue;
    const domain  = trimmed.slice(0, colon).trim().toLowerCase();
    const minutes = parseInt(trimmed.slice(colon + 1), 10);
    if (!domain || domain.length > 253) continue;
    if (isNaN(minutes) || minutes < 1 || minutes > 480) continue;
    domainTimeouts[domain] = minutes;
  }
  await chrome.storage.sync.set({ domainTimeouts });
  showSaveStatus('Saved.');
}

saveDomainTimeoutsBtn.addEventListener('click', async () => {
  await saveSettings();
  await saveExclusions();
  await saveDomainTimeouts();
});

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

autoWakeToggle.addEventListener('change', () => {
  autoWakeRow.style.display = autoWakeToggle.checked ? 'flex' : 'none';
  saveSettings();
});

timeoutInput.addEventListener('change', saveSettings);
autoWakeInput.addEventListener('change', saveSettings);

// ─── Init ─────────────────────────────────────────────────────────────────────

loadSettings();
loadSleepingTabs();
loadNeverSleep();
loadExclusions();
loadDomainTimeouts();
