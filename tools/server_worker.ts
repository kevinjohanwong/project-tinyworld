import { Database } from "bun:sqlite";

const DB_PATH = "/home/workspace/project-tinyworld/data/tinyworld.db";
const PLAN_API_URL = "https://kj.zo.space/api/tinyworld-plan";

const LAYERS = [
  "grass",
  "dryGrass",
  "leaves",
  "fruit",
  "dirt",
  "snow",
  "stone",
  "wall",
  "water",
  "trunks",
  "planks",
];

// --- Base64 Helpers ---

function encodeBase64Bytes(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64Bytes(text: string) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function deserializeLayer(value: any) {
  if (typeof value === "string") {
    const bytes = decodeBase64Bytes(value);
    const length = Math.floor(bytes.byteLength / 4);
    return new Int32Array(bytes.buffer, 0, length);
  }
  return new Int32Array(0);
}

function serializeLayer(layer: Int32Array) {
  return encodeBase64Bytes(
    new Uint8Array(
      layer.buffer.slice(layer.byteOffset, layer.byteOffset + layer.byteLength)
    )
  );
}

// --- Logic ---

async function tick() {
  console.log(`[${new Date().toISOString()}] Starting worker tick...`);
  const db = new Database(DB_PATH);

  try {
    // 1. Get all workers
    const workers = db.query("SELECT * FROM workers").all() as any[];
    console.log(`Found ${workers.length} workers.`);

    // If no workers, spawn one for each world
    if (workers.length === 0) {
      const worlds = db.query("SELECT id FROM worlds").all() as any[];
      for (const world of worlds) {
        const id = `worker-${Math.random().toString(36).slice(2, 7)}`;
        db.run(
          "INSERT INTO workers (id, world_id, vx, vy, vz, last_tick, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, world.id, 0, 10, 0, Date.now(), Date.now()]
        );
        console.log(`Spawned ${id} in world ${world.id}`);
      }
      return;
    }

    for (const worker of workers) {
      await processWorker(db, worker);
    }
  } catch (err) {
    console.error("Tick failed:", err);
  } finally {
    db.close();
  }
}

async function processWorker(db: Database, worker: any) {
  console.log(`Processing ${worker.id} (World: ${worker.world_id})...`);

  // Load world blocks
  const worldBlockRow = db
    .query("SELECT payload FROM world_blocks WHERE world_id = ?")
    .get(worker.world_id) as any;
  if (!worldBlockRow) {
    console.warn(`No blocks found for world ${worker.world_id}`);
    return;
  }

  const payload = JSON.parse(worldBlockRow.payload);
  const layers: Record<string, Int32Array> = {};
  for (const name of LAYERS) {
    if (payload.layers[name]) {
      layers[name] = deserializeLayer(payload.layers[name]);
    }
  }

  // Build ground map and voxel set for perception
  const voxelSet = new Set<string>();
  const groundMap = new Map<string, number>();

  for (const [name, arr] of Object.entries(layers)) {
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i];
      const y = arr[i + 1];
      const z = arr[i + 2];
      const key = `${x},${y},${z}`;
      voxelSet.add(key);
      const xz = `${x},${z}`;
      if (!groundMap.has(xz) || y > groundMap.get(xz)!) {
        groundMap.set(xz, y);
      }
    }
  }

  // Update current Y if needed
  const currentXZ = `${worker.vx},${worker.vz}`;
  const groundY = groundMap.get(currentXZ) ?? 0;
  if (worker.vy < groundY) {
    worker.vy = groundY;
  }

  // Parse inventory and plan
  const inventory = JSON.parse(worker.inventory || "[]");
  let plan = worker.plan ? JSON.parse(worker.plan) : null;

  // Decide if we need a new plan
  if (!plan || !plan.actions || plan.actions.length === 0) {
    console.log(`${worker.id} needs a new plan.`);
    plan = await fetchPlan(worker, layers, groundMap, inventory, db);
    if (!plan) return;
  }

  // Execute one action
  const action = plan.actions.shift();
  if (action) {
    console.log(`${worker.id} executing: ${action.action}`, action);
    await executeAction(db, worker, action, layers, voxelSet, groundMap, inventory, payload);
  }

  // Save worker state
  db.run(
    "UPDATE workers SET vx = ?, vy = ?, vz = ?, inventory = ?, plan = ?, last_tick = ? WHERE id = ?",
    [
      worker.vx,
      worker.vy,
      worker.vz,
      JSON.stringify(inventory),
      JSON.stringify(plan),
      Date.now(),
      worker.id,
    ]
  );
}

