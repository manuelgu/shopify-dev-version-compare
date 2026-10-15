const DEFAULTS = window.SDV_DEFAULT_SETTINGS;

function send(msg) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(msg, (res) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    res && res.ok ? resolve(res.result) : reject(new Error(res ? res.error : 'no response'));
  }));
}

async function refresh() {
  try {
    const s = await send({ type: 'cacheStats' });
    document.getElementById('stats').textContent = `Cache: ${s.entries} entries, ${(s.bytes / 1024 / 1024).toFixed(1)} MB`;
  } catch (e) {
    document.getElementById('stats').textContent = `Cache: ${e.message}`;
  }
}

async function loadSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const el of document.querySelectorAll('[data-setting]')) {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
    el.addEventListener('change', () => chrome.storage.sync.set({ [k]: el.type === 'checkbox' ? el.checked : el.value }));
  }
}

document.getElementById('clear').addEventListener('click', async () => {
  const note = document.getElementById('note');
  try {
    await send({ type: 'clearCache' });
    note.textContent = 'Cache cleared. Reload the docs page to refetch.';
  } catch (e) {
    note.textContent = `Could not clear the cache: ${e.message}`;
  }
  refresh();
});

document.getElementById('report').addEventListener('click', async () => {
  const note = document.getElementById('note');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/shopify\.dev\/docs\/api\//.test(tab.url || '')) { note.textContent = 'Open a shopify.dev GraphQL reference page first.'; return; }
    await chrome.tabs.sendMessage(tab.id, { type: 'command', command: 'global-diff' });
    window.close();
  } catch (e) {
    note.textContent = `Could not open the report: ${e.message}`;
  }
});

loadSettings();
refresh();
