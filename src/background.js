// ─── Constants ───────────────────────────────────────────────────────────────

const SLEEP_PAGE_BASE = chrome.runtime.getURL('sleep.html');
const ALARM_NAME = 'tabSleepCheck';
const ALARM_PERIOD_MINUTES = 1;
const DEFAULT_TIMEOUT_MINUTES = 30;
const CONTEXT_MENU_ID            = 'sleepTab';
const CONTEXT_MENU_NEVER_SLEEP_ID = 'neverSleepTab';

// Tabs currently being navigated to sleep.html for the first time.
// Used to distinguish initial sleep navigation from a user-triggered refresh.
const pendingSleepTabs = new Set();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSafeUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

function isSleepable(tab, { allowActive = false, exclusions = [] } = {}) {
  if (!isSafeUrl(tab.url)) return false;
  if (!allowActive && tab.active) return false;

  if (exclusions.length > 0) {
    try {
      const host = new URL(tab.url).hostname.toLowerCase();
      if (exclusions.some(domain => domainMatches(host, domain))) return false;
    } catch { return false; }
  }
  return true;
}

function normalizeDomain(domain) {
  return typeof domain === 'string'
    ? domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
    : '';
}

function domainMatches(host, domain) {
  const normalized = normalizeDomain(domain);
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
}

async function markTabAwake(tabId, entry = {}) {
  const { originalUrl: _originalUrl, sleepMode: _sleepMode, ...awakeEntry } = entry;
  await chrome.storage.local.set({
    [`tab_${tabId}`]: { ...awakeEntry, lastActiveAt: Date.now(), sleeping: false }
  });
}

async function markTabSleeping(tab, entry, now, sleepMode) {
  await chrome.storage.local.set({
    [`tab_${tab.id}`]: {
      ...entry,
      lastActiveAt: now,
      sleeping:     true,
      sleepMode,
      originalUrl:  tab.url
    }
  });
}

async function sleepTabWithPage(tab, entry, now) {
  const params = new URLSearchParams({
    url:   tab.url,
    title: (tab.title || tab.url).slice(0, 500),
    icon:  (tab.favIconUrl || '').slice(0, 2048),
    ts:    String(now)
  });
  const sleepUrl = `${SLEEP_PAGE_BASE}?${params.toString()}`;
  setPendingSleep(tab.id);
  try {
    await chrome.tabs.update(tab.id, { url: sleepUrl });
    await markTabSleeping(tab, entry, now, 'page');
    return true;
  } catch (error) {
    pendingSleepTabs.delete(tab.id);
    throw error;
  }
}

async function sleepTab(tab) {
  const now = Date.now();
  const stored = await chrome.storage.local.get(`tab_${tab.id}`);
  const entry  = stored[`tab_${tab.id}`] || {};

  if (chrome.tabs.discard && !tab.active) {
    if (tab.discarded) {
      await markTabSleeping(tab, entry, now, 'discard');
      return true;
    }

    const discardedTab = await chrome.tabs.discard(tab.id);
    if (discardedTab?.discarded) {
      await markTabSleeping(tab, entry, now, 'discard');
      return true;
    }
  }

  const currentTab = await chrome.tabs.get(tab.id);
  return sleepTabWithPage(currentTab, entry, now);
}

function setPendingSleep(tabId) {
  pendingSleepTabs.add(tabId);
  setTimeout(() => pendingSleepTabs.delete(tabId), 30000);
}

async function prepareActiveTabsForDiscard(tabs, allTabs) {
  if (!chrome.tabs.discard) return;

  const targetIds = new Set(tabs.map(tab => tab.id));
  for (const tab of tabs.filter(candidate => candidate.active)) {
    const replacement = allTabs.find(candidate => (
      candidate.windowId === tab.windowId &&
      !candidate.active &&
      !candidate.discarded &&
      !targetIds.has(candidate.id) &&
      !candidate.url?.startsWith(SLEEP_PAGE_BASE)
    ));

    if (replacement) {
      await chrome.tabs.update(replacement.id, { active: true });
    } else {
      await chrome.tabs.create({ active: true, windowId: tab.windowId });
    }
  }
}

