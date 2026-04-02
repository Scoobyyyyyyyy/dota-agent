# 🐕 AgentScoob — Defense of the Agents AI Bot

An autonomous AI agent for **[Defense of the Agents](https://www.defenseoftheagents.com)**, a casual idle MOBA where AI agents and humans fight side by side.

AgentScoob is a self-contained Node.js bot that registers with the game server, observes the battlefield via the REST API, makes strategic lane and ability decisions, and deploys every second.

## Features

- **Smart lane selection** — picks the lane with the fewest enemies, avoids deathballs
- **Late-game teamfight grouping** — at Level 12+, groups with allied heroes to force teamfights
- **Base emergency defense** — detects when 3+ enemy heroes push toward the base and rotates to defend
- **Recall system** — automatically recalls to base when HP drops below 30%, with a 2-minute cooldown
- **Ability priority** — follows a configurable leveling order for abilities
- **Chat messages** — announces lane changes, recalls, and says `gl&hf` at game start
- **Live dashboard** — a local web UI showing real-time hero stats, lane status, and match history
- **Win/loss tracking** — persistent match history with automatic result recording

## Quick Start

### 1. Install & Register

```bash
git clone <your-repo-url>
cd dota-agent

# Register your agent (creates src/config.json with your API key)
npm run register
```

Or manually create `src/config.json`:

```json
{
  "agentName": "YourAgentName",
  "apiKey": "your-api-key-here"
}
```

See `src/config.example.json` for the template.

### 2. Configure Strategy (Optional)

Edit `src/strategy.json` to customize your agent's behavior:

```json
{
  "preferredHeroClass": "melee",
  "laneFocus": "top",
  "recallHpThreshold": 0.30,
  "behavior": "Push aggressively when our frontline advantage is strong."
}
```

- **preferredHeroClass** — `"melee"` or `"ranged"`
- **laneFocus** — starting lane preference (`"top"`, `"mid"`, or `"bot"`)
- **recallHpThreshold** — HP percentage to trigger recall (default: `0.30`)
- **behavior** — free-text description (for your reference)

### 3. Run the Bot

```bash
npm start
```

The bot will start deploying every second and log its decisions to the console.

### 4. Run the Dashboard (Optional)

```bash
npm run dashboard
```

Opens a live tracking dashboard at `http://localhost:3333` showing:
- Hero stats (HP, XP, level, abilities)
- Lane frontline positions
- Recall cooldown status
- Match history with win/loss tracking

## Project Structure

```
dota-agent/
├── package.json              # Project manifest
├── .gitignore                # Excludes secrets & runtime files
├── README.md                 # This file
└── src/
    ├── bot.js                # Core agent logic (lane selection, recall, abilities)
    ├── dashboard.js          # Dashboard HTTP server with game state proxy
    ├── dashboard.html        # Dashboard UI (served by dashboard.js)
    ├── config.json           # Your credentials (gitignored)
    ├── config.example.json   # Credential template
    ├── strategy.json         # Agent strategy configuration
    ├── stats.json            # Match history (auto-generated, gitignored)
    └── recall_state.json     # Recall cooldown state (auto-generated, gitignored)
```

## How It Works

The bot follows an **Observe → Think → Act** loop every second:

1. **Observe** — Fetches game state from the API, finds our hero across up to 5 game slots
2. **Think** — Evaluates lane threats, decides whether to recall, picks abilities
3. **Act** — Posts a deployment with the chosen lane, class, and optional ability/recall

### Lane Decision Logic

| Game Phase | Level | Strategy |
|---|---|---|
| Early game | 1–3 | Always mid — everyone brawls mid at the start |
| Mid game | 4–11 | Pick the lane with fewest enemies (avoid deathballs) |
| Late game | 12+ | Group with allied heroes for teamfights |
| Emergency | Any | If 3+ enemies push toward base, rotate to defend |

## Links

- 🎮 [Play the game](https://www.defenseoftheagents.com)
- 📖 [API Documentation](https://www.defenseoftheagents.com/game-loop.md)
- 🔧 [Agent Setup Guide](https://defenseoftheagents.com/skill.md)

## License

MIT
