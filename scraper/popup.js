const $ = id => document.getElementById(id);
const isStake = u => { try { return /(^|\.)stake\d*\.[a-z]{2,}(\.[a-z]{2})?$/i.test(new URL(u).hostname); } catch (e) { return false; } };
const stakeTab = async () => (await chrome.tabs.query({})).find(t => isStake(t.url));
async function show() {
  const s = await chrome.storage.local.get(["listReq", "detailReq", "status", "slugs", "prog"]);
  $("s1").className = s.listReq ? "ok" : ""; $("s1x").textContent = s.listReq ? `found (like ${(s.listReq.sample || []).join(", ")})` + (s.slugs ? `, ${s.slugs.length} slots` : "") : "not yet";
  $("s2").className = s.detailReq ? "ok" : ""; $("s2x").textContent = s.detailReq ? (s.prog && s.prog.phase === "detail" || s.prog && s.prog.phase === "done" ? `${s.prog.done} done` : "found") : "not yet";
  $("st").textContent = s.status ? s.status.note : "Not started.";
}
$("start").addEventListener("click", async () => {
  // Firefox asks before an extension may read websites; ask here, since this tap counts as your OK.
  const ok = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => true);
  if (!ok) { $("st").textContent = "It needs permission to read Stake's page. Tap Start again and allow it."; return; } const t = await stakeTab(); if (!t) { $("st").textContent = "Open Stake in a tab first."; return; } chrome.tabs.sendMessage(t.id, { cmd: "start" }); });
$("pause").addEventListener("click", async () => { const t = await stakeTab(); if (t) chrome.tabs.sendMessage(t.id, { cmd: "pause" }); });
$("dl").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("export.html") }));
$("reset").addEventListener("click", async () => { if (confirm("Forget everything collected so far?")) { await chrome.storage.local.clear(); show(); } });
chrome.storage.onChanged.addListener(show);
show();
