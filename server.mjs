import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rawCatalog, additiveCatalog } from './food-catalog.mjs';
import { catalogQuery, ingredientNames } from './review.mjs';
import { configuredModel, confirmCatalogGlyphs, modelReview, readProofText, reviewInput, visionReviewStep } from './ai.mjs';
import { petCatalogText } from './agent.mjs';
import { readFormula } from './read-formula.mjs';
import { lookupPetCatalog } from './pet-catalog.mjs';
import { formulaCfuRows, formulaImageCfuRows, formulaIngredientRows } from './formula.mjs';
import { OcrWorker } from './ocr-worker.mjs';

const exec = promisify(execFile);
const defaultRoot = fileURLToPath(new URL('./', import.meta.url));
const maxBytes = 30 * 1024 * 1024;
const maxAiBytes = 2_000_000;
const maxVisionBytes = 3_000_000;
const configuredPdfPages = Number(process.env.PACKAGING_MAX_PDF_PAGES ?? 8);
const maxPdfPages = Number.isInteger(configuredPdfPages) && configuredPdfPages >= 1 && configuredPdfPages <= 32 ? configuredPdfPages : 8;

const staticRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/review.mjs', ['review.mjs', 'text/javascript; charset=utf-8']],
  ['/rules.mjs', ['rules.mjs', 'text/javascript; charset=utf-8']],
  ['/agent.mjs', ['agent.mjs', 'text/javascript; charset=utf-8']],
  ['/patents.mjs', ['patents.mjs', 'text/javascript; charset=utf-8']],
  ['/preflight-engine.mjs', ['preflight-engine.mjs', 'text/javascript; charset=utf-8']],
  ['/web/utils.mjs', ['web/utils.mjs', 'text/javascript; charset=utf-8']],
  ['/web/storage.mjs', ['web/storage.mjs', 'text/javascript; charset=utf-8']],
  ['/web/viewer.mjs', ['web/viewer.mjs', 'text/javascript; charset=utf-8']],
  ['/sample/original.jpg', ['sample.jpg', 'image/jpeg']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);

function send(response, status, type, bytes) {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  });
  response.end(bytes);
}

function json(response, status, payload) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

export async function readBody(request, limit) {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    const size = Number(declared);
    if (!Number.isInteger(size) || size < 1 || size > limit) return null;
  }
  const parts = [];
  let total = 0;
  for await (const part of request) {
    total += part.length;
    if (total > limit) return null;
    parts.push(part);
  }
  if (total < 1) return null;
  return Buffer.concat(parts, total);
}

async function withInput(bytes, ext, use) {
  const dir = await mkdtemp(join(tmpdir(), 'packaging-workbench-'));
  const path = join(dir, `input.${ext}`);
  try {
    await writeFile(path, bytes);
    return await use(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(error => console.error('临时文件清理失败', error.code));
  }
}

export function lookupFoodNames(input) {
  const names = ingredientNames(input);
  if (!names.length) throw Error('请填写要查证的名称。');
  const queries = [...new Set(names.map(({ query }) => catalogQuery(query)))].join('\n');
  const raw = JSON.parse(rawCatalog({ raw_material_query: queries }).raw_material_matches).items;
  const additives = JSON.parse(additiveCatalog({ additive_query: queries }).additive_matches).items;
  const matchOrder = ['EXACT MATCH', 'SPECIES MATCH', 'MULTIPLE MATCH', 'FUZZY MATCH'];
  const matches = new Map();
  for (const item of [...raw, ...additives]) {
    if (!matches.has(item.query)) matches.set(item.query, []);
    matches.get(item.query).push(...item.matches.map(match => ({ ...match, status: item.status })));
  }
  for (const entries of matches.values()) {
    entries.sort((a, b) => matchOrder.indexOf(a.status) - matchOrder.indexOf(b.status));
  }
  const items = names.map(name => ({ ...name, matches: matches.get(catalogQuery(name.query)) ?? [] }));
  return { items, raw, additives };
}

export async function loadModelConfig(root = defaultRoot) {
  const configPath = process.env.PACKAGING_MODEL_CONFIG;
  const defaultPath = join(root, '模型配置.json');
  const hasDefault = !configPath && await access(defaultPath).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  return configuredModel(configPath || (hasDefault ? defaultPath : null));
}

function validatePatentRegister(raw) {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.patents)) {
    throw Error('本地专利台账格式无效，需要包含 patents 数组。');
  }
  return {
    version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '本机台账',
    patents: parsed.patents.filter(item => item && typeof item.no === 'string' && Array.isArray(item.strains))
  };
}

