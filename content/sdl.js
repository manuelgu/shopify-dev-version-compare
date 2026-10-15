// Turns introspection JSON into GraphQL SDL text so versions can be diffed
// line by line. Shared via the global SDV namespace (content scripts share scope).
(function () {
  const SDV = (window.SDV = window.SDV || {});

  function ref(t) {
    if (!t) return '?';
    if (t.kind === 'NON_NULL') return ref(t.ofType) + '!';
    if (t.kind === 'LIST') return '[' + ref(t.ofType) + ']';
    return t.name;
  }

  function named(t) {
    while (t && t.ofType) t = t.ofType;
    return t ? { name: t.name, kind: t.kind } : null;
  }

  function byName(arr) {
    return (arr || []).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function desc(d, indent) {
    if (!d) return [];
    const text = String(d).replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.length === 1 && !text.includes('"""')) return [`${indent}"""${text}"""`];
    return [`${indent}"""`, ...lines.map((l) => indent + l), `${indent}"""`];
  }

  function deprecated(x) {
    if (!x || !x.isDeprecated) return '';
    return x.deprecationReason ? ` @deprecated(reason: ${JSON.stringify(x.deprecationReason)})` : ' @deprecated';
  }

  function argSig(a) {
    return `${a.name}: ${ref(a.type)}${a.defaultValue != null ? ' = ' + a.defaultValue : ''}`;
  }

  function printField(f, indent) {
    const out = desc(f.description, indent);
    const args = byName(f.args);
    if (!args.length) {
      out.push(`${indent}${f.name}: ${ref(f.type)}${deprecated(f)}`);
    } else if (args.some((a) => a.description)) {
      out.push(`${indent}${f.name}(`);
      for (const a of args) {
        out.push(...desc(a.description, indent + '  '));
        out.push(`${indent}  ${argSig(a)}`);
      }
      out.push(`${indent}): ${ref(f.type)}${deprecated(f)}`);
    } else {
      out.push(`${indent}${f.name}(${args.map(argSig).join(', ')}): ${ref(f.type)}${deprecated(f)}`);
    }
    return out;
  }

  function printType(t) {
    const out = desc(t.description, '');
    const impl = (t.interfaces || []).map((i) => i.name).sort();
    const implStr = impl.length ? ' implements ' + impl.join(' & ') : '';
    switch (t.kind) {
      case 'SCALAR':
        out.push(`scalar ${t.name}`);
        break;
      case 'UNION':
        out.push(`union ${t.name} = ${(t.possibleTypes || []).map((p) => p.name).sort().join(' | ')}`);
        break;
      case 'ENUM':
        out.push(`enum ${t.name} {`);
        for (const v of byName(t.enumValues)) {
          out.push(...desc(v.description, '  '));
          out.push(`  ${v.name}${deprecated(v)}`);
        }
        out.push('}');
        break;
      case 'INPUT_OBJECT':
        out.push(`input ${t.name} {`);
        for (const f of byName(t.inputFields)) {
          out.push(...desc(f.description, '  '));
          out.push(`  ${argSig(f)}`);
        }
        out.push('}');
        break;
      case 'INTERFACE':
      case 'OBJECT':
      default: {
        const kw = t.kind === 'INTERFACE' ? 'interface' : 'type';
        out.push(`${kw} ${t.name}${implStr} {`);
        for (const f of byName(t.fields)) out.push(...printField(f, '  '));
        out.push('}');
      }
    }
    return out;
  }

  // item: { kind: 'FIELD', root, field } | { kind: 'TYPE', type }
  function printItem(item) {
    if (!item) return [];
    if (item.kind === 'FIELD') {
      return [`# ${item.root === 'Mutation' ? 'mutation' : 'query'} field on ${item.root}`, ...printField(item.field, '')];
    }
    return printType(item.type);
  }

  // Non-scalar named types referenced directly by a field's args and return type.
  function relatedTypeNames(item) {
    if (!item || item.kind !== 'FIELD') return [];
    const names = new Set();
    const consider = (t) => {
      const n = named(t);
      if (n && n.kind !== 'SCALAR' && n.name && !n.name.startsWith('__')) names.add(n.name);
    };
    consider(item.field.type);
    for (const a of item.field.args || []) consider(a.type);
    return [...names].sort();
  }

  // Full SDL for one version's snapshot: the item plus its related types.
  function printSnapshot(snap) {
    if (!snap || !snap.item) return '';
    const parts = [printItem(snap.item).join('\n')];
    for (const name of Object.keys(snap.related || {}).sort()) {
      const t = snap.related[name];
      parts.push(t ? printType(t).join('\n') : `# type ${name} does not exist in this version`);
    }
    return parts.join('\n\n');
  }

  Object.assign(SDV, { ref, named, byName, printField, printType, printItem, relatedTypeNames, printSnapshot, argSig });
})();

// ---- member helpers (fields / args / input fields / enum values) ----------
(function () {
  const SDV = window.SDV;

  // The list of members of an item that the docs page renders individually.
  // Returns { noun, members: [{ name, sig, isDeprecated, deprecationReason }] }
  function members(item) {
    if (!item) return { noun: 'member', members: [] };
    const sigOf = (m, kind) => {
      if (kind === 'field') return SDV.fieldSig(m);
      if (kind === 'arg' || kind === 'input') return SDV.argSig(m);
      return m.name;
    };
    const pack = (arr, kind, noun) => ({ noun, members: (arr || []).map((m) => ({ name: m.name, sig: sigOf(m, kind), isDeprecated: !!m.isDeprecated, deprecationReason: m.deprecationReason || '' })) });
    if (item.kind === 'FIELD') return pack(item.field.args, 'arg', 'argument');
    const t = item.type;
    switch (t.kind) {
      case 'OBJECT': case 'INTERFACE': return pack(t.fields, 'field', 'field');
      case 'INPUT_OBJECT': return pack(t.inputFields, 'input', 'input field');
      case 'ENUM': return pack(t.enumValues, 'enum', 'value');
      case 'UNION': return pack(t.possibleTypes, 'type', 'possible type');
      default: return { noun: 'member', members: [] };
    }
  }

  // Non-scalar named types referenced by a type's fields, args and input fields.
  function referencedTypeNames(type, cap) {
    const names = new Set();
    const consider = (t) => {
      const n = SDV.named(t);
      if (n && n.kind !== 'SCALAR' && n.name && !n.name.startsWith('__') && n.name !== type.name) names.add(n.name);
    };
    for (const f of type.fields || []) { consider(f.type); for (const a of f.args || []) consider(a.type); }
    for (const f of type.inputFields || []) consider(f.type);
    for (const p of type.possibleTypes || []) names.add(p.name);
    const all = [...names].sort();
    return { names: all.slice(0, cap || all.length), total: all.length };
  }

  Object.assign(SDV, { members, referencedTypeNames });
})();
