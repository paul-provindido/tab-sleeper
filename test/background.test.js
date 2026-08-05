'use strict';

const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const test   = require('node:test');
const vm     = require('node:vm');

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners
  };
}

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (null === keys) return structuredClone(data);
      if (typeof keys === 'string') {
        return Object.hasOwn(data, keys) ? { [keys]: structuredClone(data[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
      }
      return { ...structuredClone(keys), ...structuredClone(data) };
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function loadBackground({ tabs = [], local = {}, sync = {}, discard, update } = {}) {
  const tabState = structuredClone(tabs);
  const events = {
    onActivated: createEvent(),
    onCreated:   createEvent(),
    onRemoved:   createEvent(),
    onReplaced:  createEvent(),
    onUpdated:   createEvent()
  };
  const runtimeEvents = {
    onInstalled: createEvent(),
    onMessage:   createEvent()
  };
  const alarmEvents = { onAlarm: createEvent() };
  const localArea = createStorageArea(local);
  const syncArea  = createStorageArea(sync);
  const calls     = { created: [], discarded: [], updated: [] };

  const chrome = {
    action: {
      async setBadgeText() {}
    },
    alarms: {
      create() {},
      get(_name, _callback) {},
      ...alarmEvents
    },
    commands: {
      onCommand: createEvent()
    },
    contextMenus: {
      create() {},
      async removeAll() {},
      async update() {},
      onClicked: createEvent()
    },
    runtime: {
      getURL(file) {
        return `chrome-extension://test/${file}`;
      },
      ...runtimeEvents
    },
    storage: {
      local: localArea,
      sync:  syncArea
    },
    tabs: {
      ...events,
      async create(properties) {
        const id = Math.max(0, ...tabState.map(tab => tab.id)) + 1;
        if (properties.active) {
          for (const tab of tabState) {
            if (tab.windowId === properties.windowId) tab.active = false;
          }
        }
        const tab = {
          id,
          active:    Boolean(properties.active),
          discarded: false,
          index:     tabState.filter(item => item.windowId === properties.windowId).length,
          title:     'New Tab',
          url:       'chrome://newtab/',
          windowId:  properties.windowId
        };
        tabState.push(tab);
        calls.created.push(structuredClone(tab));
        return structuredClone(tab);
      },
      async discard(tabId) {
        const tab = tabState.find(item => item.id === tabId);
        calls.discarded.push(tabId);
        if (discard) return discard(tab, tabState);
        if (!tab || tab.active || tab.discarded) return undefined;
        tab.discarded = true;
        return structuredClone(tab);
      },
      async get(tabId) {
        const tab = tabState.find(item => item.id === tabId);
        if (!tab) throw new Error('No tab');
        return structuredClone(tab);
      },
      async query(queryInfo) {
        return structuredClone(tabState.filter(tab => (
          (undefined === queryInfo.active || tab.active === queryInfo.active) &&
          (undefined === queryInfo.windowId || tab.windowId === queryInfo.windowId)
        )));
      },
      async reload(tabId) {
        const tab = tabState.find(item => item.id === tabId);
        if (tab) tab.discarded = false;
      },
      async update(tabId, properties) {
        const tab = tabState.find(item => item.id === tabId);
        if (!tab) throw new Error('No tab');
        if (properties.active) {
          for (const item of tabState) {
            if (item.windowId === tab.windowId) item.active = false;
          }
          tab.active = true;
          tab.discarded = false;
        }
        if (properties.url) {
          tab.url = properties.url;
          tab.discarded = false;
        }
        calls.updated.push({ properties: structuredClone(properties), tabId });
        if (update) return update(tab, properties, tabState);
        return structuredClone(tab);
      }
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    Date,
    Map,
    Object,
    Set,
    setTimeout() {},
    URL,
    URLSearchParams
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });

  return {
    calls,
    context,
    installed: runtimeEvents.onInstalled.listeners,
    local: localArea.data,
    messages: runtimeEvents.onMessage.listeners,
    tabs: tabState
  };
}

function getFunction(context, name) {
  return vm.runInContext(name, context);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Sleep All moves focus to a new tab and discards every eligible original tab', async () => {
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: false, discarded: false, index: 1, title: 'Two', url: 'https://two.example/', windowId: 10 }
    ]
  });
  const sleepTabs = getFunction(harness.context, 'sleepTabs');

  const result = await sleepTabs(structuredClone(harness.tabs), { allowActive: true });

  assert.deepEqual(plain(result), { eligible: 2, slept: 2 });
  assert.equal(harness.calls.created.length, 1);
  assert.equal(harness.tabs.find(tab => 1 === tab.id).discarded, true);
  assert.equal(harness.tabs.find(tab => 2 === tab.id).discarded, true);
  assert.equal(harness.tabs.find(tab => tab.active).url, 'chrome://newtab/');
  assert.equal(harness.local.tab_1.sleepMode, 'discard');
  assert.equal(harness.local.tab_2.sleepMode, 'discard');
});

