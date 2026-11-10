// Keeps the queue of bonuses for ToolBot, learns the Active bets request, and remembers which bets were already sent.
const SITE = "https://toolbott.pages.dev/*";
const get = k => chrome.storage.local.get(k);
const set = o => chrome.storage.local.set(o);

async function log(text) {
  const { log: l = [] } = await get("log");
  l.unshift({ at: Date.now(), text }); await set({ log: l.slice(0, 40) });
}

// ---- learning: open My Bets > Active in a background tab and keep the best-looking request it makes ----
let learning = null;   // { tabId, best, firstTime, timer }
async function learn(origin, again) {
  if (learning) return;
  const { activeReq } = await get("activeReq");
  if (again) await set({ activeReq: null });
  const tab = await chrome.tabs.create({ url: origin + "/my-bets/casino/active", active: false });
  learning = { tabId: tab.id, best: null, firstTime: !activeReq && !again };
  learning.timer = setTimeout(finishLearning, 12000);
}
async function finishLearning() {
  const L = learning; learning = null; if (!L) return;
  clearTimeout(L.timer);
  chrome.tabs.remove(L.tabId).catch(() => {});
  if (!L.best) { await log("Couldn't learn the Active bets request. Open My Bets > Active on Stake once yourself."); return; }
  await set({ activeReq: L.best.req, activeScore: L.best.score });
  if (L.firstTime) { await markSeen(L.best.bets.map(b => b.id)); await log(`Learned the Active bets request. ${L.best.bets.length} bet(s) already open were skipped.`); }
  else await log("Learned the Active bets request again.");
}
async function onCandidate(m, tabId) {
  if (learning && tabId === learning.tabId) {
    if (!learning.best || m.score > learning.best.score) learning.best = { score: m.score, req: m.req, bets: m.bets || [] };
    if (m.score >= 5) { clearTimeout(learning.timer); learning.timer = setTimeout(finishLearning, 1500); }
    return;
  }
  // You opened the Active page yourself: use it if it's at least as good as what's saved.
  const { activeReq, activeScore = 0 } = await get(["activeReq", "activeScore"]);
  if (!activeReq || m.score >= activeScore) {
    await set({ activeReq: m.req, activeScore: m.score });
    if (!activeReq) { await markSeen((m.bets || []).map(b => b.id)); await log("Learned the Active bets request from My Bets."); }
  }
}

// ---- bets already handled ----
async function markSeen(ids) {
  const { seen = [] } = await get("seen");
  const s = new Set(seen); ids.forEach(i => s.add(String(i)));
  await set({ seen: [...s].slice(-500) });
}

// ---- delivery to the ToolBot tab ----
async function deliver(item) {
  const tabs = await chrome.tabs.query({ url: SITE });
  let last = { ok: false, error: "No ToolBot tab is open." };
  for (const t of tabs) {
    const r = await chrome.tabs.sendMessage(t.id, { deliver: item }).catch(() => null);
    if (r && r.ok) return r;
    if (r) last = r;
  }
  return last;
}
let flushing = false;
async function flush() {
  if (flushing) return; flushing = true;
  try {
    const { queue = [] } = await get("queue");
    const left = [];
    for (const it of queue) {
      const r = await deliver(it);
      if (r.ok) { if (!r.dup) await log(`Added ${it.game} to the bonus hunt.`); }
      else { left.push(it); await set({ lastError: r.error }); }
    }
    await set({ queue: left });
    if (!left.length) await set({ lastError: "" });
  } finally { flushing = false; }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  (async () => {
    const tabId = sender.tab && sender.tab.id;
    const { enabled = true } = await get("enabled");
    if (m.type === "candidate") await onCandidate(m, tabId);
    else if (m.type === "learn") await learn(m.origin, m.again);
    else if (m.type === "log") await log(m.text);
    else if (m.type === "siteReady") await flush();
    else if (m.type === "playing" && enabled) { await set({ playing: m.game }); await deliver({ type: "playing", game: m.game }); }
    else if (m.type === "active" && enabled) {
      const { seen = [], queue = [] } = await get(["seen", "queue"]);
      const fresh = (m.bets || []).filter(b => !seen.includes(b.id));
      if (fresh.length) {
        await markSeen(fresh.map(b => b.id));
        await set({ queue: queue.concat(fresh.map(b => ({ type: "bonus", game: b.game, betId: b.id, amount: b.amount }))) });
        await log(`Found ${fresh.length} new unfinished bet(s): ${fresh.map(b => b.game).join(", ")}.`);
        await flush();
      }
    }
    else if (m.type === "popupFlush") await flush();
    else if (m.type === "relearn") { const t = (await chrome.tabs.query({})).find(t => /(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(new URL(t.url || "about:blank").hostname)); if (t) await learn(new URL(t.url).origin, true); else await log("Open Stake first, then tap Learn again."); }
    reply({ ok: true });
  })();
  return true;
});
