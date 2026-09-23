import { makeRng, range, type Rng } from "./rng";
import type { Segment, Skeleton } from "./types";
import {
  add,
  normalize,
  rotateAroundAxis,
  scale,
  v,
  type Vec3,
} from "./vec";

// A stochastic bracketed 3D L-system. Species = ruleset + angles; the seed
// perturbs angles/lengths for per-instance variety while staying deterministic.
export interface LSystemGenome {
  kind: "lsystem";
  axiom: string;
  rules: Record<string, string>;
  angleDeg: number; // base turn angle
  step: number; // segment length at depth 0
  stepFalloff: number; // length multiplier per branch depth (<1 shrinks tips)
  baseRadius: number; // trunk radius at the root
  radiusFalloff: number; // radius multiplier per branch depth
  jitterDeg: number; // seed-driven angle jitter (organic wobble)
  // Azimuth roll applied to each successive branch off an axis (golden angle
  // 137.5° by default). Spirals whorls around the trunk so the canopy fills 3D
  // radially instead of fanning into one plane. Defaults to 137.5 when omitted.
  phyllotaxisDeg?: number;
}

const DEG = Math.PI / 180;

// Expand the axiom by applying rules `iterations` times.
export function expand(genome: LSystemGenome, iterations: number): string {
  let s = genome.axiom;
  for (let i = 0; i < iterations; i++) {
    let next = "";
    for (const ch of s) next += genome.rules[ch] ?? ch;
    s = next;
  }
  return s;
}

interface TurtleState {
  pos: Vec3;
  H: Vec3; // heading (forward)
  L: Vec3; // left
  U: Vec3; // up
  depth: number;
  branchCount: number; // branches opened off this axis so far (drives phyllotaxis roll)
}

// Interpret an expanded L-system string into branch segments.
// Symbols: F draw forward; +/- yaw; &/^ pitch; \//\\ roll; [ ] push/pop.
export function interpret(
  genome: LSystemGenome,
  expanded: string,
  rng: Rng,
  origin: Vec3 = v(0, 0, 0),
): Skeleton {
  const segments: Segment[] = [];
  const stack: TurtleState[] = [];
  let st: TurtleState = {
    pos: origin,
    H: v(0, 1, 0), // grow up +Y
    L: v(1, 0, 0),
    U: v(0, 0, 1),
    depth: 0,
    branchCount: 0,
  };
  let segId = 0;
  const baseAngle = genome.angleDeg * DEG;
  const jitter = genome.jitterDeg * DEG;
  const phyllo = (genome.phyllotaxisDeg ?? 137.5) * DEG;

  const turn = (axisGetter: () => Vec3, sign: number) => {
    const a = baseAngle * sign + range(rng, -jitter, jitter);
    const axis = axisGetter();
    st.H = normalize(rotateAroundAxis(st.H, axis, a));
    st.L = normalize(rotateAroundAxis(st.L, axis, a));
    st.U = normalize(rotateAroundAxis(st.U, axis, a));
  };

  for (const ch of expanded) {
    switch (ch) {
      case "F": {
        const stepLen = genome.step * Math.pow(genome.stepFalloff, st.depth);
        const rA = genome.baseRadius * Math.pow(genome.radiusFalloff, st.depth);
        const rB = genome.baseRadius * Math.pow(genome.radiusFalloff, st.depth + 0.5);
        const a = st.pos;
        const b = add(st.pos, scale(st.H, stepLen));
        segments.push({
          id: segId++,
          a,
          b,
          radiusA: Math.max(0.5, rA),
          radiusB: Math.max(0.4, rB),
          depth: st.depth,
          terminal: false, // resolved below
          kind: "branch",
        });
        st = { ...st, pos: b };
        break;
      }
      case "+":
        turn(() => st.U, +1);
        break;
      case "-":
        turn(() => st.U, -1);
        break;
      case "&":
        turn(() => st.L, +1);
        break;
      case "^":
        turn(() => st.L, -1);
        break;
      case "/":
        turn(() => st.H, +1);
        break;
      case "\\":
        turn(() => st.H, -1);
        break;
      case "[": {
        // Phyllotaxis: roll this branch's frame around the heading by an
        // accumulating golden angle so successive whorls spiral around the
        // trunk (fills 3D radially instead of fanning into one plane).
        const roll = phyllo * st.branchCount;
        stack.push({ ...st, branchCount: st.branchCount + 1 });
        st = {
          ...st,
          L: normalize(rotateAroundAxis(st.L, st.H, roll)),
          U: normalize(rotateAroundAxis(st.U, st.H, roll)),
          depth: st.depth + 1,
          branchCount: 0,
        };
        break;
      }
      case "]": {
        const popped = stack.pop();
        if (popped) st = popped;
        break;
      }
      default:
        break; // ignore non-turtle symbols
    }
  }

  // Mark terminals: a segment is a tip if no other segment starts where it ends.
  const starts = new Set(segments.map((s) => key(s.a)));
  for (const s of segments) {
    if (!starts.has(key(s.b))) s.terminal = true;
  }

  return { root: origin, segments };
}

const key = (p: Vec3) => `${p.x.toFixed(2)}|${p.y.toFixed(2)}|${p.z.toFixed(2)}`;

export function buildLSystem(
  genome: LSystemGenome,
  iterations: number,
  seed: number,
  origin?: Vec3,
): Skeleton {
  const rng = makeRng(seed);
  const expanded = expand(genome, iterations);
  return interpret(genome, expanded, rng, origin);
}
