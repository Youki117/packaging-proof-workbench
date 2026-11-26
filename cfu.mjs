export function cfu(value, unit) {
  const supers = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  const raw = String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/^10([⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/g, (_, power) => '1×10^' + power.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => supers[c]))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => supers[c])
    .replace(/^10\^(\d+)$/, '1×10^$1');
  const u = String(unit ?? '')
    .replace(/\s+/g, '')
    .replace(/千克|公斤/g, 'kg')
    .replace(/克/g, 'g')
    .replace(/^(亿|万)\/(kg|g)$/i, '$1CFU/$2');
  const matchUnit = /^(?:(亿|万))?CFU\/(kg|g)$/i.exec(u);
  if (!matchUnit) return null;
  const [, scaleUnit, massUnit] = matchUnit;
  const exponent = raw.match(/^([\d]+(?:\.\d+)?)(?:[×xX*]10\^?(\d+)|[eE]([+-]?\d+))$/);
  const number = exponent ? Number(exponent[1]) * 10 ** Number(exponent[2] ?? exponent[3])
    : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const scale = scaleUnit === '亿' ? 1e8 : scaleUnit === '万' ? 1e4 : 1;
  const divisor = massUnit.toLowerCase() === 'kg' ? 1000 : 1;
  const result = number * scale / divisor;
  return Number.isFinite(result) && result >= 0 ? result : null;
}
