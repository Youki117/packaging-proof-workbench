import { annotationBoxes, conclusion, humanMark, issueNumber, rotateBox } from '../review.mjs';
import { $, downloadBlob, make } from './utils.mjs';

const cameraPadding = 20;
const issueScale = 2.15;
const proofLoadingText = '正在打开版面…';

export function boxStyle(element, box) {
  element.hidden = !box;
  if (!box) return;
  const [left, top, width, height] = box.map(value => `${value * 100}%`);
  Object.assign(element.style, { left, top, width, height });
}

export function regionRaster(source, box, { zoom = 2, rotate = false, limit = 2400 } = {}) {
  const sourceWidth = source.naturalWidth ?? source.width;
  const sourceHeight = source.naturalHeight ?? source.height;
  const [left, top, width, height] = box;
  const x = Math.round(left * sourceWidth);
  const y = Math.round(top * sourceHeight);
  const w = Math.round((left + width) * sourceWidth) - x;
  const h = Math.round((top + height) * sourceHeight) - y;
  if (w < 12 || h < 12) return;
  const scale = Math.min(zoom, limit / Math.max(w, h));
  const raster = make('canvas');
  raster.width = Math.round(w * scale);
  raster.height = Math.round(h * scale);
  const context = raster.getContext('2d');
  context.imageSmoothingQuality = 'high';
  if (rotate) {
    context.translate(raster.width, raster.height);
    context.scale(-1, -1);
  }
  context.drawImage(source, x, y, w, h, 0, 0, raster.width, raster.height);
  const place = inner => {
    const [rx, ry, rw, rh] = rotate ? rotateBox(inner) : inner;
    return [(x + rx * w) / sourceWidth, (y + ry * h) / sourceHeight, rw * w / sourceWidth, rh * h / sourceHeight];
  };
  return { raster, place };
}

