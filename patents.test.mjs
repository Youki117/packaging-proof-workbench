import test from 'node:test';
import assert from 'node:assert/strict';
import { patentIssues, reviewPatents } from './patents.mjs';
import { reviewSections } from './agent.mjs';

const line = (text, x, y, width = .2) => ({ text, box: [x, y, width, .014] });
const lines = [
  line('2株专利菌', .3, .02),
  line('含凝结芽孢杆菌Demo27', .2, .1),
  line('中国发明专利号：ZL 2000 1 0000001.3', .51, .1),
  line('含屎肠球菌DEMO-355', .2, .115),
  line('中国发明专利号：ZL 2000 10000002.X', .51, .115),
  line('专利菌株', .5, .5),
  line('【添加剂组成】凝结芽孢杆菌Demo27(2X10⁸CFU/g)、屎肠球菌DEMO-355(1X10⁸CFU/g)', .2, .7, .6),
];
const registry = { version: '虚构测试', patents: [
  { no: 'ZL200010000001.3', strains: ['Demo27'], certificate: 'Demo27 示例证书' },
  { no: 'ZL200010000002.X', strains: ['DEMO-355'], certificate: '示例证书 2' }
] };
function review(input) {
  const additives = reviewSections(input).filter(section => section.title === '核对添加剂组成').map(section => section.query);
  return reviewPatents([{ id: 'proof', lines: input }], new Map([['proof', additives]]), registry);
}

test('paper patent rows match the printed number, adjacent strain and back label, with authorizations kept separate', () => {
  const group = review(lines);
  assert.deepEqual(group.rows.map(({state}) => state), ['checked', 'checked', 'checked', 'checked', 'pending']);
  assert.match(group.rows[0].reference, /ZL200010000001\.3.*Demo27/);
  assert.match(group.rows[2].reason, /Demo27、DEMO-355.*2 株/);
  assert.match(group.rows[4].reason, /登记簿/);
  const stale = { id: 'old', quote: '专利菌株', status: 'pending', type: 'claims', title: '核对宣传表述与依据' };
  const edited = { ...stale, id: 'edited', conclusion: '人工批注' };
  const layout = { ...stale, id: 'layout', source: 'ai', reason: '顶盖位置需核对' };
  assert.deepEqual(patentIssues(group, [stale, edited, layout]), { kept: [edited, layout], findings: [] });
});

test('partial counts, a mispaired strain, and a number absent from the local register stay actionable', () => {
  const wrong = lines.map(line => ({ ...line }));
  wrong[1].text = '含嗜酸乳杆菌Demo45';
  wrong[4].text = '中国发明专利号：ZL200010000002.1';
  const group = review(wrong);
  assert.match(group.rows[0].reason, /DEMO45.*Demo27/);
  assert.match(group.rows[1].reason, /未找到.*\.1/);
  assert.match(group.rows[2].reason, /已用证书和添加剂栏逐株对上 0 株/);
  assert.deepEqual(patentIssues(group, []).findings.map(row => row.quote), ['ZL 2000 1 0000001.3', 'ZL200010000002.1', '2株专利菌']);
  assert.equal(patentIssues(review([lines[5]]), []).findings.length, 0);
});
