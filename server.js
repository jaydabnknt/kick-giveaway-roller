const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/chat" });

const PORT = process.env.PORT || 10000;
const CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.KICK_REDIRECT_URI || "";

let kickAccessToken = null;
let kickUser = null;

const oauthStates = new Map();
const browserClients = new Set();

app.use(express.raw({ type: "*/*" }));
app.use(express.static(path.join(__dirname, "public")));

wss.on("connection", (ws) => {
  browserClients.add(ws);

  ws.send(JSON.stringify({
    type: "status",
    connected: Boolean(kickAccessToken),
    username: kickUser?.name || kickUser?.username || null
  }));

  ws.on("close", () => browserClients.delete(ws));
});

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const ws of browserClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPKCE() {
  const verifier = base64url(crypto.randomBytes(32));

  const challenge = base64url(
    crypto.createHash("sha256")
      .update(verifier)
      .digest()
  );

  return { verifier, challenge };
}

/* ---------------- KICK LOGIN ---------------- */

app.get("/auth/kick", (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res
      .status(500)
      .send("KICK_CLIENT_ID or KICK_REDIRECT_URI is missing.");
  }

  const state = base64url(crypto.randomBytes(24));
  const { verifier, challenge } = createPKCE();

  oauthStates.set(state, {
    verifier,
    createdAt: Date.now()
  });

  const url = new URL("https://id.kick.com/oauth/authorize");

  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);

  url.searchParams.set(
    "scope",
    "user:read channel:read events:subscribe"
  );

  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.redirect(url.toString());
});

/* ---------------- OAUTH CALLBACK ---------------- */

app.get("/auth/kick/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`KICK authorization failed: ${error}`);
  }

  const saved = oauthStates.get(state);
  oauthStates.delete(state);

  if (!saved || Date.now() - saved.createdAt > 10 * 60 * 1000) {
    return res.status(400).send("Invalid or expired OAuth state.");
  }

  try {
    const response = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
        code_verifier: saved.verifier
      })
    });

    const token = await response.json();

    if (!response.ok) {
      console.error("KICK token error:", token);
      return res.status(502).send("KICK token exchange failed.");
    }

    kickAccessToken = token.access_token;

    await loadKickUser();

    broadcast({
      type: "status",
      connected: true,
      username: kickUser?.name || kickUser?.username || null
    });

    await subscribeToChat();

    res.redirect("/");
  } catch (error) {
    console.error(error);
    res.status(500).send("KICK connection failed.");
  }
});

/* ---------------- KICK USER ---------------- */

async function loadKickUser() {
  const response = await fetch(
    "https://api.kick.com/public/v1/users",
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${kickAccessToken}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `KICK user request failed: ${JSON.stringify(data)}`
    );
  }

  kickUser = Array.isArray(data?.data)
    ? data.data[0]
    : data?.data || null;
}

/* ---------------- CHAT SUBSCRIPTION ---------------- */

async function subscribeToChat() {
  const response = await fetch(
    "https://api.kick.com/public/v1/events/subscriptions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${kickAccessToken}`
      },
      body: JSON.stringify({
        method: "webhook",
        events: [
          {
            name: "chat.message.sent",
            version: 1
          }
        ]
      })
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error(
      "KICK subscription failed:",
      response.status,
      data
    );

    broadcast({
      type: "subscription",
      ok: false,
      error: data
    });

    return;
  }

  console.log("KICK chat subscription:", data);

  broadcast({
    type: "subscription",
    ok: true
  });
}

/* ---------------- WEBHOOK ---------------- */

app.post("/webhooks/kick", (req, res) => {
  const eventType = req.get("Kick-Event-Type") || "";

  /*
   * Ignore events other than chat messages.
   */
  if (eventType !== "chat.message.sent") {
    return res.sendStatus(200);
  }

  let payload;

  try {
    payload = JSON.parse(
      Buffer.from(req.body || "").toString("utf8")
    );
  } catch {
    return res.sendStatus(400);
  }

  const sender = payload?.sender;

  const username =
    sender?.username ||
    sender?.display_name ||
    sender?.name;

  if (username) {
    broadcast({
      type: "chat",
      username,
      userId: sender?.user_id || sender?.id || null,
      messageId:
        payload?.message_id ||
        req.get("Kick-Event-Message-Id") ||
        null
    });

    console.log("KICK chat:", username);
  }

  res.sendStatus(200);
});

/* ---------------- STATUS ---------------- */

app.get("/api/status", (req, res) => {
  res.json({
    connected: Boolean(kickAccessToken),
    username:
      kickUser?.name ||
      kickUser?.username ||
      null
  });
});

/* ---------------- LOGOUT ---------------- */

app.post("/api/logout", (req, res) => {
  kickAccessToken = null;
  kickUser = null;

  broadcast({
    type: "status",
    connected: false,
    username: null
  });

  res.json({ ok: true });
});

/* ---------------- FRONTEND ---------------- */

app.use((req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* ---------------- START ---------------- */

server.listen(PORT, () => {
  console.log(
    `Giveaway roller listening on port ${PORT}`
  );
});