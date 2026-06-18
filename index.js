// ── Env ───────────────────────────────────────────────────────────────────────
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const path = require('path');

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 1000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pictures', express.static(path.join(__dirname, 'pictures')));

// ── Roblox Join Log ───────────────────────────────────────────────────────────
const JOIN_LOG_CHANNEL_ID = '1512921765721014463';

// ── In-game player tracking (userId strings) ─────────────────────────────────
const playersInGame = new Set();

// ── Player sessions: username (lowercase) -> { username, userId, jobId, joinedAt } ──
// Populated from /roblox/join (every live server reports who joined + its own
// game.JobId). This lets the admin dashboard target a player by username only —
// we look up which server they're currently in and route the command there
// automatically, instead of requiring the Job ID to be copied in by hand.
const playerSessions = new Map();

// Resolve a player's current server (Job ID) by username, across every server
// that has reported a join. Returns null if we don't know where they are, or
// if Roblox has since told us they left.
function findJobIdByUsername(username) {
  if (!username) return null;
  const session = playerSessions.get(String(username).trim().toLowerCase());
  if (!session) return null;
  if (session.userId && !playersInGame.has(session.userId)) return null;
  return session.jobId;
}

// ── Pending in-game claims: robloxUserId -> { animal, mutation, traits } ───────
const pendingInGameClaims = new Map();

// ── Pending fake spawns: jobId -> { animal } ────────────────────────────────
// The game server polls /roblox/pending-fakespawn?jobId=... each spawn cycle.
// When claimed (collected into a base), the server reports back via
// /roblox/confirm-fakespawn and the player gets "Tim Cheese" instead.
const pendingFakeSpawns = new Map();

// ── Pending remote announcements: jobId -> { text } ─────────────────────────
// Each game server polls /roblox/pending-announce?jobId=... and, if there's
// a match, shows the notification to ALL players in that server, then it's
// consumed (one-shot).
const pendingAnnouncements = new Map();

// ── Pending remote spawns: jobId -> { animal, mutation, traits } ─────────────
// Like fake spawns but real — the game server spawns the animal normally
// into the next player's base that collects it, with the given mutation/traits.
const pendingRemoteSpawns = new Map();

// ── Pending remote events: jobId -> { eventName } ───────────────────────────
// The game server polls /roblox/pending-remoteevent?jobId=... and, if there's
// a match, fires EventService:ExecuteEvent for that event name on that server.
const pendingRemoteEvents = new Map();

// ── Pending freeze brainrot: jobId -> { animal, freeze } ────────────────────
// The game server polls /roblox/pending-freezebrainrot?jobId=... and sets
// ForceIdle on all matching brainrots currently on the road.
const pendingFreezebrainrots = new Map();

// ── Pending give item: jobId -> { username, item } ───────────────────────────
// The game server polls /roblox/pending-giveitem?jobId=... and gives the tool
// from ReplicatedStorage.Items to the target player's Backpack.
const pendingGiveItems = new Map();

// ── Pending force speed: jobId -> { username, speed } ────────────────────────
// The game server polls /roblox/pending-forcespeed?jobId=... and forces the
// target player's WalkSpeed. Speed 0 = disable the override.
const pendingForceSpeeds = new Map();

// ── Pending poof-road: jobId -> queued poof-road command ─────────────────────
// The game server polls /roblox/pending-poofroad?jobId=... and, if there's a
// match, poofs all non-craft-spawn animals in workspace.MovingAnimals.
const pendingPoofRoads = new Map();

// ── Pending morph brainrot: jobId -> { username, brainrot, mutation } ─────────
// The game server polls /roblox/pending-morphbrainrot?jobId=... and calls
// the morphbrainrot command on the target player.
const pendingMorphBrainrots = new Map();

// ── Pending play sound: jobId -> { soundId } ─────────────────────────────────
// The game server polls /roblox/pending-playsound?jobId=... and plays the
// given Roblox asset sound for all clients in that server.
const pendingPlaySounds = new Map();

// ── Active redeem codes: codeName -> { brainrotName, limitedUses, usedCount, createdAt } ────
// The game server polls /roblox/redeem-codes to get the full active code list.
// Codes persist until explicitly deleted via the admin dashboard.
const redeemCodes = new Map();

app.post('/roblox/join', async (req, res) => {
  const { username, userId, jobId } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  try {
    const channel = await client.channels.fetch(JOIN_LOG_CHANNEL_ID);
    await channel.send(`🟢 **${username}** (ID: \`${userId}\`) joined the game!`);
    if (userId) playersInGame.add(String(userId));
    if (jobId) {
      playerSessions.set(String(username).toLowerCase(), {
        username,
        userId: userId ? String(userId) : null,
        jobId: String(jobId),
        joinedAt: Date.now(),
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[JoinLog] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Roblox Leave Log ─────────────────────────────────────────────────────────
app.post('/roblox/leave', async (req, res) => {
  const { username, userId, secondsPlayed, jobId } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  try {
    const channel = await client.channels.fetch(JOIN_LOG_CHANNEL_ID);
    const secs = Math.max(0, Math.floor(Number(secondsPlayed) || 0));
    const hours   = Math.floor(secs / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    const seconds = secs % 60;
    const parts = [];
    if (hours   > 0) parts.push(`${hours} hour${hours   !== 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);
    const timeStr = parts.join(' and ');
    if (userId) playersInGame.delete(String(userId));
    // Only clear the tracked session if it still points at the server they're
    // leaving — avoids wiping a newer session if they already rejoined elsewhere.
    const key = String(username).toLowerCase();
    const session = playerSessions.get(key);
    if (session && (!jobId || session.jobId === String(jobId))) {
      playerSessions.delete(key);
    }
    await channel.send(`🔴 **${username}** (ID: \`${userId}\`) left the game after playing for **${timeStr}**.`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[LeaveLog] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Roblox Spawn Log ──────────────────────────────────────────────────────────
const SPAWN_LOG_CHANNEL_ID = '1512921765721014463';

app.post('/roblox/spawn', async (req, res) => {
  const { player, brainrot, rarity, mutation, traits, message } = req.body;
  if (!brainrot) return res.status(400).json({ error: 'Missing brainrot' });
  try {
    const channel = await client.channels.fetch(SPAWN_LOG_CHANNEL_ID);
    const mutText = mutation && mutation !== 'None' ? ` **${mutation}**` : '';
    const traitText = traits && traits.length ? ` [${traits.join(', ')}]` : '';
    await channel.send(`🐾 **${player}** got a${mutText} **${brainrot}**${traitText} — Rarity: \`${rarity}\``);
    res.json({ ok: true });
  } catch (err) {
    console.error('[SpawnLog] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── In-game claim endpoints ──────────────────────────────────────────────────
app.get('/roblox/pending-claim', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const claim = pendingInGameClaims.get(userId);
  if (!claim) return res.json({ pending: false });
  res.json({ pending: true, type: claim.type || 'spawn', animal: claim.animal, mutation: claim.mutation, traits: claim.traits, trait: claim.trait, duration: claim.duration });
});

app.post('/roblox/confirm-claim', (req, res) => {
  const { userId, success, error } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const idStr = String(userId);
  if (success) {
    pendingInGameClaims.delete(idStr);
    console.log(`[InGameClaim] Confirmed for ${idStr}`);
  } else {
    console.warn(`[InGameClaim] Spawn failed for ${idStr}: ${error}`);
  }
  res.json({ ok: true });
});

// ── Fake spawn poll endpoint (called by the Roblox game server each cycle) ───
app.get('/roblox/pending-fakespawn', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const spawn = pendingFakeSpawns.get(jobId);
  if (!spawn) return res.json({ pending: false });
  pendingFakeSpawns.delete(jobId); // one-shot: deliver once, don't keep re-spawning
  res.json({ pending: true, animal: spawn.animal, fakeType: spawn.fakeType ?? 'fake1' });
});

// Called by the game server after a fake animal is collected into a player's base.
// The server should then give the player "Tim Cheese" instead.
app.post('/roblox/confirm-fakespawn', async (req, res) => {
  const { jobId, collectedByUserId, collectedByUsername } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

  console.log(`[FakeSpawn] Consumed by ${collectedByUsername ?? collectedByUserId} in job ${jobId}`);

  res.json({ ok: true });
});

// ── Remote announce poll endpoint (called by the Roblox game server) ────────
app.get('/roblox/pending-announce', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const ann = pendingAnnouncements.get(jobId);
  if (!ann) return res.json({ pending: false });
  pendingAnnouncements.delete(jobId); // one-shot
  res.json({ pending: true, text: ann.text });
});

// ── Remote spawn poll endpoint (called by the Roblox game server each cycle) ─
app.get('/roblox/pending-remotespawn', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const spawn = pendingRemoteSpawns.get(jobId);
  if (!spawn) return res.json({ pending: false });
  pendingRemoteSpawns.delete(jobId); // one-shot
  res.json({ pending: true, animal: spawn.animal, mutation: spawn.mutation || null, traits: spawn.traits || [] });
});

// ── Remote event poll endpoint (called by the Roblox game server each cycle) ─
app.get('/roblox/pending-remoteevent', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const evt = pendingRemoteEvents.get(jobId);
  if (!evt) return res.json({ pending: false });
  pendingRemoteEvents.delete(jobId); // one-shot
  res.json({ pending: true, eventName: evt.eventName });
});

// ── Freeze brainrot poll endpoint ────────────────────────────────────────────
app.get('/roblox/pending-freezebrainrot', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const entry = pendingFreezebrainrots.get(jobId);
  if (!entry) return res.json({ pending: false });
  pendingFreezebrainrots.delete(jobId); // one-shot
  res.json({ pending: true, animal: entry.animal, freeze: entry.freeze });
});

// ── Give item poll endpoint ───────────────────────────────────────────────────
app.get('/roblox/pending-giveitem', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const entry = pendingGiveItems.get(jobId);
  if (!entry) return res.json({ pending: false });
  pendingGiveItems.delete(jobId); // one-shot
  res.json({ pending: true, username: entry.username, item: entry.item });
});

// ── Force speed poll endpoint ─────────────────────────────────────────────────
app.get('/roblox/pending-forcespeed', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const entry = pendingForceSpeeds.get(jobId);
  if (!entry) return res.json({ pending: false });
  pendingForceSpeeds.delete(jobId); // one-shot
  res.json({ pending: true, username: entry.username, speed: entry.speed });
});

// ── Poof-road poll endpoint ───────────────────────────────────────────────────
// The game server polls this each cycle. If there's a pending command for its
// jobId, it returns { pending: true } and the server poofs all non-craft-spawn
// animals currently in workspace.MovingAnimals.
app.get('/roblox/pending-poofroad', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const entry = pendingPoofRoads.get(jobId);
  if (!entry) return res.json({ pending: false });
  pendingPoofRoads.delete(jobId); // one-shot
  res.json({ pending: true });
});

// ── Morph brainrot poll endpoint ──────────────────────────────────────────────
// The game server polls this each cycle. Returns the username, brainrot name,
// and optional mutation to apply via the morphbrainrot Conch command.
app.get('/roblox/pending-morphbrainrot', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const entry = pendingMorphBrainrots.get(jobId);
  if (!entry) return res.json({ pending: false });
  pendingMorphBrainrots.delete(jobId); // one-shot
  res.json({ pending: true, username: entry.username, brainrot: entry.brainrot, mutation: entry.mutation || null });
});

// ── Play sound poll endpoint ──────────────────────────────────────────────────
// The game server polls this each cycle. If there's a pending sound for its
// jobId, it returns { pending: true, soundId } and the server plays it for
// all clients, then the command is consumed (one-shot).
app.get('/roblox/pending-playsound', (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const entry = pendingPlaySounds.get(jobId);
  if (!entry) return res.json({ pending: false });
  pendingPlaySounds.delete(jobId); // one-shot
  res.json({ pending: true, soundId: entry.soundId });
});

// ── Redeem codes endpoint (polled by ALL game servers to get active codes) ────
// Returns the full map of active codes so the game can validate redemptions.
// When a player redeems a code in-game, the game calls /roblox/use-redeemcode
// to consume a use (or mark fully used if limited).
app.get('/roblox/redeem-codes', (req, res) => {
  const out = {};
  for (const [name, data] of redeemCodes.entries()) {
    const entry = {
      Reward:       'Brainrot',
      limitedUses:  data.limitedUses,
      usedCount:    data.usedCount,
      // camelCase aliases so any existing poll script still works
      brainrotName:  data.brainrotName  || null,
      brainrotNames: data.brainrotNames || null,
      bundleName:    data.bundleName    || null,
      isTriple:      data.isTriple      || false,
    };
    if (data.isTriple && data.brainrotNames) {
      // PascalCase fields matching the internal CODES table shape
      entry.Names      = data.brainrotNames;
      entry.BundleName = data.bundleName || null;
    } else {
      entry.Name = data.brainrotName || null;
    }
    out[name] = entry;
  }
  res.json({ codes: out });
});

// Called by the game server when a player successfully redeems a code.
app.post('/roblox/use-redeemcode', (req, res) => {
  const codeName = String(req.body.codeName || '').toUpperCase();
  if (!codeName) return res.status(400).json({ error: 'Missing codeName' });
  const entry = redeemCodes.get(codeName);
  if (!entry) return res.status(404).json({ error: 'Code not found' });
  entry.usedCount = (entry.usedCount || 0) + 1;
  // Auto-delete when limited uses are exhausted
  if (entry.limitedUses && entry.usedCount >= entry.limitedUses) {
    redeemCodes.delete(codeName);
    console.log(`[RedeemCode] "${codeName}" exhausted all ${entry.limitedUses} uses — deleted.`);
    return res.json({ ok: true, exhausted: true });
  }
  console.log(`[RedeemCode] "${codeName}" used — ${entry.usedCount}/${entry.limitedUses ?? '∞'}`);
  res.json({ ok: true, exhausted: false });
});

// ── Discord ──────────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const ROBLOX_API_KEY  = process.env.ROBLOX_API_KEY;
const UNIVERSE_ID     = process.env.UNIVERSE_ID;
const DATASTORE_NAME  = 'DATA-FOR-EVERYONE';
const BASE = `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore`;
const CACHE_FILE = './cache.json';
const BATCH_SIZE = 20;

// ── Authorised Discord user IDs for /give ────────────────────────────────────
const GIVE_ALLOWED_IDS = new Set(['1170834053004529747']);

// ── Cache ────────────────────────────────────────────────────────────────────
let cache = null;

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`[Cache] Loaded — built at ${cache.builtAt}`);
    }
  } catch { cache = null; }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Pairing System (Discord ↔ Roblox) ────────────────────────────────────────
const PAIRS_FILE = './pairs.json';
let pairs = {}; // { discordUserId: { robloxUsername, robloxUserId, robloxDisplayName, pairedAt } }

function loadPairs() {
  try {
    if (fs.existsSync(PAIRS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8'));
      // Migration: wipe entries without a passwordHash so users must re-pair and set a password.
      let wiped = 0;
      for (const [id, entry] of Object.entries(loaded)) {
        if (entry.passwordHash) {
          pairs[id] = entry;
        } else {
          wiped++;
        }
      }
      const kept = Object.keys(pairs).length;
      console.log(`[Pairs] Loaded ${kept} paired accounts (${wiped} legacy entries wiped — must re-pair).`);
      if (wiped > 0) savePairs();
    }
  } catch { pairs = {}; }
}

function savePairs() {
  fs.writeFileSync(PAIRS_FILE, JSON.stringify(pairs, null, 2));
}

function getPairedUsername(discordUserId) {
  return pairs[discordUserId]?.robloxUsername ?? null;
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function checkPassword(discordUserId, password) {
  const entry = pairs[discordUserId];
  if (!entry || !entry.passwordHash) return false;
  return entry.passwordHash === hashPassword(password);
}

// ── Roblox API ───────────────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch a single datastore entry with retry on 429
async function getEntry(key) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const res = await axios.get(`${BASE}/entries/entry`, {
        params:  { datastoreName: DATASTORE_NAME, entryKey: key },
        headers: { 'x-api-key': ROBLOX_API_KEY },
        timeout: 15000,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const wait = Math.min(Math.pow(2, attempt) * 1000, 30000);
        console.warn(`[RateLimit] getEntry 429 — waiting ${wait}ms (attempt ${attempt + 1})`);
        await sleep(wait);
      } else if (status === 404) {
        return null;
      } else {
        console.warn(`[getEntry] "${key}" failed: ${status ?? err.message}`);
        return null;
      }
    }
  }
  console.warn(`[getEntry] Gave up on "${key}"`);
  return null;
}

// Fetch all datastore keys with retry on 429
async function getAllKeys() {
  const keys = [];
  let cursor = null;
  do {
    let success = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const params = { datastoreName: DATASTORE_NAME, limit: 100 };
        if (cursor) params.cursor = cursor;
        const res = await axios.get(`${BASE}/entries`, {
          params, headers: { 'x-api-key': ROBLOX_API_KEY }, timeout: 15000,
        });
        for (const e of res.data.keys ?? []) keys.push(e.key);
        cursor = res.data.nextPageCursor ?? null;
        success = true;
        break;
      } catch (err) {
        const status = err.response?.status;
        if (status === 429) {
          const wait = Math.min(Math.pow(2, attempt) * 1000, 30000);
          console.warn(`[RateLimit] getAllKeys 429 — waiting ${wait}ms`);
          await sleep(wait);
        } else {
          throw new Error(`getAllKeys failed: ${status ?? err.message}`);
        }
      }
    }
    if (!success) throw new Error('getAllKeys: gave up after 10 retries');
    await sleep(300); // brief pause between pages
  } while (cursor);
  return keys;
}

// Full datastore scan — updates statusMsg every ~8s
async function buildCache(statusMsg) {
  await statusMsg.edit('⏳ Step 1/2: Fetching key list...').catch(() => {});

  const keys = await getAllKeys();
  const total = keys.length;
  const data = {};
  let processed = 0;
  let lastUpdate = Date.now();

  await statusMsg.edit(`⏳ Step 2/2: Scanning **${total}** entries...`).catch(() => {});
  console.log(`[Cache] Scanning ${total} keys...`);

  for (const key of keys) {
    const entry = await getEntry(key);

    if (entry && typeof entry === 'object') {
      const podiums = entry.AnimalPodiums;
      if (Array.isArray(podiums)) {
        for (const pod of podiums) {
          if (!pod || typeof pod !== 'object' || !pod.Index) continue;
          const name = pod.Index;
          if (!data[name]) data[name] = { totalCount: 0, mutationCounts: {}, traitCounts: {} };
          data[name].totalCount++;
          const mut = pod.Mutation || 'Normal';
          data[name].mutationCounts[mut] = (data[name].mutationCounts[mut] ?? 0) + 1;
          if (Array.isArray(pod.Traits)) {
            for (const trait of pod.Traits) {
              data[name].traitCounts[trait] = (data[name].traitCounts[trait] ?? 0) + 1;
            }
          }
        }
      }
    }

    processed++;
    await sleep(100); // throttle: ~10 req/s max

    const now = Date.now();
    if (now - lastUpdate >= 8000) {
      lastUpdate = now;
      const pct = Math.floor((processed / total) * 100);
      console.log(`[Cache] ${processed}/${total} (${pct}%)`);
      await statusMsg.edit(`⏳ Scanning... **${processed}/${total}** (${pct}%)`).catch(() => {});
    }
  }

  cache = { builtAt: new Date().toISOString(), data };
  saveCache();
  console.log(`[Cache] Done — ${total} keys, ${Object.keys(data).length} animals.`);
}
// ── Format for Discord ───────────────────────────────────────────────────────
function formatOutput(name, { totalCount, mutationCounts, traitCounts }) {
  const lines = [`=== ${name} ===`, `Total: ${totalCount}`, '', 'Mutations:'];
  if (!Object.keys(mutationCounts).length) {
    lines.push('  None');
  } else {
    for (const [m, c] of Object.entries(mutationCounts).sort((a,b) => b[1]-a[1]))
      lines.push(`  ${m}: ${c}`);
  }
  if (Object.keys(traitCounts).length) {
    lines.push('', 'Traits:');
    for (const [t, c] of Object.entries(traitCounts).sort((a,b) => b[1]-a[1]))
      lines.push(`  ${t}: ${c}`);
  }
  return lines.join('\n');
}

// ── Helper — detect empty podium slots ───────────────────────────────────────
function isEmptySlot(slot) {
  if (slot === null || slot === undefined) return true;
  if (slot === 'Empty' || slot === '' || slot === false || slot === 0) return true;
  if (typeof slot === 'object' && !slot.Index) return true;
  return false;
}

// ── Core give logic ──────────────────────────────────────────────────────────
// ── In-game spawn helper ─────────────────────────────────────────────────────
// Resolves the robloxUserId for a username, checks playersInGame, and either
// fires the /roblox/spawn-for-player endpoint (if in-game) OR falls back to
// writing directly to the datastore via giveAnimalToPlayer.
// Returns { userName, method: 'ingame' | 'datastore' }
async function spawnAnimalSmrt(username, animal, mutation = null, traits = []) {
  const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
    usernames: [username], excludeBannedUsers: false,
  });
  const user = userRes.data?.data?.[0];
  if (!user) throw new Error(`Player "${username}" not found on Roblox.`);
  const robloxUserId = String(user.id);
  const userName = user.name;

  if (playersInGame.has(robloxUserId)) {
    // Queue an in-game claim — the player's game client will poll and spawn it into their base
    pendingInGameClaims.set(robloxUserId, { animal, mutation: mutation || null, traits: traits || [] });
    return { userName, method: 'ingame' };
  }

  // Fallback: write directly to datastore
  const result = await giveAnimalToPlayer(username, animal, mutation, traits);
  return { userName: result.userName, method: 'datastore' };
}

