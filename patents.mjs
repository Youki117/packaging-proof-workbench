import { ingredientNames, matchQuote, readingBox } from './review.mjs';

const patentNumber = /ZL\s*(?:\d\s*){12}\.\s*[0-9X](?![0-9A-Za-z])/giu;
const numberedClaim = /(\d+)株(?:活性)?专利菌(?:株)?/u;
const generalClaim = /(?:含活性|中国发明)?专利菌株/u;
const strainPattern = /(?:亚种|菌|球菌|酵母)(?:菌株)?[:：]?([a-z]+\d[\da-z-]*|[a-z]+-\d[\da-z-]*)/giu;
const canonical = value => value.normalize('NFKC').replace(/[‐‑–—−]/gu, '-').replace(/\s+/gu, '').toUpperCase();
const pendingReview = issue => issue.status === 'pending' && !issue.note && !issue.humanBox && !Object.hasOwn(issue, 'conclusion');
const strainsIn = text => [...canonical(text).matchAll(strainPattern)].map(match => match[1]);
const centerY = ([, y, , h]) => y + h / 2;

function usePosition(line, quote) {
  return matchQuote([line], quote)?.boxes[0] ?? line.box;
}

function neighborStrains(line, lines) {
  const [x, , w, h] = readingBox(line);
  return [...new Set(lines.flatMap(other => {
    if (other === line || (other.rotation === 180) !== (line.rotation === 180)) return [];
    const [left, , width, height] = readingBox(other);
    const gap = Math.max(left - x - w, x - left - width);
    const aligned = Math.abs(centerY(readingBox(other)) - centerY(readingBox(line))) <= Math.max(h, height) * .55;
    return aligned && gap <= .32 ? strainsIn(other.text) : [];
  }))];
}

