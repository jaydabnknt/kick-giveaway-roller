const $ = id => document.getElementById(id);
const isStake = u => { try { return /(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(new URL(u).hostname); } catch (e) { return false; } };
const stakeTab = async () => (await chrome.tabs.query({})).find(t => isStake(t.url));
async function show() {
  const s = await chrome.storage.local.get(["listReq", "detailReq", "status", "slugs", "prog"]);
  $("s1").className = s.listReq ? "ok" : ""; $("s1x").textContent = s.listReq ? `Got it (${s.listReq.n} per page).` : "";
  $("s2").className = s.detailReq ? "ok" : ""; $("s2x").textContent = s.detailReq ? `Got it (${s.detailReq.slug}).` : "Optional, but gives RTP, max win and tags.";
  $("st").textContent = s.status ? s.status.note : "Not started.";
  $("dl").disabled = !(s.slugs && s.slugs.length);
  $("start").disabled = !s.listReq;
}
$("start").addEventListener("click", async () => { const t = await stakeTab(); if (!t) { $("st").textContent = "Open Stake in a tab first."; return; } chrome.tabs.sendMessage(t.id, { cmd: "start" }); });
$("pause").addEventListener("click", async () => { const t = await stakeTab(); if (t) chrome.tabs.sendMessage(t.id, { cmd: "pause" }); });
$("dl").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("export.html") }));
$("reset").addEventListener("click", async () => { if (confirm("Forget everything collected so far?")) { await chrome.storage.local.clear(); show(); } });
chrome.storage.onChanged.addListener(show);
show();
