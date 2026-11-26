import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawCatalog, additiveCatalog } from './food-catalog.mjs';
import { catalogQuery, ingredientNames } from './review.mjs';
import { configuredModel, confirmCatalogGlyphs, modelReview, readProofText, reviewInput, visionReviewStep } from './ai.mjs';
import { petCatalogText } from './agent.mjs';
import { readFormula } from './read-formula.mjs';
import { lookupPetCatalog } from './pet-catalog.mjs';
import { formulaCfuRows, formulaImageCfuRows } from './formula.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('./', import.meta.url));
const maxBytes = 30 * 1024 * 1024;
const maxPdfPages = 8;
const maxAiBytes = 2_000_000;
const maxVisionBytes = 3_000_000;
const rapidPython = process.env.PACKAGING_OCR_PYTHON ||
  (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'PackagingProofWorkbench', 'ocr', 'Scripts', 'python.exe'));
let modelConfig;
let modelError;
try {
  const configPath = process.env.PACKAGING_MODEL_CONFIG;
  const defaultPath = new URL('./模型配置.json', import.meta.url);
  const compatibleDefault = !configPath && await access(defaultPath).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  modelConfig = await configuredModel(configPath || (compatibleDefault ? defaultPath : null), compatibleDefault);
} catch (error) {
  modelError = error.message;
}
const ports = process.argv.slice(2);
const port = Number(ports[0] ?? 8774);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口无效。');
const host = `127.0.0.1:${port}`;
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/review.mjs', ['review.mjs', 'text/javascript; charset=utf-8']],
  ['/agent.mjs', ['agent.mjs', 'text/javascript; charset=utf-8']],
  ['/patents.mjs', ['patents.mjs', 'text/javascript; charset=utf-8']],
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

async function body(request, limit) {
  const size = Number(request.headers['content-length']);
  if (!Number.isInteger(size) || size < 1 || size > limit) return null;
  const parts = [];
  for await (const part of request) parts.push(part);
  return Buffer.concat(parts);
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

async function recognize(bytes, preferWindows = false) {
  const isPng = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const isJpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (!isPng && !isJpeg) throw Error('请选择有效的 PNG 或 JPG 图片。');
  try {
    return await withInput(bytes, isPng ? 'png' : 'jpg', async path => {
      if (!preferWindows && rapidPython && await access(rapidPython).then(() => true, () => false)) {
        try {
          const { stdout } = await exec(rapidPython, [join(root, 'ocr_paddle.py'), '--image', path],
            { windowsHide: true, timeout: 45_000, maxBuffer: 12 * 1024 * 1024 });
          const result = JSON.parse(stdout);
          if (!Array.isArray(result.lines)) throw Error('Invalid OCR result');
          return { lines: result.lines, engine: 'PP-OCRv6 medium' };
        } catch (error) {
          console.warn('PP-OCRv6 回退至 Windows OCR', error.code ?? error.name);
        }
      }
      const { stdout } = await exec('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(root, 'ocr.ps1'), '-ImagePath', path
      ], { windowsHide: true, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 });
      return { ...JSON.parse(stdout), engine: 'Windows OCR' };
    });
  } catch (error) {
    console.error('OCR 失败', error.code ?? error.name, String(error.stderr ?? '').split('\n')[0]);
    throw Error('本页文字识别失败。请检查图像或 Windows 简体中文 OCR 组件，可继续看稿和手动查证。');
  }
}

async function renderPdf(bytes) {
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('请选择有效的 PDF 文件。');
  return withInput(bytes, 'pdf', async (path, dir) => {
    const options = { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 };
    try {
      const { stdout } = await exec(process.env.PACKAGING_PDFINFO || 'pdfinfo', [path], options);
      const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(pages) || pages < 1 || pages > maxPdfPages) throw Error('页数');
      await exec(process.env.PACKAGING_PDFTOPPM || 'pdftoppm', [
        '-scale-to', '2400', '-png', path, join(dir, 'page')
      ], options);
      const rendered = [];
      for (let page = 1; page <= pages; page += 1) {
        const image = await readFile(join(dir, `page-${page}.png`));
        rendered.push(image.toString('base64'));
      }
      return { pages: rendered };
    } catch {
      throw Error('PDF 打开失败。请使用未加密的 1–8 页 PDF，并确保本机可运行 Poppler。');
    }
  });
}