async function giveAnimalToPlayer(username, animal, mutation = null, traits = []) {
  const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
    usernames: [username], excludeBannedUsers: false,
  });
  const user = userRes.data?.data?.[0];
  if (!user) throw new Error(`Player "${username}" not found on Roblox.`);

  const userId   = String(user.id);
  const userName = user.name;

  const entry = await getEntry(userId);
  if (!entry) throw new Error(`"${userName}" hasn't played the game yet.`);

  const podiums = entry.AnimalPodiums;
  if (!Array.isArray(podiums)) throw new Error(`"${userName}" has no base data.`);

  let emptyIdx = -1;
  for (let i = 0; i < podiums.length; i++) {
    if (isEmptySlot(podiums[i])) { emptyIdx = i; break; }
  }

  if (emptyIdx === -1) {
    console.log(`[Give] No empty slot for ${userName}. First 5 slots:`, JSON.stringify(podiums.slice(0, 5)));
    throw new Error(`${userName}'s base is full — no empty slots available.`);
  }

  const podium = {
    Index:       animal,
    LastCollect: Math.floor(Date.now() / 1000),
    OfflineGain: 0,
  };
  if (mutation && mutation !== 'Normal') podium.Mutation = mutation;
  if (traits.length > 0) podium.Traits = traits;

  podiums[emptyIdx] = podium;
  entry.AnimalPodiums = podiums;

  await axios.post(`${BASE}/entries/entry`, JSON.stringify(entry), {
    params:  { datastoreName: DATASTORE_NAME, entryKey: userId },
    headers: {
      'x-api-key':              ROBLOX_API_KEY,
      'Content-Type':           'application/json',
      'roblox-entry-userids':   JSON.stringify([Number(userId)]),
    },
    timeout: 15000,
  });

  console.log(`[Give] ${userName} received ${mutation ? mutation + ' ' : ''}${animal}${traits.length ? ' [' + traits.join(', ') + ']' : ''}`);
  return { userName };
}

// ── Web API ──────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/api/brainrot', (req, res) => {
  const name = req.query.name?.trim();
  if (!name) return res.status(400).json({ error: 'Missing ?name= parameter' });
  if (!cache) return res.status(503).json({ error: 'Cache not built yet. Run /rebuildcache in Discord first.' });
  const entry = cache.data[name];
  if (!entry) return res.status(404).json({ error: `No data found for "${name}"` });
  res.json({ name, builtAt: cache.builtAt, ...entry });
});

app.get('/api/list', (req, res) => {
  if (!cache) return res.json({ names: [] });
  const names = Object.keys(cache.data).sort();
  res.json({ names });
});

app.get('/api/picture', (req, res) => {
  const name = req.query.name?.trim();
  if (!name) return res.json({ found: false });
  const exts = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  for (const ext of exts) {
    if (fs.existsSync(path.join(__dirname, 'pictures', `${name}.${ext}`)))
      return res.json({ found: true, url: `/pictures/${name}.${ext}` });
  }
  res.json({ found: false });
});

app.get('/api/status', (req, res) => {
  if (!cache) return res.json({ ready: false });
  res.json({ ready: true, builtAt: cache.builtAt, totalAnimals: Object.keys(cache.data).length });
});

// ── Roll System ──────────────────────────────────────────────────────────────
const ROLLABLE_FILE = './rollable.json';

// ── Secret animals with ultra-rare 0.001 weight each ────────────────────────
const SECRET_ANIMALS = ['John Pork', 'Meowl', 'Strawberry Elephant', 'Lazy Ducky'];
const SECRET_WEIGHT  = 0.001;

function loadRollable() {
  try {
    const data = JSON.parse(fs.readFileSync(ROLLABLE_FILE, 'utf8'));
    return Array.isArray(data.animals) ? data.animals : [];
  } catch { return []; }
}

function saveRollable(animals) {
  fs.writeFileSync(ROLLABLE_FILE, JSON.stringify({ animals }, null, 2), 'utf8');
}

// ── DLC Code System ──────────────────────────────────────────────────────────
const DLC_TRACKING_FILE    = './dlc_tracking.json';
const DLC_POOL_SECRET_FILE = './DLCPoolSecret.json';
const DLC_POOL_OP_FILE     = './DLCPoolOP.json';
const DLC_POOL_ASCENDED_FILE = './DLCPoolAscended.json';

const DLC_GAMEPASS_ID = '1874852361';

// ── DLC Pool loaders — reads directly from JSON files ────────────────────────
function loadDLCPool(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data.animals) && data.animals.length) return data.animals;
    throw new Error('"animals" array is missing or empty in ' + file);
  } catch (err) {
    throw new Error('Failed to load DLC pool from ' + file + ': ' + err.message);
  }
}

// ── DLC Tracking — all code data lives in dlc_tracking.json ──────────────────
// Structure:
// {
//   generatedBy: { robloxUserId: code },
//   codes: {
//     CODE: { tier, brainrot, generatedByRobloxId, generatedByRobloxName, generatedAt,
//             claimedBy: robloxUserId|null, claimedAt: iso|null, status: 'unclaimed'|'claimed' }
//   }
// }
function loadDLCTracking() {
  try {
    if (fs.existsSync(DLC_TRACKING_FILE)) return JSON.parse(fs.readFileSync(DLC_TRACKING_FILE, 'utf8'));
  } catch {}
  return { generatedBy: {}, codes: {} };
}

function saveDLCTracking(data) {
  fs.writeFileSync(DLC_TRACKING_FILE, JSON.stringify(data, null, 2));
}

function generateDLCCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function rollDLCTier() {
  const r = Math.random();
  if (r < 0.60) return 'Secret';   // 60%
  if (r < 0.90) return 'OP';       // 30%
  return 'Ascended';               // 10%
}

