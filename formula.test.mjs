import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaCfuRows, formulaImageCfuRows } from './formula.mjs';
import { compareFormulaCfu, inspectLines, rotateBox } from './review.mjs';

test('formula units come from the matching worksheet section, never from per-bag values or another sheet', () => {
  const rows = formulaCfuRows([
    'Sheet: 配方',
    'E26=氧化锌\tF26=0.001\tG26=g/条',
    'E27=企标2465\tF27=100亿/g\tG27=500亿/袋',
    'E28=枯草芽孢杆菌DEMA-031\tF28=70\tG28=350',
    'E29=酿酒酵母\tG29=5',
    'E30=嗜酸乳杆菌\tF30=4',
    'Sheet: 质检',
    'E28=枯草芽孢杆菌DEMA-031\tF28=90'
  ].join('\n'));
  assert.deepEqual(rows, [{ name: '枯草芽孢杆菌DEMA-031', perGram: 7e9, cell: '配方!F28' },
    { name: '酿酒酵母', perGram: null, cell: '配方!F29' }, { name: '嗜酸乳杆菌', perGram: 4e8, cell: '配方!F30' }]);
  assert.match(compareFormulaCfu([], 'p', { rows }).rows[1].reason, /缺失/);
  assert.throws(() => formulaCfuRows('Sheet: 配方\nE1=企标\tF1=500亿/袋\nE2=枯草芽孢杆菌\tF2=70'), /未找到/);
});

test('pet proof rules and formula comparison cite the exact label and abstain on ambiguous exponents', () => {
  const lines = [
    '宠物益生菌',
    '用于调理狗狗软便、腹泻、肠道紊乱',
    '5000亿活性菌添加',
    '【原料组成】葡萄糖',
    '【添加剂组成】枯草芽孢杆菌DEMA-031(7X10⁸CFU/g)、地衣芽孢杆菌Demo58(2X10CFU/g)',
    '【成分保证值】水分'
  ].map((text, i) => ({ text, box: [.1, .08 + i * .04, .7, .025] }));
  const titles = inspectLines(lines, 'p').map(issue => issue.title);
  assert.deepEqual(titles, ['复核宠物功效表述', '核对活菌数声称', '核对原料组成', '核对添加剂组成']);
  const formula = { name: '配方.xlsx', rows: [
    { name: '枯草芽孢杆菌DEMA-031', perGram: 7e9, cell: '配方!F28' },
    { name: '地衣芽孢杆菌demo58', perGram: 2e9, cell: '配方!F29' }
  ] };
  const [finding, extra] = compareFormulaCfu(lines, 'p', formula).findings;
  assert.equal(extra, undefined);
  assert.equal(finding.quote, '枯草芽孢杆菌DEMA-031(7X10⁸CFU/g)');
  assert.match(finding.reason, /7 亿 CFU\/g.*配方!F28.*70 亿 CFU\/g/);
  lines[4].alternate = lines[4].text.replace('10⁸', '10⁹');
  const conflict = compareFormulaCfu(lines, 'p', formula);
  assert.deepEqual([conflict.findings, conflict.matched], [[], []]);
  assert.deepEqual(conflict.rows.map(row => row.state), ['pending', 'pending']);
  assert.match(conflict.rows[0].reason, /不同数值/);
  assert.match(conflict.rows[1].reason, /指数未读清/);
  assert.equal(conflict.rows[1].cell, '配方!F29');
  assert.ok(conflict.rows[1].box);
  const recovered = [{ ...lines[4], alternate: undefined, text: lines[4].text.replace('2X10CFU', '2X10⁹CFU') }];
  const compared = compareFormulaCfu(lines, 'p', formula, [recovered], conflict.rows);
  assert.equal(compared.rows[0], conflict.rows[0]);
  assert.equal(compared.rows[1].state, 'checked');
});

test('formula image anchors per-gram values to a total and never substitutes the next column', () => {
  const specs = [
    ['企标1234', .1, .2, .12], ['3亿/g', .4, .2, .10], ['15亿/袋', .56, .2, .10],
    ['植物乳杆菌', .1, .23, .14], ['1', .48, .23, .02], ['5', .64, .23, .02],
    ['枯草芽孢杆菌', .1, .26, .16], ['2', .48, .26, .02], ['10', .63, .26, .03]
  ];
  const lines = specs.map(([text, x, y, w]) => ({ text, box: [x, y, w, .02] }));
  assert.deepEqual(formulaImageCfuRows(lines).map(row => row.perGram), [1e8, 2e8]);
  assert.throws(() => formulaImageCfuRows(lines.filter(line => line.text !== '2')), /无法可靠核验/);
  lines[7].text = '9';
  assert.throws(() => formulaImageCfuRows(lines), /无法可靠核验/);
});

