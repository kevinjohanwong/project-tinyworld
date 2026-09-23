import type { ConstructionKind, ConstructionTechnique } from "./tinyworld-construction";

export type KnowledgeConfidence = "guess" | "practiced" | "trusted";
export type BeliefRecord = {
  id: string;
  claim: string;
  confidence: number;
  status: "unverified" | "supported" | "contradicted";
  samples: number;
  source: "self" | "observation" | "conversation" | "player" | "library";
  updatedMs: number;
};
export type SkillRecord = { level: number; samples: number; successes: number; updatedMs: number };
export type TechniqueOutcome = {
  id: string;
  kind: ConstructionKind;
  techniqueId: string;
  score: number;
  issues: string[];
  experimentId?: string;
  experiment?: {
    move: ExperimentMove;
    targetedIssue?: string;
    baselineMean: number;
    baselineSamples: number;
    delta: number;
    accepted: boolean;
  };
  completedMs: number;
};
export type ExperimentMove = "door" | "roof" | "bay" | "width" | "depth" | "height" | "detail" | "simplify";
export type TechniqueExperiment = {
  id: string;
  kind: ConstructionKind;
  scale: "small" | "experienced";
  hypothesis: string;
  move: ExperimentMove;
  targetedIssue?: string;
  base: ConstructionTechnique;
  candidate: ConstructionTechnique;
  status: "planned" | "testing" | "accepted" | "rejected";
  createdMs: number;
};
export type LessonRecord = { id: string; claim: string; sourceWorker?: string; source: "player" | "conversation" | "observation" | "library"; adopted: boolean; createdMs: number };
export type WorkerKnowledge = {
  version: 1;
  beliefs: Record<string, BeliefRecord>;
  skills: Record<string, SkillRecord>;
  preferences: { novelty: number; caution: number; teaching: number };
  outcomes: TechniqueOutcome[];
  lessons: LessonRecord[];
  pendingExperiment?: TechniqueExperiment;
  lastExperimentMs: number;
  lastTeachMs: number;
};
export type LibraryTechnique = { kind: ConstructionKind; technique: ConstructionTechnique; score: number; samples: number; authors: string[]; updatedMs: number };
export type KnowledgeLibrary = { version: 1; techniques: Partial<Record<ConstructionKind, LibraryTechnique>>; records: Array<{ id: string; text: string; author: string; createdMs: number }> };

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
const cloneTechnique = (t: ConstructionTechnique): ConstructionTechnique => ({ ...t, moves: [...(t.moves || [])], corrections: [...(t.corrections || [])] });
const techniqueShape = (t: ConstructionTechnique) => JSON.stringify([t.width, t.depth, t.wallHeight, t.doorSide, t.roof, t.bays, t.floors, t.moves]);

function issueMoves(issue: string, scale: TechniqueExperiment["scale"]): ExperimentMove[] {
  const s = issue.toLowerCase();
  if (/roof|weather|leak|rain/.test(s)) return ["roof"];
  if (/door|entrance|access|navigable/.test(s)) return ["door"];
  if (/hollow|room|interior|space/.test(s)) return scale === "experienced" ? ["width", "depth", "height"] : ["bay"];
  if (/foundation|support|unstable/.test(s)) return scale === "experienced" ? ["width", "depth"] : ["bay"];
  if (/missing|unfinished|incomplete/.test(s)) return ["simplify"];
  return [];
}

