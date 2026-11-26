import { bounds, ingredientNames, inspectLines, isPetProof, matchQuote, readingBox, resolveProofCategory, rotateBox } from './review.mjs';
import { FOOD_LABEL_FIELDS, PET_EXTENDED_FIELDS, PET_PRODUCTION_FIELDS } from './rules.mjs';

const compact = text => text.normalize('NFKC').replace(/\s+/gu, '');
const missingExponent = /\d+(?:\.\d+)?[x×*]10[°º]?CFU\/g/giu;
const explicitExponent = /^(\d+(?:\.\d+)?)[x×*]10\^?(\d{1,2})CFU\/g$/iu;
const weightUnit = '(?:kg|公斤|g|克)';
const weight = new RegExp(`^(?:(?:[<>≤≥])?\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?[-~～–]\\d+(?:\\.\\d+)?)${weightUnit}$`, 'iu');
const bareBoundaryWeight = new RegExp(`^(\\d+(?:\\.\\d+)?)(${weightUnit})$`, 'iu');
const rangeWeight = new RegExp(`^(\\d+(?:\\.\\d+)?)[-~～–](\\d+(?:\\.\\d+)?)(${weightUnit})$`, 'iu');

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function similarButDifferentName(front, back) {
  if (front === back) return false;
  if ([...front].sort().join('') === [...back].sort().join('')) return true;
  if (Math.abs(front.length - back.length) > 1 || Math.min(front.length, back.length) < 3) return false;
  // Avoid matching generic suffixes like "宠物益生菌" vs "益生菌"
  if (front.includes(back) || back.includes(front)) return false;
  const dist = levenshtein(front, back);
  const maxDist = front.length >= 5 ? 2 : 1;
  if (dist > maxDist) return false;
  const setA = new Set(front);
  const shared = [...new Set(back)].filter(ch => setA.has(ch)).length;
  return shared / Math.max(setA.size, new Set(back).size) >= 0.5;
}

export function proofNameCandidates(lines) {
  const front = new Map();
  const back = [];
  for (const line of lines) {
    const text = compact(line.text);
    if (/^\p{Script=Han}{3,12}$/u.test(text)) front.set(text, line);
    const petName = /^(?:【产品名称】|\[产品名称\]|产品名称:)[:：]?(?:宠物营养补充剂|补充性宠物食品|宠物添加剂预混合饲料)[:：]?(\p{Script=Han}{3,12})$/u.exec(text)?.[1];
    const foodName = !petName && /^(?:【(?:产品名称|品名)】|\[(?:产品名称|品名)\]|(?:产品名称|品名):)[:：]?(\p{Script=Han}{3,12})$/u.exec(text)?.[1];
    const name = petName || foodName;
    if (name) back.push({ name, line });
  }
  for (const { name, line } of back) {
    if (front.has(name)) continue;
    for (const [other, frontLine] of front) {
      if (!similarButDifferentName(other, name)) continue;
      const boxes = matchQuote([line], name)?.boxes;
      if (boxes?.length !== 1) continue;
      return [{ quote: other, box: frontLine.box, rotation: frontLine.rotation },
        { quote: name, box: boxes[0], rotation: line.rotation }];
    }
  }
  return [];
}

export function confirmedNameFinding(pageId, candidates, readings) {
  if (candidates.length !== 2 || !candidates.every(({ quote }, index) => compact(readings[index] ?? '').includes(quote))) return null;
  const [front, back] = candidates;
  return { id: `${pageId}-name-${front.quote}-${back.quote}`, pageId, type: 'copy', source: 'agent', status: 'pending', note: '',
    title: '核对正背面品名', quote: back.quote, box: back.box, boxes: [back.box],
    reason: `原图复读确认正面为「${front.quote}」，背面产品名称为「${back.quote}」。请核对需要统一的品名。` };
}

export function copyReread(finding) {
  if (finding.type !== 'copy' || finding.boxes?.length !== 1) return null;
  const pair = /[“「『"]([^”」』"]{1,12})[”」』"]\s*(?:疑(?:似)?为|可能是|应为)\s*[“「『"]([^”」』"]{1,12})[”」』"]/u.exec(finding.reason);
  if (!pair || pair[1] === pair[2] || !compact(finding.quote).includes(compact(pair[1]))) return null;
  return { original: compact(pair[1]), revised: compact(pair[2]) };
}

export function contradictedCopy(check, read) {
  const text = compact(read ?? '');
  return text.includes(check.revised) && !text.includes(check.original);
}