async function sleepTabs(tabs, {
  allowActive = false,
  exclusions = [],
  neverSleepUrls = [],
  usePageForActive = false,
  usePageForAll = false
} = {}) {
  const targets = tabs.filter(tab => (
    isSleepable(tab, { allowActive, exclusions }) &&
    !neverSleepUrls.includes(tab.url)
  ));

  const allTabs = await chrome.tabs.query({});
  await prepareActiveTabsForDiscard(
    targets.filter(tab => !usePageForAll && !(usePageForActive && tab.active)),
    allTabs
  );

  const results = await Promise.all(targets.map(async tab => {
    try {
      const currentTab = await chrome.tabs.get(tab.id);
      if (usePageForAll || (usePageForActive && currentTab.active)) {
        const now = Date.now();
        const stored = await chrome.storage.local.get(`tab_${currentTab.id}`);
        const entry  = stored[`tab_${currentTab.id}`] || {};
        return sleepTabWithPage(currentTab, entry, now);
      }
      return sleepTab(currentTab);
    } catch {
      return false;
    }
  }));

  const slept = results.filter(Boolean).length;

  return { eligible: targets.length, slept };
}

// After a browser restart Chrome may assign new tab IDs. Reconcile restored
// sleep pages and extension-owned discarded tabs without claiming tabs that
// Chrome discarded independently.
async function redetectSleepingTabs({ preserveUnmatchedSleeping = false } = {}) {
  const tabs     = await chrome.tabs.query({});
  const allItems = await chrome.storage.local.get(null);
  const toSet    = {};
  const reservedKeys = new Set();
  const discardEntriesByUrl = new Map();
  const discardedTabsByUrl = new Map();
  const migratedDiscardEntries = new Map();

  for (const tab of tabs) {
    const key   = `tab_${tab.id}`;
    const entry = allItems[key];
    if (
      tab.discarded &&
      entry?.sleeping &&
      entry.sleepMode === 'discard' &&
      entry.originalUrl === tab.url
    ) {
      reservedKeys.add(key);
    }
  }

  for (const [key, entry] of Object.entries(allItems)) {
    if (
      !key.startsWith('tab_') ||
      reservedKeys.has(key) ||
      !entry?.sleeping ||
      entry.sleepMode !== 'discard' ||
      !isSafeUrl(entry.originalUrl)
    ) {
      continue;
    }

    const entries = discardEntriesByUrl.get(entry.originalUrl) || [];
    entries.push(entry);
    discardEntriesByUrl.set(entry.originalUrl, entries);
  }

  for (const tab of tabs) {
    const key = `tab_${tab.id}`;
    if (!tab.discarded || reservedKeys.has(key) || !isSafeUrl(tab.url)) continue;
    const matchingTabs = discardedTabsByUrl.get(tab.url) || [];
    matchingTabs.push(tab);
    discardedTabsByUrl.set(tab.url, matchingTabs);
  }

  for (const [url, entries] of discardEntriesByUrl) {
    const matchingTabs = discardedTabsByUrl.get(url) || [];
    if (entries.length !== matchingTabs.length) continue;
    matchingTabs.forEach((tab, index) => migratedDiscardEntries.set(tab.id, entries[index]));
  }

  for (const tab of tabs) {
    if (!tab.url) continue;
    const key      = `tab_${tab.id}`;
    const existing = allItems[key];

    if (reservedKeys.has(key)) continue;

    if (tab.discarded && isSafeUrl(tab.url)) {
      const matchingEntry = migratedDiscardEntries.get(tab.id);
      toSet[key] = matchingEntry
        ? { ...matchingEntry, sleeping: true, sleepMode: 'discard', originalUrl: tab.url }
        : { lastActiveAt: Date.now(), sleeping: false };
      continue;
    }

    if (!tab.url.startsWith(SLEEP_PAGE_BASE)) {
      if (!existing || (existing.sleeping && !preserveUnmatchedSleeping)) {
        toSet[key] = { lastActiveAt: Date.now(), sleeping: false };
      }
      continue;
    }

    try {
      const params      = new URLSearchParams(new URL(tab.url).search);
      const originalUrl = params.get('url') || '';
      if (!originalUrl || !isSafeUrl(originalUrl)) continue;
      toSet[key] = {
        sleeping:     true,
        sleepMode:    'page',
        originalUrl,
        lastActiveAt: Number(params.get('ts')) || Date.now()
      };
    } catch {
      toSet[key] = { lastActiveAt: Date.now(), sleeping: false };
    }
  }

  if (Object.keys(toSet).length > 0) await chrome.storage.local.set(toSet);
}

