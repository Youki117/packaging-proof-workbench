import test from 'node:test';
import assert from 'node:assert/strict';
import { anchoredFindings, confirmCatalogGlyphs, modelReview, readProofText, reviewInput, visionReviewStep } from './ai.mjs';
import { reviewCoverage, reviewSections } from './agent.mjs';

test('catalog glyph confirmation looks at the crop and validates each returned form', async t => {
  const image = 'data:image/jpeg;base64,/9j/AA==';
  const config = { msLlm: true, isLocal: true, model: 'MS_LLM' };
  const crops = [{ kind: 'subscript', image }, { kind: 'alpha', image }];
  let forms = ['subscript', 'latin_a'];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.messages[0].content.filter(item => item.type === 'image_url').length, 2);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ forms }) } }] });
  });
  assert.deepEqual(await confirmCatalogGlyphs(config, crops), forms);
  forms = ['normal', 'subscript'];
  await assert.rejects(confirmCatalogGlyphs(config, crops), /可验证的字形/);
});

test('image verification uses cropped text without supplying the OCR answer', async t => {
  const image = 'data:image/jpeg;base64,/9j/AA==';
  const config = { msLlm: true, isLocal: true, model: 'MS_LLM' };
  let texts = ['青屿示例', '屿青示例'];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const content = JSON.parse(options.body).messages[0].content;
    assert.equal(content.filter(item => item.type === 'image_url').length, 2);
    assert.ok(!content[0].text.includes('青屿示例'));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ texts }) } }] });
  });
  assert.deepEqual(await readProofText(config, [image, image]), texts);
  texts = ['青屿示例'];
  await assert.rejects(readProofText(config, [image, image]), /复读格式/);
  await assert.rejects(readProofText({ ...config, isLocal: false }, [image]), /本地 MS_LLM/);
});

test('visual glyph evidence blocks a duplicate typo even when the agent changes its category', async t => {
  const overview = 'data:image/jpeg;base64,/9j/AA==';
  const config = { msLlm: true, isLocal: true, model: 'MS_LLM' };
  const quote = '维生素B2(核黄素)';
  const lines = [
    { text: quote, box: [.1, .3, .15, .02], words: [{ text: quote, box: [.1, .3, .15, .02] }] }
  ];
  const answer = { findings: [{ type: 'copy', first: 1, last: 1, quote, reason: 'B2 编号未使用下标。' }] };
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  const history = [{ tool: 'catalog', id: 1, data: { glyphs: [{ quote, form: 'subscript' }] } }];
  assert.equal((await visionReviewStep(config, { overview }, lines)).findings.length, 1);
  assert.equal((await visionReviewStep(config, { overview, history }, lines)).findings.length, 0);
});

