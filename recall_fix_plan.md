# Recall Fix Plan

## Problem

AgentScoob is not recalling consistently despite being below the 30% HP threshold. The hero stays in lane taking damage instead of teleporting to base.

## Root Cause Analysis

After analyzing `src/bot.js` and the game API, there are **5 interacting issues** that explain unreliable recalls.

---

### Bug 1: `lastRecallTime` is set AFTER `deploy()`, not before — channel protection window is shorter than intended

```
Line 311:  const result = await deploy(config.apiKey, payload);   // network call (100-500ms)
Line 315:  lastRecallTime = Date.now();                           // timestamp set AFTER deploy returns
```

The channel protection guard at the top of `tick()` checks:

```js
if (Date.now() - lastRecallTime < 3000) {
    return "ok";   // skip tick to avoid interrupting recall channel
}
```

Because `lastRecallTime` is stamped **after** the deploy HTTP round-trip, the effective protection window is `3000ms - deploy_latency`. If `deploy()` takes 500ms, only 2.5s of protection remains — dangerously close to the server's 2-second channel time.

**Fix:** Set `lastRecallTime = Date.now()` **before** calling `deploy()` when `useRecall` is true.

---

### Bug 2: Recall is sent exactly once, then never retried

The recall flow today:

1. Tick N: HP < 30% → send `{ action: "recall" }` → set `lastRecallTime`
2. Ticks N+1, N+2, N+3: Channel protection skips these ticks (3 seconds)
3. Tick N+4 onwards: **Bot resumes sending normal `{ heroClass, heroLane }` commands**

If the single recall command on tick N was lost, rate-limited, or not processed by the server, the recall never happened. But `lastRecallTime` is already set, so:
- The 3-second guard silences the bot
- After that, normal movement commands resume (no recall retry)
- The **120-second cooldown** prevents any new recall attempt for 2 full minutes

The hero stays in lane at critical HP for up to 2 minutes.

**Fix:** Keep re-sending `{ action: "recall" }` on every tick during the channel window instead of going silent. The API says the hero is invulnerable during the 2-second channel, so re-sending recall won't interrupt it — but sending a `heroLane` command after the window might. The safest approach: continue sending `{ action: "recall" }` for the full channel duration rather than skipping ticks entirely.

---

### Bug 3: Normal deployment commands immediately follow the channel window and may cancel a late recall

After the 3-second silence, the bot sends:

```json
{ "heroClass": "melee", "heroLane": "mid" }
```

If the server's recall channel hasn't fully completed (due to timing drift, server lag, or the shortened window from Bug 1), this deployment overwrites the recall action. The server sees a lane assignment and cancels the pending recall.

**Fix:** Extend the channel protection window from 3s to ~5s (comfortable margin above the 2s channel), and/or check the hero's HP in the next game state to confirm the recall succeeded before resuming normal commands.

---

### Bug 4: Slow tick rate due to sequential game scanning (up to 5 HTTP calls per tick)

Each tick scans game slots 1–5 sequentially:

```js
for (let g = 1; g <= 5; g++) {
    const s = await fetchGameState(g);   // sequential await
    ...
}
```

Each fetch can take 100–500ms. In the worst case, observation alone consumes **2.5 seconds** of a 1-second interval. Combined with the `isTicking` mutex, subsequent interval callbacks are dropped:

```
Tick 1 fires at T=0     → starts scanning 5 games → finishes at T=1.5s
Tick 2 fires at T=1     → isTicking=true → dropped
Tick 3 fires at T=2     → runs normally
```

This means the bot can take **2–3 seconds** to even notice that HP dropped below threshold, by which time the hero may already be dead.

**Fix:** Run the 5 game-state fetches in parallel with `Promise.allSettled()`, or cache the known `activeGameId` and only fetch that one game on subsequent ticks.

---

### Bug 5: Unused `recallOffCooldown` variable — dead code suggests incomplete refactor

```js
// Line 249 in tick():
const recallOffCooldown = Date.now() - lastRecallTime > RECALL_COOLDOWN_MS;
```

This variable is computed but **never read**. The actual cooldown check lives inside `shouldRecall()`. This is harmless dead code but suggests the recall logic was refactored and not fully cleaned up. Removing it avoids confusion.

---

## Fix Plan

### Change 1: Set `lastRecallTime` before deploy (Bug 1)

Move the timestamp **before** the deploy call so the channel protection window starts immediately.

```javascript
// BEFORE deploy
if (useRecall) {
    lastRecallTime = Date.now();
    saveJson(RECALL_STATE_PATH, {
        lastRecallTime,
        cooldownEnds: lastRecallTime + RECALL_COOLDOWN_MS,
    });
}

const result = await deploy(config.apiKey, payload);
```

### Change 2: Re-send recall during channel window instead of going silent (Bug 2 + Bug 3)

Replace the "skip tick" guard with "force recall payload" logic:

```javascript
// At the top of tick(), replace the early-return with:
const isChannelingRecall = Date.now() - lastRecallTime < RECALL_CHANNEL_MS;

// Later, when building the payload:
if (useRecall || isChannelingRecall) {
    payload = { action: "recall" };
} else {
    payload = { heroClass, heroLane: lane, ... };
}
```

Where `RECALL_CHANNEL_MS = 5000` (2s channel + 3s safety margin). This ensures:
- Recall is sent **every tick** during the channel window (redundancy)
- No normal movement command can slip in and cancel the channel

### Change 3: Parallelize game state fetches (Bug 4)

```javascript
// Replace sequential loop with parallel fetches
const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map(g => fetchGameState(g).then(s => ({ s, g })))
);

for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { s, g } = r.value;
    const hero = findMyHero(s, config.agentName);
    const listed = s.agents?.human?.includes(config.agentName)
                || s.agents?.orc?.includes(config.agentName);
    if (hero || listed) {
        state = s; myHero = hero; activeGameId = g;
        break;
    }
}
```

Alternatively, cache `activeGameId` after the first successful find and only scan that slot on subsequent ticks, falling back to the full scan if it fails.

### Change 4: Remove dead code (Bug 5)

Delete the unused `recallOffCooldown` variable at line 249.

---

## Constant Adjustments

| Constant              | Current  | Proposed | Reason                                          |
|-----------------------|----------|----------|-------------------------------------------------|
| `RECALL_CHANNEL_MS`   | 3000 (implicit) | 5000 (new const) | Comfortable margin above the 2s server channel |
| `RECALL_COOLDOWN_MS`  | 120000   | 120000   | Matches server cooldown — keep as-is            |
| `LOOP_INTERVAL_MS`    | 1000     | 1000     | Fine if we parallelize fetches                  |

## Expected Result

1. Recall command is sent **immediately** when HP < 30% and off cooldown.
2. Recall command is **re-sent every tick** for 5 seconds, preventing any movement command from cancelling the channel.
3. After the channel window, the bot confirms HP is restored (hero at base) before resuming normal lane commands.
4. Parallel game-state fetches reduce observation time from ~2.5s to ~500ms, making the bot react to low HP much faster.
5. No more "stuck at low HP in lane" scenarios.
