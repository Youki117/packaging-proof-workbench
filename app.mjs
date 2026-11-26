import {
  annotationBoxes, conclusion, fullSample, humanMark, inspectLines, issueNumber,
  refineIngredient, resolveProofCategory, reviewMarkdown, sampleRegions, statuses, upgradeSample
} from './review.mjs';
import {
  chooseEvidenceChecks, evidenceFinding, evidenceTargets, formulaCoversModelIssue,
  intersectsBox, mergeRotatedLines, retainedReviewIssues, reviewHandoff, reviewSections
} from './agent.mjs';
import {
  AGENT_REVISION, evaluatePageFormula, rereadDetail, runPatentReviewForProject, runVisionPreflight
} from './preflight-engine.mjs';
import { $, base64ToBytes, downloadBlob, formatShortTime, make } from './web/utils.mjs';
import {
  createProjectStorage, deserializeProjectBundle, SAMPLE_PROJECT_ID, serializeProjectBundle
} from './web/storage.mjs';
import { createViewer, regionRaster } from './web/viewer.mjs';

const ocrRevision = 8;
const createSample = () => ({
  id: SAMPLE_PROJECT_ID,
  name: '青屿 · 虚构包装样稿',
  category: 'auto',
  sample: true,
  pages: [{ ...fullSample, ocr: 'waiting' }],
  issues: []
});
const createOwnProject = (name = '未命名稿件') => ({
  id: crypto.randomUUID(),
  name,
  category: 'auto',
  sample: false,
  pages: [],
  issues: []
});

let proof = $('proof');
let project;
let pageId;
let selectedId;
let panel = 'findings';
let pendingImport = false;
let readingFormula = false;
let manualPageId;
let manualBox;
let redrawingId;
let nextIssueNumber;
let lookupId = 0;
let catalogIssueId;
let reviewing = false;

function showNotice(text = '') {
  $('notice').hidden = !text;
  $('notice').textContent = text;
}

async function api(path, data, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'X-Review-Client': 'workbench' }, body: data, signal });
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error);
  return payload;
}

function currentPage() {
  return project?.pages.find(page => page.id === pageId);
}

function currentIssue() {
  return project?.issues.find(issue => issue.id === selectedId);
}

function currentCategory() {
  const allLines = project?.pages.flatMap(page => page.lines ?? []) ?? [];
  return resolveProofCategory(allLines, project?.category ?? 'auto');
}

function confirmedMarks(page = currentPage()) {
  return project.issues.filter(issue => issue.pageId === page?.id && issue.status === 'accepted' && annotationBoxes(issue).length);
}

const projectStorage = createProjectStorage({
  onStatusChange({ available, error, writes, userEdit }) {
    if (!available) {
      $('saved').textContent = '本机保存不可用，请导出意见';
      return;
    }
    if (error || userEdit || $('saved').textContent) {
      $('saved').textContent = error ? '保存失败，请先导出意见' : writes ? '正在保存…' : '已保存';
    }
  }
});

function save(userEdit = false) {
  projectStorage.save(project, userEdit);
  renderProjectCount();
}

const viewer = createViewer({
  stage: $('stage'),
  canvas: $('canvas'),
  annotations: $('annotations'),
  getProof: () => proof,
  setProof: next => { proof = next; },
  showNotice,
  getState: () => ({ project, pageId, selectedId, currentIssue, confirmedMarks }),
  onSelectIssue: id => selectIssue(id),
  onControlsSync: () => setProofControls(),
  onSelectionComplete(mode, box) {
    if (mode === 'note' || mode === 'redraw') {
      if (box[2] <= 0 || box[3] <= 0) {
        showNotice('请拖框标出需要标注的范围。');
        return;
      }
      if (mode === 'note') {
        manualBox = box;
        annotate();
      } else {
        const issue = project.issues.find(item => item.id === redrawingId);
        if (!issue || issue.pageId !== pageId || issue.status === 'dismissed') return;
        Object.assign(issue, { box, boxes: [box], humanBox: true });
        renderReview();
        save(true);
      }
    } else {
      void scanRegion(box);
    }
  }
});

function setProofControls() {
  const ready = Boolean(viewer.getProofSize());
  for (const key of ['zoom-out', 'fit', 'zoom-in', 'crop', 'position-note', 'add-note', 'toggle-marks']) $(key).disabled = !ready;
  for (const button of $('region-links').children) button.disabled = !ready;
  $('redraw').disabled = !ready || currentIssue()?.status === 'dismissed';
}

function renderProjectCount() {
  $('project-count').textContent = String(projectStorage.list().length);
}

function renderViewer() {
  const page = currentPage();
  const pageIndex = project.pages.indexOf(page);
  $('page-name').textContent = project.pages.length > 1 ? page?.label ?? '' : '';
  $('page-position').textContent = page && project.pages.length > 1 ? `${pageIndex + 1} / ${project.pages.length}` : '';
  $('export-image').textContent = project.pages.length > 1 ? '导出本页回稿' : '导出完整回稿';
  $('stage-empty').hidden = !page ? false : true;
  viewer.syncPage(page);
  setProofControls();
  viewer.renderAnnotations();
  const ocrLabels = {
    waiting: '等待本机识别',
    running: '正在识别本页',
    done: page?.ocrEngine ? `本地筛查完成 · ${page.ocrEngine}` : '本地筛查完成',
    failed: '本页识别失败 · 可手动看稿',
    blank: '本页未识别到文字'
  };
  $('page-ocr').textContent = ocrLabels[page?.ocr] ?? '';
  const aiState = $('ai-state');
  aiState.textContent = page?.ocr !== 'done' ? '' : reviewing ? '预审中'
    : page.agentRun?.state === 'paused' ? '预审可继续' : page.aiFailure ? '预审部分完成'
    : page.agentRun?.state === 'complete' && page.agentRevision === AGENT_REVISION ? 'Agent 已整理查证结果'
    : page.agentRevision === AGENT_REVISION ? '文字预审已完成' : '预审未运行';
  aiState.title = [page?.aiFailure, ...(page?.agentRun?.trace ?? page?.agentTrace ?? []), ...(page?.evidenceChecks ?? []).map(check => {
    const status = !check.confirmed ? '待确认' : evidenceFinding(check, page.id) ? '请核对分档' : '两次读数一致';
    return `${check.quote} · ${status}`;
  })].filter(Boolean).join('\n');
  $('retry-ocr').hidden = !['failed', 'blank'].includes(page?.ocr) && !(page?.ocr === 'done' && page.ocrEngine === 'Windows OCR');
  $('ai-review').hidden = project.pages.length < 2;
  $('ai-review').disabled = reviewing || !page?.lines?.length;
  $('ai-review').textContent = reviewing ? 'AI 复核中…' : 'AI 复核本页';
}

