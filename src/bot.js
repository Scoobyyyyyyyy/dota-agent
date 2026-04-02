// ─────────────────────────────────────────────────────────────────────────────
// Defense of the Agents  —  AgentScoob Bot
// ─────────────────────────────────────────────────────────────────────────────
// A self-contained Node.js bot that registers, observes the battlefield,
// makes strategic lane + ability decisions, and deploys every cycle.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = join(__dirname, "config.json");
const STRATEGY_PATH = join(__dirname, "strategy.json");
const RECALL_STATE_PATH = join(__dirname, "recall_state.json");

// ── Constants ────────────────────────────────────────────────────────────────
const BASE_URL = "https://www.defenseoftheagents.com";
const LOOP_INTERVAL_MS = 1_000; // 1 second between cycles
const RECALL_COOLDOWN_MS = 120_000; // 2-minute cooldown
const DEFAULT_RECALL_HP_THRESHOLD = 0.30; // 30% HP

// Melee ability priority (from user request)
const MELEE_ABILITY_PRIORITY = [
  "cleave",
  "thorns",
  "divine_shield",
  "fury",
  "fortitude",
];
const RANGED_ABILITY_PRIORITY = ["volley", "bloodlust", "critical_strike", "fury", "fortitude"];

// ── Lane commitment state ────────────────────────────────────────────────────
let committedLane = null;
let lastRecallTime = 0;     // timestamp of last recall activation
let emergencyLock = false;  // sticky lock for base emergencies
let lastChatGameId = null;
let lastMessageLane = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function warn(msg) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] ⚠  ${msg}`);
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── 1. Registration ─────────────────────────────────────────────────────────

async function ensureRegistered(config) {
  if (config.apiKey) {
    log(`Credentials loaded — agent "${config.agentName}" already registered.`);
    return config;
  }

  log(`No API key found. Registering agent "${config.agentName}"…`);

  const res = await fetch(`${BASE_URL}/api/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentName: config.agentName }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Registration failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  config.apiKey = data.apiKey;
  saveJson(CONFIG_PATH, config);
  log(`✅  Registered! API key saved to config.json.`);
  return config;
}

// ── 2. Observe — fetch game state ───────────────────────────────────────────

