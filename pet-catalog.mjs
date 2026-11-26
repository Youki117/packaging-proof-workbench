import entries from './pet-catalog.json' with { type: 'json' };

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

// ═══════════════════════ resolver.js ═══════════════════════
/**
 * 目录名称解析器
 *
 *   而 no_match 在下游会变成幻影「包装多出」+ 错误的删除建议。
 *   这里把匹配拆成带类型的多级，每一级都给出可执行的偏差说明。
 *
 * 返回 status：
 *   exact              完全一致
 *   format_deviation   身份确定，写法不规范（下标、括号全半角等）
 *   strain_variant     身份确定，带菌株号后缀
 *   pattern_match      命中通用条目，需检查是否标明了具体来源
 *   ambiguous          命中多个，需更具体的写法
 *   no_match           目录内找不到
 */

/**
 * 剥离名称尾部的数量/规格注释。
 * 整串留在名字里，6 个菌全部匹配失败。这里按「任意计量单位」处理。
 */
const ANNOTATION_PATTERNS = [
  // 3×10⁹CFU/袋、≥2.5×10^9 CFU/g、100亿CFU/粒
  /[（(]?\s*[≥≤>＞<＜]?\s*\d+(?:\.\d+)?\s*(?:[×xX*]\s*10\s*(?:\^|\*\*)?\s*[\d⁰¹²³⁴⁵⁶⁷⁸⁹]+|亿|万)?\s*CFU\s*(?:\/\s*[^\s）)，,、；;]*)?\s*[）)]?\s*$/i,
  // （200mg/g）、(原粉20万u/g)、（含量不低于50%）
  /[（(]\s*[^（）()]*(?:\d+(?:\.\d+)?\s*(?:mg|g|kg|μg|ug|iu|u|%|％)|含量|不低于|不高于|原粉)[^（）()]*\s*[）)]\s*$/i,
  // 不带括号的商业规格后缀：甘露寡糖50型、XX 200目。
  // 目录里没有任何条目以「数字+型/目/%」结尾，剥了不会误伤。
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

/** 拆末尾括号限定（词内括号不动） */
function splitTrailingQualifier(name) {
  const m = normalizeBrackets(name).match(/^(.*?)（([^（）]*)）$/);
  if (!m || !m[1].trim()) return { base: normalizeBrackets(name), qualifier: null };
  return { base: m[1].trim(), qualifier: m[2].trim() };
}

/** 尾部菌株号：枯草芽孢杆菌DEMO-01 → base 枯草芽孢杆菌, strain DEMO-01 */
function splitStrainSuffix(name) {
  const m = normalizeBrackets(name).match(/^([一-龥]{3,})\s*([A-Za-z][A-Za-z0-9]*(?:[-‐]\d+)?)$/);
  if (!m) return { base: normalizeBrackets(name), strain: '' };
  return { base: m[1].trim(), strain: m[2].trim() };
}

/**
 * 目录压缩 / 还原。
 *
 * 包装结构和构建期溯源字段上。压缩后 153KB，特征说明全文保留
 * （语义匹配 AI 节点要用它做候选判据）。
 *
 * 本地和线上都走 slimify→expand，保证两边跑的是同一份数据，
 * 不会出现「本地对、线上错」这种最难查的分歧。
 */
const GRINDING_RE = /粉碎|粉状|研磨|磨碎|经粉碎/;