test('active tab uses an existing ineligible replacement when available', async () => {
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: false, discarded: false, index: 1, title: 'Settings', url: 'chrome://settings/', windowId: 10 }
    ]
  });
  const sleepTabs = getFunction(harness.context, 'sleepTabs');

  const result = await sleepTabs(structuredClone(harness.tabs), { allowActive: true });

  assert.deepEqual(plain(result), { eligible: 1, slept: 1 });
  assert.equal(harness.calls.created.length, 0);
  assert.equal(harness.tabs.find(tab => 1 === tab.id).discarded, true);
  assert.equal(harness.tabs.find(tab => 2 === tab.id).active, true);
});

test('manual current-tab sleep keeps focus and uses sleep page', async () => {
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: false, discarded: false, index: 1, title: 'Two', url: 'https://two.example/', windowId: 10 }
    ]
  });

  const response = await new Promise(resolve => {
    harness.messages[0]({ action: 'sleepCurrentTab', tabId: 1 }, {}, resolve);
  });

  assert.deepEqual(plain(response), { eligible: 1, ok: true, slept: 1 });
  assert.equal(harness.calls.created.length, 0);
  assert.deepEqual(harness.calls.discarded, []);
  assert.equal(harness.tabs.find(tab => 1 === tab.id).active, true);
  assert.match(harness.tabs.find(tab => 1 === tab.id).url, /^chrome-extension:\/\/test\/sleep\.html\?/);
  assert.equal(harness.local.tab_1.sleepMode, 'page');
});

test('manual Sleep All uses sleep pages without switching focus away', async () => {
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: false, discarded: false, index: 1, title: 'Two', url: 'https://two.example/', windowId: 10 }
    ]
  });

  const response = await new Promise(resolve => {
    harness.messages[0]({ action: 'sleepAllTabsIncludingActive' }, {}, resolve);
  });

  assert.deepEqual(plain(response), { eligible: 2, ok: true, slept: 2 });
  assert.equal(harness.calls.created.length, 0);
  assert.deepEqual(harness.calls.discarded, []);
  assert.equal(harness.tabs.find(tab => 1 === tab.id).active, true);
  assert.match(harness.tabs.find(tab => 1 === tab.id).url, /^chrome-extension:\/\/test\/sleep\.html\?/);
  assert.match(harness.tabs.find(tab => 2 === tab.id).url, /^chrome-extension:\/\/test\/sleep\.html\?/);
  assert.equal(harness.local.tab_1.sleepMode, 'page');
  assert.equal(harness.local.tab_2.sleepMode, 'page');
});

test('manual Sleep Other uses sleep pages and leaves active tab alone', async () => {
  const harness = loadBackground({
    tabs: [
      { id: 1, active: true, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: false, discarded: false, index: 1, title: 'Two', url: 'https://two.example/', windowId: 10 }
    ]
  });

  const response = await new Promise(resolve => {
    harness.messages[0]({ action: 'sleepAllTabs' }, {}, resolve);
  });

  assert.deepEqual(plain(response), { eligible: 1, ok: true, slept: 1 });
  assert.equal(harness.calls.created.length, 0);
  assert.deepEqual(harness.calls.discarded, []);
  assert.equal(harness.tabs.find(tab => 1 === tab.id).url, 'https://one.example/');
  assert.equal(harness.tabs.find(tab => 1 === tab.id).active, true);
  assert.match(harness.tabs.find(tab => 2 === tab.id).url, /^chrome-extension:\/\/test\/sleep\.html\?/);
  assert.equal(harness.local.tab_2.sleepMode, 'page');
});