function renderPages() {
  const focused = document.activeElement?.dataset.page;
  const multiPage = project.pages.length > 1;
  $('pages').hidden = $('sheet-title').hidden = !multiPage;
  $('pages').closest('.sheets').hidden = !multiPage && !project.sample;
  $('pages-count').textContent = `${project.pages.length} 个版面`;
  $('pages').replaceChildren(...project.pages.map((page, index) => {
    const button = make('button', undefined, 'sheet');
    const image = make('img');
    image.alt = '';
    image.src = viewer.urlFor(page);
    const text = make('span', page.label);
    if (project.pages.length > 1) text.append(make('small', `版面 ${index + 1}`));
    button.append(image, text);
    button.dataset.page = page.id;
    if (page.id === pageId) button.setAttribute('aria-current', 'page');
    return button;
  }));
  if (focused) $('pages').querySelector(`[data-page="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  $('regions').hidden = !project.sample;
  $('region-links').replaceChildren(...(project.sample ? sampleRegions.map(region => {
    const button = make('button', region.label);
    button.dataset.region = region.id;
    button.disabled = !viewer.getProofSize();
    return button;
  }) : []));
}

function findingRow(issue) {
  const row = make('button', undefined, 'finding');
  row.dataset.issue = issue.id;
  row.setAttribute('aria-current', issue.id === selectedId ? 'true' : 'false');
  const number = make('span', issueNumber(issue), `issue-number${humanMark(issue) ? ' human' : ''}`);
  number.dataset.status = issue.status;
  const description = make('span');
  const page = project.pages.find(item => item.id === issue.pageId);
  description.append(make('strong', issue.title), make('small', page?.label));
  if (conclusion(issue)) description.append(make('small', conclusion(issue)));
  row.append(number, description, make('span', statuses[issue.status]));
  return row;
}

function matchesFilter(issue, filter = $('filter').value) {
  if (issue.status === 'dismissed' || filter === 'dismissed') return issue.status === filter;
  return filter === 'all' || filter === issue.type || filter === issue.status;
}

function adjacentIssue(step, onlyPending = false) {
  const issues = project.issues;
  const filter = $('filter').value;
  for (let i = issues.findIndex(issue => issue.id === selectedId) + step; i >= 0 && i < issues.length; i += step) {
    if (matchesFilter(issues[i], filter) && (!onlyPending || issues[i].status === 'pending')) return issues[i];
  }
}

function renderFindingNavigation() {
  const visible = project.issues.filter(issue => matchesFilter(issue));
  const position = visible.findIndex(issue => issue.id === selectedId);
  $('finding-position').textContent = visible.length ? `${position < 0 ? '–' : position + 1} / ${visible.length}` : '';
  $('previous-issue').disabled = !adjacentIssue(-1);
  $('next-issue').disabled = !adjacentIssue(1);
}

function stepFinding(step) {
  const next = adjacentIssue(step);
  if (next) selectIssue(next.id);
}

function renderHandoff() {
  const category = currentCategory();
  const groups = reviewHandoff(project.pages, project.formula, AGENT_REVISION, project.category ?? 'auto');
  if (category === 'pet' && project.patentReview) groups.push(project.patentReview);
  const handoff = $('handoff');
  const first = handoff.hidden;
  handoff.hidden = !groups.length;
  if (!groups.length) return;
  const issues = new Map(project.issues.map(issue => [issue.id, issue]));
  const evidence = project.issues.filter(issue => issue.title === '复核活菌数指数');
  const flat = value => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const findIssue = row => issues.get(row.issueId ?? row.issue?.id) ?? (row.quote && row.box ? evidence.find(issue =>
    issue.pageId === row.pageId && issue.box && intersectsBox(row.box, issue.box) && flat(row.quote).includes(flat(issue.quote))) : undefined);
  const needsHuman = row => row.state !== 'checked' && !['accepted', 'dismissed'].includes(findIssue(row)?.status);
  const pending = groups.flatMap(group => group.rows.filter(needsHuman));
  const formula = groups.find(group => group.title === '配方活菌数');
  const compared = formula?.rows.filter(row => row.state !== 'pending').length;
  const patents = new Set(project.patentReview?.rows.filter(row => row.state === 'checked' && row.reference).map(row => row.title));
  const topics = [
    formula && project.formula?.rows?.length ? `活菌数已比对 ${compared}/${formula.rows.length} 项` : '',
    patents.size ? `专利证书已核 ${patents.size} 株` : ''
  ].filter(Boolean);
  const defaultTitle = category === 'pet' ? '宠物背标' : '食品标签（GB 7718）';
  $('handoff-summary').textContent = [...(topics.length ? topics : [defaultTitle]), pending.length
    ? `${pending.length} 项待处理` : '查证结果'].join(' · ');
  if (first || !pending.length) handoff.open = false;

  const rowView = (row, detailed = false) => {
    const element = make('p', undefined, 'handoff-row');
    const title = make('strong', row.title);
    const issue = findIssue(row);
    const status = issue?.status;
    if (detailed) {
      title.append(` · ${status && status !== 'pending' ? statuses[status]
        : row.state === 'checked' ? '已核对' : row.state === 'difference' ? '有差异' : '待查证'}`);
    }
    element.append(title, make('span', row.reason));
    const reference = [row.cell, row.expected, row.reference].filter(Boolean).join(' · ');
    if (reference) element.append(make('span', reference));
    if (row.pageId || row.title === '关联配方表') {
      const button = make('button', issue ? '查看疑点' : row.box ? '定位原稿' : row.pageId ? '查看版面' : '关联配方表');
      button.type = 'button';
      button.setAttribute('aria-label', `${button.textContent} · ${row.title}`);
      button.onclick = () => {
        if (issue) {
          handoff.open = false;
          selectIssue(issue.id);
          $('note').focus({ preventScroll: true });
        } else if (row.pageId) {
          viewer.focusHandoffBox(row.pageId, row.box, id => selectPage(id));
        } else {
          $('open-formula').click();
        }
      };
      element.append(button);
    }
    return element;
  };
  const groupHeading = (group, rows) => rows.length === 1 && rows[0].title === group.title ? [] : [make('h4', group.title)];
  $('handoff-pending').replaceChildren(...(pending.length ? groups.flatMap(group => {
    const rows = group.rows.filter(needsHuman);
    return rows.length ? [...groupHeading(group, rows), ...rows.map(row => rowView(row))] : [];
  }) : [make('p', '本次查证没有待交接的项目。')]));
  const details = project.patentReview && category === 'pet'
    ? [project.patentReview, ...groups.filter(group => group !== project.patentReview)]
    : groups;
  $('handoff-results').replaceChildren(...details.flatMap(group => [...groupHeading(group, group.rows),
    ...(group.reference ? [make('p', group.reference)] : []), ...group.rows.map(row => rowView(row, true))]));
}

function renderIssueDetails(refreshNote) {
  const issue = currentIssue();
  $('details').hidden = !issue;
  $('redraw').hidden = !issue || issue.status === 'dismissed';
  const empty = $('findings-empty');
  empty.hidden = !!issue;
  if (!issue) {
    empty.textContent = adjacentIssue(1) ? '点原稿上的标框，或点「下一条」开始核对。'
      : $('filter').value !== 'all' ? '此筛选下暂无疑点。'
        : ['waiting', 'running'].includes(currentPage()?.ocr) ? '正在识别原稿并进行本地筛查。'
          : '暂无待核对提示，可继续复核原稿或新增标注。';
    return;
  }
  const source = issue.type === 'manual' ? '人工录入'
    : humanMark(issue) ? '人工修订'
    : issue.source === 'formula' ? '配方表比对'
    : issue.source === 'ai' ? 'AI 复核'
    : issue.source === 'catalog' ? '本地目录查证'
    : issue.source === 'agent' ? '原图局部复读'
    : issue.source === 'patent' ? '专利台账核对'
    : issue.baselineQuote ? '配料区放大复读' : '本机识别';
  $('detail-title').textContent = `${issueNumber(issue)} · ${issue.title}`;
  $('detail-title').title = source;
  $('detail-title').setAttribute('aria-description', source);
  $('detail-status').textContent = statuses[issue.status];
  $('detail-quote').textContent = issue.quote;
  $('detail-quote').hidden = !issue.quote;
  $('ocr-versions').hidden = !issue.baselineQuote;
  $('issue-evidence').hidden = !issue.quote && !issue.baselineQuote;
  if (refreshNote) $('ocr-versions').open = false;
  $('ocr-baseline').textContent = issue.baselineQuote ?? '';
  const hasBox = annotationBoxes(issue).length > 0;
  $('detail-location').hidden = hasBox || issue.status === 'dismissed';
  $('find-names').hidden = issue.type !== 'names' || (!issue.query && issue.source !== 'catalog');
  if (refreshNote) {
    $('note').value = conclusion(issue);
    $('issue-evidence').scrollTop = 0;
  }
  const buttons = $('decision-buttons');
  buttons.querySelector('[data-status="pending"]').hidden = issue.status === 'pending';
  const accept = buttons.querySelector('[data-status="accepted"]');
  accept.hidden = issue.status === 'accepted' || issue.status === 'dismissed';
  accept.disabled = !hasBox;
  const dismiss = buttons.querySelector('[data-status="dismissed"]');
  dismiss.textContent = issue.type === 'manual' ? '删除标注' : '排除此疑点';
  dismiss.hidden = issue.status === 'dismissed';
  $('redraw').textContent = hasBox ? '重画框' : '补画框';
  $('redraw').disabled = !viewer.getProofSize() || issue.status === 'dismissed';
}

function renderReview(refreshNote = false) {
  const focused = document.activeElement?.dataset.issue;
  const pending = project.issues.filter(issue => issue.status === 'pending');
  const decisions = project.issues.filter(issue => ['accepted', 'followup'].includes(issue.status));
  $('pending-count').textContent = pending.length;
  $('kept-count').textContent = decisions.length;
  $('export').disabled = !decisions.length || pendingImport;
  $('decisions-list').replaceChildren(...(decisions.length ? decisions.map(findingRow)
    : [make('p', '确认需修改或待查证的项目会出现在这里。', 'empty')]));
  if (focused && panel === 'decisions') {
    $('decisions-list').querySelector(`[data-issue="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  renderFindingNavigation();
  renderIssueDetails(refreshNote);
  renderHandoff();
  viewer.renderAnnotations();
}

function syncCatalogScope() {
  const pet = currentCategory() === 'pet';
  if ($('catalog-section').hidden !== pet) return;
  $('catalog-section').hidden = !pet;
  $('food-catalog-scope').hidden = pet;
  $('catalog-label').textContent = pet ? '饲料名称' : '普通食品配料名称';
  $('catalog-input').placeholder = pet ? '输入包装上的原料或添加剂名称' : '例如：菊粉、赤藓糖醇、牡丹籽油';
  clearCatalogResults();
}

function renderStatus() {
  renderHandoff();
  if (panel === 'catalog') syncCatalogScope();
  const running = project.pages.filter(page => ['waiting', 'running'].includes(page.ocr)).length;
  const failed = project.pages.filter(page => page.ocr === 'failed').length;
  const processing = $('processing');
  processing.textContent = pendingImport ? '正在导入稿件…'
    : project.pages.length < 2 ? '' : running ? `整稿还有 ${running} 页待识别`
      : failed ? `整稿有 ${failed} 页识别失败` : '';
  processing.hidden = !processing.textContent;
  const nonSampleProjects = projectStorage.list().filter(item => !item.sample);
  $('load-sample').hidden = project.sample && !nonSampleProjects.length;
  $('load-sample').textContent = project.sample && nonSampleProjects.length ? '返回最近稿件' : '打开样稿';
  $('load-sample').disabled = pendingImport;
  $('open-files').disabled = pendingImport;
  $('open-projects').disabled = pendingImport || reviewing;
  $('open-formula').disabled = readingFormula || pendingImport || reviewing || project.sample || !project.pages.length;
  $('open-formula').textContent = readingFormula ? '读取配方表…' : project.formula ? '更换配方表' : '关联配方表';
  const formulaState = $('formula-state');
  const matched = new Set(project.pages.flatMap(page => page.formulaMatches ?? []));
  const total = project.formula?.rows?.length ?? 0;
  const ingTotal = project.formula?.ingredients?.length ?? 0;
  formulaState.textContent = $('handoff').hidden
    ? total ? (matched.size ? `已比对 ${matched.size}/${total} 项活菌数` : `配方表已读取 ${total} 项，尚未匹配`)
      : ingTotal ? `已读取 ${ingTotal} 项配方配料` : ''
    : '';
  formulaState.title = project.formula?.name ?? '';
  $('preflight').disabled = pendingImport || readingFormula || reviewing || running > 0 || !project.pages.some(page => page.lines?.length);
  if (!reviewing) {
    const checked = project.pages.some(page => page.agentRevision === AGENT_REVISION);
    const failedAi = project.pages.find(page => page.aiFailure)?.aiFailure;
    const canResume = project.pages.some(page => page.agentRun?.state === 'paused');
    $('preflight').textContent = canResume ? '继续 AI 预审' : failedAi ? '重试 AI 预审' : checked ? '再次 AI 预审' : '开始 AI 预审';
    $('preflight').title = failedAi || (canResume ? '从上次已保存的查证结果继续' : '复核整稿、按需放大复读并比对已关联的配方');
  }
  if (!projectStorage.isAvailable()) $('saved').textContent = '本机保存不可用，请导出意见';
  $('category-select').value = project.category ?? 'auto';
  renderProjectCount();
}

function setPanel(name) {
  panel = name;
  for (const button of document.querySelectorAll('[data-panel]')) {
    button.setAttribute('aria-pressed', String(button.dataset.panel === panel));
    $(button.dataset.panel).hidden = button.dataset.panel !== panel;
  }
  if (panel === 'catalog') syncCatalogScope();
}

function selectPage(id, issueId, mark = false) {
  viewer.clearHandoffSpot();
  if (id !== pageId) {
    viewer.stopFocus();
    viewer.setSelection();
  }
  if (issueId !== selectedId && ['note', 'redraw'].includes(viewer.getSelectionMode())) viewer.setSelection();
  pageId = id;
  selectedId = issueId;
  if (mark && currentIssue()?.box) viewer.requestFocus(issueId);
  else viewer.stopFocus();
  const activePage = $('pages').querySelector('[aria-current="page"]');
  if (activePage?.dataset.page !== id) {
    activePage?.removeAttribute('aria-current');
    $('pages').querySelector(`[data-page="${CSS.escape(id ?? '')}"]`)?.setAttribute('aria-current', 'page');
  }
  renderViewer();
  viewer.focusOnIssue();
  const list = $('decisions-list');
  list.querySelector('[aria-current="true"]')?.setAttribute('aria-current', 'false');
  list.querySelector(`[data-issue="${CSS.escape(issueId ?? '')}"]`)?.setAttribute('aria-current', 'true');
  renderFindingNavigation();
  renderIssueDetails(true);
}

function selectIssue(id) {
  const issue = project.issues.find(item => item.id === id);
  if (!issue) return;
  if (panel !== 'findings') setPanel('findings');
  if (!matchesFilter(issue)) {
    $('filter').value = issue.status === 'dismissed' ? 'dismissed' : 'all';
    renderReview();
  }
  selectPage(issue.pageId, id, true);
}

function checkPageFormula(page, formula) {
  const { findings, staleIds } = evaluatePageFormula(page, formula, project.issues, ocrRevision);
  if (staleIds.size) project.issues = project.issues.filter(issue => !staleIds.has(issue.id));
  if (selectedId && staleIds.has(selectedId)) selectedId = undefined;
  return findings;
}

function appendFindings(findings) {
  for (const finding of findings) {
    const originalId = finding.id;
    let version = 0;
    let previous = project.issues.find(issue => issue.id === finding.id);
    const isIngredientBlock = finding.type === 'names' && finding.source !== 'ai';
    while (previous && isIngredientBlock && (previous.status !== 'pending' || previous.note) && previous.query !== finding.query) {
      version += 1;
      finding.id = version === 1 ? `${originalId}-block` : `${originalId}-block-${version}`;
      previous = project.issues.find(issue => issue.id === finding.id);
    }
    if (previous) {
      if (previous.status === 'pending' && !previous.note && !previous.humanBox && !Object.hasOwn(previous, 'conclusion')) {
        Object.assign(previous, finding, { baselineQuote: finding.baselineQuote });
      }
      continue;
    }
    const duplicate = project.issues.some(issue =>
      issue.pageId === finding.pageId && issue.source === finding.source
      && issue.quote === finding.quote && issue.type === finding.type
      && Math.abs(issue.box[0] - finding.box[0]) < .04 && Math.abs(issue.box[1] - finding.box[1]) < .04);
    if (!duplicate) project.issues.push({ ...finding, number: nextIssueNumber++ });
  }
  if (!selectedId && !viewer.getSelectionMode() && panel === 'findings') {
    selectedId = project.issues.find(issue => issue.pageId === pageId && matchesFilter(issue))?.id;
    renderReview(true);
  } else {
    renderReview();
  }
}

function openProject(next) {
  viewer.stopFocus();
  $('canvas').hidden = true;
  viewer.revokeAllUrls();
  fillCatalog('');
  $('filter').value = 'all';
  upgradeSample(next);
  project = next;
  project.category ??= 'auto';
  nextIssueNumber = project.issues.reduce((max, issue) => Math.max(max, issue.number ?? 0), 0) + 1;
  for (const issue of project.issues) issue.number ??= nextIssueNumber++;
  viewer.setView('marked');
  for (const page of project.pages) {
    if (page.ocr === 'running' || (['done', 'blank'].includes(page.ocr) && page.ocrRevision !== ocrRevision)) {
      page.ocr = 'waiting';
    }
  }
  $('case-name').textContent = project.name;
  setPanel('findings');
  renderPages();
  const first = project.pages[0]?.id;
  selectPage(first, project.issues.find(issue => issue.pageId === first && matchesFilter(issue))?.id);
  const category = currentCategory();
  appendFindings(project.pages.filter(page => page.ocr === 'done').flatMap(page =>
    inspectLines(page.lines ?? [], page.id, { category }).filter(issue => issue.title === '核对两项标示之间的分隔').map(issue => ({
      ...issue, id: `ocr${ocrRevision}-${page.ocrEngine === 'Windows OCR' ? 'winrt' : 'paddle'}-${issue.id}`
    }))));
  if (project.formula) appendFindings(project.pages.flatMap(page => checkPageFormula(page, project.formula)));
  renderReview(true);
  renderStatus();
  save();
  void scanWaiting(project);
}

async function pageBlob(page) {
  if (page.file) return page.file;
  const response = await fetch(page.src);
  if (!response.ok) throw Error('无法打开样稿。');
  return response.blob();
}

async function recognizeRegion(source, box, { zoom = 2, windows = false, rotate = false, signal } = {}) {
  const region = regionRaster(source, box, { zoom, rotate });
  if (!region) return { lines: [] };
  const { raster, place } = region;
  const image = await new Promise(resolve => raster.toBlob(resolve, 'image/png'));
  if (!image) throw Error('无法读取所选区域。');
  const { lines, engine } = await api(windows ? '/api/ocr?engine=windows' : '/api/ocr', image, signal);
  return {
    engine,
    lines: lines.map(line => ({
      ...line,
      box: place(line.box),
      rotation: rotate !== (line.rotation === 180) ? 180 : undefined,
      words: line.words?.map(word => ({ ...word, box: place(word.box) }))
    }))
  };
}

async function recoverRotatedIngredients(image, lines) {
  const rotated = lines.filter(line => line.rotation === 180);
  if (rotated.some(line => /添加剂组成/.test(line.text))) return;
  const anchor = rotated.filter(line => /CFU\s*\/\s*g/i.test(line.text)).sort((a, b) => b.box[2] - a.box[2])[0];
  if (!anchor) return;
  const [x, y, w, h] = anchor.box;
  const left = Math.max(0, x - h * 2);
  const top = Math.max(0, y - h * 4.5);
  const right = Math.min(1, x + w + h * 2);
  const bottom = Math.min(1, y + h * 4.5);
  const bitmap = await createImageBitmap(image);
  try {
    const { lines: rescanned } = await recognizeRegion(bitmap, [left, top, right - left, bottom - top], { rotate: true });
    if (!rescanned.some(line => line.rotation === 180 && /添加剂组成/.test(line.text))) return;
    const merged = mergeRotatedLines(lines, rescanned);
    if (inspectLines(merged, 'rotate').some(issue => issue.title === '核对添加剂组成' && issue.lineIndexes.length > 1)) {
      lines.splice(0, lines.length, ...merged);
    }
  } finally {
    bitmap.close();
  }
}

async function refinePage(image, lines, candidates) {
  if (!candidates.length) return;
  const bitmap = await createImageBitmap(image);
  try {
    for (const { box: [left, top, width, height], lineIndexes } of candidates) {
      const padding = lines[lineIndexes[0]].box[3] * .35;
      const x = Math.max(0, left - padding);
      const y = Math.max(0, top - padding);
      const region = [x, y, Math.min(1, left + width + padding) - x, Math.min(1, top + height + padding) - y];
      const { lines: reread } = await recognizeRegion(bitmap, region);
      const refined = refineIngredient(lineIndexes.map(index => lines[index]), reread);
      lineIndexes.forEach((index, i) => { lines[index] = refined[i]; });
    }
  } finally {
    bitmap.close();
  }
}

async function scanWaiting(target) {
  if (target.pages.some(page => page.ocr === 'running')) return;
  for (const page of target.pages) {
    if (target !== project) return;
    if (page.ocr !== 'waiting') continue;
    page.ocr = 'running';
    renderViewer();
    renderStatus();
    try {
      const image = await pageBlob(page);
      const { lines, engine = 'Windows OCR' } = await api('/api/ocr', image);
      if (project !== target) return;
      try {
        await recoverRotatedIngredients(image, lines);
      } catch (error) {
        console.warn('倒置配料区复读失败，保留整页识别结果。', error.message);
      }
      const category = resolveProofCategory(lines, target.category ?? 'auto');
      const candidates = inspectLines(lines, page.id, { category }).filter(issue => issue.lineIndexes
        && lines[issue.lineIndexes[0]].rotation !== 180);
      try {
        await refinePage(image, lines, candidates);
      } catch (error) {
        console.warn('配料区复读失败，保留整页识别结果。', error.message);
      }
      if (project !== target) return;
      const rotated = lines.filter(line => line.rotation === 180);
      if (page.ocrRevision !== ocrRevision && rotated.length) {
        target.issues = target.issues.filter(issue => issue.pageId !== page.id || issue.status !== 'pending'
          || humanMark(issue) || Object.hasOwn(issue, 'conclusion') || !issue.box
          || !rotated.some(line => intersectsBox(issue.box, line.box)));
        if (selectedId && !target.issues.some(issue => issue.id === selectedId)) selectedId = undefined;
      }
      page.ocr = lines.length ? 'done' : 'blank';
      page.ocrRevision = ocrRevision;
      page.ocrEngine = engine;
      page.lines = lines;
      delete page.agentRevision;
      delete page.agentTrace;
      delete page.agentRun;
      delete page.evidenceChecks;
      const engineKey = engine === 'Windows OCR' ? 'winrt' : 'paddle';
      appendFindings(inspectLines(lines, page.id, { category }).map(finding => ({
        ...finding, id: `ocr${ocrRevision}-${engineKey}-${finding.id}`
      })));
      if (project.formula) appendFindings(checkPageFormula(page, project.formula));
    } catch (error) {
      if (project !== target) return;
      page.ocr = 'failed';
      if (page.id === pageId) showNotice(error.message);
    }
    renderViewer();
    renderStatus();
    save();
  }
}

async function attachFormula(file) {
  if (!file || readingFormula || reviewing || project.sample || !project.pages.length) return;
  const target = project;
  if (!/\.(?:xlsx|png|jpe?g)$/i.test(file.name) || !file.size || file.size > 30 * 1024 * 1024) {
    showNotice('请选择不超过 30 MB 的 XLSX 或配方表图片。');
    return;
  }
  readingFormula = true;
  renderStatus();
  try {
    const { rows = [], ingredients = [] } = await api('/api/formula', file);
    if (project !== target) return;
    const formula = { name: file.name, rows, ingredients };
    if (JSON.stringify(target.formula) !== JSON.stringify(formula)) {
      const previous = target.issues.filter(issue => issue.source === 'formula');
      const reviewed = previous.some(issue => issue.status !== 'pending' || humanMark(issue));
      if (reviewed && !confirm('更换配方表会移除旧表对应的核对记录。请先导出需要保留的意见。继续更换？')) return;
      target.issues = target.issues.filter(issue => issue.source !== 'formula');
      if (previous.some(issue => issue.id === selectedId)) selectPage(pageId);
      target.formula = formula;
      for (const page of target.pages) {
        delete page.agentRevision;
        delete page.agentTrace;
        delete page.agentRun;
      }
    }
    appendFindings(target.pages.flatMap(page => checkPageFormula(page, formula)));
    save(true);
    const hasOcr = target.pages.some(page => page.lines?.length);
    const summary = rows.length ? `${rows.length} 项活菌数` : `${ingredients.length} 项配料成分`;
    showNotice(hasOcr ? `配方表已关联（${summary}）。右栏可查看逐项比对结果。`
      : `配方表已关联（${summary}），原稿识别完成后自动比对。`);
  } catch (error) {
    if (project === target) showNotice(`配方表读取失败：${error.message}`);
  } finally {
    readingFormula = false;
    renderStatus();
  }
}

async function fetchAiConfig() {
  return fetch('/api/ai').then(response => {
    if (!response.ok) throw Error('无法读取模型状态。');
    return response.json();
  }).catch(error => ({ available: false, error: error.message }));
}

async function refreshModelBadge() {
  const badge = $('model-badge');
  const config = await fetchAiConfig();
  if (!config.available) {
    badge.textContent = '未配置模型';
    badge.title = config.error || '请复制「模型配置.example.json」为「模型配置.json」并填写接口地址';
    return;
  }
  const activeModel = config.vision ? (config.visionModel || config.model) : config.model;
  const scope = config.vision ? (config.visionRemote ? '远程视觉' : '本地视觉') : (config.remote ? '远程文字' : '本地文字');
  badge.textContent = `${activeModel} · ${scope}`;
  badge.title = `接口主机：${config.vision ? (config.visionDestination || config.destination) : config.destination}`;
}

async function aiReview(wholeProof = false) {
  const target = project;
  const category = currentCategory();
  const pet = category === 'pet';
  const pages = (wholeProof ? project.pages : [currentPage()]).filter(page => page?.ocr === 'done' && page.lines?.length);
  const pending = pages.filter(page => page.agentRevision !== AGENT_REVISION || page.aiFailure || page.agentRun?.state === 'paused');
  const queue = wholeProof && pending.length ? pending : pages;
  if (reviewing || readingFormula || !queue.length) return;
  reviewing = true;
  renderViewer();
  renderStatus();
  showNotice('正在检查 AI 复核配置…');
  let activePage = queue[0];
  try {
    const config = await fetchAiConfig();
    if (target !== project) return;
    if (!config.vision && queue.some(page => page.agentRun?.state === 'paused')) {
      showNotice(config.error || '恢复多模态模型连接后即可继续已保存的预审。');
      return;
    }
    const willUseRemote = config.vision ? Boolean(config.visionRemote) : Boolean(config.remote);
    const remoteHost = config.vision ? (config.visionDestination || config.destination) : config.destination;
    if (willUseRemote) {
      const payloadType = config.vision ? '压缩展开稿图像与 OCR 文字' : 'OCR 文字';
      if (!confirm(`将 ${queue.length} 个版面的${payloadType}发送给远程主机 ${remoteHost}。确认该稿件可以提交后继续？`)) {
        showNotice();
        return;
      }
    }
    const errors = [];
    let rereadCount = 0;
    const originalIssues = new Set(project.issues.map(issue => issue.id));

    for (const [index, page] of queue.entries()) {
      activePage = page;
      $('preflight').textContent = `AI 预审 ${index + 1}/${queue.length}`;
      showNotice(`${config.vision ? (config.visionModel || config.model) : (config.model || 'AI')} 正在复核「${page.label}」…`);
      let findings = [];
      let checks = chooseEvidenceChecks(evidenceTargets(page.lines));
      const failures = [];
      let readings = [];
      let trace = [];
      let catalogIssues = [];
      let clearedCatalog;
      let verified = [];
      let clearedCopy = new Set();

      if (config.vision) {
        const bitmap = await createImageBitmap(await pageBlob(page));
        try {
          const cropPhoto = (box, rotate = false, zoom = 1) => {
            const view = regionRaster(bitmap, box, { zoom, rotate, limit: 1500 });
            const image = view?.raster.toDataURL('image/jpeg', .86);
            return image?.length > 600_000 ? view.raster.toDataURL('image/jpeg', .65) : image;
          };
          const visual = await runVisionPreflight({
            page,
            formula: target.formula,
            projectIssues: target.issues,
            category,
            allowRemote: willUseRemote,
            deps: {
              cropPhoto,
              recognizeRegion: (box, opts) => recognizeRegion(bitmap, box, opts),
              callApi: (path, body, signal) => api(path, body, signal)
            },
            onProgress: showNotice,
            onCheckpoint: () => save(true),
            isCurrent: () => target === project
          });
          ({ findings, catalogIssues, clearedCatalog, readings, trace, verified, clearedCopy } = visual);
          failures.push(...visual.failures);
          checks = [];
        } finally {
          bitmap.close();
        }
      } else if (config.available) {
        try {
          const review = await api('/api/ai', JSON.stringify({
            lines: page.lines, agent: true, category, allowRemote: willUseRemote
          }));
          findings = review.findings;
          checks = review.checks ?? checks;
        } catch (error) {
          failures.push(error.message);
        }
      } else {
        failures.push(config.error || '语义复核尚未配置。');
      }
      if (target !== project) return;

      try {
        if (checks.length) {
          const bitmap = await createImageBitmap(await pageBlob(page));
          try {
            for (const check of checks) {
              if (target !== project) return;
              showNotice(`正在复读「${page.label}」的原图小字 ${readings.length + 1}/${checks.length}…`);
              readings.push(await rereadDetail({
                lines: page.lines,
                check,
                recognizeRegion: (box, opts) => recognizeRegion(bitmap, box, opts)
              }));
            }
          } finally {
            bitmap.close();
          }
        }
      } catch (error) {
        failures.push(`局部复读未完成。${error.message}`);
      }
      if (target !== project) return;

      if (readings.some(reading => reading.readings.some(item => item.error && !item.optional))) {
        failures.push('部分局部复读失败。');
      }
      const refreshed = new Set(readings.map(reading => reading.id));
      page.evidenceChecks = [...(page.evidenceChecks ?? []).filter(reading => !refreshed.has(reading.id)), ...readings];
      const formulaIssues = checkPageFormula(page, target.formula);
      for (const issue of target.issues.filter(item => item.pageId === page.id && item.source === 'ai')) {
        if (formulaCoversModelIssue(issue, formulaIssues)) clearedCopy.add(issue.id);
      }
      const checkedBlocks = config.vision
        ? reviewSections(page.lines, pet).filter(section => page.agentRun?.catalogRows?.[section.id]?.length)
        : [];
      project.issues = retainedReviewIssues(project.issues, page.id, readings, clearedCatalog, clearedCopy, checkedBlocks);
      if (selectedId && !project.issues.some(issue => issue.id === selectedId)) selectedId = undefined;
      const evidenceIssues = readings.map(reading => evidenceFinding(reading, page.id)).filter(Boolean);
      if (config.vision) page.agentTrace = trace;
      else {
        delete page.agentTrace;
        delete page.agentRun;
      }
      appendFindings([
        ...evidenceIssues,
        ...catalogIssues,
        ...verified,
        ...formulaIssues,
        ...findings.filter(finding => !formulaCoversModelIssue(finding, formulaIssues)).map(({ key, ...finding }) => ({
          ...finding, id: `${page.id}-ai-${key}`, pageId: page.id, source: 'ai', status: 'pending', note: ''
        }))
      ]);
      rereadCount += readings.length;
      page.agentRevision = AGENT_REVISION;
      if (failures.length) {
        page.aiFailure = failures.join(' ');
        errors.push(`${page.label}：${page.aiFailure}`);
      } else {
        delete page.aiFailure;
      }
      save();
    }

    if (pet) {
      const registry = await fetch('/patent-register.json').then(response => {
        if (!response.ok) throw Error('本地专利台账无法读取。');
        return response.json();
      }).catch(() => undefined);
      const { patentReview, kept, findings } = runPatentReviewForProject({
        pages: target.pages,
        issues: target.issues,
        registry
      });
      target.patentReview = patentReview;
      target.issues = kept;
      if (!kept.some(issue => issue.id === selectedId)) selectedId = undefined;
      appendFindings(findings);
    }

    const added = target.issues.filter(issue => !originalIssues.has(issue.id)).length;
    const done = (wholeProof ? target.pages : queue).filter(page => page.agentRevision === AGENT_REVISION && !page.aiFailure).length;
    const summary = `${config.vision ? 'Agent 预审' : '文字预审'}已处理 ${done}/${wholeProof ? target.pages.length : queue.length} 页，原图复读 ${rereadCount} 处，新增 ${added} 条疑点。`;
    showNotice([summary, ...errors].join(' '));
  } catch (error) {
    if (target === project) {
      if (activePage) activePage.aiFailure = error.message;
      showNotice(error.message);
    }
  } finally {
    reviewing = false;
    if (target === project) save();
    renderViewer();
    renderStatus();
  }
}

async function importFiles(files) {
  if (!files.length || pendingImport) return;
  if (files.length > 8 || files.some(file => file.size < 1 || file.size > 30 * 1024 * 1024)) {
    showNotice('请选最多 8 份文件，单份大小为 1 字节至 30 MB。');
    return;
  }
  pendingImport = true;
  showNotice('正在导入新稿件…');
  renderStatus();
  renderReview();
  try {
    const next = createOwnProject(files[0].name.replace(/\.[^.]+$/, ''));
    for (const file of files) {
      if (/\.pdf$/i.test(file.name)) {
        const { pages } = await api('/api/pdf', file);
        pages.forEach((base64, index) => {
          next.pages.push({
            id: crypto.randomUUID(),
            label: `${file.name} · 第 ${index + 1} 页`,
            ocr: 'waiting',
            file: new Blob([base64ToBytes(base64)], { type: 'image/png' })
          });
        });
      } else if (/\.(png|jpe?g)$/i.test(file.name)) {
        const bitmap = await createImageBitmap(file);
        bitmap.close();
        next.pages.push({ id: crypto.randomUUID(), label: file.name, file, ocr: 'waiting' });
      } else {
        throw Error('请选择 PNG、JPG 或 PDF 文件。');
      }
      if (next.pages.length > 16) throw Error('一次可导入最多 16 个版面。');
    }
    openProject(next);
    showNotice(`已创建新稿件「${next.name}」，历史稿件可在顶部「稿件」管理中随时切回。`);
  } catch (error) {
    showNotice(`导入失败：${error.message}`);
  } finally {
    pendingImport = false;
    $('files').value = '';
    renderStatus();
    renderReview();
  }
}

function renderProjectsDialog() {
  const list = projectStorage.list();
  $('projects-list').replaceChildren(...list.map(item => {
    const card = make('div', undefined, `project-card${item.id === project.id ? ' is-current' : ''}`);
    const meta = make('div', undefined, 'project-meta');
    const kept = (item.issues ?? []).filter(i => ['accepted', 'followup'].includes(i.status)).length;
    const catLabel = item.category === 'food' ? '普通食品' : item.category === 'pet' ? '宠物饲料' : '自动品类';
    meta.append(
      make('strong', `${item.name}${item.sample ? '（内置样稿）' : ''}`),
      make('small', `${item.pages?.length ?? 0} 个版面 · ${kept} 条意见 · ${catLabel}${item.updatedAt ? ` · ${formatShortTime(item.updatedAt)}` : ''}`)
    );
    const actions = make('div', undefined, 'project-card-actions');
    const openBtn = make('button', item.id === project.id ? '当前稿件' : '打开');
    openBtn.type = 'button';
    openBtn.disabled = item.id === project.id;
    openBtn.onclick = () => {
      $('projects-dialog').close();
      openProject(item);
    };
    actions.append(openBtn);
    if (!item.sample) {
      const renameBtn = make('button', '重命名');
      renameBtn.type = 'button';
      renameBtn.onclick = () => {
        const renamed = prompt('输入新的稿件名称：', item.name)?.trim();
        if (!renamed || renamed === item.name) return;
        item.name = renamed.slice(0, 120);
        if (item.id === project.id) $('case-name').textContent = item.name;
        projectStorage.save(item, true);
        renderProjectsDialog();
      };
      const delBtn = make('button', '删除');
      delBtn.type = 'button';
      delBtn.onclick = async () => {
        if (!confirm(`确认删除稿件「${item.name}」及其所有未导出记录？`)) return;
        await projectStorage.remove(item.id);
        if (item.id === project.id) {
          const remaining = projectStorage.list();
          openProject(remaining[0] ?? createSample());
        }
        renderProjectsDialog();
        renderStatus();
      };
      actions.append(renameBtn, delBtn);
    }
    card.append(meta, actions);
    return card;
  }));
}

async function exportBundle() {
  try {
    showNotice('正在打包工程备份…');
    const jsonText = await serializeProjectBundle(project);
    downloadBlob(new Blob([jsonText], { type: 'application/json;charset=utf-8' }), `${project.name}.workbench.json`);
    showNotice('已导出工程备份文件。');
  } catch (error) {
    showNotice(`工程导出失败：${error.message}`);
  }
}

async function importBundle(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const restored = deserializeProjectBundle(text);
    $('projects-dialog').close();
    openProject(restored);
    save(true);
    showNotice(`已导入审查工程「${restored.name}」。`);
  } catch (error) {
    showNotice(`工程导入失败：${error.message}`);
  }
}

function renderCatalog(result) {
  const matchLabel = {
    'EXACT MATCH': '索引名称匹配',
    'SPECIES MATCH': '菌种名匹配，编号请核对',
    'MULTIPLE MATCH': '有多个候选',
    'FUZZY MATCH': '仅有相似候选'
  };
  $('catalog-results').replaceChildren(...result.items.map(({ query, parents = [], matches, catalog, name, record, source, verdict, notes, reason }) => {
    const entry = make('details', undefined, 'lookup-item');
    entry.open = true;
    entry.append(make('summary', [...parents, query].join(' › ')));
    if (!matches) {
      if (name && record) entry.append(make('strong', name), make('p', [catalog, record, source].filter(Boolean).join(' · ')));
      const explanation = !record ? '该目录未找到可确认的条目，请核对名称或切换目录。'
        : notes?.join(' ') || reason || (verdict === 'ok' ? '目录名称匹配。' : '请核对原文与目录写法。');
      entry.append(make('p', explanation));
      return entry;
    }
    if (!matches.length) {
      entry.append(make('p', '本地索引无匹配。可核对输入或查正式目录。'));
      return entry;
    }
    const options = make('ul');
    for (const match of matches) {
      const item = make('li');
      const basis = [match.catalog_type, match.basis, match.ins && `INS ${match.ins}`, matchLabel[match.status]].filter(Boolean);
      item.append(make('strong', match.official_name), make('p', basis.join(' · ')));
      if (match.foodcate) item.append(make('p', `适用范围：${match.foodcate}`));
      if (match.consumption) item.append(make('p', `食用量提示：${match.consumption}`));
      options.append(item);
    }
    entry.append(options);
    return entry;
  }));
}

function clearCatalogResults() {
  lookupId += 1;
  $('catalog-search').disabled = false;
  $('catalog-results').replaceChildren();
}

function fillCatalog(value, issueId) {
  catalogIssueId = issueId;
  $('catalog-back').hidden = !issueId;
  $('catalog-input').value = value.slice(0, 2000);
  const issue = project?.issues.find(item => item.id === issueId);
  $('catalog-section').value = issue?.catalogSection ?? (issue?.title.includes('添加剂') ? 'additive' : 'raw');
  clearCatalogResults();
}

async function lookup() {
  const input = $('catalog-input').value.trim();
  if (!input) {
    $('catalog-input').focus();
    return;
  }
  const id = ++lookupId;
  $('catalog-search').disabled = true;
  $('catalog-results').replaceChildren(make('p', '正在查询本地索引…', 'empty'));
  try {
    const scope = $('catalog-section');
    const result = await api(scope.hidden ? '/api/catalog' : `/api/catalog?pet=${scope.value}`, input);
    if (id === lookupId) renderCatalog(result);
  } catch (error) {
    if (id === lookupId) $('catalog-results').replaceChildren(make('p', error.message, 'empty'));
  } finally {
    if (id === lookupId) $('catalog-search').disabled = false;
  }
}

function setDecision(status) {
  const issue = currentIssue();
  if (!issue) return;
  if (status === 'accepted' && !annotationBoxes(issue).length) return;
  if (issue.status === status) return;
  const active = document.activeElement;
  const note = $('note');
  const keepKeyboardFocus = active === note || active.matches('.decision-buttons button:focus-visible');
  const wasPending = issue.status === 'pending';
  issue.status = status;
  const nextPending = wasPending && (adjacentIssue(1, true) ?? adjacentIssue(-1, true));
  if (nextPending) selectIssue(nextPending.id);
  else if (!matchesFilter(issue)) {
    const next = adjacentIssue(1) ?? adjacentIssue(-1);
    if (next) selectIssue(next.id);
    else selectPage(pageId);
  }
  renderReview();
  save(true);
  if (keepKeyboardFocus) (currentIssue() ? note : $('filter')).focus();
}

function annotate() {
  $('note-location').textContent = `位置：${currentPage().label}`;
  $('note-dialog').showModal();
}

async function scanRegion(box) {
  const target = project;
  const origin = pageId;
  if (proof.naturalWidth * box[2] < 12 || proof.naturalHeight * box[3] < 12) {
    showNotice('请框选包含文字的区域。');
    return;
  }
  showNotice('正在识别框选区域…');
  try {
    const { lines: placed } = await recognizeRegion(proof, box);
    if (target !== project) return;
    const findings = inspectLines(placed, origin, { category: currentCategory() });
    appendFindings(findings.map(finding => ({ ...finding, id: crypto.randomUUID() })));
    save();
    if (origin !== pageId) return;
    const raw = placed.map(line => line.text.replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '').trim()).join('\n');
    if (raw) {
      const block = findings.find(finding => finding.type === 'names' && finding.query);
      fillCatalog(block?.query ?? raw);
      setPanel('catalog');
      showNotice(block ? '配料段已填到「名称查证」，请先对照原稿修正。'
        : '识别结果保留了原来的断行。查证前请把同一名称的断行接起来。');
    } else {
      showNotice('框选区域未识别到文字。请放大核对，或手动录入。');
    }
  } catch (error) {
    if (target === project && origin === pageId) showNotice(error.message);
  }
}

