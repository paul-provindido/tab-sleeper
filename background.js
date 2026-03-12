// ─── Constants ───────────────────────────────────────────────────────────────

const SLEEP_PAGE_BASE = chrome.runtime.getURL('sleep.html');
const ALARM_NAME = 'tabSleepCheck';
const ALARM_PERIOD_MINUTES = 1;
const DEFAULT_TIMEOUT_MINUTES = 30;
const CONTEXT_MENU_ID = 'sleepTab';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSleepable(tab, { allowActive = false } = {}) {
  if (!tab.url) return false;
  if (!allowActive && tab.active) return false;
  if (tab.pinned) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://'];
  return !blocked.some(prefix => tab.url.startsWith(prefix));
}

async function sleepTab(tab) {
  const params = new URLSearchParams({
    url:   tab.url,
    title: tab.title || tab.url
  });
  const sleepUrl = `${SLEEP_PAGE_BASE}?${params.toString()}`;
  await chrome.tabs.update(tab.id, { url: sleepUrl });
  await chrome.storage.local.set({
    [`tab_${tab.id}`]: { lastActiveAt: Date.now(), sleeping: true }
  });
}

async function getSettings() {
  const defaults = {
    autoSleepEnabled: true,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES
  };
  return chrome.storage.sync.get(defaults);
}

// ─── Initialization ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // Set up context menu
  chrome.contextMenus.create({
    id:       CONTEXT_MENU_ID,
    title:    'Sleep Tab',
    contexts: ['page']
  });

  // Create the inactivity check alarm
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: ALARM_PERIOD_MINUTES
  });

  // Seed all currently-open tabs with a lastActiveAt timestamp
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const existing = await chrome.storage.local.get(null);
  const toSet = {};
  for (const tab of tabs) {
    const key = `tab_${tab.id}`;
    if (!existing[key]) {
      toSet[key] = { lastActiveAt: now, sleeping: false };
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
});

// Re-create alarm if the service worker restarted without an install event
chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: ALARM_PERIOD_MINUTES
    });
  }
});

// ─── Auto-sleep alarm ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const { autoSleepEnabled, timeoutMinutes } = await getSettings();
  if (!autoSleepEnabled) return;

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;

  for (const tab of tabs) {
    if (!isSleepable(tab)) continue;

    const stored = await chrome.storage.local.get(`tab_${tab.id}`);
    const entry = stored[`tab_${tab.id}`];
    if (!entry) continue;
    if (entry.sleeping) continue;

    const elapsed = now - entry.lastActiveAt;
    if (elapsed >= timeoutMs) {
      await sleepTab(tab);
    }
  }
});

// ─── Tab lifecycle tracking ───────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await chrome.storage.local.set({
    [`tab_${tabId}`]: { lastActiveAt: Date.now(), sleeping: false }
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Only reset timer when the user (or a page) navigates somewhere
  // that is NOT our own sleep page
  if (changeInfo.url && !changeInfo.url.startsWith(SLEEP_PAGE_BASE)) {
    const stored = await chrome.storage.local.get(`tab_${tabId}`);
    const entry = stored[`tab_${tabId}`] || {};
    await chrome.storage.local.set({
      [`tab_${tabId}`]: { ...entry, lastActiveAt: Date.now(), sleeping: false }
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_${tabId}`);
});

// ─── Context menu ─────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  if (!tab || !isSleepable(tab, { allowActive: true })) return;
  await sleepTab(tab);
});

// ─── Messages (from popup) ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getSleepingCount') {
    chrome.storage.local.get(null, (allItems) => {
      const count = Object.values(allItems).filter(v => v && v.sleeping).length;
      sendResponse({ count });
    });
    return true; // keep message channel open for async sendResponse
  }
});