export function separatorReread(issue, text, alternate) {
  const boundary = /^(CFU\/g\))(.+)$/iu.exec(compact(issue.quote));
  if (!boundary) return;
  const [, end, start] = boundary;
  const reading = compact(text ?? '');
  if (reading.toLowerCase().includes((end + start).toLowerCase())) return {
    ...issue, reason: `原稿局部复读也读到「${issue.quote}」。前一项活菌数的右括号后直接接下一项「${start}」，请在右括号后补顿号「、」。`
  };
  if (['、', ',', ';', '。'].some(mark => [reading, compact(alternate ?? '')].every(read =>
    read.toLowerCase().includes((end + mark + start).toLowerCase())))) return null;
}

export function formulaCoversModelIssue(issue, formulaIssues) {
  if (!/(?:配方|数量级|数值)/.test(issue.reason) || /写法|大小写|字形|格式|排版/.test(issue.reason)) return false;
  const quote = compact(issue.quote).toLowerCase();
  return formulaIssues.some(item => item.title === '核对活菌数与配方差异'
    && quote === compact(item.quote).toLowerCase() && intersectsBox(issue.box, item.box));
}

export function catalogGlyphSupersedes(finding, glyphQuote) {
  if (!/下标|上标|字形|希腊|拉丁|字母/.test(finding.reason)) return false;
  const original = compact(finding.quote);
  const cited = compact(glyphQuote);
  return original.length >= 2 && cited.length >= 2 && (original.includes(cited) || cited.includes(original));
}

const petSections = ['核对原料组成', '核对添加剂组成'];

export function reviewSections(lines, pet = false) {
  const found = inspectLines(lines, 'sections', { category: pet ? 'pet' : 'food' }).filter(issue => issue.lineIndexes);
  const anchors = found.filter(({ title }) => petSections.includes(title));
  if (pet && anchors.length === 1) {
    const [anchor] = anchors;
    const first = lines[anchor.lineIndexes[0]];
    const rotate = first.rotation === 180;
    const [x, y, w, h] = rotate ? rotateBox(anchor.box) : anchor.box;
    const margin = first.box[3];
    const above = anchor.title === petSections[1];
    const top = Math.max(0, above ? y - margin * 8 : y + h - margin);
    const bottom = Math.min(1, above ? y + margin : y + h + margin * 12);
    const left = Math.max(0, x - margin);
    const right = Math.min(1, x + Math.max(w, margin * 20) + margin);
    if (bottom > top && right > left) {
      const box = [left, top, right - left, bottom - top];
      found.push({ title: petSections[Number(!above)], search: true, query: '', lineIndexes: [],
        box: rotate ? rotateBox(box) : box, rotate });
    }
  }
  return found.map((section, index) => ({ ...section, id: index + 1 }));
}