test('manual bulk sleep starts every sleep-page navigation as one batch', async () => {
  let releaseFirstUpdate;
  const firstUpdate = new Promise(resolve => { releaseFirstUpdate = resolve; });
  const harness = loadBackground({
    tabs: [
      { id: 1, active: false, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: true, discarded: false, index: 1, title: 'Two', url: 'https://two.example/', windowId: 10 },
      { id: 3, active: false, discarded: false, index: 2, title: 'Three', url: 'https://three.example/', windowId: 10 }
    ],
    update(tab, properties) {
      if (1 === tab.id && properties.url) {
        return firstUpdate.then(() => structuredClone(tab));
      }
      return structuredClone(tab);
    }
  });
  const sleepTabs = getFunction(harness.context, 'sleepTabs');

  const sleepPromise = sleepTabs(structuredClone(harness.tabs), {
    allowActive: true,
    usePageForAll: true
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(harness.calls.updated.map(call => call.tabId), [1, 2, 3]);

  releaseFirstUpdate();
  assert.deepEqual(plain(await sleepPromise), { eligible: 3, slept: 3 });
});

test('failed native discard falls back without recording discard mode', async () => {
  const harness = loadBackground({
    discard() {
      return undefined;
    },
    tabs: [
      { id: 1, active: false, discarded: false, index: 0, title: 'One', url: 'https://one.example/', windowId: 10 },
      { id: 2, active: true, discarded: false, index: 1, title: 'Settings', url: 'chrome://settings/', windowId: 10 }
    ]
  });
  const sleepTab = getFunction(harness.context, 'sleepTab');

  assert.equal(await sleepTab(structuredClone(harness.tabs[0])), true);
  assert.equal(harness.local.tab_1.sleepMode, 'page');
  assert.match(harness.tabs[0].url, /^chrome-extension:\/\/test\/sleep\.html\?/);
});

test('restart reconciliation migrates only extension-owned discarded tabs', async () => {
  const harness = loadBackground({
    local: {
      tab_99: {
        lastActiveAt: 1234,
        originalUrl:  'https://owned.example/',
        sleepMode:    'discard',
        sleeping:     true
      }
    },
    tabs: [
      { id: 1, active: false, discarded: true, index: 0, title: 'Owned', url: 'https://owned.example/', windowId: 10 },
      { id: 2, active: false, discarded: true, index: 1, title: 'Chrome', url: 'https://browser.example/', windowId: 10 }
    ]
  });
  const redetectSleepingTabs = getFunction(harness.context, 'redetectSleepingTabs');

  await redetectSleepingTabs();

  assert.equal(harness.local.tab_1.sleeping, true);
  assert.equal(harness.local.tab_1.lastActiveAt, 1234);
  assert.deepEqual(harness.local.tab_2, { lastActiveAt: harness.local.tab_2.lastActiveAt, sleeping: false });
});

test('restart reconciliation refuses ambiguous duplicate-URL ownership', async () => {
  const harness = loadBackground({
    local: {
      tab_99: {
        lastActiveAt: 1234,
        originalUrl:  'https://duplicate.example/',
        sleepMode:    'discard',
        sleeping:     true
      }
    },
    tabs: [
      { id: 1, active: false, discarded: true, index: 0, title: 'Owned or Chrome', url: 'https://duplicate.example/', windowId: 10 },
      { id: 2, active: false, discarded: true, index: 1, title: 'Chrome or Owned', url: 'https://duplicate.example/', windowId: 10 }
    ]
  });
  const redetectSleepingTabs = getFunction(harness.context, 'redetectSleepingTabs');

  await redetectSleepingTabs();

  assert.equal(harness.local.tab_1.sleeping, false);
  assert.equal(harness.local.tab_2.sleeping, false);
});

test('Chrome update keeps unmatched sleep state until session restore completes', async () => {
  const harness = loadBackground({
    local: {
      tab_99: {
        lastActiveAt: 1234,
        originalUrl:  'https://restoring.example/',
        sleepMode:    'discard',
        sleeping:     true
      }
    },
    tabs: [
      {
        id: 99,
        active: false,
        discarded: false,
        index: 0,
        pendingUrl: 'https://restoring.example/',
        title: 'Restoring',
        url: 'chrome://newtab/',
        windowId: 10
      }
    ]
  });

  await harness.installed[0]({ reason: 'chrome_update' });

  assert.equal(harness.local.tab_99.sleeping, true);
  assert.equal(harness.local.tab_99.originalUrl, 'https://restoring.example/');
});

test('sleepability rejects unsafe URLs and matches domain boundaries', () => {
  const harness = loadBackground();
  const isSleepable = getFunction(harness.context, 'isSleepable');

  assert.equal(isSleepable({ active: false, url: 'file:///private.txt' }), false);
  assert.equal(isSleepable({ active: false, url: 'https://example.com/' }, { exclusions: ['example.com'] }), false);
  assert.equal(isSleepable({ active: false, url: 'https://shop.example.com/' }, { exclusions: ['example.com'] }), false);
  assert.equal(isSleepable({ active: false, url: 'https://notexample.com/' }, { exclusions: ['example.com'] }), true);
});

test('excluded current-tab request reports no successful sleep', async () => {
  const harness = loadBackground({
    sync: { exclusions: ['example.com'] },
    tabs: [
      { id: 1, active: true, discarded: false, index: 0, title: 'One', url: 'https://example.com/', windowId: 10 }
    ]
  });

  const response = await new Promise(resolve => {
    harness.messages[0]({ action: 'sleepCurrentTab', tabId: 1 }, {}, resolve);
  });

  assert.deepEqual(plain(response), { eligible: 0, ok: false, slept: 0 });
});
