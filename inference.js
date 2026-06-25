/**
 * Rift Scout — Role Inference Engine
 * 
 * Uses champion role distributions, summoner spell distributions,
 * and keystone rune distributions from real match data to infer
 * the role each player is playing with optimal assignment.
 */

const fs = require("fs");
const path = require("path");

// ── Load data files ───────────────────────────────────────────────────────────
function loadJson(filename) {
  try {
    const p = path.join(__dirname, "data", filename);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`⚠️  Could not load ${filename}:`, e.message);
    return {};
  }
}

const CHAMP_ROLES    = loadJson("champion_roles.json");
const SPELL_ROLES    = loadJson("spell_roles.json");
const KEYSTONE_ROLES = loadJson("keystone_roles.json");

// ── Constants ─────────────────────────────────────────────────────────────────
const ROLES      = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const SMITE_IDS  = new Set([11]);
const FLASH_ID   = 4; // Flash is useless as a signal — excluded from scoring

// ── Flex score — how spread is a champion across roles ────────────────────────
// Returns a value 0-1 where 0 = one-trick (Hecarim jungle only)
// and 1 = completely spread across all roles
function getFlexScore(champName) {
  const dist = CHAMP_ROLES[champName];
  if (!dist) return 0.5; // unknown champion — treat as medium flex

  const values = Object.values(dist);
  const topPct  = Math.max(...values);

  if (topPct >= 85) return 0.0; // very low flex
  if (topPct >= 65) return 0.3; // low flex
  if (topPct >= 50) return 0.6; // medium flex
  return 1.0;                    // high flex
}

// ── Dynamic weights based on flex score ──────────────────────────────────────
function getWeights(flexScore) {
  // Low flex  → trust champion identity more, spells/keystones less
  // High flex → trust spells/keystones more, champion identity less
  return {
    champ:    2.0 - (flexScore * 1.2), // 2.0 (low flex) → 0.8 (high flex)
    spell:    0.8 + (flexScore * 1.2), // 0.8 (low flex) → 2.0 (high flex)
    keystone: 0.8 + (flexScore * 0.7), // 0.8 (low flex) → 1.5 (high flex)
  };
}

// ── Score one player across all roles ────────────────────────────────────────
function scorePlayer(participant) {
  const champName = participant.championName || String(participant.championId);
  const spell1    = participant.spell1Id;
  const spell2    = participant.spell2Id;
  const keystone  = participant.perks?.styles?.[0]?.selections?.[0]?.perk;

  const flexScore = getFlexScore(champName);
  const weights   = getWeights(flexScore);

  const scores = {};
  for (const role of ROLES) scores[role] = 0;

  // Champion distribution score
  const champDist = CHAMP_ROLES[champName];
  if (champDist) {
    for (const [role, pct] of Object.entries(champDist)) {
      if (scores[role] !== undefined) {
        scores[role] += pct * weights.champ;
      }
    }
  }

  // Spell scores (exclude Flash — no signal)
  for (const spellId of [spell1, spell2]) {
    if (!spellId || spellId === FLASH_ID) continue;
    const spellDist = SPELL_ROLES[String(spellId)];
    if (spellDist) {
      for (const [role, pct] of Object.entries(spellDist)) {
        if (scores[role] !== undefined) {
          scores[role] += pct * weights.spell;
        }
      }
    }
  }

  // Keystone score
  if (keystone) {
    const keystoneDist = KEYSTONE_ROLES[String(keystone)];
    if (keystoneDist) {
      for (const [role, pct] of Object.entries(keystoneDist)) {
        if (scores[role] !== undefined) {
          scores[role] += pct * weights.keystone;
        }
      }
    }
  }

  return { scores, flexScore, champName };
}

// ── Generate all permutations of an array ────────────────────────────────────
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

// ── Optimal assignment across all permutations ────────────────────────────────
// For 4 non-jungle players across 4 roles: 4! = 24 permutations
// For 5 players (if no smite): 5! = 120 permutations
// Both are trivially fast
function optimalAssignment(players, availableRoles, playerScores) {
  const perms = permutations(availableRoles);
  let bestTotal    = -Infinity;
  let bestAssignment = null;

  for (const perm of perms) {
    let total = 0;
    for (let i = 0; i < players.length; i++) {
      const role = perm[i];
      total += playerScores[i].scores[role] || 0;
    }
    if (total > bestTotal) {
      bestTotal      = total;
      bestAssignment = perm;
    }
  }

  return bestAssignment;
}

// ── Main inference function ───────────────────────────────────────────────────
function inferRoles(participants) {
  // Separate into teams
  const blue = participants.filter(p => p.teamId === 100);
  const red  = participants.filter(p => p.teamId === 200);

  return {
    blue: inferTeamRoles(blue),
    red:  inferTeamRoles(red),
  };
}

function inferTeamRoles(team) {
  const result = {};

  // Step 1 — Smite pre-filter: lock jungle immediately
  const junglers    = team.filter(p => SMITE_IDS.has(p.spell1Id) || SMITE_IDS.has(p.spell2Id));
  const nonJunglers = team.filter(p => !SMITE_IDS.has(p.spell1Id) && !SMITE_IDS.has(p.spell2Id));

  // Assign jungler(s) — should always be exactly 1
  for (const p of junglers) {
    result[p.puuid || p.summonerName] = {
      role:       "JUNGLE",
      confidence: 100,
      locked:     true, // smite lock
    };
  }

  // Step 2 — Score remaining players across non-jungle roles
  const remainingRoles = ["TOP", "MIDDLE", "BOTTOM", "UTILITY"];
  const playerScores   = nonJunglers.map(p => scorePlayer(p));

  // Step 3 — Optimal assignment across all 24 permutations (4! for 4 roles)
  // Handle edge cases where team size is unexpected
  const rolesToAssign = remainingRoles.slice(0, nonJunglers.length);
  const assignment    = optimalAssignment(nonJunglers, rolesToAssign, playerScores);

  for (let i = 0; i < nonJunglers.length; i++) {
    const p          = nonJunglers[i];
    const role       = assignment[i];
    const confidence = Math.round(playerScores[i].scores[role] || 0);
    const key        = p.puuid || p.summonerName;

    result[key] = {
      role,
      confidence,
      locked:    false,
      flexScore: playerScores[i].flexScore,
      champName: playerScores[i].champName,
    };
  }

  return result;
}

module.exports = { inferRoles };
