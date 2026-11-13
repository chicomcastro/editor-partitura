import type { Score } from './model';

const DB = 'pauta';
const STORE = 'scores';

export interface ScoreMeta {
  id: string;
  title: string;
  composer: string;
  updatedAt: number;
  measures: number;
  parts: string[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveScore(score: Score): Promise<void> {
  await tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(score))));
}

export async function loadScore(id: string): Promise<Score | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<Score | undefined>);
}

export async function deleteScore(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function listScores(): Promise<ScoreMeta[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<Score[]>);
  return all
    .map((sc) => ({
      id: sc.id,
      title: sc.title,
      composer: sc.composer,
      updatedAt: sc.updatedAt,
      measures: sc.measures.length,
      parts: sc.parts.map((p) => p.name),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Pede ao Safari pra não apagar os dados (iOS limpa storage de sites pouco usados). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}
