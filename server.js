const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const RIOT_API_KEY = process.env.RIOT_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
const DD_VERSIONS = "https://ddragon.leagueoflegends.com/api/versions.json";

// ── Helpers ───────────────────────────────────────────────────────────────────
async function riotFetch(url) {
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
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": opts.prefer || "return=representation",
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message || `Supabase error ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getCurrentPatch() {
  try {
    const versions = await (await fetch(DD_VERSIONS)).json();
    // Return major.minor only e.g. "14.11"
    return versions[0].split(".").slice(0, 2).join(".");
  } catch (_) {
    return "unknown";
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true }));

// 1. Riot ID → PUUID
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

// 2. Live game by PUUID
app.get("/api/livegame/:puuid", async (req, res) => {
  try {
    const data = await riotFetch(
      `${PLATFORM}/lol/spectator/v5/active-games/by-summoner/${req.params.puuid}`
    );
    res.json(data);
  } catch (e) {
    const status = e.status || 500;
    const message = status === 404 ? "Player is not currently in a game." : e.message;
    res.status(status).json({ error: message });
  }
});

// 3. Champion data + current patch
app.get("/api/champions", async (_req, res) => {
  try {
    const versions = await (await fetch(DD_VERSIONS)).json();
    const latest = versions[0];
    const patch = latest.split(".").slice(0, 2).join(".");
    const champData = await (
      await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`)
    ).json();
    res.json({ version: latest, patch, data: champData.data });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch champion data" });
  }
});

// 4. Check matchup cache
app.get("/api/matchup/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const patch = await getCurrentPatch();
    const results = await supabaseFetch(
      `/matchups?matchup_key=eq.${encodeURIComponent(key)}&patch=eq.${patch}&limit=1`,
      { prefer: "return=representation" }
    );
    if (results && results.length > 0) {
      res.json({ cached: true, analysis: results[0].analysis, patch });
    } else {
      res.json({ cached: false, patch });
    }
  } catch (e) {
    // If cache check fails, just return not cached so we fall through to Claude
    res.json({ cached: false, patch: "unknown", error: e.message });
  }
});

// 5. Save matchup to cache
app.post("/api/matchup", async (req, res) => {
  try {
    const { matchup_key, analysis, patch } = req.body;
    if (!matchup_key || !analysis || !patch) {
      return res.status(400).json({ error: "matchup_key, analysis, and patch are required" });
    }
    await supabaseFetch("/matchups", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({ matchup_key, analysis, patch })
    });
    res.json({ saved: true });
  } catch (e) {
    // Unique constraint violation = already exists, that's fine
    res.json({ saved: false, note: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
