# Scan Economy — Scan-Seconds, Scanner Tiers, Capture Paths

*Chunk 4 design. Builds on the conservation ledger (Chunk 1) and the
mass/protection law (`mass-and-density.md`).*

## One currency: scan-seconds

Scanning is gated by a single resource — **scan-seconds** — banked
server-side in the world record next to the ledger.

- **Generation is bloom-fed.** The settlement's organic economy
  (bloom) charges the scanner, the forge, and the food supply from the
  same garden. Expansion competes with refinement and survival.
- **Spending is continuous.** Holding the scan button drains banked
  seconds in real time: 30 banked seconds = 30 seconds of sweeping.
  Partial sweeps debit only what was used.
- **Two spends, one resource:**
  - **Expand** — sweep unscanned space → new land enters the world
    (mass added to baseline, mostly raw, with rare pure/core rolls).
  - **Purge** — re-sweep owned territory → void-pool blocks in the
    swept radius are expelled and returned as **raw** matter (mass
    conserved, grades lost, per the entropy law). LiDAR is directed
    perception; the void is unperceived space. Re-perceiving it is the
    fastest way to drive it out.

## Scanner tiers (perception grades)

Every device has a perception grade. Grade sets the scan-second
exchange rate and the quality of what perception finds. Hardware is a
*lens quality*, never a paywall.

| Tier | Hardware | Cost multiplier | Material rolls |
|---|---|---|---|
| **LiDAR** | iPhone/iPad Pro (12 Pro+) | ×1 | full (18% pure vein, 3% core) |
| **ToF depth** | Android flagships w/ depth sensor | ×1.5 | slightly reduced |
| **Motion depth** | ARCore depth-from-motion (most Android) | ×2–3 | reduced |
| **Photogrammetry** | any camera (photo-mode capture) | ×3 | halved pure/core rates |
| **None** | desktop / no camera | — (cannot originate land) | — |

**No-scanner players are still full citizens.** Everything else is
web-playable: settlement management, refining, building, pilots,
ships, and purging via banked seconds (tap-and-hold sweep on the map
instead of a physical sweep). Land can also arrive *socially* — a
LiDAR-equipped player scans a bridge path or territory; scanner-haves
become the world's surveyors (asymmetric role, not a missing feature).

## Capture paths

Safari/WebKit cannot access LiDAR or ARKit depth APIs. Native capture
options, in order of commitment:

1. **Scanning-app relay (works today)** — Polycam/Scaniverse export
   GLB → upload to the web prototype. App-switch seam, but playable now.
2. **App Clip (iOS)** — sub-10MB native applet launched from a
   link/QR, no install. Does *only* LiDAR capture + mesh POST, then
   bounces back to Safari. Requires Apple Developer account ($99/yr)
   and a minimal parent app through App Store review.
3. **Google Play Instant (Android)** — same pattern, 15MB limit,
   using ARCore Depth API.
4. **Full native app** — the `ios/` endgame. ARWorldMap
   relocalization makes incremental scans arrive pre-aligned to the
   existing world (furniture-app style), so the voxelizer diffs
   instead of stitching.

## Scan-second enforcement (anti-tamper)

App Clips/Instant Apps are stateless and evictable, so the **server
owns the balance**:

1. The launch URL carries a short-lived signed token encoding the
   player's banked seconds.
2. The Clip runs a visible countdown during capture and hard-stops at
   zero; it reports actual seconds used (partial sweeps allowed).
3. The server validates the token, sanity-checks the upload (mesh
   volume/complexity vs. claimed seconds — 8 seconds cannot produce a
   city block), and debits on mesh arrival.

## Device gating: web vs. native

The web cannot reliably detect LiDAR — there is no sensor API and
user-agent strings don't distinguish Pro models. The web tier
therefore offers capture paths and lets failure/quality speak.

A native app (or App Clip) gates *exactly*:

- Runtime check:
  `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)` —
  true only on LiDAR devices. The app assigns the perception grade
  itself and signs it into the upload, so tiers are enforced, not
  self-reported.
- Photogrammetry fallback (Object Capture) for non-LiDAR iPhones is
  detected and priced at its own tier the same way.
- ARCore equivalently reports depth capability
  (`Config.DepthMode.AUTOMATIC` support) on Android.

## Press structure (chunk 4 remainder)

Compression (`4 pure → 1 raw` next tier) must move from debug call to
an in-world **press structure**: built by the player, fed by worker
haulage, visibly consuming 4-in/1-out. Grades (raw/worked/pure) get
enforced in the ledger at the same time — "only pure compresses
cleanly" is what makes unstable slugs emerge.

---

*Project TinyWorld — internal spec, June 2026*
