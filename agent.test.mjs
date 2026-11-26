import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaCoversModelIssue, separatorReread } from './agent.mjs';
import { catalogFormatFindings, catalogReviewRows, chooseEvidenceChecks, confirmedNameFinding, contradictedCopy, copyReread, evidenceFinding, evidenceTargets, mergeRotatedLines, petCatalogText, petReviewHandoff, proofNameCandidates, recoveredCfuLines, repairReview, retainedReviewIssues, reviewCoverage, reviewSections, runEvidenceCheck, sectionReread } from './agent.mjs';
import { compareFormulaCfu } from './review.mjs';

const line = (text, x, y) => ({ text, box: [x, y, .15, .02],
  words: [...text].map((character, i) => ({ text: character, box: [x + i * .004, y, .004, .02] })) });

test('pet handoff covers missed sections, every formula row and unread pages after tool calls succeed', () => {
  const lines = [line('宠物益生菌', .1, .05), line('【添加剂组成】枯草芽孢杆菌1.6×10CFU/g、酿酒酵母8×10⁸CFU/g', .1, .2)];
  const [additive, raw] = reviewSections(lines, true);
  assert.equal(raw.title, '核对原料组成');
  assert.equal(raw.search, true);
  const catalogRows = catalogReviewRows(lines.slice(1), additive,
    [{ query: '枯草芽孢杆菌', verdict: 'ok', record: 'A0187', name: '枯草芽孢杆菌' }], [], []);
  const formula = { name: '配方截图.png', rows: [{ name: '酿酒酵母', perGram: 8e8, cell: '第 1 行' },
    { name: '枯草芽孢杆菌', perGram: 16e8, cell: '第 2 行' }] };
  const comparison = compareFormulaCfu(lines, 'back', formula);
  const history = [{ tool: 'look', id: additive.id }, { tool: 'catalog', id: additive.id },
    { tool: 'look', id: raw.id, data: { notLocated: true } }, { tool: 'formula' }];
  assert.deepEqual(reviewCoverage([additive, raw], history, true), []);
  const [rawResult, additiveResult, formulaResult, unread] = petReviewHandoff([
    { id: 'back', lines, ocr: 'done', agentRun: { revision: 4, history, catalogRows: { [additive.id]: catalogRows } }, formulaRows: comparison.rows },
    { id: 'blank', label: '附页', ocr: 'blank' }
  ], formula, 4);
  assert.match(rawResult.rows[0].reason, /未定位/);
  assert.match(additiveResult.rows[0].reference, /A0187/);
  assert.deepEqual(formulaResult.rows.map(row => row.state), ['checked', 'pending']);
  assert.match(formulaResult.rows[1].reason, /指数未读清/);
  assert.equal(unread.rows[0].pageId, 'blank');
  const generic = { ...additive, pageId: 'back' };
  const edited = { ...generic, conclusion: '人工核对意见' };
  assert.deepEqual(retainedReviewIssues([generic, edited], 'back', [], undefined, undefined, [additive]), [edited]);
});

test('two agreeing regional reads recover new names without replacing a complete section with a clipped crop', () => {
  const lines = [line('【原料组成】葡萄糖、鸡水解粉', .1, .2)];
  const [raw, additive] = reviewSections(lines, true);
  const localized = [line('【原料组成】葡萄糖、鸡水解粉、菊苣根粉', .1, .2)];
  const second = [line('【原料组成】葡萄糖，鸡水解粉，菊苣根粉', .1, .2)];
  assert.match(sectionReread(raw, localized, second)?.query, /菊苣根粉/);
  assert.equal(sectionReread(raw, localized, lines), undefined);
  const clipped = [line('【原料组成】菊苣根粉', .1, .2)];
  assert.equal(sectionReread(raw, clipped, clipped), undefined);
  const recovered = [line('【添加剂组成】酿酒酵母8×10⁸CFU/g', .1, .23)];
  const read = sectionReread(additive, recovered, recovered);
  assert.ok(read);
  const [row] = compareFormulaCfu(lines, 'back', { rows: [{ name: '酿酒酵母', perGram: 8e8 }] }, [read.lines]).rows;
  assert.equal(row.state, 'checked');
  assert.deepEqual(repairReview([raw, additive], [{ tool: 'look', id: raw.id }, { tool: 'catalog', id: raw.id },
    { tool: 'formula' }, { tool: 'look', id: additive.id, data: { formulaChanged: true } }], true, []),
  [{ tool: 'catalog', id: additive.id }, { tool: 'formula' }]);
});

