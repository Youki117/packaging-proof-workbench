import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBoxes, catalogQuery, fullSample, humanMark, ingredientNames, inspectLines, matchQuote, refineIngredient, reviewMarkdown, upgradeSample } from './review.mjs';

test('cropped and complete screenshot drafts move onto the high-resolution proof once', () => {
  const position = [.5, .25, .25, .125];
  const mark = { pageId: 'sample-1', box: position, boxes: [position], number: 4, status: 'accepted', note: '核对名称', humanBox: true };
  const innerBag = { pageId: 'sample-3', box: [0, 0, 1, 1], boxes: [], number: 5, status: 'dismissed' };
  const fullMark = { pageId: 'sample-4', box: [.5, .4, .1, .2], number: 6, status: 'pending' };
  const oldFull = { id: 'sample-4', src: '/sample/4.png', ocr: 'done', lines: [{ text: '旧识别结果' }] };
  const singlePage = { sample: true, pages: [oldFull], issues: [structuredClone(fullMark)] };
  const draft = { sample: true, pages: [{ id: 'sample-1' }, { id: 'sample-3' }, oldFull],
    issues: [mark, innerBag, fullMark] };
  upgradeSample(draft);
  assert.deepEqual(draft.pages, [{ ...fullSample, ocr: 'waiting' }]);
  const pixels = ([x, y, w, h]) => [x * 6252, y * 5522, w * 6252, h * 5522].map(Math.round);
  assert.deepEqual(pixels(mark.box), [4239, 1631, 584, 194]);
  assert.deepEqual(mark.boxes, [mark.box]);
  assert.deepEqual([mark.pageId, mark.number, mark.status, mark.note, mark.humanBox], [fullSample.id, 4, 'accepted', '核对名称', true]);
  assert.deepEqual(pixels(innerBag.box), [723, 3587, 846, 1436]);
  assert.deepEqual(innerBag.boxes, []);
  assert.equal(innerBag.status, 'dismissed');
  assert.deepEqual(pixels(fullMark.box), [3180, 2821, 584, 818]);
  upgradeSample(singlePage);
  assert.deepEqual(singlePage.pages, draft.pages);
  assert.deepEqual(singlePage.issues, [fullMark]);
  const saved = structuredClone(draft);
  upgradeSample(draft);
  assert.deepEqual(draft, saved);
  const imported = { ...saved, sample: false, pages: [{ id: 'sample-1' }] };
  upgradeSample(imported);
  assert.deepEqual(imported.pages, [{ id: 'sample-1' }]);
});

test('OCR candidates keep page location and distinguish a match candidate from an opinion', () => {
  const box = [.6, .2, .3, .02];
  const result = inspectLines([
    { text: '{ 配 料 ] 低 聚 果 糖 ， 菊 粉', box },
    { text: '净 含 量：90 G', box },
    { text: '净 含 量：90 g', box },
    { text: '中 国 发 明 专 利 菌 株', box }
  ], 'page-1');
  assert.deepEqual(result.map(item => item.type), ['names', 'copy', 'claims']);
  assert.equal(result[0].query, '低聚果糖，菊粉');
  assert.deepEqual(result[0].box, box);
  assert.ok(result.every(item => item.pageId === 'page-1' && item.status === 'pending'));
});

test('a wrapped ingredient name keeps its full wording and stops before the next field', () => {
  const [finding] = inspectLines([
    { text: '{ 配 料 ] 菊 粉 ， 植 物', box: [.69, .116, .28, .018] },
    { text: '左栏其他文字', box: [.04, .14, .4, .018] },
    { text: '乳 植 杆 菌 DEMB-526 ， 赤 藓', box: [.696, .14, .28, .018] },
    { text: '糖 醇', box: [.696, .163, .06, .018] },
    { text: '{ 致 敏 物 质 提 示 菌 种 含 有 乳 成 分', box: [.69, .187, .28, .018] },
    { text: '右栏其他文字', box: [.69, .21, .2, .018] }
  ], 'page-1');
  assert.equal(finding.query, '菊粉，植物乳植杆菌 DEMB-526，赤藓糖醇');
  assert.match(finding.quote, /植物\n乳植杆菌/);
  assert.equal(finding.quote.split('\n').length, 3);
  assert.ok(finding.box[3] > .064 && finding.box[3] < .068);
});

test('adjacent pet warning and inspection statements need a separator on the same printed line', () => {
  const box = [.1, .6, .2, .02];
  const inspect = (...texts) => inspectLines(['宠物益生菌', ...texts].map(text => ({ text, box })), 'proof');
  assert.match(inspect('本产品不得饲喂反刍动物产品质量检验合格')[0].reason, /反刍动物.*换行/);
  assert.deepEqual(inspect('本产品不得饲喂反刍动物。产品质量检验合格'), []);
  assert.deepEqual(inspect('本产品不得饲喂反刍动物', '产品质量检验合格'), []);
});

