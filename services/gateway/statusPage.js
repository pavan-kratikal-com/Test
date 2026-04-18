// Self-contained HTML status dashboard — no external dependencies.
export function renderStatusPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETDP Service Status</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
         background: #0f1117; color: #e1e4e8; padding: 24px; }
  .header { display: flex; justify-content: space-between; align-items: center;
            padding: 16px 20px; background: #161b22; border-radius: 8px 8px 0 0;
            border: 1px solid #30363d; border-bottom: none; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .refresh-info { font-size: 13px; color: #8b949e; }
  .grid { border: 1px solid #30363d; border-radius: 0 0 8px 8px; overflow: hidden; }
  .row { display: grid; grid-template-columns: 24px 1fr 80px 80px 100px;
         align-items: center; gap: 12px; padding: 10px 20px;
         border-bottom: 1px solid #21262d; }
  .row:last-child { border-bottom: none; }
  .row:hover { background: #161b22; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot.ok { background: #3fb950; }
  .dot.down { background: #f85149; }
  .dot.restarting { background: #d29922; }
  .dot.unknown { background: #8b949e; }
  .name { font-weight: 500; font-size: 14px; }
  .status { font-size: 13px; }
  .status.ok { color: #3fb950; }
  .status.down { color: #f85149; }
  .status.restarting { color: #d29922; }
  .latency { font-size: 13px; color: #8b949e; text-align: right; }
  .btn { padding: 4px 12px; font-size: 12px; border: 1px solid #30363d;
         border-radius: 6px; background: #21262d; color: #c9d1d9; cursor: pointer; }
  .btn:hover { background: #30363d; border-color: #8b949e; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .footer { display: flex; justify-content: space-between; padding: 12px 20px;
            background: #161b22; border: 1px solid #30363d; border-top: none;
            border-radius: 0 0 8px 8px; font-size: 13px; color: #8b949e; margin-top: -1px; }
  .error-toast { position: fixed; bottom: 20px; right: 20px; background: #f8514926;
                 border: 1px solid #f85149; color: #f85149; padding: 10px 16px;
                 border-radius: 8px; font-size: 13px; display: none; }
</style>
</head>
<body>
<div class="header">
  <h1>ETDP Service Status</h1>
  <span class="refresh-info">Auto-refresh: <span id="countdown">10</span>s</span>
</div>
<div class="grid" id="grid">
  <div class="row"><span style="color:#8b949e">Loading...</span></div>
</div>
<div class="footer" id="footer">
  <span id="last-checked">Last checked: —</span>
  <span id="healthy-count">Healthy: —</span>
</div>
<div class="error-toast" id="toast"></div>

<script>
const REFRESH_INTERVAL = 10;
let countdown = REFRESH_INTERVAL;
let restarting = {};

async function fetchStatus() {
  try {
    const res = await fetch("/admin/status");
    const services = await res.json();
    render(services);
  } catch (e) {
    showToast("Failed to fetch status: " + e.message);
  }
}

function render(services) {
  const grid = document.getElementById("grid");
  const rows = services.map(s => {
    const state = restarting[s.name] ? "restarting" : (s.status === "ok" ? "ok" : "down");
    const label = state === "restarting" ? "restarting" : s.status;
    const lat = s.status === "ok" ? s.latency_ms + "ms" : "—";
    const disabled = state !== "ok" ? "disabled" : "";
    return \`<div class="row">
      <span class="dot \${state}"></span>
      <span class="name">\${esc(s.name)}</span>
      <span class="status \${state}">\${esc(label)}</span>
      <span class="latency">\${esc(lat)}</span>
      <button class="btn" \${disabled} onclick="restart('\${esc(s.name)}')">Restart</button>
    </div>\`;
  }).join("");
  grid.innerHTML = rows;

  const healthy = services.filter(s => s.status === "ok" && !restarting[s.name]).length;
  document.getElementById("healthy-count").textContent = "Healthy: " + healthy + "/" + services.length;
  document.getElementById("last-checked").textContent = "Last checked: " + new Date().toLocaleString();

  // Clear restarting state if service came back
  for (const s of services) {
    if (s.status === "ok" && restarting[s.name]) delete restarting[s.name];
  }
}

async function restart(name) {
  if (!confirm("Restart " + name + "?")) return;
  restarting[name] = true;
  try {
    const res = await fetch("/admin/restart/" + encodeURIComponent(name), { method: "POST" });
    const data = await res.json();
    if (!res.ok) showToast(data.error || "Restart failed");
  } catch (e) {
    showToast("Restart request failed: " + e.message);
  }
  fetchStatus();
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  setTimeout(() => t.style.display = "none", 5000);
}

setInterval(() => {
  countdown--;
  document.getElementById("countdown").textContent = countdown;
  if (countdown <= 0) { countdown = REFRESH_INTERVAL; fetchStatus(); }
}, 1000);

fetchStatus();
</script>
</body>
</html>`;
}