async function wakeTab(tabId) {
  const stored = await chrome.storage.local.get(`tab_${tabId}`);
  const entry  = stored[`tab_${tabId}`];
  if (!entry || !entry.sleeping) return false;
  const url = entry.originalUrl;
  if (!url || !isSafeUrl(url)) return false;
  if (entry.sleepMode === 'discard') {
    await chrome.tabs.reload(tabId);
  } else {
    await chrome.tabs.update(tabId, { url });
  }
  await markTabAwake(tabId, entry);
  return true;
}

async function getExclusions() {
  const { exclusions = [] } = await chrome.storage.sync.get('exclusions');
  return Array.isArray(exclusions)
    ? [...new Set(exclusions.map(normalizeDomain).filter(Boolean))].slice(0, 100)
    : [];
}

async function getSettings() {
  const defaults = {
    autoSleepEnabled: true,
    timeoutMinutes:   DEFAULT_TIMEOUT_MINUTES,
    autoWakeEnabled:  false,
    autoWakeHours:    2
  };
  const settings = await chrome.storage.sync.get(defaults);
  return {
    autoSleepEnabled: true === settings.autoSleepEnabled,
    timeoutMinutes:   normalizeNumber(settings.timeoutMinutes, 1, 480, DEFAULT_TIMEOUT_MINUTES),
    autoWakeEnabled:  true === settings.autoWakeEnabled,
    autoWakeHours:    normalizeNumber(settings.autoWakeHours, 1, 24, 2)
  };
}

