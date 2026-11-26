import test from 'node:test';
import assert from 'node:assert/strict';
import { base64ToBytes, dataUrlToBlob } from './web/utils.mjs';
import { deserializeProjectBundle } from './web/storage.mjs';

test('base64ToBytes works even without Uint8Array.fromBase64 and decodes data URLs cleanly', async () => {
  const raw = Buffer.from('hello packaging workbench').toString('base64');
  const bytes = base64ToBytes(raw);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'hello packaging workbench');

  const original = Uint8Array.fromBase64;
  Uint8Array.fromBase64 = undefined;
  try {
    const fallbackBytes = base64ToBytes(raw);
    assert.equal(Buffer.from(fallbackBytes).toString('utf8'), 'hello packaging workbench');
  } finally {
    Uint8Array.fromBase64 = original;
  }

  const blob = dataUrlToBlob(`data:image/png;base64,${raw}`);
  assert.equal(blob.type, 'image/png');
  assert.equal(await blob.text(), 'hello packaging workbench');
});

test('deserializeProjectBundle restores multi-project fields, Set state and binary page blobs', async () => {
  const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const bundle = JSON.stringify({
    schema: 'packaging-workbench.v1',
    project: {
      name: '普通食品实测稿',
      category: 'food',
      issues: [{ id: 'i1', status: 'accepted', title: '核对单位', note: '改为 g' }],
      pages: [{
        id: 'p1',
        label: 'front.png',
        ocr: 'done',
        dataUrl: `data:image/png;base64,${pngB64}`,
        agentRun: { revision: 5, state: 'complete', history: [], clearedCatalog: ['c1'] }
      }]
    }
  });
  const restored = deserializeProjectBundle(bundle);
  assert.equal(restored.sample, false);
  assert.equal(restored.name, '普通食品实测稿');
  assert.equal(restored.category, 'food');
  assert.equal(restored.pages[0].file instanceof Blob, true);
  assert.equal(restored.pages[0].agentRun.clearedCatalog instanceof Set, true);
  assert.equal(restored.pages[0].agentRun.clearedCatalog.has('c1'), true);
  assert.throws(() => deserializeProjectBundle('{"schema":"other"}'), /不是有效/);
});