/**
 * 类别名称：查目录必然查不到，但它合法。
 *
 * 《宠物饲料标签规定》第六条允许「原料组成」按**类别名称**标示，
 * 类别名称的清单在该规定附录 2；《饲料原料目录》收的是**品种名称**，
 * 两份清单本来就不重叠。以前这 14 个名字进来一律 no_match，
 * 下游按「目录查无此名」判不合规 —— 包装照法规写反而被判错。
 *
 * 同条还规定了两类可以用类别名称的例外：
 *   · 添加剂组成里，抗氧化剂、着色剂、调味和诱食物质类可以只写类别名称；
 *   · 以目录中动物水解物为主要原料复配的调味产品，标示为
 *     「宠物饲料复合调味料」或者「口味增强剂」。
 */
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
    // 已裁决的规范化规则。每条都带 citation；无引证的规则留在
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

  /**
   * 通用条目的填充词是不是一个能认出来的来源。
   *
   * 目录里 51 条通用条目（「{}乳粉」「{}油」），只有 7 条列了允许的填充词，
   * 剩下 44 条原先是「填什么都算命中」。后缀只有一个字的有九条 ——
   * 米、瓜、藻、乳、油、虫、皮、肉、贝 —— 于是「一丁米」「东果仁」「小麦芽油」
   * 这种 OCR 错字全被判成合规放行，包装上错一个字就再也查不出来。
   *
   * 需求方 2026-09-05 的口径：只要跟目录规范名不一样，又不属于允许通行的写法，
   * 就要查出来说要改。所以这里给填充词加一道门槛，判据不引入任何新词表，
   * 只用目录自身 —— 真实来源必然在目录里留下痕迹：
   *   「全脂羊乳粉」的「全脂羊」含「羊」，目录里有羊肉粉、羊乳等条目 → 认
   *   「小麦芽油」的「小麦芽」，目录里没有任何条目含「小麦芽」          → 不认
   *   「一丁米」的「一丁」，目录里没有任何条目含「一丁」                → 不认
   * 单字填充词一律不认：真名是单字的（大米、羊乳）在前面几步就精确命中了，
   * 走到通用条目这一步还是单字填充的，基本都是缺字缺出来的。
   */
  _fillerKnown(filler) {
    const f = String(filler || '').trim();
    if (f.length < 2) return false;
    if (!this._nameBlob) {
      // 一次性拼一条大字符串，之后每次填充词判定都是一次 indexOf
      this._nameBlob = this.records.map((r) => r.canonical_name || '').join('');
    }
    if (this._nameBlob.includes(f)) return true;
    // 「全脂羊」这类前面挂了工艺／部位修饰的，逐步剥掉头部再试，
    // 剥到只剩一个字就停 —— 单字不作数，理由同上。
    for (let i = 1; i <= f.length - 2; i++) {
      if (this._nameBlob.includes(f.slice(i))) return true;
    }
    return false;
  }

  /**
   * 歧义结果。ambiguity_kind 区分两种性质完全不同的歧义：
   *   qualifier_variants —— 写的是目录条目的基名，目录里有多条带不同来源限定的
   *                         （贝莱斯芽孢杆菌 CECT5940 / CGMCC24752）。能不能省限定
   *   name_collision     —— 同名不同条目，必须写更具体的名称。
   * 策略层据此走不同分支。
   */
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

  /** 身份确定后，比对字面量给出写法偏差 */
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

    // 0) 已裁决的规范化规则（带引证出处）
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

    // 1) 直接命中
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

    // 2) 剥掉输入自带的末尾括号（配方常写规格：纤维素（黄色木之纤））
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

    // 3) 菌株号后缀
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

    //    只认**结尾重复的形态字**，不做整串去重 —— 整串去重会把「可可粉」
    //    这种本身就带叠字的名字误判成写错了。
    //    去掉一个重复字之后如果能在目录里命中，就把身份也一并定下来，
    //    整改意见才说得出该改成哪个规范名。
    //
    //    位置很关键：必须排在第 4 步「通用条目模式」前面。
    //    通用条目模式认的是「___油」「___乳粉」这类带空位的目录条目，
    //    「乌贼油油」照样能填进「___油」的空位，于是被当成命中、原样放行，
    //    重叠字就永远轮不到判。放在这里，精确命中（0–3 步）仍然优先，
    //    但模糊匹配之前先把重叠字拦下来。
    //    前面几步是精确命中，目录里没有任何条目以重叠形态字结尾（已核对
    //    原料 955 条 + 添加剂 519 条，零命中），所以不会误伤正常名称。
    const dup = cleaned.match(new RegExp('(粉|末|粒|片|油|粕|浆|膏|汁|渣|饼|块|条)\\1$'));
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

    // 4) 通用条目模式：___乳粉 匹配 全脂羊乳粉
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
        // 列了允许填充词的条目，上面的 filter 已经按列表筛过，能到这里就是合规填充。
        // 没列的条目要过 _fillerKnown 这道门槛，理由见该函数的注释。
        if (!r.pattern.allowed_fillers.length && !this._fillerKnown(filler)) {
          return {
            ...base, status: 'unknown_filler', section: r.section,
            pattern_template: r.pattern.template, filler,
            deviations: [{
              kind: 'unknown_filler',
              message: `「${cleaned}」的写法像是目录通用条目「${r.pattern.template}」，`
                + `但填进去的「${filler}」在 2026-05 目录里找不到对应的来源物，`
                + `不能当作已写明具体来源`
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

    // 5) 冗余形态后缀：圆苞车前子壳粉 vs 目录「圆苞车前子壳」
    //    仅当目录特征说明本身就描述了该形态时才认，避免 玉米粉→玉米 这类误配
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

    // 6) 次级线索（括号内维生素别名）
    //    只写「维生素B₆」而不写「盐酸吡哆醇（维生素B₆）」，本身就不是目录名。
    //    别名唯一指向一条时身份是确定的，不该混进「查无此名」；
    //    指向多条（B₁ 有盐酸/硝酸两种硫胺）才是真歧义。
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

    // N) 类别名称。目录里查不到是正常的——目录收品种名，类别名在附录 2。
    //    放在最后：品种名优先，只有品种名全部落空才按类别名认。
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

  /** 候选简报。字段名对齐「目录特征说明语义匹配 AI」节点声明的唯一证据集。 */
  _brief(id) {
    const r = this.byId.get(id);
    return {
      catalog_id: r.id, catalog_name: r.canonical_name, section: r.section,
      qualifier: r.qualifier ? r.qualifier.text : '',
      description: r.description || '',
      label_requirements: r.label_requirement || '',
      category: r.category || '', scope: r.scope || '',
      // 兼容本地脚本里按 id/name 读候选的老写法
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

const resolver = new CatalogResolver({ records: expandSlim(entries) });

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
    return { query, status: res.status, verdict, name: res.canonical_name, record: res.record_id,
      reason: res.reason, notes };
  });
  return { items };
}
