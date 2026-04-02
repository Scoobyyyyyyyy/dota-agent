import { appendFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = "https://www.defenseoftheagents.com";
const TARGET_PLAYER = "League of LLMs";
const LOG_FILE = join(__dirname, "league_of_llms_log.jsonl"); // JSON Lines format
const POLL_INTERVAL = 2000;

let lastStateString = "";

function logMsg(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] 🕵️  ${msg}`);
}

async function fetchGameState(gameId) {
  try {
    const res = await fetch(`${BASE_URL}/api/game/state?game=${gameId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function spectate() {
  // Check all 5 active lobbies
  for (let gameId = 1; gameId <= 5; gameId++) {
    const state = await fetchGameState(gameId);
    if (!state || !state.heroes) continue;

    const target = state.heroes.find(h => h.name === TARGET_PLAYER);
    if (target) {
      // We found them! Extract strategic metrics
      const currentAbilities = target.abilities?.map(a => a.id) ?? [];
      const hpPercent = target.maxHp > 0 ? (target.hp / target.maxHp).toFixed(3) : 0;
      
      const record = {
        timestamp: new Date().toISOString(),
        gameId,
        tick: state.tick,
        faction: target.faction,
        class: target.class,
        level: target.level,
        lane: target.lane,
        hp: target.hp,
        maxHp: target.maxHp,
        hpPercent,
        alive: target.alive,
        abilities: currentAbilities
      };

      // To avoid massive spam, only log if state changed (lane, level, alive, or significant HP drop indicating a recall trigger)
      const stateString = `${target.level}|${target.lane}|${target.alive}|${currentAbilities.join(",")}`;
      
      // We also want to record if HP drops drastically (might be a recall indicator)
      // or if HP jumps to 100% (heavily implies they just returned to base)
      
      if (stateString !== lastStateString || target.hp === target.maxHp || hpPercent < 0.35) {
        appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf-8");
        lastStateString = stateString;
        
        logMsg(`Spotted in Game ${gameId} | Lv${target.level} ${target.class} | Lane: ${target.lane} | HP: ${hpPercent} | Alive: ${target.alive}`);
      }
      return; // Found them, no need to check other games this tick
    }
  }
}

logMsg(`Starting radar for target: ${TARGET_PLAYER}...`);
setInterval(spectate, POLL_INTERVAL);
