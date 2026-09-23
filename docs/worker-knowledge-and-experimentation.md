# Worker Knowledge and Experimentation

## Settled rules

- Every worker may attempt small, safe experiments. Experienced workers may attempt larger bounded variations.
- Failure may waste time and some ordinary material, but it must not consume emergency reserves, destabilize occupied buildings, remove escape routes, or cause irreversible collapse.
- Knowledge is personal first. Workers pass it through joint work, observation, conversation, teaching, and eventually a settlement library.
- Workers establish a running inspected baseline before experimenting. A candidate is accepted only when its inspection score beats that baseline average; otherwise the last practiced version is restored.
- Inspection issues bias the next hypothesis: roof/weather failures favor roof moves, access failures favor entrance moves, room/foundation failures favor bounded dimensional moves, and incomplete execution favors simplification.
- The player teaches, demonstrates, critiques, builds alongside workers, and sets goals. The player supplies evidence and influence but cannot directly overwrite a worker's knowledge.
- A worker may hold an incorrect or unverified belief. Repeated inspection and direct experience can support or contradict it.
- Personal discoveries can disappear when a worker leaves or dies unless they were taught or codified.
- Experimentation does not wait for the player. Routine practice and bounded experiments may happen autonomously; future notifications and email summaries will report meaningful progress.

## Architecture

```text
world truth
  -> worker perception and personal beliefs
  -> bounded technique hypothesis
  -> safe construction attempt
  -> inspection and outcome record
  -> skill/confidence update
  -> compare candidate with the base technique's running average
  -> accept or reject variation
  -> conversation / observation / library
```

Knowledge has four distinct forms:

1. **Beliefs** — fallible claims with source, confidence, and inspection status.
2. **Skills** — practiced competence derived from outcomes.
3. **Techniques** — executable, bounded construction plans.
4. **Preferences** — personality-shaped appetite for novelty, caution, and teaching.

The deterministic simulation owns ordinary experimentation and evaluation. LLM use is reserved for rare reflection, interpretation, dialogue, and future summaries; it does not control movement, construction, or truth.

## First implementation slice

- Personal knowledge persists with each worker.
- Workers alternate a practiced baseline build with a valid construction variation, avoiding candidate-on-candidate drift.
- Construction inspection produces an outcome and updates skill/confidence.
- Inspection issues steer the next relevant hypothesis instead of selecting every move uniformly.
- Candidates that beat the base running average become practiced; candidates that do not restore the prior technique, even when both builds pass or both builds remain imperfect.
- Workers announce their hypothesis and comparative result in world-space speech; `knowledgeReport()` retains the exact move, targeted issue, baseline mean/sample count, score delta, and decision for diagnostics and future conversational recall.
- Nearby workers can pass their strongest practiced technique in conversation.
- Techniques with at least three strong inspected outcomes can be codified in the persistent settlement library.
- Player teaching enters as sourced, initially unverified evidence.

## Still deferred

- Joint-work and passive observation transfer rates distinct from conversation.
- Worker departure/death and explicit knowledge loss.
- Workshops/library buildings as physical access gates for teaching and codification.
- Offline semantic-event replay for routine practice.
- Rare LLM-assisted reflection and progress notifications/email summaries.
