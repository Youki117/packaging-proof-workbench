import { blobToDataUrl, dataUrlToBlob } from './utils.mjs';

const DB_NAME = 'packaging-workbench';
const DB_VERSION = 2;
export const SAMPLE_PROJECT_ID = 'sample-default';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function createProjectStorage({ onStatusChange = () => {} } = {}) {
  let db = null;
  let errorFlag = false;
  let writes = 0;
  let decisionWrites = 0;
  const cache = new Map();

  async function init(createSample) {
    try {
      db = await openDb();
      let projects = await txGetAll(db, 'projects');
      if (!projects.length) {
        // One-time transparent migration from IndexedDB v1 ('drafts' store)
        const [legacyActive, legacySample, legacyOwn] = await Promise.all([
          txGet(db, 'drafts', 'active'),
          txGet(db, 'drafts', 'sample'),
          txGet(db, 'drafts', 'own')
        ]);
        const migrated = [];
        if (legacySample) {
          migrated.push({ ...legacySample, id: SAMPLE_PROJECT_ID, sample: true, updatedAt: legacySample.updatedAt ?? Date.now() - 1000 });
        }
        if (legacyOwn) {
          migrated.push({ ...legacyOwn, id: legacyOwn.id || 'own-legacy', sample: false, updatedAt: legacyOwn.updatedAt ?? Date.now() });
        }
        if (migrated.length) {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(['projects', 'meta'], 'readwrite');
            const store = tx.objectStore('projects');
            for (const item of migrated) store.put(item);
            const activeId = legacyActive === 'own' && legacyOwn ? (legacyOwn.id || 'own-legacy') : SAMPLE_PROJECT_ID;
            tx.objectStore('meta').put(activeId, 'activeProjectId');
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
          });
          projects = migrated;
        }
      }
      for (const item of projects) cache.set(item.id, item);
      if (!cache.has(SAMPLE_PROJECT_ID)) {
        cache.set(SAMPLE_PROJECT_ID, { ...createSample(), id: SAMPLE_PROJECT_ID, updatedAt: 0 });
      }
      const activeId = await txGet(db, 'meta', 'activeProjectId');
      return cache.get(activeId) ?? cache.get(SAMPLE_PROJECT_ID);
    } catch {
      db = null;
      const fallback = { ...createSample(), id: SAMPLE_PROJECT_ID, updatedAt: 0 };
      cache.set(fallback.id, fallback);
      return fallback;
    }
  }

  function list() {
    return [...cache.values()].sort((a, b) => {
      if (a.sample !== b.sample) return a.sample ? 1 : -1;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  }

  function getCached(id) {
    return cache.get(id);
  }

  function save(project, userEdit = false) {
    if (!project) return;
    if (!project.id) project.id = project.sample ? SAMPLE_PROJECT_ID : crypto.randomUUID();
    project.updatedAt = Date.now();
    cache.set(project.id, project);
    if (!db) {
      onStatusChange({ available: false, error: true, writes: 0, decisionWrites: 0 });
      return;
    }
    const tx = db.transaction(['projects', 'meta'], 'readwrite', { durability: userEdit ? 'strict' : 'default' });
    writes += 1;
    if (userEdit) decisionWrites += 1;
    if (userEdit) onStatusChange({ available: true, error: false, writes, decisionWrites, userEdit: true });
    tx.objectStore('projects').put(project);
    tx.objectStore('meta').put(project.id, 'activeProjectId');
    const finish = failed => {
      writes -= 1;
      if (userEdit) decisionWrites -= 1;
      errorFlag = failed;
      onStatusChange({ available: true, error: failed, writes, decisionWrites, userEdit });
    };
    tx.oncomplete = () => finish(false);
    tx.onabort = () => finish(true);
    tx.commit?.();
  }

  async function remove(id) {
    if (!id || id === SAMPLE_PROJECT_ID) return false;
    cache.delete(id);
    if (!db) return true;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').delete(id);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    return true;
  }

  return {
    init,
    list,
    getCached,
    save,
    remove,
    hasPendingDecisions: () => decisionWrites > 0,
    isAvailable: () => Boolean(db) && !errorFlag
  };
}

export async function serializeProjectBundle(project) {
  const pages = await Promise.all(project.pages.map(async page => {
    const { file, agentRun, ...rest } = page;
    const serializedRun = agentRun ? {
      ...agentRun,
      clearedCatalog: agentRun.clearedCatalog instanceof Set ? [...agentRun.clearedCatalog] : (agentRun.clearedCatalog ?? [])
    } : undefined;
    const dataUrl = file ? await blobToDataUrl(file) : undefined;
    return { ...rest, ...(serializedRun && { agentRun: serializedRun }), ...(dataUrl && { dataUrl }) };
  }));
  return JSON.stringify({
    schema: 'packaging-workbench.v1',
    exportedAt: new Date().toISOString(),
    project: {
      name: project.name,
      category: project.category ?? 'auto',
      formula: project.formula ?? null,
      patentReview: project.patentReview ?? null,
      issues: project.issues ?? [],
      pages
    }
  });
}

export function deserializeProjectBundle(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawText ?? '').replace(/^\uFEFF/, ''));
  } catch {
    throw Error('工程文件 JSON 格式无效。');
  }
  if (parsed?.schema !== 'packaging-workbench.v1' || !parsed.project || !Array.isArray(parsed.project.pages)) {
    throw Error('不是有效的包装审查工程备份文件（.workbench.json）。');
  }
  const source = parsed.project;
  const pages = source.pages.map(page => {
    const { dataUrl, agentRun, ...rest } = page;
    const restoredRun = agentRun ? {
      ...agentRun,
      clearedCatalog: new Set(Array.isArray(agentRun.clearedCatalog) ? agentRun.clearedCatalog : [])
    } : undefined;
    return {
      ...rest,
      ...(restoredRun && { agentRun: restoredRun }),
      ...(dataUrl && { file: dataUrlToBlob(dataUrl) })
    };
  });
  return {
    id: crypto.randomUUID(),
    sample: false,
    name: String(source.name || '导入的审查工程'),
    category: ['auto', 'food', 'pet'].includes(source.category) ? source.category : 'auto',
    formula: source.formula ?? undefined,
    patentReview: source.patentReview ?? undefined,
    issues: Array.isArray(source.issues) ? source.issues : [],
    pages,
    updatedAt: Date.now()
  };
}
