import re, sys
P = "/home/workspace/project-tinyworld/src/pwater/tinyworld-pwater.ts"
s = open(P).read()
def rep(old, new, count=1):
    global s
    assert s.count(old) == count, f"expected {count} match(es) for: {old[:70]!r} got {s.count(old)}"
    s = s.replace(old, new)

# 1. layered arrays after the union bins
rep("""  const gFoam = new Float32Array(nx * nz);
""", """  const gFoam = new Float32Array(nx * nz);
  // ── Layered binning (Sep 2) ─────────────────────────────────────────────
  // The solver's particles are split per column into BODY water (resting or
  // flowing on terrain) and FALLING water (free fall: vy below FALL_VY). The
  // height-field surface only sees body water, so a fall no longer stretches
  // the sheet from lip to floor and a plunge pool under a fall keeps its own
  // surface; the falling span feeds the hi-fi curtain pass. The g* bins stay
  // the UNION so the moisture consumer (waterCells) and the SSFR relax path
  // read exactly what they did — this is presentation, physics untouched.
  // ?pwfallvy= threshold in cells/s (default -4 ≈ 0.15 s of free fall).
  const FALL_VY = num("pwfallvy", -4);
  const gbHas = new Uint8Array(nx * nz);
  const gbTop = new Float32Array(nx * nz);
  const gbMin = new Float32Array(nx * nz);
  const gfHas = new Uint8Array(nx * nz);
  const gfTop = new Float32Array(nx * nz);
  const gfMin = new Float32Array(nx * nz);
  const gfCnt = new Float32Array(nx * nz);
  const gfVy = new Float32Array(nx * nz);
  let fallCols = 0;
  let fallN = 0;
""")

# 2. binFields: classify
rep("""    gHas.fill(0); gCnt.fill(0); gFx.fill(0); gFz.fill(0);
    gSpd.fill(0); gImp.fill(0); gFoam.fill(0);
""", """    gHas.fill(0); gCnt.fill(0); gFx.fill(0); gFz.fill(0);
    gSpd.fill(0); gImp.fill(0); gFoam.fill(0);
    gbHas.fill(0); gfHas.fill(0); gfCnt.fill(0); gfVy.fill(0);
    fallCols = 0; fallN = 0;
""")
rep("""      const vy = st.vel[i + 1];
      if (vy < -3) gImp[b] += Math.min(1, -vy / 12);
    }
""", """      const vy = st.vel[i + 1];
      if (vy < -3) gImp[b] += Math.min(1, -vy / 12);
      if (vy < FALL_VY) {
        if (!gfHas[b]) { gfTop[b] = y; gfMin[b] = y; gfHas[b] = 1; fallCols++; }
        else {
          if (y > gfTop[b]) gfTop[b] = y;
          if (y < gfMin[b]) gfMin[b] = y;
        }
        gfCnt[b]++;
        gfVy[b] += vy;
        fallN++;
      } else {
        if (!gbHas[b]) { gbTop[b] = y; gbMin[b] = y; gbHas[b] = 1; }
        else {
          if (y > gbTop[b]) gbTop[b] = y;
          if (y < gbMin[b]) gbMin[b] = y;
        }
      }
    }
""")
# 3. blur over BODY columns only
rep("""          if (xx < 0 || xx >= nx || !gHas[row + xx]) continue;
          s += gTop[row + xx]; c++;
""", """          if (xx < 0 || xx >= nx || !gbHas[row + xx]) continue;
          s += gbTop[row + xx]; c++;
""")
# 4. field assignment: body surface + fall span
rep("""        if (!gHas[b]) { f.mask[b] = 0; continue; }
        f.mask[b] = 1;
        f.h[b] = gSurf[b];
        f.dep[b] = gTop[b] - gMin[b] + cellD;
""", """        if (gfHas[b]) {
          // Falling span in cell units, padded by half a particle spacing.
          // Density: particles per cell of height vs a one-cell-thick sheet
          // at rest spacing (1/D^2) — a lone trickle reads ~0.2, a full
          // sheet saturates at 1.
          const span = gfTop[b] - gfMin[b] + cellD;
          f.fTop[b] = gfTop[b] + cellD * 0.5;
          f.fBot[b] = gfMin[b] - cellD * 0.5;
          f.fDen[b] = Math.min(1, (gfCnt[b] / span) * cellD * cellD);
          f.fVy[b] = gfVy[b] / gfCnt[b];
        } else f.fDen[b] = 0;
        if (!gbHas[b]) { f.mask[b] = 0; continue; }
        f.mask[b] = 1;
        f.h[b] = gSurf[b];
        f.dep[b] = gbTop[b] - gbMin[b] + cellD;
""")
# 5. report
rep("""      hifi: hifi ? hifi.state() : null,
""", """      hifi: hifi ? hifi.state() : null,
      fall: { cols: fallCols, particles: fallN, vyGate: FALL_VY },
""")
open(P, "w").write(s)
print("pwater bridge patched")
