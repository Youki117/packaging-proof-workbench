import test from 'node:test';
import assert from 'node:assert/strict';
import { cfu } from './cfu.mjs';
import { formulaCfuRows, formulaIngredientRows } from './formula.mjs';
import { lookupPetCatalog } from './pet-catalog.mjs';
import { compareFormulaCfu, compareFormulaIngredients, inspectLines } from './review.mjs';
import { catalogFormatFindings, evidenceTargets, foodCatalogReviewRows, foodReviewHandoff, proofNameCandidates, reviewHandoff } from './agent.mjs';

const line = (text, x, y, w = .2) => ({
  text,
  box: [x, y, w, .02],
  words: [...text].map((ch, i) => ({ text: ch, box: [x + i * .005, y, .005, .02] }))
});

test('pet catalog restores public-regulation normalization rules and provenance metadata', () => {
  const { items } = lookupPetCatalog('麦芽糊精、一水葡萄糖、鱼溶桨粉', 'raw');
  assert.deepEqual(items.map(i => [i.status, i.verdict, i.name]), [
    ['normalized', 'nonconforming', '糊精'],
    ['normalized', 'nonconforming', '葡萄糖'],
    ['normalized', 'nonconforming', '鱼溶浆粉']
  ]);
  assert.ok(items.every(i => i.catalog.includes('饲料原料目录') && i.source.includes('2026年5月版')));
  const { items: addItems } = lookupPetCatalog('酸性蛋白酶', 'additive');
  assert.equal(addItems[0].status, 'normalized');
  assert.equal(addItems[0].verdict, 'nonconforming');
  assert.match(addItems[0].catalog, /饲料添加剂品种目录/);
});

test('name discrepancy generalizes beyond anagrams to single-character typos and food products', () => {
  const typo = proofNameCandidates([
    line('护肠益生粉', .1, .1),
    line('产品名称：护胃益生粉', .6, .5)
  ]);
  assert.deepEqual(typo.map(item => item.quote), ['护肠益生粉', '护胃益生粉']);

  const genericPrefix = proofNameCandidates([
    line('益生菌', .1, .1),
    line('【产品名称】宠物营养补充剂宠物益生菌', .6, .5)
  ]);
  assert.deepEqual(genericPrefix, []);
});

test('CFU converter and formula parser handle CFU/kg, per-bag claims, and general non-CFU ingredient spreadsheets', () => {
  assert.equal(cfu('50', '亿CFU/kg'), 5e6);
  const cfuRows = formulaCfuRows('Sheet: 配方\nA1=菌种名称\tB1=50亿CFU/kg\nA2=植物乳植杆菌\tB2=50');
  assert.equal(cfuRows[0].perGram, 5e6);

  const lines = [
    '每袋含250亿CFU/袋活菌',
    '净含量：50g(5g×10袋)',
    '【添加剂组成】枯草芽孢杆菌5×10⁹CFU/g'
  ].map((text, i) => line(text, .1, .1 + i * .05, .6));
  const ok = compareFormulaCfu(lines, 'p', { name: 'f.xlsx', rows: [{ name: '枯草芽孢杆菌', perGram: 5e9 }] });
  assert.equal(ok.claims.length, 1);
  assert.equal(ok.claims[0].state, 'checked');
  assert.match(ok.claims[0].reason, /5 g.*每袋 250 亿 CFU/);

  lines[0] = line('每袋含300亿CFU/袋活菌', .1, .1, .6);
  const diff = compareFormulaCfu(lines, 'p', { name: 'f.xlsx', rows: [{ name: '枯草芽孢杆菌', perGram: 5e9 }] });
  assert.equal(diff.claims[0].state, 'difference');
  assert.match(diff.claims[0].issue.title, /每袋活菌数/);

  const ingText = [
    'Sheet: 配方表',
    'A1=配料名称\tB1=添加量(%)',
    'A2=低聚果糖\tB2=40%',
    'A3=牡丹籽油\tB3=10%',
    'A4=合计\tB4=100%'
  ].join('\n');
  const ingredients = formulaIngredientRows(ingText);
  assert.equal(ingredients.length, 2);
  const compared = compareFormulaIngredients([line('配料：低聚果糖、菊粉', .1, .2, .5)], 'p', { name: '食品.xlsx', ingredients });
  assert.deepEqual(compared.map(r => [r.title, r.state]), [['低聚果糖', 'checked'], ['牡丹籽油', 'pending']]);
});

