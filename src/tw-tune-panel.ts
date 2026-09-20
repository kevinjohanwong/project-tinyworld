// ── Mobile tune panel ──
// On-device tuning surface for the knobs that previously required typing URL
// params or console calls (__tw.* / __twPWater.knob) — unusable on a phone.
// Two knob classes:
//   LIVE    — applied instantly through the window handles (tod hour, exposure
//             multiplier, shadows, GTAO, outline, RayGI, water presentation).
//   RESTART — URL-param gated at boot (sky, fxanchor, grass…): the panel edits
//             the query string and reloads on "Apply & reload".
// Live values persist in localStorage (twTuneV1) and re-apply on boot as the
// subsystems come up. "Copy" exports the whole state as JSON so device
// findings can be reported back verbatim. ?tune=0 hides the panel entirely.
// Presentation/diagnostic only: no knob here changes simulation rules.

type TuneState = {
  tod: number | null;        // live hour 0–24, null = auto (real clock)
  exposure: number;          // multiplier on palette exposure
  shadowType: string | null; // basic | pcf | pcfsoft
  ssao: boolean | null;
  outline: boolean | null;
  raygi: boolean | null;
  ribNorm: number | null;
  momentum: boolean | null;
  droplets: boolean | null;
  waterRun: boolean | null;
};

const LS_KEY = "twTuneV1";

const defaults = (): TuneState => ({
  tod: null, exposure: 1, shadowType: null, ssao: null, outline: null,
  raygi: null, ribNorm: null, momentum: null, droplets: null, waterRun: null,
});

function loadState(): TuneState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch { /* fresh */ }
  return defaults();
}

function saveState(s: TuneState) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* full/private */ }
}

const w = () => window as any;

// Each live knob: how to push a state value into the running app. Returns
// true when the handle existed (so boot re-apply can retry until ready).
const appliers: Record<string, (s: TuneState) => boolean> = {
  tod: (s) => { const f = w().__tw?.tod; if (!f) return false; f(s.tod); return true; },
  exposure: (s) => { const f = w().__tw?.exposure; if (!f) return false; f(s.exposure); return true; },
  shadowType: (s) => {
    if (s.shadowType == null) return true;
    const f = w().__tw?.setShadowType; if (!f) return false; f(s.shadowType); return true;
  },
  ssao: (s) => {
    if (s.ssao == null) return true;
    const f = w().__tw?.setSSAO; if (!f) return false; f(s.ssao); return true;
  },
  outline: (s) => {
    if (s.outline == null) return true;
    const f = w().__tw?.setOutline; if (!f) return false; f({ enabled: s.outline }); return true;
  },
  raygi: (s) => {
    if (s.raygi == null) return true;
    const f = w().__tw?.raygi; if (!f) return false; f({ enabled: s.raygi }); return true;
  },
  water: (s) => {
    const k = w().__twPWater?.knob; if (!k) return false;
    const o: any = {};
    if (s.ribNorm != null) o.ribNorm = s.ribNorm;
    if (s.momentum != null) o.momentum = s.momentum;
    if (s.droplets != null) o.droplets = s.droplets;
    if (s.waterRun != null) o.running = s.waterRun;
    if (Object.keys(o).length) k(o);
    return true;
  },
};

// Restart knobs: label → [param, onValue, offValue(null = remove param)].
// "on" is each knob's DEFAULT state, so removing the param restores it.
const RESTART_KNOBS: Array<{ key: string; label: string; offValue: string }> = [
  { key: "sky", label: "Sky dome", offValue: "0" },
  { key: "fxanchor", label: "Shader FX anchors", offValue: "0" },
  { key: "grass", label: "Grass", offValue: "0" },
  { key: "grassrich", label: "Rich grass", offValue: "0" },
  { key: "shadowsplit", label: "Shadow split", offValue: "0" },
  { key: "greedy", label: "Greedy mesh", offValue: "0" },
  { key: "ssao", label: "GTAO pass", offValue: "0" },
  { key: "pwater", label: "Water sim", offValue: "0" },
  { key: "panels", label: "Cockpit panels", offValue: "0" },
];