function applyMove(candidate: ConstructionTechnique, move: ExperimentMove, n: number): string {
  if (move === "door") { candidate.doorSide = ((candidate.doorSide + 1) % 4) as 0 | 1 | 2 | 3; return "turning the entrance may improve access"; }
  if (move === "roof") { candidate.roof = candidate.roof === "gable" ? "stepped" : "gable"; return "a different supported roof may weather better"; }
  if (move === "bay") { const v = candidate.bays || 2; candidate.bays = v <= 2 ? 3 : v >= 5 ? 4 : v + (n & 1 ? 1 : -1); return "a different bay rhythm may improve openings"; }
  if (move === "width") { candidate.width += candidate.width <= 5 ? 2 : candidate.width >= 15 ? -2 : (n & 1 ? 2 : -2); return "changing the width may improve usable space"; }
  if (move === "depth") { candidate.depth += candidate.depth <= 5 ? 2 : candidate.depth >= 17 ? -2 : (n & 1 ? 2 : -2); return "changing the depth may improve usable space"; }
  if (move === "height") { candidate.wallHeight += candidate.wallHeight <= 4 ? 1 : candidate.wallHeight >= 18 ? -1 : (n & 1 ? 1 : -1); return "a small height change may improve enclosure"; }
  if (move === "simplify") {
    if (candidate.moves?.length) candidate.moves = candidate.moves.slice(0, -1);
    else candidate.bays = Math.max(2, (candidate.bays || 3) - 1);
    return "a simpler plan may be easier to finish reliably";
  }
  const options: NonNullable<ConstructionTechnique["moves"]> = ["stoop", "entrance-frame", "chimney", "lantern"];
  const add = options.find((x, i) => !candidate.moves?.includes(x) && i >= n % options.length) || options.find((x) => !candidate.moves?.includes(x));
  if (add) candidate.moves = [...new Set([...(candidate.moves || []), add])].slice(0, 3);
  return "an attached detail may improve use without risking the core";
}

export function createKnowledgeLibrary(saved?: any): KnowledgeLibrary {
  return {
    version: 1,
    techniques: saved?.techniques && typeof saved.techniques === "object" ? saved.techniques : {},
    records: Array.isArray(saved?.records) ? saved.records.slice(-64) : [],
  };
}

export function createWorkerKnowledge(id: string, traits: { ei: number; sn: number; tf: number; jp: number }, saved?: any): WorkerKnowledge {
  if (saved?.version === 1) {
    return {
      version: 1,
      beliefs: saved.beliefs && typeof saved.beliefs === "object" ? saved.beliefs : {},
      skills: saved.skills && typeof saved.skills === "object" ? saved.skills : {},
      preferences: saved.preferences || { novelty: clamp01((1 - traits.sn) / 2), caution: clamp01((1 + traits.jp) / 2), teaching: clamp01((1 + traits.ei) / 2) },
      outcomes: Array.isArray(saved.outcomes) ? saved.outcomes.slice(-32) : [],
      lessons: Array.isArray(saved.lessons) ? saved.lessons.slice(-24) : [],
      pendingExperiment: saved.pendingExperiment,
      lastExperimentMs: Number(saved.lastExperimentMs) || 0,
      lastTeachMs: Number(saved.lastTeachMs) || 0,
    };
  }
  return {
    version: 1,
    beliefs: {},
    skills: {},
    preferences: { novelty: clamp01((1 - traits.sn) / 2), caution: clamp01((1 + traits.jp) / 2), teaching: clamp01((1 + traits.ei) / 2) },
    outcomes: [], lessons: [], lastExperimentMs: 0, lastTeachMs: 0,
  };
}

export function confidenceBand(confidence: number): KnowledgeConfidence {
  return confidence >= 0.78 ? "trusted" : confidence >= 0.42 ? "practiced" : "guess";
}