async function fetchPlan(worker: any, layers: any, groundMap: Map<string, number>, inventory: any[], db: Database) {
  // Perception for Gemini
  const resources: Record<string, number> = {};
  const range = 5;
  for (const [name, arr] of Object.entries(layers)) {
    let count = 0;
    const data = arr as Int32Array;
    for (let i = 0; i < data.length; i += 3) {
      const dx = Math.abs(data[i] - worker.vx);
      const dz = Math.abs(data[i + 2] - worker.vz);
      if (dx <= range && dz <= range) count++;
    }
    if (count > 0) resources[name] = count;
  }

  const walkable: number[][] = [];
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = worker.vx + dx;
      const z = worker.vz + dz;
      const xz = `${x},${z}`;
      if (groundMap.has(xz)) {
        walkable.push([x, z]);
      }
    }
  }

  const stockpile: Record<string, number> = {};
  for (const item of inventory) {
    stockpile[item] = (stockpile[item] || 0) + 1;
  }

  const structuresRaw = db.query("SELECT * FROM structures").all() as any[];
  const structures = structuresRaw.map(s => ({
    type: s.type,
    vx: s.vx ?? 0,
    vz: s.vz ?? 0,
    topY: s.topY ?? 0,
    layer: s.layer ?? "dirt"
  }));

  const vision = {
    resources,
    walkable,
    stockpile,
    structures,
  };

  try {
    const res = await fetch(PLAN_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worker: {
          name: worker.id,
          vx: worker.vx,
          vy: worker.vy,
          vz: worker.vz,
          goal: worker.goal,
          holding: inventory[0] || "Nothing",
        },
        vision,
      }),
    });

    if (!res.ok) {
      console.error(`Plan API error: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as any;
    return data.plan;
  } catch (err) {
    console.error("Failed to fetch plan:", err);
    return null;
  }
}

async function executeAction(
  db: Database,
  worker: any,
  action: any,
  layers: Record<string, Int32Array>,
  voxelSet: Set<string>,
  groundMap: Map<string, number>,
  inventory: any[],
  payload: any
) {
  switch (action.action) {
    case "MoveTo":
      const dx = Math.sign(action.vx - worker.vx);
      const dz = Math.sign(action.vz - worker.vz);
      worker.vx += dx;
      worker.vz += dz;
      const xz = `${worker.vx},${worker.vz}`;
      worker.vy = groundMap.get(xz) ?? worker.vy;
      break;

    case "PickUp":
      const layer = action.layer;
      if (layers[layer]) {
        const arr = layers[layer];
        let nearestIdx = -1;
        let minDist = Infinity;
        for (let i = 0; i < arr.length; i += 3) {
          const d = Math.abs(arr[i] - worker.vx) + Math.abs(arr[i + 2] - worker.vz);
          if (d < minDist) {
            minDist = d;
            nearestIdx = i;
          }
        }

        if (nearestIdx !== -1 && minDist < 3) {
          const x = arr[nearestIdx];
          const y = arr[nearestIdx + 1];
          const z = arr[nearestIdx + 2];
          const newArr = new Int32Array(arr.length - 3);
          newArr.set(arr.subarray(0, nearestIdx));
          newArr.set(arr.subarray(nearestIdx + 3), nearestIdx);
          layers[layer] = newArr;
          voxelSet.delete(`${x},${y},${z}`);
          inventory.push(layer);
          console.log(`Picked up ${layer} at ${x},${y},${z}`);
          await saveWorld(db, worker.world_id, layers, payload);
        }
      }
      break;

    case "Place":
      const placeLayer = inventory.pop();
      if (placeLayer) {
        const px = action.vx ?? worker.vx;
        const pz = action.vz ?? worker.vz;
        const py = (groundMap.get(`${px},${pz}`) ?? 0) + 1;
        
        const arr = layers[placeLayer] || new Int32Array(0);
        const newArr = new Int32Array(arr.length + 3);
        newArr.set(arr);
        newArr[arr.length] = px;
        newArr[arr.length + 1] = py;
        newArr[arr.length + 2] = pz;
        layers[placeLayer] = newArr;
        
        console.log(`Placed ${placeLayer} at ${px},${py},${pz}`);
        await saveWorld(db, worker.world_id, layers, payload);
      }
      break;
    
    case "Mine":
      const mx = worker.vx;
      const mz = worker.vz;
      const my = worker.vy;
      
      for (const [name, arr] of Object.entries(layers)) {
        for (let i = 0; i < arr.length; i += 3) {
          if (arr[i] === mx && arr[i+1] === my && arr[i+2] === mz) {
            const newArr = new Int32Array(arr.length - 3);
            newArr.set(arr.subarray(0, i));
            newArr.set(arr.subarray(i + 3), i);
            layers[name] = newArr;
            worker.vy -= 1;
            console.log(`Mined ${name} at ${mx},${my},${mz}`);
            await saveWorld(db, worker.world_id, layers, payload);
            return;
          }
        }
      }
      break;
  }
}

async function saveWorld(db: Database, worldId: string, layers: Record<string, Int32Array>, payload: any) {
  for (const [name, arr] of Object.entries(layers)) {
    payload.layers[name] = serializeLayer(arr);
  }
  const json = JSON.stringify(payload);
  db.run("UPDATE world_blocks SET payload = ?, updated_at = ? WHERE world_id = ?", [json, Date.now(), worldId]);
}

// Run loop
const interval = 5000;
while (true) {
  await tick();
  await new Promise((r) => setTimeout(r, interval));
}