test('brand information and a license do not satisfy production fields', () => {
  const p = { id: 'proof', ocr: 'done', agentRun: { revision: 5, history: [] }, lines: [
    line('宠物益生菌', .1, .08), line('示例品牌', .1, .12), line('【生产许可证编号】鲁饲预(2000)00000', .1, .75)
  ] };
  const rows = () => petReviewHandoff([p], undefined, 5).find(group => group.title === '基础标识').rows;
  assert.deepEqual(rows().map(row => row.state), ['pending', 'pending', 'pending']);
  assert.deepEqual(rows()[0].box, p.lines[2].box);
  p.lines.push(line('生产企业名称：某某动物健康科技有限公司', .1, .8),
    line('生产地址（注册地址）：某省某市某路1号', .1, .82), line('生产日期（年/月/日）：见包装侧面', .1, .85));
  assert.deepEqual(rows().map(row => row.state), ['checked', 'checked', 'checked']);
  p.lines.splice(5, 1);
  p.lines[3].text = '品牌商：某某动物健康科技有限公司';
  p.lines[4].text = '品牌商地址：某省某市某路1号';
  assert.deepEqual(rows().map(row => row.state), ['pending', 'pending', 'pending']);
});

test('agent looks up broken-apart ingredients and flags only the specifically located catalog spelling', () => {
  assert.equal(petCatalogText('地衣芽孢杆菌Demo58(2X10CFU/g)植物乳杆菌Demo07(1X10⁸CFU/g)、维生素B1(硝酸硫胺)'),
    '地衣芽孢杆菌Demo58、植物乳杆菌Demo07、维生素B1(硝酸硫胺)');
  const lines = [line('添加剂组成：维生素B', .1, .1), line('1(硝酸硫胺)、蛋白酶', .1, .13)];
  const section = { id: 2, lineIndexes: [0, 1] };
  const item = { query: '维生素B1(硝酸硫胺)', status: 'format_deviation', verdict: 'nonconforming', record: 'A0038', name: '硝酸硫胺（维生素B₁）' };
  const issues = catalogFormatFindings('proof', lines, section, [
    item, { ...item, query: '蛋白酶', status: 'qualifier_omitted', verdict: 'ok' }
  ]);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].boxes.map(box => box[1]), [.1, .13]);
  assert.equal(issues[0].glyph, 'subscript');
  assert.match(issues[0].reason, /A0038.*硝酸硫胺/);
  const partial = '氰钴胺（维生素B₁2）';
  const [mixed] = catalogFormatFindings('proof', [line(partial, .1, .1)], { ...section, lineIndexes: [0] },
    [{ ...item, query: partial, name: '氰钴胺（维生素B₁₂）' }]);
  assert.equal(mixed.glyph, 'subscript');
  assert.ok(mixed.glyphBox[2] < mixed.box[2]);
  const approved = { ...mixed, id: 'manual-review', status: 'accepted' };
  const edited = { ...mixed, id: 'manual-note', conclusion: '复核包装写法。' };
  const cleared = new Set([mixed.id, approved.id, edited.id]);
  assert.deepEqual(retainedReviewIssues([mixed, approved, edited], 'proof', [], cleared), [approved, edited]);
});

