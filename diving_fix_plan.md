# 🚧 Fix Plan: Suicidal Map Traversal & Base Diving

## The Root Cause

In the game API, modifying your `heroLane` while your hero is alive and out in the field causes the game engine to physically walk your hero across the map to the new lane. During this cross-map traversal, the hero enters a "moving" state where they **ignore combat, do not attack creeps, and walk directly through enemy towers and bases.**

**Why is this happening only in the late game?**
- **Mid Game (Lv 4-11):** The agent only calls the lane selection logic (`chooseLane`) when the hero is **dead** or has just safely **recalled to base**. It locks in the `committedLane` and stays there. This is safe.
- **Late Game (Lv 12+):** The agent evaluates `chooseLaneLategame` **every single second**. If an ally moves to a different lane, your hero instantly changes `committedLane` to follow them. This triggers the suicidal cross-map walk through enemy territory, causing the hero to feed helplessly.

## The Fix

We must **strictly forbid changing lanes while alive in the field**, unless the `Recall` spell is triggered simultaneously.

### Change 1: Restrict Late Game Lane Selection
We will modify the late-game logic so that `chooseLaneLategame` is ONLY evaluated when the hero needs to pick a fresh lane from the fountain (i.e., when they are dead, or when they just finished a recall).

```javascript
// Old (Bugged) Logic:
} else if (myHero.level >= 12) {
  const best = chooseLaneLategame(...);
  committedLane = best; // Changes lane while alive!
}

// New (Safe) Logic:
} else if (!committedLane || !myHero.alive) {
  // Only pick a new lane if we are dead or just safely recalled to base.
  let best;
  if (myHero.level >= 12) {
    best = chooseLaneLategame(state, myHero.faction, committedLane);
    console.log(`⚔️ LATEGAME: Grouping with allies → ${best}`);
  } else {
    best = chooseLane(state, myHero.faction, committedLane);
    console.log(`🎯 Respawn choice (fewest enemies) → ${best}`);
  }
  committedLane = best;
}
```

### Change 2: Anti-Dive Protection (Base Emergency Adjustments)
To handle the threat of pushing an undefended enemy base when allies aren't helping, we will still include the **Anti-Dive penalty** to `chooseLaneLategame`. 
When the agent respawns at Level 12+, it will look for allies to group with. If the allies are currently diving a heavily defended enemy base (a suicide mission), the agent will instead pick a safer lane to push.

## Expected Result
1. The hero will **never** walk sideways across the map and ignore combat again.
2. The hero will pick a lane at the fountain, walk down that lane, fight to the death (or until Recall is triggered by low HP), and then re-evaluate their lane upon respawning.
3. This completely eliminates the "running into enemies without attacking" behavior.
