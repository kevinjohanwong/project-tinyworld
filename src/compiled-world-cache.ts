export type CompiledChunkGeometry = {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
};

export type CompiledChunkMap = Map<string, CompiledChunkGeometry | null>;

export type CompiledWorldCache = {
  version: number;
  key: string;
  createdAt: number;
  wall: CompiledChunkMap;
  ground: CompiledChunkMap;
  // v2: the key is computed from the RAW decoded layers, and the settled
  // result of the load pre-passes (divots → hole-fill/trees → gravity settle)
  // is stored so a hit skips those passes entirely.
  settledLayers?: Record<string, Int32Array>;
  metaFlags?: { treesUpgraded?: boolean; treeUpgradeVersion?: number };
};

const DB_NAME = "tinyworld-compiled-worlds";
const STORE_NAME = "worlds";
export const COMPILED_WORLD_CACHE_VERSION = 2;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function mixByte(hash: number, value: number): number {
  hash ^= value & 255;
  return Math.imul(hash, 16777619) >>> 0;
}

function mixInt(hash: number, value: number): number {
  hash = mixByte(hash, value);
  hash = mixByte(hash, value >>> 8);
  hash = mixByte(hash, value >>> 16);
  return mixByte(hash, value >>> 24);
}

export function compiledWorldFingerprint(
  layers: Record<string, ArrayBuffer | Int32Array>,
  variant: string,
): string {
  let hash = 2166136261 >>> 0;
  const names = Object.keys(layers).sort();
  for (const name of names) {
    for (let i = 0; i < name.length; i++) hash = mixByte(hash, name.charCodeAt(i));
    const value = layers[name];
    const data = value instanceof Int32Array ? value : new Int32Array(value);
    hash = mixInt(hash, data.length);
    for (let i = 0; i < data.length; i++) hash = mixInt(hash, data[i]);
  }
  for (let i = 0; i < variant.length; i++) hash = mixByte(hash, variant.charCodeAt(i));
  return `v${COMPILED_WORLD_CACHE_VERSION}-${hash.toString(16).padStart(8, "0")}`;
}

export async function loadCompiledWorldCache(key: string): Promise<CompiledWorldCache | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => {
      const value = req.result as CompiledWorldCache | undefined;
      resolve(value?.version === COMPILED_WORLD_CACHE_VERSION ? value : null);
    };
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}

export async function saveCompiledWorldCache(
  key: string,
  wall: CompiledChunkMap,
  ground: CompiledChunkMap,
  settledLayers?: Record<string, Int32Array>,
  metaFlags?: { treesUpgraded?: boolean; treeUpgradeVersion?: number },
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const value: CompiledWorldCache = {
    version: COMPILED_WORLD_CACHE_VERSION,
    key,
    createdAt: Date.now(),
    wall,
    ground,
    settledLayers,
    metaFlags,
  };
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}