export function planTechniqueExperiment(args: { workerId: string; tier: number; knowledge: WorkerKnowledge; technique: ConstructionTechnique; now: number; worldActive: boolean }): TechniqueExperiment | null {
  const { workerId, tier, knowledge, technique, now, worldActive } = args;
  if (!worldActive || knowledge.pendingExperiment) return null;
  const completed = knowledge.outcomes.length;
  const baseOutcomes = knowledge.outcomes.filter((o) => o.kind === technique.kind && o.techniqueId === technique.id);
  if (!baseOutcomes.length || knowledge.outcomes.at(-1)?.experimentId) return null;
  const scale: TechniqueExperiment["scale"] = tier >= 3 && completed >= 2 ? "experienced" : "small";
  const n = hash(`${workerId}:${technique.kind}:${completed}:${technique.revision}`);
  const allowed: ExperimentMove[] = scale === "experienced" ? ["door", "roof", "bay", "width", "depth", "height", "detail", "simplify"] : ["door", "roof", "bay", "simplify"];
  const recentIssues = knowledge.outcomes.filter((o) => o.kind === technique.kind).slice(-6).flatMap((o) => o.issues);
  const biased = recentIssues.map((issue) => ({ issue, moves: issueMoves(issue, scale).filter((m) => allowed.includes(m)) })).filter((x) => x.moves.length);
  const targeted = biased.length ? biased[n % biased.length] : undefined;
  const preferred = targeted?.moves[n % targeted.moves.length] || allowed[n % allowed.length];
  const order = [preferred, ...allowed.filter((m) => m !== preferred)];
  let move = preferred;
  let hypothesis = "a small variation may improve the next build";
  let candidate = cloneTechnique(technique);
  for (let i = 0; i < order.length; i++) {
    const trial = cloneTechnique(technique);
    const trialHypothesis = applyMove(trial, order[i], n + i);
    if (techniqueShape(trial) === techniqueShape(technique)) continue;
    candidate = trial;
    move = order[i];
    hypothesis = trialHypothesis;
    break;
  }
  candidate.id = `${technique.kind}-experiment-${workerId}-${completed + 1}`;
  candidate.revision = Math.max(technique.revision + 1, 3);
  candidate.successes = 0;
  const experiment: TechniqueExperiment = { id: `xp-${hash(`${workerId}:${now}:${candidate.id}`).toString(36)}`, kind: technique.kind, scale, hypothesis, move, targetedIssue: targeted?.issue, base: cloneTechnique(technique), candidate, status: "planned", createdMs: now };
  knowledge.pendingExperiment = experiment;
  knowledge.lastExperimentMs = now;
  knowledge.beliefs[experiment.id] = { id: experiment.id, claim: hypothesis, confidence: 0.28, status: "unverified", samples: 0, source: "self", updatedMs: now };
  return experiment;
}

export function recordTechniqueOutcome(args: { workerId: string; knowledge: WorkerKnowledge; technique: ConstructionTechnique; kind: ConstructionKind; score: number; issues: string[]; now: number }): { technique: ConstructionTechnique; outcome: TechniqueOutcome; experimentResolved: boolean } {
  const { workerId, knowledge, technique, kind, score, issues, now } = args;
  const pending = knowledge.pendingExperiment?.kind === kind ? knowledge.pendingExperiment : undefined;
  const baseline = pending ? knowledge.outcomes.filter((o) => o.kind === kind && o.techniqueId === pending.base.id) : [];
  const baselineMean = baseline.length ? baseline.reduce((sum, o) => sum + o.score, 0) / baseline.length : 1;
  const accepted = !!pending && score > baselineMean + 0.0001;
  const outcome: TechniqueOutcome = {
    id: `out-${hash(`${workerId}:${kind}:${now}`).toString(36)}`, kind, techniqueId: technique.id, score, issues: issues.slice(0, 8), experimentId: pending?.id,
    experiment: pending ? { move: pending.move || "detail", targetedIssue: pending.targetedIssue, baselineMean, baselineSamples: baseline.length, delta: score - baselineMean, accepted } : undefined,
    completedMs: now,
  };
  knowledge.outcomes.push(outcome);
  knowledge.outcomes = knowledge.outcomes.slice(-32);
  const skillKey = `construction:${kind}`;
  const skill = knowledge.skills[skillKey] || { level: 0.2, samples: 0, successes: 0, updatedMs: now };
  skill.samples += 1;
  if (score >= 0.9) skill.successes += 1;
  skill.level = clamp01((skill.level * (skill.samples - 1) + score) / skill.samples);
  skill.updatedMs = now;
  knowledge.skills[skillKey] = skill;
  if (!pending) return { technique, outcome, experimentResolved: false };
  const belief = knowledge.beliefs[pending.id];
  if (belief) {
    belief.samples += 1;
    belief.confidence = clamp01(0.45 + Math.abs(score - baselineMean) * 1.5);
    belief.status = accepted ? "supported" : "contradicted";
    belief.updatedMs = now;
  }
  pending.status = accepted ? "accepted" : "rejected";
  knowledge.pendingExperiment = undefined;
  return { technique: accepted ? cloneTechnique(pending.candidate) : cloneTechnique(pending.base), outcome, experimentResolved: true };
}

