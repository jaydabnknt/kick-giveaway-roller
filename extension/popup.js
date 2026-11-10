const $ = id => document.getElementById(id);
const isStake = u => { try { return /(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(new URL(u).hostname); } catch (e) { return false; } };
async function show() {
  const s = await chrome.storage.local.get(["enabled", "activeReq", "playing", "queue", "lastError", "log"]);
  $("on").checked = s.enabled !== false;
  $("learned").textContent = s.activeReq ? "learned" + (s.activeReq.operationName ? ` (${s.activeReq.operationName})` : "") : "not yet (open Stake)";
  $("learned").className = s.activeReq ? "ok" : "bad";
  $("playing").textContent = s.playing || "nothing yet";
  $("queue").textContent = (s.queue || []).length;
  $("err").textContent = (s.queue || []).length && s.lastError ? s.lastError : "";
  $("log").replaceChildren(...(s.log || []).slice(0, 15).map(l => {
    const li = document.createElement("li"), t = document.createElement("time");
    t.textContent = new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.append(t, l.text); return li;
  }));
}
$("on").addEventListener("change", () => chrome.storage.local.set({ enabled: $("on").checked }));
$("check").addEventListener("click", async () => {
  const t = (await chrome.tabs.query({})).find(t => isStake(t.url));
  if (!t) { $("err").textContent = "Open Stake in a tab first."; return; }
  await chrome.tabs.sendMessage(t.id, { cmd: "checkNow" }).catch(() => {});
  chrome.runtime.sendMessage({ type: "popupFlush" });
});
$("learn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "relearn" }));
chrome.storage.onChanged.addListener(show);
show();
