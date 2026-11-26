export const statuses = { pending: '待核对', accepted: '需修改', dismissed: '已排除', followup: '待查证' };
export const categories = { copy: '文字 / 单位', claims: '宣传用语', names: '配料名称', manual: '人工批注' };

export const fullSample = { id: 'sample-original', label: '完整展开稿', src: '/sample/original.jpg' };

const screenshotRegions = [
  ['sample-1', '成分与宣传面', [635, 13, 527, 351]],
  ['sample-2', '营养与标识面', [115, 13, 523, 351]],
  ['sample-3', '内袋', [105, 542, 191, 324]]
];

// Register the old screenshot to the 6252 × 5522 original using matching artwork in all three regions.
function originalBox([x, y, width, height]) {
  const scale = 4.431;
  return [(258 + x * scale) / 6252, (1185 + y * scale) / 5522,
    width * scale / 6252, height * scale / 5522];
}

export const sampleRegions = [
  { id: 'sample-1', label: '正面', box: [.53, .17, .41, .51] },
  { id: 'sample-2', label: '背标', box: [.06, .17, .46, .51] },
  { id: 'sample-3', label: '侧面', box: [.06, .70, .88, .15] }
];
export const rotateBox = ([x, y, w, h]) => [Math.max(0, 1 - x - w), Math.max(0, 1 - y - h), w, h];
export const readingBox = line => line.rotation === 180 ? rotateBox(line.box) : line.box;

export function upgradeSample(project) {
  if (!project.sample || project.pages.some(page => page.id === fullSample.id)) return;
  project.pages = [{ ...fullSample, ocr: 'waiting' }];
  for (const issue of project.issues) {
    const region = issue.pageId === 'sample-4' ? [0, 0, 1319, 923]
      : screenshotRegions.find(([id]) => id === issue.pageId)?.[2];
    if (!region) continue;
    const [x, y, w, h] = region;
    const toFull = ([left, top, width, height]) => originalBox([x + left * w, y + top * h, width * w, height * h]);
    issue.pageId = fullSample.id;
    if (issue.box) issue.box = toFull(issue.box);
    if (issue.boxes) issue.boxes = issue.boxes.map(toFull);
  }
}

function compareText(text) {
  return text.trim()
    .replace(/(?<=[\p{Script=Han}])[^\S\r\n]+(?=[\p{Script=Han}])/gu, '')
    .replace(/\s*([，、；：,:;])\s*/g, '$1');
}

