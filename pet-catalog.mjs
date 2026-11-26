import entries from './pet-catalog.json' with { type: 'json' };

// Public-regulation-cited normalization rules based on official MOA catalogs (2026-05 edition).
export const PUBLIC_NAMING_RULES = {
  schema: 'naming-rules.public.v1',
  rules: [
    {
      id: 'NR-001',
      from: '麦芽糊精',
      to: '糊精',
      kind: 'catalog_consolidation',
      citation: '《饲料原料目录（2026年5月版）》13.1.2 糊精',
      message: '2026-05 目录将麦芽糊精归入 13.1.2「糊精」（按葡萄糖当量 DE 值区分），规范名应写作「糊精」'
    },
    {
      id: 'NR-002',
      from: '一水葡萄糖',
      to: '葡萄糖',
      kind: 'catalog_consolidation',
      citation: '《饲料原料目录（2026年5月版）》13.4.6 葡萄糖',
      message: '目录 13.4.6「葡萄糖」特征描述已涵盖含一个结晶水的形式，规范名应写作「葡萄糖」'
    },
    {
      id: 'NR-003',
      from: '鱼溶桨粉',
      to: '鱼溶浆粉',
      kind: 'typo',
      citation: '《饲料原料目录（2026年5月版）》10.4.9 鱼溶浆粉',
      message: '目录规范名为「鱼溶浆粉」，「桨」为形近错字，应为「浆」'
    },
    {
      id: 'NR-004',
      from: '酸性蛋白酶',
      to: '蛋白酶（产自黑曲霉、米曲霉、枯草芽孢杆菌、长柄木霉3）',
      kind: 'catalog_consolidation',
      citation: '《饲料添加剂品种目录（2026年5月版）》酶制剂类',
      message: '目录酶制剂按来源分类而非最适 pH，「酸性蛋白酶」应对应目录规范名「蛋白酶」条目'
    }
  ]
};

function matchKey(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/\bdl-a-/gi, 'dl-α-')
    .toLowerCase()
    .replace(/[\s()（）【】\[\]{}\-—_,，、:：;；.。·]/g, '');
}

function normalizeBrackets(s) {
  return String(s).replace(/\(/g, '（').replace(/\)/g, '）').replace(/\s+/g, ' ').trim();
}

const ANNOTATION_PATTERNS = [
  /[（(]?\s*[≥≤>＞<＜]?\s*\d+(?:\.\d+)?\s*(?:[×xX*]\s*10\s*(?:\^|\*\*)?\s*[\d⁰¹²³⁴⁵⁶⁷⁸⁹]+|亿|万)?\s*CFU\s*(?:\/\s*[^\s）)，,、；;]*)?\s*[）)]?\s*$/i,
  /[（(]\s*[^（）()]*(?:\d+(?:\.\d+)?\s*(?:mg|g|kg|μg|ug|iu|u|%|％)|含量|不低于|不高于|原粉)[^（）()]*\s*[）)]\s*$/i,
  /[（(]?\s*\d+(?:\.\d+)?\s*(?:型|目|%|％)\s*[）)]?\s*$/
];

function stripAnnotation(name) {
  let text = normalizeBrackets(name).replace(/[。；;，,]+$/, '').trim();
  let changed = true;
  const stripped = [];
  while (changed) {
    changed = false;
    for (const re of ANNOTATION_PATTERNS) {
      const m = text.match(re);
      if (m && m[0].trim() && m[0].trim() !== text) {
        stripped.push(m[0].trim());
        text = text.slice(0, text.length - m[0].length).trim().replace(/[，,、；;]+$/, '').trim();
        changed = true;
        break;
      }
    }
  }
  return { name: text, stripped };
}

function splitTrailingQualifier(name) {
  const m = normalizeBrackets(name).match(/^(.*?)（([^（）]*)）$/);
  if (!m || !m[1].trim()) return { base: normalizeBrackets(name), qualifier: null };
  return { base: m[1].trim(), qualifier: m[2].trim() };
}

function splitStrainSuffix(name) {
  const m = normalizeBrackets(name).match(/^([一-龥]{3,})\s*([A-Za-z][A-Za-z0-9]*(?:[-‐]\d+)?)$/);
  if (!m) return { base: normalizeBrackets(name), strain: '' };
  return { base: m[1].trim(), strain: m[2].trim() };
}

