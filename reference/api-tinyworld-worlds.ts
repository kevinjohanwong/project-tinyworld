import type { Context } from "hono";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const DATA_DIR = "/home/workspace/project-tinyworld/data";
const DB_PATH = `${DATA_DIR}/tinyworld.db`;

// Discovery layer: a requester's "node" is their location.
// GPS tier (client shares coords): tight, human-scale perception.
// IP tier (fallback): coarse, city-scale perception.
// Worlds outside the node's perception radius are not returned at all.
const GPS_VISIBILITY_KM = 0.15; // matches the 150 m access gate: if you can enter it, you can see it
const GPS_LIDAR_BROADCAST_KM = 5;
const IP_VISIBILITY_KM = 50;
const IP_LIDAR_BROADCAST_KM = 500;

const ipCache = new Map<string, { lat: number; lon: number; city: string; ts: number } | { fail: true; ts: number }>();
const IP_CACHE_TTL = 24 * 3600_000;

function isPrivateIp(ip: string) {
  return (
    !ip ||
    ip === "::1" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
}

async function resolveNodeFromIp(ip: string) {
  if (isPrivateIp(ip)) return null;
  const cached = ipCache.get(ip);
  if (cached && Date.now() - cached.ts < IP_CACHE_TTL) {
    return "fail" in cached ? null : cached;
  }
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as any;
    if (data?.success && typeof data.latitude === "number" && typeof data.longitude === "number") {
      const node = { lat: data.latitude, lon: data.longitude, city: data.city || data.region || "unknown", ts: Date.now() };
      ipCache.set(ip, node);
      return node;
    }
  } catch {}
  ipCache.set(ip, { fail: true, ts: Date.now() });
  return null;
}

function getDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.run(`CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    owner TEXT DEFAULT 'kj',
    base_blocks INTEGER DEFAULT 0,
    integrity REAL DEFAULT 100,
    created_at INTEGER NOT NULL,
    last_visited INTEGER NOT NULL,
    last_scanned INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS block_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    source TEXT DEFAULT 'user',
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS bridges (
    id TEXT PRIMARY KEY,
    world_a TEXT NOT NULL,
    world_b TEXT NOT NULL,
    integrity REAL DEFAULT 100,
    created_at INTEGER NOT NULL,
    last_reinforced INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS world_blocks (
    world_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    block_count INTEGER DEFAULT 0,
    resolution INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS structures (
    id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    built_at INTEGER NOT NULL
  )`);
  return db;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export default async function handler(c: Context) {
  const db = getDb();
  try {
    if (c.req.method === "POST") {
      const body = await c.req.json().catch(() => null);
      if (!body) return c.json({ ok: false, error: "JSON body required" }, 400);

      if (body.action === "saveBlocks") {
        if (!body.worldId || !body.layers) {
          return c.json({ ok: false, error: "worldId and layers are required" }, 400);
        }
        const world = db.query(`SELECT id FROM worlds WHERE id = ?`).get(body.worldId);
        if (!world) return c.json({ ok: false, error: "world not found" }, 404);
        const now = Date.now();
        const payload = JSON.stringify({ layers: body.layers, meta: body.meta ?? {} });
        const blockCount = typeof body.blockCount === "number" ? Math.floor(body.blockCount) : 0;
        const resolution = typeof body.resolution === "number" ? Math.floor(body.resolution) : 0;
        db.run(
          `INSERT INTO world_blocks (world_id, payload, block_count, resolution, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(world_id) DO UPDATE SET payload = excluded.payload,
             block_count = excluded.block_count, resolution = excluded.resolution,
             updated_at = excluded.updated_at`,
          [body.worldId, payload, blockCount, resolution, now],
        );
        db.run(`UPDATE worlds SET base_blocks = ?, last_scanned = ?, last_visited = ? WHERE id = ?`, [
          blockCount, now, now, body.worldId,
        ]);
        return c.json({ ok: true, worldId: body.worldId, blockCount, bytes: payload.length });
      }

      if (body.action === "logEvents") {
        if (!body.worldId || !Array.isArray(body.events)) {
          return c.json({ ok: false, error: "worldId and events (array) are required" }, 400);
        }
        for (const ev of body.events) {
          if (!ev.kind || typeof ev.count !== "number") continue;
          db.run(
            `INSERT INTO block_events (world_id, kind, count, source, created_at) VALUES (?, ?, ?, ?, ?)`,
            [body.worldId, ev.kind, ev.count, ev.source || "sim", Date.now()]
          );
        }
        return c.json({ ok: true });
      }

      if (typeof body.lat !== "number" || typeof body.lon !== "number") {
        return c.json({ ok: false, error: "lat and lon (numbers) are required" }, 400);
      }
      const now = Date.now();
      const id = `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Unnamed Tiny World";
      const baseBlocks = typeof body.baseBlocks === "number" ? Math.max(0, Math.floor(body.baseBlocks)) : 0;
      db.run(
        `INSERT INTO worlds (id, name, lat, lon, base_blocks, integrity, created_at, last_visited, last_scanned)
         VALUES (?, ?, ?, ?, ?, 100, ?, ?, ?)`,
        [id, name, body.lat, body.lon, baseBlocks, now, now, now],
      );
      const world = db.query(`SELECT * FROM worlds WHERE id = ?`).get(id);
      return c.json({ ok: true, world });
    }

    const lat = c.req.query("lat") ? Number(c.req.query("lat")) : null;
    const lon = c.req.query("lon") ? Number(c.req.query("lon")) : null;

    const worldId = c.req.query("id");
    if (worldId && c.req.query("blocks") === "1") {
      const row = db.query(`SELECT * FROM world_blocks WHERE world_id = ?`).get(worldId) as any;
      if (!row) return c.json({ ok: false, error: "no saved blocks for this world" }, 404);
      db.run(`UPDATE worlds SET last_visited = ? WHERE id = ?`, [Date.now(), worldId]);
      return new Response(row.payload, {
        headers: { "Content-Type": "application/json", "X-Block-Count": String(row.block_count) },
      });
    }

    // --- Node resolution (discovery layer) ---
    const nodeLatQ = c.req.query("nodeLat");
    const nodeLonQ = c.req.query("nodeLon");
    let node: { lat: number; lon: number; city: string } | null = null;
    let nodeSource: "override" | "gps" | "ip" | "unresolved" = "unresolved";
    if (nodeLatQ && nodeLonQ && !Number.isNaN(Number(nodeLatQ)) && !Number.isNaN(Number(nodeLonQ))) {
      node = { lat: Number(nodeLatQ), lon: Number(nodeLonQ), city: "debug-override" };
      nodeSource = "override";
    } else if (lat !== null && lon !== null && !Number.isNaN(lat) && !Number.isNaN(lon)) {
      node = { lat, lon, city: "gps" };
      nodeSource = "gps";
    } else {
      const fwd = c.req.header("x-forwarded-for") || "";
      const ip = fwd.split(",")[0]?.trim() || "";
      const resolved = await resolveNodeFromIp(ip);
      if (resolved) {
        node = { lat: resolved.lat, lon: resolved.lon, city: resolved.city };
        nodeSource = "ip";
      }
    }
    const gpsTier = nodeSource === "gps" || nodeSource === "override";
    const visibilityKm = gpsTier ? GPS_VISIBILITY_KM : IP_VISIBILITY_KM;
    const broadcastKm = gpsTier ? GPS_LIDAR_BROADCAST_KM : IP_LIDAR_BROADCAST_KM;

    const lidarWorldIds = new Set(
      (db.query(`SELECT DISTINCT target_id FROM structures WHERE target_kind = 'world' AND type = 'lidar_tower'`).all() as any[]).map(
        (r) => r.target_id,
      ),
    );

    const worlds = db.query(`SELECT * FROM worlds ORDER BY created_at DESC`).all() as any[];
    const blockRows = db.query(`SELECT world_id, block_count, resolution, updated_at FROM world_blocks`).all() as any[];
    const blockMap = new Map(blockRows.map((r) => [r.world_id, r]));
    const enriched = worlds.map((w) => {
      const nodeDistanceKm = node ? haversineMeters(node.lat, node.lon, w.lat, w.lon) / 1000 : null;
      const hasLidar = lidarWorldIds.has(w.id);
      let visibleVia: "local" | "lidar_broadcast" | "unfiltered" = "unfiltered";
      let visible = true;
      if (nodeDistanceKm !== null) {
        if (nodeDistanceKm <= visibilityKm) {
          visible = true;
          visibleVia = "local";
        } else if (hasLidar && nodeDistanceKm <= broadcastKm) {
          visible = true;
          visibleVia = "lidar_broadcast";
        } else {
          visible = false;
        }
      }
      return {
        ...w,
        hasSavedBlocks: blockMap.has(w.id),
        savedBlockCount: blockMap.get(w.id)?.block_count ?? 0,
        savedResolution: blockMap.get(w.id)?.resolution ?? 0,
        hasLidarTower: hasLidar,
        nodeDistanceKm: nodeDistanceKm !== null ? Math.round(nodeDistanceKm * 1000) / 1000 : null,
        visibleVia,
        _visible: visible,
        distanceMeters:
          lat !== null && lon !== null && !Number.isNaN(lat) && !Number.isNaN(lon)
            ? Math.round(haversineMeters(lat, lon, w.lat, w.lon))
            : null,
      };
    });

    const visibleWorlds = enriched.filter((w) => w._visible).map(({ _visible, ...w }) => w);
    const hiddenCount = enriched.length - visibleWorlds.length;

    return c.json({
      ok: true,
      node: {
        source: nodeSource,
        city: node?.city ?? null,
        lat: node ? Math.round(node.lat * 100) / 100 : null,
        lon: node ? Math.round(node.lon * 100) / 100 : null,
        visibilityRadiusKm: visibilityKm,
        lidarBroadcastKm: broadcastKm,
        filtered: nodeSource !== "unresolved",
      },
      count: visibleWorlds.length,
      hiddenCount,
      worlds: visibleWorlds,
    });
  } finally {
    db.close();
  }
}