test('whole-box claims use the printed additive values and adjacent net content only when all rows match unambiguously', () => {
  const lines = [
    { text: '5000亿活性菌添加', box: [.58, .41, .2, .018] },
    { text: '净含量:50g(5g×10)', box: [.42, .41, .12, .018] },
    { text: '【添加剂组成】枯草芽孢杆菌DEMA-031(7×10⁸CFU/g)、地衣芽孢杆菌Demo58(2×10⁹CFU/g)', box: [.2, .7, .6, .019] }
  ];
  const formula = { name: '配方.xlsx', rows: [
    { name: '枯草芽孢杆菌DEMA-031', perGram: 7e9 },
    { name: '地衣芽孢杆菌Demo58', perGram: 2e9 }
  ] };
  const total = () => compareFormulaCfu(lines, 'proof', formula).findings.find(item => /整盒/.test(item.title));
  assert.match(total().reason, /27 亿 CFU\/g.*50 g.*1350 亿 CFU.*5000 亿/);
  lines[1].text = '净含量:50g(5g×9)';
  assert.equal(total(), undefined);
  lines[1].text = '净含量:50g';
  formula.rows.pop();
  assert.equal(total(), undefined);
});

test('centered additive heading collects wrapped counts and stops at the guarantee values', () => {
  const lines = [
    ['添加剂组成', .15, .10, .05],
    ['植物乳', .1, .12, .15],
    ['杆菌6.0×10⁸CFU/g、枯草芽孢杆菌DEMA-031(7X10⁸CFU/g)', .1, .139, .22],
    ['产品成分分析保证值', .12, .158, .12],
    ['嗜酸乳杆菌6.0×10⁸CFU/g', .1, .175, .18]
  ].map(([text, x, y, width]) => ({ text, box: [x, y, width, .015] }));
  const result = compareFormulaCfu(lines, 'p', { name: '配方.png', rows: [
    { name: '植物乳杆菌', perGram: 6e8 }, { name: '嗜酸乳杆菌', perGram: 6e8 },
    { name: '枯草芽孢杆菌DEMA-0', perGram: 7e9, image: true, cell: '明细第 2 行' }
  ] });
  assert.deepEqual(result.matched, ['植物乳杆菌']);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, '核对配方表菌株号');
  assert.match(result.findings[0].reason, /两份原稿的编号/);
});

test('a printed CFU denominator is retained even when totals are pending', () => {
  const lines = [
    '调理肠胃2500亿CFU/盒活菌多层包埋技术',
    '含益生菌50亿CFU/g，出厂时添加',
    '净含量：5g×10',
    '【添加剂组成】枯草芽孢杆菌5×10⁹CFU/g',
    '【成分保证值】水分'
  ].map((text, i) => ({ text, box: [.1, .08 + i * .05, .7, .025] }));
  const formula = { rows: [{ name: '枯草芽孢杆菌', perGram: 5e9 }] };
  const compare = () => compareFormulaCfu(lines, 'proof', formula);
  assert.deepEqual(compare().claims.map(row => [row.quote, row.state]), [
    ['2500亿CFU/盒', 'checked'], ['50亿CFU/g', 'checked']
  ]);
  assert.match(compare().claims[0].reason, /50 g.*2500 亿 CFU/);
  lines[3].text = '【添加剂组成】枯草芽孢杆菌5×10CFU/g';
  assert.deepEqual(compare().claims.map(row => row.state), ['pending', 'pending']);
  assert.match(compare().claims[1].reason, /已标明计量口径/);
  lines[3].text = '【添加剂组成】枯草芽孢杆菌5×10⁹CFU/g';
  lines[0].text = '2400亿CFU/盒';
  assert.match(compare().claims[0].issue.reason, /2500 亿 CFU.*声称为 2400 亿/);
});

test('an upside-down additive panel uses reading order while the formula finding keeps original coordinates', () => {
  const lines = [
    ['【添加剂组成】枯草芽孢杆菌', .1],
    ['DEMA-031(7X10⁸CFU/g)', .125],
    ['产品成分分析保证值', .15]
  ].map(([text, y]) => ({ text, rotation: 180, box: rotateBox([.2, y, .35, .02]),
    words: [{ text, box: rotateBox([.2, y, .35, .02]) }] })).reverse();
  const { findings, matched } = compareFormulaCfu(lines, 'p', { name: '配方.xlsx',
    rows: [{ name: '枯草芽孢杆菌DEMA-031', perGram: 7e9, cell: 'F2' }] });
  assert.deepEqual(matched, ['枯草芽孢杆菌dema-031']);
  assert.match(findings[0].quote, /^枯草芽孢杆菌DEMA-031/);
  assert.ok(findings[0].box[1] > .8);
});