export function initTunePanel() {
  if (typeof document === "undefined") return;
  if (document.getElementById("tw-tune-gear")) return;
  const params = new URLSearchParams(location.search);
  if (params.get("tune") === "0") return;

  const state = loadState();

  // Boot re-apply: push saved live values as their subsystems come up.
  const pending = new Set(Object.keys(appliers));
  const bootTimer = setInterval(() => {
    for (const key of Array.from(pending)) {
      try { if (appliers[key](state)) pending.delete(key); } catch { /* subsystem mid-init */ }
    }
    if (!pending.size) clearInterval(bootTimer);
  }, 1000);
  setTimeout(() => clearInterval(bootTimer), 90000);

  const css = document.createElement("style");
  css.textContent = `
#tw-tune-gear{position:fixed;right:10px;bottom:170px;z-index:10006;width:40px;height:40px;border-radius:50%;background:rgba(10,14,22,.62);border:1px solid rgba(255,255,255,.22);color:#dfe7f2;font-size:19px;line-height:38px;text-align:center;user-select:none;-webkit-user-select:none;touch-action:manipulation;cursor:pointer}
#tw-tune-panel{position:fixed;right:8px;bottom:8px;z-index:10007;width:min(330px,calc(100vw - 16px));max-height:74dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(8,11,17,.93);border:1px solid rgba(140,170,220,.35);border-radius:12px;padding:12px 14px 16px;color:#e6edf7;font:12px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 12px 44px rgba(0,0,0,.5)}
#tw-tune-panel h4{margin:10px 0 4px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#8fa8cc}
#tw-tune-panel .tw-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:34px}
#tw-tune-panel .tw-val{color:#9fe8a9;font-family:ui-monospace,monospace;font-size:11px;min-width:44px;text-align:right}
#tw-tune-panel input[type=range]{flex:1;height:30px;accent-color:#6ea8ff;touch-action:none}
#tw-tune-panel select{background:#131a26;color:#e6edf7;border:1px solid rgba(140,170,220,.35);border-radius:6px;padding:4px 6px;font-size:12px}
#tw-tune-panel button{background:#1a2436;color:#e6edf7;border:1px solid rgba(140,170,220,.4);border-radius:8px;padding:7px 10px;font-size:12px;touch-action:manipulation;cursor:pointer}
#tw-tune-panel button.tw-primary{background:#2b4a86;border-color:#4f77c2}
#tw-tune-panel .tw-toggle{min-width:52px}
#tw-tune-panel .tw-toggle.on{background:#245a34;border-color:#3f9a5c;color:#c9f5d3}
#tw-tune-panel .tw-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
#tw-tune-panel .tw-close{position:sticky;top:0;float:right;background:none;border:none;color:#8fa8cc;font-size:18px;padding:0 2px}
`;
  document.head.appendChild(css);

  const gear = document.createElement("div");
  gear.id = "tw-tune-gear";
  gear.textContent = "⚙";
  document.body.appendChild(gear);

  const panel = document.createElement("div");
  panel.id = "tw-tune-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  const set = (patch: Partial<TuneState>, applyKey: string) => {
    Object.assign(state, patch);
    saveState(state);
    try { appliers[applyKey]?.(state); } catch { /* handle missing */ }
  };

  const fmtTod = (h: number | null) =>
    h == null ? "auto" : `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

  const build = () => {
    panel.innerHTML = "";
    const add = (el: HTMLElement) => panel.appendChild(el);
    const h4 = (t: string) => { const e = document.createElement("h4"); e.textContent = t; add(e); };
    const row = () => { const e = document.createElement("div"); e.className = "tw-row"; add(e); return e; };
    const label = (r: HTMLElement, t: string) => { const e = document.createElement("span"); e.textContent = t; r.appendChild(e); return e; };
    const val = (r: HTMLElement, t: string) => { const e = document.createElement("span"); e.className = "tw-val"; e.textContent = t; r.appendChild(e); return e; };

    const closeBtn = document.createElement("button");
    closeBtn.className = "tw-close"; closeBtn.textContent = "✕";
    closeBtn.onclick = () => { panel.style.display = "none"; gear.style.display = "block"; };
    add(closeBtn);

    // ── LIGHT ──
    h4("Light");
    {
      const r = row(); label(r, "Time");
      const v = val(r, fmtTod(state.tod));
      const auto = document.createElement("button");
      auto.className = "tw-toggle" + (state.tod == null ? " on" : "");
      auto.textContent = state.tod == null ? "auto" : "live";
      r.appendChild(auto);
      const sr = row();
      const slider = document.createElement("input");
      slider.type = "range"; slider.min = "0"; slider.max = "24"; slider.step = "0.25";
      slider.value = String(state.tod ?? 12);
      sr.appendChild(slider);
      slider.oninput = () => {
        set({ tod: parseFloat(slider.value) }, "tod");
        v.textContent = fmtTod(state.tod);
        auto.textContent = "live"; auto.classList.remove("on");
      };
      auto.onclick = () => {
        set({ tod: null }, "tod");
        v.textContent = "auto"; auto.textContent = "auto"; auto.classList.add("on");
      };
    }
    {
      const r = row(); label(r, "Exposure ×");
      const v = val(r, state.exposure.toFixed(2));
      const sr = row();
      const slider = document.createElement("input");
      slider.type = "range"; slider.min = "0.5"; slider.max = "1.8"; slider.step = "0.02";
      slider.value = String(state.exposure);
      sr.appendChild(slider);
      slider.oninput = () => { set({ exposure: parseFloat(slider.value) }, "exposure"); v.textContent = state.exposure.toFixed(2); };
    }
    {
      const r = row(); label(r, "Shadow filter");
      const sel = document.createElement("select");
      for (const o of ["default", "basic", "pcf", "pcfsoft"]) {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        if ((state.shadowType ?? "default") === o) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => set({ shadowType: sel.value === "default" ? null : sel.value }, "shadowType");
      r.appendChild(sel);
    }
    const toggleRow = (name: string, key: keyof TuneState, applyKey: string) => {
      const r = row(); label(r, name);
      const b = document.createElement("button");
      const cur = state[key] as boolean | null;
      b.className = "tw-toggle" + (cur === false ? "" : " on");
      b.textContent = cur == null ? "default" : cur ? "on" : "off";
      b.onclick = () => {
        const now = state[key] == null ? false : !state[key];
        set({ [key]: now } as any, applyKey);
        b.textContent = now ? "on" : "off";
        b.classList.toggle("on", now);
      };
      r.appendChild(b);
    };
    toggleRow("Ambient occlusion", "ssao", "ssao");
    toggleRow("Outline pass", "outline", "outline");
    toggleRow("RayGI (debug)", "raygi", "raygi");

    // ── WATER ──
    h4("Water");
    {
      const r = row(); label(r, "Ribbon density");
      const v = val(r, state.ribNorm != null ? state.ribNorm.toFixed(3) : "default");
      const sr = row();
      const slider = document.createElement("input");
      // log scale 0.002 → 0.03
      slider.type = "range"; slider.min = "0"; slider.max = "1"; slider.step = "0.01";
      const toRib = (t: number) => 0.002 * Math.pow(15, t);
      const fromRib = (rn: number) => Math.log(rn / 0.002) / Math.log(15);
      slider.value = String(state.ribNorm != null ? Math.min(1, Math.max(0, fromRib(state.ribNorm))) : fromRib(0.005));
      sr.appendChild(slider);
      slider.oninput = () => {
        const rn = Math.round(toRib(parseFloat(slider.value)) * 1000) / 1000;
        set({ ribNorm: rn }, "water");
        v.textContent = rn.toFixed(3);
      };
    }
    toggleRow("Momentum", "momentum", "water");
    toggleRow("Droplets", "droplets", "water");
    toggleRow("Sim running", "waterRun", "water");

    // ── RESTART KNOBS ──
    h4("Restart knobs (reloads)");
    const pendingParams: Record<string, string | null> = {};
    for (const k of RESTART_KNOBS) {
      const r = row(); label(r, k.label);
      const b = document.createElement("button");
      const isOff = params.get(k.key) === k.offValue;
      b.className = "tw-toggle" + (isOff ? "" : " on");
      b.textContent = isOff ? "off" : "on";
      b.onclick = () => {
        const currentlyOff = b.textContent === "off";
        const nextOff = !currentlyOff;
        b.textContent = nextOff ? "off" : "on";
        b.classList.toggle("on", !nextOff);
        pendingParams[k.key] = nextOff ? k.offValue : null;
      };
      r.appendChild(b);
    }
    {
      const r = row(); label(r, "Water cell K");
      const sel = document.createElement("select");
      for (const o of ["default", "2", "3", "4"]) {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        if ((params.get("pwk") || "default") === o) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => { pendingParams["pwk"] = sel.value === "default" ? null : sel.value; };
      r.appendChild(sel);
    }
    {
      const applyBtn = document.createElement("button");
      applyBtn.className = "tw-primary";
      applyBtn.textContent = "Apply & reload";
      applyBtn.onclick = () => {
        const p = new URLSearchParams(location.search);
        for (const [key, value] of Object.entries(pendingParams)) {
          if (value == null) p.delete(key); else p.set(key, value);
        }
        location.search = p.toString();
      };
      const r = row(); r.appendChild(applyBtn);
    }

    // ── ACTIONS ──
    const actions = document.createElement("div");
    actions.className = "tw-actions";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy settings";
    copyBtn.onclick = async () => {
      const payload = JSON.stringify({ ...state, url: location.search }, null, 0);
      try { await navigator.clipboard.writeText(payload); copyBtn.textContent = "Copied ✓"; }
      catch {
        const ta = document.createElement("textarea");
        ta.value = payload; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); copyBtn.textContent = "Copied ✓"; } catch { copyBtn.textContent = payload.slice(0, 20); }
        ta.remove();
      }
      setTimeout(() => { copyBtn.textContent = "Copy settings"; }, 1500);
    };
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset all";
    resetBtn.onclick = () => {
      try { localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
      const p = new URLSearchParams(location.search);
      for (const k of RESTART_KNOBS) p.delete(k.key);
      p.delete("pwk");
      location.search = p.toString();
    };
    actions.appendChild(copyBtn);
    actions.appendChild(resetBtn);
    add(actions);
  };

  gear.onclick = () => {
    build();
    panel.style.display = "block";
    gear.style.display = "none";
  };
}