function normalizeNumber(value, min, max, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

async function getNeverSleepUrls() {
  const { neverSleepUrls = [] } = await chrome.storage.local.get('neverSleepUrls');
  return Array.isArray(neverSleepUrls)
    ? [...new Set(neverSleepUrls.filter(isSafeUrl))]
    : [];
}

async function getDomainTimeouts() {
  const { domainTimeouts = {} } = await chrome.storage.sync.get('domainTimeouts');
  if (!domainTimeouts || typeof domainTimeouts !== 'object' || Array.isArray(domainTimeouts)) return {};
  const safeEntries = [];
  for (const [k, v] of Object.entries(domainTimeouts)) {
    const domain  = normalizeDomain(k);
    const minutes = normalizeNumber(v, 1, 480, 0);
    if (domain && minutes) safeEntries.push([domain, minutes]);
  }
  return Object.fromEntries(safeEntries);
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

chrome.runtime.onInstalled.addListener(async (details) => {
  if (chrome.contextMenus) {
    await chrome.contextMenus.removeAll();
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

  await redetectSleepingTabs({ preserveUnmatchedSleeping: details?.reason === 'chrome_update' });
  if (details?.reason !== 'chrome_update') await cleanupStaleTabs();
  await updateBadge();
});

chrome.alarms.get(ALARM_NAME, async (alarm) => {
  if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  // Re-create entries visible during initial session restore. Do not remove
  // unmatched entries yet; Chrome may still be restoring their tabs.
  await redetectSleepingTabs({ preserveUnmatchedSleeping: true });
  await updateBadge();
});

// ─── Auto-sleep alarm ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // Reconcile once more before delayed cleanup so late-restored tabs keep
  // their sleeping state.
  await redetectSleepingTabs();
  await cleanupStaleTabs();

  const { autoSleepEnabled, timeoutMinutes, autoWakeEnabled, autoWakeHours } = await getSettings();
  const exclusions     = await getExclusions();
  const domainTimeouts = await getDomainTimeouts();
  const neverSleepUrls = await getNeverSleepUrls();
  const tabs           = await chrome.tabs.query({});
  const now            = Date.now();
  const defaultMs      = timeoutMinutes * 60 * 1000;
  const autoWakeMs     = autoWakeHours  * 60 * 60 * 1000;

  for (const tab of tabs) {
    const stored = await chrome.storage.local.get(`tab_${tab.id}`);
    const entry  = stored[`tab_${tab.id}`];
    if (!entry) continue;

    if (entry.sleeping) {
      if (entry.sleepMode === 'discard' && false === tab.discarded) {
        await markTabAwake(tab.id, entry);
        continue;
      }
      if (autoWakeEnabled && (now - entry.lastActiveAt) >= autoWakeMs) {
        try { await wakeTab(tab.id); } catch {}
      }
    } else {
      if (!autoSleepEnabled) continue;
      if (!isSleepable(tab, { exclusions })) continue;
      if (neverSleepUrls.includes(tab.url)) continue;
      let timeoutMs = defaultMs;
      try {
        const host = new URL(tab.url).hostname;
        for (const [domain, minutes] of Object.entries(domainTimeouts)) {
          if (domainMatches(host, domain)) { timeoutMs = minutes * 60 * 1000; break; }
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
  if (entry.sleeping && entry.sleepMode === 'discard') {
    await markTabAwake(tabId, entry);
  } else if (!entry.sleeping) {
    await markTabAwake(tabId, entry);
  }
  if (chrome.contextMenus) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const neverSleepUrls = await getNeverSleepUrls();
    try {
      await chrome.contextMenus.update(
        CONTEXT_MENU_NEVER_SLEEP_ID,
        { checked: neverSleepUrls.includes(tab?.url) }
      );
    } catch {}
  }
  await updateBadge();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (typeof tab.id !== 'number') return;
  await chrome.storage.local.set({
    [`tab_${tab.id}`]: { lastActiveAt: Date.now(), sleeping: false }
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (false === changeInfo.discarded) {
    const stored = await chrome.storage.local.get(`tab_${tabId}`);
    const entry  = stored[`tab_${tabId}`] || {};
    if (entry.sleeping && entry.sleepMode === 'discard') {
      await markTabAwake(tabId, entry);
      await updateBadge();
    }
    return;
  }

  // Initial sleep navigation complete — clear the pending flag
  if (pendingSleepTabs.has(tabId) && changeInfo.status === 'complete') {
    pendingSleepTabs.delete(tabId);
    return;
  }

  if (changeInfo.url) {
    if (changeInfo.url.startsWith(SLEEP_PAGE_BASE)) {
      // Tab is being navigated to sleep.html for the first time — do nothing
      return;
    }
    // Navigating away from sleep.html to a real URL
    pendingSleepTabs.delete(tabId);
    const stored = await chrome.storage.local.get(`tab_${tabId}`);
    const entry  = stored[`tab_${tabId}`] || {};
    await markTabAwake(tabId, entry);
    if (entry.sleeping) await updateBadge();
    return;
  }

  // No URL change + status loading + not a pending sleep = user refreshed the page
  if (changeInfo.status === 'loading' && !pendingSleepTabs.has(tabId)) {
    const stored = await chrome.storage.local.get(`tab_${tabId}`);
    const entry  = stored[`tab_${tabId}`] || {};
    if (!entry.sleeping) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (entry.sleepMode === 'discard' && false === tab.discarded) {
        await markTabAwake(tabId, entry);
        await updateBadge();
      } else if (tab.url?.startsWith(SLEEP_PAGE_BASE)) {
        await wakeTab(tabId);
        await updateBadge();
      }
    } catch {}
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  pendingSleepTabs.delete(tabId);
  await chrome.storage.local.remove(`tab_${tabId}`);
  await updateBadge();
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const removedKey = `tab_${removedTabId}`;
  const stored     = await chrome.storage.local.get(removedKey);
  const entry      = stored[removedKey] || { lastActiveAt: Date.now(), sleeping: false };

  if (pendingSleepTabs.delete(removedTabId)) setPendingSleep(addedTabId);
  await chrome.storage.local.set({ [`tab_${addedTabId}`]: entry });
  await chrome.storage.local.remove(removedKey);
});

// ─── Context menu ─────────────────────────────────────────────────────────────

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab) return;

    if (info.menuItemId === CONTEXT_MENU_ID) {
      const exclusions     = await getExclusions();
      const neverSleepUrls = await getNeverSleepUrls();
      await sleepTabs([tab], { allowActive: true, exclusions, neverSleepUrls, usePageForAll: true });
      await updateBadge();
      return;
    }

    if (info.menuItemId === CONTEXT_MENU_NEVER_SLEEP_ID) {
      const neverSleepUrls = await getNeverSleepUrls();
      const updated = info.checked
        ? [...new Set([...neverSleepUrls, tab.url])]
        : neverSleepUrls.filter(u => u !== tab.url);
      await chrome.storage.local.set({ neverSleepUrls: updated });
    }
  });
}

// ─── Keyboard shortcut ───────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'sleep-current-tab') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const exclusions     = await getExclusions();
  const neverSleepUrls = await getNeverSleepUrls();
  await sleepTabs([tab], { allowActive: true, exclusions, neverSleepUrls, usePageForAll: true });
  await updateBadge();
});