test('vision agent receives crop and tool evidence, and only runs grounded next actions', async t => {
  const lines = [
    { text: '原料组成：麦芽糊精', box: [.15, .2, .26, .03],
      words: [{ text: '原料组成：', box: [.15, .2, .12, .03] }, { text: '麦芽糊精', box: [.27, .2, .14, .03] }] },
    { text: '添加剂组成：两歧双歧杆菌', box: [.15, .25, .4, .03] }
  ];
  const overview = 'data:image/jpeg;base64,/9j/AA==';
  const config = { msLlm: true, isLocal: true, model: 'MS_LLM' };
  const mock = t.mock.method(globalThis, 'fetch', async (_, options) => {
    const { max_tokens: maxTokens, messages } = JSON.parse(options.body);
    assert.equal(maxTokens, 8000);
    const content = messages[0].content;
    assert.deepEqual(content[1], { type: 'image_url', image_url: { url: overview } });
    const { history, remaining } = JSON.parse(content.at(-1).text);
    if (history.length) {
      assert.equal(content.filter(item => item.type === 'image_url').length, 2);
      assert.equal(history[0].data.lines[0], lines[0].text);
      assert.ok(remaining.some(item => item.tool === 'catalog'));
    }
    const answer = history.some(item => item.tool === 'catalog') ? { findings: [
      { type: 'names', first: 1, last: 1, quote: '麦芽糊精', reason: '请核对目录写法。' }
    ] } : { actions: [
      { tool: 'catalog', id: 1 }, { tool: 'look', id: 1 }, { tool: 'look', id: 99 }, { tool: 'formula' },
      { tool: 'shell', id: 2 }, { tool: 'catalog', id: 2 }
    ] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
  });
  const first = await visionReviewStep(config, { overview }, lines);
  assert.deepEqual(first.actions, [{ tool: 'look', id: 1 }]);
  const history = [{ ...first.actions[0], data: { lines: [lines[0].text] } }];
  const next = await visionReviewStep(config, { overview, history, crops: [{ id: 1, image: overview }] }, lines);
  assert.deepEqual(next.actions, [{ tool: 'catalog', id: 1 }]);
  assert.equal(reviewCoverage(reviewSections(lines), history, true).length, 4);
  const close = await visionReviewStep(config, { overview, crops: [{ id: 1, image: overview }],
    history: [...history, { ...next.actions[0], data: { flagged: ['麦芽糊精'] } }] }, lines);
  assert.deepEqual(close.findings, []);
  await assert.rejects(visionReviewStep({ ...config, isLocal: false }, { overview }, lines), /本地 MS_LLM/);
  await assert.rejects(visionReviewStep(config, { overview: 'https://example.com/packaging.jpg' }, lines), /稿件/);
  assert.equal(mock.mock.callCount(), 3);
});

test('AI findings must quote indexed lines and may refer to a region reread', () => {
  const lines = reviewInput({ lines: [
    { text: '低聚粜糖和植', alternate: '低聚果糖和植', box: [.1, .1, .5, .02] },
    { text: '物乳植杆菌', box: [.1, .13, .22, .02] },
    { text: '宣传用语', box: [.7, .15, .2, .02] }
  ] });
  const finding = { type: 'names', first: 1, last: 2, quote: '低聚 果糖和植物乳植杆菌', reason: '核对配料字形' };
  const result = anchoredFindings({ findings: [
    finding,
    { ...finding, quote: '低聚果糖', last: 1 },
    { ...finding, quote: '低聚果糖' },
    { ...finding, first: 2, last: 3, quote: '植物乳植杆菌宣传用语' },
    { ...finding, first: 3, last: 3, quote: '治愈疾病' },
    { ...finding, type: 'manual' },
    { ...finding, last: 4 },
    finding
  ] }, lines);
  assert.deepEqual(result.map(item => item.quote), [finding.quote, '低聚果糖']);
  assert.equal(result[0].box[0], .1);
  assert.equal(result[0].box[1], .1);
  assert.ok(Math.abs(result[0].box[3] - .05) < .000001);
  assert.equal(result[0].title, 'AI 提示 · 配料表述');
  assert.throws(() => anchoredFindings({}, lines), /格式/);
  assert.throws(() => reviewInput({ lines: [{ text: '净含量', box: [.8, .1, .4, .02] }] }), /超出/);
  assert.throws(() => reviewInput({ lines: [{ text: '净含量', alternate: 30, box: [.1, .1, .5, .02] }] }), /超出/);
});

test('SSE model review preserves exact ingredient boxes and rejects unsupported quotes', async t => {
  const lines = reviewInput({ lines: [{ text: '配料：菊粉、赤藓糖醇', box: [.1, .2, .6, .035],
    words: ['配料：', '菊粉', '、', '赤藓糖醇'].map((text, i) => ({ text, box: [.1 + i * .1, .2, .08, .035] })) }] });
  const answer = JSON.stringify({ findings: [
    { type: 'names', first: 1, last: 1, quote: '赤藓糖醇', reason: '对照配方确认该名称。' },
    { type: 'names', first: 1, last: 1, quote: '柠檬酸', reason: '核对名称。' }
  ] });
  const fetch = t.mock.method(globalThis, 'fetch', async (_, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.stream, true);
    assert.equal(request.reasoning_effort, 'none');
    assert.equal(request.chat_template_kwargs.enable_thinking, false);
    assert.ok(!JSON.stringify(request.messages).includes('"box"'));
    const frame = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`;
    const stream = `${frame(answer.slice(0, 40))}${frame(answer.slice(40))}data: [DONE]\r\n\r\n`;
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const results = await modelReview({ model: 'MS_LLM', msLlm: true }, lines);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].quote, '赤藓糖醇');
  assert.ok(Math.abs(results[0].boxes[0][0] - .4) < 1e-8);
  assert.ok(Math.abs(results[0].boxes[0][2] - .08) < 1e-8);
});

test('pet claims already covered by local rules keep the local wording', async t => {
  const lines = [
    '宠物益生菌',
    '优选5株专利菌',
    '狗狗服用示例药物这类消炎止痛药期间'
  ].map((text, i) => ({ text, box: [.1, .1 + i * .05, .6, .03] }));
  const findings = [
    { type: 'claims', quote: '优选5株专利菌', first: 2, last: 2, reason: '需要核对专利数量。' },
    { type: 'copy', quote: '优选5株专利菌', first: 2, last: 2, reason: '仅对应4株。' },
    { type: 'claims', quote: '狗狗服用示例药物', first: 3, last: 3, reason: '请复核用药相关宣传。' }
  ];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.match(JSON.parse(options.body).messages[0].content, /人工审阅宠物饲料包装/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings }) } }] });
  });
  const result = await modelReview({ model: 'MS_LLM', msLlm: true }, lines);
  assert.deepEqual(result.map(issue => issue.quote), ['狗狗服用示例药物']);
});
