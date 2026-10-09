import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import pg from 'pg';
import { Server as SocketIOServer } from 'socket.io';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  transports: ['polling', 'websocket'],
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
});

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway/Postgres providers commonly require TLS in production.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PGPOOL_MAX || 10),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  query_timeout: 15000,
  keepAlive: true
});
pool.on('error', (err) => console.error('Unexpected PostgreSQL pool error:', err.message));

async function initializeDatabase() {
  // Keep schema.sql beside server.js so deployment can initialize an empty database.
  const schema = await readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  // Safe, additive migrations for databases created by an earlier VIBORA version.
  await pool.query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'Nigeria 🇳🇬';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'Global';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS personality TEXT NOT NULL DEFAULT 'Ambitious';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS style TEXT NOT NULL DEFAULT 'Street Luxe';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS money INTEGER NOT NULL DEFAULT 10000;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS fame INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS followers INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS day INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS business_level INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS business_started BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE players ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'Home';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS activity TEXT NOT NULL DEFAULT 'New life started';
    ALTER TABLE players ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE players ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE life_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS life_events_player_created_idx ON life_events(player_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS chat_messages_location_created_idx ON chat_messages(location, created_at DESC);
  `);
  await pool.query('SELECT 1');
  console.log('VIBORA database schema ready.');
}

const LOCATIONS = ['Home', 'Work District', 'Market Street', 'Pulse Club'];
const MAX_NAME = 20;
const MAX_MESSAGE = 500;
const COOKIE = 'vibora_token';

app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function cleanText(value, max) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, max);
}
function money(n) { return `₦${Number(n).toLocaleString('en-NG')}`; }
function signToken(player) {
  return jwt.sign({ sub: player.id, name: player.name }, JWT_SECRET, { expiresIn: '30d' });
}
function setAuth(res, player) {
  res.cookie(COOKIE, signToken(player), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}
function getToken(req) { return req.cookies?.[COOKIE]; }
function auth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Not signed in.' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
}
async function playerById(id) {
  const { rows } = await pool.query('SELECT * FROM players WHERE id=$1', [id]);
  return rows[0] || null;
}
async function eventsFor(id) {
  const { rows } = await pool.query('SELECT text FROM life_events WHERE player_id=$1 ORDER BY created_at DESC LIMIT 30', [id]);
  return rows.map(r => r.text);
}
function publicState(p, events) {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    country: p.country,
    region: p.region,
    personality: p.personality,
    style: p.style,
    money: p.money,
    fame: p.fame,
    followers: p.followers,
    day: p.day,
    businessLevel: p.business_level,
    businessStarted: p.business_started,
    location: p.location,
    activity: p.activity,
    events,
    updatedAt: p.updated_at
  };
}
async function addEvent(client, playerId, day, text) {
  await client.query('INSERT INTO life_events(player_id,text) VALUES($1,$2)', [playerId, `Day ${day} — ${text}`]);
}
async function transactionUpdate(id, updater) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM players WHERE id=$1 FOR UPDATE', [id]);
    if (!rows[0]) throw Object.assign(new Error('Player not found.'), { status: 404 });
    const next = await updater(rows[0], client);
    await client.query(
      `UPDATE players SET name=$2,country=$3,region=$4,personality=$5,style=$6,money=$7,fame=$8,followers=$9,day=$10,business_level=$11,business_started=$12,location=$13,activity=$14,updated_at=NOW() WHERE id=$1`,
      [id,next.name,next.country,next.region,next.personality,next.style,next.money,next.fame,next.followers,next.day,next.business_level,next.business_started,next.location,next.activity]
    );
    await client.query('COMMIT');
    return await playerById(id);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}
function publicPlayer(p) { return { id: p.id, name: p.name, location: p.location, activity: p.activity, fame: p.fame, followers: p.followers }; }

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'VIBORA', database: 'connected', time: new Date().toISOString() }); }
  catch (err) { console.error('Health check failed:', err.message); res.status(503).json({ ok: false, service: 'VIBORA', database: 'unavailable' }); }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const email = cleanText(req.body.email, 120).toLowerCase();
    const password = String(req.body.password || '');
    const name = cleanText(req.body.name, MAX_NAME);
    const country = cleanText(req.body.country, 60) || 'Nigeria 🇳🇬';
    const region = cleanText(req.body.region, 30) || 'Global';
    const personality = cleanText(req.body.personality, 30) || 'Ambitious';
    const style = cleanText(req.body.style, 30) || 'Street Luxe';
    if (!email.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!name) return res.status(400).json({ error: 'Enter a character name.' });
    const existing = await pool.query('SELECT 1 FROM players WHERE email=$1', [email]);
    if (existing.rowCount) return res.status(409).json({ error: 'That email is already registered.' });
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO players(id,email,password_hash,name,country,region,personality,style) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id,email,hash,name,country,region,personality,style]
    );
    await pool.query('INSERT INTO life_events(player_id,text) VALUES($1,$2)', [id, `Day 1 — ${name} entered VIBORA with ₦10,000.`]);
    setAuth(res, rows[0]);
    res.json({ state: publicState(rows[0], [`Day 1 — ${name} entered VIBORA with ₦10,000.`]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create the account.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = cleanText(req.body.email, 120).toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT * FROM players WHERE email=$1', [email]);
    const player = rows[0];
    if (!player || !(await bcrypt.compare(password, player.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    setAuth(res, player);
    res.json({ state: publicState(player, await eventsFor(player.id)) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not sign in.' }); }
});

app.post('/api/auth/logout', (_req, res) => { res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }); res.json({ ok: true }); });
app.get('/api/me', auth, async (req, res) => { const p = await playerById(req.user.sub); if (!p) return res.status(404).json({ error: 'Player not found.' }); res.json({ state: publicState(p, await eventsFor(p.id)) }); });

app.post('/api/game/create', auth, async (req, res) => {
  try {
    const next = await transactionUpdate(req.user.sub, async (p, client) => {
      const name = cleanText(req.body.name, MAX_NAME) || p.name;
      const country = cleanText(req.body.country, 60) || p.country;
      const region = cleanText(req.body.region, 30) || 'Global';
      const personality = cleanText(req.body.personality, 30) || 'Ambitious';
      const style = cleanText(req.body.style, 30) || 'Street Luxe';
      await client.query('DELETE FROM life_events WHERE player_id=$1', [p.id]);
      await addEvent(client, p.id, 1, `${name} entered VIBORA with ₦10,000.`);
      return { ...p, name, country, region, personality, style, money:10000, fame:0, followers:0, day:1, business_level:0, business_started:false, location:'Home', activity:'New life started' };
    });
    res.json({ state: publicState(next, await eventsFor(next.id)) });
  } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || 'Could not create life.' }); }
});

app.post('/api/game/save', auth, async (req, res) => {
  try { const p = await playerById(req.user.sub); if (!p) return res.status(404).json({ error:'Player not found.' }); res.json({ state: publicState(p, await eventsFor(p.id)) }); }
  catch { res.status(500).json({ error:'Save failed.' }); }
});

app.post('/api/game/location', auth, async (req, res) => {
  try {
    const location = cleanText(req.body.location, 40);
    if (!LOCATIONS.includes(location)) return res.status(400).json({ error: 'Invalid location.' });
    const next = await transactionUpdate(req.user.sub, async (p, client) => {
      const day = p.day + 1;
      await addEvent(client, p.id, day, `Visited ${location}.`);
      return { ...p, location, day, activity:`Exploring ${location}` };
    });
    res.json({ state: publicState(next, await eventsFor(next.id)) });
    broadcastLocation(next);
  } catch (e) { res.status(e.status || 500).json({ error:e.message || 'Could not change location.' }); }
});

app.post('/api/game/work', auth, async (req, res) => {
  try {
    const jobs = { 'Delivery Rider': [2500,1], 'Freelance Designer':[3500,3], 'Café Assistant':[1800,1] };
    const job = cleanText(req.body.job, 40);
    if (!jobs[job]) return res.status(400).json({ error:'Invalid job.' });
    const [pay, fame] = jobs[job];
    const next = await transactionUpdate(req.user.sub, async (p, client) => {
      const day=p.day+1; await addEvent(client,p.id,day,`Worked as ${job} and earned ${money(pay)}.`);
      return {...p,money:p.money+pay,fame:p.fame+fame,day,activity:`${job} shift completed`};
    });
    res.json({ state: publicState(next, await eventsFor(next.id)) });
  } catch(e){res.status(e.status||500).json({error:e.message||'Work failed.'});}
});

app.post('/api/game/business/start', auth, async (req,res)=>{
  try { const next=await transactionUpdate(req.user.sub,async(p,client)=>{ if(p.business_started) throw Object.assign(new Error('Business already open.'),{status:400}); if(p.money<5000) throw Object.assign(new Error('You need ₦5,000.'),{status:400}); const day=p.day+1; await addEvent(client,p.id,day,'Opened Vibora Shop.'); return {...p,money:p.money-5000,business_started:true,business_level:1,day,activity:'Running Vibora Shop'};}); res.json({state:publicState(next,await eventsFor(next.id))}); }
  catch(e){res.status(e.status||500).json({error:e.message||'Could not start business.'});}
});
app.post('/api/game/business/collect', auth, async (req,res)=>{
  try { const next=await transactionUpdate(req.user.sub,async(p,client)=>{ if(!p.business_started) throw Object.assign(new Error('Start the business first.'),{status:400}); const income=1500+p.business_level*1000; const day=p.day+1; await addEvent(client,p.id,day,`Collected ${money(income)} from Vibora Shop.`); return {...p,money:p.money+income,day,activity:'Collected business income'};}); res.json({state:publicState(next,await eventsFor(next.id))}); }
  catch(e){res.status(e.status||500).json({error:e.message||'Could not collect income.'});}
});
app.post('/api/game/business/upgrade', auth, async (req,res)=>{
  try { const next=await transactionUpdate(req.user.sub,async(p,client)=>{ if(!p.business_started) throw Object.assign(new Error('Start the business first.'),{status:400}); if(p.business_level>=3) throw Object.assign(new Error('Maximum prototype level reached.'),{status:400}); const cost=4000+p.business_level*2000; if(p.money<cost) throw Object.assign(new Error(`You need ${money(cost)}.`),{status:400}); const level=p.business_level+1; const day=p.day+1; await addEvent(client,p.id,day,`Upgraded Vibora Shop to Level ${level}.`); return {...p,money:p.money-cost,business_level:level,fame:p.fame+5,day,activity:`Upgraded Vibora Shop to Level ${level}`};}); res.json({state:publicState(next,await eventsFor(next.id))}); }
  catch(e){res.status(e.status||500).json({error:e.message||'Could not upgrade business.'});}
});
app.post('/api/game/video', auth, async (req,res)=>{
  try { const next=await transactionUpdate(req.user.sub,async(p,client)=>{ if(p.money<300) throw Object.assign(new Error('You need ₦300.'),{status:400}); const day=p.day+1; await addEvent(client,p.id,day,'Posted a creator video and gained 17 followers.'); return {...p,money:p.money-300,followers:p.followers+17,fame:p.fame+8,day,activity:'Posted a creator video'};}); res.json({state:publicState(next,await eventsFor(next.id))}); }
  catch(e){res.status(e.status||500).json({error:e.message||'Could not post video.'});}
});

app.get('/api/chat/history', auth, async (req,res)=>{
  try { const p=await playerById(req.user.sub); const loc=LOCATIONS.includes(p.location)?p.location:'Home'; const {rows}=await pool.query('SELECT id,player_id,player_name,location,message,created_at FROM chat_messages WHERE location=$1 ORDER BY created_at DESC LIMIT 50',[loc]); res.json({messages:rows.reverse()}); }
  catch { res.status(500).json({error:'Could not load chat.'}); }
});

const online = new Map();
function broadcastLocation(p) {
  io.emit('player:moved', publicPlayer(p));
}
async function onlinePlayers(location) {
  const ids=[...online.values()].filter(x=>x.location===location).map(x=>x.playerId);
  if(!ids.length) return [];
  const {rows}=await pool.query('SELECT id,name,location,activity,fame,followers FROM players WHERE id = ANY($1::uuid[])',[ids]);
  return rows.map(publicPlayer);
}
async function emitPresence(location) { io.emit('presence:update', { location, players: await onlinePlayers(location) }); }

io.use((socket,next)=>{
  try {
    const raw=socket.handshake.headers.cookie||'';
    const token=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.split('=')[1];
    if(!token) return next(new Error('Not signed in'));
    socket.user=jwt.verify(token,JWT_SECRET); next();
  } catch { next(new Error('Not signed in')); }
});

io.on('connection', async socket=>{
  try {
    const p=await playerById(socket.user.sub); if(!p){socket.disconnect(true);return;}
    online.set(socket.id,{playerId:p.id,location:p.location});
    socket.join(`location:${p.location}`);
    socket.emit('presence:update',{location:p.location,players:await onlinePlayers(p.location)});
    await emitPresence(p.location);
  } catch (err) { console.error('Socket connection setup failed:', err.message); socket.disconnect(true); return; }

  socket.on('location:sync', async () => {
    try {
      const current = await playerById(socket.user.sub);
      if (!current) return socket.disconnect(true);
      const old = online.get(socket.id);
      const oldLocation = old?.location;
      const newLocation = LOCATIONS.includes(current.location) ? current.location : 'Home';
      if (oldLocation && oldLocation !== newLocation) socket.leave(`location:${oldLocation}`);
      socket.join(`location:${newLocation}`);
      online.set(socket.id, { playerId: current.id, location: newLocation });
      socket.emit('presence:update', { location: newLocation, players: await onlinePlayers(newLocation) });
      if (oldLocation) await emitPresence(oldLocation);
      await emitPresence(newLocation);
    } catch (err) { console.error('Location sync failed:', err.message); }
  });

  socket.on('chat:send', async raw=>{
    try {
      const message=cleanText(raw?.message,MAX_MESSAGE); if(!message) return;
      const current=await playerById(socket.user.sub); if(!current) return;
      const location=LOCATIONS.includes(current.location)?current.location:'Home';
      const {rows}=await pool.query('INSERT INTO chat_messages(player_id,player_name,location,message) VALUES($1,$2,$3,$4) RETURNING id,player_id,player_name,location,message,created_at',[current.id,current.name,location,message]);
      io.to(`location:${location}`).emit('chat:message',rows[0]);
    } catch (err) { console.error('Chat message failed:', err.message); socket.emit('chat:error', { error: 'Message could not be sent. Please try again.' }); }
  });

  socket.on('disconnect',async()=>{ const info=online.get(socket.id); online.delete(socket.id); if(info) { try { await emitPresence(info.location); } catch (err) { console.error('Presence update failed:', err.message); } } });
});

// Express 5 catch-all; static frontend is deployed at public/index.html.
app.get('/{*splat}', (_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.use((err, _req, res, _next) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return;
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
  res.status(status).json({ error: status === 500 ? 'Server error. Please try again shortly.' : err.message });
});

async function start() {
  try {
    await initializeDatabase();
    httpServer.listen(PORT, '0.0.0.0', () => console.log(`VIBORA online server listening on ${PORT}`));
  } catch (err) {
    console.error('VIBORA startup failed. Check DATABASE_URL, database availability, and schema.sql:', err.message);
    process.exitCode = 1;
    await pool.end().catch(() => {});
    process.exit();
  }
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down VIBORA gracefully.`);
  httpServer.close(async () => {
    await pool.end().catch(err => console.error('Database shutdown error:', err.message));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
start();