function lookupNames(input) {
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



createServer(async (request, response) => {
  if (request.headers.host !== host) return json(response, 403, { error: '请通过本机地址打开工作台。' });
  const url = new URL(request.url, `http://${host}`);
  const route = routes.get(url.pathname);
  try {
    if (request.method === 'GET' && url.pathname === '/patent-register.json') {
      const register = await readFile(join(root, 'patent-register.local.json'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '{"version":"未配置","patents":[]}';
      });
      return json(response, 200, JSON.parse(register));
    }
    if (request.method === 'GET' && route) {
      return send(response, 200, route[1], await readFile(join(root, route[0])));
    }
        if (request.method === 'GET' && url.pathname === '/api/ai') {
      return json(response, 200, {
        available: Boolean(modelConfig),
        ...(modelError && { error: modelError }),
        ...(modelConfig && { remote: !modelConfig.isLocal, destination: modelConfig.url.hostname, model: modelConfig.model,
          vision: modelConfig.isLocal && modelConfig.msLlm })
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
      const bytes = await body(request, catalog ? 12_000 : vision ? maxVisionBytes : ai ? maxAiBytes : maxBytes);
      if (!bytes) return json(response, 413, { error: ai ? '当前版面文字过多，无法提交 AI 复核。' : '请检查输入大小。文件上限为 30 MB。' });
      if (ai) {
        if (!modelConfig) return json(response, 503, { error: modelError || 'AI 复核尚未配置。' });
        let input;
        try { input = JSON.parse(bytes.toString('utf8')); } catch {
          return json(response, 400, { error: '无法读取当前版面的文字数据。' });
        }
        if (mode === 'vision') return json(response, 200, await visionReviewStep(modelConfig, input, reviewInput(input)));
        if (mode === 'glyphs') return json(response, 200, { forms: await confirmCatalogGlyphs(modelConfig, input?.crops) });
        if (mode === 'proof-text') return json(response, 200, { texts: await readProofText(modelConfig, input?.crops) });
        if (!modelConfig.isLocal && input?.allowRemote !== true) {
          return json(response, 403, { error: '请确认是否将本页 OCR 文字提交给远程模型。' });
        }
        const result = await modelReview(modelConfig, reviewInput(input), input?.agent === true);
        return json(response, 200, Array.isArray(result) ? { findings: result } : result);
      }
      if (catalog) {
        const input = bytes.toString('utf8').trim();
        if (!input || input.length > 2000) return json(response, 400, { error: '请输入 1–2000 字的配料名称。' });
        const section = url.searchParams.get('pet');
        if (section === 'raw' || section === 'additive') return json(response, 200, lookupPetCatalog(section === 'additive' ? petCatalogText(input) : input, section));
        return json(response, 200, lookupNames(input));
      }
      if (url.pathname === '/api/formula') {
        const spreadsheet = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        const rows = spreadsheet ? await withInput(bytes, 'xlsx', async path => formulaCfuRows((await readFormula(path)).text))
          : formulaImageCfuRows((await recognize(bytes)).lines);
        return json(response, 200, { rows });
      }
      const result = url.pathname === '/api/ocr'
        ? await recognize(bytes, url.searchParams.get('engine') === 'windows') : await renderPdf(bytes);
      return json(response, 200, result);
    }
    return json(response, 404, { error: '页面或接口不存在。' });
  } catch (error) {
    return json(response, 422, { error: error.message });
  }
}).listen(port, '127.0.0.1', () => console.log(`包装审查工作台 http://${host}`));