function reInspectByCategory() {
  const category = currentCategory();
  // Drop untouched automatic local findings and regenerate under the chosen category.
  project.issues = project.issues.filter(issue =>
    issue.source || issue.type === 'manual' || issue.status !== 'pending' || humanMark(issue) || Object.hasOwn(issue, 'conclusion'));
  for (const page of project.pages) {
    if (page.ocr !== 'done' || !page.lines?.length) continue;
    const engineKey = page.ocrEngine === 'Windows OCR' ? 'winrt' : 'paddle';
    appendFindings(inspectLines(page.lines, page.id, { category }).map(finding => ({
      ...finding, id: `ocr${ocrRevision}-${engineKey}-${finding.id}`
    })));
  }
  syncCatalogScope();
  renderReview(true);
  renderStatus();
  save(true);
}

// Event bindings
window.addEventListener('beforeunload', event => {
  if (projectStorage.hasPendingDecisions()) event.preventDefault();
});

$('open-files').onclick = () => $('files').click();
$('open-formula').onclick = () => $('formula-file').click();
$('open-projects').onclick = () => {
  renderProjectsDialog();
  $('projects-dialog').showModal();
};
$('close-projects').onclick = () => $('projects-dialog').close();
$('new-project-import').onclick = () => {
  $('projects-dialog').close();
  $('files').click();
};
$('export-bundle').onclick = () => { void exportBundle(); };
$('import-bundle').onclick = () => $('bundle-file').click();
$('bundle-file').onchange = event => {
  const [file] = event.target.files;
  event.target.value = '';
  void importBundle(file);
};
$('category-select').onchange = event => {
  project.category = event.target.value;
  reInspectByCategory();
};
$('formula-file').onchange = event => {
  const [file] = event.target.files;
  event.target.value = '';
  void attachFormula(file);
};
$('files').onchange = event => {
  const files = [...event.target.files];
  event.target.value = '';
  void importFiles(files);
};
$('load-sample').onclick = () => {
  if (!project) return;
  save();
  if (project.sample) {
    const latest = projectStorage.list().find(item => !item.sample);
    if (latest) openProject(latest);
  } else {
    openProject(projectStorage.getCached(SAMPLE_PROJECT_ID) ?? createSample());
  }
};
$('pages').onclick = event => {
  const id = event.target.closest('[data-page]')?.dataset.page;
  if (!id) return;
  if (id !== pageId) selectPage(id, project.issues.find(issue => issue.pageId === id && matchesFilter(issue))?.id);
  else if (viewer.getProofSize()) {
    viewer.stopFocus();
    viewer.setSelection();
    viewer.fitProof(true);
  }
};
$('region-links').onclick = event => {
  const region = sampleRegions.find(item => item.id === event.target.dataset.region);
  if (region) viewer.focusRegionBox(region.box);
};
$('decisions-list').onclick = event => {
  const issueId = event.target.closest('[data-issue]')?.dataset.issue;
  if (issueId) selectIssue(issueId);
};
$('toggle-marks').onclick = () => {
  const clean = $('stage').classList.contains('clean');
  if (viewer.getSelectionMode() && !clean) viewer.setSelection();
  viewer.setView(clean ? 'marked' : 'clean');
};
for (const button of document.querySelectorAll('[data-panel]')) button.onclick = () => setPanel(button.dataset.panel);
$('filter').onchange = () => {
  const issue = currentIssue();
  if (issue && matchesFilter(issue)) return renderFindingNavigation();
  const next = project.issues.find(item => matchesFilter(item));
  if (next) selectIssue(next.id);
  else selectPage(pageId);
};
$('previous-issue').onclick = () => stepFinding(-1);
$('next-issue').onclick = () => stepFinding(1);
for (const [id, factor] of [['zoom-out', 1 / 1.3], ['fit', 0], ['zoom-in', 1.3]]) {
  $(id).onclick = () => viewer.zoomProof(factor);
}
$('crop').onclick = () => viewer.setSelection(viewer.getSelectionMode() === 'ocr' ? '' : 'ocr');
$('retry-ocr').onclick = () => {
  currentPage().ocr = 'waiting';
  void scanWaiting(project);
};
$('ai-review').onclick = () => { void aiReview(); };
$('preflight').onclick = () => { void aiReview(true); };
$('find-names').onclick = () => {
  const issue = currentIssue();
  if (!issue) return;
  if (catalogIssueId !== issue.id) fillCatalog(issue.query ?? issue.quote ?? '', issue.id);
  setPanel('catalog');
  $('catalog-input').focus();
};
$('catalog-back').onclick = () => {
  setPanel('findings');
  if (selectedId !== catalogIssueId) selectIssue(catalogIssueId);
  $('find-names').focus();
};
$('catalog-input').oninput = clearCatalogResults;
$('catalog-section').onchange = clearCatalogResults;
$('catalog-form').onsubmit = event => { event.preventDefault(); void lookup(); };