const ingredientLabel = /^(?:[【\[（({〖〔]\s*)?(?:配料(?:表)?|原辅料(?:表)?|原料(?:表|组成)?|添加剂组成)\s*(?:(?:[】\]）)}〗〕]\s*[:：]?|[:：])\s*(.*)|$)/;
const nextField = /^(?:[【\[〖〔{]\s*[\p{Script=Han}]{2,12}\s*[】\]〗〕}]|[\p{Script=Han}]{2,12}\s*[:：]|[【\[〖〔{]?\s*(?:致敏物质|过敏原|营养成分|产品成分分析保证值|产品类别|净含量|食用方法|贮存条件|储存条件|保质期|适宜人群|不适宜人群|生产日期|生产商|生产者|执行标准|产品标准|注意事项|温馨提示))/u;

export function bounds(lines) {
  const left = Math.min(...lines.map(line => line.box[0]));
  const top = Math.min(...lines.map(line => line.box[1]));
  const right = Math.max(...lines.map(line => line.box[0] + line.box[2]));
  const bottom = Math.max(...lines.map(line => line.box[1] + line.box[3]));
  return [left, top, right - left, bottom - top];
}

const compactText = text => text.normalize('NFC').replace(/\s+/gu, '');
const cfuClaimScope = /(\d+(?:\.\d+)?)亿CFU\/(盒|袋|条|g|克)(?![a-z])/iu;

export function isPetProof(lines) {
  return lines.some(({ text }) => /宠物益生菌|宠物营养补充剂|宠物添加剂预混合饲料|补充性宠物食品|宠物饲料卫生规定/.test(compactText(text)))
    || ['原料组成', '添加剂组成'].every(label => lines.some(({ text }) => compactText(text).startsWith(`【${label}】`)));
}

function wordBox(line, start, end) {
  const words = line.words?.map(word => ({ ...word, text: compactText(word.text) }));
  if (!words || words.map(word => word.text).join('') !== line.text) return;
  let offset = 0;
  const selected = words.filter(word => {
    const from = offset;
    offset += word.text.length;
    return from < end && offset > start;
  });
  if (!selected.length) return;
  const first = words.indexOf(selected[0]);
  const prefix = words.slice(0, first).reduce((size, word) => size + word.text.length, 0);
  if (prefix !== start || prefix + selected.reduce((size, word) => size + word.text.length, 0) !== end) return;
  return bounds(selected);
}

export function matchQuote(lines, quote) {
  const needle = compactText(quote);
  if (!needle || !lines.length) return;
  const matches = new Map();
  const variants = lines.reduce((all, line) => all.flatMap(parts => {
    const baseline = { text: compactText(line.text), words: line.words };
    const alternate = { text: compactText(line.alternate ?? line.text), words: line.alternateWords };
    return (baseline.text === alternate.text ? [baseline] : [baseline, alternate]).map(part => [...parts, part]);
  }), [[]]);
  for (const parts of variants) {
    const text = parts.map(part => part.text).join('');
    const lastStart = text.length - parts.at(-1).text.length;
    for (let start = text.indexOf(needle); start >= 0 && start < parts[0].text.length; start = text.indexOf(needle, start + 1)) {
      const end = start + needle.length;
      if (end <= lastStart) continue;
      let offset = 0;
      const boxes = parts.map(part => {
        const from = Math.max(0, start - offset);
        const to = Math.min(part.text.length, end - offset);
        offset += part.text.length;
        return wordBox(part, from, to);
      });
      const key = `${start}:${end - lastStart}`;
      if (boxes.every(Boolean) || !matches.has(key)) matches.set(key, boxes.every(Boolean) ? boxes : []);
    }
  }
  if (matches.size) return { boxes: matches.size === 1 ? matches.values().next().value : [] };
}

function ingredientDifference(lines, quote) {
  if (!lines.some(line => line.alternate)) return;
  let match;
  for (let first = 0; first < lines.length; first += 1) {
    for (let last = first + 1; last <= Math.min(first + 4, lines.length); last += 1) {
      const span = lines.slice(first, last);
      const candidate = matchQuote(span, quote);
      if (!candidate) continue;
      if (match || !candidate.boxes.length) return;
      match = { span, boxes: candidate.boxes };
    }
  }
  if (!match) return;
  const original = match.span.map((line, i) => {
    const [left, , width] = match.boxes[i];
    return (line.words ?? []).filter(({ box: [x, , w] }) => x + w / 2 >= left && x + w / 2 <= left + width)
      .map(word => word.text).join('');
  }).join('');
  const chinese = text => text.replace(/[^\p{Script=Han}]+/gu, '');
  if (chinese(original).length < 2 || chinese(original) === chinese(quote)) return;
  return { original, boxes: match.boxes };
}

export function refineIngredient(lines, reread) {
  if (reread.length !== lines.length) return lines;
  const sorted = [...reread].sort((a, b) => a.box[1] - b.box[1]);
  if (!ingredientLabel.test(compareText(sorted[0]?.text ?? ''))) return lines;
  const aligned = lines.every(({ box }, index) => {
    const [x, y, width, height] = sorted[index].box;
    const centerShift = Math.abs(y + height / 2 - box[1] - box[3] / 2);
    const overlap = Math.min(x + width, box[0] + box[2]) - Math.max(x, box[0]);
    return centerShift <= box[3] * .5 && overlap >= box[2] * .8 && height <= box[3] * 1.6;
  });
  if (!aligned) return lines;
  return lines.map((line, index) => {
    const alternate = compareText(sorted[index].text);
    return alternate === compareText(line.text) ? line : { ...line, alternate, alternateWords: sorted[index].words };
  });
}

function splitNames(input) {
  const names = [];
  let depth = 0;
  let start = 0;
  const add = end => {
    const name = input.slice(start, end).trim();
    if (name) names.push(name);
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if ('（([{【'.includes(char)) depth += 1;
    else if ('）)]}】'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth || !/[、,，;；。\n]/.test(char)) continue;
    if (char === ',' && /\d,\d/.test(input.slice(Math.max(0, i - 1), i + 2))) continue;
    add(i);
    start = i + 1;
  }
  add(input.length);
  return names;
}

export function ingredientNames(input, parents = []) {
  return splitNames(compareText(input)).flatMap(query => {
    // Only expand an explicit mixture. Other parentheses can be part of the indexed name.
    const group = /^(复[合配][^（(]*|混合[^（(]*|预拌[^（(]*)[（(]([\s\S]+)[）)]$/.exec(query);
    if (group && splitNames(group[2]).length > 1) {
      return ingredientNames(group[2], [...parents, group[1].trim()]);
    }
    return [{ query, parents }];
  });
}

export function catalogQuery(name) {
  // Keep the display text intact. The shared index expects an uninterrupted strain identifier.
  const strain = /^(.+?(?:亚种|杆菌|球菌|酵母))\s*([A-Za-z][A-Za-z0-9.．·\-\s]*\d[A-Za-z0-9]*)$/u.exec(name);
  if (strain) return strain[1] + strain[2].replace(/\s+/g, '').replace(/[.．·]/g, '-');
  return name.replace(/(?<=\d),(?=\d)/g, '﹐');
}

function ingredientBlock(lines, first, firstText) {
  const [left, top, width, height] = readingBox(first);
  const aligned = lines.filter(line => (line.rotation === 180) === (first.rotation === 180));
  const body = !firstText && aligned.filter(line => {
    const [x, y, w, h] = readingBox(line);
    return y - top >= height * .5 && y - top <= Math.max(height, h) * 1.9 && w >= width
      && x <= left && x + w >= left + width && !nextField.test(line.text) && !ingredientLabel.test(line.text);
  }).sort((a, b) => readingBox(a)[1] - readingBox(b)[1])[0];
  const [bodyLeft, , bodyWidth] = readingBox(body || first);
  const columnTolerance = Math.max(.02, Math.min(.045, bodyWidth * .16));
  const following = aligned.map(line => ({ line, box: readingBox(line) })).filter(({ box }) =>
    box[1] >= top + height * .5 && (Math.abs(box[0] - bodyLeft) <= columnTolerance
      || (body && box[0] >= bodyLeft && box[0] + box[2] <= bodyLeft + bodyWidth && box[2] >= bodyWidth * .2)));
  following.sort((a, b) => a.box[1] - b.box[1]);
  const block = [first];
  let previous = readingBox(first);
  for (const { line, box } of following) {
    const [, y, , h] = box;
    const step = y - previous[1];
    if (step < previous[3] * .5) continue;
    if (step > Math.max(h, previous[3]) * 1.9 || nextField.test(line.text) || ingredientLabel.test(line.text)) break;
    block.push(line);
    previous = box;
  }
  const hasAlternate = block.some(line => line.alternate && line.alternate !== line.text);
  const preferred = block.map(line => line.alternate ?? line.text);
  return {
    quote: preferred.join('\n'),
    query: [ingredientLabel.exec(preferred[0])?.[1] ?? firstText, ...preferred.slice(1)].join(''),
    ...(hasAlternate && { baselineQuote: block.map(line => line.text).join('\n') }),
    box: block.length === 1 ? first.box : bounds(block),
    lineIndexes: block.map(line => line.index),
    count: block.length
  };
}

export function inspectLines(lines, pageId) {
  const findings = [];
  const readableLines = lines.map((line, index) => ({ ...line, text: compareText(line.text), index }));
  const pet = isPetProof(lines);
  readableLines.forEach((line, index) => {
    const { text: readable, box } = line;
    const compact = readable.replace(/\s+/g, '');
    const make = (type, title, reason, evidence = {}) => findings.push({
      id: `${pageId}-${index}-${type}`, pageId, type, title, reason, quote: readable, box,
      status: 'pending', note: '', boxes: [], ...evidence
    });
    const precise = (type, title, reason, quote) => {
      const boxes = matchQuote([line], quote)?.boxes ?? [];
      make(type, title, reason, { quote, boxes, box: boxes[0] ?? box });
    };
    const ingredient = ingredientLabel.exec(readable);
    if (ingredient) {
      const { count, ...evidence } = ingredientBlock(readableLines, line, ingredient[1] ?? '');
      const reason = count > 1
        ? `已接起同栏相邻的 ${count} 行。请对照原稿核对文字、标点和编号，再查名称。`
        : '识别到一行配料文字。查名称前请对照原稿确认是否还有续行。';
      const label = /原料组成|添加剂组成/.exec(readable)?.[0];
      make('names', label ? `核对${label}` : '核对配料名称', reason, evidence);
      if (evidence.baselineQuote) {
        const block = evidence.lineIndexes.map(i => readableLines[i]);
        ingredientNames(evidence.query).forEach(({ query }, ordinal) => {
          const name = /^([\p{Script=Han}]+(?:亚种|杆菌|球菌|酵母))(?=\s|[A-Za-z0-9]|$)/u.exec(query)?.[1] ?? query;
          const different = ingredientDifference(block, name);
          if (!different) return;
          const { original, boxes } = different;
          make('names', '核对单项配料字形', `两遍识别分别读为「${original}」和「${name}」。请对照原稿确认名称。`, {
            id: `${pageId}-${index}-ingredient-${ordinal}`, query: name, quote: name, boxes,
            box: bounds(boxes.map(box => ({ box }))), baselineQuote: original
          });
        });
      }
    }
    const petClaim = pet && /(?:用于)?(?:调理|缓解|改善|预防|治疗)[^；。！？]{0,24}(?:软便|腹泻|肠道紊乱)|降低药物带来的肠胃刺激/.exec(compact);
    const countClaim = /\d+(?:\.\d+)?亿\s*(?:CFU|活(?:性)?菌)(?:添加)?/i.exec(compact);
    const claim = /治疗|治愈|根治|疗效|降血糖|降血压|增强免疫力|调节肠道菌群|(?:中国发明)?专利菌株|\d+株专利菌/.exec(compact);
    if (petClaim) {
      precise('claims', '复核宠物功效表述', '这段涉及动物症状或用药效果。请结合原稿和支持材料复核宣传表述。', petClaim[0]);
    } else if (countClaim) {
      const scope = cfuClaimScope.exec(compact.normalize('NFKC'));
      const reason = scope ? `包装识别为每${scope[2].toLowerCase() === 'g' ? '克' : scope[2]}，请与配方及背标明细核对数值。`
        : '请确认每克、每袋或整盒的标示口径，并核对与配方及包装明细是否一致。';
      precise('claims', '核对活菌数声称', reason, scope?.[0] ?? countClaim[0]);
    } else if (claim) {
      precise('claims', '核对宣传表述与依据', '请结合整面包装、产品类别和支持材料，判断这处表达是否需要修改。', claim[0]);
    }
    const unit = /\d+(?:\.\d+)?(?:KG|Kg|MG|Mg|ML|Ml|G)(?![a-zA-Z])/.exec(compact);
    const punctuation = /[，、；：]{2,}/.exec(compact);
    if (/净含量|净重|规格/.test(compact) && unit) {
      precise('copy', '核对单位写法', '识别结果出现了大写或混写单位。请先核对原稿中的字符和单位。', unit[0]);
    } else if (punctuation) {
      precise('copy', '核对重复标点', '识别结果中出现相连标点，请对照原稿确认。', punctuation[0]);
    } else if (pet) {
      const separator = /CFU\/g[)）](?:[\p{Script=Han}]{2,12}(?:杆菌|球菌|酵母))/iu.exec(compact);
      if (separator) precise('copy', '核对成分间分隔符', '两项成分之间疑似缺少分隔符，请对照原稿。', separator[0]);
      const joinedNotices = '反刍动物产品质量检验';
      if (compact.includes(joinedNotices)) precise('copy', '核对两项标示之间的分隔',
        '识别到反刍动物警示和质量检验标示连在一起。请对照原稿，在「反刍动物」后换行，或加句号分开。', joinedNotices);
    }
  });
  return findings;
}

const cfuName = text => compactText(text).normalize('NFKC').toLowerCase();
const billion = n => `${Number((n / 1e8).toPrecision(12))} 亿 CFU/g`;

function compareCfuClaims(lines, pageId, rows, formula, complete) {
  const display = lines.map(line => line.text.normalize('NFKC').replace(/\s+/gu, ''));
  const netGrams = entry => {
    const net = /^净含量[:：]?(?:(\d+(?:\.\d+)?)g(?:\((\d+(?:\.\d+)?)g[x×*](\d+)(?:袋|条)?\))?|(\d+(?:\.\d+)?)g[x×*](\d+)(?:袋|条)?)$/iu.exec(entry);
    if (!net) return;
    const [, total, weight, count, packWeight, packs] = net;
    if (weight && Math.abs(Number(weight) * Number(count) - Number(total)) > 1e-6) return;
    return total ? Number(total) : Number(packWeight) * Number(packs);
  };
  const proofWeights = new Set(display.map(netGrams).filter(grams => grams > 0));
  const ready = complete && rows.length > 0 && rows.every(row => row.state !== 'pending' && Number.isFinite(row.value));
  const perGram = rows.reduce((sum, row) => sum + row.value, 0);
  const claims = [];
  for (const [index, text] of display.entries()) {
    const explicit = cfuClaimScope.exec(text);
    if (explicit && ['袋', '条'].includes(explicit[2])) continue;
    const claim = explicit ?? /^(\d+(?:\.\d+)?)亿活性菌添加$/u.exec(text);
    if (!claim) continue;
    const line = lines[index];
    const box = matchQuote([line], claim[0])?.boxes[0] ?? line.box;
    const key = { pageId, box, quote: claim[0], title: claim[0] };
    const boxScope = !explicit || explicit[2] === '盒';
    let grams = 1;
    if (!explicit) {
      const [x, y, w, h] = readingBox(line);
      const nearbyWeights = new Set(display.flatMap((entry, ordinal) => {
        if (lines[ordinal].rotation !== line.rotation) return [];
        const [left, top, width, height] = readingBox(lines[ordinal]);
        if (Math.abs(top + height / 2 - y - h / 2) > h * 2
            || Math.abs(left + width / 2 - x - w / 2) > .3) return [];
        const weight = netGrams(entry);
        return weight > 0 ? [weight] : [];
      }));
      if (!ready || nearbyWeights.size !== 1) continue;
      [grams] = nearbyWeights;
    } else if (boxScope) {
      [grams] = proofWeights.size === 1 ? proofWeights : [];
    }
    if (!ready || !grams) {
      claims.push({ ...key, state: 'pending', reason: !ready ? '原稿已标明计量口径，先补齐背标逐菌活菌数，再核算这处声称。'
        : '原稿已写每盒，尚未读取到唯一的净含量。请核对整盒克重后再比较数值。' });
      continue;
    }
    const total = perGram * grams / 1e8;
    const declared = Number(claim[1]);
    const formulaTotal = formula.rows.reduce((sum, row) => sum + row.perGram, 0) * grams / 1e8;
    const matches = value => Math.abs(value - declared) <= Math.max(1, declared, value) * 1e-9;
    const printed = `背标 ${rows.length} 项合计 ${billion(perGram)}${boxScope ? `，按${explicit ? '' : '同面'}净含量 ${grams} g 折算为整盒 ${Number(total.toPrecision(12))} 亿 CFU` : ''}`;
    if (matches(total) && matches(formulaTotal)) {
      if (explicit) claims.push({ ...key, state: 'checked', reason: `${printed}。与配方和包装声称一致。` });
      continue;
    }
    const advice = matches(formulaTotal) ? '按配方可达到正面数值，请先修正背标与配方不符的项目。'
      : '请按配方核对并统一声称及背标数值。';
    const reason = `${printed}，声称为 ${declared} 亿。${advice}${explicit ? '' : '请写清「每盒」口径。'}`;
    const id = `${pageId}-formula-${boxScope ? 'box' : 'gram'}-${index}`;
    claims.push({ ...key, state: 'difference', reason, issue: { ...key, id, boxes: [box], type: 'claims',
      source: 'formula', title: boxScope ? '核对整盒活菌数与背标合计' : '核对每克活菌数与背标合计', status: 'pending', note: '', reason } });
  }
  return claims;
}

export function compareFormulaCfu(lines, pageId, formula, localBlocks = [], previous = []) {
  const counts = new Map();
  const blocks = inspectLines(lines, pageId).filter(finding => finding.title === '核对添加剂组成')
    .map(finding => finding.lineIndexes.map(index => lines[index]));
  for (const block of [...blocks, ...localBlocks]) {
    for (const alternate of [false, true]) {
      const text = block.map((line, i) => {
        const content = compactText(alternate ? line.alternate ?? line.text : line.text);
        return i === 0 && content === '添加剂组成' ? '' : content;
      });
      const joined = text.join('');
      for (const match of joined.matchAll(/([\p{Script=Han}]{2,24}(?:[a-z][a-z\d-]*?\d[a-z\d-]*?)?)([(（]?)(\d+(?:\.\d+)?)[×x*]10(?:\^?(\d{1,2})|([⁰¹²³⁴⁵⁶⁷⁸⁹]{1,2})|[°º]?)(?:CFU\/g)([)）]?)/giu)) {
        const [quote, name, opening, coefficient, plain, superDigits, closing] = match;
        if (Boolean(opening) !== Boolean(closing) || (!opening && /[A-Za-z\d]$/u.test(name))) continue;
        const exponent = Number(plain ?? superDigits?.normalize('NFKC'));
        if (exponent > 20) continue;
        const key = cfuName(name);
        const perGram = Number.isFinite(exponent) ? Number(coefficient) * 10 ** exponent : null;
        let offset = 0;
        const cited = block.filter((_, index) => {
          const start = offset;
          offset += text[index].length;
          return start < match.index + quote.length && offset > match.index;
        });
        if (cited.length > 4) continue;
        const boxes = matchQuote(cited, quote)?.boxes ?? [];
        const list = counts.get(key) ?? new Map();
        if (!list.has(perGram) || boxes.length) {
          const box = boxes.length ? bounds(boxes.map(box => ({ box }))) : bounds(cited);
          list.set(perGram, { quote, boxes, box });
        }
        counts.set(key, list);
      }
    }
  }
  const names = new Map();
  for (const row of formula.rows) {
    const key = cfuName(row.name);
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  const rows = formula.rows.map((row, index) => {
    const key = cfuName(row.name);
    const amounts = counts.get(key);
    const valid = [...(amounts ?? [])].filter(([value]) => value !== null);
    const candidates = !amounts && row.image && /[A-Za-z][\w-]{2,}\d$/u.test(row.name) ? [...counts]
      .filter(([name, values]) => name.startsWith(key) && /^\d+$/u.test(name.slice(key.length))
        && values.size === 1 && !names.has(name)) : [];
    const fingerprint = JSON.stringify([row, names.get(key), [...(amounts ?? [])], candidates.map(([name, values]) => [name, [...values]])]);
    if (previous[index]?.fingerprint === fingerprint) return previous[index];
    const entry = { index, key, pageId, title: row.name, cell: row.cell, expected: Number.isFinite(row.perGram) ? billion(row.perGram) : '',
      state: 'pending', reason: '在包装添加剂栏未找到对应名称或菌株号。', fingerprint };
    if (!Number.isFinite(row.perGram)) return { ...entry, box: valid[0]?.[1].box ?? amounts?.get(null)?.box,
      reason: '配方表的每克活菌数缺失或无法解析，请核对单元格。' };
    if (names.get(key) !== 1) return { ...entry, reason: '配方表有重复名称，需核对菌株编号和对应行。' };
    if (valid.length > 1) return { ...entry, box: valid[0][1].box, reason: `包装读到不同数值（${valid.map(([value]) => billion(value)).join('、')}），请以原图为准。` };
    if (!valid.length) {
      if (amounts?.has(null)) return { ...entry, box: amounts.get(null).box, quote: amounts.get(null).quote,
        reason: '已定位包装原文，活菌数指数未读清。' };
      if (candidates.length !== 1) return entry;
      const [[candidate, values]] = candidates;
      const [[, evidence]] = values;
      const issue = { ...evidence, id: `${pageId}-formula-name-${key}-${candidate}`, pageId, type: 'copy',
        source: 'formula', title: '核对配方表菌株号', status: 'pending', note: '',
        reason: `配方「${formula.name}」${row.cell}的菌株名读为「${row.name}」，与包装菌株号未完全对应。请核对两份原稿的编号。` };
      return { ...entry, box: evidence.box, reason: '配方和包装的菌株号未完全对应。', issue };
    }
    const [[perGram, evidence]] = valid;
    const result = { ...entry, box: evidence.box, value: perGram, reason: `包装 ${billion(perGram)}，配方 ${entry.expected}。` };
    if (Math.abs(perGram - row.perGram) <= Math.max(perGram, row.perGram) * 1e-9) return { ...result, state: 'checked' };
    const issue = { ...evidence, id: `${pageId}-formula-${key}-${perGram}-${row.perGram}`, pageId, type: 'copy',
      source: 'formula', title: '核对活菌数与配方差异', status: 'pending', note: '',
      reason: `包装识别为 ${billion(perGram)}，配方表「${formula.name}」${row.cell}${row.image ? '的每克列' : ''} 为 ${billion(row.perGram)}。请对照两份原稿确认。` };
    return { ...result, state: 'difference', issue };
  });
  const claims = compareCfuClaims(lines, pageId, rows, formula, counts.size === rows.length);
  return { findings: [...rows, ...claims].flatMap(row => row.issue ? [row.issue] : []),
    matched: rows.filter(row => row.state !== 'pending').map(row => row.key), rows, claims };
}

export const annotationBoxes = issue => issue.boxes ?? (issue.type === 'manual' && issue.box ? [issue.box] : []);
export const conclusion = issue => issue.conclusion ?? (issue.note || issue.reason || '');
export const issueNumber = issue => String(issue.number ?? '').padStart(2, '0');
export const humanMark = issue => issue.type === 'manual' || issue.humanBox || conclusion(issue) !== issue.reason;

export function reviewMarkdown(name, pages, issues) {
  const single = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  const included = issues.filter(issue => ['accepted', 'followup'].includes(issue.status));
  const output = [`# ${single(name)} · 包装修改清单`, '',
    `共 ${included.length} 条人工处理意见。另有 ${issues.filter(issue => issue.status === 'pending').length} 条候选待核对。`, ''];
  for (const status of ['accepted', 'followup']) {
    const items = included.filter(issue => issue.status === status);
    if (!items.length) continue;
    output.push(`## ${statuses[status]}`, '');
    for (const issue of items) {
      const page = pages.find(item => item.id === issue.pageId);
      const location = issue.box
        ? `（距左 ${Math.round(issue.box[0] * 100)}%，距上 ${Math.round(issue.box[1] * 100)}%）`
        : '';
      output.push(`- ${issue.number ? `${issueNumber(issue)} · ` : ''}${single(page?.label || '未知版面')}${location} · ${single(issue.title)}`);
      if (issue.quote) output.push(`  - ${issue.type === 'manual' ? '原文' : '识别引文'}：${single(issue.quote)}`);
      output.push(`  - 审查结论：${single(conclusion(issue))}`, '');
    }
  }
  return output.join('\r\n');
}
