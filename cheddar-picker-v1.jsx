import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// CHEDDAR LOGIC — SIGNAL ENGINE + DYNAMIC SCHEDULER + MULTI-DESTINATION PUBLISHER
// Stack: The Odds API → Signal Scorer → Post Timer → Cheddar UI + Discord
// ═══════════════════════════════════════════════════════════════════════════════

// ── SPORT CONFIG ──────────────────────────────────────────────────────────────
// Each sport has its own slate window and posting logic.
// Earliest game determines post time — we publish 90min before first lock.

const SPORT_CONFIG = {
  NBA: {
    key: "basketball_nba",
    color: "#C9082A",
    icon: "🏀",
    typicalGameTimes: ["12:00", "13:00", "14:30", "17:00", "19:00", "19:30", "20:00", "22:00"],
    minPostHour: 12,
    maxPostHour: 16,
    bufferMinutes: 90, // post 90min before first game
    leagues: ["NBA"],
  },
  MLB: {
    key: "baseball_mlb",
    color: "#002D72",
    icon: "⚾",
    typicalGameTimes: ["13:05", "13:10", "13:35", "16:05", "19:05", "19:10", "19:35", "20:05"],
    minPostHour: 12,
    maxPostHour: 16,
    bufferMinutes: 90,
    leagues: ["MLB"],
  },
  NHL: {
    key: "icehockey_nhl",
    color: "#000000",
    icon: "🏒",
    typicalGameTimes: ["12:00", "14:00", "17:00", "19:00", "19:30", "20:00", "22:00"],
    minPostHour: 12,
    maxPostHour: 16,
    bufferMinutes: 90,
    leagues: ["NHL"],
  },
};

// ── SIGNAL SCORING ENGINE ─────────────────────────────────────────────────────
// In production: calls The Odds API for live lines, then scores each game.
// Signal = value bet detection via line discrepancy + implied prob edge.

const SIGNAL_WEIGHTS = {
  lineValue: 0.40,      // Core edge — our prob vs market implied prob
  marketConsensus: 0.25, // How many books agree on this line
  lineMovement: 0.20,   // Line moved in our favor (sharp signal)
  publicFade: 0.15,     // Fading heavy public side (contrarian edge)
};

// Simulate Odds API response structure (real call: GET /v4/sports/{sport}/odds)
const simulateOddsAPIResponse = (sport, numGames) => {
  const teamsByLeague = {
    NBA: [
      ["Boston Celtics","Miami Heat"],["LA Lakers","Golden State Warriors"],
      ["Denver Nuggets","Phoenix Suns"],["Milwaukee Bucks","Cleveland Cavaliers"],
      ["Oklahoma City Thunder","Dallas Mavericks"],["New York Knicks","Philadelphia 76ers"],
    ],
    MLB: [
      ["New York Yankees","Boston Red Sox"],["LA Dodgers","San Francisco Giants"],
      ["Houston Astros","Texas Rangers"],["Atlanta Braves","New York Mets"],
      ["Chicago Cubs","St. Louis Cardinals"],["Toronto Blue Jays","Baltimore Orioles"],
    ],
    NHL: [
      ["Boston Bruins","Toronto Maple Leafs"],["Edmonton Oilers","Calgary Flames"],
      ["Colorado Avalanche","Dallas Stars"],["New York Rangers","New Jersey Devils"],
      ["Vegas Golden Knights","LA Kings"],["Tampa Bay Lightning","Florida Panthers"],
    ],
  };

  const teams = teamsByLeague[sport];
  const games = [];
  const config = SPORT_CONFIG[sport];

  for (let i = 0; i < numGames; i++) {
    const pair = teams[i % teams.length];
    const gameTimeStr = config.typicalGameTimes[i % config.typicalGameTimes.length];
    const [h, m] = gameTimeStr.split(":").map(Number);

    // Simulate book lines — spread and moneyline for both sides
    const trueSpread = (Math.random() * 10 - 5).toFixed(1);
    const homeSpread = parseFloat(trueSpread);
    const awaySpread = -homeSpread;
    const homeML = homeSpread < 0
      ? -(100 + Math.abs(homeSpread) * 12) // favorite
      : (100 + Math.abs(homeSpread) * 10);  // underdog
    const awayML = -homeML;

    // Simulate 5 books with slight variance (how real odds API looks)
    const books = Array.from({ length: 5 }, (_, b) => ({
      bookmaker: ["DraftKings","FanDuel","BetMGM","Caesars","PointsBet"][b],
      homeSpread: homeSpread + (Math.random() * 1 - 0.5).toFixed(1) * 1,
      homeML: homeML + Math.round(Math.random() * 10 - 5),
      awaySpread: awaySpread + (Math.random() * 1 - 0.5).toFixed(1) * -1,
      awayML: awayML + Math.round(Math.random() * 10 - 5),
    }));

    // Line movement simulation (positive = moved toward home)
    const lineMovement = (Math.random() * 3 - 1.5).toFixed(1);

    // Public betting % (>60% = heavy public side)
    const homePublicPct = Math.round(Math.random() * 70 + 20);

    games.push({
      id: `${sport}-game-${i}`,
      sport,
      homeTeam: pair[0],
      awayTeam: pair[1],
      gameHour: h,
      gameMin: m,
      gameTimeStr,
      books,
      avgHomeSpread: homeSpread,
      avgHomeML: homeML,
      lineMovement: parseFloat(lineMovement),
      homePublicPct,
      awayPublicPct: 100 - homePublicPct,
    });
  }
  return games;
};