test('generalized rules cover food GB 7718 handoff, vertical weight tables, greek glyph checks and joined mandatory notices', () => {
  const foodLines = [
    line('产品名称：低聚果糖固体饮料', .1, .05),
    line('配料：低聚果糖、牡丹籽油', .1, .1),
    line('净含量：60g', .1, .15),
    line('预防糖尿病、改善睡眠、顶级品质', .1, .2),
    line('生产企业：示例食品有限公司', .1, .3),
    line('生产地址：示例省示例市示例路1号', .1, .35),
    line('食品生产许可证编号：SC10637010000001', .1, .4)
  ];
  const foodFindings = inspectLines(foodLines, 'f', { category: 'food' });
  assert.ok(foodFindings.some(f => f.title === '复核疾病治疗或医疗宣称'));

  const handoff = reviewHandoff([
    { id: 'f', ocr: 'done', lines: foodLines, agentRun: { revision: 5, history: [], catalogRows: {
      1: foodCatalogReviewRows(foodLines, { box: foodLines[1].box }, [
        { query: '牡丹籽油', matches: [{ official_name: '牡丹籽油', catalog_type: '新食品原料', foodcate: '不包括婴幼儿食品', consumption: '≤10克/天', status: 'EXACT MATCH' }] }
      ])
    } } }
  ], undefined, 5, 'food');
  const catalogGroup = handoff.find(g => g.title === '配料目录查证');
  assert.equal(catalogGroup.rows[0].state, 'pending');
  assert.match(catalogGroup.rows[0].reason, /不包括婴幼儿食品/);
  const gbGroup = handoff.find(g => g.title === '基础标识（GB 7718）');
  assert.ok(gbGroup);
  assert.equal(gbGroup.rows.find(r => r.title === '食品生产许可证编号').state, 'checked');
  assert.equal(gbGroup.rows.find(r => r.title === '营养成分表').state, 'pending');

  // Vertical weight table support
  const verticalTargets = evidenceTargets([
    line('2-10公斤', .1, .2, .12),
    line('10公斤', .1, .24, .12)
  ]);
  assert.equal(verticalTargets.length, 1);
  assert.equal(verticalTargets[0].quote, '10公斤');

  // Generalized greek glyph check (β vs b) and normalized naming rule findings
  const block = [line('添加剂组成：b-胡萝卜素、麦芽糊精', .1, .1, .6)];
  const formatIssues = catalogFormatFindings('p', block, { id: 1, title: '核对添加剂组成', lineIndexes: [0] }, [
    { query: 'b-胡萝卜素', status: 'format_deviation', verdict: 'nonconforming', record: 'A9999', name: 'β-胡萝卜素' },
    { query: '麦芽糊精', status: 'normalized', verdict: 'nonconforming', record: 'R0123', name: '糊精', notes: ['规范名应写作「糊精」'] }
  ]);
  assert.equal(formatIssues.length, 2);
  assert.equal(formatIssues[0].glyph, 'greek');
  assert.equal(formatIssues[0].glyphExpected, 'β');
  assert.equal(formatIssues[1].quote, '麦芽糊精');

  // Generalized joined notices beyond exact hardcoded phrase
  const joined = inspectLines([line('宠物益生菌', .1, .05), line('本产品不得饲喂反刍动物贮存条件：阴凉干燥', .1, .1)], 'p');
  assert.ok(joined.some(f => f.title === '核对两项标示之间的分隔'));
});