// ─── Messages (from popup) ────────────────────────────────────────────────────

function respondAsync(sendResponse, task) {
  task()
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false }));
  return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getSleepingTabs') {
    return respondAsync(sendResponse, async () => {
      const allItems = await chrome.storage.local.get(null);
      const tabs     = await chrome.tabs.query({});
      const result   = [];
      for (const tab of tabs) {
        const entry = allItems[`tab_${tab.id}`];
        if (entry && entry.sleeping) {
          result.push({ tabId: tab.id, title: tab.title, originalUrl: entry.originalUrl });
        }
      }
      return { tabs: result };
    });
  }

  if (message.action === 'wakeTab') {
    return respondAsync(sendResponse, async () => {
      const woke = await wakeTab(message.tabId);
      await updateBadge();
      return { ok: woke };
    });
  }

  if (message.action === 'wakeAllTabs') {
    return respondAsync(sendResponse, async () => {
      const allItems = await chrome.storage.local.get(null);
      const tabs     = await chrome.tabs.query({});
      let eligible   = 0;
      let woke       = 0;
      for (const tab of tabs) {
        const entry = allItems[`tab_${tab.id}`];
        if (entry && entry.sleeping) {
          eligible++;
          try {
            if (await wakeTab(tab.id)) woke++;
          } catch {}
        }
      }
      await updateBadge();
      return { eligible, ok: woke === eligible, woke };
    });
  }

  if (message.action === 'sleepCurrentTab') {
    return respondAsync(sendResponse, async () => {
      const tab = await chrome.tabs.get(message.tabId);
      const exclusions     = await getExclusions();
      const neverSleepUrls = await getNeverSleepUrls();
      const result = await sleepTabs([tab], {
        allowActive: true,
        exclusions,
        neverSleepUrls,
        usePageForAll: true
      });
      await updateBadge();
      return { ok: result.eligible > 0 && result.slept === result.eligible, ...result };
    });
  }

  if (message.action === 'sleepAllTabs') {
    return respondAsync(sendResponse, async () => {
      const exclusions     = await getExclusions();
      const neverSleepUrls = await getNeverSleepUrls();
      const tabs   = await chrome.tabs.query({});
      const result = await sleepTabs(tabs, { exclusions, neverSleepUrls, usePageForAll: true });
      await updateBadge();
      return { ok: result.eligible > 0 && result.slept === result.eligible, ...result };
    });
  }

  if (message.action === 'sleepAllTabsIncludingActive') {
    return respondAsync(sendResponse, async () => {
      const exclusions     = await getExclusions();
      const neverSleepUrls = await getNeverSleepUrls();
      const tabs   = await chrome.tabs.query({});
      const result = await sleepTabs(tabs, { allowActive: true, exclusions, neverSleepUrls, usePageForAll: true });
      await updateBadge();
      return { ok: result.eligible > 0 && result.slept === result.eligible, ...result };
    });
  }
});
