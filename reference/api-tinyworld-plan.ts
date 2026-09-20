import type { Context } from "hono";

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";

const SYSTEM_PROMPT = `You are a TinyWorld architect AI. Given a worker's vision of the world, generate a simple building plan.

Primitive vocabulary:
- column {vx,vz,height,layer} — vertical stack, height 1-8
- wall {from:[vx,vz],to:[vx,vz],height,layer} — line of blocks
- floor {from:[vx,vz],to:[vx,vz],layer} — flat rectangular patch
- pile {vx,vz,radius,layer} — 1-high scattered pile

Rules:
- Only place on walkable cells (provided as (vx,vz) tuples)
- Do not exceed available resource counts
- height is block count from ground
- Prefer simple, aesthetic builds near landmarks
- 2-5 primitives max per plan
- Layer must be one of: grass, dryGrass, leaves, fruit, dirt, snow

Respond with JSON matching the plan schema.`;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short name for this build (2-4 words)" },
    rationale: { type: "string", description: "One sentence explaining why this plan fits the scene" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["column", "wall", "floor", "pile"] },
          vx: { type: "integer" },
          vz: { type: "integer" },
          height: { type: "integer", minimum: 1, maximum: 8 },
          layer: { type: "string", enum: ["grass", "dryGrass", "leaves", "fruit", "dirt", "snow"] },
          from: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
          to: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
          radius: { type: "integer", minimum: 1, maximum: 4 },
        },
        required: ["kind", "layer"],
      },
      minItems: 1,
      maxItems: 5,
    },
  },
  required: ["name", "rationale", "steps"],
};

export default async function handler(c: Context) {
  const apiKey = process.env.Gemini_API_key_v3 || process.env.Gemini_API_key_v2 || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ ok: false, error: "GEMINI_API_KEY not set" }, 500);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "JSON body required" }, 400);
  }

  const { vision } = body;
  const vx = typeof body?.vx === "number" ? body.vx : body?.worker?.vx;
  const vz = typeof body?.vz === "number" ? body.vz : body?.worker?.vz;
  if (typeof vx !== "number" || typeof vz !== "number") {
    return c.json({ ok: false, error: "vx and vz (numbers) are required" }, 400);
  }

  const resources = vision?.resources ?? {};
  const walkableCells = vision?.walkable ?? vision?.walkable_cells ?? [];
  const landmarks = vision?.landmarks ?? [];

  const userPrompt = `Worker at (${vx}, ${vz})

Available resources:
${Object.entries(resources)
  .map(([layer, count]) => `- ${layer}: ${count}`)
  .join("\n")}

Walkable cells (sample, max 50):
${JSON.stringify(walkableCells.slice(0, 50))}

Nearby landmarks:
${JSON.stringify(landmarks.slice(0, 10))}

Generate a simple building plan.`;

  const request = {
    contents: [
      { role: "user", parts: [{ text: SYSTEM_PROMPT + "\n\n" + userPrompt }] },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: PLAN_SCHEMA,
      temperature: 0.7,
      maxOutputTokens: 512,
    },
  };

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Gemini API error:", res.status, text);
    return c.json({ ok: false, error: `Gemini API error (${res.status})` }, 502);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    return c.json({ ok: false, error: "Empty Gemini response" }, 502);
  }

  let plan: any;
  try {
    plan = JSON.parse(text);
  } catch {
    console.error("Failed to parse Gemini JSON:", text);
    return c.json({ ok: false, error: "Invalid JSON from Gemini" }, 502);
  }

  // Basic validation
  if (!plan.name || !plan.rationale || !Array.isArray(plan.steps)) {
    return c.json({ ok: false, error: "Plan missing required fields" }, 502);
  }

  return c.json({ ok: true, plan });
}
