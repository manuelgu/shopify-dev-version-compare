// Service worker: fetches GraphQL introspection data from shopify.dev's public
// docs proxies (the endpoints the docs' GraphiQL explorer uses), the developer
// changelog feed, and caches everything in chrome.storage.local.

const APIS = {
  'admin-graphql': { proxy: 'admin-graphql-direct-proxy', changelogCategory: 'Admin GraphQL API' },
  'storefront': { proxy: 'storefront-graphql-direct-proxy', changelogCategory: 'Storefront API' },
};
const FEED_URL = 'https://shopify.dev/changelog/feed.xml';
const TTL_UNSTABLE = 60 * 60 * 1000;        // unstable moves daily -> 1h
const TTL_STABLE = 24 * 60 * 60 * 1000;     // stable versions -> 24h
const TTL_FEED = 6 * 60 * 60 * 1000;
const TYPE_BATCH = 20;

const TYPE_REF = 'fragment TR on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }';
const FIELD_SEL = 'name description isDeprecated deprecationReason args { name description defaultValue type { ...TR } } type { ...TR }';
const TYPE_SEL = `kind name description interfaces { name } possibleTypes { name }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  inputFields { name description defaultValue type { ...TR } }
  fields(includeDeprecated: true) { ${FIELD_SEL} }`;

const mem = new Map();
const inflight = new Map();
let generation = 0; // bumped by clearCache so in-flight loaders don't repopulate the cache

function proxyFor(api) {
  const cfg = APIS[api];
  if (!cfg) throw new Error(`Unsupported API: ${api}`);
  return `https://shopify.dev/${cfg.proxy}/`;
}

