# Void Motes, the Void Island & the Supermoon

**Status:** Spec v11 — KJ + Claude, 2026-07-06 (**v11: glow matter as the world's counter-force (§4.1)** — all trees glow two-tier (weak groves / strong super-tree beacon, implemented on staging); glow matter attached to a void ship makes it blink, dissipate, and scatter its matter back into the world; bigger ships need more light. Opens #38–39. v10 and earlier: KJ + Claude, 2026-07-03 — v2 added KJ rulings: void island neighbor, one central supermoon, player clash/collaboration. v3 added: **sculpting — players create their own mechs from void substance**, §8. v4 added: **ownership = crew + claim locks** (§8.5), **ceremonies as semi-dynamic events** (§10), **bidirectional conversion — badly treated motes can defect** (#29). v5 resolved #32–34: **passing is tree-tied + can happen in void clashes**, **joyful ceremonies send invites**, **defection is real**. v6 added: **wrecks & groves — trees grow out of fallen mechs, or mechs can be retrieved** (§8.6). v7: **disturbing a grove is possible but makes some in the colony sad** (#36c). v8 adds: **mote memory — the second ledger** (§11). v9 resolved #37: **memories are conversation-only**. **v10: KJ ruled the entire remaining open-call board (2026-07-03)** — headline additions: real-time building as the player's raid-time hand (#2), worker-delivered raid forecasts (#9), the void hunts bridges (#11), day-visible moon + day attacks (#16), dark motes grow (#17) and must be stranded to convert (#18, no relapse #19, mote-only yield #20), chat steers the colony and attention grants comfort (#23), all-users-equal geo rules with bridge-bound sentinels (#14), every grove-tree is a grave + **all trees glow at night** (#36a). Only #36b — grove comfort aura — remains open.)
**Depends on:** `mass-and-density.md` (pressure law, un-grading, ships), `biome-nyc-temperate.md` (phases, archetypes), `worker-growth-mechs-and-food.md` (the loop being mirrored), the live Chunk 3 creatures + ledger in staging (`tw-staging-app.tsx`).
**Design pillar (KJ, 2026-07-02):** the whole game should feel like *everyone playing in a LEGO world* — building itself is the entertainment; high creativity, imagination, self-storytelling. The void must serve that pillar, not fight it.

## 1. Problem

Today's void is ambient decay. Chunk 3 wraiths erode weak edges in place: the block blips out, a HUD number ticks up, the ledger moves `WORLD → VOID`. Mechanically honest, dramatically empty — the player defends against an *invisible subtraction*. Towers grant "erosion suppression" against a force you can't see acting. Nothing about it produces a story you'd retell.

KJ's redesign: **void creatures are almost like the motes — they have their own gameplay loop.** They take blocks and *carry them away* — back to a void ship, which ferries them to a **void island that neighbors every world**. The void stops being weather and becomes a rival colony living next door.

## 2. The Mirror

One mental model, opposite sign. Players already understand the worker loop; the void reuses its verbs:

| Verb | Worker mote | Void mote |
|---|---|---|
| Spawn | dawn arrival at world edge | disembarks from a landed void ship at night |
| Target | chore queue (harvest, build) | weakest exposed face (pressure law picks it) |
| Act | harvest block → carry | **pry** block loose → carry |
| Deposit | visible stockpile | ship's hold |
| Home | hut (shelter, warmth) | the **void island** next door |
| Long-term | builds the settlement | builds the void island → feeds the **supermoon** |

The conservation ledger already speaks this language: `WORLD → VOID` is kind `remove`, `VOID → WORLD` is kind `grow` (tw-staging-app.tsx:343). Nothing new is minted — the void pool just becomes *visible matter in enemy hands* instead of an abstract number.

## 3. Void Mote Loop

1. **Disembark** — motes exit the landed ship (§4). Count scales with phase (active: 2–3, aggressive: 4–6), capped like today's creatures.
2. **Target** — walk to the lowest-protection exposed face within range, exactly what the pressure field already computes. Beamed faces (tower coverage) are never targeted — the beam *deters* rather than abstractly "suppresses." **Rare tiers hunt value (resolved #4):** common motes stay strictly lawful under the pressure law; rare archetypes (Concrete Null tier) covet fruit, pure grades, and cores — and may strike at **settlements** themselves, prying blocks out of BUILT structures (KJ: "maybe try to destroy settlements" — encoded as theft from buildings under the same pry law; nothing deleted, a dismantled hut is a recoverable loss, not an erasure).
3. **Pry** — a visible, interruptible timer on the block. Duration scales with **density** ("density is what the void sees" — already the law): leaves come loose in ~2s, stone takes ~10s, a core is a multi-night siege target only for rare archetypes (resolved #4: rare tiers only). Ledger fires at pry completion: `WORLD → VOID`, source `void_pry`.
4. **Carry** — the stolen block renders overhead, worker-style. Carriers are slow (loaded pace), and they **walk (resolved #10: "walk first — then get on ship and fly")** — loaded carriers path along walkable ground exactly like workers, chaseable the whole way; flight belongs to the ship alone. This is the drama window: a visible thief with your property, walking away.
5. **Deliver** — block enters the ship's hold (hold contents visible through the hull — the night's losses are countable at a glance).
6. **Repeat** until dawn or the hold is full.

**Interception:** a carrier that is knocked down (worker/mech contact, purge sweep — never a direct player tap; resolved #2: colony-only) **drops the block where it stands**: `VOID → WORLD`, kind `grow`, intact grade. Recovery before liftoff = full refund. This replaces "damage mitigation" with a physical chase.

**The player's live hand is building (resolved #2: "no for now — can build in real time though").** No arcade tap-to-drop verb; the purge stays the player's one active defense. But building is never locked during a raid — walls, mass, and towers can be placed mid-raid to wall off a carrier's path or reshape the pressure field in real time. The player's moment-to-moment agency *is* the LEGO verb.

**Dawn (resolved #7: drop and flee):** surviving carriers drop anything mid-carry where they stand and flee to the ship empty-handed — dawn is a recovery sweep across the yard, the gentlest reading.

## 4. The Void Ship

- **Arrival:** at the start of the active phase (20:00 local), a ship crosses from the void island and descends to the lowest-protection perimeter cell **outside all tower beams**. Towers therefore shape void geography — a well-placed tower doesn't reduce a decay stat, it visibly forces landings to the far side of the island.
- **Hold = the night's theft budget.** Phase and season multipliers (biome doc) modulate hold size and mote count instead of an abstract eat rate. A hard cap keeps bad nights survivable.
- **Liftoff:** at dawn, or when the hold fills, the ship rises and flies home to the void island — a deliberate, watchable departure. This is the emotional beat of the night cycle: you see exactly what left, and you can see where it went.
- **v1 is not combat:** the ship itself can't be destroyed. The purge sweep (already live) expels motes and forces an early, half-empty liftoff — the existing tool gets a visible payoff.
- **Quiet nights (resolved #9: protection-gated):** if perimeter protection everywhere exceeds a threshold, no ship comes. Defense earns silence, and silence is *readable* — no ship crossing the gap means you won the night.
- **Raid forecast (KJ, new with #9):** when the player enters the world, workers **tell them when the raid might happen** — "a ship will likely land at the NE shore tonight" — computed from the same protection map the ship's landing logic uses. The forecast is diegetic (workers speak it via §6.3, accuracy scaling with tier), never a HUD widget. Entering your world starts with your colony briefing you.
- **Night is chapter 1's rhythm:** island ships fly only at night. Once the supermoon escalation begins, attacks can also come **by day** (resolved #16) — daylight safety is a chapter-1 privilege, not a law of the world.

### 4.1 Light as a Weapon — Glow Matter vs the Void Ship

**KJ ruling (2026-07-06): glow matter is the world's counter-force to the void, and attaching it to a void ship is how the ship comes down.** This is the mechanical spine of KJ's framing — *"these trees and this glowing is exactly what pushed back against the void."* Light is the **world pole**; the void is its opposite. Trees are how the world makes light.

- **Trees are the font of glow matter (KJ ruling, implemented on staging 2026-07-06).** Every tree glows at night, but two-tier: **regular groves glow very weak**, the **hero super tree is a strong beacon**. The super tree is the world's brightest light source and therefore its strategic keystone — protecting the beacon is protecting the world's ability to fight back. (This is the §8.6 "all trees glow at night" ruling given a mechanical payload: the glow is not only memorial atmosphere, it is a *resource signal*.)
- **The mechanic:** when **glow matter is attached to a void ship, the ship blinks, dissipates, and scatters its matter.** A ship carrying light destabilizes — the held blocks it was ferrying scatter back into the world rather than reaching the island (`VOID → WORLD`, kind `grow` — the night's theft recovered by light, not by force). Light doesn't *destroy* the ship's cargo; it *releases* it. Fully in keeping with the LEGO pillar: the world's answer to erasure is illumination, and nothing is deleted — matter is scattered back, recoverable.
- **Scaling by ship mass (KJ ruling): a bigger void ship requires more light material attached.** Ties directly into the mass law — a ship's hold/size *is* its mass, so the glow matter needed to bring it down scales with that mass. Small chapter-1 ships fall to a modest amount of light; the bigger, slower supermoon ships (#12) demand a proportionally larger light payload — likely more than one weak grove can supply, which is *why* the super-tree beacon (and cultivating many glowing trees) matters.
- **Revises §4's "v1 is not combat."** The ship still has no health bar and takes no arcade tap — but "can't be destroyed" was the v1 placeholder. The light path is the sanctioned, non-violent way to neutralize a ship: you don't attack it, you *illuminate* it. Consistent with the two-hands rule (§6.3: the player's hands are build + converse, never a weapon) — glow matter is a build/logistics act, not a strike.

**Open (proposals, KJ to steer):** how glow matter is *harvested and carried* — proposal: it accrues in glowing canopies over the night and workers gather it like blocks (a light-harvest chore), then a worker/mech carries it to affix it to a landed ship (mirrors the void mote's pry→carry→deliver, signed positive). Whether attaching is a worker act, a mech verb, or a tower beam focused on the ship. And whether the super tree must be *grown/earned* to unlock ship-scale light (making the beacon a progression gate). These are §15 open calls #38–39.

## 5. The Void Island — Chapter 1

**KJ ruling: every world has a mini void island as a neighbor.** It sits in the unscanned void gap just off the world's perimeter — the multi-world placement system already treats the space between scanned worlds as void at true metric offsets; the island occupies that gap, visible from your shore.

- **It is the per-world VOID pool, made walkable-distance visible.** Everything stolen accretes onto the island in its original materials. The invariant holds exactly: `WORLD + STOCKPILE + BUILT + VOID(island) === baseline`. The HUD's void number and the island's silhouette are the same fact — a neglected world watches its island *grow in its own colors*. **Resolved #5: visible from far away** — the island reads from anywhere in the world, not just the near shore; the loss is ambiently visible at all times.
- **It is the first major chapter.** The near-term goal arc: build protection → survive nights → reach the island (bridge or early raft — **resolved #11: either is valid, but the void will try to destroy bridges** — a standing structure across the gap is a standing provocation, and defending your bridge becomes part of holding the route open) → **raid and destroy it**, reclaiming your matter (`VOID → WORLD`, kind `grow`; grade per the un-grading clock, §7).
- **Escape and escalation (KJ ruling):** destroying the island doesn't end the void — its motes *escape*, a fleeing ship rising toward the **supermoon**, and the void **escalates**: chapter 2+ pressure arrives from the supermoon instead. **Resolved #12: bigger, slower moon ships** — larger holds on a longer cadence — **maybe followed by new islands**: the void can re-colonize the gap and seed a fresh island, making chapters cyclical rather than one-and-done. Breaking the island is a real victory that raises the stakes, not a cleanup task.
- **Void architecture (resolved #6: a mix):** the island shouldn't be a scrap heap — part **void-world architecture** (the void's own crooked, ordered forms, its "only ordered things") and part **recognizable normal-island structures**: chunks of your world, rebuilt wrong in your own materials. The alien and the stolen-familiar side by side is the storytelling payload, and it's just placement logic.

## 6. Dark Motes — Population Reflection & Conversion

**KJ ruling:** dark motes **reflect the growing population base** of real motes, and they **can be converted over** — conversion is "the more permanent way of peace and stabilization."

### 6.1 Reflection

The void's local force is not a fixed spawn table — it mirrors your colony. Dark mote allotment ≈ `f(real mote population) − converted count`. Consequences:

- **Difficulty auto-scales.** A three-mote hamlet faces one shy thief; a thriving colony casts a proportional shadow. Expansion *creates its own opposition* — growth is never free, which keeps the terrarium honest.
- **Extermination can't win.** Knock-downs and purges are stopgaps: the reflection refills the void's ranks as long as your population keeps growing. War manages the symptom.
- **Conversion is the only permanent subtraction.** Each converted dark mote permanently reduces the void's allotment. Peace arrives when conversions keep pace with population growth — meaning peace is a *practice you maintain*, not a checkbox you tick. Stop converting while you grow, and the shadow returns.
- **Individuals grow too (resolved #17: "dark motes also grow").** Beyond the population reflection, individual dark motes tier up by consuming stolen matter — the worker growth ladder with theft as food. Higher tiers pry denser blocks and **crew void mechs** under the same crew-points law (§7). And because tier carries over, a converted Elder-dark is a colony treasure — the void's growth economy feeds the value of the peace path.

### 6.2 Conversion (resolved #18–20)

- **A dark mote must be stranded first (resolved #18).** Conversion never begins mid-raid — the raid is the raid. It starts only when a dark mote misses the liftoff and dawn catches it in your world. The stranded stranger, cared for instead of purged, is the whole story shape. (Nights-to-convert: tuning knob, not a design question.)
- **The tools of conversion are the systems you already have:** food, shelter, warmth, comfort. A stranded dark mote that is fed instead of chased, or that shelters through a dawn in a high-comfort hut, accrues conversion progress. The same comfort math that grows your motes (warmth shell, meal regularity, MBTI compat, beam light) redeems theirs. You convert the thing that steals your food *by feeding it* — the LEGO pillar's kindness made mechanical.
- **Visual: conversion is eyes opening (resolved #8: "eyeless. at first").** Worker motes have eyes; dark motes are born eyeless — and *at first* is the whole design: as a dark mote converts, its eyes gradually appear. The visual delta between dark and light IS the progress bar. No new UI. (Empathy calibration closed: they become sympathetic exactly as redemption becomes possible.)
- **No relapse (resolved #19).** A converted mote never turns back — permanence is the point of the peace path. (Defection of *your* motes, #29, is a different law: neglect converts out; conversion in is forever.)
- **The mote is the entire yield (resolved #20: "mote only").** Conversion returns no substance mass to the ledger — the `convert` event carries a colonist, not matter. What you gain is a *who*, not a *what*.
- **Converted motes keep a gift:** they are nocturnal by origin — a converted mote can work the night shift, the one thing no natural mote does. Mechanically precious, thematically earned, and it makes each conversion a visible, named addition to the colony rather than a stat change.
- **Lore weight:** dark motes are made of void substance — conversion is the **only process in the game that reverses assimilation**. Machines can't refine void substance back into meaning; only a relationship can. (This holds under the resolved #15: void substance is a sculpting medium, never an industrial one — it stays inert to refinement.)

### 6.3 High-Intelligence Motes & Dialogue

**KJ ruling:** motes are **high-intelligence**, and users can **talk to them** (maybe). This spans both colonies — it's the deepest expression of the self-storytelling pillar, because the characters can tell you their side.

- **Speech scales with tier (proposed).** Speck: squeaks and gestures. Mote: two-word utterances. Puff: sentences. Elder: full conversation with memory. Intelligence becomes the *visible payoff of growth* — you raise an Elder partly to finally hear what it thinks. (Mirrors: dark motes speak in static/whispers that **clear as conversion progresses**, the audio twin of eyes opening.)
- **Grounded in lived events, not improv.** A mote's dialogue is generated from its actual history — its `block_events`, meals, housemates, night raids it survived, blocks it personally carried — plus its existing MBTI personality. Motes can only tell stories that really happened in your world. The player builds the world; the world writes the characters' material; the characters hand the stories back.
- **Conversation as conversion agency (proposed — answers #2 and #18 together).** The player's two hands stay non-violent: *purge* (defense) and *conversation* (peace). Talking to a stranded dark mote is how the player personally participates in conversion — workers handle food and shelter, but the player's attention is the catalyst.
- **Suggestions, never commands (resolved #21: as stated).** Players can ask and propose ("a tower on the hill would be nice"); motes weigh requests against personality and comfort — an agreeable mote obliges, a stubborn one has opinions. This keeps the colony autonomous (idle-game soul) and gives MBTI conversational teeth. No chat-RTS command console.
- **Chat is the steering channel, and attention feeds the loop (resolved #23: "yes it does").** Two rulings in one: (a) conversation is *also* **how the player gives workers commands and suggestions** — chat is the colony's steering wheel, though every request still passes through the #21 weighting (motes can refuse; "commands" are still suggestions to a character, not orders to a unit). (b) Talking to a mote **grants comfort** — attention is a real resource, for workers as well as dark motes. The chore-ification risk noted in the original call is accepted; blunting it (caps, diminishing returns per mote per day) is tuning, not design.
- **Implementation sketch:** the zo LLM path already exists (`/zo/ask`, used for scan Telegram pings). Per-mote context = identity card (name, tier, MBTI, comfort) + recent event log. Cost/latency control (resolved #22: yes — Elder only): free LLM dialogue is Elder-tier (rare, precious); lower tiers use slot-filled utterance templates from the same context.

### 6.4 Two paths, never forced

Destruction and conversion coexist as strategies, exactly like player clash-vs-collaboration (§9): raid the island and the survivors escalate to the supermoon; convert steadily and the local void *stabilizes*. The game never forces the peaceful path — it just makes it the only permanent one. The player's stance toward the void and toward other players is the same choice, governed by the same laws.

## 7. The Supermoon

**KJ ruling: one central supermoon for the whole world** — all players, all worlds. The void's collective hoard, and the far end of the escalation arc.

**Placement (KJ ruling): the supermoon sits at the exact center of the world-sphere.** The planes are reverse-curved — worlds live on the *inside* of the sphere, facing inward — so the center is the one point every world shares. Consequences that fall out of the geometry for free:

- **One shared sky.** Every player, from every world, looks up at the same supermoon. When anyone anywhere loses blocks to a ferry, *everyone's* moon grows. The state of the planetary war is ambient and communal — a doom-clock rendered in the sky.
- **"Up" belongs to the void.** Inward = toward the center = toward the void's capital. This retroactively explains the existing flight rules (flight burns mass into the void pool, flying ships are ×3 pressure beacons): leaving the ground means entering the void's domain. Bedrock-direction (outward) is safety; altitude is exposure.
- **Fair by construction.** Every world is equidistant from the center — ferry routes, escape flights, and raid distances are identical for all players. No spawn-location advantage in the endgame.
- **Visible traffic.** Ferries and raid fleets crossing the interior are potentially visible from other worlds — a neighbor's losses, or a collaborative raid forming up, seen as moving lights in the shared sky.

**Singular void substance (KJ ruling).** The supermoon is not a heap of stolen blocks — it is **one substance**. Matter that arrives is *assimilated*: identity, material, and grade are erased; only mass survives. This is un-grading taken to its limit, and it draws the line between the two void tiers sharply:

- **Island = your blocks, recoverable.** Recognizable materials, grades intact for as long as the matter sits there (resolved #3). Raiding the island returns *your* stuff.
- **Supermoon = void substance, converted.** Raiding the supermoon can never return your oak and stone — it yields **void substance** as a material (fully resolved #15: it is the sculpting medium, §8, and it is **dense** in the mass law — heavy to haul home, high pressure-resistance once sculpted; the expedition cost and the mech's armor are the same number).
- Ledger stays honest: assimilation is a `convert` event — mass in equals mass out, identity dropped. Nothing is deleted, but something *is* lost: form. The void's threat is not destruction, it's **erasure of meaning** — which is precisely the opposite of the LEGO pillar, and why it's the right antagonist.

**Global effect (KJ ruling: "it all effects").** Supermoon mass is a live planetary input: void aggression everywhere scales with the moon's size. A heavy moon means harder nights for every player — so collaborative raids are *planetary maintenance*, the strongest reason for strangers to cooperate with no rule forcing them. Curve shape: the sublinear / soft-cap proposal stands unchallenged (adopted, tunable) — a losing community faces pressure, never a death spiral.

**Moon visibility & day attacks (resolved #16).** The moon **is visible during the day** — a pale presence in the daytime sky, the war never fully out of view — and supermoon-tier forces **can also attack during the day**. Night keeps its monopoly on danger only in chapter 1 (island ships stay nocturnal, §4); once the escalation arc begins, daylight is no longer a promise. This also answers KJ's #9 question — raids are *not* always at night, past chapter 1.

**Void mechs (KJ ruling).** The void's escalation tier is mechanical: **mechs made of void substance, piloted by dark motes**. The mirror holds at every level — if crew-points gate player mechs, the same law gates theirs. Chapter 2+ nights can land a void mech instead of a foot crew: slower, prying dense blocks the motes can't, requiring the player's own mechs (not just towers) to answer.

- **Ferry deadline:** the void island has a hold capacity. When it overflows — or when its motes escape a destroyed island with whatever they can carry — a ferry departs for the supermoon. Matter that reaches the supermoon leaves the world's easy reach: raid your island *before the ferry* or the recovery becomes a late-game expedition. (Resolved #13: "this is ok" — the overflow mechanism stands as written; exact hold size / night count is a tuning knob.)
- **Ledger:** island → supermoon transfers are cross-world exports in `block_events`. Per-world VOID splits into `VOID_local` (island, raidable now) and `VOID_exported` (supermoon share). Global invariant: Σ every world's four pools + supermoon === Σ baselines. Nothing in the game ever deletes a block.
- **Un-grading (resolved #3: "un-grading only on moon"):** the void un-grades on the *supermoon*, never the island — island matter keeps its grade intact (an island raid is always full recovery), supermoon matter decays to raw. Urgency lives at the ferry deadline, not on the island itself.
- **Supermoon raids are the late game** — keel-core ships (mass-and-density §8), probably *collaborative* (multiple players' ships), the planetary war made legible: from the globe view, unscanned Earth IS the void, and the supermoon is its capital.

## 8. Sculpting — Player-Made Mechs

**KJ ruling (2026-07-03): sculpting is how players create their own mechs.** Void substance is the medium. The void represents pre-design — the player's answer is to mold it.

### 8.1 Why void substance is the only possible clay

- Every real block is grid-locked, material-typed, graded — *identity is the point* (the ledger tracks it). You can stack real blocks; you cannot shape them.
- Void substance is the game's one formless matter: identity erased, only mass survives (§7). Formlessness — the void's weapon — is exactly what makes it sculptable.
- **This completes the symmetry of the two reversals.** The supermoon erases *form and identity*. Conversion restores **identity** — a dark mote gets its eyes back (§6.2, the only process that reverses assimilation). Sculpting restores **form** — the player imposes shape and meaning on formless mass. The relationship path recovers the *who*; the craft path recovers the *what*. Neither returns your oak — but together they turn the void's own substance into the two most precious things in the game: a colonist, and a mech.
- §6.2's lore holds untouched: void substance stays industrially inert — it never refines back into stone or oak. Sculpting doesn't change what the substance *is*, only what it *means*. A sculpted mech is still void-dark: the player's mechs and the void's mechs are visibly kin, the mirror (§2) made flesh.

### 8.2 Sourcing the clay (late-game, deliberately)

- **Supermoon raids** (§7) — the primary yield; sculpting is *why* supermoon loot is worth the expedition.
- **Void-mech wreckage** — chapter 2+ void mechs knocked down collapse into substance where they fall.
- **Converted dark motes** — a converted high-tier mote may bring its mech across as a dowry (#31: clay + remembered design). Note the grain vs #20: *conversion itself* yields only the mote; the dowry is the separate mass of the mech it piloted, and #17 (dark motes grow) is what makes high-tier converts with mechs exist at all.
- **The island never yields substance** — island matter is your blocks in original materials, by definition (§7).
- **Ledger:** new pool `SUBSTANCE_held` (per-world). Capture is a cross-pool transfer (supermoon/wreck → held); sculpting is a *form* change, not a pool change. Nothing minted, ever.

### 8.3 Recognition, not blueprints

Same grain as towers (worker-growth §7: *"the player designs and builds towers freely — the game recognizes one, it never places one"*) and the shelter flood-fill. The player sculpts free-form; the game runs a **mech recognizer** over the result — the third structural recognizer.

A sculpture becomes a mech when it has functional organs:

- **Cockpit cavity** (≥1) — an enclosed hollow with a porthole; reuses the carved-cockpit porthole rendering. Cavity count = crew seats.
- **Locomotion contact** — legs / skids / hover base; the contact pattern sets gait.
- **Manipulators** (optional) — grip points; count sets carry/bundle capability.

Everything else is aesthetics — silhouette, ornament, asymmetry. Capability derives from mass + organs through *existing* law: mass sets armor and energy drain (density law), crew-points requirement scales with mass (same gate as stock mechs), manipulators set bundle size. Stock mechs (Drone/Sentinel/Titan) remain the fixed, earned designs; sculpted mechs are the open ceiling above them — a brilliant sculpt can out-perform a Titan. The LEGO pillar's promise applied to the endgame: **building is the power curve.**

**Degenerate sculpts (resolved #27: "valid but useless").** A cockpit-only statue passes the recognizer — it is a crewable mech that can do nothing, and that's fine; the recognizer stays permissive. The mass/density law self-balances min-maxing (a solid cube is all armor and no reach, no manipulators, brutal energy drain) — no explicit limb or proportion rules needed.

### 8.4 Who sculpts, and the corruption seed

- **Sculpting is an Elder-crewed mech capability** (prior KJ ruling: molding is tier-gated). It joins Hold and Reclaim as the fourth exclusive mech verb in worker-growth §5.1.
- **Corruption seed (resolved #26: yes):** *raw* held substance attracts void pressure — the void wants its formless matter back. A *finished* sculpted mech does not: form is a claim the void respects. Hoarding clay is dangerous; sculpting it is the resolution. Urgency to create, not stockpile. Magnitude included: a large raw stockpile acts as an **anti-tower**, actively drawing ship landings toward it.
- **Dialogue hook (§6.3):** high-intelligence dark motes recognize their own substance walking your world — sculpted mechs should provoke reactions in conversation. The void has an opinion about what you made of it.

### 8.5 Ownership — the crew is the key

**KJ question (2026-07-03): what is ownership, technically — are there keys?** Proposal: no deeds, no registry, no key items. Three diegetic locks, each falling out of law already on the books:

1. **Crew lock.** Only motes pilot — the player never drives directly (idle soul). An unmanned mech is inert sculpture. Frames belong to the colony's shared fleet, and mote-to-frame assignments are temporary: a familiar pilot may handle a frame better, but no mote owns or permanently binds it. "Stealing a mech" therefore means shipping dead mass home under the same pry/hold/presence bounds as any theft (§9). There is no hot-wire.
2. **Claim lock.** §8.4 already rules that form is *a claim the void respects* — ownership IS that claim, held by the sculptor's colony. Taken by force out of the owner's claim, the substance relaxes back to formlessness: the thief receives raw `SUBSTANCE` at full mass, never the mech — the same collapse as destruction (#25). **A gift is a consensual claim transfer** — the one way form survives a change of hands. Mechanically trivial to detect: hostile transfers ride the void-verb machinery (pry/carry/ship `block_events`), gifts are a distinct consensual event. You can steal the matter; authorship is only ever given.
3. **Host seat.** Allied motes (a collaborator's crew on a joint supermoon raid) can fill seats only while ≥1 owner mote is aboard. Mixed crews exist; hijacking doesn't.

Consequences:

- Mech theft is never worth more than substance theft — flattens the griefing incentive spike (feeds the resolved #14 bound) with zero artificial rules.
- Gifting a finished mech becomes one of the largest gestures in the game, because consent is the only channel form survives. Very LEGO.
- Blueprint sharing (#28) is untouched: the *idea* travels free; the mech does not.

### 8.6 Wrecks & Groves

**KJ ruling (2026-07-03): sometimes trees grow out of fallen mechs — or the mechs can be retrieved.**

A mech that falls in a void clash doesn't vanish into a pool — it lies where it fell. This refines #25: the collapse is *in place*, a wreck. Two fates:

- **Retrieval.** A wreck can be hauled home — but it's mech-scale mass, so recovery is itself a mech operation (bulk law, worker-growth §5.1). A retrieved sculpt returns its substance to `SUBSTANCE_held`; the form is gone (#25 stands). Retrieval means an expedition into the place you just lost a fight — recovering your fallen mech is a story mission the sim writes for free.
- **The grove (resolved #36a: "yes — every grove-tree is a grave").** Sometimes a tree grows out of the wreck, and the "sometimes" is now law: **the tree grows iff the crew passed with the mech** — the tree *is* the crew (#32: motes pass into trees), rooting through the chassis. Bailed-out crews leave bare, indefinitely retrievable wrecks. Lore stays exact: trees never grow *from* void substance (§6.2 — the substance is inert); they grow from the fallen motes, *through* the wreck. A tree on a wreck means someone is buried there — always. The battlefield reads at a glance.
- **All trees glow at night (KJ ruling, 2026-07-03; two-tier refinement 2026-07-06).** Not only grove-trees — every tree in the world glows softly after dark. The night, the void's own phase, is lit by the world's living things; memorial groves join a visual language the whole world already speaks, and a grove of the fallen reads at night as a constellation on the old front line. (Passing-trees — Elders who became trees, #32 — glow with the rest: the dead keep a light on.) **Two-tier (KJ 2026-07-06, implemented on staging):** regular groves glow *very weak*; the hero **super tree is a strong beacon**. This glow is also the world's weapon — see §4.1: light attached to a void ship scatters its haul back.
- **The choice.** Retrieve the matter, or leave the memorial. Once roots claim the chassis it is entombed — mass conserved, marked memorial in the ledger. Over years the frontier becomes a **grove of the fallen**: chassis in the roots, canopy over the old front line (resolves #35 — the world's most dangerous places grow its most sacred).
- **Disturbing a grove (KJ ruling, 2026-07-03): possible — but it makes some in the colony sad.** Not a flat penalty: *some* motes grieve — those who knew the fallen (housemates, crewmates, from their real event history) and the empathetic personalities (MBTI feeling axis). Grief is a comfort drop under existing math, visible in dialogue (§6.3 — the mote who watched you dig up their crewmate's grave will say so). And because comfort is loyalty (#29), repeatedly robbing graves can push a grieving mote toward defection. The taboo is enforced entirely by characters — no rule forbids it, the colony just remembers.

Visual touchstone: the moss-grown guardian of Laputa — iron under green, grief turned gentle.

## 9. Other Players — Clash, Not Forced

**KJ ruling:** destruction *and* collaboration between players exist — "almost Clash of Clans like — but I don't want it to be forced by game rules."

- **No forced PvP.** No matchmaking, no raid button, no rule that pushes players at each other. Interaction emerges from **shared physical space**: geography-as-auth means another player reaches your world only by physically being there (geo-gate) or traveling the void by ship (perceived-space hierarchy: feet → bridges → ships). Your potential rivals and allies are literally your neighborhood.
- **Same verbs as the void.** A hostile player gets no special "attack" verb — they can pry, carry, and ship blocks home exactly like void motes, subject to the same pressure/pry law and the same defenses (mass, towers, colony interception). Cross-world theft is a `block_events` transfer between ledgers — identical machinery to the supermoon export.
- **Collaboration is the same verbs signed positive:** gifting blocks, bridging adjacent worlds, scan-merging (existing merge-candidate flow), joint supermoon raids. Rival or ally is a *player* choice, never a rule.
- **Griefing bound (resolved #14: "all users are the same").** No artificial caps — the physical bounds already in law (hold size, presence time, pry law) are the whole bound, and *symmetry* is the guarantee: every rule that limits a griefer limits you identically. The geo rules:
  - **Geo presence grants the view.** A player physically at your world's location can *see* it — no opt-in gate. But they arrive as a visitor, **without their sentinel**: eyes, feet, and the shared verbs, not their heavy assets.
  - **Sentinels travel the built graph.** A player's sentinel (and by extension mech-scale power) can move to another world **only if bridges are built** — infrastructure, consented into existence on both sides of a gap, is what carries force between worlds. Your body travels by geography; your army travels by bridge.
  - Combined with #11 (the void tries to destroy bridges), cross-world force projection is expensive to open and expensive to keep open — the griefing bound is a maintenance bill, not a rulebook.

## 10. Ceremonies — Semi-Dynamic Events

**KJ ruling (2026-07-03): ceremonies are a system.** Gift re-imprints, conversion completions, dowry re-sculpts, the **birth of new motes**, the **passing of motes** — all staged as **semi-dynamic events**: *triggered by the sim* (never scheduled, never scripted into a calendar), *choreographed once triggered*.

The grammar (proposed):

- **Trigger** — a sim-state threshold fires it: a conversion completes, a sculpt is fired, a mote arrives or passes, a gifted mech lands.
- **Gathering** — nearby motes down tools and assemble. In an idle game, the colony *choosing to stop working* is itself the strongest possible signal that something matters.
- **Choreography** — short authored staging (positions, light, timing) filled with **dynamic content**: the mote's real history supplies the words via the §6.3 dialogue machinery. A passing Elder's eulogy is its actual event log; a converted mote's first clear words are about the night it missed the liftoff. Authored form, lived content — that's the "semi."
- **Witness & invite (KJ ruling)** — ceremonies are for the player, and joyful ones (birth, conversion, firing, gift) **send the player an invite** — the colony pings you and waits a bounded time (the Telegram/push plumbing already exists from scan pings). The game's notifications become *invitations in the colony's own voice*, never chore reminders. A passing cannot wait — it happens, and leaves a **memorial** the player can attend late.
- **Interruptible** — the world does not pause. A void raid can crash a birth ceremony, and defending it becomes a story you retell. Semi-dynamic cuts both ways: the sim keeps authoring.

**Ceremony roster (v1):** birth (new arrival) · passing (an Elder passes **into a tree**; void clashes can also take motes — #32) · conversion completion (eyes fully open, first clear words, naming) · sculpt firing (the claim is created, §8.5) · gift re-imprint (the claim transfers, #30) · dowry re-sculpt (converted mote aboard, #31) · **defection** (the dark ceremony — a leaving that is witnessed, not silent; #29/#34).

**Plumbing:** ceremonies emit story events into the existing `block_events`/recap machinery — offline ceremonies surface in recap cards (*"While you were away: an Elder passed. The colony gathered at the orchard."*), with memorials as the visitable evidence, same grain as landing scars (§13).

## 11. Mote Memory — The Second Ledger

**KJ ruling (2026-07-03): motes have little database memories** — observations of the world, small things they have seen or heard — **a ledger that then influences their actions.**

The game already has one ledger for matter (nothing minted, nothing deleted). This is the second: a ledger for *experience*. The conservation law made blocks trustworthy; the memory ledger makes characters trustworthy — a mote can only feel, say, and do things its history supports.

- **What gets written:** witnessed events (a raid survived, a block personally carried, a ceremony attended, a grave disturbed), heard things (gossip, below), felt things (meals, cold nights, a housemate's warmth). Grain matches `block_events` — most entries are references into logs that already exist.
- **Little, deliberately.** Each mote keeps a small capped store: the N most *salient* memories, where salience = emotional weight (a survived raid outranks a routine meal). Mundane memories fade; the big ones stay for life. Motes forget small things and remember what mattered — which is what makes them feel alive rather than logged.
- **Heard, not just seen — gossip.** Idle motes near each other exchange top-salience memories, recorded with provenance ("heard from Miso") at reduced salience. Colony culture becomes emergent: a grave disturbance witnessed by one mote becomes, within a few nights, something the whole colony knows — the taboo (§8.6) spreads the way real taboos do. Nothing is globally broadcast; knowledge physically travels between motes.
- **The ledger influences actions** — memories feed *existing* decision weights, not a new brain:
  - **Grief** (§8.6): comfort drop scaled by memory salience and relationship to the fallen.
  - **Place attachment:** a mote prefers or avoids sites of strong memories — patrols where a friend fell, hesitates at the old landing scar.
  - **Loyalty** (#29): defection risk = accumulated grievance-memories vs kindness-memories. The last-chance conversation (#34) is literally an argument about what the mote remembers.
  - **Conversion** (§6.2): progress *is* the dark mote's accumulating memories of being fed and sheltered — the mechanic was always memory; now it's explicit.
- **Ceremonies read from it (§10):** the eulogy is the colony's shared memories of the fallen; a converted mote's first clear words are its oldest kind-memory. Dialogue (§6.3) upgrades from "recent event log" to the memory ledger itself — the identity card becomes *what this mote remembers*.
- **Access is conversation-only (KJ ruling, 2026-07-03 — resolves #37).** There is no journal UI, no inspector panel, no memory list. The *only* window into a mote's ledger is asking it (§6.3). Consequences:
  - **Mystery survives.** A browsable journal would turn characters back into database rows. Asking keeps the ledger diegetic — what you know about a mote is what it chose to tell you, colored by how it tells it.
  - **Trust gates disclosure.** Motes hold back their heaviest memories until comfort/trust is high enough — a grieving mote won't name who disturbed the grove to a stranger; a mote nursing grievances won't admit defection thoughts until the last-chance conversation (#34) forces them out. Investigating your own colony means *earning* answers, using the same comfort systems that run everything else.
  - **Provenance surfaces naturally in speech** — "Miso told me…" instead of a metadata field. Tracing a rumor to its witness is a conversation chain, which makes colony investigation (who saw the grave robbed? who started this story?) an emergent detective loop with zero new UI.
  - **Speech tiers apply (§6.3 / #22):** an Elder can narrate a memory; a Speck can only *react* to one (shivering near the landing scar, refusing to graze by the grove). Below the dialogue tier, memories are legible only through behavior — which is exactly place-attachment (above) doing the disclosure work.
  - **Debug is exempt:** `memoryReport(moteId)` stays — telemetry is for the developer, the fiction is for the player.
- **Implementation grain:** one small table (`mote_memories`: mote_id, tick, kind seen/heard/felt, subject ref, salience, provenance), capped per mote, written by systems that already emit events. The §6.3 dialogue context and the offline recap already consume per-mote history — this formalizes the store they read. Telemetry: `memoryReport(moteId)` — the ledger sorted by salience; reading it should explain why the mote acts.

## 12. Why This Serves the LEGO Pillar

- **Nothing is ever destroyed.** Conservation reads as *kindness*: your blocks are displaced — to the island, the supermoon, or a neighbor's world — never deleted, and every displacement has a recovery path. Players experiment and build freely because worst-case is a recoverable theft. LEGO worlds don't punish; they escalate.
- **Defense = building.** Protection comes from the mass law (dense builds), towers (recognized constructions), and shelter geometry — every counter to the void *and to hostile players* is more building, which is the activity the game rewards anyway.
- **Self-storytelling engine.** A thief prying loose a specific block, a Puff chasing it down, a ship crossing to an island built of your stolen orchard, a neighbor who turned out to be an ally on a supermoon raid — one-night stories the player authors by where they built and what they left exposed.
- **The endgame is authorship.** Sculpting (§8) makes the deepest late-game reward *a design act*: the strongest mech in your world is the one you shaped with your own hands, out of the enemy's erasure. The power curve and the creative act are the same curve.
- **Empathy calibration (resolved #8):** void motes need enough character to be memorable, not so much that stopping them feels cruel. The answer: **eyeless, at first** — dark motes gain eyes only through conversion (§6.2), so sympathy arrives exactly when redemption does.

## 13. Offline Catch-up

Replace the current teleport-to-pool estimate with ship-visit simulation: elapsed nights × (ship came? hold filled? ferry departed?) given the world's protection map. Same math, better recap: *"The void ship landed 3 times at the NE shore. 214 blocks taken. The island grew — a ferry leaves for the supermoon in 2 nights."* The landing scar (lowest-protection cell — already computed for rifts) is visitable evidence.

## 14. Telemetry & Debug

`__tw` levers, matching the worker harness style: `voidReport()` (phase, motes, hold, island total, ferry countdown), `spawnVoidShip()`, `forceLiftoff()`, `islandReport()` (composition by material/grade), `moonReport()` (supermoon share), `dropCarriers()`, `raidForecast()` (the workers' entrance briefing — predicted landing cell + likelihood, §4). Sculpting (§8): `substanceReport()` (held mass, sources, corruption pressure), `sculptValidate()` (runs the mech recognizer on a sculpture — organs found, mass, crew requirement, verdict).

## 15. Open Calls (KJ to rule)

Resolved by KJ 2026-07-02: ~~#1 moon scope~~ → hierarchy: per-world void island (chapter 1) + one central supermoon (shared, escalation arc). Player clash/collaboration exists, never forced.

**2026-07-03: KJ ruled the entire remaining board.** Only #36b (grove comfort aura) is still open; the #16 aggression-curve *shape* stands as proposed (adopted, tunable).

2. ~~**Direct player agency**~~ — **Resolved (KJ): "no for now — can build in real time though."** No tap-to-drop; interception is colony-only and purge stays the player's active hand — but building is never locked during a raid: walls, mass, and towers placed mid-raid are the player's live agency (§3).
3. ~~**Dropped-block grade**~~ — **Resolved (KJ): un-grading only on the moon.** Island matter keeps its grade for as long as it sits there — an island raid is always full recovery; grade erases only at supermoon assimilation (§7).
4. ~~**Value-seeking archetypes**~~ — **Resolved (KJ): yes — rare tiers only.** Common motes stay lawful under the pressure law; rare archetypes covet fruit / pure grade / cores — and (KJ: "maybe try to destroy settlements?") may strike BUILT structures directly, same pry law, nothing deleted (§3). The settlement-strike is flagged as a tunable *maybe*.
5. ~~**Island visibility**~~ — **Resolved (KJ): visible from far away.** The island reads from anywhere in the world; the loss stays ambiently visible (§5).
6. ~~**Void architecture**~~ — **Resolved (KJ): a mix of void-world and normal-island architecture** — the void's own crooked ordered forms alongside recognizable chunks of your world rebuilt wrong (§5).
7. ~~**Dawn behavior**~~ — **Resolved (KJ): drop and flee.** Carriers abandon cargo where they stand; dawn is a recovery sweep (§3).
8. ~~**Void mote character**~~ — **Fully resolved (KJ): dark motes, eyeless — at first.** Eyes arrive only as conversion progress (§6.2); empathy calibration closed — sympathy arrives exactly when redemption does.
9. ~~**Ship cadence**~~ — **Resolved (KJ): protection-gated** — quiet nights are earnable and readable. New mechanic (KJ): **workers deliver the raid forecast when the player enters the world** — the colony briefs you on when and where the ship might land (§4). KJ's embedded question (are raids always at night?) is answered by #16: island ships are nocturnal (chapter 1); supermoon-tier attacks can also come by day.
10. ~~**Carried-block physics**~~ — **Resolved (KJ): "walk first — then get on ship and fly."** Loaded carriers path along ground like workers, chaseable the whole way; flight belongs to the ship (§3).
11. ~~**Reaching the island**~~ — **Resolved (KJ): either way is ok — but the void will try to destroy the bridges.** Bridge and raft both valid routes; a bridge is a standing provocation the void actively targets, so holding the route open is part of the chapter (§5). First-reach timing: tuning.
12. ~~**Escalation shape**~~ — **Resolved (KJ): yes — bigger, slower moon ships; maybe followed by new islands.** Larger holds on a longer cadence; the void can re-seed an island, making chapters cyclical (§5, §7).
13. ~~**Ferry cadence**~~ — **Resolved (KJ): "this is ok."** The hold-overflow mechanism stands as written; exact hold size / night count is a tuning knob (§7).
14. ~~**Griefing bound**~~ — **Resolved (KJ): all users are the same.** No artificial caps beyond physical law; symmetry is the bound. Geo presence grants the *view* (visitors arrive without their sentinel); **a sentinel can move to another world only if bridges are built** (§9).
15. ~~**Void substance as a player material**~~ — **Fully resolved (KJ): it is the sculpting medium (§8), and it is *dense*** in the mass law — heavy to haul, strong once sculpted (§7). Corruption-seed shape resolved at #26.
16. ~~**Global aggression curve**~~ — **Resolved (KJ, visibility): the moon is visible during the day — and can also attack during the day** (§7). Daylight danger is the supermoon escalation's signature; chapter-1 island ships stay nocturnal. Curve *shape*: the sublinear / soft-cap proposal stands unchallenged — adopted, tunable.
17. ~~**Do individual dark motes grow?**~~ — **Resolved (KJ): dark motes also grow.** Individuals tier up on stolen matter and crew void mechs under the crew-points law; a converted Elder-dark is a colony treasure (§6.1).
18. ~~**Conversion mechanism**~~ — **Resolved (KJ): a dark mote must be stranded first.** No mid-raid befriending — conversion begins only after a missed liftoff; comfort systems do the converting as proposed (§6.2). Nights-to-convert: tuning.
19. ~~**Converted mote nature**~~ — **Resolved (KJ): no relapse.** Conversion is permanent — that is the point of the peace path. Night-shift gift and eyes-as-progress stand (§6.2).
20. ~~**Conversion vs the ledger**~~ — **Resolved (KJ): mote only.** The converted mote is the entire yield; no substance mass returns to the ledger (§6.2).
21. ~~**Suggestion boundary**~~ — **Resolved (KJ): as stated.** Requests are comfort-weighted inputs; refusal stays common and characterful (§6.3).
22. ~~**Dialogue tiers**~~ — **Resolved (KJ): yes — Elder only** for free LLM conversation; slot-filled templates below (§6.3).
23. ~~**Does attention feed the loop?**~~ — **Resolved (KJ): yes it does** — talking to a mote grants comfort, and **chat is also how the player gives workers commands and suggestions** (still weighted per #21 — motes can refuse). Chore-risk accepted; mitigation is tuning (§6.3).
24. ~~**Sculpting interface**~~ — **Resolved (KJ 2026-07-03): in-world.** The Elder mech physically molds the substance mound — watchable, diegetic. Remaining detail: sub-grid resolution (mechs are smaller than buildings — sub-grid probably necessary for readable silhouettes).
25. ~~**Permanence & wrecks**~~ — **Resolved (KJ 2026-07-03):** a destroyed sculpted mech collapses back to `SUBSTANCE_held` — full mass, form lost. Nothing deleted; the grief is real anyway. (Corollary: the owner can always re-mold their own mech at the in-world station — it's their claim.) **Refined by §8.6:** the collapse is *in place* — a wreck where it fell; the mass reaches `SUBSTANCE_held` only when retrieved, and a grove can claim it first.
26. ~~**Corruption-seed shape**~~ — **Resolved (KJ): yes.** Raw held substance attracts void pressure; a finished sculpt is a claim the void respects; and a large raw stockpile is an **anti-tower** that draws ship landings (§8.4).
27. ~~**Recognizer strictness**~~ — **Resolved (KJ): valid but useless.** A cockpit-only statue passes the recognizer (crewable, does nothing); the mass/density law self-balances min-maxing — no explicit limb/proportion rules (§8.3).
28. ~~**Design sharing**~~ — **Resolved (KJ 2026-07-03): yes.** Designs travel free; the recipient supplies their own substance mass — share the *idea*, never the *matter*. Physical transfer of a finished mech is an ownership question → §8.5.
29. ~~**Void hijack**~~ — **Resolved (KJ 2026-07-03): yes — the vector is badly treated motes.** The hijack is never the void picking a lock: a neglected, miserable mote opens the cockpit — or pilots the sculpt away itself and **defects**. This makes conversion **bidirectional**: the same comfort math that redeems dark motes (§6.2) can lose yours. Kindness converts in; neglect converts out. One law, both signs. Comfort stops being a growth multiplier and becomes **loyalty** (this also resolves worker-growth open call #12). Drama shape: #34 (resolved — defection is real).
30. ~~**Gifted-mech arrival**~~ — **Resolved (KJ 2026-07-03): a little ceremony** — the recipient's Elder re-imprints the claim. Generalized into the ceremonies system (§10), alongside birth and passing ceremonies per the same ruling.
31. ~~**Dowry claim**~~ — **Resolved (KJ 2026-07-03):** clay + remembered design, and the re-sculpt **with the converted mote aboard** is itself a ceremony (§10).
32. ~~**Passing (mortality)**~~ — **Resolved (KJ 2026-07-03): tied to the tree — but it can also happen in clashes with the void.** The natural arc: an Elder's passing becomes a tree — the memorial is alive, the super-tree lore closes its own loop, and conservation holds (the mote's mass roots into the world). And mortality is not only gentle: motes can fall defending the world at night — void clashes carry true stakes. Remaining detail → #35.
33. ~~**Ceremony presence**~~ — **Resolved (KJ 2026-07-03): joyful ceremonies wait AND send the user invites.** The colony pings the player to come (existing Telegram/push plumbing) — notifications become invitations in the colony's own voice. Passings leave attendable memorials. (Interruption stays as proposed: the sim never pauses.)
34. ~~**Defection drama**~~ — **Resolved (KJ 2026-07-03): defection is possible** — a real outcome, not a scripted scare. The last-chance conversation exists but can *fail*: a mote far enough gone refuses to be talked down (MBTI + comfort weighted). The player can lose someone for real — which is exactly what makes loyalty worth maintaining.
35. ~~**Where the fallen go**~~ — **Resolved (KJ 2026-07-03): unified in the wreck — sometimes trees grow out of fallen mechs, or the mechs can be retrieved.** Full shape in §8.6. The void never takes the fallen; the world does.
36. **Grove rules** (three parts): **(a)** ~~crew-death condition~~ — **Resolved (KJ): yes — every grove-tree is a grave.** Tree grows iff the crew passed with the mech; bailed-out crews leave bare, indefinitely retrievable wrecks (§8.6). **Plus (KJ, same ruling): all trees glow at night** — a world-wide night visual, not grove-only; groves read as constellations on the old front line (§8.6). **(b)** do memorial groves radiate comfort — the fallen keep helping (proposed: comfort aura only, never GP/yield, so death is never economically *good*)? **← the one remaining open call.** **(c)** ~~disturbing a grove~~ — **Resolved (KJ 2026-07-03): possible, but it makes some in the colony sad.** Individual, not flat: grief hits motes who knew the fallen plus empathetic personalities; comfort drop → loyalty math → repeated grave-robbing courts defection (§8.6).
37. ~~**Reading a mote's memories**~~ — **Resolved (KJ 2026-07-03): conversation-only.** You learn what a mote remembers only by asking it (§6.3) — no journal UI. Privacy holds: heavy memories are trust-gated behind comfort, provenance surfaces in speech ("Miso told me…"), and below the dialogue tier memories show only through behavior. Full shape in §11.
38. **Glow-matter harvest & delivery** (new, §4.1) — how does glow matter get from a glowing canopy onto a void ship? Proposal: it accrues in canopies over the night, workers gather it like blocks (a light-harvest chore), and a worker/mech carries it to affix to a landed ship — the void mote's pry→carry→deliver loop signed positive. Whether attaching is a worker act, a mech verb, or a focused tower beam is open. Tuning-adjacent, but the verb choice is a design call.
39. **Is the super tree a progression gate?** (new, §4.1) — must the strong-beacon super tree be grown/earned to unlock ship-scale light (so a young world can't yet down a ship), or is beacon-strength light available from the start? Ties the two-tier glow (implemented) into the chapter-1 difficulty curve.
40. **Does the void island breathe?** (raised by KJ 2026-07-06, pre-existing open fork) — is the per-world void island a *fixed* shadow-world you build toward raiding (§5 as written), or does its size **breathe with the nightly tug-of-war** — growing on nights the void wins, shrinking on nights light scatters the ship's haul back (§4.1)? The light-vs-ship mechanic makes a breathing island newly coherent: the island silhouette becomes the running scoreboard of the war, not just an accreting loss.
