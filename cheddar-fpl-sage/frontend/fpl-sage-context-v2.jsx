import { useState, useEffect, useCallback } from "react";

// ─── Risk Posture Behavior Map ───────────────────────────────────────────────
// This is the SOURCE OF TRUTH for what changes at each risk level.
// Every behavioral delta is explicit and human-readable.

export const RISK_POSTURE_MAP = {
  conservative: {
    label: "Conservative",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.08)",
    border: "rgba(34,197,94,0.25)",
    icon: "🛡",
    tagline: "Protect your rank. Don't chase.",
    thresholds: {
      transferGainFloor: 2.5,
      hitNetFloor: 6,
      maxHitsPerGW: 0,
      chipDeployBoost: 15,
      captainDiffMaxOwnership: 5,
      bbMinBenchXPts: 12,
      tcRequiresDGW: true,
    },
    behaviors: [
      { category: "Transfers",   rule: "Only transfer players with clear OUT/injury status. Gain threshold ≥ 2.5 pts over 3 GWs before pulling trigger." },
      { category: "Hits",        rule: "No hits unless 3+ starters are OUT. A 4pt hit requires 6pt gain floor to justify." },
      { category: "Captain",     rule: "Always pick the highest-ownership premium (Salah, Haaland). Differentials only if ownership < 5% AND xPts ≥ 8." },
      { category: "Chips",       rule: "Raise chip deploy threshold by +15 pts. Bench Boost only in DGW with 12+ bench xPts. TC only on DGW premium." },
      { category: "Bench",       rule: "Prioritize reliable bench coverage. Budget players must be near-guaranteed starters." },
      { category: "Transfers",   rule: "Prefer holds over speculative buys. Price rises are secondary to fixture certainty." },
    ],
  },
  balanced: {
    label: "Balanced",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.25)",
    icon: "⚖",
    tagline: "Optimal EV. Standard thresholds.",
    thresholds: {
      transferGainFloor: 1.5,
      hitNetFloor: 8,
      maxHitsPerGW: 1,
      chipDeployBoost: 0,
      captainDiffMaxOwnership: 25,
      bbMinBenchXPts: 10,
      tcRequiresDGW: true,
    },
    behaviors: [
      { category: "Transfers",   rule: "Transfer when gain ≥ 1.5 pts projected over next 3 GWs. Form + fixture both considered." },
      { category: "Hits",        rule: "1 hit acceptable if net gain ≥ 8 pts. 2 hits only in extreme squad emergency." },
      { category: "Captain",     rule: "Best projected captain. Mix of ownership and differential considered. Max 25% differential risk." },
      { category: "Chips",       rule: "Standard chip thresholds apply (score ≥ 70 = DEPLOY). Sequence matters: WC → BB → TC." },
      { category: "Bench",       rule: "Bench provides safety net. Budget for 1 premium bench player near a DGW window." },
      { category: "Transfers",   rule: "Price rise chasing allowed if player is also a squad improvement." },
    ],
  },
  aggressive: {
    label: "Aggressive",
    color: "#ef4444",
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.25)",
    icon: "⚡",
    tagline: "Chase the ceiling. High variance, high upside.",
    thresholds: {
      transferGainFloor: 1,
      hitNetFloor: 5,
      maxHitsPerGW: 2,
      chipDeployBoost: -10,
      captainDiffMaxOwnership: 15,
      bbMinBenchXPts: 8,
      tcRequiresDGW: false,
    },
    behaviors: [
      { category: "Transfers",   rule: "Transfer on form + fixture alone. Gain threshold drops to 1 pt if differential value exists." },
      { category: "Hits",        rule: "Up to 2 hits per GW if squad is misaligned with fixtures. 4pt hit worth it if gaining 5+ pts EV." },
      { category: "Captain",     rule: "Target differentials < 15% ownership if xPts ≥ 7.5. Actively avoid template captain if alternative exists." },
      { category: "Chips",       rule: "Lower chip threshold by -10 pts. Offensive FH in DGW considered even without BGW. TC on single game if xPts ≥ 10." },
      { category: "Bench",       rule: "Bench deprioritized. Budget freed for premium starters. Accept bench weakness for starting XI quality." },
      { category: "Transfers",   rule: "Price rise speculation allowed. Sell before form dips rather than waiting for certainty." },
    ],
  },
};

