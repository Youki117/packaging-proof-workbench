import { readFile } from 'node:fs/promises';

export function parseModelConfigObject(config, base = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw Error('模型配置顶层必须是 JSON 对象。');
  }
  const environment = { ...base, PYTHONUTF8: '1' };
  const section = (name, optional = false) => {
    const value = config[name];
    if (optional && value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error(`配置缺少对象：${name}`);
    }
    return value;
  };
  const text = (values, name, field, optional = false) => {
    const value = values[field];
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw Error(`${name}的${field}必须是单行字符串。`);
    }
    return value;
  };
  const flag = (values, name, field) => {
    const value = values[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw Error(`${name}的${field}必须是布尔值（true 或 false）。`);
    return value;
  };
  const maxTokens = (values, name) => {
    const value = values['最大输出Token'];
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 256 || value > 32768) {
      throw Error(`${name}的最大输出Token必须是 256–32768 之间的整数。`);
    }
    return String(value);
  };
  const compat = (values, name) => {
    const value = values['兼容模式'];
    if (value === undefined || value === '') return '';
    if (!['auto', 'ms_llm', 'standard'].includes(value)) {
      throw Error(`${name}的兼容模式仅支持 auto、ms_llm 或 standard。`);
    }
    return value;
  };
  const endpoint = (value, name) => {
    if (!value) return value;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw Error(`${name}必须是完整 HTTP(S) 接口地址。`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw Error(`${name}必须是无内嵌凭据或查询参数的 HTTP(S) 接口地址。`);
    }
    return value;
  };

  const hasTextSection = config['文本模型'] !== undefined;
  const hasVisionSection = config['视觉模型'] !== undefined;
  if (!hasTextSection && !hasVisionSection) {
    throw Error('配置缺少对象：文本模型');
  }

  for (const [name, prefix] of [['文本模型', 'REVIEW'], ['视觉模型', 'VISION']]) {
    const values = section(name, true);
    if (!values) {
      for (const suffix of ['CHAT_URL', 'MODEL', 'API_KEY']) environment[`${prefix}_${suffix}`] = '';
      continue;
    }
    for (const [field, suffix] of [['API地址', 'CHAT_URL'], ['模型名称', 'MODEL'], ['API密钥', 'API_KEY']]) {
      const value = text(values, name, field, field === 'API密钥');
      environment[`${prefix}_${suffix}`] = field === 'API地址' ? endpoint(value, `${name}的API地址`) : value;
    }
    const supportsVision = flag(values, name, '支持视觉');
    if (supportsVision !== undefined) environment[`${prefix}_VISION`] = String(supportsVision);
    const mode = compat(values, name);
    if (mode) environment[`${prefix}_COMPAT`] = mode;
    const limit = maxTokens(values, name);
    if (limit) environment[`${prefix}_MAX_TOKENS`] = limit;
  }
  return environment;
}

export async function modelEnvironment(path, base = process.env) {
  let config;
  try {
    config = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw Error('无法读取模型配置，请检查文件路径、UTF-8 编码和 JSON 格式。');
  }
  return parseModelConfigObject(config, base);
}
