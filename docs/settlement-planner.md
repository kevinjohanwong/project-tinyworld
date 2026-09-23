# Settlement Planner

## Purpose

The settlement planner coordinates buildings, access, terrain work, and landscaping as one persistent site plan. Individual building techniques remain separate inspectable plans; the settlement planner owns their arrangement and dependencies.

## Five levels

1. **Shelter** — cottage, entrance path, garden; no dedicated mech storage yet.
2. **Homestead** — cottage and workshop sharing a yard/path system, with an optional one-frame driveway, charging pad, or shed.
3. **Courtyard** — longhouse, workshop, and townhouse around a plaza with a prepared terrace and shared utility-frame parking.
4. **Cliff village** — four-building cluster plus cliff stairs, terrace, retaining wall, drainage, optional cave room, and terrain-compatible mech bays.
5. **District** — civic hall anchoring housing, workshop, watchtower, plaza, paths, landscape infrastructure, and a communal hangar/expedition yard.

## Persistent plan

`SettlementPlan` stores:

- level, composition pattern, anchor, stage, and status;
- building parcels with kind, rotation, dependency, and completion state;
- a connected shared path network;
- terrain operations: cave, cliff stairs, terrace, retaining wall;
- landscape zones: garden, grove, plaza, drainage;
- mech infrastructure: pads, driveways, sheds, shared parking, workshops, hangar bays, and expedition staging;
- final inspection and issues.

Workers create the plan before creating building projects. Building projects occupy the plan's parcels in order and report completion back to it. Plans and parcel progress save with the worker and survive reload/offline catch-up.

## Stage order

```text
survey → access → terrain → buildings → landscape → inspection → complete
```

The planner is now live for parcel grouping and persistence. Terrain and landscape operations are represented with explicit cells, outputs, and dependencies; their worker execution verbs are the next implementation boundary. Cave excavation must move removed matter into visible carried/stockpile state, and constructed stairs/retaining walls must spend that same visible material through the conservation ledger.

## Invariants

1. Every parcel connects to the shared path network.
2. Entrances face usable access space rather than another footprint.
3. Parcels may not overlap.
4. Terrain work precedes dependent construction.
5. Excavated material is conserved and becomes visible local supply.
6. Caves require a reachable opening, worker clearance, and supported ceilings.
7. Cliff stairs change no more than one vertical voxel per step.
8. Retaining walls have a support path to terrain.
9. Landscaping cannot consume or move protected trees.
10. Randomness selects only among already-valid plans.
11. Mech parking belongs to the shared settlement fleet; a pad beside a house never assigns that frame permanently to the resident.
12. Every operational bay must connect to a path wide and clear enough for its intended frame, with enough maneuvering room to enter and leave.
13. Parked frames, spare parts, cargo, and damaged returns remain physical world objects, never hidden inventory.

## Debug controls

- `__tw.cityReport()` includes settlement level and every worker's saved plan.
- `__tw.settlementStart(level?, workerId?)` creates a fresh level 1–5 plan at a valid nearby anchor.
