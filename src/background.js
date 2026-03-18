// ─── Constants ───────────────────────────────────────────────────────────────

const SLEEP_PAGE_BASE = chrome.runtime.getURL('sleep.html');
const ALARM_NAME = 'tabSleepCheck';
const ALARM_PERIOD_MINUTES = 1;
const DEFAULT_TIMEOUT_MINUTES = 30;
const CONTEXT_MENU_ID            = 'sleepTab';
const CONTEXT_MENU_NEVER_SLEEP_ID = 'neverSleepTab';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSafeUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

function isSleepable(tab, { allowActive = false, exclusions = [] } = {}) {
  if (!tab.url) return false;
  if (!allowActive && tab.active) return false;
  if (tab.pinned) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'javascript:', 'data:'];
  if (blocked.some(prefix => tab.url.startsWith(prefix))) return false;
  if (exclusions.length > 0) {
    try {
      const host = new URL(tab.url).hostname;
      if (exclusions.some(e => host.includes(e))) return false;
    } catch { return false; }
  }
  return true;
}

async function sleepTab(tab) {
  const now = Date.now();
  const params = new URLSearchParams({
    url:   tab.url,
    title: (tab.title || tab.url).slice(0, 500),
    icon:  tab.favIconUrl || '',
    ts:    String(now)   // sleep timestamp — recovered on browser restart
  });
  const sleepUrl = `${SLEEP_PAGE_BASE}?${params.toString()}`;
  await chrome.tabs.update(tab.id, { url: sleepUrl });
  const stored = await chrome.storage.local.get(`tab_${tab.id}`);
  const entry  = stored[`tab_${tab.id}`] || {};
  await chrome.storage.local.set({
    [`tab_${tab.id}`]: { ...entry, lastActiveAt: now, sleeping: true, originalUrl: tab.url }
  });
}

// After a browser restart Chrome assigns new tab IDs, so storage entries from
// the previous session (keyed by old tab IDs) no longer match. Scan all tabs
// for ones still showing sleep.html and re-create their storage entries with
// the current tab IDs so the badge and sleeping-tab list are correct.
async function redetectSleepingTabs() {
  const tabs     = await chrome.tabs.query({});
  const allItems = await chrome.storage.local.get(null);
  const toSet    = {};

  for (const tab of tabs) {
    if (!tab.url || !tab.url.startsWith(SLEEP_PAGE_BASE)) continue;
    const key = `tab_${tab.id}`;
    if (allItems[key]?.sleeping) continue; // already tracked under this ID

    try {
      const params      = new URLSearchParams(new URL(tab.url).search);
      const originalUrl = params.get('url') || '';
      if (!originalUrl || !isSafeUrl(originalUrl)) continue;
      toSet[key] = {
        sleeping:     true,
        originalUrl,
        lastActiveAt: Number(params.get('ts')) || Date.now()
      };
    } catch {}
  }

  if (Object.keys(toSet).length > 0) await chrome.storage.local.set(toSet);
}

async function wakeTab(tabId) {
  const stored = await chrome.storage.local.get(`tab_${tabId}`);
  const entry  = stored[`tab_${tabId}`];
  if (!entry || !entry.sleeping) return;
  const url = entry.originalUrl;
  if (!url || !isSafeUrl(url)) return;
  await chrome.tabs.update(tabId, { url });
  await chrome.storage.local.set({
    [`tab_${tabId}`]: { ...entry, sleeping: false, lastActiveAt: Date.now() }
  });
}

async function getExclusions() {
  const { exclusions = [] } = await chrome.storage.sync.get('exclusions');
  return Array.isArray(exclusions) ? exclusions.filter(e => typeof e === 'string') : [];
}

async function getSettings() {
  const defaults = {
    autoSleepEnabled: true,
    timeoutMinutes:   DEFAULT_TIMEOUT_MINUTES,
    autoWakeEnabled:  false,
    autoWakeHours:    2
  };
  return chrome.storage.sync.get(defaults);
}

async function getDomainTimeouts() {
  const { domainTimeouts = {} } = await chrome.storage.sync.get('domainTimeouts');
  if (!domainTimeouts || typeof domainTimeouts !== 'object' || Array.isArray(domainTimeouts)) return {};
  const safe = {};
  for (const [k, v] of Object.entries(domainTimeouts)) {
    if (typeof k === 'string' && Number.isFinite(v) && v >= 1) safe[k] = v;
  }
  return safe;
}

async function updateBadge() {
  await chrome.action.setBadgeText({ text: '' });
}

async function cleanupStaleTabs() {
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map(t => `tab_${t.id}`));
  const allItems = await chrome.storage.local.get(null);
  const staleKeys = Object.keys(allItems).filter(k => k.startsWith('tab_') && !liveIds.has(k));
  if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys);
}

// ─── Initialization ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.contextMenus) {
    chrome.contextMenus.create({
      id:       CONTEXT_MENU_ID,
      title:    'Sleep Tab',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id:       CONTEXT_MENU_NEVER_SLEEP_ID,
      title:    "Never sleep this tab",
      type:     'checkbox',
      checked:  false,
      contexts: ['page']
    });
  }

  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const existing = await chrome.storage.local.get(null);
  const toSet = {};
  for (const tab of tabs) {
    const key = `tab_${tab.id}`;
    if (!existing[key]) toSet[key] = { lastActiveAt: now, sleeping: false };
  }
  if (Object.keys(toSet).length > 0) await chrome.storage.local.set(toSet);

  await cleanupStaleTabs();
  await updateBadge();
});