const CHIP_OPTIONS = [
  { id: "wildcard",       label: "Wildcard",       icon: "🃏", color: "#818cf8" },
  { id: "bench_boost",    label: "Bench Boost",    icon: "📈", color: "#34d399" },
  { id: "triple_captain", label: "Triple Captain", icon: "👑", color: "#fbbf24" },
  { id: "free_hit",       label: "Free Hit",       icon: "🎯", color: "#f472b6" },
];

export const DEFAULT_CONTEXT = {
  freeTransfers: 1,
  chips: ["bench_boost", "triple_captain"],
  riskPosture: "balanced",
  benchPoints: 9,
  injuries: [{ player: "Haaland", status: "DOUBTFUL", chance: 65 }],
  notes: "",
};

export const DEFAULT_HEADER = {
  kicker: "◆ FPL SAGE 2.0 ◆ DECISION ENGINE",
  title: "GW28 Context Layer",
  deadline: "Deadline: Tue 24 Feb · 18:30 UTC",
};

const PRIORITY_CONFIG = {
  URGENT: { color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
  HIGH:   { color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  MEDIUM: { color: "#eab308", bg: "rgba(234,179,8,0.12)" },
  LOW:    { color: "#22c55e", bg: "rgba(34,197,94,0.12)" },
  DEPLOY: { color: "#a855f7", bg: "rgba(168,85,247,0.12)" },
  MONITOR:{ color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  HOLD:   { color: "#475569", bg: "rgba(71,85,105,0.12)" },
};

// ─── Mock engine output ──────────────────────────────────────────────────────
function generateReasoning(context) {
  const posture = RISK_POSTURE_MAP[context.riskPosture];
  const chips = Array.isArray(context.chips) ? context.chips : [];
  const hasChips = chips.length > 0;
  const hasBB = chips.includes("bench_boost");
  const hasTC = chips.includes("triple_captain");
  const hasWC = chips.includes("wildcard");
  const hasFH = chips.includes("free_hit");

  const factors = [];
  const decisions = [];
  const chipRecs = [];

  // Transfer logic
  if (context.freeTransfers === 0) {
    factors.push({ signal: "Transfer bank", value: "EMPTY", note: "Any move costs 4pts" });
    if (context.riskPosture === "conservative") decisions.push({ action: "HOLD", detail: "Conservative mode: no hits. Hold until free transfer regenerates." });
    if (context.riskPosture === "balanced") decisions.push({ action: "HOLD", detail: "No free transfers. Only transfer if gain > 8pts net of hit cost." });
    if (context.riskPosture === "aggressive") decisions.push({ action: "CONSIDER HIT", detail: "Aggressive mode: 1 hit acceptable if squad misaligned with fixtures and EV gain ≥ 5pts." });
  } else {
    factors.push({ signal: "Free transfers", value: context.freeTransfers, note: `${context.freeTransfers > 1 ? "Can chain moves" : "1 surgical transfer"}` });
    decisions.push({ action: "TRANSFER AVAILABLE", detail: `${context.freeTransfers} free ${context.freeTransfers === 1 ? "transfer" : "transfers"} available. ${posture.behaviors.find(b => b.category === "Transfers")?.rule}` });
  }

  // Risk posture effect on captain
  const captainBehavior = posture.behaviors.find(b => b.category === "Captain");
  factors.push({ signal: "Captain strategy", value: posture.label.toUpperCase(), note: captainBehavior?.rule });

  // Chip sequencing
  if (hasChips) {
    if (hasWC && hasBB) chipRecs.push({ chip: "Wildcard → Bench Boost", rec: "SEQUENCE", detail: "Use WC to build DGW-optimised squad, then deploy BB in the same or next DGW. Highest combined EV." });
    if (hasBB && !hasWC) chipRecs.push({ chip: "Bench Boost", rec: "MONITOR", detail: "Hold for DGW with 3+ bench players covering double fixtures. Target GW33 window." });
    if (hasTC) {
      if (context.riskPosture === "aggressive") chipRecs.push({ chip: "Triple Captain", rec: "MONITOR", detail: "Aggressive: consider TC on elite player in a strong single-game fixture if xPts ≥ 10. Don't wait exclusively for DGW." });
      else chipRecs.push({ chip: "Triple Captain", rec: "HOLD", detail: "Standard: TC most valuable in DGW on a premium. Wait for confirmed double fixture." });
    }
    if (hasFH) chipRecs.push({ chip: "Free Hit", rec: "HOLD", detail: "Reserve for heavy BGW (3+ starters blanking) or offensive DGW pivot. Do not burn on a manageable week." });

    // Injury overrides affect chip urgency
    const outPlayers = context.injuries.filter(i => i.status === "OUT");
    if (outPlayers.length >= 2 && hasWC) {
      chipRecs.unshift({ chip: "Wildcard", rec: "ELEVATED", detail: `${outPlayers.length} injury overrides active. WC threshold lowering — squad health deteriorating.` });
    }
  }

  // Bench points logic
  if (context.benchPoints > 0) {
    const bbBehavior = context.benchPoints >= 12 ? "HIGH bench score — BB deserves serious consideration this GW." : context.benchPoints >= 8 ? "Decent bench return. Monitor for DGW before deploying BB." : "Low bench score. BB would have underdelivered. Rebuild bench depth first.";
    factors.push({ signal: "Bench pts (last GW)", value: context.benchPoints, note: bbBehavior });
  }

  return { factors, decisions, chipRecs };
}

function buildSummary(context, reasoning) {
  const posture = RISK_POSTURE_MAP[context.riskPosture];
  const deploys = reasoning.chipRecs.filter(c => c.rec === "DEPLOY" || c.rec === "ELEVATED" || c.rec === "SEQUENCE");
  const monitors = reasoning.chipRecs.filter(c => c.rec === "MONITOR");
  const chips = Array.isArray(context.chips) ? context.chips : [];
  const activeInjuries = (context.injuries || []).filter(i => i.status === "OUT" || i.status === "DOUBTFUL");

  let verdict = "HOLD & MONITOR";
  let verdictColor = "#475569";
  let lines = [];

  if (deploys.length > 0) {
    verdict = "CHIP ACTION RECOMMENDED";
    verdictColor = "#a855f7";
    lines.push(`${deploys[0].chip} flagged for deployment — ${deploys[0].detail}`);
  } else if (context.freeTransfers >= 2) {
    verdict = "TRANSFER WINDOW OPEN";
    verdictColor = "#f59e0b";
    lines.push(`${context.freeTransfers} free transfers banked. ${posture.tagline}`);
  }

  if (activeInjuries.length > 0) {
    lines.push(`${activeInjuries.length} active injury override${activeInjuries.length > 1 ? "s" : ""} in play — factor into transfer priority.`);
  }

  if (chips.length > 0) {
    lines.push(`${chips.length} chip${chips.length > 1 ? "s" : ""} available — evaluated against ${posture.label.toLowerCase()} posture thresholds.`);
  }

  lines.push(`${posture.icon} ${posture.label} posture: ${posture.tagline}`);

  return { verdict, verdictColor, lines };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function GlassCard({ children, style = {}, accentColor }) {
  return (
    <div style={{
      background: "rgba(10,14,26,0.75)",
      border: `1px solid ${accentColor || "rgba(255,255,255,0.07)"}`,
      borderRadius: 10,
      backdropFilter: "blur(16px)",
      padding: "16px 18px",
      ...style,
    }}>
      {children}
    </div>
  );
}

function Label({ children, style = {} }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.12em",
      color: "#334155", textTransform: "uppercase", marginBottom: 8,
      ...style,
    }}>{children}</div>
  );
}

function Badge({ label, color, bg }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
      padding: "2px 7px", borderRadius: 3,
      color, background: bg, border: `1px solid ${color}40`,
    }}>{label}</span>
  );
}