test('standalone raw material heading collects its content without crossing a larger vertical gap', () => {
  const [finding] = inspectLines([
    { text: '原料表', box: [.08, .1, .1, .02] },
    { text: '低 聚 果 糖、复 合 粉（菊 粉、赤 藓', box: [.085, .125, .5, .02] },
    { text: '糖 醇）', box: [.085, .15, .15, .02] },
    { text: '下一段独立文字', box: [.085, .25, .5, .02] }
  ], 'page-1');
  assert.equal(finding.query, '低聚果糖、复合粉（菊粉、赤藓糖醇）');
});

test('aligned OCR reread preserves both transcriptions and original coordinates', () => {
  const original = [
    { text: '【配料】低聚粜糖，乳酸孚', box: [.7, .1, .24, .02] },
    { text: '球菌DEMC-60', box: [.7, .124, .17, .02] }
  ];
  const reread = [
    { text: '球菌DEMC-60', box: [.704, .124, .16, .021] },
    { text: '〖配料] 低聚果糖，乳酸乳', box: [.704, .1, .23, .021] }
  ];
  const [finding] = inspectLines(refineIngredient(original, reread), 'p');
  assert.equal(finding.query, '低聚果糖，乳酸乳球菌DEMC-60');
  assert.match(finding.baselineQuote, /低聚粜糖/);
  assert.deepEqual(finding.box, inspectLines(original, 'p')[0].box);
  assert.equal(refineIngredient(original, reread.slice(0, 1)), original);
  assert.equal(refineIngredient(original, [{ ...reread[0], box: [.1, .124, .16, .021] }, reread[1]]), original);
});

test('name lookup separates explicit compound ingredients, preserving paths and qualifiers', () => {
  assert.deepEqual(ingredientNames('复合粉（菊粉、复配剂（柠檬酸、赤藓糖醇））\n透明质酸钠（提取法）、1,3-二油酸'), [
    { query: '菊粉', parents: ['复合粉'] },
    { query: '柠檬酸', parents: ['复合粉', '复配剂'] },
    { query: '赤藓糖醇', parents: ['复合粉', '复配剂'] },
    { query: '透明质酸钠（提取法）', parents: [] },
    { query: '1,3-二油酸', parents: [] }
  ]);
  assert.equal(catalogQuery('乳酸乳球菌乳亚种 DEMC · 60'), '乳酸乳球菌乳亚种DEMC-60');
  assert.equal(catalogQuery('动物双歧杆菌乳亚种 JYB R 刁 90'), '动物双歧杆菌乳亚种 JYB R 刁 90');
});

test('exact quote boxes cover each physical line and abstain on an ambiguous or cut token', () => {
  const frame = (words, y) => ({ text: words.join(''), box: [.1, y, .7, .025],
    words: words.map((text, i) => ({ text, box: [.1 + .12 * i, y, .08, .025] })) });
  const first = frame(['菊粉、', '植物'], .15);
  const second = frame(['乳植杆菌', '、水苏糖'], .18);
  const exact = matchQuote([first, second], '植物乳植杆菌');
  assert.equal(exact.boxes.length, 2);
  assert.ok(Math.abs(exact.boxes[0][0] - .22) < 1e-8 && Math.abs(exact.boxes[1][0] - .1) < 1e-8);
  assert.deepEqual(matchQuote([first], '菊粉'), { boxes: [] });
  assert.deepEqual(matchQuote([frame(['菊粉', '、', '菊粉'], .2)], '菊粉'), { boxes: [] });
  assert.equal(matchQuote([first], '假引文'), undefined);
  assert.deepEqual(annotationBoxes({ type: 'names', box: first.box }), []);
  assert.equal(humanMark({ type: 'names', reason: '工具结论', conclusion: '人工结论' }), true);
});

test('export includes only human decisions and preserves original draft location', () => {
  const result = reviewMarkdown('稿件', [{ id: 'page-1', label: '包装正面' }], [
    { title: '待核对候选标题', pageId: 'page-1', status: 'pending' },
    { title: '已排除候选标题', pageId: 'page-1', status: 'dismissed' },
    { title: '确认单位', pageId: 'page-1', status: 'accepted', quote: '90 G', note: '改为 90 g', box: [.6, .2, .3, .02] },
    { title: '补查依据', pageId: 'page-1', status: 'followup', note: '研发补充资料' }
  ]);
  assert.match(result, /包装正面（距左 60%，距上 20%）/);
  assert.match(result, /识别引文：90 G/);
  assert.match(result, /改为 90 g/);
  assert.match(result, /研发补充资料/);
  assert.doesNotMatch(result, /待核对候选标题|已排除候选标题/);
});