function rollDLCBrainrot(tier) {
  const file = tier === 'Secret' ? DLC_POOL_SECRET_FILE : tier === 'OP' ? DLC_POOL_OP_FILE : DLC_POOL_ASCENDED_FILE;
  const pool = loadDLCPool(file);
  return pool[Math.floor(Math.random() * pool.length)];
}

function rollDLCMutation() {
  const r = Math.random();
  if (r < 0.30) return 'Koolio';   // 30%
  if (r < 0.60) return 'YinYang';  // 30%
  if (r < 0.80) return 'Cyber';    // 20%
  return null;                      // 20% nothing
}

async function checkRobloxGamepass(robloxUserId, gamepassId) {
  try {
    const res = await axios.get(`https://inventory.roblox.com/v1/users/${robloxUserId}/items/GamePass/${gamepassId}`, {
      timeout: 10000,
    });
    return Array.isArray(res.data?.data) && res.data.data.length > 0;
  } catch (err) {
    // 403 means private inventory but the user might still own it; treat as unknown
    if (err.response?.status === 403) return null; // null = can't verify
    return false;
  }
}

function rollAnimal(animals) {
  // Each normal animal has weight 1, each secret has weight 0.001
  const secretTotal = SECRET_WEIGHT * SECRET_ANIMALS.length;
  const totalWeight = animals.length + secretTotal;

  const r = Math.random() * totalWeight;

  // First slice belongs to secret animals
  if (r < secretTotal) {
    const idx = Math.floor(r / SECRET_WEIGHT);
    return SECRET_ANIMALS[Math.min(idx, SECRET_ANIMALS.length - 1)];
  }

  // Remainder belongs to normal animals, uniformly
  const normalR = r - secretTotal;
  return animals[Math.min(Math.floor(normalR), animals.length - 1)];
}

// ── Mutation Roll (25% chance) ───────────────────────────────────────────────
const MUTATIONS = [
  { name: 'Gold',        weight: 7   },
  { name: 'Diamond',     weight: 3   },
  { name: 'Rainbow',     weight: 0.2 },
  { name: 'Candy',       weight: 1   },
  { name: 'Lava',        weight: 1   },
  { name: 'Galaxy',      weight: 1   },
  { name: 'YinYang',     weight: 1   },
  { name: 'Radioactive', weight: 1   },
  { name: 'Cursed',      weight: 1   },
  { name: 'Divine',      weight: 1   },
  { name: 'Cyber',       weight: 1   },
  { name: 'Bloodrot',    weight: 2   },
];
const MUTATION_TOTAL_WEIGHT = MUTATIONS.reduce((s, m) => s + m.weight, 0);

function rollMutation() {
  // 25% chance of getting a mutation at all
  if (Math.random() >= 0.25) return null;

  // Weighted pick among mutations
  let r = Math.random() * MUTATION_TOTAL_WEIGHT;
  for (const m of MUTATIONS) {
    r -= m.weight;
    if (r <= 0) return m.name;
  }
  return MUTATIONS[MUTATIONS.length - 1].name;
}

// ── Trait Roll (35% chance, only during TraitTime) ───────────────────────────
const TRAITS = [
  'Taco','Pizza','Nyan','Galactic','Lucky','John Pork','Los Friends',
  'Orange Egg','Green Egg','Blue Egg','Pink Egg','Orange Balloon','Bunny Ears',
  'Green Balloon','Granny','Blue Balloon','Red Balloon','Pink Balloon',
  'Rainbow Balloon','Fireworks','Zombie','Claws','Glitched','Bubblegum','Fire',
  'Wet','Snowy','Cometstruck','Explosive','Disco','10B','1YR','Shark Fin',
  'Matteo Hat','Brazil','Sleepy','Lightning','UFO','Spider','Strawberry','Paint',
  'Skeleton','Sombrero','Tie','Witch Hat','Indonesia','Meowl','RIP Gravestone',
  'Jackolantern Pet','Santa Hat','Reindeer Pet','Skibidi','Pochito','Halo',
  '26','Rose',':3','Chocolate','Koolio Signed','Zeta Signed',
];

// ── Lucky Blocks (for /rngblock) ────────────────────────────────────────────
const LUCKY_BLOCKS = [
  { name: 'Mythic Lucky Block',           rarity: 'Mythic',        weight: 500  },
  { name: 'Brainrot God Lucky Block',     rarity: 'Brainrot God',  weight: 10   },
  { name: 'Secret Lucky Block',           rarity: 'Secret',        weight: 0.7  },
  { name: 'Admin Lucky Block',            rarity: 'Admin',         weight: 5    },
  { name: 'Taco Lucky Block',             rarity: 'Taco',          weight: 20   },
  { name: 'Los Lucky Blocks',             rarity: 'Admin',         weight: 5    },
  { name: 'Spooky Lucky Block',           rarity: 'Spooky',        weight: 15   },
  { name: 'Los Taco Blocks',              rarity: 'Taco',          weight: 15   },
  { name: 'Festive Lucky Block',          rarity: 'Festive',       weight: 12   },
  { name: 'Premium Festive Lucky Block',  rarity: 'Festive',       weight: 8    },
  { name: 'Leprechaun Lucky Block',       rarity: "St Patrick's",  weight: 12   },
  { name: 'Premium Leprechaun Lucky Block', rarity: "St Patrick's", weight: 8   },
  { name: 'Egg Lucky Block',              rarity: 'Easter',        weight: 10   },
  { name: 'Heart Lucky Block',            rarity: 'Valentines',    weight: 12   },
  { name: 'Premium Heart Lucky Block',    rarity: 'Valentines',    weight: 8    },
];
const LUCKY_BLOCK_TOTAL_WEIGHT = LUCKY_BLOCKS.reduce((s, b) => s + b.weight, 0);

function rollLuckyBlock() {
  let r = Math.random() * LUCKY_BLOCK_TOTAL_WEIGHT;
  for (const b of LUCKY_BLOCKS) {
    r -= b.weight;
    if (r <= 0) return b;
  }
  return LUCKY_BLOCKS[LUCKY_BLOCKS.length - 1];
}

// ── TraitTime state: unix timestamp (ms) when TraitTime expires (0 = inactive)
let traitTimeExpiresAt = 0;

// ── LuckTime state ───────────────────────────────────────────────────────────
const LUCK_ANIMALS = ['Lazy Ducky', 'John Pork', 'Rang Ring Bus', 'Elefanto Frigo'];
let luckTimeTimer = null; // setTimeout ref so we can restore rollable when LuckTime ends

function rollTraits() {
  if (Date.now() > traitTimeExpiresAt) return [];
  const rolled = [];
  const used = new Set();
  // 'Koolio Signed' and 'Zeta Signed' are never available from RNG — they must be given manually
  const rollableTraits = TRAITS.filter(t => t !== 'Koolio Signed' && t !== 'Zeta Signed');
  for (let i = 0; i < 3; i++) {
    if (Math.random() >= 0.35) break;
    const available = rollableTraits.filter(t => !used.has(t));
    if (!available.length) break;
    const pick = available[Math.floor(Math.random() * available.length)];
    rolled.push(pick);
    used.add(pick);
  }
  return rolled;
}


app.get('/api/roll', (req, res) => {
  const animals = loadRollable();
  if (!animals.length) return res.status(503).json({ error: 'No rollable animals configured.' });
  const animal = animals[Math.floor(Math.random() * animals.length)];
  res.json({ animal });
});

app.get('/api/rollable', (req, res) => {
  res.json({ animals: loadRollable() });
});