export function createViewer({
  stage,
  canvas,
  annotations,
  getProof,
  setProof,
  showNotice,
  getState,
  onSelectIssue,
  onSelectionComplete,
  onControlsSync
}) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let camera = { x: 0, y: 0, scale: 1 };
  let proofSize;
  let panStart;
  let selectionMode = '';
  let dragStart;
  let proofRequest;
  let focusRequest;
  let handoffSpot;
  let focusAnimation;
  let imageUrls = new Map();

  function urlFor(page) {
    if (page.src) return page.src;
    if (!imageUrls.has(page.id)) imageUrls.set(page.id, URL.createObjectURL(page.file));
    return imageUrls.get(page.id);
  }

  function revokeAllUrls() {
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls = new Map();
  }

  function transform({ x, y, scale }) {
    return `translate(${x}px, ${y}px) scale(${scale})`;
  }

  function constrain({ x, y, scale }) {
    const pad = cameraPadding;
    const axis = (offset, extent, available) => extent <= available - 2 * pad
      ? (available - extent) / 2 : Math.min(pad, Math.max(available - pad - extent, offset));
    return {
      x: axis(x, proofSize.width * scale, stage.clientWidth),
      y: axis(y, proofSize.height * scale, stage.clientHeight),
      scale
    };
  }

  function centerAt(scale, x = .5, y = .5) {
    return constrain({
      x: stage.clientWidth / 2 - proofSize.width * scale * x,
      y: stage.clientHeight / 2 - proofSize.height * scale * y,
      scale
    });
  }

  function visibleCamera() {
    if (!focusAnimation) return camera;
    const { e: x, f: y, a: scale } = new DOMMatrixReadOnly(getComputedStyle(canvas).transform);
    return { x, y, scale };
  }

  function showZoom(scale) {
    const proof = getProof();
    const label = scale === 1 ? '适合窗口' : `原图 ${Math.round(proofSize.width * scale / proof.naturalWidth * 100)}%`;
    if ($('zoom-level').textContent !== label) $('zoom-level').textContent = label;
  }

  function placeAnnotations({ x, y, scale }) {
    Object.assign(annotations.style, {
      width: `${proofSize.width * scale}px`,
      height: `${proofSize.height * scale}px`,
      transform: `translate(${x}px, ${y}px)`
    });
  }

  function moveCamera(next, overview = false, animated = false) {
    const start = visibleCamera();
    focusAnimation?.cancel();
    focusAnimation = undefined;
    camera = next;
    canvas.style.transform = transform(next);
    stage.classList.toggle('is-zoomed', next.scale > 1);
    const distance = Math.hypot(next.x - start.x, next.y - start.y);
    if (!animated || reducedMotion.matches || (distance < 1 && Math.abs(start.scale - next.scale) < .002)) {
      placeAnnotations(next);
      showZoom(next.scale);
      return;
    }
    showZoom(start.scale);
    const duration = overview ? 460 : Math.min(380, 230 + distance * .17);
    const easing = 'cubic-bezier(.24, .45, .26, 1)';
    const frames = [{ transform: transform(start) }];
    if (overview) frames.push({ transform: transform(start), offset: 60 / duration, easing });
    else frames[0].easing = easing;
    frames.push({ transform: transform(next) });
    const animation = canvas.animate(frames, { duration, fill: 'backwards' });
    focusAnimation = animation;
    placeAnnotations(start);
    function follow() {
      if (focusAnimation !== animation) return;
      placeAnnotations(visibleCamera());
      requestAnimationFrame(follow);
    }
    requestAnimationFrame(follow);
    animation.onfinish = () => {
      if (focusAnimation !== animation) return;
      focusAnimation = undefined;
      placeAnnotations(next);
      showZoom(next.scale);
    };
  }

  function issueCamera(issue, scale) {
    const [x, y, width, height] = issue.box;
    return centerAt(scale, x + width / 2, y + height / 2);
  }

  function fitProof(reset = false, issue) {
    if (!proofSize && !reset) return;
    const proof = getProof();
    const old = proofSize;
    const available = Math.max(1, Math.min(stage.clientWidth - 2 * cameraPadding,
      (stage.clientHeight - 2 * cameraPadding) * proof.naturalWidth / proof.naturalHeight, proof.naturalWidth));
    proofSize = {
      width: available,
      height: available * proof.naturalHeight / proof.naturalWidth,
      viewWidth: stage.clientWidth,
      viewHeight: stage.clientHeight
    };
    canvas.style.width = `${proofSize.width}px`;
    canvas.style.height = `${proofSize.height}px`;
    if (issue) {
      moveCamera(issueCamera(issue, issueScale));
      return;
    }
    const scale = reset ? 1 : camera.scale;
    const x = old && !reset ? (old.viewWidth / 2 - camera.x) / (old.width * scale) : .5;
    const y = old && !reset ? (old.viewHeight / 2 - camera.y) / (old.height * scale) : .5;
    moveCamera(centerAt(scale, x, y));
  }

  function stopFocus() {
    focusRequest = undefined;
    if (focusAnimation) moveCamera(visibleCamera());
  }

  function focusOnIssue() {
    const { currentIssue } = getState();
    const issue = currentIssue();
    if (!focusRequest || issue?.id !== focusRequest || !proofSize) return;
    focusRequest = undefined;
    moveCamera(issueCamera(issue, Math.max(issueScale, camera.scale)),
      !focusAnimation && camera.scale === 1, true);
  }

  function fadePreviousProof(image) {
    const previous = make('div', undefined, 'previous-proof');
    previous.inert = true;
    const layer = canvas.cloneNode(false);
    const outline = annotations.cloneNode(true);
    for (const element of [layer, image, outline]) element.removeAttribute('id');
    outline.hidden = false;
    layer.append(image);
    previous.append(layer, outline);
    annotations.after(previous);
    const fade = previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-out' });
    fade.onfinish = () => previous.remove();
  }

  function renderAnnotations() {
    const { project, pageId, selectedId, currentIssue, confirmedMarks } = getState();
    $('export-image').disabled = !proofSize || !confirmedMarks().length;
    annotations.hidden = !proofSize;
    const issue = currentIssue();
    const badge = $('active-mark');
    badge.hidden = !(proofSize && issue?.pageId === pageId && issue.status !== 'dismissed' && annotationBoxes(issue).length);
    if (!badge.hidden) {
      badge.textContent = issueNumber(issue);
      badge.setAttribute('aria-label', `当前标注 ${issueNumber(issue)}`);
      badge.classList.toggle('human', humanMark(issue));
    }
    if (!proofSize) return;
    const focused = annotations.contains(document.activeElement) ? document.activeElement.dataset.issue : undefined;
    annotations.replaceChildren(...project.issues.filter(item => item.pageId === pageId && item.status !== 'dismissed')
      .flatMap(item => annotationBoxes(item).map((box, index) => {
        const button = make('button', undefined, `annotation${humanMark(item) ? ' human' : ''}`);
        button.dataset.issue = item.id;
        button.setAttribute('aria-label', `${issueNumber(item)} ${item.title}`);
        button.setAttribute('aria-current', String(item.id === selectedId));
        if (index) button.tabIndex = -1;
        boxStyle(button, box);
        return button;
      })));
    if (focused) annotations.querySelector(`[data-issue="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  async function loadProof(request) {
    const page = request.page;
    const image = new Image();
    image.src = urlFor(page);
    image.id = 'proof';
    image.alt = page.label;
    image.draggable = false;
    showNotice(proofLoadingText);
    try {
      await image.decode();
    } catch {
      if (proofRequest !== request) return;
      canvas.hidden = true;
      showNotice('原稿图片加载失败，可切换版面后重试。');
      return;
    }
    if (proofRequest !== request) return;
    if ($('notice').textContent === proofLoadingText) showNotice();
    const issue = getState().currentIssue();
    const destination = handoffSpot ?? (!canvas.hidden && issue?.id === focusRequest ? issue : undefined);
    const previous = getProof();
    previous.replaceWith(image);
    setProof(image);
    if (destination && !reducedMotion.matches) fadePreviousProof(previous);
    fitProof(true, destination);
    handoffSpot = undefined;
    canvas.hidden = false;
    renderAnnotations();
    onControlsSync();
    if (destination) focusRequest = undefined;
    focusOnIssue();
  }

  function syncPage(page) {
    if (page !== proofRequest?.page) {
      proofRequest = { page };
      stage.querySelector('.previous-proof')?.remove();
      proofSize = undefined;
      if (page) void loadProof(proofRequest);
      else {
        canvas.hidden = true;
        getProof().removeAttribute('src');
      }
    }
  }

  function zoomProof(factor = 0, cursor) {
    if (!proofSize) return;
    const proof = getProof();
    const start = visibleCamera();
    const maxScale = Math.max(6, 2 * proof.naturalWidth / proofSize.width);
    const scale = factor ? Math.max(.55, Math.min(maxScale, (cursor ? start.scale : camera.scale) * factor)) : 1;
    const [x, y] = cursor ?? [stage.clientWidth / 2, stage.clientHeight / 2];
    const ratio = scale / start.scale;
    focusRequest = undefined;
    const next = factor ? constrain({ x: x - (x - start.x) * ratio, y: y - (y - start.y) * ratio, scale }) : centerAt(1);
    moveCamera(next, false, !cursor);
  }

  function panProof(x, y, start = visibleCamera()) {
    if (!proofSize || selectionMode) return false;
    const next = constrain({ x: start.x + x, y: start.y + y, scale: start.scale });
    if (!focusAnimation && next.x === camera.x && next.y === camera.y) return false;
    focusRequest = undefined;
    moveCamera(next);
    return true;
  }

  function setView(mode) {
    const clean = mode === 'clean';
    stage.classList.toggle('clean', clean);
    $('toggle-marks').textContent = clean ? '显示标记' : '清屏';
    $('toggle-marks').title = clean ? '重新显示原稿上的标框' : '临时隐藏原稿上的所有标框';
  }

  function setSelection(mode = '') {
    if (mode) stopFocus();
    selectionMode = mode;
    dragStart = undefined;
    canvas.classList.toggle('cropping', !!mode);
    stage.classList.toggle('is-selecting', !!mode);
    $('crop').setAttribute('aria-pressed', String(mode === 'ocr'));
    $('add-note').setAttribute('aria-pressed', String(mode === 'note'));
    $('redraw').setAttribute('aria-pressed', String(mode === 'redraw'));
    $('selection').hidden = true;
    showNotice(mode === 'ocr' ? '在原稿上拖一个框，重新识别区域内的文字。按 Esc 取消。'
      : mode ? '在原稿上拖框标出位置。按 Esc 取消。' : '');
  }

  function focusRegionBox(box) {
    if (!proofSize) return;
    setSelection();
    const [x, y, w, h] = box;
    const scale = Math.max(1, Math.min(5,
      (stage.clientWidth - 2 * cameraPadding) / (proofSize.width * w),
      (stage.clientHeight - 2 * cameraPadding) / (proofSize.height * h)));
    moveCamera(centerAt(scale, x + w / 2, y + h / 2), false, true);
  }

  function focusHandoffBox(pageId, box, selectPage) {
    const loaded = proofRequest?.page?.id === pageId && proofSize && !canvas.hidden;
    selectPage(pageId);
    if (box && loaded) moveCamera(issueCamera({ box }, Math.max(issueScale, camera.scale)), false, true);
    else if (box) handoffSpot = { box };
    else if (loaded) fitProof(true);
  }

  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    const unit = value => Math.max(0, Math.min(1, value));
    return [unit((event.clientX - bounds.left) / bounds.width), unit((event.clientY - bounds.top) / bounds.height)];
  }

  function rectangle(first, last) {
    return [Math.min(first[0], last[0]), Math.min(first[1], last[1]),
      Math.abs(first[0] - last[0]), Math.abs(first[1] - last[1])];
  }

  async function exportImage(project, page, issues) {
    if (!proofSize || !issues.length) return;
    const proof = getProof();
    const title = `${project.name} · ${page.label}`;
    const result = make('canvas');
    const width = proof.naturalWidth;
    const height = proof.naturalHeight;
    result.width = Math.max(720, width);
    const offset = Math.floor((result.width - width) / 2);
    const font = Math.max(18, Math.round(result.width / 65));
    const padding = font;
    const lineHeight = Math.ceil(font * 1.5);
    const context = result.getContext('2d');
    const fontStyle = `${font}px "Microsoft YaHei UI", sans-serif`;
    context.font = fontStyle;
    const captions = [title, ...issues.map(issue => `${issueNumber(issue)}  ${conclusion(issue) || issue.title}`)];
    const rows = captions.map(text => {
      const lines = [''];
      for (const character of text.replace(/\r\n/g, '\n')) {
        const last = lines.length - 1;
        if (character === '\n') lines.push('');
        else if (context.measureText(lines[last] + character).width > result.width - 2 * padding) lines.push(character);
        else lines[last] += character;
      }
      return lines;
    });
    result.height = height + 2 * padding + rows.reduce((total, lines) => total + (lines.length + .5) * lineHeight, 0);
    try {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, result.width, result.height);
      context.drawImage(proof, offset, 0, width, height);
      context.font = fontStyle;
      const markFont = Math.max(12, Math.round(width / 150));
      const colors = getComputedStyle(stage);
      for (const issue of issues) {
        const human = humanMark(issue);
        const color = colors.getPropertyValue(human ? '--human-mark' : '--auto-mark').trim();
        context.font = `700 ${markFont}px "Segoe UI", sans-serif`;
        const number = issueNumber(issue);
        const labelWidth = context.measureText(number).width + 8;
        const labelHeight = markFont + 4;
        for (const [left, top, w, h] of annotationBoxes(issue)) {
          const x = offset + left * width;
          const y = top * height;
          const stroke = Math.max(1.25, width / 2300);
          context.lineWidth = stroke + 1.5;
          context.strokeStyle = '#27212c';
          context.strokeRect(x, y, w * width, h * height);
          context.lineWidth = stroke;
          context.strokeStyle = color;
          context.strokeRect(x, y, w * width, h * height);
          const labelX = Math.min(result.width - labelWidth, x);
          const labelY = y >= labelHeight ? y - labelHeight : Math.min(height - labelHeight, y + h * height);
          context.fillStyle = color;
          context.fillRect(labelX, Math.max(0, labelY), labelWidth, labelHeight);
          context.fillStyle = human ? '#fff' : '#211e34';
          context.fillText(number, labelX + 4, Math.max(0, labelY) + markFont);
        }
      }
      context.font = fontStyle;
      context.fillStyle = '#211e34';
      let y = height + padding + font;
      for (const lines of rows) {
        for (const line of lines) {
          context.fillText(line, padding, y);
          y += lineHeight;
        }
        y += lineHeight / 2;
      }
      const png = await new Promise(resolve => result.toBlob(resolve, 'image/png'));
      if (!png) throw Error('图片过大或浏览器无法生成 PNG。');
      downloadBlob(png, `${title}-完整回稿.png`);
    } catch (error) {
      showNotice(`标注图导出失败。${error.message}`);
    }
  }

  // Bind stage/canvas pointer, wheel, keyboard and resize listeners
  stage.addEventListener('wheel', event => {
    if (!proofSize || event.ctrlKey || event.metaKey || !event.deltaY) return;
    event.preventDefault();
    if (dragStart || panStart?.camera) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    const delta = Math.max(-180, Math.min(180, event.deltaY * unit));
    const rect = stage.getBoundingClientRect();
    zoomProof(Math.exp(-delta * .0025), [event.clientX - rect.left, event.clientY - rect.top]);
  }, { passive: false });

  stage.addEventListener('pointerdown', event => {
    stage.querySelector('.previous-proof')?.remove();
    if (selectionMode || !proofSize || camera.scale <= 1 || event.button !== 0 || !event.isPrimary) return;
    panStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  stage.addEventListener('pointermove', event => {
    if (panStart?.id !== event.pointerId) return;
    const dx = event.clientX - panStart.x;
    const dy = event.clientY - panStart.y;
    if (!panStart.camera) {
      if (Math.hypot(dx, dy) < 4) return;
      stopFocus();
      panStart.camera = camera;
      stage.classList.add('is-panning');
      stage.setPointerCapture(event.pointerId);
    }
    panProof(dx, dy, panStart.camera);
  });
  function endPan(event) {
    if (panStart?.id !== event.pointerId) return;
    panStart = undefined;
    stage.classList.remove('is-panning');
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, endPan);
  stage.addEventListener('pointerleave', event => { if (!panStart?.camera) endPan(event); });
  stage.addEventListener('keydown', event => {
    const direction = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
    if (direction && panProof(...direction)) event.preventDefault();
    else if (['+', '=', '-', '0'].includes(event.key) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      zoomProof(event.key === '0' ? 0 : event.key === '-' ? 1 / 1.3 : 1.3);
    }
  });
  reducedMotion.addEventListener('change', () => {
    stage.querySelector('.previous-proof')?.remove();
    if (focusAnimation) moveCamera(camera);
  });
  new ResizeObserver(() => {
    if (proofSize && (proofSize.viewWidth !== stage.clientWidth || proofSize.viewHeight !== stage.clientHeight)) fitProof();
  }).observe(stage);

  annotations.onclick = event => {
    const id = event.target.closest('[data-issue]')?.dataset.issue;
    if (id) onSelectIssue(id);
  };
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !selectionMode) return;
    setSelection();
  });
  canvas.onpointerdown = event => {
    if (!selectionMode || event.button !== 0 || !proofSize) return;
    dragStart = point(event);
    canvas.setPointerCapture(event.pointerId);
    boxStyle($('selection'), [...dragStart, 0, 0]);
  };
  canvas.onpointermove = event => {
    if (dragStart) boxStyle($('selection'), rectangle(dragStart, point(event)));
  };
  canvas.onpointerup = event => {
    if (!dragStart) return;
    const box = rectangle(dragStart, point(event));
    const mode = selectionMode;
    setSelection();
    onSelectionComplete(mode, box);
  };
  canvas.onpointercancel = () => setSelection();

  return {
    urlFor,
    revokeAllUrls,
    syncPage,
    fitProof,
    zoomProof,
    stopFocus,
    focusOnIssue,
    focusRegionBox,
    focusHandoffBox,
    renderAnnotations,
    setView,
    setSelection,
    exportImage,
    requestFocus: issueId => { focusRequest = issueId; },
    clearHandoffSpot: () => { handoffSpot = undefined; },
    getProofSize: () => proofSize,
    getSelectionMode: () => selectionMode
  };
}