chrome.alarms.get(ALARM_NAME, async (alarm) => {
  if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  // Re-create storage entries for sleeping tabs using their new tab IDs
  // (Chrome assigns fresh IDs after every restart/profile switch)
  await redetectSleepingTabs();
  await cleanupStaleTabs();
  await updateBadge();
});

// ─── Auto-sleep alarm ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // Cleanup runs here, well after session restore has had time to complete
  await cleanupStaleTabs();

  const { autoSleepEnabled, timeoutMinutes, autoWakeEnabled, autoWakeHours } = await getSettings();
  const exclusions     = await getExclusions();
  const domainTimeouts = await getDomainTimeouts();
  const tabs           = await chrome.tabs.query({});
  const now            = Date.now();
  const defaultMs      = timeoutMinutes * 60 * 1000;
  const autoWakeMs     = autoWakeHours  * 60 * 60 * 1000;

  for (const tab of tabs) {
    const stored = await chrome.storage.local.get(`tab_${tab.id}`);
    const entry  = stored[`tab_${tab.id}`];
    if (!entry) continue;

    if (entry.sleeping) {
      if (autoWakeEnabled && (now - entry.lastActiveAt) >= autoWakeMs) {
        try { await wakeTab(tab.id); } catch {}
      }
    } else {
      if (!autoSleepEnabled) continue;
      if (!isSleepable(tab, { exclusions })) continue;
      if (entry.neverSleep) continue;
      let timeoutMs = defaultMs;
      try {
        const host = new URL(tab.url).hostname;
        for (const [domain, minutes] of Object.entries(domainTimeouts)) {
          if (host.includes(domain)) { timeoutMs = minutes * 60 * 1000; break; }
        }
      } catch {}
      if ((now - entry.lastActiveAt) >= timeoutMs) await sleepTab(tab);
    }
  }
  await updateBadge();
});

// ─── Tab lifecycle tracking ───────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const stored = await chrome.storage.local.get(`tab_${tabId}`);
  const entry  = stored[`tab_${tabId}`] || {};
  if (!entry.sleeping) {
    await chrome.storage.local.set({
      [`tab_${tabId}`]: { ...entry, lastActiveAt: Date.now(), sleeping: false }
    });
  }
  if (chrome.contextMenus) {
    chrome.contextMenus.update(CONTEXT_MENU_NEVER_SLEEP_ID, { checked: !!entry.neverSleep });
  }
  await updateBadge();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url && !changeInfo.url.startsWith(SLEEP_PAGE_BASE)) {
    const stored = await chrome.storage.local.get(`tab_${tabId}`);
    const entry  = stored[`tab_${tabId}`] || {};
    await chrome.storage.local.set({
      [`tab_${tabId}`]: { ...entry, lastActiveAt: Date.now(), sleeping: false }
    });
    if (entry.sleeping) await updateBadge();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.local.remove(`tab_${tabId}`);
  await updateBadge();
});

// ─── Context menu ─────────────────────────────────────────────────────────────

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab) return;

    if (info.menuItemId === CONTEXT_MENU_ID) {
      const exclusions = await getExclusions();
      if (!isSleepable(tab, { allowActive: true, exclusions })) return;
      await sleepTab(tab);
      await updateBadge();
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_NEVER_SLEEP_ID) {
      const key    = `tab_${tab.id}`;
      const stored = await chrome.storage.local.get(key);
      const entry  = stored[key] || {};
      await chrome.storage.local.set({ [key]: { ...entry, neverSleep: info.checked } });
    }
  });
}

// ─── Keyboard shortcut ───────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'sleep-current-tab') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const exclusions = await getExclusions();
  if (isSleepable(tab, { allowActive: true, exclusions })) {
    await sleepTab(tab);
    await updateBadge();
  }
});

// ─── Messages (from popup) ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getSleepingTabs') {
    (async () => {
      const allItems = await chrome.storage.local.get(null);
      const tabs     = await chrome.tabs.query({});
      const result   = [];
      for (const tab of tabs) {
        const entry = allItems[`tab_${tab.id}`];
        if (entry && entry.sleeping) {
          result.push({ tabId: tab.id, title: tab.title, originalUrl: entry.originalUrl });
        }
      }
      sendResponse({ tabs: result });
    })();
    return true;
  }

  if (message.action === 'wakeTab') {
    (async () => {
      try { await wakeTab(message.tabId); } catch {}
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'wakeAllTabs') {
    (async () => {
      const allItems = await chrome.storage.local.get(null);
      const tabs     = await chrome.tabs.query({});
      for (const tab of tabs) {
        const entry = allItems[`tab_${tab.id}`];
        if (entry && entry.sleeping) {
          try { await wakeTab(tab.id); } catch {}
        }
      }
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'sleepCurrentTab') {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId);
        const exclusions = await getExclusions();
        if (isSleepable(tab, { allowActive: true, exclusions })) await sleepTab(tab);
      } catch {}
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'sleepAllTabs') {
    (async () => {
      const exclusions = await getExclusions();
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!isSleepable(tab, { exclusions })) continue;
        const stored = await chrome.storage.local.get(`tab_${tab.id}`);
        const entry  = stored[`tab_${tab.id}`] || {};
        if (entry.neverSleep) continue;
        try { await sleepTab(tab); } catch {}
      }
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'sleepAllTabsIncludingActive') {
    (async () => {
      const exclusions = await getExclusions();
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!isSleepable(tab, { allowActive: true, exclusions })) continue;
        const stored = await chrome.storage.local.get(`tab_${tab.id}`);
        const entry  = stored[`tab_${tab.id}`] || {};
        if (entry.neverSleep) continue;
        try { await sleepTab(tab); } catch {}
      }
      await updateBadge();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