const GRINDING_RE = /粉碎|粉状|研磨|磨碎|经粉碎/;

const CATEGORY_NAMES = new Map();
{
  const put = (names, source, section, note) => {
    for (const n of names) CATEGORY_NAMES.set(matchKey(n), { name: n, source, section, note });
  };
  put([
    '谷物及其制品', '油料籽实及其制品', '豆科籽实及其制品', '果蔬类籽实及其制品',
    '天然植物及其制品', '饲草类及其制品', '藻类及其制品', '乳类及其制品',
    '肉类及其制品', '昆虫及其制品', '蛋类及其制品', '鱼类等水生生物及其制品',
    '矿物质', '微生物发酵类制品'
  ], '《宠物饲料标签规定》附录 2', 'raw',
    '是《宠物饲料标签规定》附录 2 的原料类别名称，第六条允许原料组成按类别名称标示，不要求出现在《饲料原料目录》中');
  put(['抗氧化剂', '着色剂', '调味物质', '诱食物质', '调味和诱食物质'],
    '《宠物饲料标签规定》第六条', 'additive',
    '是饲料添加剂的类别名称，《宠物饲料标签规定》第六条允许抗氧化剂、着色剂、调味和诱食物质类标示类别名称');
  put(['宠物饲料复合调味料', '口味增强剂'],
    '《宠物饲料标签规定》第六条', 'raw',
    '是《宠物饲料标签规定》第六条指定的名称：以目录中动物水解物为主要原料复配的调味产品，应按此名标示');
}

function expandSlim(slim) {
  return slim.map((o) => ({
    id: o.i,
    section: o.s === 0 ? 'raw' : 'additive',
    canonical_name: o.n,
    match_keys: o.k.map((k) =>
      k.charAt(0) === '!' ? { key: k.slice(1), kind: 'base_no_qualifier' } : { key: k, kind: 'canonical' }),
    secondary_key: o.y || '',
    requires_subscript: !!o.b,
    pattern: o.p ? { prefix: o.p[0], suffix: o.p[1], template: o.p[2], allowed_fillers: o.p[3] || [] } : null,
    description: o.d || '',
    desc_has_grinding: GRINDING_RE.test(o.d || ''),
    label_requirement: o.l || '',
    qualifier: o.q ? { text: o.q } : null,
    category: o.c || '',
    scope: o.o || ''
  }));
}

class CatalogResolver {
  constructor(catalog, namingRules) {
    this.naming = new Map();
    for (const r of (namingRules && namingRules.rules) || []) {
      this.naming.set(matchKey(r.from), r);
    }
    this.records = catalog.records;
    this.byId = new Map(this.records.map((r) => [r.id, r]));
    this.primary = new Map();
    this.secondary = new Map();
    this.patterns = [];
    for (const r of this.records) {
      for (const k of r.match_keys) {
        if (!this.primary.has(k.key)) this.primary.set(k.key, []);
        this.primary.get(k.key).push({ id: r.id, kind: k.kind });
      }
      if (r.secondary_key) {
        if (!this.secondary.has(r.secondary_key)) this.secondary.set(r.secondary_key, []);
        this.secondary.get(r.secondary_key).push(r.id);
      }
      if (r.pattern) this.patterns.push(r);
    }
  }

  _hits(key, sectionHint) {
    let hits = this.primary.get(key) || [];
    if (sectionHint && hits.length > 1) {
      const narrowed = hits.filter((h) => this.byId.get(h.id).section === sectionHint);
      if (narrowed.length) hits = narrowed;
    }
    return hits;
  }

  _fillerKnown(filler) {
    const f = String(filler || '').trim();
    if (f.length < 2) return false;
    if (!this._nameBlob) {
      this._nameBlob = this.records.map((r) => r.canonical_name || '').join(' ');
    }
    if (this._nameBlob.includes(f)) return true;
    for (let i = 1; i <= f.length - 2; i++) {
      if (this._nameBlob.includes(f.slice(i))) return true;
    }
    return false;
  }

