// Content script: detects GraphQL reference pages on shopify.dev, shows a version
// banner ("introduced in", per-version status), per-field badges, changelog
// entries and a compare panel.
(function () {
  const SDV = window.SDV;
  const URL_RE = /^https:\/\/shopify\.dev\/docs\/api\/(admin-graphql|storefront)\/([^/?#]+)\/(queries|mutations|objects|interfaces|unions|enums|input-objects|scalars|connections|payloads)\/([A-Za-z0-9_]+)/;
  const CONTEXT_LINES = 3;
  const DEEP_CAP = 40;
  const DEFAULT_SETTINGS = window.SDV_DEFAULT_SETTINGS;
  const LINK_RE = /\/docs\/api\/(admin-graphql|storefront)\/[^/]+\/(queries|mutations|objects|interfaces|unions|enums|input-objects|scalars|connections|payloads)\/([A-Za-z0-9_]+)(?=[#?/]|$)/;

  let settings = { ...DEFAULT_SETTINGS };
  let currentKey = null;
  let state = null;

  // ---- helpers ------------------------------------------------------------

  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('No response from the extension background worker'));
          res.ok ? resolve(res.result) : reject(new Error(res.error));
        });
      } catch (e) { reject(e); }
    });
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function rich(text) {
    return String(text).split('`').map((p, i) => (i % 2 ? h('code', null, p) : p));
  }

  function parseUrl() {
    const m = URL_RE.exec(location.href);
    if (!m) return null;
    const category = m[3];
    return { api: m[1], version: m[2], category, name: m[4], kind: category === 'queries' ? 'query' : category === 'mutations' ? 'mutation' : 'type' };
  }

  function compareVersions(a, b) {
    if (a.value === 'unstable') return 1;
    if (b.value === 'unstable') return -1;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  }

  function readVersions() {
    const sel = document.querySelector('select[data-version-selector]');
    if (!sel || !sel.options.length) return null;
    const list = [...sel.options].map((o) => {
      const label = o.textContent.replace(/\s+/g, ' ').trim();
      return { value: o.value, latest: /\blatest\b/i.test(label), rc: /release candidate/i.test(label) };
    });
    list.sort(compareVersions);
    return list;
  }

  function docsUrl(version, page) {
    return `https://shopify.dev/docs/api/${page.api}/${version}/${page.category}/${page.name}`;
  }

  function versionInfo(value) { return state.versions.find((v) => v.value === value) || { value }; }
  function versionLabel(value) {
    const v = versionInfo(value);
    return v.rc ? `${value} (RC)` : v.latest ? `${value} (latest)` : value;
  }
  function vIndex(value) { return state.versions.findIndex((v) => v.value === value); }
  function kindLabel(page) { return page.kind === 'type' ? page.category.replace(/s$/, '').replace('-', ' ') : page.kind; }
  function latestVersion() { return (state.versions.find((v) => v.latest) || state.versions[Math.max(0, state.versions.length - 2)]).value; }

  // ---- data ---------------------------------------------------------------

  // Phase A: presence (cheap, from the per-version name index or a single __type).
  // Async results are applied only when the page state they were started for is still current
  // (the SPA may have navigated to another item in the meantime).
  function loadPresence(version) {
    const st = state, { page } = st;
    return send({ type: 'presence', api: page.api, version, kind: page.kind, name: page.name })
      .then((present) => { if (state === st) st.presence.set(version, !!present); })
      .catch(() => { if (state === st) st.presence.set(version, 'error'); })
      .finally(() => { if (state === st) { renderChip(version); renderFacts(); } });
  }

  // Phase B: full definition (+ directly referenced types for mutations/queries).
  async function loadSnapshot(version) {
    const { page } = state;
    const item = await send({ type: 'item', api: page.api, version, kind: page.kind, name: page.name });
    const snap = { item, related: {} };
    if (item) {
      const names = SDV.relatedTypeNames(item);
      if (names.length) snap.related = await send({ type: 'types', api: page.api, version, names });
    }
    snap.sdl = SDV.printSnapshot(snap);
    return snap;
  }

  function ensureDetail(version) {
    if (!state.loads.has(version)) {
      const st = state;
      const entry = { status: 'loading', snap: null, error: null };
      st.details.set(version, entry);
      const p = loadSnapshot(version)
        .then((snap) => { entry.snap = snap; entry.status = snap.item ? 'present' : 'missing'; if (state === st) st.presence.set(version, !!snap.item); })
        .catch((err) => { entry.status = 'error'; entry.error = err.message; })
        .finally(() => { if (state === st && st.details.get(version) === entry) onDetailSettled(version); });
      st.loads.set(version, p);
    }
    return state.loads.get(version);
  }

  function onDetailSettled(version) {
    renderChip(version);
    if (version === state.current) for (const v of state.versions) renderChip(v.value);
    renderFacts();
    if (detailsSettled()) { applyMemberBadges(); renderH1Badge(); }
    if (state.panel) renderPanel();
  }

  // Referenced types one level deep (for the compare panel of type pages).
  function ensureDeep(version) {
    if (!state.deep.has(version)) {
      const d = state.details.get(version);
      const type = d && d.status === 'present' && d.snap.item.kind === 'TYPE' ? d.snap.item.type : null;
      const { names } = type ? SDV.referencedTypeNames(type, DEEP_CAP) : { names: [] };
      const st = state;
      const p = names.length
        ? send({ type: 'types', api: st.page.api, version, names }).catch(() => ({}))
        : Promise.resolve({});
      st.deep.set(version, p.then((map) => { st.deepMaps.set(version, map); return map; }));
    }
    return state.deep.get(version);
  }

  function detail(version) { return state.details.get(version); }
  function presentIn(version) {
    const d = detail(version);
    if (d && (d.status === 'present' || d.status === 'missing')) return d.status === 'present';
    const p = state.presence.get(version);
    return typeof p === 'boolean' ? p : null;
  }
  function presenceSettled() { return state.versions.every((v) => presentIn(v.value) !== null || state.presence.get(v.value) === 'error'); }
  function detailsSettled() { return state.versions.every((v) => { const d = detail(v.value); return d && d.status !== 'loading'; }); }

  function statusOf(version) {
    const d = detail(version);
    if (d && d.status === 'error') return 'error';
    if (d && d.status === 'present') {
      const cur = detail(state.current);
      if (!cur || cur.status !== 'present') return version === state.current ? 'same' : 'present';
      return d.snap.sdl === cur.snap.sdl ? 'same' : 'changed';
    }
    const p = presentIn(version);
    if (p === true) return 'present';
    if (p === false) return 'missing';
    return state.presence.get(version) === 'error' ? 'error' : 'loading';
  }

  function lifecycle() {
    const vs = state.versions.map((v) => v.value);
    let introduced = null, removed = null, seen = false, unknownBefore = false;
    for (const v of vs) {
      const p = presentIn(v);
      if (p === null) { if (!seen) unknownBefore = true; continue; }
      if (p) { if (!seen) { introduced = v; seen = true; } removed = null; }
      else if (seen && !removed) removed = v;
    }
    const everywhere = vs.every((v) => presentIn(v) === true); // present in every queryable version: nothing to say
    return { introduced, removed, oldest: vs[0], uncertain: introduced === vs[0] || unknownBefore, everywhere };
  }

  function memberMap(version) {
    const d = detail(version);
    if (!d || d.status !== 'present') return null;
    const m = new Map();
    for (const x of SDV.members(d.snap.item).members) m.set(x.name, x);
    return m;
  }

  // ---- banner -------------------------------------------------------------

  const STATUS_ICON = { same: '✓', changed: '≠', missing: '–', loading: '…', error: '!', present: '•' };
  const STATUS_TITLE = {
    same: 'Identical to the version you are viewing',
    changed: 'Differs from the version you are viewing — click to see the diff',
    missing: 'Does not exist in this version',
    loading: 'Loading…',
    error: 'Could not load this version',
    present: 'Exists in this version (checking for differences…)',
  };

  function buildBanner() {
    const { page } = state;
    const ui = state.ui;
    ui.factsEl = h('span', { class: 'sdv-facts' });
    ui.collapseBtn = h('button', { type: 'button', class: 'sdv-btn sdv-btn--icon', title: 'Collapse / expand', on: { click: () => setCollapsed(!settings.collapsed, true) } }, '▾');
    const quick = h('button', { type: 'button', class: 'sdv-btn sdv-btn--quiet', title: 'Compare with the selected target (Alt+Shift+U compares with unstable)', on: { click: () => openCompare(state.current, state.target) } }, '⇄ compare');

    const head = h('div', { class: 'sdv-row sdv-row--head' },
      h('span', { class: 'sdv-brand', title: 'Shopify Dev Version Compare' }, 'Versions'),
      h('span', { class: 'sdv-title' }, h('code', null, page.name), h('span', { class: 'sdv-kind' }, kindLabel(page))),
      ui.factsEl,
      h('span', { class: 'sdv-spacer' }),
      quick,
      ui.collapseBtn,
    );

    ui.chipsEl = h('div', { class: 'sdv-chips' });
    ui.chipByVersion = new Map();
    for (const v of state.versions) {
      const chip = h('button', { type: 'button', class: 'sdv-chip', on: { click: () => { if (v.value === state.current) return; if (statusOf(v.value) === 'missing') return; openCompare(state.current, v.value); } } },
        h('span', { class: 'sdv-chip-icon' }, ''), v.value, v.latest ? h('small', null, 'latest') : v.rc ? h('small', null, 'RC') : null);
      ui.chipByVersion.set(v.value, chip);
      ui.chipsEl.append(chip);
    }

    const other = state.versions.filter((v) => v.value !== state.current);
    ui.select = h('select', { class: 'sdv-select', 'aria-label': 'Version to compare with' },
      ...other.map((v) => h('option', { value: v.value }, versionLabel(v.value))));
    ui.select.value = state.target;
    ui.select.addEventListener('change', () => { setTarget(ui.select.value, true); });

    ui.changelogBtn = h('button', { type: 'button', class: 'sdv-btn sdv-btn--quiet', on: { click: () => { ui.changelogList.hidden = !ui.changelogList.hidden; } } }, 'Changelog…');
    ui.changelogList = h('ul', { class: 'sdv-changelog', hidden: true });
    ui.changelogRow = h('div', { class: 'sdv-row sdv-row--changelog', hidden: true }, ui.changelogBtn, ui.changelogList);

    ui.body = h('div', { class: 'sdv-body' },
      h('div', { class: 'sdv-row sdv-row--timeline' },
        ui.chipsEl,
        h('div', { class: 'sdv-compare' },
          h('label', null, 'Compare with ', ui.select),
          h('button', { type: 'button', class: 'sdv-btn sdv-btn--primary', on: { click: () => openCompare(state.current, ui.select.value) } }, 'Compare'),
          h('button', { type: 'button', class: 'sdv-btn', title: 'Everything that differs between the two versions, across the whole API (Alt+Shift+G)', on: { click: () => openReport(state.current, state.target) } }, 'What changed ▸'),
          ui.filterToggle = h('label', { class: 'sdv-toggle sdv-toggle--filter', title: 'Hide sidebar entries, fields, arguments and enum values that are identical in the compare target' },
            ui.filterCb = h('input', { type: 'checkbox' }), ' Only changes'),
        ),
      ),
      ui.changelogRow,
    );

    ui.filterCb.checked = !!settings.onlyChanges;
    ui.filterCb.addEventListener('change', () => { settings.onlyChanges = ui.filterCb.checked; chrome.storage.sync.set({ onlyChanges: ui.filterCb.checked }).catch(() => {}); applyFilter(); });
    ui.banner = h('div', { class: 'sdv-banner sdv-root' }, head, ui.body);
    setCollapsed(settings.collapsed, false);
    for (const v of state.versions) renderChip(v.value);
    renderFacts();
  }

  // Change the compare target; remembered per API so the next page / tab keeps it.
  function setTarget(value, persist) {
    if (!state || !value || value === state.current || !state.versions.some((v) => v.value === value)) return;
    state.target = value;
    if (state.ui.select && state.ui.select.value !== value) state.ui.select.value = value;
    renderFacts(); applyMemberBadges(); clearFilter(); applyFilter();
    if (persist) {
      settings.lastTarget = { ...(settings.lastTarget || {}), [state.page.api]: value };
      chrome.storage.sync.set({ lastTarget: settings.lastTarget }).catch(() => {});
    }
  }

  function setCollapsed(collapsed, persist) {
    settings.collapsed = collapsed;
    if (state && state.ui.banner) {
      state.ui.banner.classList.toggle('sdv-banner--collapsed', collapsed);
      state.ui.collapseBtn.textContent = collapsed ? '▸' : '▾';
    }
    if (persist) chrome.storage.sync.set({ collapsed }).catch(() => {});
  }

  function renderChip(version) {
    const chip = state.ui.chipByVersion.get(version);
    if (!chip) return;
    const status = statusOf(version);
    const isCur = version === state.current;
    chip.className = `sdv-chip sdv-chip--${status}${isCur ? ' sdv-chip--current' : ''}`;
    chip.firstChild.textContent = STATUS_ICON[status] || '';
    chip.title = isCur ? 'The version you are viewing' : STATUS_TITLE[status] + (status === 'missing' || status === 'loading' ? '' : ' (click to compare)');
  }

  function renderFacts() {
    const { factsEl } = state.ui;
    const facts = [];
    const life = lifecycle();
    const cur = detail(state.current);

    if (!presenceSettled()) facts.push(h('span', { class: 'sdv-fact sdv-fact--muted' }, 'Checking versions…'));
    else if (!life.introduced) facts.push(h('span', { class: 'sdv-fact sdv-fact--muted' }, 'Not found via introspection in any browsable version'));
    else if (life.everywhere) { /* exists in every version we can query: no lifecycle fact needed */ }
    else if (life.uncertain) {
      facts.push(h('span', { class: 'sdv-fact', title: `shopify.dev only exposes currently supported API versions (oldest: ${life.oldest}), so the item may have been introduced earlier.` },
        'Available since ', h('b', null, life.introduced), ' or earlier ', h('span', { class: 'sdv-info' }, 'ⓘ')));
    } else {
      facts.push(h('span', { class: 'sdv-fact sdv-fact--new' }, 'Introduced in ', h('b', null, life.introduced)));
    }
    if (presenceSettled() && life.removed) facts.push(h('span', { class: 'sdv-fact sdv-fact--removed' }, 'Removed in ', h('b', null, life.removed)));

    if (cur && cur.status === 'present' && cur.snap.item.kind === 'FIELD' && cur.snap.item.field.isDeprecated) {
      const since = firstVersionWhere((v) => { const d = detail(v); return d && d.status === 'present' && d.snap.item.field.isDeprecated; });
      facts.push(h('span', { class: 'sdv-fact sdv-fact--deprecated', title: cur.snap.item.field.deprecationReason || '' }, 'Deprecated', since ? [' since ', h('b', null, since)] : null));
    }
    if (cur && cur.status === 'error') facts.push(h('span', { class: 'sdv-fact sdv-fact--error' }, 'Error: ', cur.error));

    // What the compare target adds / removes at member level.
    const curMap = memberMap(state.current), tMap = memberMap(state.target);
    if (curMap && tMap) {
      const noun = SDV.members(cur.snap.item).noun;
      const added = [...tMap.keys()].filter((n) => !curMap.has(n));
      const removed = [...curMap.keys()].filter((n) => !tMap.has(n));
      const changed = [...curMap.keys()].filter((n) => tMap.has(n) && (tMap.get(n).sig !== curMap.get(n).sig || tMap.get(n).isDeprecated !== curMap.get(n).isDeprecated));
      const parts = [];
      if (added.length) parts.push(`+${added.length} ${noun}${added.length === 1 ? '' : 's'}`);
      if (removed.length) parts.push(`−${removed.length}`);
      if (changed.length) parts.push(`≠${changed.length}`);
      if (parts.length) {
        facts.push(h('button', { type: 'button', class: 'sdv-fact sdv-fact--link', title: `Compared with ${state.target}: ${added.length} added, ${removed.length} removed, ${changed.length} changed. Click to see the diff.`, on: { click: () => openCompare(state.current, state.target) } },
          `${state.target}: ${parts.join(' ')}`));
      }
    }
    factsEl.replaceChildren(...facts);
  }

  function firstVersionWhere(pred) {
    for (const v of state.versions) if (pred(v.value)) return v.value;
    return null;
  }

  function mountBanner() {
    const main = document.querySelector('main#main-content') || document.querySelector('main');
    if (!main) return false;
    const host = main.firstElementChild || main;
    host.prepend(state.ui.banner);
    return true;
  }

  // ---- inline H1 badge + member badges -------------------------------------

  function renderH1Badge() {
    const ui = state.ui;
    if (ui.h1Badge) { ui.h1Badge.remove(); ui.h1Badge = null; }
    if (!settings.inlineBadge || !presenceSettled()) return;
    const life = lifecycle();
    if (!life.introduced || life.everywhere) return;
    const h1 = (document.querySelector('main') || document).querySelector('h1');
    if (!h1) return;
    const text = life.uncertain ? `≤ ${life.introduced}` : `since ${life.introduced}`;
    const title = life.uncertain ? `Already present in ${life.introduced}, the oldest version shopify.dev exposes` : `Introduced in API version ${life.introduced}`;
    ui.h1Badge = h('span', { class: `sdv-root sdv-h1 ${life.uncertain ? '' : 'sdv-h1--new'}`, title }, text, life.removed ? h('span', { class: 'sdv-h1-removed' }, ` · removed in ${life.removed}`) : null);
    h1.append(ui.h1Badge);
  }

  function memberAnchor(name) {
    const { page } = state;
    const main = document.querySelector('main') || document;
    const sels = page.kind !== 'type'
      ? [`#${CSS.escape('arguments-' + name)}`]
      : [`[id="field-${page.name}.fields.${name}"]`, `#${CSS.escape('fields-' + name)}`, `#${CSS.escape('enums-' + name)}`];
    for (const s of sels) { const el = main.querySelector(s); if (el) return el; }
    return null;
  }

  function removeMemberBadges() {
    for (const b of state.ui.memberBadges) b.remove();
    for (const a of state.ui.markedMembers) a.classList.remove('sdv-name-new');
    state.ui.memberBadges = [];
    state.ui.markedMembers = [];
  }

  // ---- "new in this version" marks on sidebar / in-page links ------------

  function loadNewIn() {
    const idx = vIndex(state.current);
    if (idx <= 0 || state.newIn !== null) return; // oldest browsable version: nothing to compare against
    const st = state;
    st.newIn = 'loading';
    const prev = st.versions[idx - 1].value;
    send({ type: 'newIn', api: st.page.api, version: st.current, prev })
      .then((r) => { if (state === st) { st.newIn = { mutations: new Set(r.mutations), queries: new Set(r.queries), types: new Set(r.types), prev }; applyLinkMarks(); } })
      .catch(() => { if (state === st) st.newIn = false; });
  }

  function applyLinkMarks() {
    if (!state || !settings.newMarks || !state.newIn || typeof state.newIn !== 'object') return;
    const links = document.querySelectorAll('a[href*="/docs/api/"]:not([data-sdv-marked])');
    for (const a of links) {
      a.dataset.sdvMarked = '1';
      if (a.closest('.sdv-root')) continue;
      const m = LINK_RE.exec(a.getAttribute('href') || '');
      if (!m || m[1] !== state.page.api) continue;
      if (m[2] === state.page.category && m[3] === state.page.name) continue; // the page's own anchor links
      const set = m[2] === 'mutations' ? state.newIn.mutations : m[2] === 'queries' ? state.newIn.queries : state.newIn.types;
      if (!set.has(m[3])) continue;
      const inNav = !!a.closest('[data-testid="page-navigation"], nav, aside');
      a.classList.add(inNav ? 'sdv-nav-new' : 'sdv-link-new');
      a.title = `${m[3]}: new in ${state.current} (not in ${state.newIn.prev})`;
    }
  }

  function clearLinkMarks() {
    for (const a of document.querySelectorAll('a[data-sdv-marked]')) {
      delete a.dataset.sdvMarked;
      a.classList.remove('sdv-nav-new', 'sdv-link-new');
      if (a.title && a.title.includes(': new in ')) a.removeAttribute('title');
    }
  }

  function applyMemberBadges() {
    removeMemberBadges();
    if (!settings.memberBadges || !detailsSettled()) return;
    const cur = detail(state.current);
    if (!cur || cur.status !== 'present') return;
    const { members } = SDV.members(cur.snap.item);
    if (!members.length) return;

    const life = lifecycle();
    const maps = state.versions.map((v) => ({ v: v.value, map: memberMap(v.value), present: presentIn(v.value) }));
    const curIdx = vIndex(state.current);
    const tIdx = vIndex(state.target);
    const tMap = memberMap(state.target);

    for (const m of members) {
      const anchor = memberAnchor(m.name);
      if (!anchor) continue;
      const badges = [];

      // first version that has this member (only versions where the item itself exists)
      let firstSeen = null, unknownBefore = false;
      for (const e of maps) {
        if (e.present === false) continue;
        if (!e.map) { if (!firstSeen) unknownBefore = true; continue; }
        if (e.map.has(m.name)) { firstSeen = e.v; break; }
      }
      if (firstSeen && firstSeen !== life.introduced && !unknownBefore) {
        if (firstSeen === state.current) {
          badges.push(h('span', { class: 'sdv-mb sdv-mb--current', title: `New in API version ${state.current}, the version you are viewing` }, `new in ${firstSeen}`));
          if (settings.newMarks) {
            // underline only the name text (the docs wrap it in a hashed "_Name_…" span)
            const nameEl = anchor.querySelector('[class*="_Name_"]') || anchor.querySelector('span:not(.visuallyHidden)') || anchor;
            nameEl.classList.add('sdv-name-new');
            state.ui.markedMembers.push(nameEl);
          }
        } else {
          badges.push(h('span', { class: 'sdv-mb sdv-mb--new', title: `Added in API version ${firstSeen}` }, `since ${firstSeen}`));
        }
      }
      if (m.isDeprecated) {
        const since = maps.find((e) => e.map && e.map.has(m.name) && e.map.get(m.name).isDeprecated);
        badges.push(h('span', { class: 'sdv-mb sdv-mb--deprecated', title: m.deprecationReason || 'Deprecated' }, since && since.v !== state.current ? `deprecated since ${since.v}` : 'deprecated'));
      }
      // removed in a later version
      const removedIn = maps.slice(curIdx + 1).find((e) => e.map && !e.map.has(m.name));
      if (removedIn) badges.push(h('span', { class: 'sdv-mb sdv-mb--removed', title: `No longer exists in ${removedIn.v}` }, `removed in ${removedIn.v}`));
      // difference against the compare target
      if (tMap && state.target !== state.current) {
        const tm = tMap.get(m.name);
        if (!tm) {
          const explained = firstSeen && vIndex(firstSeen) > tIdx; // a "since"/"new in" badge already covers it
          if (tIdx < curIdx && !explained) badges.push(h('span', { class: 'sdv-mb sdv-mb--missing', title: `Does not exist in ${state.target}` }, `not in ${state.target}`));
        } else if (tm.sig !== m.sig || tm.isDeprecated !== m.isDeprecated) {
          const what = tm.sig !== m.sig ? `${state.target}: ${tm.sig}` : `${state.target}: ${tm.isDeprecated ? 'deprecated' : 'not deprecated'}`;
          badges.push(h('button', { type: 'button', class: 'sdv-mb sdv-mb--changed', title: what + ' (click to compare)', on: { click: () => openCompare(state.current, state.target) } }, `≠ ${state.target}`));
        }
      }
      if (!badges.length) continue;
      const wrap = h('span', { class: 'sdv-root sdv-mbs' }, ...badges);
      anchor.after(wrap);
      state.ui.memberBadges.push(wrap);
    }
    state.ui.badgeAnchorName = members[0].name;
  }

  // ---- global diff (whole API, version a -> version b) ----------------------

  function ensureGlobalDiff(a, b) {
    const key = `${a}|${b}`;
    if (!state.globalDiffs.has(key)) {
      const st = state;
      const p = send({ type: 'globalDiff', api: st.page.api, a, b }).then((gd) => {
        const toSets = (c) => ({ added: new Set(c.added), removed: new Set(c.removed), changed: new Set(c.changed), lists: c });
        const tnames = (arr) => arr.map((t) => t.name);
        gd.sets = {
          mutations: toSets(gd.mutations), queries: toSets(gd.queries),
          types: { added: new Set(tnames(gd.types.added)), removed: new Set(tnames(gd.types.removed)), changed: new Set(tnames(gd.types.changed)), lists: gd.types },
        };
        return gd;
      });
      st.globalDiffs.set(key, { promise: p, value: null, error: null });
      p.then((gd) => { const e = st.globalDiffs.get(key); if (e) e.value = gd; if (state === st) { applyFilter(); if (st.panel && st.panel.mode === 'report') renderReport(); } })
       .catch((err) => { const e = st.globalDiffs.get(key); if (e) e.error = err.message; if (state === st && st.panel && st.panel.mode === 'report') renderReport(); });
    }
    return state.globalDiffs.get(key);
  }

  // Status of a docs link relative to the diff a -> b: 'added' | 'removed' | 'changed' | 'same'
  function linkStatus(gd, category, name) {
    const c = category === 'mutations' ? gd.sets.mutations : category === 'queries' ? gd.sets.queries : gd.sets.types;
    if (c.changed.has(name)) return 'changed';
    if (c.removed.has(name)) return 'removed';
    if (c.added.has(name)) return 'added';
    return 'same';
  }

  function typeCategory(name, kind) {
    switch (kind) {
      case 'INPUT_OBJECT': return 'input-objects';
      case 'ENUM': return 'enums';
      case 'INTERFACE': return 'interfaces';
      case 'UNION': return 'unions';
      case 'SCALAR': return 'scalars';
      default: return name.endsWith('Connection') ? 'connections' : name.endsWith('Payload') ? 'payloads' : 'objects';
    }
  }

  // ---- "only changes" filter: sidebar + members on the page ---------------

  function hideEl(el) { if (!el || el.classList.contains('sdv-hidden')) return; el.classList.add('sdv-hidden'); state.ui.hiddenEls.push(el); }

  function clearFilter() {
    if (!state) return;
    for (const el of state.ui.hiddenEls) el.classList.remove('sdv-hidden');
    state.ui.hiddenEls = [];
    for (const a of document.querySelectorAll('a[data-sdv-filtered]')) { delete a.dataset.sdvFiltered; a.classList.remove('sdv-nav-changed', 'sdv-nav-removed', 'sdv-nav-newer'); }
    if (state.ui.filterNote) { state.ui.filterNote.remove(); state.ui.filterNote = null; }
    state.ui.membersFiltered = false;
  }

  function applyFilter() {
    if (!state) return;
    if (!settings.onlyChanges || state.target === state.current) { if (state.ui.hiddenEls.length || state.ui.filterNote) clearFilter(); return; }
    const entry = ensureGlobalDiff(state.current, state.target);
    const gd = entry.value;
    if (!gd) return; // applied when it arrives
    const targetNewer = vIndex(state.target) > vIndex(state.current);

    // sidebar
    const nav = document.querySelector('[data-testid="page-navigation"]');
    if (nav) {
      for (const a of nav.querySelectorAll('a[href*="/docs/api/"]:not([data-sdv-filtered])')) {
        a.dataset.sdvFiltered = '1';
        const m = LINK_RE.exec(a.getAttribute('href') || '');
        if (!m || m[1] !== state.page.api) continue;
        const status = linkStatus(gd, m[2], m[3]);
        if (status === 'same') hideEl(a.closest('li') || a);
        else if (status === 'changed') { a.classList.add('sdv-nav-changed'); a.title = `${m[3]}: differs in ${state.target}`; }
        else if (status === 'removed' && targetNewer) { a.classList.add('sdv-nav-removed'); a.title = `${m[3]}: removed in ${state.target}`; }
        else if (status === 'removed') { a.classList.add('sdv-nav-newer'); a.title = `${m[3]}: added after ${state.target}`; }
      }
    }

    // members of the current page
    if (!state.ui.membersFiltered && detailsSettled()) {
      const curMap = memberMap(state.current), tMap = memberMap(state.target);
      if (curMap && tMap) {
        state.ui.membersFiltered = true;
        let shown = 0, total = 0;
        for (const [name, m] of curMap) {
          const anchor = memberAnchor(name);
          if (!anchor) continue;
          total++;
          const tm = tMap.get(name);
          const differs = !tm || tm.sig !== m.sig || tm.isDeprecated !== m.isDeprecated;
          if (differs) { shown++; continue; }
          const dt = anchor.closest('dt');
          const row = dt || anchor.closest('li') || anchor.parentElement;
          hideEl(row);
          if (dt && dt.nextElementSibling && dt.nextElementSibling.tagName === 'DD') hideEl(dt.nextElementSibling);
        }
        const onlyInTarget = [...tMap.keys()].filter((n) => !curMap.has(n));
        const noun = SDV.members(detail(state.current).snap.item).noun;
        const note = h('div', { class: 'sdv-root sdv-filter-note' },
          `Only changes vs ${state.target}: showing ${shown} of ${total} ${noun}s on this page`,
          onlyInTarget.length ? [` · ${onlyInTarget.length} ${noun}${onlyInTarget.length === 1 ? '' : 's'} only in ${state.target}: `, ...onlyInTarget.slice(0, 12).map((n, i) => [i ? ', ' : '', h('code', null, n)]), onlyInTarget.length > 12 ? ', …' : ''] : null,
          ' ', h('a', { class: 'sdv-link', href: docsUrl(state.target, state.page), target: '_blank', rel: 'noopener' }, `open ${state.target} docs ↗`),
        );
        state.ui.filterNote = note;
        state.ui.banner.after(note);
      }
    }
  }

  // ---- "what changed" report ------------------------------------------------

  function openReport(a, b) {
    if (!state || !a || !b) return;
    closePanel();
    const overlay = h('div', { class: 'sdv-overlay', on: { click: closePanel } });
    const panel = h('aside', { class: 'sdv-panel sdv-root', role: 'dialog', 'aria-label': 'What changed between API versions' });
    state.panel = { mode: 'report', overlay, panel, a, b, query: '', expanded: new Set(), details: new Map(), open: new Set(['mutations', 'queries', 'types']) };
    document.body.append(overlay, panel);
    document.addEventListener('keydown', onKey);
    if (a !== b) ensureGlobalDiff(a, b);
    renderReport();
  }

  const KIND_LABEL = { objects: 'Objects', payloads: 'Payloads', connections: 'Connections', 'input-objects': 'Input objects', enums: 'Enums', interfaces: 'Interfaces', unions: 'Unions', scalars: 'Scalars' };

  function renderReport() {
    if (!state || !state.panel || state.panel.mode !== 'report') return;
    const P = state.panel;
    const { panel, a, b } = P;
    const { page } = state;
    panel.replaceChildren();
    const mkSelect = (value, onChange) => {
      const s = h('select', { class: 'sdv-select' }, ...state.versions.map((v) => h('option', { value: v.value }, versionLabel(v.value))));
      s.value = value; s.addEventListener('change', () => onChange(s.value)); return s;
    };
    panel.append(h('header', { class: 'sdv-panel-head' },
      h('div', { class: 'sdv-panel-title' }, 'What changed', h('span', { class: 'sdv-kind' }, page.api === 'storefront' ? 'Storefront API' : 'Admin API')),
      h('button', { type: 'button', class: 'sdv-btn sdv-close', 'aria-label': 'Close', on: { click: closePanel } }, '×'),
    ));
    const search = h('input', { type: 'search', class: 'sdv-select sdv-search', placeholder: 'Filter by name…', value: P.query });
    search.addEventListener('input', () => { P.query = search.value.trim().toLowerCase(); renderReportBody(); });
    panel.append(h('div', { class: 'sdv-panel-controls' },
      mkSelect(a, (v) => openReport(v, b)),
      h('button', { type: 'button', class: 'sdv-btn', title: 'Swap versions', on: { click: () => openReport(b, a) } }, '⇄'),
      mkSelect(b, (v) => { setTarget(v, true); openReport(a, v); }),
      h('span', { class: 'sdv-spacer' }),
      search,
    ));
    P.body = h('div', { class: 'sdv-panel-body' });
    panel.append(P.body);
    renderReportBody();
    if (document.activeElement !== search && P.query) search.focus();
  }

  function renderReportBody() {
    const P = state.panel;
    const { a, b } = P;
    const body = P.body;
    body.replaceChildren();
    if (a === b) { body.append(h('p', { class: 'sdv-muted' }, 'Pick two different versions.')); return; }
    const entry = state.globalDiffs.get(`${a}|${b}`);
    if (!entry || (!entry.value && !entry.error)) { body.append(h('p', { class: 'sdv-muted' }, `Loading the ${a} and ${b} schemas… (a few seconds the first time, cached afterwards)`)); return; }
    if (entry.error) { body.append(h('p', { class: 'sdv-error' }, 'Could not load: ', entry.error)); return; }
    const gd = entry.value;
    const q = P.query;
    const match = (n) => !q || n.toLowerCase().includes(q);

    const total = (c) => c.added.length + c.removed.length + c.changed.length;
    const counts = (c) => [c.added.length ? h('span', { class: 'sdv-cnt sdv-cnt--add' }, `+${c.added.length}`) : null, c.removed.length ? h('span', { class: 'sdv-cnt sdv-cnt--del' }, `−${c.removed.length}`) : null, c.changed.length ? h('span', { class: 'sdv-cnt sdv-cnt--chg' }, `≠${c.changed.length}`) : null];
    body.append(h('p', { class: 'sdv-report-summary' },
      h('b', null, `${a} → ${b}`), ': ',
      'mutations ', ...counts(gd.mutations), ' · queries ', ...counts(gd.queries), ' · types ', ...counts({ added: gd.types.added, removed: gd.types.removed, changed: gd.types.changed }),
      (total(gd.mutations) + total(gd.queries) + total({ added: gd.types.added, removed: gd.types.removed, changed: gd.types.changed })) === 0 ? ' — identical' : '',
    ));

    const section = (key, title, c, nameOf, catOf) => {
      const rows = [];
      const push = (status, x) => { const name = nameOf(x); if (match(name)) rows.push({ status, name, cat: catOf(x) }); };
      for (const x of c.added) push('added', x);
      for (const x of c.changed) push('changed', x);
      for (const x of c.removed) push('removed', x);
      if (!rows.length) return null;
      const open = P.open.has(key);
      const head = h('h3', { class: 'sdv-report-h' , on: { click: () => { if (open) P.open.delete(key); else P.open.add(key); renderReportBody(); } } }, h('span', { class: 'sdv-caret' }, open ? '▾' : '▸'), ` ${title} `, h('span', { class: 'sdv-muted' }, `(${rows.length})`));
      const list = h('ul', { class: 'sdv-report-list' });
      if (open) for (const r of rows) list.append(reportRow(r));
      return h('section', { class: 'sdv-report-section' }, head, list);
    };

    const sections = [];
    sections.push(section('mutations', 'Mutations', gd.mutations, (n) => n, () => 'mutations'));
    sections.push(section('queries', 'Queries', gd.queries, (n) => n, () => 'queries'));
    // types grouped by docs category
    const groups = {};
    for (const status of ['added', 'changed', 'removed']) for (const t of gd.types[status]) {
      const cat = typeCategory(t.name, t.kind);
      (groups[cat] = groups[cat] || { added: [], changed: [], removed: [] })[status].push(t);
    }
    for (const cat of ['objects', 'payloads', 'connections', 'input-objects', 'enums', 'interfaces', 'unions', 'scalars']) {
      if (!groups[cat]) continue;
      if (!P.open.has('types')) continue;
      sections.push(section('types:' + cat, KIND_LABEL[cat], groups[cat], (t) => t.name, () => cat));
    }
    const any = sections.some(Boolean);
    if (!any) body.append(h('p', { class: 'sdv-muted' }, q ? `Nothing matching "${q}".` : 'No differences.'));
    for (const s of sections) if (s) body.append(s);
    if (Object.keys(groups).length && !P.open.has('types')) body.append(h('h3', { class: 'sdv-report-h', on: { click: () => { P.open.add('types'); renderReportBody(); } } }, h('span', { class: 'sdv-caret' }, '▸'), ' Types'));
  }

  function reportRow(r) {
    const P = state.panel;
    const { a, b } = P;
    const { page } = state;
    const key = `${r.cat}/${r.name}`;
    const version = r.status === 'removed' ? a : b;
    const url = `https://shopify.dev/docs/api/${page.api}/${version}/${r.cat}/${r.name}`;
    const icon = r.status === 'added' ? '+' : r.status === 'removed' ? '−' : '≠';
    const li = h('li', { class: `sdv-report-row sdv-report-row--${r.status}` },
      h('span', { class: 'sdv-report-icon' }, icon),
      h('a', { class: 'sdv-report-name', href: url, target: '_blank', rel: 'noopener', title: `Open in the ${version} docs` }, r.name),
      r.status === 'changed' ? h('button', { type: 'button', class: 'sdv-btn sdv-btn--quiet sdv-report-more', on: { click: () => toggleReportDetail(r, li) } }, P.expanded.has(key) ? 'hide' : 'details') : null,
    );
    if (r.status === 'changed' && P.expanded.has(key)) li.append(reportDetail(r));
    return li;
  }

  function toggleReportDetail(r, li) {
    const P = state.panel;
    const key = `${r.cat}/${r.name}`;
    if (P.expanded.has(key)) P.expanded.delete(key); else P.expanded.add(key);
    li.replaceWith(reportRow(r));
  }

  function reportDetail(r) {
    const P = state.panel;
    const key = `${r.cat}/${r.name}`;
    const box = h('div', { class: 'sdv-report-detail' });
    const d = P.details.get(key);
    if (d && d.changes) {
      if (!d.changes.length) box.append(h('p', { class: 'sdv-muted' }, 'Only descriptions differ.'));
      else box.append(h('ul', null, ...d.changes.map((c) => h('li', { class: `sdv-change sdv-change--${c.level}` }, ...rich(c.text)))));
      return box;
    }
    if (d && d.error) { box.append(h('p', { class: 'sdv-error' }, d.error)); return box; }
    box.append(h('p', { class: 'sdv-muted' }, 'Loading…'));
    if (!d) {
      P.details.set(key, { loading: true });
      const st = state, panelRef = P;
      const { a, b } = P;
      const load = async (version) => {
        if (r.cat === 'mutations' || r.cat === 'queries') {
          const item = await send({ type: 'item', api: st.page.api, version, kind: r.cat === 'mutations' ? 'mutation' : 'query', name: r.name });
          const snap = { item, related: {} };
          if (item) { const names = SDV.relatedTypeNames(item); if (names.length) snap.related = await send({ type: 'types', api: st.page.api, version, names }); }
          return snap;
        }
        const types = await send({ type: 'types', api: st.page.api, version, names: [r.name] });
        return { item: types[r.name] ? { kind: 'TYPE', type: types[r.name] } : null, related: {} };
      };
      Promise.all([load(a), load(b)])
        .then(([sa, sb]) => { panelRef.details.set(key, { changes: SDV.summarize(sa, sb) }); })
        .catch((err) => { panelRef.details.set(key, { error: err.message }); })
        .finally(() => { if (state === st && st.panel === panelRef) { const row = [...panelRef.body.querySelectorAll('.sdv-report-row')].find((el) => el.querySelector('.sdv-report-name')?.textContent === r.name && el.querySelector('.sdv-report-name')?.href.includes(`/${r.cat}/`)); if (row) row.replaceWith(reportRow(r)); } });
    }
    return box;
  }

  // ---- changelog ----------------------------------------------------------

  function loadChangelog() {
    const ui = state.ui;
    if (!settings.changelog) { ui.changelogRow.hidden = true; return; }
    if (state.changelog) { renderChangelog(); return; }
    const st = state;
    st.changelog = 'loading';
    send({ type: 'changelog', api: st.page.api, name: st.page.name })
      .then((entries) => { if (state === st) { st.changelog = entries; renderChangelog(); } })
      .catch(() => { if (state === st) { st.changelog = []; renderChangelog(); } });
  }

  function renderChangelog() {
    const ui = state.ui;
    const entries = Array.isArray(state.changelog) ? state.changelog : [];
    ui.changelogRow.hidden = !settings.changelog || !entries.length;
    ui.changelogBtn.textContent = `Changelog: ${entries.length} ${entries.length === 1 ? 'entry mentions' : 'entries mention'} ${state.page.name} ▾`;
    ui.changelogList.hidden = entries.length > 3;
    ui.changelogList.replaceChildren(...entries.map((e) => h('li', null,
      h('span', { class: 'sdv-cl-date' }, (e.date || '').slice(0, 10)),
      h('a', { class: 'sdv-link', href: e.link, target: '_blank', rel: 'noopener' }, e.title),
      ...e.versions.map((v) => h('span', { class: 'sdv-cl-tag' }, v)),
      ...e.tags.map((t) => h('span', { class: 'sdv-cl-tag sdv-cl-tag--warn' }, t)),
    )));
  }

  // ---- compare panel ------------------------------------------------------

  function openCompare(a, b) {
    if (!state || !a || !b || a === b) return;
    const keep = state.panel && state.panel.mode === 'item' ? { deep: state.panel.deep, showAll: state.panel.showAll } : { deep: false, showAll: false };
    closePanel();
    state.pair = { a, b };
    const overlay = h('div', { class: 'sdv-overlay', on: { click: closePanel } });
    const panel = h('aside', { class: 'sdv-panel sdv-root', role: 'dialog', 'aria-label': 'Compare API versions' });
    state.panel = { mode: 'item', overlay, panel, showAll: keep.showAll, deep: keep.deep };
    document.body.append(overlay, panel);
    document.addEventListener('keydown', onKey);
    renderPanel();
    Promise.all([ensureDetail(a), ensureDetail(b)]).then(() => renderPanel());
  }

  function onKey(e) { if (e.key === 'Escape') closePanel(); }

  function closePanel() {
    if (!state || !state.panel) return;
    state.panel.overlay.remove();
    state.panel.panel.remove();
    state.panel = null;
    document.removeEventListener('keydown', onKey);
  }

  function snapshotFor(version, deep) {
    const d = detail(version);
    if (!d || d.status !== 'present') return null;
    if (!deep) return d.snap;
    const extra = state.deepMaps.get(version) || {};
    const snap = { item: d.snap.item, related: { ...d.snap.related, ...extra } };
    snap.sdl = SDV.printSnapshot(snap);
    return snap;
  }

  function renderPanel() {
    if (!state || !state.panel) return;
    if (state.panel.mode === 'report') return renderReport();
    const { panel } = state.panel;
    const { a, b } = state.pair;
    const { page } = state;
    const ea = detail(a), eb = detail(b);
    panel.replaceChildren();

    const mkSelect = (value, onChange) => {
      const s = h('select', { class: 'sdv-select' }, ...state.versions.map((v) => h('option', { value: v.value }, versionLabel(v.value))));
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };

    panel.append(h('header', { class: 'sdv-panel-head' },
      h('div', { class: 'sdv-panel-title' }, h('code', null, page.name), h('span', { class: 'sdv-kind' }, kindLabel(page))),
      h('button', { type: 'button', class: 'sdv-btn sdv-close', 'aria-label': 'Close', on: { click: closePanel } }, '×'),
    ));
    panel.append(h('div', { class: 'sdv-panel-controls' },
      mkSelect(a, (v) => openCompare(v, b)),
      h('button', { type: 'button', class: 'sdv-btn', title: 'Swap versions', on: { click: () => openCompare(b, a) } }, '⇄'),
      mkSelect(b, (v) => { setTarget(v, true); openCompare(a, v); }),
      h('span', { class: 'sdv-spacer' }),
      h('a', { class: 'sdv-link', href: docsUrl(a, page), target: '_blank', rel: 'noopener' }, `Open ${a} docs ↗`),
      h('a', { class: 'sdv-link', href: docsUrl(b, page), target: '_blank', rel: 'noopener' }, `Open ${b} docs ↗`),
    ));

    const body = h('div', { class: 'sdv-panel-body' });
    panel.append(body);

    const loading = [ea, eb].some((e) => !e || e.status === 'loading');
    if (loading) { body.append(h('p', { class: 'sdv-muted' }, 'Loading both versions…')); return; }
    const err = [ea, eb].find((e) => e.status === 'error');
    if (err) { body.append(h('p', { class: 'sdv-error' }, 'Could not load: ', err.error)); return; }

    // Deep compare option for type pages.
    const isType = page.kind === 'type';
    let deep = isType && state.panel.deep;
    if (isType) {
      const src = [ea, eb].find((e) => e.status === 'present');
      const refs = src ? SDV.referencedTypeNames(src.snap.item.type, DEEP_CAP) : { names: [], total: 0 };
      if (refs.total) {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = deep;
        cb.addEventListener('change', () => {
          state.panel.deep = cb.checked;
          if (cb.checked) Promise.all([ensureDeep(a), ensureDeep(b)]).then(() => renderPanel());
          renderPanel();
        });
        const capped = refs.total > refs.names.length ? ` (first ${refs.names.length} of ${refs.total})` : ` (${refs.total})`;
        body.append(h('label', { class: 'sdv-toggle sdv-toggle--block' }, cb, ` Include directly referenced types${capped}`));
        if (deep && (!state.deepMaps.has(a) || !state.deepMaps.has(b))) {
          Promise.all([ensureDeep(a), ensureDeep(b)]).then(() => renderPanel());
          body.append(h('p', { class: 'sdv-muted' }, 'Loading referenced types…'));
          deep = false;
        }
      }
    }

    const sa = snapshotFor(a, deep), sb = snapshotFor(b, deep);
    const changes = SDV.summarize(sa || { item: null }, sb || { item: null });
    const summary = h('section', { class: 'sdv-summary' });
    summary.append(h('h3', null, `Changes from ${a} to ${b}`));
    if (!changes.length) summary.append(h('p', { class: 'sdv-ok' }, '✓ No differences (including descriptions' + (deep || !isType ? ' and referenced types' : '') + ').'));
    else summary.append(h('ul', null, ...changes.map((c) => h('li', { class: `sdv-change sdv-change--${c.level}` }, ...rich(c.text)))));
    body.append(summary);

    const lines = SDV.diffLines(sa ? sa.sdl : '', sb ? sb.sdl : '');
    const changed = lines.some((l) => l.op !== ' ');
    const toggle = h('input', { type: 'checkbox' });
    toggle.checked = state.panel.showAll;
    toggle.addEventListener('change', () => { state.panel.showAll = toggle.checked; renderPanel(); });
    body.append(h('div', { class: 'sdv-diff-head' },
      h('h3', null, 'Schema diff'),
      h('span', { class: 'sdv-legend' }, h('span', { class: 'sdv-legend-del' }, `− ${a}`), h('span', { class: 'sdv-legend-add' }, `+ ${b}`)),
      h('label', { class: 'sdv-toggle' }, toggle, ' Show unchanged lines'),
    ));

    const pre = h('pre', { class: 'sdv-diff' });
    if (!changed && !state.panel.showAll) {
      pre.append(h('div', { class: 'sdv-line sdv-line--skip' }, `${lines.length} identical lines hidden — tick "Show unchanged lines" to view the definition`));
    } else {
      const keep = new Array(lines.length).fill(state.panel.showAll);
      if (!state.panel.showAll) {
        lines.forEach((l, i) => {
          if (l.op === ' ') return;
          for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++) keep[j] = true;
        });
      }
      let skipped = 0;
      const flush = () => { if (skipped) { pre.append(h('div', { class: 'sdv-line sdv-line--skip' }, `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)); skipped = 0; } };
      lines.forEach((l, i) => {
        if (!keep[i]) { skipped++; return; }
        flush();
        const cls = l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same';
        pre.append(h('div', { class: `sdv-line sdv-line--${cls}` }, h('span', { class: 'sdv-gutter' }, l.op), l.text));
      });
      flush();
    }
    body.append(pre);
  }

  // ---- lifecycle ----------------------------------------------------------

  function setup(page, versions) {
    let current = page.version;
    if (current === 'latest') current = (versions.find((v) => v.latest) || versions[Math.max(0, versions.length - 2)] || {}).value || current;
    if (!versions.some((v) => v.value === current)) { versions.push({ value: current }); versions.sort(compareVersions); }

    const others = versions.filter((v) => v.value !== current).map((v) => v.value);
    const resolve = (t) => (t === 'latest' ? (versions.find((v) => v.latest) || {}).value : t);
    const remembered = resolve((settings.lastTarget || {})[page.api]);
    let target = others.includes(remembered) ? remembered : resolve(settings.defaultTarget);
    if (!others.includes(target)) target = others.includes('unstable') ? 'unstable' : others[others.length - 1];

    state = {
      page, versions, current, target,
      presence: new Map(), details: new Map(), loads: new Map(), deep: new Map(), deepMaps: new Map(),
      ui: { memberBadges: [], markedMembers: [], h1Badge: null, hiddenEls: [], filterNote: null },
      panel: null, pair: null, changelog: null, newIn: null, globalDiffs: new Map(),
    };
    buildBanner();
    mountBanner();

    for (const v of versions) loadPresence(v.value);
    for (const v of versions) ensureDetail(v.value);
    if (settings.prefetch) send({ type: 'warm', api: page.api, versions: versions.map((v) => v.value) }).catch(() => {});
    loadChangelog();
    if (settings.newMarks) loadNewIn();
    if (settings.onlyChanges && target) ensureGlobalDiff(current, target);
  }

  function teardown() {
    if (!state) return;
    closePanel();
    clearFilter();
    clearLinkMarks();
    removeMemberBadges();
    if (state.ui.h1Badge) state.ui.h1Badge.remove();
    if (state.ui.banner) state.ui.banner.remove();
    state = null;
  }

  let pendingSince = 0;
  let loadedAt = 0;
  function tick() {
    if (!loadedAt && document.readyState === 'complete') loadedAt = Date.now();
    if (!loadedAt || Date.now() - loadedAt < 600) return; // let React hydrate before touching the DOM
    const page = parseUrl();
    const key = page ? `${page.api}/${page.version}/${page.category}/${page.name}` : null;
    if (key !== currentKey) {
      currentKey = key;
      teardown();
      pendingSince = Date.now();
    }
    if (!page) return;
    if (!state) {
      if (pendingSince === Infinity) return; // gave up: no version selector on this page
      const versions = readVersions();
      if (versions) setup(page, versions);
      else if (Date.now() - pendingSince > 15000) pendingSince = Infinity;
      return;
    }
    // The SPA may re-render the main column: re-mount anything that got dropped.
    if (!document.contains(state.ui.banner)) mountBanner();
    applyLinkMarks();
    applyFilter();
    if (detailsSettled()) {
      const ui = state.ui;
      if (settings.memberBadges) {
        const dropped = ui.memberBadges.length && !document.contains(ui.memberBadges[0]);
        const late = !ui.memberBadges.length && ui.badgeAnchorName && Date.now() - (ui.badgeAttemptedAt || 0) > 2000 && memberAnchor(ui.badgeAnchorName);
        if (dropped || late) { ui.badgeAttemptedAt = Date.now(); applyMemberBadges(); }
      }
      if (settings.inlineBadge && (!ui.h1Badge || !document.contains(ui.h1Badge))) renderH1Badge();
    }
  }

  // ---- settings + commands -------------------------------------------------

  function applySettings(next) {
    const prev = settings;
    settings = { ...DEFAULT_SETTINGS, ...next };
    if (!state) return;
    if (prev.collapsed !== settings.collapsed) setCollapsed(settings.collapsed, false);
    if (prev.memberBadges !== settings.memberBadges) applyMemberBadges();
    if (prev.inlineBadge !== settings.inlineBadge) renderH1Badge();
    if (prev.changelog !== settings.changelog) loadChangelog();
    const remembered = (settings.lastTarget || {})[state.page.api];
    if (remembered && remembered !== (prev.lastTarget || {})[state.page.api] && remembered !== state.target) setTarget(remembered, false);
    if (prev.onlyChanges !== settings.onlyChanges) { if (state.ui.filterCb) state.ui.filterCb.checked = settings.onlyChanges; clearFilter(); applyFilter(); }
    if (prev.newMarks !== settings.newMarks) {
      if (settings.newMarks) { loadNewIn(); applyLinkMarks(); applyMemberBadges(); }
      else { clearLinkMarks(); applyMemberBadges(); }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'command' || !state) return;
    if (msg.command === 'compare-unstable') openCompare(state.current, state.current === 'unstable' ? latestVersion() : 'unstable');
    if (msg.command === 'global-diff') openReport(state.current, state.target);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const next = { ...settings };
    for (const [k, v] of Object.entries(changes)) next[k] = 'newValue' in v ? v.newValue : DEFAULT_SETTINGS[k];
    applySettings(next);
  });

  if (!SDV) return;
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => { applySettings(s); }).catch(() => {}).finally(() => {
    setInterval(tick, 500);
    tick();
  });
})();