async function fetchGameState(gameId) {
  const url = gameId
    ? `${BASE_URL}/api/game/state?game=${gameId}`
    : `${BASE_URL}/api/game/state`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch game state (${res.status})`);
  }
  return res.json();
}

// ── 3. Think — decide lane & ability ────────────────────────────────────────

function findMyHero(state, agentName) {
  return state.heroes?.find((h) => h.name === agentName) ?? null;
}

/**
 * Find the lane with the lowest number of enemy units.
 * Checks both creeps and enemy players (heroes).
 * In case of a tie, prefers the lane we are already in to prevent bouncing.
 */
function chooseLane(state, faction, currentLane) {
  const enemyFaction = faction === "human" ? "orc" : "human";
  const pushSign = faction === "human" ? 1 : -1;
  const lanes = state.lanes;
  const heroes = state.heroes ?? [];

  let bestLane = "top";
  let minEnemies = Infinity;

  const enemyHeroCount = { top: 0, mid: 0, bot: 0 };
  const friendlyHeroCount = { top: 0, mid: 0, bot: 0 };
  for (const h of heroes) {
    if (h.alive) {
      if (h.faction === enemyFaction && enemyHeroCount[h.lane] !== undefined) {
        enemyHeroCount[h.lane]++;
      } else if (h.faction === faction && friendlyHeroCount[h.lane] !== undefined) {
        friendlyHeroCount[h.lane]++;
      }
    }
  }

  for (const laneName of ["top", "mid", "bot"]) {
    const enemyCreeps = lanes[laneName][enemyFaction] ?? 0;
    // Enemy heroes are extremely dangerous. We weight heroes heavily to avoid deathballs.
    let enemyUnits = enemyCreeps + (enemyHeroCount[laneName] * 10);

    const pushDepth = lanes[laneName].frontline * pushSign;
    // Anti-Dive Protection
    if (pushDepth >= 85 && enemyHeroCount[laneName] >= friendlyHeroCount[laneName]) {
      enemyUnits += 1000;
    }

    // Prefer the lowest enemy count. Tie-break: stick to current lane.
    if (enemyUnits < minEnemies || (enemyUnits === minEnemies && laneName === currentLane)) {
      minEnemies = enemyUnits;
      bestLane = laneName;
    }
  }

  return bestLane;
}

/**
 * Late-game lane selection (Lv12+): group up with friendly heroes.
 * Picks the lane with the most alive allied heroes to force teamfights.
 * Tie-break: stick to current lane to prevent bouncing.
 */
function chooseLaneLategame(state, faction, currentLane) {
  const heroes = state.heroes ?? [];
  const pushSign = faction === "human" ? 1 : -1;
  const enemyFaction = faction === "human" ? "orc" : "human";

  const friendlyCount = { top: 0, mid: 0, bot: 0 };
  const enemyCount = { top: 0, mid: 0, bot: 0 };
  for (const h of heroes) {
    if (h.alive) {
      if (h.faction === faction && friendlyCount[h.lane] !== undefined) {
        friendlyCount[h.lane]++;
      } else if (h.faction === enemyFaction && enemyCount[h.lane] !== undefined) {
        enemyCount[h.lane]++;
      }
    }
  }

  let bestLane = currentLane ?? "mid";
  let maxScore = -Infinity;

  for (const laneName of ["top", "mid", "bot"]) {
    let score = friendlyCount[laneName];
    const pushDepth = state.lanes[laneName].frontline * pushSign;
    
    // Anti-Dive Protection
    if (pushDepth >= 85 && enemyCount[laneName] >= friendlyCount[laneName]) {
      score -= 1000;
    }

    if (score > maxScore || (score === maxScore && laneName === currentLane)) {
      maxScore = score;
      bestLane = laneName;
    }
  }

  return bestLane;
}

/**
 * Choose an ability when the hero has a pending level-up.
 * Prefer unlocking NEW level 1 abilities over upgrading existing ones.
 */
function chooseAbility(myHero, strategy) {
  if (!myHero?.abilityChoices || myHero.abilityChoices.length === 0) {
    return null;
  }

  const heroClass = myHero.class ?? strategy?.preferredHeroClass ?? "melee";
  const priorityList =
    heroClass === "ranged" ? RANGED_ABILITY_PRIORITY : MELEE_ABILITY_PRIORITY;

  // array of ability IDs we already know
  const currentAbilities = myHero.abilities?.map((a) => a.id) ?? [];

  // Pass 1: Try to pick something we DON'T have yet (unlock a Level 1 ability)
  for (const ability of priorityList) {
    if (myHero.abilityChoices.includes(ability) && !currentAbilities.includes(ability)) {
      return ability;
    }
  }

  // Pass 2: If we are forced to upgrade (all choices are things we already have),
  // upgrade the highest priority one available.
  for (const ability of priorityList) {
    if (myHero.abilityChoices.includes(ability)) {
      return ability;
    }
  }

  return null;
}

// ── Recall decision ─────────────────────────────────────────────────────────

/**
 * Determine whether the hero should recall to base.
 * Triggers when HP drops below the configured threshold and recall is off cooldown.
 * Recall completely replaces any flee/retreat logic — the hero teleports to base.
 */
function shouldRecall(myHero, strategy) {
  if (!myHero || !myHero.alive) return false;
  if (myHero.maxHp === 0) return false;

  const threshold = strategy?.recallHpThreshold ?? DEFAULT_RECALL_HP_THRESHOLD;
  const hpPercent = myHero.hp / myHero.maxHp;
  const offCooldown = Date.now() - lastRecallTime > RECALL_COOLDOWN_MS;

  return hpPercent < threshold && offCooldown;
}

// ── 4. Act — post deployment ────────────────────────────────────────────────

async function deploy(apiKey, payload) {
  const res = await fetch(`${BASE_URL}/api/strategy/deployment`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deployment failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ── 5. Main game loop ───────────────────────────────────────────────────────

let isTicking = false;

async function tick(config, strategy) {
  if (isTicking) return "ok";
  isTicking = true;

  try {
    // ── Recall Channel Protection ──────────────────────────────────────────────
    // The game server requires a ~2-second channel to successfully teleport.
    // If we recently activated recall, skip this tick so we don't send a
    // movement/attack command that interrupts our own channel!
    if (Date.now() - lastRecallTime < 3000) {
      return "ok";
    }

    // 2. Observe — scan all games to find our hero
    let state = null;
    let myHero = null;
    let activeGameId = null;

    for (let g = 1; g <= 5; g++) {
      try {
        const s = await fetchGameState(g);
        const hero = findMyHero(s, config.agentName);
        const listed =
          s.agents?.human?.includes(config.agentName) ||
          s.agents?.orc?.includes(config.agentName);

        if (hero || listed) {
          state = s;
          myHero = hero;
          activeGameId = g;
          break;
        }
      } catch {
        // game slot may not exist
      }
    }

    // Fallback: if not found in any game, fetch default so first deploy works
    if (!state) {
      state = await fetchGameState();
    }

    // Handle death to clear emergency stickiness
    if (myHero && !myHero.alive) {
      emergencyLock = false;
    }

    // Release emergency lock gracefully if the Base Emergency lane is successfully pushed out past the river
    if (myHero && myHero.alive && emergencyLock && committedLane) {
      const sign = myHero.faction === "human" ? -1 : 1;
      if (state.lanes[committedLane].frontline * sign <= 0) {
        log(`✅ Base emergency in ${committedLane} resolved! Returning to standard routing.`);
        emergencyLock = false;
        committedLane = null;
      }
    }

    if (state.winner) {
      log(`🏆  Game over! Winner: ${state.winner} (game ${activeGameId ?? "?"})`);
      return "gameover";
    }

    // 3. Think
    const heroClass = strategy?.preferredHeroClass ?? "melee";

    // ── Recall check (replaces any flee/retreat logic) ─────────────────────
    let useRecall = false;

    if (myHero && myHero.alive) {
      const recallOffCooldown = Date.now() - lastRecallTime > RECALL_COOLDOWN_MS;

      // Priority 1: Critical HP — recall immediately
      if (shouldRecall(myHero, strategy)) {
        useRecall = true;
        committedLane = null; // Clear so we evaluate a fresh lane upon arriving back at base
        const hpPct = Math.round((myHero.hp / myHero.maxHp) * 100);
        log(`🏠 RECALL: HP at ${hpPct}% — channeling recall to base!`);
      }

      // Priority 2: Base emergency + recall available → instant teleport to defend
      // Only in late game (Lv9+) — early/mid game recall is for HP recovery only
      if (!useRecall && recallOffCooldown && myHero.level >= 9 && !emergencyLock) {
        const sign = myHero.faction === "human" ? -1 : 1;
        const enemyFaction = myHero.faction === "human" ? "orc" : "human";
        const enemyHeroesPerLane = { top: 0, mid: 0, bot: 0 };
        for (const h of (state.heroes ?? [])) {
          if (h.faction === enemyFaction && h.alive && enemyHeroesPerLane[h.lane] !== undefined) {
            enemyHeroesPerLane[h.lane]++;
          }
        }
        for (const laneName of ["top", "mid", "bot"]) {
          if (enemyHeroesPerLane[laneName] < 3) continue;
          const heroThreat = enemyHeroesPerLane[laneName] * 10;
          const threshold = Math.max(30, 80 - heroThreat);
          if (state.lanes[laneName].frontline * sign >= threshold) {
            useRecall = true;
            committedLane = laneName;
            emergencyLock = true;
            log(`🏠 RECALL + 🚨 BASE EMERGENCY: Recalling to defend ${laneName}!`);
            break;
          }
        }
      }
    }

    // ── Lane decision (only when NOT recalling) ────────────────────────────
    let lane;
    if (!myHero) {
      // First deploy — go mid (early-game brawl meta)
      lane = "mid";
    } else if (myHero.level <= 5) {
      // Early game (Levels 1-5): always mid — everyone brawls mid at the start
      lane = "mid";
      committedLane = "mid";
    } else if (!useRecall) {
      // Standard lane logic (base emergency without recall, or normal play)
      const sign = myHero.faction === "human" ? -1 : 1;
      const enemyFaction = myHero.faction === "human" ? "orc" : "human";
      let baseThreatLane = null;

      if (myHero.level >= 9) {
        if (emergencyLock && committedLane) {
          baseThreatLane = committedLane;
        } else {
          // Count enemy heroes per lane
          const enemyHeroesPerLane = { top: 0, mid: 0, bot: 0 };
          for (const h of (state.heroes ?? [])) {
            if (h.faction === enemyFaction && h.alive && enemyHeroesPerLane[h.lane] !== undefined) {
              enemyHeroesPerLane[h.lane]++;
            }
          }

          for (const laneName of ["top", "mid", "bot"]) {
            if (enemyHeroesPerLane[laneName] < 3) continue;
            // Each enemy hero in a lane lowers the emergency threshold by 10
            // 3 heroes → 50, 4+ → 40
            const heroThreat = enemyHeroesPerLane[laneName] * 10;
            const threshold = Math.max(30, 80 - heroThreat);
            if (state.lanes[laneName].frontline * sign >= threshold) {
              baseThreatLane = laneName;
              log(`⚠️  Threat in ${laneName}: fl=${state.lanes[laneName].frontline}, enemies=${enemyHeroesPerLane[laneName]}, threshold=${threshold}`);
              emergencyLock = true;
              break;
            }
          }
        }
      }

      if (baseThreatLane) {
        if (committedLane !== baseThreatLane) {
          log(`🚨 BASE EMERGENCY: Switching to ${baseThreatLane} to defend!`);
          committedLane = baseThreatLane;
        }
      } else if (myHero.level >= 9) {
        // Late game (Lv9+): group up with friendly heroes for teamfights
        const best = chooseLaneLategame(state, myHero.faction, committedLane);
        if (best !== committedLane) {
          log(`⚔️ LATEGAME: Grouping with allies → ${best}`);
        }
        committedLane = best;
      } else if (!committedLane || !myHero.alive) {
        // Mid game (Lv6-8): pick the lane with fewest enemies
        const best = chooseLane(state, myHero.faction, committedLane);
        if (best !== committedLane) {
          log(`🎯 ${!committedLane ? "Initial" : "Respawn"} choice (fewest enemies) → ${best}`);
          committedLane = best;
        }
      }

      lane = committedLane;
    } else {
      // Recalling — keep the committed lane for after we arrive at base
      lane = committedLane ?? "top";
    }

    const abilityChoice = myHero ? chooseAbility(myHero, strategy) : null;

    // Build a short status message for the spectator UI
    // Only include `message` when we have something NEW to say.
    // The field is optional — omitting it means no chat entry is created.
    let message = null;

    if (activeGameId && lastChatGameId !== activeGameId) {
      message = "Scoob: gl&hf";
      lastChatGameId = activeGameId;
      lastMessageLane = null; // ensure we broadcast our first lane next tick
    } else if (useRecall) {
      message = `Scoob 🏠 RECALLING`;
      lastMessageLane = null; // reset so we mention our lane again when we leave base
    } else if (lane !== lastMessageLane) {
      message = `Scoob → ${lane.toUpperCase()}`;
      lastMessageLane = lane;
    }

    if (abilityChoice) {
      message = message
        ? `${message} | leveling ${abilityChoice}`
        : `Scoob leveling ${abilityChoice}`;
    }

    const payload = {
      heroClass,
      heroLane: lane,
      ...(abilityChoice && { abilityChoice }),
      ...(useRecall && { action: "recall" }),
      ...(message && { message }),
    };

    // 4. Act
    const result = await deploy(config.apiKey, payload);

    // ── Update recall state ────────────────────────────────────────────────
    if (useRecall) {
      lastRecallTime = Date.now();
      // Write recall state to shared file for dashboard consumption
      saveJson(RECALL_STATE_PATH, {
        lastRecallTime,
        cooldownEnds: lastRecallTime + RECALL_COOLDOWN_MS,
      });
    }

    // ── Pretty log ─────────────────────────────────────────────────────────
    const heroInfo = myHero
      ? `Lv${myHero.level} ${myHero.class} (${myHero.hp}/${myHero.maxHp} HP)`
      : "first deploy";
    const laneInfo = Object.entries(state.lanes)
      .map(([n, l]) => `${n}: fl=${l.frontline}`)
      .join(" | ");

    log(
      `🎮  Tick #${state.tick} | ${heroInfo} | Lane: ${lane} | ${laneInfo}` +
      (abilityChoice ? ` | 🆙 ${abilityChoice}` : "") +
      (useRecall ? ` | 🏠 RECALL` : "") +
      ` | gameId=${result.gameId ?? "?"}`
    );

    return "ok";
  } finally {
    isTicking = false;
  }
}

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  Defense of the Agents  —  AgentScoob  🐕");
  log("═══════════════════════════════════════════════════════");

  // Load config & strategy
  let config = loadJson(CONFIG_PATH) ?? { agentName: "AgentScoob", apiKey: "" };
  const strategy = loadJson(STRATEGY_PATH);

  if (strategy) {
    log(`Strategy loaded: class=${strategy.preferredHeroClass}, lane=${strategy.laneFocus}`);
    log(`Behavior: "${strategy.behavior}"`);
  }

  // Register if needed (first run)
  config = await ensureRegistered(config);

  // One-shot mode for --register-only
  if (process.argv.includes("--register-only")) {
    log("Registration complete. Exiting (--register-only).");
    return;
  }

  // ── Continuous game loop ───────────────────────────────────────────────
  log(`Starting game loop — deploying every ${LOOP_INTERVAL_MS / 1000}s…`);

  // Run the first tick immediately
  try {
    await tick(config, strategy);
  } catch (err) {
    warn(`First tick failed: ${err.message}`);
  }

  // Then repeat on interval
  setInterval(async () => {
    try {
      // Re-read strategy on each tick so you can hot-edit it
      const freshStrategy = loadJson(STRATEGY_PATH) ?? strategy;
      await tick(config, freshStrategy);
    } catch (err) {
      warn(`Tick error: ${err.message}`);
    }
  }, LOOP_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