async function gql(api, version, query, attempt = 0) {
  let res;
  try {
    res = await fetch(proxyFor(api) + encodeURIComponent(version), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    if (attempt < 2) { await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); return gql(api, version, query, attempt + 1); }
    throw err;
  }
  if (res.status >= 500 && attempt < 2) { // the proxy occasionally answers 502; retry with a short backoff
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    return gql(api, version, query, attempt + 1);
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Proxy returned HTTP ${res.status}`);
  if (json.error) throw new Error(json.error);
  if (!json.data) throw new Error(json.errors?.[0]?.message || `HTTP ${res.status}`);
  return json.data;
}

function ttlFor(version) {
  return version === 'unstable' ? TTL_UNSTABLE : TTL_STABLE;
}

// Memory + storage cache with request de-duplication.
async function cached(key, ttl, loader) {
  const now = Date.now();
  const m = mem.get(key);
  if (m && now - m.t < ttl) return m.v;
  try {
    const st = await chrome.storage.local.get(key);
    const e = st[key];
    if (e && now - e.t < ttl) { mem.set(key, e); return e.v; }
  } catch (_) { /* storage unavailable: fall through */ }
  if (inflight.has(key)) return inflight.get(key);
  const gen = generation;
  const p = (async () => {
    try {
      const v = await loader();
      if (gen === generation) store(key, v);
      return v;
    } finally { if (inflight.get(key) === p) inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

function store(key, v) {
  const entry = { t: Date.now(), v };
  mem.set(key, entry);
  chrome.storage.local.set({ [key]: entry }).catch(() => {});
}

// Cheap per-version index: root type names and the names of all root fields.
function getIndex(api, version) {
  return cached(`idx2:${api}:${version}`, ttlFor(version), async () => {
    const d = await gql(api, version, '{ __schema { queryType { name fields { name } } mutationType { name fields { name } } types { name } } }');
    const q = d.__schema.queryType, m = d.__schema.mutationType;
    return {
      queryType: q ? q.name : null,
      mutationType: m ? m.name : null,
      queries: q ? q.fields.map((f) => f.name) : [],
      mutations: m ? m.fields.map((f) => f.name) : [],
      types: (d.__schema.types || []).map((t) => t.name).filter((n) => !n.startsWith('__')),
    };
  });
}

// Names that exist in `version` but not in `prev`: what the version introduced.
async function newIn(api, version, prev) {
  const [cur, old] = await Promise.all([getIndex(api, version), getIndex(api, prev)]);
  const diff = (a, b) => { const s = new Set(b || []); return (a || []).filter((x) => !s.has(x)); };
  return { mutations: diff(cur.mutations, old.mutations), queries: diff(cur.queries, old.queries), types: diff(cur.types, old.types) };
}

// All fields of a root type as a name -> field map.
function getRootFields(api, version, root) {
  return cached(`root:${api}:${version}:${root}`, ttlFor(version), async () => {
    const d = await gql(api, version, `${TYPE_REF} query { r: __type(name: "${root}") { fields(includeDeprecated: true) { ${FIELD_SEL} } } }`);
    const out = {};
    for (const f of d.r?.fields || []) out[f.name] = f;
    return out;
  });
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Several named types in one request (chunked), each cached individually and
// de-duplicated while in flight. Returns { name: type | null }.
async function getTypes(api, version, names) {
  const gen = generation;
  const keyOf = (n) => `type:${api}:${version}:${n}`;
  const out = {};
  const waits = [];
  const owned = []; // names this call is responsible for loading: { name, resolve, reject }
  for (const name of [...new Set(names)]) {
    if (!NAME_RE.test(name)) continue;
    const key = keyOf(name);
    const m = mem.get(key);
    if (m && Date.now() - m.t < ttlFor(version)) { out[name] = m.v; continue; }
    if (inflight.has(key)) { waits.push(inflight.get(key).then((v) => { out[name] = v; })); continue; }
    // register synchronously so concurrent callers share this load
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    p.catch(() => {});
    inflight.set(key, p);
    owned.push({ name, key, resolve, reject, p });
    waits.push(p.then((v) => { out[name] = v; }));
  }
  if (owned.length) {
    const settle = (o, v) => { if (inflight.get(o.key) === o.p) inflight.delete(o.key); o.resolve(v); };
    const fail = (o, e) => { if (inflight.get(o.key) === o.p) inflight.delete(o.key); o.reject(e); };
    let still = owned;
    try {
      const st = await chrome.storage.local.get(owned.map((o) => o.key)).catch(() => ({}));
      still = [];
      for (const o of owned) {
        const e = st[o.key];
        if (e && Date.now() - e.t < ttlFor(version)) { mem.set(o.key, e); settle(o, e.v); }
        else still.push(o);
      }
      for (let i = 0; i < still.length; i += TYPE_BATCH) {
        const chunk = still.slice(i, i + TYPE_BATCH);
        const sel = chunk.map((o, j) => `t${j}: __type(name: "${o.name}") { ${TYPE_SEL} }`).join('\n');
        const d = await gql(api, version, `${TYPE_REF} query { ${sel} }`);
        chunk.forEach((o, j) => {
          const v = d[`t${j}`] || null;
          if (gen === generation) store(o.key, v);
          settle(o, v);
        });
      }
    } catch (err) {
      for (const o of still) fail(o, err);
      throw err;
    }
  }
  await Promise.all(waits);
  return out;
}

async function getType(api, version, name) {
  const r = await getTypes(api, version, [name]);
  return r[name] || null;
}

async function getItem(api, version, kind, name) {
  if (kind === 'mutation' || kind === 'query') {
    const idx = await getIndex(api, version);
    const root = kind === 'mutation' ? idx.mutationType : idx.queryType;
    if (!root) return null;
    const list = kind === 'mutation' ? idx.mutations : idx.queries;
    if (!list.includes(name)) return null;
    const fields = await getRootFields(api, version, root);
    const field = fields[name];
    return field ? { kind: 'FIELD', root, field } : null;
  }
  const type = await getType(api, version, name);
  return type ? { kind: 'TYPE', type } : null;
}

// Presence only: answered from the small per-version name index.
async function getPresence(api, version, kind, name) {
  const idx = await getIndex(api, version);
  const list = kind === 'mutation' ? idx.mutations : kind === 'query' ? idx.queries : idx.types;
  return list.includes(name);
}

// Background prefetch of the heavy root field maps so later pages are instant.
const warmed = new Set();
async function warm(api, versions) {
  const todo = [];
  for (const v of versions) {
    const key = `${api}:${v}`;
    if (warmed.has(key)) continue;
    warmed.add(key);
    todo.push(v);
  }
  (async () => {
    for (const v of todo) {
      try {
        const idx = await getIndex(api, v);
        if (idx.mutationType) await getRootFields(api, v, idx.mutationType);
        if (idx.queryType) await getRootFields(api, v, idx.queryType);
        await getFingerprint(api, v);
      } catch (_) { warmed.delete(`${api}:${v}`); }
    }
  })();
  return todo.length;
}

// ---- schema fingerprints + global diff ---------------------------------
// One description-free introspection per version (~3.5 MB), reduced to a
// structural hash per type and per root field (~150 KB). Two fingerprints
// give "what changed between A and B" for the whole API in milliseconds.

const SCHEMA_Q = `${TYPE_REF} query { __schema { queryType { name } mutationType { name } types {
  kind name interfaces { name } possibleTypes { name }
  enumValues(includeDeprecated: true) { name isDeprecated }
  inputFields { name defaultValue type { ...TR } }
  fields(includeDeprecated: true) { name isDeprecated args { name defaultValue type { ...TR } } type { ...TR } } } } }`;

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0') + (str.length % 4096).toString(36);
}
function refStr(t) { if (!t) return '?'; if (t.kind === 'NON_NULL') return refStr(t.ofType) + '!'; if (t.kind === 'LIST') return '[' + refStr(t.ofType) + ']'; return t.name; }
function argStr(a) { return `${a.name}:${refStr(a.type)}${a.defaultValue != null ? '=' + a.defaultValue : ''}`; }
function fieldSigStr(f) { return `${f.name}(${(f.args || []).map(argStr).sort().join(',')}):${refStr(f.type)}${f.isDeprecated ? '@d' : ''}`; }
function typeSig(t) {
  const parts = [t.kind, t.name];
  if (t.interfaces) parts.push('I:' + t.interfaces.map((i) => i.name).sort().join('&'));
  if (t.possibleTypes) parts.push('P:' + t.possibleTypes.map((i) => i.name).sort().join('|'));
  if (t.enumValues) parts.push('E:' + t.enumValues.map((v) => v.name + (v.isDeprecated ? '@d' : '')).sort().join(','));
  if (t.inputFields) parts.push('N:' + t.inputFields.map(argStr).sort().join(','));
  if (t.fields) parts.push('F:' + t.fields.map(fieldSigStr).sort().join(';'));
  return parts.join('|');
}

// { types: { name: [kind, hash] }, mutations: { name: hash }, queries: { name: hash } }
function getFingerprint(api, version) {
  return cached(`fp:${api}:${version}`, ttlFor(version), async () => {
    const d = await gql(api, version, SCHEMA_Q);
    const s = d.__schema;
    const qn = s.queryType && s.queryType.name, mn = s.mutationType && s.mutationType.name;
    const types = {}, mutations = {}, queries = {};
    for (const t of s.types || []) {
      if (t.name.startsWith('__')) continue;
      if (t.name === mn) { for (const f of t.fields || []) mutations[f.name] = fnv(fieldSigStr(f)); continue; }
      if (t.name === qn) { for (const f of t.fields || []) queries[f.name] = fnv(fieldSigStr(f)); continue; }
      types[t.name] = [t.kind, fnv(typeSig(t))];
    }
    return { types, mutations, queries };
  });
}

function compareMaps(A, B, hashOf) {
  const added = [], removed = [], changed = [];
  for (const k in B) { if (!(k in A)) added.push(k); else if (hashOf(A[k]) !== hashOf(B[k])) changed.push(k); }
  for (const k in A) if (!(k in B)) removed.push(k);
  const s = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return { added: added.sort(s), removed: removed.sort(s), changed: changed.sort(s) };
}

// Everything that differs between version a and version b.
async function globalDiff(api, a, b) {
  const [fa, fb] = await Promise.all([getFingerprint(api, a), getFingerprint(api, b)]);
  const id = (x) => x, th = (x) => x[1];
  const t = compareMaps(fa.types, fb.types, th);
  const withKind = (names) => names.map((name) => ({ name, kind: (fb.types[name] || fa.types[name])[0] }));
  return {
    a, b,
    mutations: compareMaps(fa.mutations, fb.mutations, id),
    queries: compareMaps(fa.queries, fb.queries, id),
    types: { added: withKind(t.added), removed: withKind(t.removed), changed: withKind(t.changed) },
    totals: { a: { types: Object.keys(fa.types).length, mutations: Object.keys(fa.mutations).length, queries: Object.keys(fa.queries).length },
              b: { types: Object.keys(fb.types).length, mutations: Object.keys(fb.mutations).length, queries: Object.keys(fb.queries).length } },
  };
}

// ---- changelog ----------------------------------------------------------

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function stripTags(s) { return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

function getFeed() {
  return cached('feed:changelog', TTL_FEED, async () => {
    const res = await fetch(FEED_URL);
    if (!res.ok) throw new Error(`Changelog feed HTTP ${res.status}`);
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml))) {
      const block = m[1];
      const desc = tag(block, 'description');
      const codes = new Set();
      const cre = /<code[^>]*>([\s\S]*?)<\/code>/g;
      let c;
      while ((c = cre.exec(desc))) for (const tok of stripTags(c[1]).split(/[^A-Za-z0-9_]+/)) if (tok) codes.add(tok);
      const categories = [];
      const catre = /<category>([^<]*)<\/category>/g;
      while ((c = catre.exec(block))) categories.push(decodeEntities(c[1]).trim());
      items.push({
        title: stripTags(tag(block, 'title')),
        link: decodeEntities(tag(block, 'link')),
        date: tag(block, 'atom:published') || tag(block, 'pubDate'),
        categories,
        codes: [...codes],
        text: stripTags(desc).slice(0, 6000),
      });
    }
    return items;
  });
}

function isSpecificName(name) {
  // camelCase / PascalCase identifiers of some length are unlikely to appear by accident
  return name.length >= 8 && /[a-z][A-Z]/.test(name);
}

async function changelog(api, name) {
  const cfg = APIS[api];
  const items = await getFeed();
  const wordRe = new RegExp(`(^|[^A-Za-z0-9_])${name}(?=$|[^A-Za-z0-9_])`);
  const specific = isSpecificName(name);
  const out = [];
  for (const it of items) {
    const apiCats = it.categories.filter((c) => / API$/.test(c)); // e.g. "Admin GraphQL API", not "Breaking API Change"
    if (apiCats.length && cfg && !apiCats.includes(cfg.changelogCategory)) continue;
    const strong = it.codes.includes(name) || wordRe.test(it.title);
    const weak = specific && wordRe.test(it.text);
    if (!strong && !weak) continue;
    out.push({
      title: it.title, link: it.link, date: it.date,
      versions: it.categories.filter((c) => /^\d{4}-\d{2}$/.test(c)),
      tags: it.categories.filter((c) => /breaking|deprecat|action required/i.test(c)),
    });
  }
  out.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return out.slice(0, 12);
}

// ---- housekeeping -------------------------------------------------------

async function clearCache() {
  generation++;
  mem.clear();
  inflight.clear();
  warmed.clear();
  await chrome.storage.local.clear();
}

async function cacheStats() {
  const keys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const bytes = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
  return { entries: keys.length, bytes };
}

async function handle(msg) {
  switch (msg.type) {
    case 'presence': return getPresence(msg.api, msg.version, msg.kind, msg.name);
    case 'item': return getItem(msg.api, msg.version, msg.kind, msg.name);
    case 'types': return getTypes(msg.api, msg.version, msg.names || []);
    case 'warm': return warm(msg.api, msg.versions || []);
    case 'newIn': return newIn(msg.api, msg.version, msg.prev);
    case 'globalDiff': return globalDiff(msg.api, msg.a, msg.b);
    case 'changelog': return changelog(msg.api, msg.name);
    case 'clearCache': return clearCache();
    case 'cacheStats': return cacheStats();
    default: throw new Error(`Unknown message type: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // keep the channel open for the async response
});

// Keyboard shortcut (see manifest "commands") -> forwarded to the active docs tab.
if (chrome.commands) {
  chrome.commands.onCommand.addListener(async (command) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'command', command }).catch(() => {});
  });
}
