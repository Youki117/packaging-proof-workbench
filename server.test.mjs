import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchServer } from './server.mjs';

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function sendChunked(port, path, chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'X-Review-Client': 'workbench',
        'Transfer-Encoding': 'chunked',
        ...headers
      }
    }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('server supports chunked POST bodies, enforces CSRF/Host guards, exposes multimodal capabilities and validates patent register', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-srv-'));
  const badRegister = join(dir, 'patent-register.local.json');
  await writeFile(badRegister, JSON.stringify({ version: '测试台账', patents: [{ no: 'ZL202400000001.1', strains: ['Demo1'], certificate: 'cert.pdf' }] }));
  const server = createWorkbenchServer({
    patentRegisterPath: badRegister,
    modelConfig: {
      url: new URL('http://192.168.3.100:10830/v1/chat/completions'),
      isLocal: true,
      model: 'MS_LLM',
      msLlm: true,
      key: '',
      maxTokens: 8000,
      vision: true,
      visionEndpoint: {
        url: new URL('https://ark.example.com/v1/chat/completions'),
        isLocal: false,
        model: 'custom-vl',
        msLlm: false,
        key: 'k',
        maxTokens: 4096,
        vision: true
      }
    }
  });
  const port = await listen(server);
  try {
    // 1) /api/ai returns full text + vision metadata
    const aiResp = await fetch(`http://127.0.0.1:${port}/api/ai`);
    assert.equal(aiResp.status, 200);
    const aiInfo = await aiResp.json();
    assert.equal(aiInfo.available, true);
    assert.equal(aiInfo.vision, true);
    assert.equal(aiInfo.visionModel, 'custom-vl');
    assert.equal(aiInfo.visionRemote, true);
    assert.equal(aiInfo.visionDestination, 'ark.example.com');

    // 2) /patent-register.json returns validated local entries
    const regResp = await fetch(`http://127.0.0.1:${port}/patent-register.json`);
    assert.equal(regResp.status, 200);
    const reg = await regResp.json();
    assert.equal(reg.patents.length, 1);

    // 3) Chunked POST to /api/catalog succeeds (previously rejected without content-length)
    const chunked = await sendChunked(port, '/api/catalog?pet=raw', ['麦芽', '糊精、', '葡萄糖']);
    assert.equal(chunked.status, 200);
    assert.equal(chunked.body.items[0].status, 'normalized');
    assert.equal(chunked.body.items[0].name, '糊精');
    assert.match(chunked.body.items[0].catalog, /饲料原料目录/);
    assert.match(chunked.body.items[0].source, /13\.1\.2/);

    // 4) Missing CSRF header is rejected with 403
    const csrfResp = await fetch(`http://127.0.0.1:${port}/api/catalog`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}` },
      body: '菊粉'
    });
    assert.equal(csrfResp.status, 403);

    // 5) Remote vision endpoint blocks unconfirmed request
    const remoteBlocked = await fetch(`http://127.0.0.1:${port}/api/ai?mode=proof-text`, {
      method: 'POST',
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-Review-Client': 'workbench' },
      body: JSON.stringify({ crops: ['data:image/jpeg;base64,/9j/AA=='] })
    });
    assert.equal(remoteBlocked.status, 422);
    assert.match((await remoteBlocked.json()).error, /远程多模态模型/);

    // 6) Oversized chunked payload returns 413
    const oversized = await sendChunked(port, '/api/catalog', ['A'.repeat(7000), 'B'.repeat(7000)]);
    assert.equal(oversized.status, 413);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});
