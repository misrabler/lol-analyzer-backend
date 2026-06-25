const express  = require("express");
const cors     = require("cors");
const { inferRoles } = require("./inference");

const app  = express();
const PORT = process.env.PORT || 3001;

const RIOT_API_KEY  = process.env.RIOT_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5500")
  .split(",").map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  }
}));
app.use(express.json());

const PLATFORM = "https://na1.api.riotgames.com";
const REGIONAL = "https://americas.api.riotgames.com";

// ── Helpers ───────────────────────────────────────────────────────────────────
async function riotFetch(url, retries = 3) {
  const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { status: res.status, message: err?.status?.message || res.statusText };
  }
  return res.json();
}

async function supabaseFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getCurrentPatch() {
  try {
    const v = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    return v[0].split(".").slice(0, 2).join(".");
  } catch (_) { return "unknown"; }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Combined game data — champions + spells + keystones in one call
app.get("/api/gamedata", async (_req, res) => {
  try {
    const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    const ver      = versions[0];
    const patch    = ver.split(".").slice(0, 2).join(".");

    const [champData, spellData, runeData] = await Promise.all([
      fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/champion.json`).then(r => r.json()),
      fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/summoner.json`).then(r => r.json()),
      fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/runesReforged.json`).then(r => r.json()),
    ]);

    // Build keystone map: id → { name, icon }
    const keystones = {};
    for (const tree of runeData) {
      for (const slot of tree.slots[0]?.runes || []) {
        keystones[slot.id] = { name: slot.name, icon: slot.icon };
      }
    }

    // Build spell map: key (numeric) → { name, image }
    const spells = {};
    for (const [, spell] of Object.entries(spellData.data)) {
      spells[spell.key] = { name: spell.name, image: spell.image.full };
    }

    res.json({
      version: ver,
      patch,
      champions: champData.data,
      spells,
      keystones,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch game data" });
  }
});

// Riot ID → PUUID
app.get("/api/account/:gameName/:tagLine", async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    const data = await riotFetch(
      `${REGIONAL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Live game by PUUID
app.get("/api/livegame/:puuid", async (req, res) => {
  try {
    const data = await riotFetch(
      `${PLATFORM}/lol/spectator/v5/active-games/by-summoner/${req.params.puuid}`
    );
    res.json(data);
  } catch (e) {
    const status  = e.status || 500;
    const message = status === 404 ? "Player is not currently in a game." : e.message;
    res.status(status).json({ error: message });
  }
});

// Infer roles for all 10 participants
app.post("/api/infer-roles", (req, res) => {
  try {
    const { participants } = req.body;
    if (!Array.isArray(participants) || participants.length !== 10) {
      return res.status(400).json({ error: "Expected 10 participants" });
    }
    const result = inferRoles(participants);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check matchup cache
app.get("/api/matchup/:key", async (req, res) => {
  try {
    const patch   = await getCurrentPatch();
    const results = await supabaseFetch(
      `/matchups?matchup_key=eq.${encodeURIComponent(req.params.key)}&patch=eq.${patch}&limit=1`
    );
    if (results?.length > 0) {
      res.json({ cached: true, analysis: results[0].analysis, patch });
    } else {
      res.json({ cached: false, patch });
    }
  } catch (e) {
    res.json({ cached: false, patch: "unknown" });
  }
});

// Save matchup to cache
app.post("/api/matchup", async (req, res) => {
  try {
    const { matchup_key, analysis, patch } = req.body;
    if (!matchup_key || !analysis || !patch) {
      return res.status(400).json({ error: "matchup_key, analysis, patch required" });
    }
    await supabaseFetch("/matchups", {
      method: "POST",
      prefer: "return=minimal",
      body:   JSON.stringify({ matchup_key, analysis, patch }),
    });
    res.json({ saved: true });
  } catch (e) {
    res.json({ saved: false, note: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