export function createWorkbenchServer({
  root = defaultRoot,
  port = 8774,
  modelConfig: initialModelConfig,
  modelError: initialModelError,
  ocrWorker: customOcrWorker,
  rapidPython = process.env.PACKAGING_OCR_PYTHON ||
    (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'PackagingProofWorkbench', 'ocr', 'Scripts', 'python.exe')),
  patentRegisterPath = join(root, 'patent-register.local.json'),
  recognizeOverride
} = {}) {
  let modelConfig = initialModelConfig;
  let modelError = initialModelError;
  let worker = customOcrWorker ?? null;
  let winOcrActive = 0;
  const winOcrQueue = [];

  const runWinOcrQueued = fn => new Promise((resolveTask, rejectTask) => {
    const start = () => {
      winOcrActive += 1;
      Promise.resolve().then(fn).then(resolveTask, rejectTask).finally(() => {
        winOcrActive -= 1;
        const next = winOcrQueue.shift();
        if (next) next();
      });
    };
    if (winOcrActive < 2) start();
    else winOcrQueue.push(start);
  });

  async function ensureWorker() {
    if (worker) return worker;
    if (!rapidPython) return null;
    const exists = await access(rapidPython).then(() => true, () => false);
    if (!exists) return null;
    worker = new OcrWorker({
      command: rapidPython,
      args: [join(root, 'ocr_paddle.py'), '--server']
    });
    return worker;
  }

  async function recognize(bytes, preferWindows = false, signal) {
    if (recognizeOverride) return recognizeOverride(bytes, preferWindows, signal);
    const isPng = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const isJpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    if (!isPng && !isJpeg) throw Error('请选择有效的 PNG 或 JPG 图片。');
    try {
      return await withInput(bytes, isPng ? 'png' : 'jpg', async path => {
        if (!preferWindows) {
          const activeWorker = await ensureWorker();
          if (activeWorker) {
            try {
              const result = await activeWorker.recognize(path, { timeoutMs: 45_000, signal });
              return { lines: result.lines, engine: 'PP-OCRv6 medium' };
            } catch (error) {
              if (signal?.aborted) throw error;
              console.warn('PP-OCRv6 回退至系统 OCR', error.code ?? error.message);
            }
          }
        }
        if (process.platform !== 'win32') {
          throw Error('当前非 Windows 系统且未配置 PP-OCRv6 Python 环境。请设置 PACKAGING_OCR_PYTHON 指向已安装 rapidocr 的 Python。');
        }
        return await runWinOcrQueued(async () => {
          const { stdout } = await exec('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', join(root, 'ocr.ps1'), '-ImagePath', path
          ], { windowsHide: true, timeout: 25_000, maxBuffer: 4 * 1024 * 1024, signal });
          return { ...JSON.parse(stdout), engine: 'Windows OCR' };
        });
      });
    } catch (error) {
      if (signal?.aborted) throw Error('文字识别已取消。');
      console.error('OCR 失败', error.code ?? error.name, String(error.stderr ?? error.message ?? '').split('\n')[0]);
      throw Error(process.platform === 'win32'
        ? '本页文字识别失败。请检查图像或 Windows 简体中文 OCR 组件，可继续看稿和手动查证。'
        : error.message);
    }
  }

  async function renderPdf(bytes, signal) {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('请选择有效的 PDF 文件。');
    return withInput(bytes, 'pdf', async (path, dir) => {
      const options = { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, signal };
      try {
        const { stdout } = await exec(process.env.PACKAGING_PDFINFO || 'pdfinfo', [path], options);
        const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (!Number.isInteger(pages) || pages < 1 || pages > maxPdfPages) throw Error('页数');
        await exec(process.env.PACKAGING_PDFTOPPM || 'pdftoppm', [
          '-scale-to', '2400', '-png', path, join(dir, 'page')
        ], options);
        const files = (await readdir(dir))
          .filter(name => /^page-\d+\.png$/.test(name))
          .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        if (files.length !== pages) throw Error('渲染页数不一致');
        const rendered = [];
        for (const name of files) {
          const image = await readFile(join(dir, name));
          rendered.push(image.toString('base64'));
        }
        return { pages: rendered };
      } catch {
        throw Error(`PDF 打开失败。请使用未加密的 1–${maxPdfPages} 页 PDF，并确保本机可运行 Poppler。`);
      }
    });
  }

  const server = createServer(async (request, response) => {
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    const host = `127.0.0.1:${activePort}`;
    if (request.headers.host !== host) return json(response, 403, { error: '请通过本机地址打开工作台。' });
    const url = new URL(request.url, `http://${host}`);
    const route = staticRoutes.get(url.pathname);
    const controller = new AbortController();
    request.on('close', () => {
      if (!request.complete) controller.abort();
    });
    try {
      if (request.method === 'GET' && url.pathname === '/patent-register.json') {
        const register = await readFile(patentRegisterPath, 'utf8').then(validatePatentRegister, error => {
          if (error.code === 'ENOENT') return { version: '未配置', patents: [] };
          throw error;
        });
        return json(response, 200, register);
      }
      if (request.method === 'GET' && route) {
        return send(response, 200, route[1], await readFile(join(root, route[0])));
      }
      if (request.method === 'GET' && url.pathname === '/api/ai') {
        const visionEndpoint = modelConfig?.visionEndpoint;
        return json(response, 200, {
          available: Boolean(modelConfig),
          ...(modelError && { error: modelError }),
          ...(modelConfig && {
            remote: !modelConfig.isLocal,
            destination: modelConfig.url.hostname,
            model: modelConfig.model,
            vision: Boolean(visionEndpoint),
            ...(visionEndpoint && {
              visionModel: visionEndpoint.model,
              visionRemote: !visionEndpoint.isLocal,
              visionDestination: visionEndpoint.url.hostname
            })
          })
        });
      }
      if (request.method === 'POST' && ['/api/ocr', '/api/pdf', '/api/catalog', '/api/ai', '/api/formula'].includes(url.pathname)) {
        if (request.headers.origin !== `http://${host}` || request.headers['x-review-client'] !== 'workbench') {
          return json(response, 403, { error: '请从当前工作台提交。' });
        }
        const catalog = url.pathname === '/api/catalog';
        const ai = url.pathname === '/api/ai';
        const mode = ai && url.searchParams.get('mode');
        const vision = mode === 'vision' || mode === 'glyphs' || mode === 'proof-text';
        const bytes = await readBody(request, catalog ? 12_000 : vision ? maxVisionBytes : ai ? maxAiBytes : maxBytes);
        if (!bytes) return json(response, 413, { error: ai ? '当前版面文字过多，无法提交 AI 复核。' : '请检查输入大小。文件上限为 30 MB。' });
        if (ai) {
          if (!modelConfig) return json(response, 503, { error: modelError || 'AI 复核尚未配置。' });
          let input;
          try { input = JSON.parse(bytes.toString('utf8')); } catch {
            return json(response, 400, { error: '无法读取当前版面的文字数据。' });
          }
          const callOptions = { signal: controller.signal, allowRemote: input?.allowRemote === true, category: input?.category };
          if (mode === 'vision') return json(response, 200, await visionReviewStep(modelConfig, input, reviewInput(input), callOptions));
          if (mode === 'glyphs') return json(response, 200, { forms: await confirmCatalogGlyphs(modelConfig, input?.crops, callOptions) });
          if (mode === 'proof-text') return json(response, 200, { texts: await readProofText(modelConfig, input?.crops, callOptions) });
          if (!modelConfig.isLocal && input?.allowRemote !== true) {
            return json(response, 403, { error: '请确认是否将本页 OCR 文字提交给远程模型。' });
          }
          const result = await modelReview(modelConfig, reviewInput(input), input?.agent === true, callOptions);
          return json(response, 200, Array.isArray(result) ? { findings: result } : result);
        }
        if (catalog) {
          const input = bytes.toString('utf8').trim();
          if (!input || input.length > 2000) return json(response, 400, { error: '请输入 1–2000 字的配料名称。' });
          const section = url.searchParams.get('pet');
          if (section === 'raw' || section === 'additive') return json(response, 200, lookupPetCatalog(section === 'additive' ? petCatalogText(input) : input, section));
          return json(response, 200, lookupFoodNames(input));
        }
        if (url.pathname === '/api/formula') {
          const spreadsheet = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
          if (spreadsheet) {
            const payload = await withInput(bytes, 'xlsx', async path => {
              const { text } = await readFormula(path);
              let rows = [];
              try {
                rows = formulaCfuRows(text);
              } catch (cfuError) {
                const ingredients = formulaIngredientRows(text);
                if (!ingredients.length) throw cfuError;
                return { rows: [], ingredients };
              }
              return { rows, ingredients: formulaIngredientRows(text) };
            });
            return json(response, 200, payload);
          }
          const rows = formulaImageCfuRows((await recognize(bytes, false, controller.signal)).lines);
          return json(response, 200, { rows, ingredients: [] });
        }
        const result = url.pathname === '/api/ocr'
          ? await recognize(bytes, url.searchParams.get('engine') === 'windows', controller.signal)
          : await renderPdf(bytes, controller.signal);
        return json(response, 200, result);
      }
      return json(response, 404, { error: '页面或接口不存在。' });
    } catch (error) {
      if (response.writableEnded) return;
      return json(response, 422, { error: error.message });
    }
  });

  server.on('close', () => {
    if (worker && !customOcrWorker) worker.close();
  });

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  let modelConfig;
  let modelError;
  try {
    modelConfig = await loadModelConfig(defaultRoot);
  } catch (error) {
    modelError = error.message;
  }
  const ports = process.argv.slice(2);
  const port = Number(ports[0] ?? 8774);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口无效。');
  const server = createWorkbenchServer({ root: defaultRoot, port, modelConfig, modelError });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(port, '127.0.0.1', () => console.log(`包装审查工作台 http://127.0.0.1:${port}`));
}