export function reviewPatents(pages, sectionsByPage, registry = { version: '未配置', patents: [] }) {
  const records = new Map(registry.patents.map(record => [record.no, record]));
  const rows = [];
  const claims = [];
  const ingredients = new Set(pages.flatMap(page => (sectionsByPage.get(page.id) ?? [])
    .flatMap(text => ingredientNames(text).flatMap(({ query }) => strainsIn(query)))));
  for (const { id: pageId, lines = [] } of pages) {
    for (const [index, line] of lines.entries()) {
      const text = line.text.normalize('NFKC');
      const claim = numberedClaim.exec(text.replace(/\s+/gu, '')) ?? generalClaim.exec(text.replace(/\s+/gu, ''));
      if (claim) {
        const quote = claim[0];
        claims.push({ pageId, box: usePosition(line, quote), quote, declared: Number(claim[1]), line });
      }
      for (const [ordinal, match] of [...text.matchAll(patentNumber)].entries()) {
        const no = canonical(match[0]);
        const record = records.get(no);
        const quote = match[0];
        const box = usePosition(line, quote);
        const inline = [...new Set(strainsIn(text))];
        const candidates = inline.length ? inline : neighborStrains(line, lines);
        const strain = candidates.length === 1 ? candidates[0] : '';
        const citedStrain = strain && record?.strains.find(value => canonical(value) === strain);
        const reference = record && `${record.no} · ${record.certificate}`;
        const state = !record || !strain || record.licensee || record.note || !ingredients.has(strain) ? 'pending' : 'checked';
        const reason = !record ? `本地证书台账未找到 ${no}。先核对原稿号码，若一致请补该专利的证书。`
          : !strain ? `证书确认 ${no} 覆盖 ${record.strains.join('、')}，原稿同一行的菌株未能可靠定位。`
          : !citedStrain ? `原稿把 ${strain} 与 ${no} 印在同一行，证书记载的菌株为 ${record.strains.join('、')}。请核对菌株和号码。`
          : record.licensee ? `菌株与证书号相符。台账记录独家授权给${record.licensee}，请核实本产品的引用授权。`
          : record.note ? `菌株与证书号相符。${record.note}`
          : !ingredients.has(strain) ? `菌株与证书号相符，添加剂栏尚未定位 ${citedStrain}，请核对实际配方及标示。`
          : `原稿菌株与证书号一致，添加剂栏也标有 ${citedStrain}。`;
        rows.push({ pageId, box, quote, strain, no, citedStrain, line,
          id: `${pageId}-patent-${index}-${ordinal}-${no}`, title: citedStrain ? `专利 · ${citedStrain}` : `专利 · ${no}`,
          reason, reference, state: record && strain && !citedStrain ? 'difference' : state });
      }
    }
  }
  const countClaims = claims.filter(item => Number.isFinite(item.declared));
  const references = [...rows];
  for (const [index, claim] of countClaims.entries()) {
    const samePage = references.filter(row => row.pageId === claim.pageId && row.line.rotation === claim.line.rotation);
    const sameRotationClaims = countClaims.filter(item => item.pageId === claim.pageId && item.line.rotation === claim.line.rotation);
    const pool = samePage.length ? samePage.filter(row => {
      if (sameRotationClaims.length === 1) return true;
      const distance = other => Math.abs(centerY(readingBox(row.line)) - centerY(readingBox(other.line)));
      return !sameRotationClaims.some(other => other !== claim && distance(other) <= distance(claim));
    }) : countClaims.length === 1 ? references : [];
    const verified = new Set(pool.filter(row => row.state === 'checked').map(row => row.citedStrain));
    const checked = verified.size === claim.declared && pool.every(row => row.state === 'checked');
    rows.push({ ...claim, title: claim.quote, state: checked ? 'checked' : 'pending', id: `${claim.pageId}-patent-count-${index}`,
      reason: checked ? `包装列出 ${[...verified].join('、')}。这 ${verified.size} 株均与发明专利证书和添加剂栏相符。`
        : `包装声称 ${claim.declared} 株，已用证书和添加剂栏逐株对上 ${verified.size} 株。请补核其余菌株与引用依据。` });
  }
  const confirmed = rows.some(row => row.no && row.state === 'checked') && rows.filter(row => row.no).every(row => row.state === 'checked');
  for (const [index, claim] of claims.filter(item => !Number.isFinite(item.declared)).entries()) {
    const supported = confirmed && !countClaims.length || rows.some(row => Number.isFinite(row.declared) && row.state === 'checked');
    if (!supported && (rows.length || index)) continue;
    rows.push({ ...claim, title: claim.quote, state: supported ? 'checked' : 'pending', id: `${claim.pageId}-patent-label-${index}`,
      ...(supported ? {} : { evidenceOnly: true }),
      reason: supported ? '同一稿的专利明细已核对证书和对应菌株。' : '原稿提及专利，未读到可对应的号码或具体菌株。可补本产品引用的证书供追溯。' });
  }
  if (!rows.length) return null;
  if (rows.some(row => row.no && row.state === 'checked')) rows.push({ title: '专利登记状态', state: 'pending',
    reason: '已查本地发明专利证书。当前有效状态需查专利登记簿。' });
  return { title: '专利依据', reference: `本地发明专利证书台账 · ${registry.version} · ${registry.patents.length} 份`,
    rows: rows.map(({ line, no, declared, strain, citedStrain, ...row }) => row) };
}

export function patentIssues(group, issues) {
  const kept = issues.filter(issue => !pendingReview(issue) || !(
    issue.source === 'patent' || (group && issue.type === 'claims' && /专利/u.test(issue.quote) &&
      ((!issue.source && issue.title === '核对宣传表述与依据') ||
        (issue.source === 'ai' && /^(?:优选|甄选|含活性)?(?:\d+株)?专利菌(?:株)?$/u.test(canonical(issue.quote))
          && !/字号|字体|颜色|版面|位置|顶盖|主展示|相邻|有效|授权|登记/.test(issue.reason))))));
  const findings = (group?.rows ?? []).filter(row => row.state !== 'checked' && row.id && !row.evidenceOnly).map(row => ({
    ...row, issueId: row.id, source: 'patent', type: 'claims', status: 'pending', note: '', boxes: [row.box]
  }));
  return { kept, findings };
}