export function receiveLesson(args: { knowledge: WorkerKnowledge; claim: string; source: LessonRecord["source"]; now: number; sourceWorker?: string; demonstratedTechnique?: ConstructionTechnique }): { adopted: boolean; technique?: ConstructionTechnique } {
  const { knowledge, claim, source, now, sourceWorker, demonstratedTechnique } = args;
  const prior = Object.values(knowledge.beliefs).find((b) => b.claim === claim);
  const sourceWeight = source === "player" ? 0.62 : source === "library" ? 0.7 : source === "observation" ? 0.52 : 0.46;
  const adopted = !prior || prior.confidence < sourceWeight + knowledge.preferences.novelty * 0.15;
  const id = `lesson-${hash(`${claim}:${source}:${sourceWorker || ""}`).toString(36)}`;
  knowledge.lessons.push({ id, claim: claim.slice(0, 160), source, sourceWorker, adopted, createdMs: now });
  knowledge.lessons = knowledge.lessons.slice(-24);
  if (adopted) knowledge.beliefs[id] = { id, claim: claim.slice(0, 160), confidence: sourceWeight, status: "unverified", samples: 0, source: source === "conversation" ? "conversation" : source, updatedMs: now };
  return { adopted, technique: adopted && demonstratedTechnique ? cloneTechnique(demonstratedTechnique) : undefined };
}

export function teachBestTechnique(args: { teacherId: string; teacher: WorkerKnowledge; learner: WorkerKnowledge; techniques: Record<string, ConstructionTechnique>; now: number }): { kind: ConstructionKind; technique: ConstructionTechnique } | null {
  const ranked = Object.entries(args.teacher.skills).filter(([k, v]) => k.startsWith("construction:") && v.samples > 0).sort((a, b) => b[1].level - a[1].level);
  if (!ranked.length) return null;
  const kind = ranked[0][0].split(":")[1] as ConstructionKind;
  const technique = args.techniques[kind];
  if (!technique) return null;
  const lesson = receiveLesson({ knowledge: args.learner, claim: `${kind} technique demonstrated by ${args.teacherId}`, source: "conversation", sourceWorker: args.teacherId, demonstratedTechnique: technique, now: args.now });
  args.teacher.lastTeachMs = args.now;
  args.learner.lastTeachMs = args.now;
  return lesson.adopted && lesson.technique ? { kind, technique: lesson.technique } : null;
}

export function codifyTechnique(library: KnowledgeLibrary, workerId: string, knowledge: WorkerKnowledge, technique: ConstructionTechnique, now: number): boolean {
  const skill = knowledge.skills[`construction:${technique.kind}`];
  if (!skill || skill.samples < 3 || skill.level < 0.9) return false;
  const current = library.techniques[technique.kind];
  if (current && current.score >= skill.level && current.samples >= skill.samples) return false;
  library.techniques[technique.kind] = { kind: technique.kind, technique: cloneTechnique(technique), score: skill.level, samples: skill.samples, authors: [...new Set([...(current?.authors || []), workerId])], updatedMs: now };
  library.records.push({ id: `lib-${hash(`${workerId}:${technique.kind}:${now}`).toString(36)}`, text: `${workerId} recorded a practiced ${technique.kind} technique`, author: workerId, createdMs: now });
  library.records = library.records.slice(-64);
  return true;
}