// ─── Risk Posture Selector ────────────────────────────────────────────────────
function RiskPostureSelector({ value, onChange }) {
  const [expanded, setExpanded] = useState(null);

  return (
    <div>
      <Label>Risk Posture</Label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {Object.entries(RISK_POSTURE_MAP).map(([key, cfg]) => {
          const isActive = value === key;
          const isExpanded = expanded === key;

          return (
            <div key={key} style={{
              border: `1px solid ${isActive ? cfg.border : "rgba(255,255,255,0.06)"}`,
              borderRadius: 8,
              background: isActive ? cfg.bg : "rgba(255,255,255,0.02)",
              overflow: "hidden",
              transition: "all 0.2s",
            }}>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer" }}
                onClick={() => onChange(key)}>
                <div style={{
                  width: 18, height: 18, borderRadius: "50%",
                  border: `2px solid ${isActive ? cfg.color : "rgba(255,255,255,0.2)"}`,
                  background: isActive ? cfg.color : "transparent",
                  flexShrink: 0, transition: "all 0.15s",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {isActive && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: isActive ? cfg.color : "#94a3b8" }}>
                  {cfg.icon} {cfg.label}
                </span>
                <span style={{ fontSize: 11, color: "#475569", flex: 1 }}>{cfg.tagline}</span>
                <button
                  onClick={e => { e.stopPropagation(); setExpanded(isExpanded ? null : key); }}
                  style={{
                    background: "none", border: "none", color: "#475569",
                    cursor: "pointer", fontSize: 11, padding: "0 4px",
                  }}>
                  {isExpanded ? "▲ hide" : "▼ rules"}
                </button>
              </div>

              {/* Expanded behavior map */}
              {isExpanded && (
                <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", padding: "10px 12px 12px" }}>
                  <div style={{ fontSize: 10, color: "#334155", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                    What changes at this posture:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {cfg.behaviors.map((b, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", flexShrink: 0,
                          color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`,
                          padding: "1px 5px", borderRadius: 3, marginTop: 1,
                        }}>{b.category.toUpperCase()}</span>
                        <span style={{ fontSize: 11, color: "#64748b", lineHeight: 1.5 }}>{b.rule}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chip Multi-Select ────────────────────────────────────────────────────────
function ChipMultiSelect({ selected, onChange }) {
  const toggle = (id) => {
    onChange(selected.includes(id) ? selected.filter(c => c !== id) : [...selected, id]);
  };

  return (
    <div>
      <Label>Available Chips <span style={{ color: "#334155", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— select all you have</span></Label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {CHIP_OPTIONS.map(chip => {
          const isOn = selected.includes(chip.id);
          return (
            <button key={chip.id} onClick={() => toggle(chip.id)} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "9px 12px", borderRadius: 8, cursor: "pointer",
              background: isOn ? `${chip.color}14` : "rgba(255,255,255,0.02)",
              border: `1px solid ${isOn ? chip.color + "50" : "rgba(255,255,255,0.07)"}`,
              transition: "all 0.15s",
            }}>
              <div style={{
                width: 14, height: 14, borderRadius: 3,
                border: `2px solid ${isOn ? chip.color : "rgba(255,255,255,0.2)"}`,
                background: isOn ? chip.color : "transparent",
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.15s",
              }}>
                {isOn && <span style={{ color: "#000", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
              </div>
              <span style={{ fontSize: 12 }}>{chip.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: isOn ? chip.color : "#64748b" }}>{chip.label}</span>
            </button>
          );
        })}
      </div>
      {selected.length === 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#334155" }}>
          No chips selected — all chip guidance suppressed in analysis.
        </div>
      )}
    </div>
  );
}

// ─── Injury Overrides ────────────────────────────────────────────────────────
function InjuryOverrides({ injuries, onChange }) {
  const inputStyle = {
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6, color: "#e2e8f0", padding: "6px 9px", fontSize: 12,
    outline: "none", width: "100%", fontFamily: "inherit",
  };

  const update = (i, field, val) => onChange(injuries.map((inj, idx) => idx === i ? { ...inj, [field]: val } : inj));
  const add = () => onChange([...injuries, { player: "", status: "DOUBTFUL", chance: 75 }]);
  const remove = (i) => onChange(injuries.filter((_, idx) => idx !== i));

  const statusColors = { FIT: "#22c55e", DOUBTFUL: "#f59e0b", OUT: "#ef4444" };

  return (
    <div>
      <Label>Injury Overrides <span style={{ color: "#334155", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>— what the API doesn't know yet</span></Label>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {injuries.map((inj, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto",
            gap: 6, alignItems: "center",
            padding: "8px 10px",
            background: "rgba(255,255,255,0.02)",
            border: `1px solid ${statusColors[inj.status] || "#334155"}22`,
            borderLeft: `3px solid ${statusColors[inj.status] || "#334155"}`,
            borderRadius: 6,
          }}>
            <input placeholder="Player name" value={inj.player}
              onChange={e => update(i, "player", e.target.value)}
              style={inputStyle} />
            <select value={inj.status} onChange={e => update(i, "status", e.target.value)}
              style={{ ...inputStyle, color: statusColors[inj.status] }}>
              {["FIT", "DOUBTFUL", "OUT"].map(s => <option key={s}>{s}</option>)}
            </select>
            <div style={{ position: "relative" }}>
              <input type="number" value={inj.chance} min={0} max={100}
                onChange={e => update(i, "chance", +e.target.value)}
                style={{ ...inputStyle, paddingRight: 24 }} />
              <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "#475569" }}>%</span>
            </div>
            <button onClick={() => remove(i)} style={{
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
              color: "#ef4444", borderRadius: 5, padding: "5px 8px", cursor: "pointer", fontSize: 11,
            }}>✕</button>
          </div>
        ))}
        <button onClick={add} style={{
          background: "none", border: "1px dashed rgba(255,255,255,0.1)",
          color: "#334155", borderRadius: 6, padding: "7px 12px", cursor: "pointer",
          fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textAlign: "left",
          transition: "all 0.15s",
        }}>+ Add player override</button>
      </div>
    </div>
  );
}

// ─── Reasoning Panel ──────────────────────────────────────────────────────────
function ReasoningPanel({ context }) {
  const reasoning = generateReasoning(context);
  const summary = buildSummary(context, reasoning);
  const posture = RISK_POSTURE_MAP[context.riskPosture];

  return (
    <GlassCard accentColor={`${posture.color}30`} style={{ gridColumn: "1 / -1" }}>
      {/* Summary bar */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "flex-start",
        padding: "10px 14px", borderRadius: 7, marginBottom: 14,
        background: `${summary.verdictColor}10`,
        border: `1px solid ${summary.verdictColor}25`,
        borderLeft: `4px solid ${summary.verdictColor}`,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: summary.verdictColor, letterSpacing: "0.02em", marginBottom: 5 }}>
            {summary.verdict}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {summary.lines.map((l, i) => (
              <div key={i} style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                {i === 0 ? "→ " : "· "}{l}
              </div>
            ))}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 16 }}>
          <div style={{ fontSize: 9, color: "#334155", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Posture</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: posture.color }}>{posture.icon} {posture.label}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Signals */}
        <div>
          <Label>Input Signals</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {reasoning.factors.map((f, i) => (
              <div key={i} style={{
                display: "flex", gap: 8, alignItems: "flex-start",
                padding: "7px 10px", background: "rgba(255,255,255,0.02)",
                borderRadius: 6, border: "1px solid rgba(255,255,255,0.04)",
              }}>
                <span style={{ fontSize: 10, color: "#475569", minWidth: 100, flexShrink: 0, marginTop: 1 }}>{f.signal}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", flexShrink: 0 }}>{f.value}</span>
                <span style={{ fontSize: 11, color: "#475569", lineHeight: 1.4 }}>{f.note}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Decisions + Chip recs */}
        <div>
          <Label>Derived Decisions</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {reasoning.decisions.map((d, i) => {
              const actionColor = d.action.includes("HOLD") ? "#475569" : d.action.includes("AVAILABLE") ? "#f59e0b" : d.action.includes("HIT") ? "#ef4444" : "#22c55e";
              return (
                <div key={i} style={{
                  padding: "7px 10px", background: "rgba(255,255,255,0.02)",
                  borderRadius: 6, borderLeft: `3px solid ${actionColor}`,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: actionColor, marginBottom: 3, letterSpacing: "0.07em" }}>{d.action}</div>
                  <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4 }}>{d.detail}</div>
                </div>
              );
            })}

            {reasoning.chipRecs.length > 0 && (
              <>
                <Label style={{ marginTop: 8 }}>Chip Guidance</Label>
                {reasoning.chipRecs.map((c, i) => {
                  const cfg = PRIORITY_CONFIG[c.rec] || PRIORITY_CONFIG.HOLD;
                  return (
                    <div key={i} style={{
                      padding: "7px 10px", background: cfg.bg,
                      borderRadius: 6, border: `1px solid ${cfg.color}25`,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8" }}>{c.chip}</span>
                        <Badge label={c.rec} color={cfg.color} bg={cfg.bg} />
                      </div>
                      <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4 }}>{c.detail}</div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Posture rules footer */}
      <div style={{
        marginTop: 14, paddingTop: 12,
        borderTop: "1px solid rgba(255,255,255,0.05)",
      }}>
        <Label>Active Posture Rules — {posture.label}</Label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {posture.behaviors.map((b, i) => (
            <div key={i} style={{
              fontSize: 11, color: "#475569",
              padding: "4px 9px", background: posture.bg,
              border: `1px solid ${posture.border}`,
              borderRadius: 4,
            }}>
              <span style={{ color: posture.color, fontWeight: 700 }}>{b.category}: </span>
              {b.rule}
            </div>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}

// ─── Context Editor (main panel) ──────────────────────────────────────────────
function ContextEditor({ context, onChange }) {
  const update = (key, val) => onChange({ ...context, [key]: val });

  const inputStyle = {
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6, color: "#e2e8f0", padding: "6px 9px", fontSize: 12,
    outline: "none", width: "100%", fontFamily: "inherit",
  };

  return (
    <GlassCard accentColor="rgba(168,85,247,0.2)" style={{ gridColumn: "1 / -1" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", boxShadow: "0 0 8px #a855f7" }} />
        <Label style={{ marginBottom: 0 }}>Manual Context</Label>
        <span style={{ fontSize: 10, color: "#334155" }}>— what neither API provides</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {/* Col 1 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Free Transfers */}
          <div>
            <Label>Free Transfers</Label>
            <div style={{ display: "flex", gap: 4 }}>
              {[0, 1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => update("freeTransfers", n)} style={{
                  flex: 1, padding: "7px 0", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer",
                  background: context.freeTransfers === n ? "#a855f7" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${context.freeTransfers === n ? "#a855f7" : "rgba(255,255,255,0.08)"}`,
                  color: context.freeTransfers === n ? "#fff" : "#475569",
                  transition: "all 0.15s",
                }}>{n}</button>
              ))}
            </div>
          </div>

          {/* Bench pts */}
          <div>
            <Label>Bench Pts — Last GW</Label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="range" min={0} max={30} value={context.benchPoints}
                onChange={e => update("benchPoints", +e.target.value)}
                style={{ flex: 1, accentColor: "#a855f7" }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", minWidth: 28, textAlign: "right" }}>
                {context.benchPoints}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "#334155", marginTop: 3 }}>
              {context.benchPoints >= 12 ? "🟢 Strong — BB deserves consideration" :
               context.benchPoints >= 8  ? "🟡 Decent — build toward DGW window" :
                                           "🔴 Weak — rebuild bench depth first"}
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label>Strategy Notes</Label>
            <textarea value={context.notes} rows={3}
              onChange={e => update("notes", e.target.value)}
              placeholder="e.g. Holding WC for GW32 DGW setup. Keeping Salah regardless."
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
          </div>
        </div>

        {/* Col 2 — Risk Posture */}
        <div>
          <RiskPostureSelector value={context.riskPosture} onChange={v => update("riskPosture", v)} />
        </div>

        {/* Col 3 — Chips + Injuries */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <ChipMultiSelect selected={context.chips} onChange={v => update("chips", v)} />
          <InjuryOverrides injuries={context.injuries} onChange={v => update("injuries", v)} />
        </div>
      </div>
    </GlassCard>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export function FPLSageContextLayer({
  value,
  onChange,
  initialValue = DEFAULT_CONTEXT,
  header = DEFAULT_HEADER,
  showReasoning: showReasoningProp,
  onToggleReasoning,
  maxWidth = 1060,
}) {
  const [internalContext, setInternalContext] = useState(initialValue);
  const [internalShowReasoning, setInternalShowReasoning] = useState(true);

  const context = value || internalContext;
  const showReasoning = typeof showReasoningProp === "boolean" ? showReasoningProp : internalShowReasoning;

  const setContext = useCallback((next) => {
    if (!value) setInternalContext(next);
    if (onChange) onChange(next);
  }, [value, onChange]);

  const toggleReasoning = useCallback(() => {
    if (typeof showReasoningProp !== "boolean") {
      setInternalShowReasoning(prev => !prev);
    }
    if (onToggleReasoning) onToggleReasoning();
  }, [showReasoningProp, onToggleReasoning]);

  const [pulse, setPulse] = useState(false);

  // Pulse when context changes to indicate re-evaluation
  useEffect(() => {
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 600);
    return () => clearTimeout(t);
  }, [context]);

  const posture = RISK_POSTURE_MAP[context.riskPosture];

  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(ellipse at 15% 15%, rgba(168,85,247,0.07) 0%, transparent 45%), radial-gradient(ellipse at 85% 85%, rgba(249,115,22,0.05) 0%, transparent 45%), #080c18",
      fontFamily: "'DM Mono', 'Fira Code', 'Courier New', monospace",
      color: "#e2e8f0",
      padding: "24px",
    }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 10, color: "#334155", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 5 }}>
            {header.kicker}
          </div>
          <h1 style={{
            margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em",
            color: "#e2e8f0",
          }}>
            {header.title}
          </h1>
          <div style={{ marginTop: 3, fontSize: 11, color: "#334155" }}>
            {header.deadline}
            {" · "}
            <span style={{
              color: posture.color,
              transition: "color 0.3s",
            }}>
              {posture.icon} {posture.label} posture active
            </span>
          </div>
        </div>
        <button
          onClick={toggleReasoning}
          style={{
            background: showReasoning ? "rgba(168,85,247,0.12)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${showReasoning ? "rgba(168,85,247,0.4)" : "rgba(255,255,255,0.08)"}`,
            color: showReasoning ? "#a855f7" : "#475569",
            borderRadius: 7, padding: "8px 14px", cursor: "pointer",
            fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
            transition: "all 0.2s",
          }}>
          {showReasoning ? "▲ Hide Reasoning" : "▼ Show Reasoning"}
        </button>
      </div>

      {/* Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, maxWidth }}>
        {/* Context Editor */}
        <ContextEditor context={context} onChange={setContext} />

        {/* Reasoning + Summary */}
        {showReasoning && (
          <div style={{
            opacity: pulse ? 0.7 : 1,
            transition: "opacity 0.3s",
          }}>
            <ReasoningPanel context={context} />
          </div>
        )}
      </div>

      {/* Footer source tags */}
      <div style={{ marginTop: 14, display: "flex", gap: 8, maxWidth }}>
        {[
          { label: "FPL Sage Engine", status: "live", port: "8001" },
          { label: "Captain Model", status: "live", version: "v1.0" },
          { label: "Context Layer", status: `${(context.chips || []).length} chips · ${(context.injuries || []).length} overrides`, highlight: true },
        ].map((s, i) => (
          <div key={i} style={{
            flex: 1, padding: "10px 14px",
            background: "rgba(10,14,26,0.7)", border: "1px solid rgba(255,255,255,0.05)",
            borderRadius: 8,
          }}>
            <div style={{ fontSize: 10, color: "#334155", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
              Source {i + 1}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>{s.label}</div>
            <div style={{ marginTop: 4, display: "flex", gap: 5, alignItems: "center" }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: s.highlight ? "#f59e0b" : "#22c55e" }} />
              <span style={{ fontSize: 10, color: s.highlight ? "#f59e0b" : "#22c55e" }}>
                {s.status}{s.port ? ` · port ${s.port}` : ""}{s.version ? ` · ${s.version}` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FPLSage2Dashboard() {
  return <FPLSageContextLayer />;
}
