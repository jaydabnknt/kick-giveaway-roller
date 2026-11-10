// On ToolBot's site: passes messages from the extension to the page, and the page's answers back.
const pending = new Map();
window.addEventListener("message", e => {
  const d = e.data;
  if (e.source !== window || !d || d.from !== "toolbot-page" || !pending.has(d.ack)) return;
  pending.get(d.ack)(d); pending.delete(d.ack);
});
const toPage = msg => new Promise(res => {
  const id = Math.random().toString(36).slice(2);
  pending.set(id, res);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ ok: false, error: "the ToolBot page didn't answer (reload it)" }); } }, 5000);
  window.postMessage({ from: "toolbot-ext", id, ...msg }, location.origin);
});
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.deliver) { toPage(m.deliver).then(reply); return true; }
});
setTimeout(() => chrome.runtime.sendMessage({ type: "siteReady" }).catch(() => {}), 1500);