test('agent permits named targets, requires two engines and compares a recovered value without rewriting original OCR', async () => {
  const lines = [
    line('【添加剂组成】植物乳杆菌(2X10CFU/g)', .15, .1),
    line('2-10kg', .15, .2), line('10kg', .32, .2), line('>10kg', .49, .2)
  ];
  const targets = evidenceTargets(lines);
  assert.deepEqual(targets.map(target => target.quote), ['2X10CFU/g', '10kg']);
  assert.deepEqual(chooseEvidenceChecks(targets, ['2', 999]), [targets[0]]);
  assert.deepEqual(chooseEvidenceChecks(targets, [2, 2, 999]), targets);
  const calls = [];
  const recovered = await runEvidenceCheck(targets[0], (engine, wider) => {
    calls.push([engine, wider]);
    const partial = engine === 'Windows OCR' && !wider;
    return { engine, lines: [{ text: partial ? '2X10CFU/g' : '2×10⁹CFU/g', box: targets[0].box }] };
  });
  assert.deepEqual(calls, [['Windows OCR', false], ['PP-OCRv6 medium', false], ['Windows OCR', true]]);
  assert.equal(recovered.confirmed, '2×10^9CFU/g');
  assert.equal(evidenceFinding(recovered, 'proof'), null);
  const comparison = compareFormulaCfu(recoveredCfuLines(lines, [recovered]), 'proof',
    { name: '配方.xlsx', rows: [{ name: '植物乳杆菌', perGram: 2e8, cell: 'F2' }] });
  assert.match(comparison.findings[0].reason, /20 亿 CFU\/g.*F2.*2 亿/);
  assert.ok(comparison.findings[0].boxes.length);
  assert.match(lines[0].text, /2X10CFU\/g/);
  const conflict = await runEvidenceCheck(targets[0], engine => ({
    engine, lines: [{ text: engine === 'Windows OCR' ? '2X109CFU/g' : '2X108CFU/g', box: targets[0].box }]
  }));
  assert.equal(conflict.confirmed, '');
  assert.match(evidenceFinding(conflict, 'proof').reason, /10\^9.*10\^8/);
  assert.equal(recoveredCfuLines(lines, [conflict])[0], lines[0]);
  const partial = engine => ({ engine, lines: [{ text: engine === 'Windows OCR' ? '2 · 0X109CFU/g' : '2X10CFU/g', box: targets[0].box }] });
  assert.equal((await runEvidenceCheck(targets[0], partial, async () => '(2X10⁹CFU/g)植')).confirmed, '2×10^9CFU/g');
  assert.equal((await runEvidenceCheck(targets[0], partial, async () => '(2X10⁸CFU/g)植')).confirmed, '');
  const center = (engine, crop) => ({ engine, lines: [{ text: crop === 'center' ? '2X10⁹CFU/g' : '2X10CFU/g', box: targets[0].box }] });
  assert.equal((await runEvidenceCheck(targets[0], center, async () => '2X10⁹CFU/g')).confirmed, '2×10^9CFU/g');
  const unread = engine => ({ engine, lines: [{ text: '2X10CFU/g', box: targets[0].box }] });
  assert.equal((await runEvidenceCheck(targets[0], unread, async () => '2X10⁹CFU/g')).confirmed, '');
  const decimal = { ...targets[0], quote: '1.6×10CFU/g' };
  const withComma = (engine, crop) => ({ engine, lines: [{ text: crop === 'center' ? '菌 1 ， 6 × 109CFU / g 、' : '1.6×10CFU/g', box: decimal.box }] });
  assert.equal((await runEvidenceCheck(decimal, withComma, async () => '1.6×10⁹CFU/g')).confirmed, '1.6×10^9CFU/g');
});

test('grounded correction replaces a punctuation or count prompt only when it covers the same issue', () => {
  const separator = { quote: 'CFU/g)植物乳杆菌' };
  assert.match(separatorReread(separator, '10⁹CFU/g)植物乳杆菌').reason, /请在右括号后补顿号/);
  assert.equal(separatorReread(separator, 'CFU/g)、植物乳杆菌', 'CFU/g)、植物乳杆菌'), null);
  assert.equal(separatorReread(separator, 'CFU/g)、植物乳杆菌'), undefined);
  const claim = { quote: '枯草芽孢杆菌DEMA-031(7X10⁸CFU/g)', box: [.3,.4,.2,.02], reason: '与配方数量不符' };
  const numeric = [{ ...claim, title: '核对活菌数与配方差异' }];
  assert.equal(formulaCoversModelIssue(claim, numeric), true);
  assert.equal(formulaCoversModelIssue({ ...claim, reason: '乘号写法与配方不同' }, numeric), false);
  assert.equal(formulaCoversModelIssue({ ...claim, box: [.3,.6,.2,.02] }, numeric), false);
});