// Score a single game, return best side + score breakdown
const scoreGame = (game) => {
  const { books, avgHomeSpread, avgHomeML, lineMovement, homePublicPct } = game;

  // 1. Line Value: find discrepancy across books
  const spreads = books.map(b => b.homeSpread);
  const maxSpread = Math.max(...spreads);
  const minSpread = Math.min(...spreads);
  const lineDiscrepancy = Math.abs(maxSpread - minSpread);
  const lineValueScore = Math.min(lineDiscrepancy / 3, 1); // normalize 0-1

  // 2. Market Consensus: tight consensus = reliable line
  const consensusScore = 1 - lineValueScore; // inverse of discrepancy

  // 3. Line Movement: moved away from public = sharp
  const lineMovementScore = Math.abs(lineMovement) / 3;

  // 4. Public Fade: >65% public on one side = contrarian value
  const heavyPublicSide = homePublicPct > 65 ? "away" : homePublicPct < 35 ? "home" : null;
  const publicFadeScore = heavyPublicSide
    ? (Math.abs(homePublicPct - 50) / 50)
    : 0.2;

  const totalScore = (
    lineValueScore * SIGNAL_WEIGHTS.lineValue +
    consensusScore * SIGNAL_WEIGHTS.marketConsensus +
    lineMovementScore * SIGNAL_WEIGHTS.lineMovement +
    publicFadeScore * SIGNAL_WEIGHTS.publicFade
  );

  // Determine best side
  const fadeHome = heavyPublicSide === "home" && lineMovement < 0;
  const recommendedSide = fadeHome ? "away" : "home";
  const recommendedTeam = recommendedSide === "home" ? game.homeTeam : game.awayTeam;
  const recommendedML = recommendedSide === "home" ? avgHomeML : -avgHomeML;
  const recommendedSpread = recommendedSide === "home"
    ? avgHomeSpread
    : -avgHomeSpread;

  // Convert ML to implied prob
  const impliedProb = recommendedML < 0
    ? Math.abs(recommendedML) / (Math.abs(recommendedML) + 100)
    : 100 / (recommendedML + 100);

  // Our edge: model win prob vs implied
  const modelWinProb = impliedProb + (totalScore * 0.08); // edge on top

  // Kelly fraction
  const b = recommendedML > 0 ? recommendedML / 100 : 100 / Math.abs(recommendedML);
  const q = 1 - modelWinProb;
  const kelly = Math.max(0, (b * modelWinProb - q) / b);
  const quarterKelly = kelly * 0.25;

  // Signal type
  let signalType = "Model Edge";
  if (lineMovementScore > 0.5 && heavyPublicSide) signalType = "Reverse Line Move";
  else if (lineMovementScore > 0.4) signalType = "Sharp Money";
  else if (publicFadeScore > 0.5) signalType = "Public Fade";
  else if (lineDiscrepancy > 1.5) signalType = "Book Discrepancy";

  const confidenceLabel =
    totalScore > 0.68 ? "ELITE" :
    totalScore > 0.54 ? "HIGH" :
    totalScore > 0.42 ? "SOLID" : "WEAK";

  return {
    ...game,
    recommendedTeam,
    recommendedSide,
    recommendedML,
    recommendedSpread,
    impliedProb,
    modelWinProb,
    quarterKelly,
    totalScore,
    confidenceLabel,
    signalType,
    scoreBreakdown: {
      lineValue: lineValueScore,
      consensus: consensusScore,
      lineMovement: lineMovementScore,
      publicFade: publicFadeScore,
    },
    lineDiscrepancy,
    heavyPublicSide,
  };
};

