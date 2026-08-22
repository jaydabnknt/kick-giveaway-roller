const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/chat' });
const PORT = process.env.PORT || 10000;
const CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.KICK_REDIRECT_URI || '';

const oauthStates = new Map();
const clients = new Set();
let accessToken = null;
let kickUser = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type:'status', connected:!!accessToken, username:kickUser?.name || null }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}
function b64url(buf) { return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

app.get('/auth/kick', (req,res) => {
  if (!CLIENT_ID || !REDIRECT_URI) return res.status(500).send('KICK OAuth is not configured yet.');
  const state = b64url(crypto.randomBytes(24));
  const {verifier,challenge} = pkce();
  oauthStates.set(state,{verifier,createdAt:Date.now()});
  const u = new URL('https://id.kick.com/oauth/authorize');
  u.searchParams.set('client_id',CLIENT_ID);
  u.searchParams.set('response_type','code');
  u.searchParams.set('redirect_uri',REDIRECT_URI);
  u.searchParams.set('scope','user:read events:subscribe');
  u.searchParams.set('state',state);
  u.searchParams.set('code_challenge',challenge);
  u.searchParams.set('code_challenge_method','S256');
  res.redirect(u.toString());
});

app.get('/auth/kick/callback', async (req,res) => {
  const {code,state,error} = req.query;
  if (error) return res.status(400).send(`KICK authorization failed: ${error}`);
  const saved = oauthStates.get(state);
  oauthStates.delete(state);
  if (!saved || Date.now()-saved.createdAt > 10*60*1000) return res.status(400).send('Invalid or expired OAuth state.');
  try {
    const r = await fetch('https://id.kick.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:REDIRECT_URI,code,code_verifier:saved.verifier})});
    const token = await r.json();
    if (!r.ok) return res.status(502).send('KICK token exchange failed.');
    accessToken = token.access_token;
    kickUser = await getKickUser();
    broadcast({type:'status',connected:true,username:kickUser?.name || null});
    res.redirect('/');
  } catch (e) { console.error(e); res.status(500).send('KICK connection failed.'); }
});

async function kickApi(url, options={}) {
  const r = await fetch(url,{...options,headers:{Accept:'application/json',Authorization:`Bearer ${accessToken}`,...(options.headers||{})}});
  const text = await r.text();
  let data; try { data=JSON.parse(text); } catch { data=text; }
  if (!r.ok) throw new Error(`KICK API ${r.status}: ${text}`);
  return data;
}
async function getKickUser() {
  try { const data=await kickApi('https://api.kick.com/public/v1/users'); return Array.isArray(data.data)?data.data[0]:data.data||null; }
  catch(e){ console.warn('Could not read KICK user:',e.message); return null; }
}

/*
  The browser/roller is ready for live chat messages. KICK event-subscription
  details should be wired here against the current official developer docs
  before production use, rather than guessing a websocket/event endpoint.
  When a chat event arrives, call:

      broadcast({ type:'chat', username:'ViewerName' });
*/

app.get('/api/status',(req,res)=>res.json({connected:!!accessToken,username:kickUser?.name||null}));
app.post('/api/logout',(req,res)=>{accessToken=null;kickUser=null;broadcast({type:'status',connected:false,username:null});res.json({ok:true});});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

server.listen(PORT,()=>console.log(`Listening on ${PORT}`));