export function petCatalogText(text) {
  return text.replace(/[(（]\s*\d+(?:\.\d+)?\s*[x×*]\s*10[\d^⁰¹²³⁴⁵⁶⁷⁸⁹°º]*\s*CFU\s*\/\s*g\s*[)）](?=([\p{Script=Han}]+[A-Z][\w-]+\s*[(（]\s*\d)?)/giu,
    (_, next) => next ? '、' : '').replace(/\d+(?:\.\d+)?\s*[x×*]\s*10[\d^⁰¹²³⁴⁵⁶⁷⁸⁹°º]*\s*CFU\s*\/\s*g/giu, '');
}

export function sectionReread(section, primary, corroborating) {
  const relevant = lines => reviewSections(lines, petSections.includes(section.title))
    .filter(item => item.title === section.title && item.query && intersectsBox(item.box, section.box));
  const [candidate, extra] = relevant(primary);
  if (!candidate || extra) return;
  const names = query => ingredientNames(section.title === petSections[1] ? petCatalogText(query) : query)
    .map(({ query }) => compact(query));
  const baseline = names(section.query);
  const observed = names(candidate.query);
  if (!observed.length || (!section.search && (observed.length < baseline.length || (baseline.length > 1
    && !baseline.some(name => observed.includes(name)))))) return;
  const normalize = text => text.normalize('NFC').replace(/\s+/gu, '').replace(/[,，；;]/gu, '、').replace(/。$/u, '');
  const [second, ambiguous] = relevant(corroborating ?? []);
  const changed = normalize(candidate.query) !== normalize(section.query);
  if (!changed || !second || ambiguous || !intersectsBox(candidate.box, second.box)
    || normalize(candidate.query) !== normalize(second.query)) return;
  return { query: candidate.query, box: candidate.box, lines: candidate.lineIndexes.map(index => primary[index]) };
}

function sectionQuote(block, quote) {
  const found = block.flatMap((_, start) => [1, 2, 3, 4].slice(0, block.length - start).flatMap(length => {
    const span = block.slice(start, start + length);
    const match = matchQuote(span, quote);
    return match ? [{ boxes: match.boxes, box: match.boxes.length ? bounds(match.boxes.map(box => ({ box }))) : bounds(span) }] : [];
  }));
  return found.length === 1 ? found[0] : undefined;
}

const GREEK_LOOKALIKES = [
  ['β', /[bB]/],
  ['γ', /[rRyY]/],
  ['μ', /[uU]/],
  ['ω', /[wW]/]
];

function detectGlyphVerification(query, name, block) {
  const expectedSub = /([A-Za-z])([₀-₉]+)/.exec(name);
  if (expectedSub) {
    const base = expectedSub[1];
    const tokenPattern = new RegExp(`${base}[\\d₀-₉]*\\d[\\d₀-₉]*`);
    const observed = tokenPattern.exec(query)?.[0];
    if (observed && observed.normalize('NFKC') === expectedSub[0].normalize('NFKC')) {
      const glyphBox = block.map(line => matchQuote([line], observed)?.boxes?.[0]).find(Boolean);
      return { glyph: 'subscript', glyphBase: base, glyphBox };
    }
  }
  if (/[aA]/.test(query) && /α/.test(name)) {
    return { glyph: 'alpha' };
  }
  for (const [greek, latinRe] of GREEK_LOOKALIKES) {
    if (name.includes(greek) && !query.includes(greek) && latinRe.test(query)) {
      const observed = latinRe.exec(query)[0];
      return { glyph: 'greek', glyphExpected: greek, glyphObserved: observed };
    }
  }
  return {};
}

export function catalogFormatFindings(pageId, lines, section, items) {
  const block = section.lineIndexes.map(index => lines[index]);
  const actionableStatuses = new Set(['format_deviation', 'normalized', 'duplicated_char', 'alias_only']);
  return items.flatMap(({ query, status, verdict, name, record, notes }) => {
    if (!actionableStatuses.has(status) || verdict !== 'nonconforming' || !record || !name || !query) return [];
    const position = sectionQuote(block, query);
    if (!position?.boxes.length) return [];
    const glyphMeta = status === 'format_deviation' ? detectGlyphVerification(query, name, block) : {};
    const detail = notes?.length ? `${notes.join(' ')} ` : '';
    return [{ id: `${pageId}-catalog-${section.id}-${record}-${query}`, pageId, type: 'names', source: 'catalog',
      ...glyphMeta, catalogSection: section.title === petSections[1] ? 'additive' : 'raw',
      title: '核对目录名称写法', quote: query, ...position, status: 'pending', note: '',
      reason: `本地目录条目 ${record} 的对应写法为「${name}」。${detail}请对照原图核实该项名称、字形和排版。` }];
  });
}

export function catalogReviewRows(block, section, items, glyphs, flagged) {
  return items.map(item => {
    const { query, verdict, record, name, catalog, source } = item;
    const glyph = glyphs.find(entry => entry.quote === query);
    const visualMatch = ['subscript', 'superscript', 'greek_alpha', 'greek'].includes(glyph?.form);
    const issue = flagged.find(entry => entry.quote === query);
    const state = glyph?.form === 'unclear' || (!record && verdict !== 'ok') || ['unresolved', 'ambiguous'].includes(verdict)
      ? 'pending' : visualMatch || verdict === 'ok' && record ? 'checked' : issue ? 'difference' : 'pending';
    const reason = visualMatch ? '已在原图复核字形。' : glyph?.form === 'unclear' ? '原图字形未确认。'
      : state === 'pending' && !record ? '本地目录未定位到唯一条目，请核对原文及依据。'
        : issue?.reason || item.notes?.join(' ') || item.reason || (state === 'checked' ? '对应到本地目录条目。' : '请对照原图核对目录写法。');
    return { title: query, box: sectionQuote(block, query)?.box ?? section.box, state, reason,
      reference: [catalog, record, source, name].filter(Boolean).join(' · '), issueId: issue?.id };
  });
}

export function foodCatalogReviewRows(block, section, items) {
  return items.map(({ query, parents = [], matches = [] }) => {
    const title = [...parents, query].join(' › ');
    const box = sectionQuote(block, query)?.box ?? section.box;
    if (!matches.length) {
      return {
        title, box, state: 'checked',
        reason: '未落入新食品原料/特殊添加剂受限索引，按普通食品原料对照原稿核实。',
        reference: ''
      };
    }
    const top = matches[0];
    const alerts = [];
    if (top.foodcate && /不包括|仅限|不得|限量|范围/.test(top.foodcate)) alerts.push(`适用范围：${top.foodcate.slice(0, 60)}`);
    if (top.consumption && /≤|推荐|限量|天/.test(top.consumption)) alerts.push(`食用量提示：${top.consumption.slice(0, 50)}`);
    const needsCheck = alerts.length > 0 || top.status === 'SPECIES MATCH' || top.status === 'FUZZY MATCH' || top.status === 'MULTIPLE MATCH';
    const reason = alerts.length
      ? `命中「${top.official_name}」：${alerts.join('；')}。请核对适用人群与警示标示。`
      : top.status === 'SPECIES MATCH'
        ? `菌种名匹配「${top.official_name}」，请对照原稿核对具体菌株号与适用类别。`
        : top.status === 'EXACT MATCH'
          ? `索引精确匹配「${top.official_name}」。`
          : `索引返回相似候选「${top.official_name}」，请核对原稿写法与依据。`;
    return {
      title, box,
      state: needsCheck ? 'pending' : 'checked',
      reason,
      reference: [top.catalog_type, top.basis, top.ins && `INS ${top.ins}`].filter(Boolean).join(' · ')
    };
  });
}

const changesFormula = item => !item?.error && (item?.tool === 'reread' && item.data?.kind === 'cfu' && item.data.confirmed
  || item?.tool === 'look' && item.data?.formulaChanged);

export function reviewActions(proposals, sections, targets, formula, history) {
  const actions = [];
  const measuredFormula = history.findLastIndex(item => item?.tool === 'formula' && !item.error);
  const latestReread = history.findLastIndex(changesFormula);
  const formulaAttempts = history.slice(Math.max(measuredFormula, latestReread) + 1).filter(item => item?.tool === 'formula').length;
  for (const proposal of proposals.slice(0, 12)) {
    const { tool, id } = proposal ?? {};
    if (tool === 'formula') {
      if (formula === true && (measuredFormula < 0 || latestReread > measuredFormula) && formulaAttempts < 2
        && !actions.some(action => action.tool === tool)) actions.push({ tool });
      continue;
    }
    if (tool === 'look' || tool === 'catalog') {
      if (!sections.some(section => section.id === id)) continue;
      if (tool === 'catalog' && !history.some(item => item?.tool === 'look' && item.id === id && !item.error && !item.data?.notLocated)) continue;
    } else if (tool === 'reread') {
      if (!targets.some(target => target.id === id)) continue;
    } else {
      continue;
    }
    const attempted = history.filter(item => item?.tool === tool && item.id === id);
    const mayRetry = attempted.length === 1 && Boolean(attempted[0].error);
    if ((!attempted.length || mayRetry) && !actions.some(item => item.tool === tool && item.id === id)) actions.push({ tool, id });
  }
  return actions.slice(0, 6).sort((a, b) => Number(a.tool === 'formula') - Number(b.tool === 'formula'));
}

export function reviewCoverage(sections, history, hasFormula, targets = []) {
  const missing = sections.flatMap(({ id, title }) => (history.some(item => item.tool === 'look' && item.id === id && item.data?.notLocated && !item.error)
    ? ['look'] : ['look', 'catalog'])
    .filter(tool => !history.some(item => item.tool === tool && item.id === id && !item.error))
    .map(tool => ({ tool, id, title })));
  for (const { id, kind, quote } of targets) {
    if (kind === 'cfu' && !hasFormula) continue;
    if (!history.some(item => item.tool === 'reread' && item.id === id && !item.error)) {
      missing.push({ tool: 'reread', id, title: quote });
    }
  }
  const formulaIndex = history.findLastIndex(item => item.tool === 'formula' && !item.error);
  if (hasFormula && (formulaIndex < 0 || history.slice(formulaIndex + 1).some(changesFormula))) {
    missing.push({ tool: 'formula', title: '对照配方' });
  }
  return missing;
}

export function repairReview(sections, history, formula, targets) {
  const missing = reviewCoverage(sections, history, formula, targets);
  const actions = reviewActions(missing, sections, targets, formula, history);
  const readsPending = actions.some(item => item.tool === 'reread' && targets.find(target => target.id === item.id)?.kind === 'cfu'
    || item.tool === 'look' && sections.find(section => section.id === item.id)?.title === petSections[1]);
  return readsPending ? actions.filter(item => item.tool !== 'formula') : actions;
}

function matchFieldGroup(title, fields, pages, anchorPattern) {
  const lines = pages.flatMap(page => (page.lines ?? []).map(line => ({ ...line, pageId: page.id })));
  const anchor = anchorPattern ? lines.find(line => anchorPattern.test(compact(line.text))) : undefined;
  return {
    title,
    rows: fields.map(({ title: label, pattern, missing }) => {
      const found = lines.find(line => pattern.test(compact(line.text)));
      return {
        title: label,
        state: found ? 'checked' : 'pending',
        pageId: found?.pageId ?? anchor?.pageId ?? pages[0]?.id,
        box: (found ?? anchor)?.box,
        reason: found ? `原稿识别到「${found.text}」，可定位查看。` : missing
      };
    })
  };
}

function petLabelHandoff(pages) {
  return matchFieldGroup('基础标识', PET_PRODUCTION_FIELDS, pages, /生产许可|生产日期/u);
}

export function foodReviewHandoff(pages, formula, revision) {
  const active = pages.filter(page => page.agentRun?.revision === revision);
  const scanned = pages.filter(page => page.ocr === 'done' && page.lines?.length);
  if (!active.length && !scanned.length) return [];
  const sourcePages = active.length ? active : scanned;
  const groups = [];
  if (active.length) {
    const catalogRows = active.flatMap(page =>
      Object.values(page.agentRun.catalogRows ?? {}).flat().map(row => ({ ...row, pageId: page.id })));
    if (catalogRows.length) groups.push({ title: '配料目录查证', rows: catalogRows });
  }
  if (formula?.rows?.length) {
    const formulaRows = formula.rows.map((row, index) => {
      const options = pages.map(page => page.formulaRows?.[index]).filter(Boolean);
      const valid = options.filter(option => option.state !== 'pending');
      const chosen = valid[0] ?? options.find(option => option.box) ?? options[0]
        ?? { title: row.name, cell: row.cell, state: 'pending', reason: '尚未完成此行比对。' };
      return chosen;
    });
    groups.push({ title: '配方活菌数', reference: formula.name, rows: formulaRows });
  }
  if (formula?.ingredients?.length) {
    const ingredientRows = formula.ingredients.map((row, index) => {
      const options = pages.map(page => page.formulaIngredients?.[index]).filter(Boolean);
      return options.find(item => item.state === 'checked') ?? options[0]
        ?? { title: row.name, cell: row.cell, expected: row.amount, state: 'pending', reason: '尚未核对此项配方配料。' };
    });
    groups.push({ title: '配方配料核对', reference: formula.name, rows: ingredientRows });
  }
  const claims = sourcePages.flatMap(page => page.formulaClaims ?? []);
  if (claims.length) groups.push({ title: '活菌数声称', rows: claims });
  const unread = pages.filter(page => page.ocr !== 'done' || !page.lines?.length);
  if (unread.length) {
    groups.push({
      title: '未审版面',
      rows: unread.map(page => ({
        title: page.label, state: 'pending', pageId: page.id,
        reason: page.ocr === 'blank' ? '此版面未识别到文字，请查看原稿。' : page.ocr === 'failed' ? '本机识别失败，可重试。' : '等待识别。'
      }))
    });
  }
  groups.push(matchFieldGroup('基础标识（GB 7718）', FOOD_LABEL_FIELDS, sourcePages, /生产许可|配料|净含量/u));
  return groups;
}

export function petReviewHandoff(pages, formula, revision) {
  const active = pages.filter(page => page.agentRun?.revision === revision);
  if (!active.length) return [];
  const grouped = petSections.map(title => {
    const entries = active.flatMap(page => reviewSections(page.lines ?? [], true).filter(section => section.title === title)
      .map(section => ({ page, section, read: page.agentRun.history.find(item => item.tool === 'look' && item.id === section.id && !item.error),
        rows: page.agentRun.catalogRows?.[section.id] })));
    const found = entries.filter(({ section, read }) => !section.search || read?.data?.joined);
    const position = found[0];
    const group = { title: title.replace(/^核对/u, ''), position: position && { pageId: position.page.id,
      box: position.read?.data?.box ?? position.section.box }, rows: found.flatMap(({ page, section, rows, read }) =>
      rows?.length ? rows.map(row => ({ ...row, pageId: page.id })) : [{ title: title.replace(/^核对/u, ''), state: 'pending', pageId: page.id,
        box: read?.data?.box ?? section.box, reason: '名称目录查证尚未完成。' }]) };
    if (!found.length) {
      const anchor = entries[0];
      group.rows.push({ title: group.title, state: 'pending', pageId: anchor?.page.id ?? active[0].id,
        box: anchor?.section.box, reason: '未定位到该栏，请查看完整原稿确认。' });
    }
    return group;
  });
  const additive = grouped[1].position;
  const formulaRows = !formula?.rows?.length ? [{ title: '关联配方表', reason: '未关联配方表，无法核对每克活菌数。', state: 'pending' }]
    : formula.rows.map((row, index) => {
      const options = pages.map(page => page.formulaRows?.[index]).filter(Boolean);
      const valid = options.filter(option => option.state !== 'pending');
      const localized = options.find(option => option.box);
      const fallback = { title: row.name, cell: row.cell, state: 'pending', reason: '尚未完成此行比对。' };
      const chosen = valid[0] ?? localized ?? options[0] ?? fallback;
      if (new Set(valid.map(option => option.value)).size > 1) return { ...chosen, issue: undefined, state: 'pending',
        reason: '不同版面读到不同的活菌数，请核对各版面及配方。' };
      return chosen.box ? chosen : { ...chosen, pageId: additive?.pageId ?? chosen.pageId, box: additive?.box };
    });
  const claims = active.flatMap(page => page.formulaClaims ?? []);
  const unread = pages.filter(page => page.ocr !== 'done' || !page.lines?.length || !active.includes(page));
  const ingredientCheck = formula?.ingredients?.length ? [{
    title: '配方配料核对',
    reference: formula.name,
    rows: formula.ingredients.map((row, index) => {
      const options = pages.map(page => page.formulaIngredients?.[index]).filter(Boolean);
      return options.find(item => item.state === 'checked') ?? options[0]
        ?? { title: row.name, cell: row.cell, expected: row.amount, state: 'pending', reason: '尚未核对此项配方成分。' };
    })
  }] : [];
  return [...grouped, { title: '配方活菌数', reference: formula?.name, rows: formulaRows },
    ...ingredientCheck,
    ...(!claims.length ? [] : [{ title: '活菌数声称', rows: claims }]), ...(!unread.length ? [] : [{
    title: '未审版面', rows: unread.map(page => ({ title: page.label, state: 'pending', pageId: page.id,
      reason: page.ocr === 'blank' ? '此版面未识别到文字，请查看原稿。' : page.ocr === 'failed' ? '本机识别失败，可重试。' : '尚未运行视觉预审。' }))
  }]), petLabelHandoff(active), matchFieldGroup('其他法定标识', PET_EXTENDED_FIELDS, active, /生产许可|净含量|保质期/u)];
}

export function reviewHandoff(pages, formula, revision, categoryOverride = 'auto') {
  const allLines = pages.flatMap(page => page.lines ?? []);
  const category = resolveProofCategory(allLines, categoryOverride);
  return category === 'pet'
    ? petReviewHandoff(pages, formula, revision)
    : foodReviewHandoff(pages, formula, revision);
}

export function evidenceTargets(lines) {
  const targets = [];
  lines.forEach((line, index) => {
    const add = (kind, quote) => {
      const boxes = matchQuote([line], quote)?.boxes ?? [];
      const box = boxes[0] ?? (quote === line.text.trim() ? line.box : null);
      if (box) targets.push({ id: targets.length + 1, kind, index, quote, box });
    };
    for (const match of line.text.matchAll(missingExponent)) add('cfu', match[0]);
    const boundary = bareBoundaryWeight.exec(compact(line.text));
    if (!boundary) return;
    const [x, y, w, h] = readingBox(line);
    const neighbors = lines.filter(other => {
      if (other === line || (other.rotation === 180) !== (line.rotation === 180)) return false;
      const [ox, oy, ow, oh] = readingBox(other);
      const sameRow = Math.abs(oy + oh / 2 - y - h / 2) <= Math.max(h, oh) * .65
        && Math.abs(ox - x) < Math.max(w * 7, .06);
      const sameCol = Math.abs(ox + ow / 2 - x - w / 2) <= Math.max(w, ow) * 1.2
        && Math.abs(oy - y) <= Math.max(h, oh) * 3.5;
      return sameRow || sameCol;
    });
    const middle = neighbors.find(other => {
      const parts = rangeWeight.exec(compact(other.text));
      return parts && Number(parts[2]) === Number(boundary[1])
        && parts[3].toLowerCase() === boundary[2].toLowerCase();
    });
    if (middle) add('weight', line.text.trim());
  });
  return targets;
}

export function chooseEvidenceChecks(targets, selections) {
  const automatic = targets.filter(target => target.kind === 'cfu').slice(0, 4);
  const requested = new Set(Array.isArray(selections) ? selections.slice(0, 12) : []);
  const chosen = targets.filter(target => target.kind === 'weight' && requested.has(target.id)).slice(0, 2);
  return [...automatic, ...chosen];
}

export function coversEvidenceCheck(finding, check) {
  const quote = compact(finding.quote ?? '').toLowerCase();
  if (!quote.includes(compact(check.quote).toLowerCase())) return false;
  if (check.kind === 'cfu' && !/指数|上标|次方|数量级/.test(finding.reason)) return false;
  const [x, y, w, h] = finding.box;
  const centerX = check.box[0] + check.box[2] / 2;
  const centerY = check.box[1] + check.box[3] / 2;
  return centerX >= x && centerX <= x + w && centerY >= y && centerY <= y + h;
}

export function unsupportedReviewFinding({ quote, reason }) {
  if (typeof quote !== 'string' || typeof reason !== 'string') return false;
  return (/[x×*]10\d{1,2}CFU\/g/i.test(quote) && /上标|指数格式/.test(reason))
    || (/\d/.test(quote) && /(?:数值|含量|添加量|剂量)(?:偏|过|较)(?:高|低)/.test(reason));
}

export function intersectsBox([x, y, w, h], [a, b, c, d]) {
  return Math.min(x + w, a + c) > Math.max(x, a) && Math.min(y + h, b + d) > Math.max(y, b);
}

export function mergeRotatedLines(lines, reread) {
  const recovered = reread.filter(line => line.rotation === 180);
  const replaced = line => line.rotation === 180 && recovered.some(candidate => {
    const [x, y, w, h] = line.box;
    const [a, b, c, d] = candidate.box;
    const overlap = Math.min(x + w, a + c) - Math.max(x, a);
    return Math.abs(y + h / 2 - b - d / 2) < Math.min(h, d) * .6 && overlap >= w * .8;
  });
  return [...lines.filter(line => !replaced(line)), ...recovered];
}

function observedValues(target, lines) {
  const values = new Set();
  const writtenCoefficient = /^\d+(?:\.\d+)?/.exec(target.quote)?.[0];
  const coefficient = Number(writtenCoefficient);
  for (const line of lines) {
    if (!intersectsBox(target.box, line.box)) continue;
    const text = compact(line.text).replace(/(?<=\d)[·∙](?=\d)/gu, '.');
    if (target.kind === 'weight') {
      if (weight.test(text) && text.replace(/^[<>≤≥]/, '').toLowerCase() === compact(target.quote).toLowerCase()) {
        values.add(text.toLowerCase());
      }
      continue;
    }
    const cfuText = writtenCoefficient?.includes('.') ? text.replace(/(?<=\d),(?=\d)/gu, '.') : text;
    for (const token of cfuText.matchAll(/\d+(?:\.\d+)?[x×*]10\^?\d{1,2}CFU\/g/giu)) {
      const [, base, exponent] = explicitExponent.exec(token[0]);
      if (Number(base) === coefficient && Number(exponent) <= 20) values.add(`${coefficient}×10^${Number(exponent)}CFU/g`);
    }
  }
  return [...values];
}

export async function runEvidenceCheck(target, reread, readImage) {
  const engines = ['Windows OCR', 'PP-OCRv6 medium'];
  const read = async (requestedEngine, wider) => {
    try {
      const { lines, engine } = await reread(requestedEngine, wider);
      if (engine !== requestedEngine) return { engine: requestedEngine, values: [], error: '引擎不可用' };
      return { engine, values: observedValues(target, lines) };
    } catch (error) {
      return { engine: requestedEngine, error: error.message, values: [] };
    }
  };
  const readings = [];
  for (const engine of engines) readings.push(await read(engine, false));
  if (target.kind === 'cfu' && readings.some(reading => reading.values.length === 1)) {
    const index = readings.findIndex(reading => !reading.error && !reading.values.length);
    if (index >= 0) readings[index] = await read(engines[index], true);
  }
  if (readImage && target.kind === 'cfu' && readings.every(reading => !reading.error && !reading.values.length)) {
    readings[0] = await read(engines[0], 'center');
  }
  const consensus = () => {
    const values = new Set(readings.flatMap(reading => reading.values));
    return values.size === 1 && readings.filter(reading => reading.values.length === 1).length >= 2
      ? [...values][0] : '';
  };
  if (readImage && target.kind === 'cfu' && readings.every(reading => !reading.error)
    && readings.every(reading => reading.values.length <= 1) && readings.some(reading => !reading.values.length)) {
    try {
      const text = await readImage();
      const values = observedValues(target, [{ text, box: target.box }]);
      readings.push({ engine: '视觉模型复读', values });
    } catch (error) {
      readings.push({ engine: '视觉模型复读', values: [], error: error.message, optional: true });
    }
  }
  const confirmed = consensus();
  return { ...target, readings, confirmed };
}

export function evidenceFinding(reading, pageId) {
  const { kind, index, quote, box, readings, confirmed } = reading;
  if (confirmed && (kind === 'cfu' || confirmed !== compact(quote).toLowerCase())) return null;
  const evidence = readings.map(({ engine, values, error }) => `${engine}：${values.join(' / ') || (error ? '复读失败' : '未读清')}`).join('。');
  const reason = kind === 'cfu'
    ? `${evidence}。请在原稿确认指数，再核算此项活菌数。`
    : `${confirmed ? `两种识别均读为「${quote}」。` : `${evidence}。`}相邻两档涉及同一个体重/分量边界，请确认比较符号与分档口径。`;
  return { id: `${pageId}-evidence-${index}-${kind}-${quote}`, pageId, source: 'agent', type: 'copy',
    title: kind === 'cfu' ? '复核活菌数指数' : '复核喂食体重分档', quote, box, boxes: [box], reason, status: 'pending', note: '' };
}

export function retainedReviewIssues(issues, pageId, readings, clearedCatalog = new Set(), clearedCopy = new Set(), checkedBlocks = []) {
  return issues.filter(issue => {
    if (issue.pageId !== pageId || issue.status !== 'pending' || issue.note || issue.humanBox || Object.hasOwn(issue, 'conclusion')) return true;
    if (!issue.source && issue.title === '核对成分间分隔符' && clearedCopy.has(issue.id)) return false;
    if (issue.source === 'catalog') return !clearedCatalog.has(issue.id);
    if (issue.source === 'ai') return !clearedCopy.has(issue.id)
      && !unsupportedReviewFinding(issue) && !readings.some(reading => coversEvidenceCheck(issue, reading));
    if (issue.source === 'agent') return !readings.some(reading =>
      issue.quote === reading.quote && issue.id === `${pageId}-evidence-${reading.index}-${reading.kind}-${reading.quote}`
      && !evidenceFinding(reading, pageId));
    if (!issue.source && issue.lineIndexes?.length) return !checkedBlocks.some(block => block.title === issue.title
      && block.lineIndexes[0] === issue.lineIndexes[0]);
    return true;
  });
}

export function recoveredCfuLines(lines, readings = []) {
  const recovered = lines.slice();
  for (const { kind, index, quote, confirmed, box } of readings) {
    if (kind !== 'cfu' || !explicitExponent.test(confirmed)) continue;
    const line = recovered[index];
    if (!line) continue;
    const token = quote.normalize('NFC').replace(/\s+/gu, '');
    const text = line.text.normalize('NFC').replace(/\s+/gu, '');
    if (text.split(token).length !== 2 || !matchQuote([line], token)?.boxes.length) continue;
    const start = text.indexOf(token);
    let offset = 0;
    const words = line.words.flatMap(word => {
      const prior = offset;
      offset += word.text.normalize('NFC').replace(/\s+/gu, '').length;
      if (offset <= start || prior >= start + token.length) return [word];
      return prior === start ? [{ text: confirmed, box }] : [];
    });
    const alternate = line.alternate?.replace(quote, confirmed);
    recovered[index] = { ...line, text: text.replace(token, confirmed), words,
      ...(alternate && { alternate, alternateWords: alternate === line.alternate ? line.alternateWords : undefined }) };
  }
  return recovered;
}
