// Linear-space Myers diff (middle snake, divide & conquer) plus a structured,
// human readable change summary.
(function () {
  const SDV = (window.SDV = window.SDV || {});

  function middleSnake(a, a0, a1, b, b0, b1) {
    const N = a1 - a0, M = b1 - b0, MAX = N + M, delta = N - M, odd = (delta & 1) !== 0;
    const off = MAX + 2;
    const vf = new Int32Array(2 * off + 2), vr = new Int32Array(2 * off + 2);
    vf[off + 1] = 0; vr[off + 1] = 0;
    const half = Math.ceil(MAX / 2);
    for (let D = 0; D <= half; D++) {
      for (let k = -D; k <= D; k += 2) {
        let x = (k === -D || (k !== D && vf[off + k - 1] < vf[off + k + 1])) ? vf[off + k + 1] : vf[off + k - 1] + 1;
        let y = x - k; const sx = x, sy = y;
        while (x < N && y < M && a[a0 + x] === b[b0 + y]) { x++; y++; }
        vf[off + k] = x;
        if (odd && k - delta >= -(D - 1) && k - delta <= D - 1 && vf[off + k] + vr[off + delta - k] >= N) {
          return { x: a0 + sx, y: b0 + sy, u: a0 + x, v: b0 + y };
        }
      }
      for (let k = -D; k <= D; k += 2) {
        let x = (k === -D || (k !== D && vr[off + k - 1] < vr[off + k + 1])) ? vr[off + k + 1] : vr[off + k - 1] + 1;
        let y = x - k; const sx = x, sy = y;
        while (x < N && y < M && a[a1 - 1 - x] === b[b1 - 1 - y]) { x++; y++; }
        vr[off + k] = x;
        if (!odd && k - delta >= -D && k - delta <= D && vr[off + k] + vf[off + delta - k] >= N) {
          return { x: a1 - x, y: b1 - y, u: a1 - sx, v: b1 - sy };
        }
      }
    }
    return null;
  }

  function diffRange(a, a0, a1, b, b0, b1, out, depth) {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { out.push({ op: ' ', text: a[a0] }); a0++; b0++; }
    const tail = [];
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) { tail.push({ op: ' ', text: a[a1 - 1] }); a1--; b1--; }
    const N = a1 - a0, M = b1 - b0;
    if (N === 0) { for (let j = b0; j < b1; j++) out.push({ op: '+', text: b[j] }); }
    else if (M === 0) { for (let i = a0; i < a1; i++) out.push({ op: '-', text: a[i] }); }
    else {
      const s = depth < 5000 ? middleSnake(a, a0, a1, b, b0, b1) : null;
      const degenerate = !s || (s.x === a0 && s.y === b0 && s.u === a1 && s.v === b1) || (s.u === a1 && s.v === b1 && s.x === a0 && s.y === b0);
      const wholeLeft = s && s.x === a1 && s.y === b1;      // left subproblem would equal this one
      const wholeRight = s && s.u === a0 && s.v === b0;     // right subproblem would equal this one
      if (degenerate || wholeLeft || wholeRight) {
        for (let i = a0; i < a1; i++) out.push({ op: '-', text: a[i] });
        for (let j = b0; j < b1; j++) out.push({ op: '+', text: b[j] });
      } else {
        diffRange(a, a0, s.x, b, b0, s.y, out, depth + 1);
        for (let i = s.x; i < s.u; i++) out.push({ op: ' ', text: a[i] });
        diffRange(a, s.u, a1, b, s.v, b1, out, depth + 1);
      }
    }
    while (tail.length) out.push(tail.pop());
  }

  // Returns [{ op: ' ' | '+' | '-', text }]
  function diffLines(aText, bText) {
    const a = aText ? aText.split('\n') : [];
    const b = bText ? bText.split('\n') : [];
    const out = [];
    diffRange(a, 0, a.length, b, 0, b.length, out, 0);
    return out;
  }

  // ---- structured summary -------------------------------------------------

  function mapBy(arr) {
    const m = new Map();
    for (const x of arr || []) m.set(x.name, x);
    return m;
  }

  function fieldSig(f) {
    const args = SDV.byName(f.args).map(SDV.argSig).join(', ');
    return `${f.name}${args ? '(' + args + ')' : ''}: ${SDV.ref(f.type)}`;
  }

  function diffMembers(changes, noun, oldArr, newArr, sig, scope) {
    const A = mapBy(oldArr), B = mapBy(newArr);
    const where = scope ? ` on \`${scope}\`` : '';
    for (const [name, nb] of B) {
      if (!A.has(name)) { changes.push({ level: 'add', text: `Added ${noun} \`${name}\`${where}${sig ? ': `' + sig(nb) + '`' : ''}` }); continue; }
      const na = A.get(name);
      if (sig) {
        const sa = sig(na), sb = sig(nb);
        if (sa !== sb) changes.push({ level: 'change', text: `Changed ${noun} \`${name}\`${where}: \`${sa}\` → \`${sb}\`` });
      }
      if (!na.isDeprecated && nb.isDeprecated) changes.push({ level: 'change', text: `Deprecated ${noun} \`${name}\`${where}${nb.deprecationReason ? ': ' + nb.deprecationReason : ''}` });
      else if (na.isDeprecated && !nb.isDeprecated) changes.push({ level: 'change', text: `Un-deprecated ${noun} \`${name}\`${where}` });
      else if (na.isDeprecated && nb.isDeprecated && (na.deprecationReason || '') !== (nb.deprecationReason || '')) changes.push({ level: 'info', text: `Deprecation reason updated for ${noun} \`${name}\`${where}` });
      if ((na.description || '') !== (nb.description || '')) changes.push({ level: 'info', text: `Description updated for ${noun} \`${name}\`${where}` });
    }
    for (const name of A.keys()) {
      if (!B.has(name)) changes.push({ level: 'remove', text: `Removed ${noun} \`${name}\`${where}` });
    }
  }

  function diffField(changes, fa, fb, scope) {
    const where = scope ? ` on \`${scope}\`` : '';
    if (SDV.ref(fa.type) !== SDV.ref(fb.type)) changes.push({ level: 'change', text: `Return type${where} changed: \`${SDV.ref(fa.type)}\` → \`${SDV.ref(fb.type)}\`` });
    diffMembers(changes, 'argument', fa.args, fb.args, SDV.argSig, scope);
    if (!fa.isDeprecated && fb.isDeprecated) changes.push({ level: 'change', text: `Deprecated${where}${fb.deprecationReason ? ': ' + fb.deprecationReason : ''}` });
    else if (fa.isDeprecated && !fb.isDeprecated) changes.push({ level: 'change', text: `No longer deprecated${where}` });
    if ((fa.description || '') !== (fb.description || '')) changes.push({ level: 'info', text: `Description updated${where}` });
  }

  function diffType(changes, ta, tb) {
    const scope = tb.name;
    if (ta.kind !== tb.kind) { changes.push({ level: 'change', text: `Kind of \`${scope}\` changed: ${ta.kind} → ${tb.kind}` }); return; }
    const ia = (ta.interfaces || []).map((i) => i.name).sort().join(' & ');
    const ib = (tb.interfaces || []).map((i) => i.name).sort().join(' & ');
    if (ia !== ib) changes.push({ level: 'change', text: `Interfaces of \`${scope}\` changed: \`${ia || '∅'}\` → \`${ib || '∅'}\`` });
    if (ta.kind === 'UNION' || ta.kind === 'INTERFACE') diffMembers(changes, 'possible type', ta.possibleTypes, tb.possibleTypes, null, scope);
    if (ta.kind === 'ENUM') diffMembers(changes, 'enum value', ta.enumValues, tb.enumValues, null, scope);
    if (ta.kind === 'INPUT_OBJECT') diffMembers(changes, 'input field', ta.inputFields, tb.inputFields, SDV.argSig, scope);
    if (ta.kind === 'OBJECT' || ta.kind === 'INTERFACE') diffMembers(changes, 'field', ta.fields, tb.fields, fieldSig, scope);
    if ((ta.description || '') !== (tb.description || '')) changes.push({ level: 'info', text: `Description of \`${scope}\` updated` });
  }

  // snapshots: { item, related: {name: type|null} }
  function summarize(snapA, snapB) {
    const changes = [];
    const ia = snapA && snapA.item, ib = snapB && snapB.item;
    if (!ia && !ib) return changes;
    if (!ia) { changes.push({ level: 'add', text: 'Does not exist in the first version' }); return changes; }
    if (!ib) { changes.push({ level: 'remove', text: 'Does not exist in the second version' }); return changes; }
    if (ia.kind === 'FIELD' && ib.kind === 'FIELD') diffField(changes, ia.field, ib.field, null);
    else if (ia.kind === 'TYPE' && ib.kind === 'TYPE') diffType(changes, ia.type, ib.type);

    const names = new Set([...Object.keys(snapA.related || {}), ...Object.keys(snapB.related || {})]);
    for (const name of [...names].sort()) {
      const ta = snapA.related && snapA.related[name];
      const tb = snapB.related && snapB.related[name];
      if (ta && tb) diffType(changes, ta, tb);
      else if (!ta && tb) changes.push({ level: 'add', text: `Type \`${name}\` only exists in the second version` });
      else if (ta && !tb) changes.push({ level: 'remove', text: `Type \`${name}\` only exists in the first version` });
    }
    return changes;
  }

  Object.assign(SDV, { diffLines, summarize, fieldSig });
})();
