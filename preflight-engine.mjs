import { compareFormulaCfu, compareFormulaIngredients, humanMark, inspectLines, resolveProofCategory } from './review.mjs';
import {
  catalogFormatFindings, catalogGlyphSupersedes, catalogReviewRows, chooseEvidenceChecks,
  confirmedNameFinding, contradictedCopy, copyReread, evidenceFinding, evidenceTargets,
  foodCatalogReviewRows, formulaCoversModelIssue, intersectsBox, proofNameCandidates,
  recoveredCfuLines, repairReview, retainedReviewIssues, reviewCoverage, reviewSections,
  runEvidenceCheck, sectionReread, separatorReread
} from './agent.mjs';
import { patentIssues, reviewPatents } from './patents.mjs';

export const AGENT_REVISION = 5;
export const MAX_ROUNDS = 7;
export const MAX_CALLS = 16;
export const PAGE_TIMEOUT_MS = 120_000;

export function paddedRegion([x, y, w, h], padding) {
  const left = Math.max(0, x - padding);
  const top = Math.max(0, y - padding);
  return [left, top, Math.min(1, x + w + padding) - left, Math.min(1, y + h + padding) - top];
}

// Fixed bug from v0.4.11: run.local[id] stores `.query`, not `.joined`.
export function collectAdditiveQueries(pages) {
  return new Map(pages.map(page => {
    const sections = reviewSections(page.lines ?? [], true).filter(section => section.title === '核对添加剂组成');
    return [page.id, sections.map(section => page.agentRun?.local?.[section.id]?.query ?? section.query).filter(Boolean)];
  }));
}

export function evaluatePageFormula(page, formula, projectIssues, ocrRevision) {
  if (!formula) return { findings: [], staleIds: new Set() };
  const lines = page.lines ?? [];
  const localAdditives = Object.values(page.agentRun?.local ?? {}).filter(item => item.additive).map(item => item.lines);
  const localQueries = Object.values(page.agentRun?.local ?? {}).map(item => item.query).filter(Boolean);

  let findings = [];
  let matched = [];
  let rows = [];
  let claims = [];
  if (formula.rows?.length) {
    const cfuResult = compareFormulaCfu(
      recoveredCfuLines(lines, page.evidenceChecks),
      page.id,
      formula,
      localAdditives,
      page.formulaRows
    );
    ({ findings, matched, rows, claims } = cfuResult);
  }
  const ingredients = formula.ingredients?.length
    ? compareFormulaIngredients(lines, page.id, formula, localQueries)
    : [];

  page.formulaMatches = matched;
  page.formulaRows = rows;
  page.formulaClaims = claims;
  page.formulaIngredients = ingredients;

  const current = new Set(findings.map(issue => issue.id));
  const claimText = text => text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const stale = projectIssues.filter(issue => issue.pageId === page.id
    && issue.status === 'pending' && !humanMark(issue) && !Object.hasOwn(issue, 'conclusion')
    && (issue.source === 'formula' && !current.has(issue.id)
      || !issue.source && issue.title === '核对活菌数声称' && claims.some(claim =>
        claimText(claim.quote).startsWith(claimText(issue.quote)) && intersectsBox(claim.box, issue.box))));
  const staleIds = new Set(stale.map(issue => issue.id));
  const oldTotal = stale.find(issue => issue.title === '核对整盒活菌数与背标合计');
  if (oldTotal && !claims.some(claim => claim.quote === oldTotal.quote)) {
    const original = inspectLines(lines, page.id).find(issue => issue.title === '核对活菌数声称' && issue.quote === oldTotal.quote);
    if (original) {
      findings = [...findings, { ...original, id: `ocr${ocrRevision}-${page.ocrEngine === 'Windows OCR' ? 'winrt' : 'paddle'}-${original.id}` }];
    }
  }
  return { findings, staleIds };
}

export function runPatentReviewForProject({ pages, issues, registry }) {
  const donePages = pages.filter(page => page.ocr === 'done');
  const additives = collectAdditiveQueries(pages);
  const patentReview = reviewPatents(donePages, additives, registry);
  const { kept, findings } = patentIssues(patentReview, issues);
  return { patentReview, kept, findings };
}