  _ambiguous(base, hits, reason) {
    const kinds = hits.map((h) => h.kind);
    return {
      ...base, status: 'ambiguous',
      ambiguity_kind: kinds.length && kinds.every((k) => k === 'base_no_qualifier')
        ? 'qualifier_variants' : 'name_collision',
      candidates: hits.map((h) => this._brief(h.id)),
      reason: reason || '目录中多个条目使用该名称'
    };
  }

  _deviations(input, record) {
    const out = [];
    const shown = normalizeBrackets(input);
    if (shown === record.canonical_name) return out;
    if (record.requires_subscript && /[A-EK]\s*\d/.test(shown) && !/[₀-₉]/.test(shown)) {
      out.push({ kind: 'subscript_required', message: `维生素编号须用下标，应写作「${record.canonical_name}」` });
    }
    if (matchKey(shown) === matchKey(record.canonical_name) && !out.length) {
      out.push({ kind: 'format', message: `写法与目录规范名有差异，规范名为「${record.canonical_name}」` });
    }
    return out;
  }

  resolve(rawName, options = {}) {
    const sectionHint = options.section || '';
    const original = String(rawName || '').trim();
    if (!original) return { status: 'no_match', input: original, reason: '空名称' };

    const { name: cleaned, stripped } = stripAnnotation(original);
    const base = { input: original, cleaned, stripped_annotations: stripped };

    // 0) Public-regulation-cited normalization rules
    const nr = this.naming.get(matchKey(cleaned));
    if (nr) {
      const target = this._hits(matchKey(nr.to), sectionHint);
      if (target.length === 1) {
        const r = this.byId.get(target[0].id);
        return {
          ...base, status: 'normalized', record_id: r.id, section: r.section,
          canonical_name: r.canonical_name,
          deviations: [{ kind: 'naming_rule', message: nr.message, rule_id: nr.id, citation: nr.citation }],
          label_requirement: r.label_requirement, scope: r.scope, category: r.category
        };
      }
    }

    // 1) Direct match
    let hits = this._hits(matchKey(cleaned), sectionHint);
    if (hits.length === 1) {
      const r = this.byId.get(hits[0].id);
      const dev = this._deviations(cleaned, r);
      return {
        ...base,
        status: hits[0].kind === 'base_no_qualifier' ? 'qualifier_omitted' : (dev.length ? 'format_deviation' : 'exact'),
        record_id: r.id, section: r.section, canonical_name: r.canonical_name,
        deviations: hits[0].kind === 'base_no_qualifier'
          ? [...dev, { kind: 'qualifier_omitted', message: `目录完整名为「${r.canonical_name}」，省略了限定「${r.qualifier ? r.qualifier.text : ''}」` }]
          : dev,
        label_requirement: r.label_requirement, scope: r.scope, category: r.category
      };
    }
    if (hits.length > 1) return this._ambiguous(base, hits);

    // 2) Strip trailing qualifier in parentheses
    const q = splitTrailingQualifier(cleaned);
    if (q.qualifier) {
      hits = this._hits(matchKey(q.base), sectionHint);
      if (hits.length === 1) {
        const r = this.byId.get(hits[0].id);
        return {
          ...base, status: 'exact', record_id: r.id, section: r.section, canonical_name: r.canonical_name,
          input_qualifier: q.qualifier,
          deviations: [...this._deviations(q.base, r)],
          note: `输入括号内「${q.qualifier}」为规格/来源说明，不参与名称裁决`,
          label_requirement: r.label_requirement, scope: r.scope, category: r.category
        };
      }
      if (hits.length > 1) return this._ambiguous(base, hits);
    }

    // 3) Strain suffix
    const s = splitStrainSuffix(q.qualifier ? q.base : cleaned);
    if (s.strain) {
      hits = this._hits(matchKey(s.base), sectionHint);
      if (hits.length === 1) {
        const r = this.byId.get(hits[0].id);
        return {
          ...base, status: 'strain_variant', record_id: r.id, section: r.section,
          canonical_name: r.canonical_name, strain_suffix: s.strain,
          deviations: this._deviations(s.base, r),
          label_requirement: r.label_requirement, scope: r.scope, category: r.category
        };
      }
      if (hits.length > 1) return this._ambiguous(base, hits);
    }

    // Trailing duplicated form character
    const dup = cleaned.match(/(粉|末|粒|片|油|粕|浆|膏|汁|渣|饼|块|条)\1$/);
    if (dup && cleaned.length > 2) {
      const fixed = cleaned.slice(0, cleaned.length - 1);
      const dhits = this._hits(matchKey(fixed), sectionHint);
      const target = dhits.length === 1 ? this.byId.get(dhits[0].id) : null;
      const want = target ? target.canonical_name : fixed;
      return {
        ...base, status: 'duplicated_char',
        record_id: target ? target.id : undefined,
        canonical_name: target ? target.canonical_name : undefined,
        section: target ? target.section : (sectionHint || ''),
        deviations: [{
          kind: 'duplicated_char',
          message: `名称结尾出现重叠字「${dup[1]}${dup[1]}」` +
            (target ? `，目录规范名为「${want}」` : `，去掉重复的「${dup[1]}」应为「${want}」，但该名称同样不在 2026-05 目录中`)
        }],
        reason: `名称结尾重叠字「${dup[1]}${dup[1]}」`
      };
    }

    // 4) Pattern match
    const probe = s.strain ? s.base : (q.qualifier ? q.base : cleaned);
    const pk = matchKey(probe);
    const patternHits = this.patterns.filter((r) => {
      const suffix = matchKey(r.pattern.suffix);
      const prefix = matchKey(r.pattern.prefix);
      if (!suffix || !pk.endsWith(suffix) || pk === suffix) return false;
      const filler = pk.slice(prefix.length, pk.length - suffix.length);
      if (!filler) return false;
      if (r.pattern.allowed_fillers.length) {
        return r.pattern.allowed_fillers.some((f) => matchKey(f) && filler.includes(matchKey(f)));
      }
      return true;
    }).sort((a, b) => matchKey(b.pattern.suffix).length - matchKey(a.pattern.suffix).length);
    if (patternHits.length) {
      const longest = matchKey(patternHits[0].pattern.suffix).length;
      const top = patternHits.filter((r) => matchKey(r.pattern.suffix).length === longest);
      if (top.length === 1) {
        const r = top[0];
        const filler = probe.slice(0, probe.length - r.pattern.suffix.length);
        if (!r.pattern.allowed_fillers.length && !this._fillerKnown(filler)) {
          return {
            ...base, status: 'unknown_filler', section: r.section,
            pattern_template: r.pattern.template, filler,
            deviations: [{
              kind: 'unknown_filler',
              message: `「${cleaned}」的写法像是目录通用条目「${r.pattern.template}」，但填进去的「${filler}」在 2026-05 目录里找不到对应的来源物，不能当作已写明具体来源`
            }],
            reason: `通用条目「${r.pattern.template}」的填充词「${filler}」不是目录里的来源物`
          };
        }
        return {
          ...base, status: 'pattern_match', record_id: r.id, section: r.section,
          canonical_name: probe, pattern_template: r.pattern.template,
          filler,
          allowed_fillers: r.pattern.allowed_fillers,
          label_requirement: r.label_requirement,
          deviations: [], scope: r.scope, category: r.category,
          note: `命中通用目录条目「${r.pattern.template}」，配方写明了具体来源`
        };
      }
      return this._ambiguous(base, top.map((r) => ({ id: r.id, kind: 'pattern' })), '命中多个通用目录条目');
    }

    // 5) Redundant form suffix
    const FORM_SUFFIX = /(粉末|粉|粒|末|片|颗粒)$/;
    const fm = probe.match(FORM_SUFFIX);
    if (fm && probe.length > fm[0].length + 1) {
      const trimmed = probe.slice(0, probe.length - fm[0].length);
      const fhits = this._hits(matchKey(trimmed), sectionHint);
      if (fhits.length === 1) {
        const r = this.byId.get(fhits[0].id);
        if (r.desc_has_grinding) {
          return {
            ...base, status: 'format_deviation', record_id: r.id, section: r.section,
            canonical_name: r.canonical_name,
            deviations: [{ kind: 'redundant_form_suffix', message: `目录规范名为「${r.canonical_name}」，特征说明已含粉碎工艺，后缀「${fm[0]}」冗余` }],
            label_requirement: r.label_requirement, scope: r.scope, category: r.category
          };
        }
      }
    }

    // 6) Secondary alias (e.g. vitamin alias without chemical name)
    const secHits = this.secondary.get(matchKey(cleaned)) || [];
    if (secHits.length === 1) {
      const r = this.byId.get(secHits[0]);
      return {
        ...base, status: 'alias_only', record_id: r.id, section: r.section,
        canonical_name: r.canonical_name,
        deviations: [{ kind: 'alias_only', message: `只写了维生素别名，目录规范名为「${r.canonical_name}」` }],
        label_requirement: r.label_requirement, scope: r.scope, category: r.category
      };
    }
    if (secHits.length > 1) {
      return {
        ...base, status: 'ambiguous', ambiguity_kind: 'vitamin_alias',
        candidates: secHits.map((id) => this._brief(id)),
        reason: '只写了维生素别名，目录中对应多个化合物'
      };
    }

    // 7) Statutory category names
    const catHit = CATEGORY_NAMES.get(matchKey(cleaned));
    if (catHit && (!sectionHint || sectionHint === catHit.section)) {
      return {
        ...base, status: 'category_name',
        canonical_name: catHit.name, section: catHit.section,
        category: catHit.name, category_source: catHit.source,
        label_requirement: '', scope: '',
        reason: catHit.note
      };
    }

    return { ...base, status: 'no_match', reason: '2026-05 目录中未找到该名称' };
  }