// Debug — raw datastore entry
app.get('/api/debug', async (req, res) => {
  const username = req.query.username?.trim();
  if (!username) return res.status(400).json({ error: 'Missing ?username= parameter' });
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const entry = await getEntry(String(user.id));
    if (!entry) return res.status(404).json({ error: 'No datastore entry found.' });
    res.json({ userId: user.id, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim — web roll page
app.post('/api/claim', async (req, res) => {
  const { username, animal } = req.body;
  if (!username || !animal) return res.status(400).json({ error: 'Missing username or animal.' });

  const rollable = loadRollable();
  if (!rollable.includes(animal)) return res.status(400).json({ error: 'That animal is not rollable.' });

  try {
    const { userName } = await giveAnimalToPlayer(username, animal);
    res.json({ success: true, message: `${animal} has been added to ${userName}'s base!`, username: userName });
  } catch (err) {
    console.error('[Claim] Error:', err.message);
    if (err.response?.status === 403)
      return res.status(403).json({ error: 'API key does not have DataStore Write permission.' });
    res.status(500).json({ error: err.message });
  }
});

// Live spawns
const SPAWN_DS = `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore`;
let spawnCache = { data: [], fetchedAt: 0 };

app.get('/api/spawns', async (req, res) => {
  const now = Date.now();
  if (now - spawnCache.fetchedAt < 15000) return res.json(spawnCache.data);
  try {
    const r = await axios.get(`${SPAWN_DS}/entries/entry`, {
      params:  { datastoreName: 'LIVEBOARD-SPAWNS', entryKey: 'spawns' },
      headers: { 'x-api-key': ROBLOX_API_KEY },
      timeout: 10000,
    });
    const spawns = Array.isArray(r.data) ? r.data : [];
    spawns.sort((a, b) => b.t - a.t);
    spawnCache = { data: spawns.slice(0, 25), fetchedAt: now };
    res.json(spawnCache.data);
  } catch {
    res.json(spawnCache.data);
  }
});

// Player lookup
app.get('/api/player', async (req, res) => {
  const username = req.query.username?.trim();
  if (!username) return res.status(400).json({ error: 'Missing ?username= parameter' });

  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });

    const userId      = user.id;
    const exactName   = user.name;
    const displayName = user.displayName;

    const entry = await getEntry(String(userId));
    if (!entry) return res.status(404).json({ error: `No data found for "${exactName}". They may not have played the game.` });

    const podiums = entry.AnimalPodiums;
    if (!Array.isArray(podiums)) return res.status(404).json({ error: `No base data found for "${exactName}".` });

    const animals = [];
    for (const pod of podiums) {
      if (!pod || typeof pod !== 'object' || !pod.Index) continue;
      animals.push({
        name:     pod.Index,
        mutation: pod.Mutation || null,
        traits:   Array.isArray(pod.Traits) ? pod.Traits : [],
      });
    }

    let avatarUrl = null;
    try {
      const av = await axios.get('https://thumbnails.roblox.com/v1/users/avatar-headshot', {
        params: { userIds: userId, size: '150x150', format: 'Png' },
      });
      avatarUrl = av.data?.data?.[0]?.imageUrl || null;
    } catch {}

    res.json({ username: exactName, displayName, userId, avatarUrl, animals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to look up player: ' + (err.response?.data?.message ?? err.message) });
  }
});

// ── Discord commands ─────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('brainrotcounts')
      .setDescription('Count how many players own a specific brainrot animal')
      .addStringOption(o => o.setName('brainrot').setDescription('Brainrot name').setRequired(true)),
    new SlashCommandBuilder()
      .setName('roll')
      .setDescription('Roll a random brainrot for the web page'),
    new SlashCommandBuilder()
      .setName('cachestatus')
      .setDescription('Check when the cache was last built'),
    new SlashCommandBuilder()
      .setName('pair')
      .setDescription('Link your Discord account to your Roblox username')
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Your Roblox username')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('password')
          .setDescription('Set a password (first time) or enter your existing password (required to re-pair)')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('unpair')
      .setDescription('Unlink your Discord account from Roblox')
      .addStringOption(o =>
        o.setName('password')
          .setDescription('Your pairing password')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('pairstatus')
      .setDescription('Check which Roblox account you are paired to'),
    new SlashCommandBuilder()
      .setName('rng')
      .setDescription('Roll a random brainrot — claim it or re-roll!'),
    new SlashCommandBuilder()
      .setName('clearrng')
      .setDescription('Delete all pending /rng roll messages and reset everyone\'s roll (restricted)'),
    new SlashCommandBuilder()
      .setName('viewbase')
      .setDescription('View what brainrots a player has in their base')
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Roblox username to look up')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('give')
      .setDescription('Give a brainrot to a player\'s Roblox base (restricted)')
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Roblox username of the player')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('animal')
          .setDescription('Exact brainrot name')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('mutation')
          .setDescription('Mutation (e.g. Gold, Diamond, Rainbow) — leave blank for Normal')
          .setRequired(false))
      .addStringOption(o =>
        o.setName('traits')
          .setDescription('Traits, comma-separated (e.g. Halo, Lucky) — leave blank for none')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('rngblock')
      .setDescription('Roll a random Lucky Block — claim it or re-roll!'),
    new SlashCommandBuilder()
      .setName('traittime')
      .setDescription('Activate TraitTime — rng rolls have a 35% trait chance for N seconds (restricted)')
      .addIntegerOption(o =>
        o.setName('amount')
          .setDescription('Duration in seconds')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(86400)),
    new SlashCommandBuilder()
      .setName('editbrainrot')
      .setDescription('Edit the mutation and traits of a brainrot in a player\'s base (restricted)')
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Roblox username of the player')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('mutation')
          .setDescription('Mutation (e.g. Gold, Diamond) — leave blank to clear')
          .setRequired(false))
      .addStringOption(o =>
        o.setName('traits')
          .setDescription('Traits, comma-separated (e.g. Halo, Lucky) — leave blank to clear')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('announce')
      .setDescription('Send a message to the announcements channel (restricted)'),
    new SlashCommandBuilder()
      .setName('luck')
      .setDescription('Activate LuckTime — adds rare secret animals to the rollable pool for N seconds (restricted)')
      .addIntegerOption(o =>
        o.setName('amount')
          .setDescription('Duration in seconds')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(86400)),
    new SlashCommandBuilder()
      .setName('signanimal')
      .setDescription('Add the "Koolio Signed" trait to a brainrot in a player\'s base (restricted)')
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Roblox username of the player')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('troll')
      .setDescription("Temporarily turn a player's whole base into Noobini Pizzanini (restricted)")
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Roblox username of the player')
          .setRequired(true))
      .addIntegerOption(o =>
        o.setName('duration')
          .setDescription('Seconds until their base reverts back to normal')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(86400))
      .addStringOption(o =>
        o.setName('brainrot')
          .setDescription('Brainrot to turn everything into — leave blank for Noobini Pizzanini')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('rebuildcache')
      .setDescription('Rebuild the brainrot animal cache from the datastore (restricted)'),
    new SlashCommandBuilder()
      .setName('dlccode')
      .setDescription('Generate a one-time DLC code (requires linked account + DLC Code gamepass)'),
    new SlashCommandBuilder()
      .setName('dlcredeem')
      .setDescription('Redeem a DLC code to receive a brainrot')
      .addStringOption(o =>
        o.setName('code')
          .setDescription('The DLC code to redeem')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('dm')
      .setDescription('Send a direct message to a Discord user (restricted)')
      .addUserOption(o =>
        o.setName('user')
          .setDescription('The user to DM')
          .setRequired(true))
      .addStringOption(o =>
        o.setName('message')
          .setDescription('The message to send')
          .setRequired(true)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const GUILD_ID = process.env.GUILD_ID || '1471025740513284098';

  // Wipe global commands and guild commands, then register fresh to the guild
  await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  console.log('[Discord] Cleared all global commands.');
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [] });
  console.log(`[Discord] Cleared guild commands for ${GUILD_ID}.`);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log(`[Discord] Slash commands registered to guild ${GUILD_ID}.`);
}

let isBuilding = false;

// Tracks users who have rolled /rng but haven't claimed yet
const pendingRolls = new Set();

// Tracks active /rng messages so /clearrng can delete them: Map<userId, { channelId, messageId }>
const rngMessages = new Map();

client.on('interactionCreate', async interaction => {

  // ── Server & channel guard ────────────────────────────────────────────────
  const ALLOWED_GUILD   = '1471025740513284098';
  const ALLOWED_CHANNEL = '1485150339463381176';
  const RESTRICTED_CHANNEL = '1514924301474594887'; // extra channel where restricted/admin commands also work

  const isDmCommand = interaction.isChatInputCommand() && interaction.commandName === 'dm';
  const inAllowedChannel = interaction.channelId === ALLOWED_CHANNEL || interaction.channelId === RESTRICTED_CHANNEL;
  if (!isDmCommand && (interaction.guildId !== ALLOWED_GUILD || !inAllowedChannel)) {
    const msg = { content: "This only works in Steal a Koolio's Discord!", ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
    return interaction.reply(msg);
  }

  // ── Button interactions ───────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    const action = parts[0];

    // ── rng_claim / rng_reroll ──────────────────────────────────────────────
    if (action === 'rng_claim' || action === 'rng_reroll') {
      const userId     = parts[1];
      const animalName = parts.slice(2).join(':'); // animal name is the rest

      // Only the original roller can interact
      if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ This roll isn\'t yours!', ephemeral: true });
      }

      const animals = loadRollable();
      if (!animals.length) {
        return interaction.reply({ content: '❌ No rollable animals configured.', ephemeral: true });
      }

      if (action === 'rng_reroll') {
        const REROLL_COST = 10_000_000_000_000_000; // 10QI

        const paired = getPairedUsername(userId);
        if (!paired) {
          return interaction.reply({
            content: 'You need a linked Roblox account to re-roll. Use `/pair <username>` first!',
            ephemeral: true,
          });
        }

        await interaction.deferUpdate();

        // Resolve Roblox user ID
        let robloxUserId;
        try {
          const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
            usernames: [paired], excludeBannedUsers: false,
          });
          const user = userRes.data?.data?.[0];
          if (!user) throw new Error(`Roblox player "${paired}" not found.`);
          robloxUserId = String(user.id);
        } catch (err) {
          return interaction.editReply({ content: `Could not find Roblox account: ${err.message}`, components: [] });
        }

        // Fetch entry and check balance
        const entry = await getEntry(robloxUserId);
        if (!entry) {
          return interaction.editReply({ content: 'Could not fetch your Roblox data.', components: [] });
        }

        const currentCoins = entry.Coins ?? 0;
        if (currentCoins < REROLL_COST) {
          return interaction.editReply({
            content: `You can't afford a re-roll! You need **10QI coins** but only have **${(currentCoins / 1e15).toFixed(2)}QI**.`,
            components: [],
          });
        }

        // Deduct and save
        entry.Coins = currentCoins - REROLL_COST;
        try {
          await axios.post(`${BASE}/entries/entry`, JSON.stringify(entry), {
            params:  { datastoreName: DATASTORE_NAME, entryKey: robloxUserId },
            headers: {
              'x-api-key':            ROBLOX_API_KEY,
              'Content-Type':         'application/json',
              'roblox-entry-userids': JSON.stringify([Number(robloxUserId)]),
            },
            timeout: 15000,
          });
        } catch (err) {
          return interaction.editReply({ content: `Failed to deduct coins: ${err.message}`, components: [] });
        }

        const newAnimal   = rollAnimal(animals);
        const newMutation = rollMutation();
        const newTraits   = rollTraits();
        const claimNote   = `Linked as **${paired}** — click Claim to add it to your base!`;
        const mutLabel    = newMutation ? ` ✨ **${newMutation}**` : '';
        const traitLabel  = newTraits.length ? ` 🌟 **${newTraits.join(', ')}**` : '';
        const customData  = [newAnimal, newMutation || '', newTraits.join(',')].join('|');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`rng_claim:${userId}:${customData}`)
            .setLabel('✅ Claim')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`rng_reroll:${userId}:${customData}`)
            .setLabel('Reroll for 10QI!')
            .setStyle(ButtonStyle.Secondary),
        );

        return interaction.editReply({
          content: `🎲 <@${userId}> rolled:${mutLabel}${traitLabel} **${newAnimal}**\n${claimNote}`,
          components: [row],
        });
      }

      // Claim
      const paired = getPairedUsername(userId);
      if (!paired) {
        return interaction.reply({
          content: '❌ You don\'t have a Roblox account linked. Use `/pair <username>` first!',
          ephemeral: true,
        });
      }

      // Parse animal name and optional mutation from customId (format: "name" or "name|Mutation")
      // Format: "animal|mutation|traits" (mutation may be empty, traits is comma-separated)
      const parts2        = animalName.split('|');
      const claimAnimal   = parts2[0];
      const claimMutation = parts2[1] || null;
      const claimTraits   = parts2[2] ? parts2[2].split(',') : [];

      // Verify the animal is still rollable
      if (!animals.includes(claimAnimal)) {
        return interaction.reply({ content: '❌ That brainrot is no longer available to claim.', ephemeral: true });
      }

      const mutPart   = claimMutation ? `${claimMutation} ` : '';
      const traitPart = claimTraits.length ? ` [${claimTraits.join(', ')}]` : '';
      const claimLabel = `**${mutPart}${claimAnimal}**${traitPart}`;
      await interaction.update({ content: `⏳ Claiming ${claimLabel} for **${paired}**...`, components: [] });

      try {
        const { userName, method } = await spawnAnimalSmrt(paired, claimAnimal, claimMutation, claimTraits);
        pendingRolls.delete(userId);
        rngMessages.delete(userId);
        const dest = method === 'ingame' ? 'spawned in-game for' : 'added to the base of';
        return interaction.editReply(`✅ ${claimLabel} has been ${dest} **${userName}**!`);
      } catch (err) {
        pendingRolls.delete(userId);
        rngMessages.delete(userId);
        return interaction.editReply(`❌ Claim failed: ${err.message}`);
      }
    }


    // ── rngblock_claim / rngblock_reroll ───────────────────────────────────
    if (action === 'rngblock_claim' || action === 'rngblock_reroll') {
      const userId    = parts[1];
      const blockName = parts.slice(2).join(':');

      if (interaction.user.id !== userId)
        return interaction.reply({ content: "❌ This roll isn't yours!", ephemeral: true });

      if (action === 'rngblock_reroll') {
        const newBlock = rollLuckyBlock();
        const paired   = getPairedUsername(userId);
        const claimNote = paired
          ? `Linked as **${paired}** — click Claim to add it to your base!`
          : `Link your Roblox account with \`/pair\` to claim rolls!`;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`rngblock_claim:${userId}:${newBlock.name}`)
            .setLabel('✅ Claim')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`rngblock_reroll:${userId}:${newBlock.name}`)
            .setLabel('🎲 Re-roll')
            .setStyle(ButtonStyle.Secondary),
        );

        return interaction.update({
          content: `🎲 <@${userId}> rolled: **${newBlock.name}** *(${newBlock.rarity})*
${claimNote}`,
          components: [row],
        });
      }

      // Claim
      const paired = getPairedUsername(userId);
      if (!paired)
        return interaction.reply({ content: "❌ You don't have a Roblox account linked. Use `/pair <username>` first!", ephemeral: true });

      const block = LUCKY_BLOCKS.find(b => b.name === blockName);
      if (!block)
        return interaction.reply({ content: '❌ That lucky block is no longer valid.', ephemeral: true });

      await interaction.update({ content: `⏳ Claiming **${block.name}** for **${paired}**...`, components: [] });

      try {
        const { userName } = await giveAnimalToPlayer(paired, block.name, null, []);
        return interaction.editReply(`✅ **${block.name}** *(${block.rarity})* has been added to **${userName}**'s base!`);
      } catch (err) {
        return interaction.editReply(`❌ Claim failed: ${err.message}`);
      }
    }

    return;
  }

  // ── Select menu interactions (editbrainrot / signanimal pick) ────────────
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('editbrainrot_pick:')) {
      const parts      = interaction.customId.split(':');
      const editorId   = parts[1];
      const robloxId   = parts[2];
      const username   = parts[3];
      const mutation   = parts[4] || null;
      const traitsRaw  = parts[5] || '';

      if (interaction.user.id !== editorId)
        return interaction.reply({ content: '❌ This menu is not for you.', flags: MessageFlags.Ephemeral });

      const podiumIdx = parseInt(interaction.values[0], 10);
      const traits = traitsRaw ? traitsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const entry = await getEntry(robloxId);
        if (!entry) return interaction.editReply('❌ Could not fetch player data.');

        const podiums = entry.AnimalPodiums;
        if (!Array.isArray(podiums) || !podiums[podiumIdx])
          return interaction.editReply('❌ That podium slot no longer exists.');

        const pod = podiums[podiumIdx];

        if (playersInGame.has(robloxId)) {
          // Player is online — queue an in-game edit so it applies live instead of
          // writing directly to the datastore (which their session would overwrite on leave).
          pendingInGameClaims.set(robloxId, { type: 'edit', animal: pod.Index, mutation: mutation || null, traits });
          const mutLabel   = mutation ? `✨ ${mutation} ` : '';
          const traitLabel = traits.length ? ` [${traits.join(', ')}]` : '';
          return interaction.editReply(`✅ Queued update for **${username}**'s **${pod.Index}** → ${mutLabel}**${pod.Index}**${traitLabel} — it will be applied in-game shortly!`);
        }

        if (mutation) pod.Mutation = mutation;
        else delete pod.Mutation;

        if (traits.length > 0) pod.Traits = traits;
        else delete pod.Traits;

        podiums[podiumIdx] = pod;
        entry.AnimalPodiums = podiums;

        await axios.post(`${BASE}/entries/entry`, JSON.stringify(entry), {
          params:  { datastoreName: DATASTORE_NAME, entryKey: robloxId },
          headers: {
            'x-api-key':            ROBLOX_API_KEY,
            'Content-Type':         'application/json',
            'roblox-entry-userids': JSON.stringify([Number(robloxId)]),
          },
          timeout: 15000,
        });

        const mutLabel   = mutation ? `✨ ${mutation} ` : '';
        const traitLabel = traits.length ? ` [${traits.join(', ')}]` : '';
        return interaction.editReply(`✅ Updated **${username}**'s **${pod.Index}** → ${mutLabel}**${pod.Index}**${traitLabel}`);
      } catch (err) {
        return interaction.editReply(`❌ Failed to save changes: ${err.message}`);
      }
    }

    if (interaction.customId.startsWith('signanimal_pick:')) {
      const parts    = interaction.customId.split(':');
      const editorId = parts[1];
      const robloxId = parts[2];
      const username = parts[3];

      if (interaction.user.id !== editorId)
        return interaction.reply({ content: '❌ This menu is not for you.', flags: MessageFlags.Ephemeral });

      const SIGN_TRAITS = {
        '1170834053004529747': 'Koolio Signed',
        '1485383517620801807': 'Taco Signed',
      };
      const signTrait = SIGN_TRAITS[editorId] || 'Koolio Signed';

      const podiumIdx = parseInt(interaction.values[0], 10);

      try {
        const entry = await getEntry(robloxId);
        if (!entry) {
          await interaction.update({ content: '❌ Could not fetch player data.', components: [] });
          return;
        }

        const podiums = entry.AnimalPodiums;
        if (!Array.isArray(podiums) || !podiums[podiumIdx]) {
          await interaction.update({ content: '❌ That podium slot no longer exists.', components: [] });
          return;
        }

        const pod = podiums[podiumIdx];
        const existingTraits = Array.isArray(pod.Traits) ? pod.Traits : [];

        if (existingTraits.includes(signTrait)) {
          await interaction.update({ content: `⚠️ **${pod.Index}** already has the **${signTrait}** trait!`, components: [] });
          return;
        }

        if (playersInGame.has(robloxId)) {
          // Player is online — queue an in-game claim so it applies live instead of
          // writing directly to the datastore (which their session would overwrite on leave).
          pendingInGameClaims.set(robloxId, { type: 'trait', animal: pod.Index, trait: signTrait });
          await interaction.update({
            content: `✅ Queued **${signTrait}** for **${username}**'s **${pod.Index}** — it will be applied in-game shortly!`,
            components: [],
          });
          return;
        }

        pod.Traits = [...existingTraits, signTrait];
        podiums[podiumIdx] = pod;
        entry.AnimalPodiums = podiums;

        await axios.post(`${BASE}/entries/entry`, JSON.stringify(entry), {
          params:  { datastoreName: DATASTORE_NAME, entryKey: robloxId },
          headers: {
            'x-api-key':            ROBLOX_API_KEY,
            'Content-Type':         'application/json',
            'roblox-entry-userids': JSON.stringify([Number(robloxId)]),
          },
          timeout: 15000,
        });

        const traitLabel = pod.Traits.join(', ');
        await interaction.update({
          content: `✅ Signed **${username}**'s **${pod.Index}** with **${signTrait}**! Traits: [${traitLabel}]`,
          components: [],
        });
      } catch (err) {
        await interaction.update({ content: `❌ Failed to save: ${err.message}`, components: [] });
      }
    }

    return;
  }

  // ── announce_modal submit ─────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'announce_modal') {
    if (interaction.user.id !== '1170834053004529747')
      return interaction.reply({ content: '❌ Not authorised.', ephemeral: true });

    const message = interaction.fields.getTextInputValue('announce_message');
    const ANNOUNCE_CHANNEL = '1485410734216187914';

    try {
      const channel = await client.channels.fetch(ANNOUNCE_CHANNEL);
      await channel.send(message);
      return interaction.reply({ content: '✅ Announcement sent!', ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `❌ Failed to send: ${err.message}`, ephemeral: true });
    }
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /dm ───────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'dm') {
    if (interaction.user.id !== '1170834053004529747')
      return interaction.reply({ content: '❌ Not authorised.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const targetUser = interaction.options.getUser('user');
    const message    = interaction.options.getString('message');
    try {
      await targetUser.send(message);
      return interaction.editReply(`✅ DM sent to **${targetUser.tag}**.`);
    } catch (err) {
      return interaction.editReply(`❌ Could not DM **${targetUser.tag}**: ${err.message}`);
    }
  }

  // /announce uses showModal — must NOT deferReply first
  if (interaction.commandName === 'announce') {
    if (interaction.user.id !== '1170834053004529747')
      return interaction.reply({ content: '❌ You are not authorised to use `/announce`.', ephemeral: true });

    const modal = new ModalBuilder()
      .setCustomId('announce_modal')
      .setTitle('Send Announcement');

    const messageInput = new TextInputBuilder()
      .setCustomId('announce_message')
      .setLabel('Announcement message')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Type your announcement here...')
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(new ActionRowBuilder().addComponents(messageInput));
    return interaction.showModal(modal);
  }

  // ── /dlccode needs ephemeral defer so only the user sees the code ───────────
  if (interaction.commandName === 'dlccode' || interaction.commandName === 'pair' || interaction.commandName === 'unpair') {
    await interaction.deferReply({ ephemeral: true });
  } else {
    await interaction.deferReply();
  }

  // ── /pair ─────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'pair') {
    const username = interaction.options.getString('username')?.trim();
    const password = interaction.options.getString('password')?.trim();

    if (!username || !password)
      return interaction.editReply('❌ Both a username and password are required.');

    const existing = pairs[interaction.user.id];

    // If already paired, require correct password to re-pair
    if (existing) {
      if (!checkPassword(interaction.user.id, password)) {
        return interaction.editReply(`❌ Incorrect password. Re-pairing denied.`);
      }
    }

    await interaction.editReply(`🔗 Verifying Roblox account **${username}**...`);

    try {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [username], excludeBannedUsers: false,
      });
      const user = userRes.data?.data?.[0];
      if (!user) return interaction.editReply(`❌ Roblox user **"${username}"** not found. Check the spelling and try again.`);

      const entry = await getEntry(String(user.id));
      if (!entry) return interaction.editReply(`❌ **${user.name}** hasn't played the game yet, so there's no data to link.`);

      const wasAlready = existing ? ` (previously linked to **${existing.robloxUsername}**)` : '';
      // Keep existing password if re-pairing, otherwise hash the new one
      const passwordHash = existing ? existing.passwordHash : hashPassword(password);

      pairs[interaction.user.id] = {
        robloxUsername:    user.name,
        robloxUserId:      String(user.id),
        robloxDisplayName: user.displayName,
        pairedAt:          new Date().toISOString(),
        passwordHash,
      };
      savePairs();

      return interaction.editReply(
        `✅ Your Discord account is now linked to Roblox account **${user.name}**${wasAlready}!\n` +
        `🔒 Your password is set — keep it safe! You'll need it to re-pair or unpair.`
      );
    } catch (err) {
      return interaction.editReply(`❌ Failed to verify: ${err.message}`);
    }
  }

  // ── /unpair ───────────────────────────────────────────────────────────────
  if (interaction.commandName === 'unpair') {
    const existing = pairs[interaction.user.id];
    if (!existing) return interaction.editReply('❌ You don\'t have a linked Roblox account.');
    const password = interaction.options.getString('password')?.trim() || null;
    if (!password || !checkPassword(interaction.user.id, password)) {
      return interaction.editReply('❌ Incorrect password. Unpair denied.');
    }
    delete pairs[interaction.user.id];
    savePairs();
    return interaction.editReply(`✅ Your Discord account has been unlinked from **${existing.robloxUsername}**.`);
  }

  // ── /pairstatus ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'pairstatus') {
    const p = pairs[interaction.user.id];
    if (!p) return interaction.editReply('❌ You haven\'t linked a Roblox account yet. Use `/pair <username>` to link one.');
    return interaction.editReply(
      `🔗 You are linked to Roblox account **${p.robloxUsername}**\n` +
      `📅 Paired on: ${new Date(p.pairedAt).toLocaleString()}`
    );
  }



  // ── /cachestatus ──────────────────────────────────────────────────────────
  if (interaction.commandName === 'cachestatus') {
    if (!cache) return interaction.editReply('❌ No cache yet. Run `/rebuildcache` first.');
    return interaction.editReply(
      `✅ Cache built at **${new Date(cache.builtAt).toLocaleString()}**\n📦 **${Object.keys(cache.data).length}** unique brainrot animals tracked.`
    );
  }

  // ── /rng ──────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'rng') {
    const animals = loadRollable();
    if (!animals.length) return interaction.editReply('❌ No rollable animals configured. Edit `rollable.json` first.');

    if (pendingRolls.has(interaction.user.id)) {
      return interaction.editReply({ content: '⚠️ You already have an unclaimed roll! Claim or re-roll your current one before rolling again.', ephemeral: true });
    }

    const animal   = rollAnimal(animals);
    const mutation = rollMutation();
    const traits   = rollTraits();
    const paired   = getPairedUsername(interaction.user.id);
    const claimNote = paired
      ? `Linked as **${paired}** — click Claim to add it to your base!`
      : `Link your Roblox account with \`/pair\` to claim rolls!`;

    const mutLabel   = mutation ? ` ✨ **${mutation}**` : '';
    const traitLabel = traits.length ? ` 🌟 **${traits.join(', ')}**` : '';
    const rollLabel  = animal;
    const customData = [animal, mutation || '', traits.join(',')].join('|');

    pendingRolls.add(interaction.user.id);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rng_claim:${interaction.user.id}:${customData}`)
        .setLabel('✅ Claim')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rng_reroll:${interaction.user.id}:${customData}`)
        .setLabel('Reroll for 10QI!')
        .setStyle(ButtonStyle.Secondary),
    );

    const rngReply = await interaction.editReply({
      content: `🎲 <@${interaction.user.id}> rolled:${mutLabel}${traitLabel} **${rollLabel}**\n${claimNote}`,
      components: [row],
    });
    rngMessages.set(interaction.user.id, { channelId: interaction.channelId, messageId: rngReply.id });
    return;
  }

  // ── /rngblock ────────────────────────────────────────────────────────────
  if (interaction.commandName === 'rngblock') {
    const block  = rollLuckyBlock();
    const paired = getPairedUsername(interaction.user.id);
    const claimNote = paired
      ? `Linked as **${paired}** — click Claim to add it to your base!`
      : `Link your Roblox account with \`/pair\` to claim rolls!`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rngblock_claim:${interaction.user.id}:${block.name}`)
        .setLabel('✅ Claim')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rngblock_reroll:${interaction.user.id}:${block.name}`)
        .setLabel('🎲 Re-roll')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.editReply({
      content: `🎲 <@${interaction.user.id}> rolled: **${block.name}** *(${block.rarity})*\n${claimNote}`,
      components: [row],
    });
  }

  // ── /roll ─────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'roll') {
    const animals = loadRollable();
    if (!animals.length) return interaction.editReply('❌ No rollable animals configured. Edit `rollable.json` first.');
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return interaction.editReply(
      `🎲 **${animal}**\n\nClaim it at: \`http://localhost:3000/roll\`\n*Enter your Roblox username and the animal name to claim.*`
    );
  }

  // ── /rebuildcache ─────────────────────────────────────────────────────────
  if (interaction.commandName === 'rebuildcache') {
    if (interaction.user.id !== '1170834053004529747') return interaction.editReply('❌ Not authorised.');
    if (isBuilding) return interaction.editReply('⚠️ Scan already in progress — wait for it to finish.');
    isBuilding = true;
    await interaction.editReply('🔄 Cache rebuild started. Follow progress below.');
    let statusMsg;
    try {
      statusMsg = await interaction.channel.send('⏳ Starting...');
      await buildCache(statusMsg);
      await statusMsg.edit(`✅ Cache rebuilt! **${Object.keys(cache.data).length}** unique animals found.`);
    } catch (err) {
      console.error('[rebuildcache]', err);
      const msg = `❌ Cache build failed: \`${err.message}\``;
      if (statusMsg) await statusMsg.edit(msg).catch(() => interaction.channel.send(msg).catch(() => {}));
      else await interaction.channel.send(msg).catch(() => {});
    } finally {
      isBuilding = false;
    }
    return;
  }

  // ── /brainrotcounts ───────────────────────────────────────────────────────
  if (interaction.commandName === 'brainrotcounts') {
    const name = interaction.options.getString('brainrot');
    if (!cache) return interaction.editReply('❌ No cache yet. Run `/rebuildcache` first.');
    const entry = cache.data[name];
    if (!entry) return interaction.editReply(`❌ No data for \`${name}\` — check spelling.`);
    await interaction.editReply(`\`\`\`\n${formatOutput(name, entry)}\n\`\`\`\n*Cache updated: ${new Date(cache.builtAt).toLocaleString()}*`);
    return;
  }

  // ── /give ─────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'give') {
    if (!GIVE_ALLOWED_IDS.has(interaction.user.id))
      return interaction.editReply('❌ You are not authorised to use `/give`.');

    const username  = interaction.options.getString('username').trim();
    const animal    = interaction.options.getString('animal').trim();
    const mutRaw    = interaction.options.getString('mutation');
    const traitsRaw = interaction.options.getString('traits');

    const mutation = mutRaw ? mutRaw.trim() : null;
    const traits   = traitsRaw ? traitsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const mutLabel   = mutation && mutation !== 'Normal' ? ` **${mutation}**` : '';
    const traitLabel = traits.length ? ` [${traits.join(', ')}]` : '';

    try {
      const { userName, method } = await spawnAnimalSmrt(username, animal, mutation, traits);
      const dest = method === 'ingame' ? 'spawned in-game for' : 'added to the base of';
      return interaction.editReply(`✅ ${method === 'ingame' ? '🎮' : '✅'} ${mutLabel ? mutLabel.trim() + ' ' : ''}**${animal}**${traitLabel} has been ${dest} **${userName}**!`);
    } catch (err) {
      console.error('[Give] Error:', err.response?.data || err.message);
      const msg = err.response?.data?.message ?? err.message;
      if (err.response?.status === 403)
        return interaction.editReply('❌ API key does not have DataStore Write permission. Check `create.roblox.com/credentials`.');
      return interaction.editReply(`❌ Failed: ${msg}`);
    }
  }

  // ── /troll ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'troll') {
    if (!GIVE_ALLOWED_IDS.has(interaction.user.id))
      return interaction.editReply('❌ You are not authorised to use `/troll`.');

    const username = interaction.options.getString('username').trim();
    const duration = interaction.options.getInteger('duration');
    const brainrot = interaction.options.getString('brainrot')?.trim() || 'Noobini Pizzanini';

    let robloxUserId, userName;
    try {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [username], excludeBannedUsers: false });
      const rUser = userRes.data?.data?.[0];
      if (!rUser) return interaction.editReply(`❌ Roblox user **${username}** not found.`);
      robloxUserId = String(rUser.id);
      userName = rUser.name;
    } catch (err) {
      return interaction.editReply(`❌ Failed to look up Roblox account: ${err.message}`);
    }

    if (!playersInGame.has(robloxUserId))
      return interaction.editReply(`❌ **${userName}** is not currently in the game. \`/troll\` only works while they're online.`);

    pendingInGameClaims.set(robloxUserId, { type: 'troll', duration, animal: brainrot });
    return interaction.editReply(`🤡 Queued **${brainrot}** troll on **${userName}**'s base for **${duration}s** — it'll apply in-game shortly and revert automatically!`);
  }

  // ── /traittime ────────────────────────────────────────────────────────────
  if (interaction.commandName === 'traittime') {
    if (interaction.user.id !== '1170834053004529747')
      return interaction.editReply('❌ You are not authorised to use `/traittime`.');

    const amount = interaction.options.getInteger('amount');
    traitTimeExpiresAt = Math.max(traitTimeExpiresAt, Date.now()) + amount * 1000;
    const secsLeft = Math.round((traitTimeExpiresAt - Date.now()) / 1000);
    return interaction.editReply(
      `🎯 **TraitTime activated!** rng rolls have a 35% trait chance for the next **${amount}s**!\n` +
      `⏱️ TraitTime expires in **${secsLeft} seconds**.`
    );
  }

  // ── /clearrng ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'clearrng') {
    if (!GIVE_ALLOWED_IDS.has(interaction.user.id))
      return interaction.editReply('❌ You are not authorised to use `/clearrng`.');

    const total = rngMessages.size;
    let deleted = 0;
    let failed  = 0;

    for (const [userId, { channelId, messageId }] of rngMessages.entries()) {
      try {
        const channel = await client.channels.fetch(channelId);
        const message = await channel.messages.fetch(messageId);
        await message.delete();
        deleted++;
      } catch {
        failed++;
      }
      pendingRolls.delete(userId);
      rngMessages.delete(userId);
    }

    const summary = total === 0
      ? '✅ No pending /rng rolls to clear.'
      : `✅ Cleared **${deleted}** /rng message(s)${failed ? `, ${failed} couldn't be deleted (already gone).` : '.'} Everyone can roll again.`;

    return interaction.editReply(summary);
  }

  // ── /viewbase ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'viewbase') {
    const username = interaction.options.getString('username')?.trim();
    if (!username) return interaction.editReply('❌ Please provide a Roblox username.');

    await interaction.editReply(`🔍 Looking up **${username}**'s base...`);

    try {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [username], excludeBannedUsers: false,
      });
      const user = userRes.data?.data?.[0];
      if (!user) return interaction.editReply(`❌ Roblox user **"${username}"** not found. Check the spelling and try again.`);

      const entry = await getEntry(String(user.id));
      if (!entry) return interaction.editReply(`❌ **${user.name}** hasn't played the game yet.`);

      const podiums = entry.AnimalPodiums;
      if (!Array.isArray(podiums)) return interaction.editReply(`❌ No base data found for **${user.name}**.`);

      const animals = [];
      for (const pod of podiums) {
        if (!pod || typeof pod !== 'object' || !pod.Index) continue;
        const mut    = pod.Mutation && pod.Mutation !== 'Normal' ? `✨ ${pod.Mutation} ` : '';
        const traits = Array.isArray(pod.Traits) && pod.Traits.length ? ` [${pod.Traits.join(', ')}]` : '';
        animals.push(`${mut}**${pod.Index}**${traits}`);
      }

      if (!animals.length) return interaction.editReply(`📭 **${user.name}**'s base is empty.`);

      // Split into chunks so we never exceed Discord's 2000-char limit
      const header = `🏠 **${user.name}**'s base — ${animals.length} brainrot(s):\n\n`;
      const chunks = [];
      let current  = header;

      for (const line of animals) {
        const entry = `• ${line}\n`;
        if (current.length + entry.length > 1900) {
          chunks.push(current);
          current = entry;
        } else {
          current += entry;
        }
      }
      if (current) chunks.push(current);

      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
      }
    } catch (err) {
      return interaction.editReply(`❌ Failed to look up base: ${err.message}`);
    }
  }

  // ── /editbrainrot ─────────────────────────────────────────────────────────
  if (interaction.commandName === 'editbrainrot') {
    if (interaction.user.id !== '1170834053004529747')
      return interaction.editReply('❌ You are not authorised to use `/editbrainrot`.');

    const username  = interaction.options.getString('username')?.trim();
    const mutation  = interaction.options.getString('mutation')?.trim() || '';
    const traitsRaw = interaction.options.getString('traits')?.trim() || '';

    if (!username) return interaction.editReply('❌ Please provide a Roblox username.');

    await interaction.editReply(`🔍 Looking up **${username}**'s base...`);

    try {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [username], excludeBannedUsers: false,
      });
      const user = userRes.data?.data?.[0];
      if (!user) return interaction.editReply(`❌ Roblox user **"${username}"** not found.`);

      const entry = await getEntry(String(user.id));
      if (!entry) return interaction.editReply(`❌ **${user.name}** hasn't played the game yet.`);

      const podiums = entry.AnimalPodiums;
      if (!Array.isArray(podiums)) return interaction.editReply(`❌ No base data found for **${user.name}**.`);

      const options = [];
      for (let i = 0; i < podiums.length; i++) {
        const pod = podiums[i];
        if (!pod || typeof pod !== 'object' || !pod.Index) continue;
        const mut    = pod.Mutation && pod.Mutation !== 'Normal' ? `${pod.Mutation} ` : '';
        const traits = Array.isArray(pod.Traits) && pod.Traits.length ? ` [${pod.Traits.join(', ')}]` : '';
        const label  = `${mut}${pod.Index}${traits}`.slice(0, 100);
        options.push({ label, value: String(i) });
        if (options.length >= 25) break;
      }

      if (!options.length) return interaction.editReply(`📭 **${user.name}**'s base is empty.`);

      // Encode mutation and traits into the customId so no server-side state is needed
      // Format: editbrainrot_pick:<editorId>:<robloxId>:<username>:<mutation>:<traits>
      const customId = `editbrainrot_pick:${interaction.user.id}:${user.id}:${user.name}:${mutation}:${traitsRaw}`;

      const mutDisplay   = mutation  ? ` | Mutation: **${mutation}**`  : ' | No mutation (will clear)';
      const traitDisplay = traitsRaw ? ` | Traits: **${traitsRaw}**`   : ' | No traits (will clear)';

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder('Choose a brainrot to edit')
          .addOptions(options)
      );

      return interaction.editReply({
        content: `✏️ **${user.name}**'s base — pick a brainrot to edit:\n${mutDisplay}${traitDisplay}`,
        components: [row],
      });
    } catch (err) {
      return interaction.editReply(`❌ Failed: ${err.message}`);
    }
  }

  // ── /luck ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'luck') {
    if (interaction.user.id !== '1170834053004529747')
      return interaction.editReply('❌ You are not authorised to use `/luck`.');

    const amount = interaction.options.getInteger('amount');

    // Clear any existing LuckTime timer
    if (luckTimeTimer) {
      clearTimeout(luckTimeTimer);
      luckTimeTimer = null;
    }

    // Add luck animals to rollable (avoid duplicates)
    const animals = loadRollable();
    let added = 0;
    for (const a of LUCK_ANIMALS) {
      if (!animals.includes(a)) { animals.push(a); added++; }
    }
    saveRollable(animals);

    // Schedule removal after duration
    luckTimeTimer = setTimeout(() => {
      try {
        const current = loadRollable();
        const trimmed = current.filter(a => !LUCK_ANIMALS.includes(a));
        saveRollable(trimmed);
        console.log('[LuckTime] Expired — luck animals removed from rollable.');
      } catch (err) {
        console.error('[LuckTime] Failed to remove luck animals:', err.message);
      }
      luckTimeTimer = null;
    }, amount * 1000);

    return interaction.editReply(
      `🍀 **LuckTime activated!** The following have been added to the rollable pool for **${amount}s**:
` +
      LUCK_ANIMALS.map(a => `• **${a}**`).join('\n') + '\n' +
      `⏱️ They will be removed automatically after **${amount} seconds**.`
    );
  }

  // ── /signanimal ───────────────────────────────────────────────────────────
  if (interaction.commandName === 'signanimal') {
    const SIGN_TRAITS = {
      '1170834053004529747': 'Koolio Signed',
      '1485383517620801807': 'Taco Signed',
      '1419409676495229170': 'Zeta Signed',
    };
    const signTrait = SIGN_TRAITS[interaction.user.id];
    if (!signTrait)
      return interaction.editReply('❌ You are not authorised to use `/signanimal`.');

    const username = interaction.options.getString('username')?.trim();
    if (!username) return interaction.editReply('❌ Please provide a Roblox username.');

    await interaction.editReply(`🔍 Looking up **${username}**'s base...`);

    try {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [username], excludeBannedUsers: false,
      });
      const user = userRes.data?.data?.[0];
      if (!user) return interaction.editReply(`❌ Roblox user **"${username}"** not found.`);

      const entry = await getEntry(String(user.id));
      if (!entry) return interaction.editReply(`❌ **${user.name}** hasn't played the game yet.`);

      const podiums = entry.AnimalPodiums;
      if (!Array.isArray(podiums)) return interaction.editReply(`❌ No base data found for **${user.name}**.`);

      const options = [];
      for (let i = 0; i < podiums.length; i++) {
        const pod = podiums[i];
        if (!pod || typeof pod !== 'object' || !pod.Index) continue;
        const mut    = pod.Mutation && pod.Mutation !== 'Normal' ? `${pod.Mutation} ` : '';
        const traits = Array.isArray(pod.Traits) && pod.Traits.length ? ` [${pod.Traits.join(', ')}]` : '';
        const label  = `${mut}${pod.Index}${traits}`.slice(0, 100);
        options.push({ label, value: String(i) });
        if (options.length >= 25) break;
      }

      if (!options.length) return interaction.editReply(`📭 **${user.name}**'s base is empty.`);

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`signanimal_pick:${interaction.user.id}:${user.id}:${user.name}`)
          .setPlaceholder('Choose a brainrot to sign')
          .addOptions(options)
      );

      return interaction.editReply({
        content: `✍️ **${user.name}**'s base — pick a brainrot to add **${signTrait}** to:`,
        components: [row],
      });
    } catch (err) {
      return interaction.editReply(`❌ Failed: ${err.message}`);
    }
  }

  // ── /dlccode ──────────────────────────────────────────────────────────────
  if (interaction.commandName === 'dlccode') {
    const paired = getPairedUsername(interaction.user.id);
    if (!paired) {
      return interaction.editReply(
        `❌ You don't have a Roblox account linked yet!\nUse \`/pair <username>\` to link your account first.`
      );
    }

    await interaction.editReply(`🔍 Verifying your account and gamepass ownership...`);

    try {
      // Resolve roblox user ID
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [paired], excludeBannedUsers: false,
      });
      const user = userRes.data?.data?.[0];
      if (!user) return interaction.editReply(`❌ Could not find your Roblox account **${paired}**.`);
      const robloxUserId = String(user.id);

      // Check if this roblox account already generated a code
      const tracking = loadDLCTracking();
      if (tracking.generatedBy[robloxUserId]) {
        return interaction.editReply(
          `❌ The Roblox account **${paired}** has already generated a DLC code.\nEach Roblox account can only generate **one code**.`
        );
      }

      // Check gamepass ownership
      const ownsPass = await checkRobloxGamepass(robloxUserId, DLC_GAMEPASS_ID);
      if (ownsPass === false) {
        return interaction.editReply(
          `❌ **${paired}** doesn't own the **DLC Code** gamepass.\n` +
          `You can purchase it here: https://www.roblox.com/game-pass/${DLC_GAMEPASS_ID}/DLC-Code`
        );
      }
      if (ownsPass === null) {
        return interaction.editReply(
          `⚠️ Your Roblox inventory is set to **private**, so I can't verify gamepass ownership.\n` +
          `Please set your inventory to public, then try again.\n` +
          `Alternatively, purchase the gamepass here: https://www.roblox.com/game-pass/${DLC_GAMEPASS_ID}/DLC-Code`
        );
      }

      // Generate a unique code
      let code;
      let attempts = 0;
      do {
        code = generateDLCCode();
        attempts++;
        if (attempts > 100) throw new Error('Failed to generate a unique code. Please try again.');
      } while (tracking.codes[code]);

      // Roll the tier, brainrot, and mutation
      const tier     = rollDLCTier();
      const brainrot = rollDLCBrainrot(tier);
      const mutation = rollDLCMutation();

      // Save to tracking
      tracking.generatedBy[robloxUserId] = code;
      tracking.codes[code] = {
        tier,
        brainrot,
        mutation,
        generatedByRobloxId:   robloxUserId,
        generatedByRobloxName: user.name,
        generatedAt:           new Date().toISOString(),
        claimedBy:             null,
        status:                'unclaimed',
      };
      saveDLCTracking(tracking);

      const mutLabel = mutation ? `\n✨ Mutation: **${mutation}**` : `\n✨ Mutation: **None**`;
      return interaction.editReply(
        `🎁 **DLC Code generated for ${user.name}!**\n\n` +
        `🔑 Your code: \`${code}\`\n` +
        `🎖️ Tier: **${tier}**` + mutLabel + `\n\n` +
        `You can share this code with anyone — but it can only be redeemed **once**!\n` +
        `The recipient should use \`/dlcredeem <code>\` to claim the brainrot.`
      );
    } catch (err) {
      return interaction.editReply(`❌ Failed: ${err.message}`);
    }
  }

  // ── /dlcredeem ────────────────────────────────────────────────────────────
  if (interaction.commandName === 'dlcredeem') {
    const codeInput = interaction.options.getString('code')?.trim().toUpperCase();
    if (!codeInput) return interaction.editReply('❌ Please provide a code to redeem.');

    const paired = getPairedUsername(interaction.user.id);
    if (!paired) {
      return interaction.editReply(
        `❌ You need a linked Roblox account to redeem a code!\nUse \`/pair <username>\` first.`
      );
    }

    await interaction.editReply(`🔍 Looking up code and your account...`);

    try {
      // Resolve roblox user ID
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [paired], excludeBannedUsers: false,
      });
      const user = userRes.data?.data?.[0];
      if (!user) return interaction.editReply(`❌ Could not find your Roblox account **${paired}**.`);
      const robloxUserId = String(user.id);

      const tracking = loadDLCTracking();

      // Validate code exists
      const codeData = tracking.codes[codeInput];
      if (!codeData) return interaction.editReply(`❌ Code \`${codeInput}\` is invalid or doesn't exist.`);

      // Check if already claimed
      if (codeData.status === 'claimed') {
        return interaction.editReply(`❌ Code \`${codeInput}\` has already been redeemed and is no longer valid.`);
      }

      // Check if player is currently in-game — must leave before redeeming
      if (playersInGame.has(robloxUserId)) {
        return interaction.editReply(
          `❌ You can't redeem a DLC code while you're in the game!\n\n` +
          `Please **leave the game first**, then come back and redeem your code.`
        );
      }

      // Give the brainrot to the player
      await interaction.editReply(`⏳ Redeeming code and adding **${codeData.brainrot}** to your base...`);

      try {
        const { userName } = await giveAnimalToPlayer(paired, codeData.brainrot, codeData.mutation || null, []);

        // Mark code as claimed
        codeData.status    = 'claimed';
        codeData.claimedBy = robloxUserId;
        codeData.claimedAt = new Date().toISOString();
        saveDLCTracking(tracking);

        const redeemMutLabel = codeData.mutation ? `✨ **${codeData.mutation}** ` : '';
        return interaction.editReply(
          `✅ **Code redeemed successfully!**\n\n` +
          `🎖️ Tier: **${codeData.tier}**\n` +
          `✨ Mutation: **${codeData.mutation || 'None'}**\n` +
          `🐾 Added ${redeemMutLabel}**${codeData.brainrot}** to **${userName}**'s base!\n\n` +
          `*This code has now been used and cannot be redeemed again.*`
        );
      } catch (err) {
        return interaction.editReply(`❌ Code is valid but failed to add brainrot: ${err.message}`);
      }
    } catch (err) {
      return interaction.editReply(`❌ Failed: ${err.message}`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  DASHBOARD API ROUTES  (http://localhost:4500/dashboard.html)
// ════════════════════════════════════════════════════════════════════════════

// Serve dashboard at root

// ════════════════════════════════════════════════════════════════════════════
//  DASHBOARD API ROUTES  (http://localhost:3000/dashboard.html)
// ════════════════════════════════════════════════════════════════════════════

// Serve dashboard at root
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Players in-game (for dashboard homepage)
app.get('/api/players-in-game', (req, res) => {
  const players = [...playersInGame];
  res.json({ count: players.length, players });
});

// Give brainrot
app.post('/api/admin/give', async (req, res) => {
  const { username, animal, mutation = null, traits = [] } = req.body;
  if (!username || !animal)
    return res.status(400).json({ error: 'username and animal are required' });
  try {
    const { userName, method } = await spawnAnimalSmrt(username, animal, mutation, traits);
    const dest = method === 'ingame' ? 'spawned in-game for' : 'added to the base of';
    const mutLabel   = mutation ? `${mutation} ` : '';
    const traitLabel = traits.length ? ` [${traits.join(', ')}]` : '';
    res.json({ message: `${mutLabel}${animal}${traitLabel} has been ${dest} ${userName}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// View base
app.get('/api/admin/viewbase', async (req, res) => {
  const username = req.query.username?.trim();
  if (!username) return res.status(400).json({ error: 'username is required' });
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const entry = await getEntry(String(user.id));
    if (!entry) return res.status(404).json({ error: `${user.name} hasn't played the game yet.` });
    const podiums = entry.AnimalPodiums;
    if (!Array.isArray(podiums))
      return res.status(404).json({ error: `No base data found for ${user.name}.` });
    const animals = [];
    for (const pod of podiums) {
      if (!pod || typeof pod !== 'object' || !pod.Index) continue;
      animals.push({
        name:     pod.Index,
        mutation: pod.Mutation && pod.Mutation !== 'Normal' ? pod.Mutation : null,
        traits:   Array.isArray(pod.Traits) ? pod.Traits : [],
      });
    }
    res.json({ username: user.name, count: animals.length, animals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit brainrot
app.post('/api/admin/editbrainrot', async (req, res) => {
  const { username, animal, mutation = null, traits = [] } = req.body;
  if (!username || !animal)
    return res.status(400).json({ error: 'username and animal are required' });
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const robloxUserId = String(user.id);
    if (playersInGame.has(robloxUserId)) {
      pendingInGameClaims.set(robloxUserId, { type: 'edit', animal, mutation: mutation || null, traits: Array.isArray(traits) ? traits : [] });
      return res.json({ message: `Edit queued for ${user.name} (in-game) — will apply within a few seconds.` });
    }
    const entry = await getEntry(robloxUserId);
    if (!entry) return res.status(404).json({ error: `${user.name} hasn't played the game yet.` });
    const podiums = entry.AnimalPodiums;
    if (!Array.isArray(podiums)) return res.status(404).json({ error: `No base data for ${user.name}.` });
    let found = false;
    for (let i = 0; i < podiums.length; i++) {
      const pod = podiums[i];
      if (pod && typeof pod === 'object' && pod.Index === animal) {
        if (mutation) pod.Mutation = mutation; else delete pod.Mutation;
        if (traits.length) pod.Traits = traits; else delete pod.Traits;
        podiums[i] = pod; found = true; break;
      }
    }
    if (!found) return res.status(404).json({ error: `${animal} not found in ${user.name}'s base.` });
    entry.AnimalPodiums = podiums;
    await axios.post(`${BASE}/entries/entry`, JSON.stringify(entry), {
      params:  { datastoreName: DATASTORE_NAME, entryKey: robloxUserId },
      headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json', 'roblox-entry-userids': JSON.stringify([Number(robloxUserId)]) },
      timeout: 15000,
    });
    res.json({ message: `${animal} edited for ${user.name}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sign animal
app.post('/api/admin/signanimal', async (req, res) => {
  const { username, animal } = req.body;
  if (!username || !animal) return res.status(400).json({ error: 'username and animal are required' });
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const robloxUserId = String(user.id);
    if (playersInGame.has(robloxUserId)) {
      pendingInGameClaims.set(robloxUserId, { type: 'trait', animal, trait: 'Koolio Signed' });
      return res.json({ message: `"Koolio Signed" queued for ${animal} on ${user.name} (in-game).` });
    }
    const entry = await getEntry(robloxUserId);
    if (!entry) return res.status(404).json({ error: `${user.name} hasn't played the game yet.` });
    const podiums = entry.AnimalPodiums;
    let found = false;
    for (let i = 0; i < podiums.length; i++) {
      const pod = podiums[i];
      if (pod && typeof pod === 'object' && pod.Index === animal) {
        const traits = Array.isArray(pod.Traits) ? pod.Traits : [];
        if (!traits.includes('Koolio Signed')) traits.push('Koolio Signed');
        pod.Traits = traits; podiums[i] = pod; found = true; break;
      }
    }
    if (!found) return res.status(404).json({ error: `${animal} not found in ${user.name}'s base.` });
    entry.AnimalPodiums = podiums;
    await axios.post(`${BASE}/entries/entry`, JSON.stringify(entry), {
      params:  { datastoreName: DATASTORE_NAME, entryKey: robloxUserId },
      headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json', 'roblox-entry-userids': JSON.stringify([Number(robloxUserId)]) },
      timeout: 15000,
    });
    res.json({ message: `"Koolio Signed" added to ${animal} for ${user.name}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Troll
app.post('/api/admin/troll', async (req, res) => {
  const { username, duration = 30, animal = 'Noobini Pizzanini' } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const robloxUserId = String(user.id);
    if (!playersInGame.has(robloxUserId))
      return res.status(400).json({ error: `${user.name} is not currently in the game.` });
    pendingInGameClaims.set(robloxUserId, { type: 'troll', duration, animal });
    res.json({ message: `Troll queued on ${user.name}'s base for ${duration}s — will apply in-game shortly!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TraitTime
app.post('/api/admin/traittime', (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'amount must be a positive integer' });
  traitTimeExpiresAt = Math.max(traitTimeExpiresAt, Date.now()) + amount * 1000;
  const secsLeft = Math.round((traitTimeExpiresAt - Date.now()) / 1000);
  res.json({ message: `TraitTime activated for ${amount}s! Expires in ${secsLeft}s total.` });
});

// LuckTime
app.post('/api/admin/lucktime', (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'amount must be a positive integer' });
  if (luckTimeTimer) { clearTimeout(luckTimeTimer); luckTimeTimer = null; }
  const animals = loadRollable();
  let added = 0;
  for (const a of LUCK_ANIMALS) { if (!animals.includes(a)) { animals.push(a); added++; } }
  saveRollable(animals);
  luckTimeTimer = setTimeout(() => {
    try { saveRollable(loadRollable().filter(a => !LUCK_ANIMALS.includes(a))); console.log('[LuckTime] Expired.'); }
    catch (err) { console.error('[LuckTime] Failed to remove luck animals:', err.message); }
    luckTimeTimer = null;
  }, amount * 1000);
  res.json({ message: `LuckTime activated for ${amount}s! Added ${added} secret animal(s) to rollable.` });
});

// Announce
app.post('/api/admin/announce', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  try {
    const channel = await client.channels.fetch('1485410734216187914');
    await channel.send(message);
    res.json({ message: 'Announcement sent!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rebuild Cache
app.post('/api/admin/rebuildcache', async (req, res) => {
  if (isBuilding) return res.status(409).json({ error: 'Cache build already in progress.' });
  res.json({ message: 'Cache rebuild started! Check server logs for progress.' });
  isBuilding = true;
  const fakeStatusMsg = { edit: (t) => { console.log('[Cache/Dashboard]', t); return Promise.resolve(); } };
  try {
    await buildCache(fakeStatusMsg);
    console.log(`[Cache/Dashboard] Done — ${Object.keys(cache.data).length} animals.`);
  } catch (err) {
    console.error('[Cache/Dashboard] Build failed:', err.message);
  } finally {
    isBuilding = false;
  }
});

// Rollable add/remove
app.post('/api/admin/rollable/add', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const animals = loadRollable();
  if (animals.includes(name)) return res.status(409).json({ error: `"${name}" is already in the rollable list.` });
  animals.push(name);
  saveRollable(animals);
  res.json({ message: `"${name}" added to rollable list.` });
});

app.post('/api/admin/rollable/remove', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  saveRollable(loadRollable().filter(a => a !== name));
  res.json({ message: `"${name}" removed from rollable list.` });
});

// DLC Code generate (admin version — no gamepass check)
app.post('/api/admin/dlccode', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const robloxUserId = String(user.id);
    const tracking = loadDLCTracking();
    const existingCode = tracking.generatedBy[robloxUserId];
    if (existingCode && tracking.codes[existingCode]?.status === 'unclaimed')
      return res.status(409).json({ error: `${user.name} already has an unclaimed code: ${existingCode}` });
    const tier = rollDLCTier();
    const brainrot = rollDLCBrainrot(tier);
    const mutation = rollDLCMutation();
    const code = generateDLCCode();
    tracking.generatedBy[robloxUserId] = code;
    tracking.codes[code] = { tier, brainrot, mutation, generatedByRobloxId: robloxUserId, generatedByRobloxName: user.name, generatedAt: new Date().toISOString(), claimedBy: null, claimedAt: null, status: 'unclaimed' };
    saveDLCTracking(tracking);
    res.json({ message: `Code generated for ${user.name}!`, code, tier, brainrot, mutation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DLC Redeem
app.post('/api/admin/dlcredeem', async (req, res) => {
  const { username, code } = req.body;
  if (!username || !code) return res.status(400).json({ error: 'username and code are required' });
  try {
    const upperCode = code.trim().toUpperCase();
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const robloxUserId = String(user.id);
    const tracking = loadDLCTracking();
    const codeData  = tracking.codes[upperCode];
    if (!codeData) return res.status(404).json({ error: `Code "${upperCode}" not found.` });
    if (codeData.status === 'claimed') return res.status(409).json({ error: `Code "${upperCode}" has already been redeemed.` });
    const { userName } = await spawnAnimalSmrt(username, codeData.brainrot, codeData.mutation, []);
    codeData.status = 'claimed'; codeData.claimedBy = robloxUserId; codeData.claimedAt = new Date().toISOString();
    saveDLCTracking(tracking);
    res.json({ message: `Code redeemed! ${codeData.mutation ? codeData.mutation + ' ' : ''}${codeData.brainrot} added to ${userName}'s base.`, tier: codeData.tier, brainrot: codeData.brainrot, mutation: codeData.mutation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fake Spawn — queue a fake animal to spawn on whichever server a player is currently in
app.post('/api/admin/fakespawn', async (req, res) => {
  const { username, animal, fakeType } = req.body;
  if (!username || !animal) return res.status(400).json({ error: 'username and animal are required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });

  // fakeType: 'fake1' = IsFake (poofs on click), 'fake2' = iffake (poofs on arrival), 'fake3' = FakeInBase (poofs in base)
  const resolvedType = fakeType === 'fake2' ? 'fake2' : fakeType === 'fake3' ? 'fake3' : 'fake1';

  pendingFakeSpawns.set(jobId, { animal, fakeType: resolvedType, queuedAt: Date.now() });

  const typeLabel = resolvedType === 'fake2' ? 'Fake 2 (iffake — poofs on arrival)' : resolvedType === 'fake3' ? 'Fake 3 (FakeInBase — poofs in base)' : 'Fake 1 (IsFake — poofs on click)';
  console.log(`[FakeSpawn] Queued "${animal}" for "${username}"'s server (job ${jobId}) as ${typeLabel}`);
  res.json({ message: `Fake "${animal}" queued for ${username}'s server as ${typeLabel}.` });
});
// Remote Announce — queue a notification for everyone in whichever server a player is currently in
app.post('/api/admin/remote-announce', async (req, res) => {
  const { username, text } = req.body;
  if (!username || !text) return res.status(400).json({ error: 'username and text are required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });

  pendingAnnouncements.set(jobId, { text, queuedAt: Date.now() });

  console.log(`[Announce] Queued "${text}" for "${username}"'s server (job ${jobId})`);
  res.json({ message: `Announcement queued for ${username}'s server. Everyone in that server will see it.` });
});

// Poof Base — queue a poof-base for a specific player (by username)
app.post('/api/admin/poofbase', async (req, res) => {
  const { username, duration } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  const dur = Math.max(1, Math.floor(Number(duration) || 30));
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false,
    });
    const user = userRes.data?.data?.[0];
    if (!user) return res.status(404).json({ error: `Player "${username}" not found on Roblox.` });
    const robloxUserId = String(user.id);
    if (!playersInGame.has(robloxUserId))
      return res.status(400).json({ error: `${user.name} is not currently in-game.` });
    pendingInGameClaims.set(robloxUserId, { type: 'poofbase', duration: dur });
    res.json({ message: `Poof base queued for ${user.name} — ${dur}s duration.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remote Spawn — queue a real animal spawn on whichever server a player is currently in
app.post('/api/admin/remote-spawn', async (req, res) => {
  const { username, animal, mutation, traits } = req.body;
  if (!username || !animal) return res.status(400).json({ error: 'username and animal are required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });

  const resolvedMutation = (mutation && mutation.trim()) ? mutation.trim() : null;
  const resolvedTraits   = Array.isArray(traits) ? traits.filter(Boolean) : [];

  pendingRemoteSpawns.set(jobId, { animal, mutation: resolvedMutation, traits: resolvedTraits, queuedAt: Date.now() });

  const mutLabel   = resolvedMutation ? ` [${resolvedMutation}]` : '';
  const traitLabel = resolvedTraits.length ? ` (${resolvedTraits.join(', ')})` : '';
  console.log(`[RemoteSpawn] Queued "${animal}"${mutLabel}${traitLabel} for "${username}"'s server (job ${jobId})`);
  res.json({ message: `"${animal}"${mutLabel}${traitLabel} queued for next spawn on ${username}'s server.` });
});

// Remote Event — trigger a named event on whichever server a player is currently in
app.post('/api/admin/remote-event', async (req, res) => {
  const { username, eventName } = req.body;
  if (!username || !eventName) return res.status(400).json({ error: 'username and eventName are required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });

  pendingRemoteEvents.set(jobId, { eventName, queuedAt: Date.now() });

  console.log(`[RemoteEvent] Queued event "${eventName}" for "${username}"'s server (job ${jobId})`);
  res.json({ message: `Event "${eventName}" queued for ${username}'s server. It will fire on the next poll cycle.` });
});

// Freeze Brainrot — queue a freeze/unfreeze for whichever server a player is currently in
app.post('/api/admin/freeze-brainrot', (req, res) => {
  const { username, animal, freeze } = req.body;
  if (!username || !animal) return res.status(400).json({ error: 'username and animal are required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });
  const shouldFreeze = freeze === true || freeze === 'true';
  pendingFreezebrainrots.set(jobId, { animal, freeze: shouldFreeze, queuedAt: Date.now() });
  const action = shouldFreeze ? '🥶 Freeze' : '▶️ Unfreeze';
  console.log(`[FreezeBreainrot] Queued ${action} "${animal}" for "${username}"'s server (job ${jobId})`);
  res.json({ message: `${action} queued for "${animal}" on ${username}'s server.` });
});

// Give Item — queue an item give for a player, wherever they currently are
app.post('/api/admin/give-item', (req, res) => {
  const { username, item } = req.body;
  if (!username || !item) return res.status(400).json({ error: 'username and item are required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });
  pendingGiveItems.set(jobId, { username, item, queuedAt: Date.now() });
  console.log(`[GiveItem] Queued item "${item}" for "${username}" on job ${jobId}`);
  res.json({ message: `Item "${item}" queued for ${username}.` });
});

// Force Speed — queue a speed override for a player, wherever they currently are
app.post('/api/admin/force-speed', (req, res) => {
  const { username, speed } = req.body;
  if (!username || speed === undefined || speed === null) return res.status(400).json({ error: 'username and speed are required' });
  const resolvedSpeed = parseFloat(speed);
  if (isNaN(resolvedSpeed)) return res.status(400).json({ error: 'speed must be a number' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });
  pendingForceSpeeds.set(jobId, { username, speed: resolvedSpeed, queuedAt: Date.now() });
  const label = resolvedSpeed === 0 ? 'disabled' : `set to ${resolvedSpeed}`;
  console.log(`[ForceSpeed] Queued speed ${label} for "${username}" on job ${jobId}`);
  res.json({ message: `Speed ${label} queued for ${username}.` });
});

// Poof Road — queue a poof of all road animals in whichever server a player is currently in
// Skips craft-spawn animals. Fires Poof VFX + sound to all clients, then destroys.
app.post('/api/admin/poof-road', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });
  pendingPoofRoads.set(jobId, { queuedAt: Date.now() });
  console.log(`[PoofRoad] Queued poof-road for "${username}"'s server (job ${jobId})`);
  res.json({ message: `Poof road queued for ${username}'s server. All non-craft road animals will poof on next poll.` });
});

// Morph Brainrot — morph a player into a brainrot model in a specific server (by job ID)
app.post('/api/admin/morph-brainrot', (req, res) => {
  const { jobId, username, brainrot, mutation } = req.body;
  if (!jobId || !username || !brainrot) return res.status(400).json({ error: 'jobId, username, and brainrot are required' });
  const resolvedMutation = (mutation && mutation.trim()) ? mutation.trim() : null;
  pendingMorphBrainrots.set(jobId, { username, brainrot, mutation: resolvedMutation, queuedAt: Date.now() });
  const mutLabel = resolvedMutation ? ` [${resolvedMutation}]` : '';
  console.log(`[MorphBrainrot] Queued morph of "${username}" into "${brainrot}"${mutLabel} on job ${jobId}`);
  res.json({ message: `Morph queued: "${username}" → "${brainrot}"${mutLabel} on job ${jobId.slice(0, 8)}….` });
});

// Play Sound — queue a sound to play for all clients in whichever server a player is currently in
app.post('/api/admin/play-sound', (req, res) => {
  const { username, soundId } = req.body;
  if (!username || !soundId) return res.status(400).json({ error: 'username and soundId are required' });
  const resolvedSoundId = String(soundId).trim();
  if (!/^\d+$/.test(resolvedSoundId)) return res.status(400).json({ error: 'soundId must be numeric' });
  const jobId = findJobIdByUsername(username);
  if (!jobId) return res.status(404).json({ error: `Could not find "${username}" in any tracked server. Make sure they're currently in-game.` });
  pendingPlaySounds.set(jobId, { soundId: resolvedSoundId, queuedAt: Date.now() });
  console.log(`[PlaySound] Queued sound "${resolvedSoundId}" for "${username}"'s server (job ${jobId})`);
  res.json({ message: `Sound rbxassetid://${resolvedSoundId} queued for ${username}'s server. It will play for all clients on the next poll.` });
});

// ── Redeem code admin endpoints ───────────────────────────────────────────────
app.post('/api/admin/createredeemcode', (req, res) => {
  let { codeName, brainrotName, limitedUses } = req.body;
  if (!codeName || !brainrotName) return res.status(400).json({ error: 'codeName and brainrotName are required' });
  codeName = String(codeName).trim().toUpperCase();
  brainrotName = String(brainrotName).trim();
  if (redeemCodes.has(codeName)) return res.status(409).json({ error: `Code "${codeName}" already exists.` });
  const uses = (limitedUses !== undefined && limitedUses !== null && limitedUses !== '') ? parseInt(limitedUses, 10) : null;
  if (uses !== null && (isNaN(uses) || uses < 1)) return res.status(400).json({ error: 'limitedUses must be a positive integer.' });
  redeemCodes.set(codeName, { brainrotName, limitedUses: uses, usedCount: 0, createdAt: new Date().toISOString() });
  console.log(`[RedeemCode] Created "${codeName}" -> ${brainrotName} (uses: ${uses ?? 'unlimited'})`);
  res.json({ message: `Code "${codeName}" created! Reward: ${brainrotName}${uses ? ` (${uses} uses)` : ' (unlimited)'}` });
});

app.post('/api/admin/createtriplecode', (req, res) => {
  let { codeName, brainrotNames, bundleName, limitedUses } = req.body;
  if (!codeName) return res.status(400).json({ error: 'codeName is required' });
  if (!Array.isArray(brainrotNames) || brainrotNames.length !== 3 || brainrotNames.some(n => !n || !n.trim()))
    return res.status(400).json({ error: 'brainrotNames must be an array of exactly 3 non-empty names' });
  codeName = String(codeName).trim().toUpperCase();
  const names = brainrotNames.map(n => String(n).trim());
  const bundle = bundleName ? String(bundleName).trim() : names.join(' + ');
  if (redeemCodes.has(codeName)) return res.status(409).json({ error: `Code "${codeName}" already exists.` });
  const uses = (limitedUses !== undefined && limitedUses !== null && limitedUses !== '') ? parseInt(limitedUses, 10) : null;
  if (uses !== null && (isNaN(uses) || uses < 1)) return res.status(400).json({ error: 'limitedUses must be a positive integer.' });
  redeemCodes.set(codeName, { brainrotNames: names, bundleName: bundle, limitedUses: uses, usedCount: 0, createdAt: new Date().toISOString(), isTriple: true });
  console.log(`[TripleCode] Created "${codeName}" -> [${names.join(', ')}] bundle:"${bundle}" (uses: ${uses ?? 'unlimited'})`);
  res.json({ message: `Triple code "${codeName}" created! Bundle: ${bundle} (${names.join(', ')})${uses ? ` — ${uses} uses` : ' — unlimited'}` });
});

app.delete('/api/admin/deleteredeemcode', (req, res) => {
  let { codeName } = req.body;
  if (!codeName) return res.status(400).json({ error: 'codeName is required' });
  codeName = String(codeName).trim().toUpperCase();
  if (!redeemCodes.has(codeName)) return res.status(404).json({ error: `Code "${codeName}" not found.` });
  redeemCodes.delete(codeName);
  console.log(`[RedeemCode] Deleted "${codeName}"`);
  res.json({ message: `Code "${codeName}" deleted.` });
});

app.get('/api/admin/listredeemcodes', (req, res) => {
  const list = [];
  for (const [name, data] of redeemCodes.entries()) {
    list.push({
      name,
      brainrotName:  data.brainrotName  || null,
      brainrotNames: data.brainrotNames || null,
      bundleName:    data.bundleName    || null,
      isTriple:      data.isTriple      || false,
      limitedUses:   data.limitedUses,
      usedCount:     data.usedCount,
      createdAt:     data.createdAt
    });
  }
  res.json({ codes: list });
});

// Swap Datastores — swap the entire datastore entries of two players (both must be offline)
app.post('/api/admin/swap-datastores', async (req, res) => {
  const { usernameA, usernameB } = req.body;
  if (!usernameA || !usernameB) return res.status(400).json({ error: 'usernameA and usernameB are required' });
  if (usernameA.trim().toLowerCase() === usernameB.trim().toLowerCase())
    return res.status(400).json({ error: 'Both usernames are the same.' });
  try {
    // Resolve both Roblox user IDs simultaneously
    const [resA, resB] = await Promise.all([
      axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [usernameA], excludeBannedUsers: false }),
      axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [usernameB], excludeBannedUsers: false }),
    ]);
    const userA = resA.data?.data?.[0];
    const userB = resB.data?.data?.[0];
    if (!userA) return res.status(404).json({ error: `Player "${usernameA}" not found on Roblox.` });
    if (!userB) return res.status(404).json({ error: `Player "${usernameB}" not found on Roblox.` });

    const idA = String(userA.id);
    const idB = String(userB.id);

    // Block if either player is currently in-game
    if (playersInGame.has(idA))
      return res.status(400).json({ error: `${userA.name} is currently in-game. Ask them to leave first.` });
    if (playersInGame.has(idB))
      return res.status(400).json({ error: `${userB.name} is currently in-game. Ask them to leave first.` });

    // Fetch both entries
    const [entryA, entryB] = await Promise.all([getEntry(idA), getEntry(idB)]);
    if (!entryA) return res.status(404).json({ error: `${userA.name} hasn't played the game yet (no datastore entry).` });
    if (!entryB) return res.status(404).json({ error: `${userB.name} hasn't played the game yet (no datastore entry).` });

    // Write A's data into B's key and B's data into A's key
    await Promise.all([
      axios.post(`${BASE}/entries/entry`, JSON.stringify(entryA), {
        params:  { datastoreName: DATASTORE_NAME, entryKey: idB },
        headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json', 'roblox-entry-userids': JSON.stringify([Number(idB)]) },
        timeout: 15000,
      }),
      axios.post(`${BASE}/entries/entry`, JSON.stringify(entryB), {
        params:  { datastoreName: DATASTORE_NAME, entryKey: idA },
        headers: { 'x-api-key': ROBLOX_API_KEY, 'Content-Type': 'application/json', 'roblox-entry-userids': JSON.stringify([Number(idA)]) },
        timeout: 15000,
      }),
    ]);

    console.log(`[SwapDatastores] Swapped datastores between ${userA.name} (${idA}) and ${userB.name} (${idB})`);
    res.json({ message: `Datastores swapped between ${userA.name} and ${userB.name}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send DM
app.post('/api/admin/dm', async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });
  try {
    const user    = await client.users.fetch(userId);
    const channel = await user.createDM();
    await channel.send(message);
    res.json({ message: `DM sent to ${user.tag}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════

// ── Start ─────────────────────────────────────────────────────────────────────
const picturesDir = path.join(__dirname, 'pictures');
if (!fs.existsSync(picturesDir)) fs.mkdirSync(picturesDir);

app.listen(PORT, () => console.log(`[Web] Running → http://localhost:${PORT}`));

client.once('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommands();
  loadCache();
  loadPairs();
});

client.login(process.env.DISCORD_TOKEN);