const note = $('note');
note.oninput = () => {
  const issue = currentIssue();
  if (!issue || note.value === conclusion(issue)) return;
  const wasHuman = humanMark(issue);
  issue.conclusion = note.value;
  if (issue.status === 'accepted' || issue.status === 'followup' || wasHuman !== humanMark(issue)) renderReview();
  save(true);
};
note.onkeydown = event => {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing || event.repeat) return;
  const accept = $('decision-buttons').querySelector('[data-status="accepted"]');
  if (accept.disabled || accept.hidden) return;
  event.preventDefault();
  setDecision('accepted');
};
$('decision-buttons').onclick = event => {
  const status = event.target.closest('[data-status]')?.dataset.status;
  if (status) setDecision(status);
};
$('add-note').onclick = () => {
  if (!viewer.getProofSize()) return;
  manualPageId = pageId;
  manualBox = undefined;
  $('note-form').reset();
  viewer.setView('marked');
  viewer.setSelection(viewer.getSelectionMode() === 'note' ? '' : 'note');
};
$('redraw').onclick = () => {
  redrawingId = selectedId;
  viewer.setView('marked');
  viewer.setSelection(viewer.getSelectionMode() === 'redraw' ? '' : 'redraw');
};
$('position-note').onclick = () => {
  $('note-dialog').close();
  viewer.setSelection('note');
};
$('cancel-note').onclick = () => $('note-dialog').close();
$('note-form').onsubmit = event => {
  event.preventDefault();
  const advice = $('manual-note').value.trim();
  if (!manualBox || manualPageId !== pageId) return;
  const quote = $('manual-quote').value.trim();
  const issue = {
    id: crypto.randomUUID(),
    pageId: manualPageId,
    type: 'manual',
    title: '人工发现',
    quote,
    box: manualBox,
    boxes: [manualBox],
    number: nextIssueNumber++,
    note: advice,
    status: event.submitter.value
  };
  project.issues.push(issue);
  $('note-dialog').close();
  setPanel('findings');
  $('filter').value = 'all';
  selectIssue(issue.id);
  renderReview(true);
  save(true);
};
$('export').onclick = () => {
  const markdown = reviewMarkdown(project.name, project.pages, project.issues);
  downloadBlob(new Blob(['\ufeff', markdown], { type: 'text/markdown;charset=utf-8' }), `${project.name}-包装修改清单.md`);
};
$('export-image').onclick = () => {
  void viewer.exportImage(project, currentPage(), confirmedMarks());
};

// Bootstrap
const initial = await projectStorage.init(createSample);
openProject(initial);
void refreshModelBadge();
