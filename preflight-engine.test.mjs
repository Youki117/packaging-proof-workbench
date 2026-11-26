import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdditiveQueries, runPatentReviewForProject, runVisionPreflight } from './preflight-engine.mjs';

const line = (text, x, y, w = .25) => ({
  text,
  box: [x, y, w, .02],
  words: [...text].map((ch, i) => ({ text: ch, box: [x + i * .005, y, .005, .02] }))
});

test('collectAdditiveQueries and patent review use recovered run.local[id].query (fixes v0.4.11 .joined bug)', () => {
  const page = {
    id: 'p1',
    ocr: 'done',
    lines: [
      line('宠物益生菌', .1, .05),
      line('【原料组成】葡萄糖', .1, .2),
      line('1株专利菌', .1, .08),
      line('含凝结芽孢杆菌Demo27', .1, .12),
      line('中国发明专利号：ZL200010000001.3', .4, .12)
    ],
    // Section 1 = 原料组成, Section 2 = search placeholder for 核对添加剂组成 (section.query === '')
    agentRun: {
      local: {
        2: {
          additive: true,
          query: '凝结芽孢杆菌Demo27(2×10⁸CFU/g)',
          box: [.1, .25, .4, .03],
          lines: [line('【添加剂组成】凝结芽孢杆菌Demo27(2×10⁸CFU/g)', .1, .25)]
        }
      }
    }
  };
  const additives = collectAdditiveQueries([page]);
  assert.deepEqual(additives.get('p1'), ['凝结芽孢杆菌Demo27(2×10⁸CFU/g)']);

  const registry = {
    version: '测试',
    patents: [{ no: 'ZL200010000001.3', strains: ['Demo27'], certificate: 'Demo27.pdf' }]
  };
  const { patentReview, findings } = runPatentReviewForProject({ pages: [page], issues: [], registry });
  assert.equal(patentReview.rows[0].state, 'checked');
  assert.match(patentReview.rows[0].reason, /添加剂栏也标有 Demo27/);
  assert.equal(findings.length, 0);
});

test('runVisionPreflight orchestrates look -> catalog -> finish for ordinary food proofs and saves food catalog handoff rows', async () => {
  const page = {
    id: 'food-1',
    label: '食品样稿',
    ocr: 'done',
    lines: [
      line('产品名称：低聚果糖固体饮料', .1, .05),
      line('配料：低聚果糖、牡丹籽油', .1, .15, .4)
    ]
  };
  let visionCalls = 0;
  const fakeImg = 'data:image/jpeg;base64,/9j/AA==';
  const result = await runVisionPreflight({
    page,
    formula: null,
    projectIssues: [],
    category: 'food',
    allowRemote: true,
    deps: {
      cropPhoto: () => fakeImg,
      recognizeRegion: async () => ({ engine: 'PP-OCRv6 medium', lines: page.lines }),
      callApi: async (path, body) => {
        const parsed = path.startsWith('/api/catalog') ? body : JSON.parse(body);
        if (path === '/api/ai?mode=vision') {
          visionCalls += 1;
          assert.equal(parsed.category, 'food');
          assert.equal(parsed.allowRemote, true);
          if (visionCalls === 1) return { actions: [{ tool: 'look', id: 1 }] };
          if (visionCalls === 2) return { actions: [{ tool: 'catalog', id: 1 }] };
          return { findings: [] };
        }
        if (path === '/api/catalog') {
          return {
            items: [
              { query: '低聚果糖', parents: [], matches: [] },
              {
                query: '牡丹籽油', parents: [],
                matches: [{ official_name: '牡丹籽油', catalog_type: '新食品原料', foodcate: '不包括婴幼儿食品', consumption: '≤10克/天', status: 'EXACT MATCH' }]
              }
            ]
          };
        }
        throw Error(`Unexpected API call: ${path}`);
      }
    }
  });
  assert.equal(page.agentRun.state, 'complete');
  assert.equal(result.failures.length, 0);
  const rows = page.agentRun.catalogRows[1];
  assert.equal(rows.length, 2);
  assert.equal(rows[1].state, 'pending');
  assert.match(rows[1].reason, /不包括婴幼儿食品/);
});
