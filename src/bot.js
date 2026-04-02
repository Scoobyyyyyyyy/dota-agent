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
const RECALL_CHANNEL_MS = 5_000;   // 2s server channel + 3s safety margin
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
// emergencyLock removed for all-mid strategy
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

// Lane selection logic removed: we only go mid.

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
    // During the channel window we keep re-sending { action: "recall" } every
    // tick so no movement command can slip in and cancel the channel.
    const isChannelingRecall = Date.now() - lastRecallTime < RECALL_CHANNEL_MS;

    if (isChannelingRecall) {
      log(`🏠 RECALL CHANNEL: re-sending recall (${Math.round((Date.now() - lastRecallTime) / 1000)}s into channel)`);
      await deploy(config.apiKey, { action: "recall" });
      return "ok";
    }

    // 2. Observe — scan all games to find our hero (parallel fetches)
    let state = null;
    let myHero = null;
    let activeGameId = null;

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((g) =>
        fetchGameState(g).then((s) => ({ s, g }))
      )
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { s, g } = r.value;
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
    }

    // Fallback: if not found in any game, fetch default so first deploy works
    if (!state) {
      state = await fetchGameState();
    }

    // Emergency lock logic removed.

    if (state.winner) {
      log(`🏆  Game over! Winner: ${state.winner} (game ${activeGameId ?? "?"})`);
      return "gameover";
    }

    // 3. Think
    const heroClass = strategy?.preferredHeroClass ?? "melee";

    // ── Recall check (replaces any flee/retreat logic) ─────────────────────
    let useRecall = false;

    if (myHero && myHero.alive) {
      // Priority 1: Critical HP — recall immediately
      if (shouldRecall(myHero, strategy)) {
        useRecall = true;
        committedLane = null; // Clear so we evaluate a fresh lane upon arriving back at base
        const hpPct = Math.round((myHero.hp / myHero.maxHp) * 100);
        log(`🏠 RECALL: HP at ${hpPct}% — channeling recall to base!`);
      }

      // Base emergency recall logic removed.
    }

    // ── Lane decision (only when NOT recalling) ────────────────────────────
    let lane;
    if (!useRecall) {
      lane = "mid";
      committedLane = "mid";
    } else {
      // Recalling — keep the committed lane for after we arrive at base
      lane = "mid";
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

    let payload;
    if (useRecall) {
      payload = { action: "recall" };
      if (message) payload.message = message;
    } else {
      payload = {
        heroClass,
        heroLane: lane,
        ...(abilityChoice && { abilityChoice }),
        ...(message && { message }),
      };
    }

    // ── Update recall state BEFORE deploy so channel protection starts immediately
    if (useRecall) {
      lastRecallTime = Date.now();
      // Write recall state to shared file for dashboard consumption
      saveJson(RECALL_STATE_PATH, {
        lastRecallTime,
        cooldownEnds: lastRecallTime + RECALL_COOLDOWN_MS,
      });
    }

    // 4. Act
    const result = await deploy(config.apiKey, payload);

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