test('same bounds with a missing comparator need review, and human decisions survive refreshed evidence', async () => {
  const lines = [line('2-10kg', .15, .2), line('10kg', .32, .2)];
  const [target] = evidenceTargets(lines);
  const same = await runEvidenceCheck(target, engine => ({ engine, lines: [{ text: '10kg', box: target.box }] }));
  assert.match(evidenceFinding(same, 'proof').reason, /两种识别均读为「10kg」/);
  const different = await runEvidenceCheck(target, engine => ({ engine, lines: [{ text: '>10kg', box: target.box }] }));
  assert.equal(evidenceFinding(different, 'proof'), null);
  const old = { ...evidenceFinding(same, 'proof'), source: 'ai' };
  const guessed = { ...old, quote: '2X108CFU/g', reason: '原稿缺少指数上标格式' };
  const reviewed = { ...old, status: 'accepted', conclusion: '人工已核对' };
  assert.deepEqual(retainedReviewIssues([guessed, old, reviewed, evidenceFinding(same, 'proof')], 'proof', [different]), [reviewed]);
});

test('rotated reread replaces aligned lines only and retains lines omitted by the crop', () => {
  const miss = { ...line('原始第二行', .1, .22), rotation: 180 };
  const old = { ...line('原始第一行', .1, .24), rotation: 180 };
  const normal = line('原稿另一面', .1, .24);
  const newLine = { ...line('复读第一行', .102, .241), rotation: 180 };
  assert.deepEqual(mergeRotatedLines([miss, old, normal], [newLine]), [miss, normal, newLine]);
});

test('coverage brings back skipped checks, retries a failure once and rejects an old formula', () => {
  const sections = [{ id: 1, title: '添加剂组成' }];
  const details = [{ id: 1, kind: 'weight', quote: '10kg' }, { id: 2, kind: 'cfu', quote: '2X10CFU/g' }];
  const formula = { tool: 'formula' };
  const history = [{ tool: 'look', id: 1 }, formula, { tool: 'reread', id: 1, error: 'OCR unavailable' }];
  assert.deepEqual(repairReview(sections, history, true, details), [
    { tool: 'catalog', id: 1 }, { tool: 'reread', id: 1 }, { tool: 'reread', id: 2 }
  ]);
  const read = { tool: 'reread', id: 2, data: { kind: 'cfu', confirmed: '2×10^9CFU/g' } };
  history.push({ tool: 'catalog', id: 1 }, { tool: 'reread', id: 1, error: 'OCR timeout' }, read);
  assert.deepEqual(repairReview(sections, history, true, details), [formula]);
  assert.deepEqual(reviewCoverage(sections, history, true, details).map(item => item.tool), ['reread', 'formula']);
  history[4] = { tool: 'reread', id: 1 };
  assert.deepEqual(repairReview(sections, history, true, details), [formula]);
  history.push({ ...formula, error: 'formula timeout' });
  assert.deepEqual(repairReview(sections, history, true, details), [formula]);
  history.push(formula);
  assert.deepEqual(reviewCoverage(sections, history, true, details), []);
  assert.deepEqual(repairReview(sections, history, true, details), []);
});

test('a product name discrepancy requires both original readings and locates the back label', () => {
  const front = line('青屿示例', .11, .15);
  const back = line('【产品名称】宠物营养补充剂屿青示例', .6, .5);
  const candidates = proofNameCandidates([front, back]);
  assert.deepEqual(candidates.map(item => item.quote), ['青屿示例', '屿青示例']);
  assert.equal(confirmedNameFinding('proof', candidates, ['青屿示例', '青屿示例']), null);
  const issue = confirmedNameFinding('proof', candidates, ['青屿示例', '屿青示例']);
  assert.match(issue.reason, /正面为「青屿示例」，背面产品名称为「屿青示例」/);
  assert.ok(issue.box[2] < back.box[2]);
  const matchingBack = line('【产品名称】宠物营养补充剂青屿示例', .6, .5);
  assert.deepEqual(proofNameCandidates([front, matchingBack]), []);
});

test('a crop can contradict a proposed correction while preserving a decision made by an operator', () => {
  const issue = { id: 'a', pageId: 'proof', source: 'ai', type: 'copy', status: 'pending',
    quote: '勿长期不同断服用', reason: '“不同断”疑为“不间断”。', boxes: [[.2, .3, .1, .01]] };
  const check = copyReread(issue);
  assert.equal(contradictedCopy(check, '勿长期不间断服用'), true);
  assert.equal(contradictedCopy(check, '勿长期不同断服用'), false);
  assert.equal(contradictedCopy(check, ''), false);
  const edited = { ...issue, id: 'b', conclusion: '保留此意见' };
  assert.deepEqual(retainedReviewIssues([issue, edited], 'proof', [], new Set(), new Set(['a', 'b'])), [edited]);
});