export function rereadDetail({ lines, check, signal, recognizeRegion, readImage }) {
  const [x, y, w, h] = check.box;
  const [, lineY, , height] = lines[check.index].box;
  return runEvidenceCheck(check, (engine, useLineBounds) => {
    const rotate = lines[check.index].rotation === 180;
    if (useLineBounds === 'center') {
      const left = Math.max(0, x - h * .55);
      const top = Math.max(0, y - h * .45);
      return recognizeRegion(
        [left, top, Math.min(1, x + w + h * .55) - left, Math.min(1, y + h * 1.45) - top],
        { zoom: 4, windows: true, rotate, signal }
      );
    }
    const padding = height * .7;
    const left = Math.max(0, x - padding);
    const top = Math.max(0, (useLineBounds ? lineY : y) - height * .35);
    const bottom = useLineBounds ? lineY + height * 1.25 : y + h + height * .25;
    return recognizeRegion(
      [left, top, Math.min(1, x + w + padding) - left, Math.min(1, bottom) - top],
      { zoom: 4, windows: engine === 'Windows OCR', rotate, signal }
    );
  }, readImage);
}

export async function runVisionPreflight({
  page,
  formula,
  projectIssues,
  category = 'auto',
  allowRemote = false,
  timeoutMs = PAGE_TIMEOUT_MS,
  deps,
  onProgress = () => {},
  onCheckpoint = () => {},
  isCurrent = () => true
}) {
  const lines = page.lines ?? [];
  const resolvedCategory = resolveProofCategory(lines, category);
  const pet = resolvedCategory === 'pet';
  const sections = reviewSections(lines, pet);
  const details = evidenceTargets(lines);
  const hasFormula = Boolean(formula?.rows?.length || formula?.ingredients?.length);

  const resumable = page.agentRun?.state === 'paused' && page.agentRun.revision === AGENT_REVISION;
  const run = resumable ? page.agentRun : {
    revision: AGENT_REVISION,
    state: 'paused',
    history: [],
    readings: [],
    trace: [],
    catalogIssues: [],
    clearedCatalog: new Set(),
    catalogRows: {},
    local: {}
  };
  if (!(run.clearedCatalog instanceof Set)) {
    run.clearedCatalog = new Set(Array.isArray(run.clearedCatalog) ? run.clearedCatalog : []);
  }
  page.agentRun = run;
  onCheckpoint();

  const { history, readings, trace, catalogIssues, clearedCatalog } = run;
  const crops = [];
  const failures = [];
  const result = { findings: [], catalogIssues, clearedCatalog, readings, trace, failures, verified: [], clearedCopy: new Set() };
  const signal = AbortSignal.timeout(timeoutMs);
  const missing = () => reviewCoverage(sections, history, hasFormula, details);
  const repairs = () => repairReview(sections, history, hasFormula, details);
  let finished = false;
  let finish = false;
  let retriedFormat = false;

  const sectionView = section => {
    if (section.search) return { box: section.box, rotate: section.rotate };
    const first = lines[section.lineIndexes[0]];
    return { box: paddedRegion(section.box, first.box[3] * .5), rotate: first.rotation === 180 };
  };
  const includeCrop = (section, image) => {
    const prior = crops.findIndex(crop => crop.id === section.id);
    if (prior >= 0) crops.splice(prior, 1);
    crops.push({ id: section.id, image });
    if (crops.length > 3) crops.shift();
  };

  try {
    const overview = deps.cropPhoto([0, 0, 1, 1], false, 1);
    for (const item of history.filter(item => item.tool === 'look' && !item.error).slice(-3)) {
      const section = sections.find(candidate => candidate.id === item.id);
      if (!section) continue;
      const { box, rotate } = sectionView(section);
      const image = deps.cropPhoto(box, rotate, 1);
      if (image) includeCrop(section, image);
    }

    for (let round = 0; round < MAX_ROUNDS && isCurrent(); round += 1) {
      signal.throwIfAborted();
      onProgress(`Agent 正在${round ? '根据工具结果继续查证' : '查看完整展开稿'} · ${page.label}`);
      const finalTurn = finish || round === MAX_ROUNDS - 1 || history.length === MAX_CALLS;
      let step;
      try {
        step = await deps.callApi('/api/ai?mode=vision', JSON.stringify({
          lines, overview, crops, history, formula: hasFormula, pet, category: resolvedCategory,
          allowRemote, finish: finalTurn
        }), signal);
      } catch (error) {
        if (retriedFormat || !error.message.includes('未返回约定') || round === MAX_ROUNDS - 1) throw error;
        retriedFormat = true;
        trace.push('模型输出格式错误 · 重试一次');
        continue;
      }
      if (!isCurrent()) break;
      if (step.findings) {
        result.findings = step.findings;
        if (!missing().length) {
          finished = true;
          break;
        }
      }
      const planned = step.actions ?? [];
      const recovery = !planned.length && !finalTurn;
      const actions = recovery ? repairs() : planned;
      if (!actions.length) {
        if (finalTurn) break;
        finish = true;
        continue;
      }

      for (const action of actions.slice(0, MAX_CALLS - history.length)) {
        if (!isCurrent()) break;
        signal.throwIfAborted();
        const { tool, id } = action;
        const section = sections.find(s => s.id === id);
        const detail = details.find(d => d.id === id);
        const additive = section?.title === '核对添加剂组成';
        const petSection = pet && (additive || section?.title === '核对原料组成');
        const label = tool === 'look' ? `看原图 · ${section.title}`
          : tool === 'catalog' ? `查目录 · ${section.title}`
            : tool === 'reread' ? `复读原图 · ${detail.quote}` : '逐项对照配方';
        onProgress(`Agent · ${label}`);
        const item = { ...action, origin: recovery ? 'coverage' : 'model' };
        const started = performance.now();
        try {
          if (tool === 'look') {
            const { box, rotate } = sectionView(section);
            const image = deps.cropPhoto(box, rotate, 1);
            if (!image) throw Error('局部尺寸不足。');
            const read = await deps.recognizeRegion(box, { rotate, signal });
            if (!read.lines.length && !section.search) throw Error('局部未识别到文字。');
            includeCrop(section, image);
            if (read.engine !== 'Windows OCR' && sectionReread(section, read.lines, read.lines)) {
              try {
                const confirmation = await deps.recognizeRegion(box, { rotate, windows: true, signal });
                const recovered = confirmation.engine === 'Windows OCR' && sectionReread(section, read.lines, confirmation.lines);
                if (recovered) run.local[id] = { ...recovered, additive };
              } catch {
                // Non-Windows or Windows OCR unavailable: keep primary read safely.
              }
            }
            const recovered = run.local[id];
            item.data = {
              engine: read.engine,
              lines: read.lines.map(line => line.text),
              joined: recovered?.query ?? section.query,
              box: recovered?.box,
              notLocated: !recovered && section.search,
              formulaChanged: Boolean(additive && recovered)
            };
            trace.push(`${label} · ${read.lines.length} 行`);
          } else if (tool === 'catalog') {
            const base = section.lineIndexes.map(index => lines[index]);
            const recovered = run.local[id];
            const block = recovered?.lines ?? base;
            const kind = additive ? 'additive' : 'raw';
            const query = recovered?.query ?? section.query;
            const { items } = await deps.callApi(petSection ? `/api/catalog?pet=${kind}` : '/api/catalog', query, signal);
            if (!items.length) throw Error('目录未收到可查的名称。');
            const located = { ...section, box: recovered?.box ?? section.box, lineIndexes: block.map((_, index) => index) };
            const candidates = petSection ? catalogFormatFindings(page.id, block, located, items) : [];
            const flagged = candidates.filter(issue => !issue.glyph);
            const toVerify = candidates.filter(issue => issue.glyph);
            const glyphs = [];
            const rotate = block[0]?.rotation === 180;
            for (let start = 0; start < toVerify.length; start += 6) {
              const batch = toVerify.slice(start, start + 6);
              onProgress(`Agent · 回到原图确认 ${batch.length} 处字形`);
              const { forms } = await deps.callApi('/api/ai?mode=glyphs', JSON.stringify({
                allowRemote,
                crops: batch.map(issue => {
                  const box = issue.glyphBox ?? issue.box;
                  return {
                    kind: issue.glyph,
                    ...(issue.glyphBase && { base: issue.glyphBase }),
                    ...(issue.glyphExpected && { expected: issue.glyphExpected }),
                    ...(issue.glyphObserved && { observed: issue.glyphObserved }),
                    image: deps.cropPhoto(paddedRegion(box, box[3] * .4), rotate, 3)
                  };
                })
              }), signal);
              batch.forEach((issue, index) => {
                const form = forms[index];
                glyphs.push({ quote: issue.quote, box: issue.box, form });
                if (form === 'normal' || form === 'latin_a' || form === 'latin') flagged.push(issue);
                if (form === 'subscript' || form === 'superscript' || form === 'greek_alpha' || form === 'greek') clearedCatalog.add(issue.id);
                if (form === 'unclear') {
                  flagged.push({ ...issue, title: '回看原图确认字形', reason: `${issue.reason} 原图复读未能确认实际字形。` });
                }
              });
            }
            catalogIssues.push(...flagged.map(({ glyph, glyphBase, glyphExpected, glyphObserved, glyphBox, ...issue }) => issue));
            if (petSection) {
              run.catalogRows[id] = catalogReviewRows(block, located, items, glyphs, flagged);
              const found = new Set(flagged.map(issue => issue.id));
              projectIssues.filter(issue => issue.id.startsWith(`${page.id}-catalog-${id}-`) && !found.has(issue.id))
                .forEach(issue => clearedCatalog.add(issue.id));
            } else {
              run.catalogRows[id] = foodCatalogReviewRows(block, located, items);
            }
            item.data = {
              items: petSection ? items : items.map(({ query: q, matches }) => ({ query: q, matches: matches.slice(0, 3) })),
              flagged: flagged.map(issue => issue.quote),
              glyphs
            };
            trace.push(`${label} · ${items.length} 项`);
            if (glyphs.length) trace.push(`回看字形 · ${glyphs.length} 处`);
          } else if (tool === 'reread') {
            const reading = await rereadDetail({
              lines,
              check: detail,
              signal,
              recognizeRegion: deps.recognizeRegion,
              readImage: async () => {
                const image = deps.cropPhoto(paddedRegion(detail.box, detail.box[3] * .44), lines[detail.index].rotation === 180, 5);
                if (!image) return '';
                const { texts } = await deps.callApi('/api/ai?mode=proof-text', JSON.stringify({ allowRemote, crops: [image] }), signal);
                return texts[0];
              }
            });
            const previous = readings.findIndex(check => check.id === id);
            if (previous >= 0) readings.splice(previous, 1);
            readings.push(reading);
            item.data = { kind: reading.kind, readings: reading.readings, confirmed: reading.confirmed };
            if (reading.readings.some(entry => entry.error && !entry.optional)) throw Error('局部复读引擎未能完成。');
            trace.push(`${label} · ${reading.confirmed || '待确认'}`);
          } else if (tool === 'formula') {
            const blocks = Object.values(run.local).filter(entry => entry.additive).map(entry => entry.lines);
            const compared = formula?.rows?.length
              ? compareFormulaCfu(recoveredCfuLines(lines, readings), page.id, formula, blocks, page.formulaRows)
              : { rows: [], matched: [], findings: [] };
            const localQueries = Object.values(run.local).map(entry => entry.query).filter(Boolean);
            const ingredients = formula?.ingredients?.length
              ? compareFormulaIngredients(lines, page.id, formula, localQueries)
              : [];
            page.formulaRows = compared.rows;
            page.formulaIngredients = ingredients;
            item.data = {
              source: formula.name,
              total: formula.rows?.length ?? 0,
              matched: compared.matched,
              pending: compared.rows.filter(row => row.state === 'pending').map(({ title, cell, reason }) => ({ title, cell, reason })),
              findings: compared.findings.map(({ quote, reason }) => ({ quote, reason })),
              ...(ingredients.length && {
                ingredientsMatched: ingredients.filter(r => r.state === 'checked').length,
                ingredientsTotal: ingredients.length
              })
            };
            trace.push(`${label} · ${compared.matched.length}/${formula.rows?.length ?? 0} 项`);
          }
        } catch (error) {
          item.error = error.message;
          trace.push(`${label} · 未完成`);
        }
        if (!isCurrent()) return result;
        history.push({ ...item, elapsedMs: Math.round(performance.now() - started) });
        if (recovery) trace[trace.length - 1] += ' · 覆盖检查补查';
        onCheckpoint();
      }
    }

    if (finished && isCurrent()) {
      const observedGlyphs = history.filter(item => item.tool === 'catalog' && !item.error)
        .flatMap(item => item.data.glyphs ?? []).filter(glyph => glyph.box && glyph.form !== 'unclear');
      const existing = projectIssues.filter(issue => issue.pageId === page.id && issue.source === 'ai');
      for (const issue of existing) {
        if (observedGlyphs.some(glyph => intersectsBox(glyph.box, issue.box) && catalogGlyphSupersedes(issue, glyph.quote))) {
          result.clearedCopy.add(issue.id);
        }
      }
      const names = proofNameCandidates(lines);
      const separators = projectIssues.filter(issue => issue.pageId === page.id && !issue.source
        && issue.title === '核对成分间分隔符').map(issue => {
        const line = lines.find(item => intersectsBox(issue.box, item.box) && item.text.replace(/\s+/gu, '').includes(issue.quote));
        return { ...issue, separator: true, rotation: line?.rotation, alternate: line?.alternate };
      });
      const typos = result.findings.flatMap(finding => {
        const check = copyReread(finding);
        return check ? [{ ...finding, check }] : [];
      });
      const samples = [...names, ...separators, ...typos].slice(0, 6).map(sample => ({
        ...sample, image: deps.cropPhoto(paddedRegion(sample.box, sample.box[3] * .44), sample.rotation === 180, 4)
      })).filter(sample => sample.image);
      if (samples.length) {
        onProgress(`正在回看原图 · ${samples.length} 处`);
        const { texts } = await deps.callApi('/api/ai?mode=proof-text', JSON.stringify({
          allowRemote,
          crops: samples.map(sample => sample.image)
        }), signal);
        run.verification = samples.map(({ quote, key, check }, i) => ({ quote, key, check, read: texts[i] }));
        const nameReadings = names.map(name => texts[samples.findIndex(sample => sample.quote === name.quote && !sample.key)]);
        const verifiedName = confirmedNameFinding(page.id, names, nameReadings);
        samples.forEach(({ separator, image, alternate, ...issue }, index) => {
          if (!separator) return;
          const confirmed = separatorReread(issue, texts[index], alternate);
          if (confirmed === null) result.clearedCopy.add(issue.id);
          else if (confirmed) result.verified.push(confirmed);
        });
        const supersededName = ({ quote, reason }) => verifiedName && quote.includes(names[1].quote)
          && reason.includes(names[0].quote) && /名称|品名|顺序/.test(reason);
        if (verifiedName) {
          result.verified.push(verifiedName);
          for (const issue of existing.filter(supersededName)) result.clearedCopy.add(issue.id);
        }
        let removedTypos = 0;
        for (const { key, check, read } of run.verification) {
          if (check && contradictedCopy(check, read)) {
            result.clearedCopy.add(`${page.id}-ai-${key}`);
            removedTypos += 1;
          }
        }
        result.findings = result.findings.filter(({ key, quote, reason }) => !result.clearedCopy.has(`${page.id}-ai-${key}`)
          && !supersededName({ quote, reason }));
        trace.push(`回看原文 · ${samples.length} 处，排除 ${removedTypos} 条 OCR 疑点`);
      }
    }
  } catch (error) {
    failures.push(signal.aborted ? `本轮达到 ${Math.round(timeoutMs / 1000)} 秒上限。` : error.message);
  }
  const remaining = missing();
  if (remaining.length) failures.push(`尚待查证 ${remaining.length} 项：${remaining.map(item => item.title).join('、')}。`);
  else if (!finished && !failures.length) failures.push('Agent 未完成审查收尾。');
  run.state = !failures.length ? 'complete'
    : (!remaining.length || repairs().length) && history.length < MAX_CALLS ? 'paused' : 'failed';
  run.remaining = remaining;
  return result;
}

export { chooseEvidenceChecks, evidenceFinding, evidenceTargets, formulaCoversModelIssue, retainedReviewIssues, reviewSections };