// ── DYNAMIC SCHEDULER ─────────────────────────────────────────────────────────
// Determines post time per sport based on earliest game lock.
// Returns scheduled post time as HH:MM string.

const getPostTime = (games, sport) => {
  if (!games.length) return null;
  const config = SPORT_CONFIG[sport];

  // Find earliest game today
  const earliest = games.reduce((min, g) =>
    g.gameHour * 60 + g.gameMin < min.gameHour * 60 + min.gameMin ? g : min
  );

  // Post = earliest game - buffer, clamped to [12:00, 16:00]
  let postMin = earliest.gameHour * 60 + earliest.gameMin - config.bufferMinutes;
  const minPost = config.minPostHour * 60;
  const maxPost = config.maxPostHour * 60;
  postMin = Math.max(minPost, Math.min(maxPost, postMin));

  const h = Math.floor(postMin / 60);
  const m = postMin % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
};

// ── DISCORD FORMATTER ─────────────────────────────────────────────────────────
// Formats the play for Discord embed (simulated — production uses webhook POST)

const formatDiscordMessage = (play, bankroll, wager) => {
  const sportEmoji = SPORT_CONFIG[play.sport]?.icon || "🎯";
  const ml = play.recommendedML > 0 ? `+${play.recommendedML}` : `${play.recommendedML}`;
  const spread = play.recommendedSpread > 0 ? `+${play.recommendedSpread}` : `${play.recommendedSpread}`;

  return `**🧀 CHEDDAR LOGIC — DAY ${play.dayNumber} PLAY**
━━━━━━━━━━━━━━━━━━━━━━
${sportEmoji} **${play.homeTeam} vs ${play.awayTeam}**
📌 **${play.recommendedTeam}** · Spread ${spread} · ML ${ml}
🔍 Signal: ${play.signalType}
📊 Confidence: ${play.confidenceLabel} (${(play.totalScore * 100).toFixed(0)}/100)
💰 Wager: $${wager.toFixed(2)} of $${bankroll.toFixed(2)} bankroll
📈 Model Edge: ${((play.modelWinProb - play.impliedProb) * 100).toFixed(1)}%
━━━━━━━━━━━━━━━━━━━━━━
*One play. One day. Build the roll.* 🧀`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:wght@400;700&family=Barlow+Condensed:wght@300;400;600;700;900&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #080c10;
    --surface: #0d1318;
    --surface2: #111820;
    --border: #1c2630;
    --border2: #243040;
    --text: #dce8f0;
    --muted: #4a6070;
    --dim: #2a3a48;
    --gold: #f0b840;
    --green: #20e870;
    --red: #ff3d55;
    --nba: #C9082A;
    --mlb: #3a6bc4;
    --nhl: #8ab4cc;
  }

  body { background: var(--bg); font-family: 'Barlow Condensed', sans-serif; }

  .shell {
    max-width: 500px;
    margin: 0 auto;
    min-height: 100vh;
    background: var(--bg);
    position: relative;
  }

  /* Scanline texture */
  .shell::before {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.03) 2px,
      rgba(0,0,0,0.03) 4px
    );
    pointer-events: none;
    z-index: 100;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: rgba(8,12,16,0.95);
    backdrop-filter: blur(12px);
    z-index: 10;
  }

  .wordmark {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 28px;
    letter-spacing: 4px;
    color: var(--gold);
  }

  .wordmark span {
    color: var(--text);
    opacity: 0.3;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 5px 12px;
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 1px;
  }

  .status-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--green);
    animation: blink 2s ease infinite;
  }

  @keyframes blink {
    0%,100% { opacity: 1; }
    50% { opacity: 0.2; }
  }

  .content { padding: 0 16px 40px; }

  /* ── Sport Selector ── */
  .sport-row {
    display: flex;
    gap: 8px;
    padding: 16px 0 12px;
  }

  .sport-btn {
    flex: 1;
    padding: 10px 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    font-family: 'Bebas Neue', sans-serif;
    font-size: 16px;
    letter-spacing: 1px;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .sport-btn .icon { font-size: 18px; }
  .sport-btn .label { font-size: 13px; }

  .sport-btn.active {
    border-color: var(--gold);
    color: var(--gold);
    background: rgba(240,184,64,0.06);
  }

  /* ── Bankroll Strip ── */
  .bankroll-strip {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .br-left {}
  .br-label {
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .br-amount {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 44px;
    color: var(--green);
    line-height: 1;
    letter-spacing: 1px;
  }
  .br-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .br-stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .br-stat-val {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 20px;
    line-height: 1;
  }
  .br-stat-key {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    letter-spacing: 1px;
  }

  /* ── Scheduler Card ── */
  .sched-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px 18px;
    margin-bottom: 14px;
  }

  .sched-header {
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 14px;
  }

  .sched-timeline {
    position: relative;
    height: 40px;
    margin-bottom: 8px;
  }

  .timeline-track {
    position: absolute;
    top: 50%;
    left: 0; right: 0;
    height: 2px;
    background: var(--border);
    transform: translateY(-50%);
  }

  .timeline-window {
    position: absolute;
    top: 50%;
    height: 2px;
    background: var(--gold);
    transform: translateY(-50%);
    opacity: 0.4;
  }

  .timeline-marker {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .marker-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    border: 2px solid;
  }

  .marker-label {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    white-space: nowrap;
  }

  .sched-meta {
    display: flex;
    justify-content: space-between;
  }

  .sched-meta-item {
    display: flex;
    flex-direction: column;
  }

  .sched-meta-val {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 22px;
    color: var(--text);
    line-height: 1;
  }

  .sched-meta-key {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    letter-spacing: 1px;
    margin-top: 2px;
  }

  /* ── Signal Card ── */
  .signal-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: 14px;
  }

  .signal-sport-bar {
    height: 3px;
  }

  .signal-body { padding: 18px; }

  .signal-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 14px;
  }

  .signal-sport-tag {
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    letter-spacing: 2px;
    color: var(--muted);
  }

  .conf-badge {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 13px;
    letter-spacing: 1px;
    padding: 3px 10px;
    border-radius: 20px;
  }

  .signal-matchup {
    margin-bottom: 12px;
  }

  .matchup-away {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 300;
    font-size: 14px;
    color: var(--muted);
    letter-spacing: 1px;
    margin-bottom: 2px;
  }

  .matchup-home {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 900;
    font-size: 22px;
    color: var(--text);
    letter-spacing: 0.5px;
    line-height: 1.1;
  }

  .pick-row {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .pick-label {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    letter-spacing: 1px;
    margin-bottom: 4px;
  }

  .pick-team {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    font-size: 18px;
    color: var(--gold);
  }

  .pick-line {
    font-family: 'Space Mono', monospace;
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
  }

  .pick-signal {
    text-align: right;
  }

  .signal-type {
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--green);
    letter-spacing: 1px;
    margin-bottom: 4px;
  }

  .signal-score {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 32px;
    color: var(--text);
    line-height: 1;
  }

  /* Score breakdown bars */
  .breakdown {
    margin-bottom: 14px;
  }

  .breakdown-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 7px;
  }

  .bd-label {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    letter-spacing: 1px;
    width: 80px;
    flex-shrink: 0;
    text-transform: uppercase;
  }

  .bd-bar {
    flex: 1;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .bd-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  .bd-val {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    width: 28px;
    text-align: right;
    flex-shrink: 0;
  }

  /* Wager section */
  .wager-section {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 14px;
  }

  .wager-top {
    display: flex;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .wager-stat { display: flex; flex-direction: column; }

  .wager-val {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 26px;
    line-height: 1;
  }

  .wager-key {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    letter-spacing: 1px;
    margin-top: 2px;
  }

  .kelly-bar {
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .kelly-fill {
    height: 100%;
    background: var(--gold);
    border-radius: 2px;
    transition: width 0.5s ease;
  }

  /* Destinations */
  .dest-row {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
  }

  .dest-card {
    flex: 1;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    position: relative;
    overflow: hidden;
  }

  .dest-icon { font-size: 20px; }
  .dest-name {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    font-size: 13px;
    color: var(--text);
    letter-spacing: 1px;
  }
  .dest-status {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    letter-spacing: 1px;
  }

  .dest-card.sent { border-color: var(--green); }
  .dest-card.sent .dest-status { color: var(--green); }
  .dest-card.pending .dest-status { color: var(--muted); }
  .dest-card.sending { border-color: var(--gold); }
  .dest-card.sending .dest-status { color: var(--gold); }

  /* Discord preview */
  .discord-preview {
    background: #36393f;
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 14px;
    border-left: 4px solid var(--gold);
  }

  .discord-header {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: #72767d;
    letter-spacing: 1px;
    margin-bottom: 10px;
  }

  .discord-msg {
    font-family: 'Space Mono', monospace;
    font-size: 10px;
    color: #dcddde;
    line-height: 1.8;
    white-space: pre-wrap;
  }

  .discord-msg strong { color: #fff; }
  .discord-msg em { color: #72767d; font-style: normal; }

  /* Action button */
  .lock-btn {
    width: 100%;
    padding: 17px;
    background: var(--gold);
    color: #080c10;
    border: none;
    border-radius: 12px;
    font-family: 'Bebas Neue', sans-serif;
    font-size: 22px;
    letter-spacing: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .lock-btn:hover:not(:disabled) {
    background: #f5c840;
    transform: translateY(-1px);
  }

  .lock-btn:disabled {
    background: var(--surface2);
    color: var(--dim);
    cursor: not-allowed;
    letter-spacing: 2px;
    font-size: 16px;
  }

  /* History */
  .hist-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 8px;
  }

  .hist-sport { font-size: 18px; flex-shrink: 0; }

  .hist-body { flex: 1; }
  .hist-team {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    font-size: 15px;
    color: var(--text);
  }
  .hist-meta {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    letter-spacing: 1px;
    margin-top: 2px;
  }

  .hist-result {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .hist-pnl {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 22px;
    line-height: 1;
  }
  .hist-br {
    font-family: 'Space Mono', monospace;
    font-size: 8px;
    color: var(--muted);
    margin-top: 1px;
  }

  .sec-label {
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 3px;
    text-transform: uppercase;
    margin: 18px 0 10px;
  }

  .next-day-btn {
    width: 100%;
    padding: 13px;
    background: transparent;
    border: 1px solid var(--border2);
    border-radius: 10px;
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 2px;
    cursor: pointer;
    text-transform: uppercase;
    transition: all 0.15s;
    margin-top: 12px;
  }

  .next-day-btn:hover {
    border-color: var(--gold);
    color: var(--gold);
  }

  .tab-row {
    display: flex;
    gap: 4px;
    margin: 12px 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
  }

  .tab-btn {
    flex: 1;
    padding: 8px;
    background: transparent;
    border: none;
    border-radius: 7px;
    font-family: 'Space Mono', monospace;
    font-size: 9px;
    color: var(--muted);
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.15s;
    text-transform: uppercase;
  }

  .tab-btn.active {
    background: var(--surface2);
    color: var(--text);
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .fade-in { animation: fadeIn 0.3s ease forwards; }
`;

// ── TIME HELPERS ──
const pct12to4 = (h, m) => ((h * 60 + m - 720) / 240) * 100; // 12pm=0%, 4pm=100%

export default function CheddarLogicV2() {
  const [sport, setSport] = useState("NBA");
  const [bankroll, setBankroll] = useState(10.00);
  const [startingBankroll] = useState(10.00);
  const [dayNumber, setDayNumber] = useState(1);
  const [phase, setPhase] = useState("IDLE"); // IDLE | SCORING | READY | PUBLISHING | PUBLISHED | LOCKED
  const [candidates, setCandidates] = useState([]);
  const [bestPlay, setBestPlay] = useState(null);
  const [postTime, setPostTime] = useState(null);
  const [wager, setWager] = useState(0);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState("play");
  const [discordMsg, setDiscordMsg] = useState("");
  const [destStatus, setDestStatus] = useState({ dashboard: "pending", discord: "pending" });
  const timerRef = useRef(null);

  const runSignalEngine = () => {
    setPhase("SCORING");
    setTimeout(() => {
      const numGames = 4 + Math.floor(Math.random() * 3);
      const games = simulateOddsAPIResponse(sport, numGames);
      const scored = games.map(g => scoreGame(g));
      // Filter to only ELITE/HIGH confidence
      const qualified = scored.filter(g => g.confidenceLabel !== "WEAK");
      // Sort by score, pick best
      qualified.sort((a, b) => b.totalScore - a.totalScore);
      setCandidates(qualified);

      const best = qualified[0] || scored[0];
      const pt = getPostTime(games, sport);
      const kelly = best.quarterKelly;
      const w = Math.max(
        0.50,
        Math.min(parseFloat((bankroll * kelly).toFixed(2)), parseFloat((bankroll * 0.20).toFixed(2)))
      );

      const enriched = { ...best, dayNumber, sport };
      setBestPlay(enriched);
      setPostTime(pt);
      setWager(w);
      setDiscordMsg(formatDiscordMessage(enriched, bankroll, w));
      setPhase("READY");
    }, 1200);
  };

  const publishPlay = () => {
    setPhase("PUBLISHING");
    setDestStatus({ dashboard: "sending", discord: "sending" });

    setTimeout(() => setDestStatus(d => ({ ...d, dashboard: "sent" })), 600);
    setTimeout(() => setDestStatus(d => ({ ...d, discord: "sent" })), 1100);

    setTimeout(() => {
      // Simulate outcome
      const won = Math.random() < bestPlay.modelWinProb;
      const b = bestPlay.recommendedML > 0
        ? bestPlay.recommendedML / 100
        : 100 / Math.abs(bestPlay.recommendedML);
      const profit = won ? parseFloat((wager * b).toFixed(2)) : -wager;
      const newBankroll = parseFloat((bankroll + profit).toFixed(2));

      setHistory(h => [{
        day: dayNumber,
        sport,
        team: bestPlay.recommendedTeam,
        signal: bestPlay.signalType,
        confidence: bestPlay.confidenceLabel,
        wager,
        profit,
        won,
        bankrollAfter: newBankroll,
        postTime,
      }, ...h]);

      setBankroll(newBankroll);
      setPhase("PUBLISHED");
    }, 1600);
  };

  const nextDay = () => {
    setDayNumber(d => d + 1);
    setPhase("IDLE");
    setBestPlay(null);
    setCandidates([]);
    setDestStatus({ dashboard: "pending", discord: "pending" });
  };

  const roi = bankroll - startingBankroll;
  const roiPct = ((roi / startingBankroll) * 100).toFixed(1);
  const wins = history.filter(h => h.won).length;
  const winRate = history.length ? ((wins / history.length) * 100).toFixed(0) : null;

  const sportColor = SPORT_CONFIG[sport]?.color || "#f0b840";
  const confColor = bestPlay?.confidenceLabel === "ELITE" ? "#20e870"
    : bestPlay?.confidenceLabel === "HIGH" ? "#f0b840"
    : "#8ab4cc";

  return (
    <>
      <style>{css}</style>
      <div className="shell">
        {/* Topbar */}
        <div className="topbar">
          <div className="wordmark">CHEDDAR<span> LOGIC</span></div>
          <div className="status-pill">
            <div className="status-dot" />
            {phase === "SCORING" ? "SCANNING..." : phase === "PUBLISHING" ? "PUBLISHING..." : "ENGINE LIVE"}
          </div>
        </div>

        <div className="content">
          {/* Sport Tabs */}
          <div className="sport-row">
            {["NBA","MLB","NHL"].map(s => (
              <button
                key={s}
                className={`sport-btn ${sport === s ? "active" : ""}`}
                onClick={() => { setSport(s); setPhase("IDLE"); setBestPlay(null); }}
              >
                <span className="icon">{SPORT_CONFIG[s].icon}</span>
                <span className="label">{s}</span>
              </button>
            ))}
          </div>

          {/* Bankroll Strip */}
          <div className="bankroll-strip">
            <div className="br-left">
              <div className="br-label">Bankroll · Day {dayNumber}</div>
              <div className="br-amount">${bankroll.toFixed(2)}</div>
            </div>
            <div className="br-right">
              <div className="br-stat">
                <div className="br-stat-val" style={{ color: roi >= 0 ? "var(--green)" : "var(--red)" }}>
                  {roi >= 0 ? "+" : ""}{roiPct}%
                </div>
                <div className="br-stat-key">ROI</div>
              </div>
              {winRate && (
                <div className="br-stat">
                  <div className="br-stat-val" style={{ color: "var(--gold)" }}>{winRate}%</div>
                  <div className="br-stat-key">Win Rate</div>
                </div>
              )}
            </div>
          </div>

          {/* View Tabs */}
          <div className="tab-row">
            {["play","history"].map(t => (
              <button key={t} className={`tab-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {t === "play" ? "Today's Play" : `History (${history.length})`}
              </button>
            ))}
          </div>

          {tab === "play" && (
            <>
              {/* IDLE */}
              {phase === "IDLE" && (
                <button className="lock-btn fade-in" onClick={runSignalEngine}>
                  RUN SIGNAL ENGINE
                </button>
              )}

              {/* SCORING */}
              {phase === "SCORING" && (
                <div className="sched-card fade-in" style={{ textAlign: "center", padding: "32px" }}>
                  <div className="sched-header" style={{ marginBottom: 8 }}>Scanning {sport} slate via Odds API...</div>
                  <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 9, color: "var(--muted)" }}>
                    Pulling live lines → scoring candidates → applying Kelly gate
                  </div>
                </div>
              )}

              {/* READY / PUBLISHED */}
              {(phase === "READY" || phase === "PUBLISHED" || phase === "PUBLISHING") && bestPlay && (
                <div className="fade-in">
                  {/* Dynamic Schedule Card */}
                  <div className="sched-card">
                    <div className="sched-header">// Dynamic Post Schedule</div>
                    <div style={{ position: "relative", height: 52, marginBottom: 10 }}>
                      <div className="timeline-track" />
                      {/* 12-4pm window highlight */}
                      <div className="timeline-window" style={{ left: "0%", width: "100%" }} />
                      {/* Post time marker */}
                      {postTime && (() => {
                        const [h, m] = postTime.split(":").map(Number);
                        const p = Math.max(0, Math.min(100, pct12to4(h, m)));
                        return (
                          <div className="timeline-marker" style={{ left: `${p}%` }}>
                            <div className="marker-dot" style={{ borderColor: "var(--gold)", background: "var(--gold)" }} />
                            <div className="marker-label" style={{ color: "var(--gold)", marginTop: 6 }}>POST {postTime}</div>
                          </div>
                        );
                      })()}
                      {/* First game marker */}
                      {(() => {
                        const earliest = candidates[0];
                        if (!earliest) return null;
                        const gameH = earliest.gameHour;
                        const gameM = earliest.gameMin;
                        const p = Math.max(0, Math.min(100, pct12to4(gameH, gameM)));
                        return (
                          <div className="timeline-marker" style={{ left: `${p}%`, top: 4 }}>
                            <div className="marker-label" style={{ color: "var(--muted)", marginBottom: 4 }}>
                              1st TIP {earliest.gameTimeStr}
                            </div>
                            <div className="marker-dot" style={{ borderColor: "var(--muted)", background: "transparent" }} />
                          </div>
                        );
                      })()}
                      {/* Labels */}
                      <div style={{ position: "absolute", bottom: -4, left: 0, fontFamily: "'Space Mono'", fontSize: 7, color: "var(--dim)" }}>12PM</div>
                      <div style={{ position: "absolute", bottom: -4, right: 0, fontFamily: "'Space Mono'", fontSize: 7, color: "var(--dim)" }}>4PM</div>
                    </div>
                    <div className="sched-meta" style={{ marginTop: 16 }}>
                      <div className="sched-meta-item">
                        <div className="sched-meta-val">{postTime || "—"}</div>
                        <div className="sched-meta-key">Scheduled Post</div>
                      </div>
                      <div className="sched-meta-item">
                        <div className="sched-meta-val">{candidates.length}</div>
                        <div className="sched-meta-key">Games Scored</div>
                      </div>
                      <div className="sched-meta-item">
                        <div className="sched-meta-val">{candidates.filter(c => c.confidenceLabel !== "WEAK").length}</div>
                        <div className="sched-meta-key">Qualified</div>
                      </div>
                      <div className="sched-meta-item">
                        <div className="sched-meta-val">90m</div>
                        <div className="sched-meta-key">Pre-Game Buffer</div>
                      </div>
                    </div>
                  </div>

                  {/* Signal Card */}
                  <div className="signal-card">
                    <div className="signal-sport-bar" style={{ background: sportColor }} />
                    <div className="signal-body">
                      <div className="signal-top">
                        <div className="signal-sport-tag">{SPORT_CONFIG[sport]?.icon} {sport} · GAME LINE</div>
                        <div className="conf-badge" style={{
                          background: confColor + "22",
                          color: confColor,
                          border: `1px solid ${confColor}44`,
                        }}>{bestPlay.confidenceLabel}</div>
                      </div>

                      <div className="signal-matchup">
                        <div className="matchup-away">{bestPlay.awayTeam}</div>
                        <div className="matchup-home">@ {bestPlay.homeTeam}</div>
                      </div>

                      <div className="pick-row">
                        <div>
                          <div className="pick-label">PICK</div>
                          <div className="pick-team">{bestPlay.recommendedTeam}</div>
                          <div className="pick-line">
                            Spread {bestPlay.recommendedSpread > 0 ? "+" : ""}{bestPlay.recommendedSpread} ·{" "}
                            ML {bestPlay.recommendedML > 0 ? "+" : ""}{bestPlay.recommendedML}
                          </div>
                        </div>
                        <div className="pick-signal">
                          <div className="signal-type">{bestPlay.signalType}</div>
                          <div className="signal-score">{(bestPlay.totalScore * 100).toFixed(0)}</div>
                          <div style={{ fontFamily: "'Space Mono', monospace", fontSize: 8, color: "var(--muted)" }}>/100 SCORE</div>
                        </div>
                      </div>

                      {/* Score Breakdown */}
                      <div className="breakdown">
                        {[
                          { label: "Line Value", val: bestPlay.scoreBreakdown.lineValue, color: "#20e870" },
                          { label: "Consensus", val: bestPlay.scoreBreakdown.consensus, color: "#f0b840" },
                          { label: "Line Move", val: bestPlay.scoreBreakdown.lineMovement, color: "#8ab4cc" },
                          { label: "Pub Fade", val: bestPlay.scoreBreakdown.publicFade, color: "#ff8060" },
                        ].map(row => (
                          <div className="breakdown-row" key={row.label}>
                            <div className="bd-label">{row.label}</div>
                            <div className="bd-bar">
                              <div className="bd-fill" style={{ width: `${row.val * 100}%`, background: row.color }} />
                            </div>
                            <div className="bd-val">{(row.val * 100).toFixed(0)}%</div>
                          </div>
                        ))}
                      </div>

                      {/* Wager */}
                      <div className="wager-section">
                        <div className="wager-top">
                          <div className="wager-stat">
                            <div className="wager-val" style={{ color: "var(--gold)" }}>${wager.toFixed(2)}</div>
                            <div className="wager-key">Wager (¼-Kelly)</div>
                          </div>
                          <div className="wager-stat">
                            <div className="wager-val" style={{ color: "var(--text)" }}>
                              {(bestPlay.quarterKelly * 100).toFixed(1)}%
                            </div>
                            <div className="wager-key">of Bankroll</div>
                          </div>
                          <div className="wager-stat">
                            <div className="wager-val" style={{ color: "var(--green)" }}>
                              {((bestPlay.modelWinProb - bestPlay.impliedProb) * 100).toFixed(1)}%
                            </div>
                            <div className="wager-key">Edge</div>
                          </div>
                        </div>
                        <div className="kelly-bar">
                          <div className="kelly-fill" style={{ width: `${Math.min(bestPlay.quarterKelly * 500, 100)}%` }} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Discord Preview */}
                  <div className="sec-label">// Discord Preview</div>
                  <div className="discord-preview">
                    <div className="discord-header"># cheddar-logic · webhook preview</div>
                    <div className="discord-msg">
                      {discordMsg.split('\n').map((line, i) => {
                        const boldLine = line.replace(/\*\*(.*?)\*\*/g, (_, t) => `<b>${t}</b>`);
                        return <div key={i} dangerouslySetInnerHTML={{ __html: boldLine || '&nbsp;' }} />;
                      })}
                    </div>
                  </div>

                  {/* Destinations */}
                  <div className="sec-label">// Publishing Destinations</div>
                  <div className="dest-row">
                    {[
                      { key: "dashboard", icon: "📊", name: "Cheddar UI" },
                      { key: "discord", icon: "💬", name: "Discord" },
                    ].map(d => (
                      <div key={d.key} className={`dest-card ${destStatus[d.key]}`}>
                        <div className="dest-icon">{d.icon}</div>
                        <div className="dest-name">{d.name}</div>
                        <div className="dest-status">
                          {destStatus[d.key] === "sent" ? "✓ PUBLISHED"
                            : destStatus[d.key] === "sending" ? "SENDING..."
                            : "READY"}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* CTA */}
                  {phase === "READY" && (
                    <button className="lock-btn fade-in" onClick={publishPlay}>
                      PUBLISH PLAY · ${wager.toFixed(2)}
                    </button>
                  )}
                  {phase === "PUBLISHING" && (
                    <button className="lock-btn" disabled>PUBLISHING TO ALL DESTINATIONS...</button>
                  )}
                  {phase === "PUBLISHED" && (
                    <>
                      <button className="lock-btn" disabled>
                        ✓ PUBLISHED · {history[0]?.won ? `WON +$${history[0]?.profit.toFixed(2)}` : `LOST -$${Math.abs(history[0]?.profit || 0).toFixed(2)}`}
                      </button>
                      <button className="next-day-btn" onClick={nextDay}>→ Advance to Day {dayNumber + 1}</button>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {tab === "history" && (
            <div className="fade-in">
              {history.length === 0 && (
                <div style={{ textAlign: "center", padding: "40px 0", fontFamily: "'Space Mono', monospace", fontSize: 10, color: "var(--muted)" }}>
                  No plays yet. Run the engine on Day 1.
                </div>
              )}
              {history.map((h, i) => (
                <div className="hist-row" key={i}>
                  <div className="hist-sport">{SPORT_CONFIG[h.sport]?.icon}</div>
                  <div className="hist-body">
                    <div className="hist-team">{h.team}</div>
                    <div className="hist-meta">D{h.day} · {h.sport} · {h.signal} · {h.confidence} · ${h.wager.toFixed(2)} · {h.postTime}</div>
                  </div>
                  <div className="hist-result">
                    <div className="hist-pnl" style={{ color: h.profit >= 0 ? "var(--green)" : "var(--red)" }}>
                      {h.profit >= 0 ? "+" : ""}{h.profit.toFixed(2)}
                    </div>
                    <div className="hist-br">${h.bankrollAfter.toFixed(2)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
