import test from 'node:test';
import assert from 'node:assert/strict';
import { OcrWorker } from './ocr-worker.mjs';

const mockWorkerScript = `
const readline = require('node:readline');
console.log('noisy banner that should be ignored before ready');
console.log(JSON.stringify({ ready: true }));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.image === 'crash') process.exit(2);
  if (req.image === 'slow') return setTimeout(() => console.log(JSON.stringify({ id: req.id, lines: [{ text: 'slow', box: [0,0,.1,.1] }] })), 400);
  if (req.image === 'bad') return console.log(JSON.stringify({ id: req.id, error: 'corrupt image' }));
  console.log(JSON.stringify({ id: req.id, lines: [{ text: req.image, box: [0, 0, .5, .1] }] }));
});
`;

function createMockWorker(overrides = {}) {
  return new OcrWorker({
    command: process.execPath,
    args: ['-e', mockWorkerScript],
    idleMs: 5_000,
    startTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    ...overrides
  });
}

test('OcrWorker reuses a single persistent child process across sequential and concurrent calls', async () => {
  const worker = createMockWorker();
  try {
    const [a, b, c] = await Promise.all([
      worker.recognize('img-1'),
      worker.recognize('img-2'),
      worker.recognize('img-3')
    ]);
    assert.equal(a.lines[0].text, 'img-1');
    assert.equal(b.lines[0].text, 'img-2');
    assert.equal(c.lines[0].text, 'img-3');
    const stats = worker.stats();
    assert.equal(stats.spawns, 1);
    assert.equal(stats.completed, 3);
    assert.equal(stats.running, true);
  } finally {
    worker.close();
  }
});

test('OcrWorker recovers cleanly after per-image errors, worker crashes, timeouts and aborts', async () => {
  const worker = createMockWorker({ requestTimeoutMs: 120 });
  try {
    await assert.rejects(worker.recognize('bad'), /corrupt image/);
    assert.equal(worker.stats().spawns, 1);

    await assert.rejects(worker.recognize('crash'), /异常退出/);
    const afterCrash = await worker.recognize('recovered');
    assert.equal(afterCrash.lines[0].text, 'recovered');
    assert.equal(worker.stats().spawns, 2);

    await assert.rejects(worker.recognize('slow'), /超时/);
    const afterTimeout = await worker.recognize('ok-again');
    assert.equal(afterTimeout.lines[0].text, 'ok-again');

    const controller = new AbortController();
    const slowPromise = worker.recognize('slow', { timeoutMs: 2_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(slowPromise, /取消/);
  } finally {
    worker.close();
  }
});

test('OcrWorker shuts down automatically after idle timeout and respawns on demand', async () => {
  const worker = createMockWorker({ idleMs: 80 });
  try {
    assert.equal((await worker.recognize('first')).lines[0].text, 'first');
    assert.equal(worker.stats().running, true);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(worker.stats().running, false);
    assert.equal((await worker.recognize('second')).lines[0].text, 'second');
    assert.equal(worker.stats().spawns, 2);
  } finally {
    worker.close();
  }
});
