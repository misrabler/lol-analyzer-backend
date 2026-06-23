const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// ── Allow your Netlify frontend (and localhost for testing) ──────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5500")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
  })
);
app.use(express.json());

// ── Riot base URLs for NA ────────────────────────────────────────────────────
const PLATFORM = "https://na1.api.riotgames.com";   // platform-level (spectator, summoner)
const REGIONAL = "https://americas.api.riotgames.com"; // regional (account by Riot ID)

async function riotFetch(url) {
  const res = await fetch(`${url}`, {
    headers: { "X-Riot-Token": RIOT_API_KEY },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ status: { message: res.statusText } }));
    const msg = err?.status?.message || res.statusText;
    throw { status: res.status, message: msg };
  }
  return res.json();
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── 1. Resolve Riot ID → PUUID ───────────────────────────────────────────────
//    GET /api/account/:gameName/:tagLine
app.get("/api/account/:gameName/:tagLine", async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    const data = await riotFetch(
      `${REGIONAL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    res.json(data); // { puuid, gameName, tagLine }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Unknown error" });
  }
});

// ── 2. Summoner by PUUID → summonerId (needed for spectator) ─────────────────
//    GET /api/summoner/:puuid
app.get("/api/summoner/:puuid", async (req, res) => {
  try {
    const data = await riotFetch(
      `${PLATFORM}/lol/summoner/v4/summoners/by-puuid/${req.params.puuid}`
    );
    res.json(data); // { id, accountId, puuid, profileIconId, ... }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Unknown error" });
  }
});

// ── 3. Live game by summonerId ────────────────────────────────────────────────
//    GET /api/livegame/:summonerId
app.get("/api/livegame/:summonerId", async (req, res) => {
  try {
    const data = await riotFetch(
      `${PLATFORM}/lol/spectator/v5/active-games/by-summoner/${req.params.summonerId}`
    );
    res.json(data);
  } catch (e) {
    // 404 = not in game — surface that cleanly
    const status = e.status || 500;
    const message = status === 404 ? "Player is not currently in a game." : e.message;
    res.status(status).json({ error: message });
  }
});

// ── 4. Static: Data Dragon champion list ─────────────────────────────────────
//    GET /api/champions
app.get("/api/champions", async (_req, res) => {
  try {
    // Fetch the latest version first
    const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    const latest = versions[0];
    const champData = await (
      await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`)
    ).json();
    res.json({ version: latest, data: champData.data });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch champion data" });
  }
});

app.listen(PORT, () => console.log(`✅  Server running on port ${PORT}`));