  _brief(id) {
    const r = this.byId.get(id);
    return {
      catalog_id: r.id, catalog_name: r.canonical_name, section: r.section,
      qualifier: r.qualifier ? r.qualifier.text : '',
      description: r.description || '',
      label_requirements: r.label_requirement || '',
      category: r.category || '', scope: r.scope || '',
      id: r.id, name: r.canonical_name
    };
  }
}

function splitTopLevel(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of String(text || '')) {
    if ('(（[【{'.includes(ch)) depth += 1;
    if (')）]】}'.includes(ch) && depth > 0) depth -= 1;
    if (depth === 0 && /[、,，;；\n]/.test(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function recoverMergedToken(token, section, R, depth) {
  const s = String(token).trim();
  if ((depth || 0) > 4 || s.length < 6) return null;
  const cuts = [];
  const re = /[）)]\s*(?=[^\s、,，;；)）])/g;
  let m;
  while ((m = re.exec(s))) cuts.push(m.index + m[0].length);
  for (const cut of cuts) {
    const head = s.slice(0, cut).trim();
    const tail = s.slice(cut).trim();
    if (!head || !tail) continue;
    const rh = R.resolve(head, { section });
    if (!rh.record_id) continue;
    const rt = R.resolve(tail, { section });
    if (rt.record_id) {
      return [{ name: head, res: rh }, { name: tail, res: rt }];
    }
    const rest = recoverMergedToken(tail, section, R, (depth || 0) + 1);
    if (rest) return [{ name: head, res: rh }].concat(rest);
  }
  return null;
}

const resolver = new CatalogResolver({ records: expandSlim(entries) }, PUBLIC_NAMING_RULES);

function catalogLabel(res) {
  if (res.status === 'category_name') return res.category_source || '《宠物饲料标签规定》';
  if (res.section === 'additive') return '饲料添加剂品种目录（2026-05）';
  if (res.section === 'raw') return '饲料原料目录（2026-05）';
  return '';
}

export function lookupPetCatalog(input, section) {
  const items = splitTopLevel(input).flatMap(name => {
    const res = resolver.resolve(name, { section });
    return res.record_id ? [{ name, res }] : recoverMergedToken(name, section, resolver) ?? [{ name, res }];
  }).map(({ name: query, res }) => {
    const notes = res.deviations?.map(item => item.message).filter(Boolean) ?? [];
    const sameSection = res.section === section;
    const verdict = res.status === 'ambiguous' ? 'ambiguous'
      : !sameSection || (!res.record_id && res.status !== 'category_name') ? 'unresolved'
      : notes.length ? 'nonconforming' : 'ok';
    const citation = res.deviations?.find(item => item.citation)?.citation;
    return {
      query,
      status: res.status,
      verdict,
      name: res.canonical_name,
      catalog: catalogLabel(res),
      record: res.record_id,
      code: res.record_id,
      source: citation || res.category || res.category_source || '',
      reason: res.reason,
      notes
    };
  });
  return { items };
}
