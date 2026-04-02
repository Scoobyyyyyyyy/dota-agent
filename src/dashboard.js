// ─────────────────────────────────────────────────────────────────────────────
// AgentScoob Dashboard Server
// ─────────────────────────────────────────────────────────────────────────────
// A lightweight HTTP server that serves the tracking dashboard and proxies
// game state from the DOTA API (avoids CORS issues in the browser).
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "http";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3333;
const BASE_URL = "https://www.defenseoftheagents.com";
const AGENT_NAME = "AgentScoob";
const STATS_PATH = join(__dirname, "stats.json");
const HTML_PATH = join(__dirname, "dashboard.html");
const CONFIG_PATH = join(__dirname, "config.json");
const RECALL_STATE_PATH = join(__dirname, "recall_state.json");

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Track last known game to detect game-overs
let lastKnownGameId = null;
let lastKnownTick = 0;

// ── Track wins/losses ────────────────────────────────────────────────────────

function recordResult(gameId, winner, faction) {
  const stats = loadJson(STATS_PATH) ?? {
    totalGames: 0,
    wins: 0,
    losses: 0,
    history: [],
  };

  // Prevent double-recording if the game just finished milliseconds ago.
  // The delete trackedFactions[g] already handles this cleanly, but as a safeguard,
  // we check if this gameId was recorded in the last 60 seconds.
  const oneMinuteAgo = new Date(Date.now() - 60000);
  const recentlyRecorded = stats.history.find(
    (h) => h.gameId === gameId && new Date(h.timestamp) > oneMinuteAgo
  );
  if (recentlyRecorded) return;

  const won = winner === faction;
  stats.totalGames++;
  if (won) stats.wins++;
  else stats.losses++;

  stats.history.push({
    gameId,
    faction,
    winner,
    result: won ? "WIN" : "LOSS",
    timestamp: new Date().toISOString(),
  });

  // Keep last 100 entries
  if (stats.history.length > 100) {
    stats.history = stats.history.slice(-100);
  }

  saveJson(STATS_PATH, stats);
  console.log(
    `[Stats] Game ${gameId}: ${won ? "WIN 🏆" : "LOSS 💀"} (${winner} won)`
  );
}

// ── Background Polling ───────────────────────────────────────────────────────
let cachedMatches = [];
const trackedFactions = {}; // gameId -> faction

async function pollGames() {
  try {
    const active = [];

    for (let g = 1; g <= 5; g++) {
      try {
        const res = await fetch(`${BASE_URL}/api/game/state?game=${g}`);
        if (!res.ok) continue;
        const state = await res.json();

        const hero = state.heroes?.find((h) => h.name === AGENT_NAME);
        const isHuman = state.agents?.human?.includes(AGENT_NAME);
        const isOrc = state.agents?.orc?.includes(AGENT_NAME);
        const inGame = isHuman || isOrc;

        let faction = hero?.faction;
        if (!faction) {
          if (isHuman) faction = "human";
          else if (isOrc) faction = "orc";
        }

        // Remember which team the agent is on so we can log it when the game ends
        if (faction) {
          trackedFactions[g] = faction;
        }

        // If the game is over and we remember playing in it recently
        if (state.winner && trackedFactions[g]) {
          recordResult(g, state.winner, trackedFactions[g]);
          delete trackedFactions[g]; // clear memory for next match in this slot
        }

        if (inGame || hero) {
          active.push({
            gameId: g,
            tick: state.tick,
            winner: state.winner,
            faction,
            hero,
            lanes: state.lanes,
            towers: state.towers,
            bases: state.bases,
            agents: state.agents,
            allHeroes: state.heroes,
          });
        }
      } catch {
        // skip unreachable
      }
    }

    cachedMatches = active;
  } catch (err) {
    console.error("[Dashboard] Polling error:", err.message);
  }
}

// Poll every 5 seconds independently of the browser
setInterval(pollGames, 5000);
pollGames();

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Dashboard HTML ───────────────────────────────────────────────────────
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(HTML_PATH, "utf-8"));
    return;
  }

  // ── API: current agent status ────────────────────────────────────────────
  if (url.pathname === "/api/status") {
    try {
      const stats = loadJson(STATS_PATH) ?? {
        totalGames: 0,
        wins: 0,
        losses: 0,
        history: [],
      };

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });

      // Read recall state from shared file
      const recallState = loadJson(RECALL_STATE_PATH);
      let recallCooldownRemaining = 0;
      if (recallState?.cooldownEnds) {
        recallCooldownRemaining = Math.max(0, recallState.cooldownEnds - Date.now());
      }

      res.end(
        JSON.stringify({
          agent: AGENT_NAME,
          activeGames: cachedMatches,
          stats: stats,
          recall: {
            lastRecallTime: recallState?.lastRecallTime ?? 0,
            cooldownRemaining: recallCooldownRemaining,
            isOnCooldown: recallCooldownRemaining > 0,
          },
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\n🎮  AgentScoob Dashboard running at http://localhost:${PORT}\n`);
});
