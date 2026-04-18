// Enterprise Email Security Dashboard — self-contained HTML SPA, no external dependencies.
// Hash-based routing: #overview, #threats, #incident/:org/:msg, #users, #domains,
//                     #campaigns, #policies, #models
export function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETDP SOC Dashboard</title>
<style>
  :root {
    --bg: #0a0e14; --surface: #131920; --surface2: #1a2230;
    --border: #1e2a36; --text: #e6edf3; --muted: #7d8590;
    --accent: #58a6ff; --crit: #f85149; --high: #db6d28;
    --med: #d29922; --low: #3fb950; --info: #58a6ff;
  }
  [data-theme="light"] {
    --bg: #f6f8fa; --surface: #ffffff; --surface2: #f0f3f6;
    --border: #d0d7de; --text: #1f2328; --muted: #656d76;
    --accent: #0969da; --crit: #cf222e; --high: #bc4c00;
    --med: #9a6700; --low: #1a7f37; --info: #0969da;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: var(--bg); color: var(--text); font-size: 13px; display: flex; height: 100vh; overflow: hidden; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Nav Rail ────────────────────────────────────────── */
  .nav-rail { width: 56px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border);
              display: flex; flex-direction: column; transition: width 0.2s; overflow: hidden; z-index: 50;
              flex-shrink: 0; }
  .nav-rail:hover { width: 200px; }
  .nav-brand { padding: 16px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border);
               white-space: nowrap; min-height: 56px; }
  .nav-brand svg { flex-shrink: 0; }
  .nav-brand span { font-weight: 700; font-size: 14px; opacity: 0; transition: opacity 0.2s; }
  .nav-rail:hover .nav-brand span { opacity: 1; }
  .nav-items { flex: 1; padding: 8px 0; }
  .nav-item { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer;
              color: var(--muted); white-space: nowrap; border-left: 3px solid transparent;
              transition: all 0.15s; font-size: 13px; }
  .nav-item:hover { color: var(--text); background: var(--surface2); }
  .nav-item.active { color: var(--accent); border-left-color: var(--accent); background: var(--surface2); }
  .nav-item svg { flex-shrink: 0; width: 20px; height: 20px; }
  .nav-item span { opacity: 0; transition: opacity 0.2s; }
  .nav-rail:hover .nav-item span { opacity: 1; }
  .nav-footer { padding: 12px; border-top: 1px solid var(--border); }

  /* ── Main Layout ────────────────────────────────────── */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  .topbar { display: flex; align-items: center; gap: 16px; padding: 10px 24px;
            background: var(--surface); border-bottom: 1px solid var(--border); min-height: 48px; }
  .topbar h2 { font-size: 16px; font-weight: 600; }
  .topbar select { background: var(--surface2); color: var(--text); border: 1px solid var(--border);
                   border-radius: 6px; padding: 5px 10px; font-size: 13px; }
  .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
  .theme-btn { background: none; border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px;
               color: var(--muted); cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 4px; }
  .theme-btn:hover { color: var(--text); border-color: var(--muted); }
  .content { flex: 1; overflow-y: auto; padding: 24px; }

  /* ── KPI Cards ──────────────────────────────────────── */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
         padding: 16px; text-align: center; }
  .kpi .value { font-size: 28px; font-weight: 700; }
  .kpi .label { font-size: 11px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi.crit .value { color: var(--crit); }
  .kpi.warn .value { color: var(--med); }
  .kpi.good .value { color: var(--low); }
  .kpi.info .value { color: var(--info); }

  /* ── Panels ─────────────────────────────────────────── */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .panel h3 { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 12px;
              text-transform: uppercase; letter-spacing: 0.5px; }
  .panel-full { grid-column: 1 / -1; }

  /* ── Tables ─────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; color: var(--muted); font-weight: 500;
       border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase;
       letter-spacing: 0.3px; cursor: default; white-space: nowrap; }
  th.sortable { cursor: pointer; }
  th.sortable:hover { color: var(--text); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--surface2); }
  tr:hover { background: var(--surface2); }
  tr.clickable { cursor: pointer; }

  /* ── Filters ────────────────────────────────────────── */
  .filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .filters select, .filters input { background: var(--surface2); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  .filters input[type="text"] { width: 200px; }
  .filters input[type="number"] { width: 80px; }

  /* ── Badges ─────────────────────────────────────────── */
  .badge { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge.block { background: #f8514920; color: var(--crit); }
  .badge.quarantine { background: #d2992220; color: var(--med); }
  .badge.allow { background: #3fb95020; color: var(--low); }
  .badge.phishing { background: #f8514920; color: var(--crit); }
  .badge.spam { background: #d2992220; color: var(--med); }
  .badge.ham { background: #3fb95020; color: var(--low); }
  .badge.active { background: #3fb95020; color: var(--low); }
  .badge.trained { background: #58a6ff20; color: var(--info); }
  .badge.retired { background: #7d859020; color: var(--muted); }
  .badge.rolled_back { background: #f8514920; color: var(--crit); }
  .badge.running { background: #d2992220; color: var(--med); }
  .badge.success { background: #3fb95020; color: var(--low); }
  .badge.failed { background: #f8514920; color: var(--crit); }
  .badge.incumbent { background: #3fb95020; color: var(--low); }
  .badge.canary { background: #d2992220; color: var(--med); }

  /* ── Severity colors ────────────────────────────────── */
  .sev-crit { color: var(--crit); font-weight: 600; }
  .sev-high { color: var(--high); font-weight: 500; }
  .sev-med { color: var(--med); }
  .sev-low { color: var(--low); }
  .sev-info { color: var(--info); }

  /* ── Score colors ───────────────────────────────────── */
  .score-high { color: var(--crit); font-weight: 600; }
  .score-med { color: var(--med); }
  .score-low { color: var(--low); }

  /* ── Auth chips ─────────────────────────────────────── */
  .auth-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
               border-radius: 4px; font-size: 11px; font-weight: 600; }
  .auth-chip.pass { background: #3fb95020; color: var(--low); }
  .auth-chip.fail { background: #f8514920; color: var(--crit); }
  .auth-chip.none { background: #7d859020; color: var(--muted); }

  /* ── IOC tags ───────────────────────────────────────── */
  .ioc-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .ioc-tag { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px;
             padding: 2px 8px; font-size: 12px; font-family: monospace; word-break: break-all;
             display: flex; align-items: center; gap: 4px; }
  .ioc-tag .copy-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 0; }
  .ioc-tag .copy-btn:hover { color: var(--text); }

  /* ── Action buttons ─────────────────────────────────── */
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { padding: 6px 14px; font-size: 13px; border: 1px solid var(--border); border-radius: 6px;
         cursor: pointer; background: var(--surface2); color: var(--text); }
  .btn:hover { background: var(--border); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { opacity: 0.9; }
  .btn.danger { border-color: var(--crit); color: var(--crit); }
  .btn.danger:hover { background: #f8514920; }
  .btn.success { border-color: var(--low); color: var(--low); }
  .btn.success:hover { background: #3fb95020; }

  /* ── Detail Drawer ──────────────────────────────────── */
  .drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 90; display: none; }
  .drawer-overlay.open { display: block; }
  .drawer { position: fixed; top: 0; right: -500px; width: 480px; height: 100vh; background: var(--surface);
            border-left: 1px solid var(--border); z-index: 100; overflow-y: auto; transition: right 0.25s;
            display: flex; flex-direction: column; }
  .drawer.open { right: 0; }
  .drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 16px;
                   border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .drawer-close { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 18px; padding: 4px; }
  .drawer-close:hover { color: var(--text); }
  .drawer-body { flex: 1; padding: 16px; overflow-y: auto; }
  .drawer-section { margin-bottom: 16px; }
  .drawer-section h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
                       color: var(--muted); margin-bottom: 8px; }

  /* ── Incident Page ──────────────────────────────────── */
  .incident-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .back-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text);
              border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; display: flex;
              align-items: center; gap: 4px; }
  .back-btn:hover { background: var(--border); }
  .section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
             padding: 16px; margin-bottom: 12px; }
  .section h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
                color: var(--muted); margin-bottom: 10px; }
  .detail-meta { font-size: 13px; color: var(--muted); margin-bottom: 6px; }

  /* ── Attack Chain SVG ───────────────────────────────── */
  .attack-chain { overflow-x: auto; margin: 12px 0; }

  /* ── Pipeline Bar ───────────────────────────────────── */
  .pipeline-bar { display: flex; gap: 16px; font-size: 13px; flex-wrap: wrap; }
  .pipeline-item { color: var(--muted); }
  .pipeline-item span { color: var(--text); font-weight: 500; }

  /* ── Notes form ─────────────────────────────────────── */
  .notes-form { display: flex; gap: 8px; margin-top: 12px; }
  .notes-form input { flex: 1; background: var(--bg); border: 1px solid var(--border);
                      border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 13px; }
  .notes-form button { padding: 6px 14px; background: var(--accent); border: none;
                       border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; }
  .notes-form button:hover { opacity: 0.9; }

  /* ── Feedback ───────────────────────────────────────── */
  .feedback-entry { font-size: 12px; color: var(--muted); padding: 4px 0;
                    border-bottom: 1px solid var(--surface2); }
  .feedback-entry:last-child { border-bottom: none; }

  /* ── Sparkline ──────────────────────────────────────── */
  .sparkline-container { height: 60px; }

  /* ── Toast ──────────────────────────────────────────── */
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px;
           border-radius: 8px; font-size: 13px; display: none; z-index: 200; }
  .toast.success { background: #23863640; border: 1px solid #238636; color: var(--low); }
  .toast.error { background: #f8514930; border: 1px solid var(--crit); color: var(--crit); }

  /* ── Policy Editor ──────────────────────────────────── */
  .threshold-editor { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
  .threshold-editor label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .threshold-editor input { width: 100px; background: var(--bg); border: 1px solid var(--border);
                            border-radius: 6px; padding: 6px 10px; color: var(--text); font-size: 14px; font-weight: 600; }

  /* ── Traffic Split Bar ──────────────────────────────── */
  .traffic-bar { height: 24px; border-radius: 6px; overflow: hidden; display: flex; margin: 8px 0; }
  .traffic-bar .seg { display: flex; align-items: center; justify-content: center;
                      font-size: 11px; font-weight: 600; color: #fff; }

  /* ── Campaign Card ──────────────────────────────────── */
  .campaign-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
                   padding: 16px; margin-bottom: 12px; cursor: pointer; }
  .campaign-card:hover { border-color: var(--accent); }
  .campaign-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .campaign-details { display: none; margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
  .campaign-card.expanded .campaign-details { display: block; }

  /* ── User Card ──────────────────────────────────────── */
  .user-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .user-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
  .user-stats { display: flex; gap: 16px; font-size: 12px; color: var(--muted); }

  /* ── Checkbox ───────────────────────────────────────── */
  .check-cell { width: 32px; }
  input[type="checkbox"] { accent-color: var(--accent); }

  /* ── Bulk bar ───────────────────────────────────────── */
  .bulk-bar { display: none; align-items: center; gap: 12px; padding: 8px 16px;
              background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
              margin-bottom: 12px; }
  .bulk-bar.visible { display: flex; }

  /* ── Responsive ─────────────────────────────────────── */
  .empty { text-align: center; color: var(--muted); padding: 40px; font-size: 14px; }

  @media (max-width: 1024px) {
    .grid-2 { grid-template-columns: 1fr; }
    .grid-3 { grid-template-columns: 1fr; }
  }
  @media (max-width: 768px) {
    .kpis { grid-template-columns: repeat(2, 1fr); }
    .drawer { width: 100vw; }
  }
</style>
</head>
<body>

<!-- Nav Rail -->
<nav class="nav-rail" id="nav-rail">
  <div class="nav-brand">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="6" fill="#58a6ff"/>
      <path d="M7 8h10M7 12h7M7 16h10" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span>ETDP Security</span>
  </div>
  <div class="nav-items">
    <div class="nav-item active" data-view="overview" onclick="navigate('#overview')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm0 6a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zm10 0a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"/></svg>
      <span>Overview</span>
    </div>
    <div class="nav-item" data-view="threats" onclick="navigate('#threats')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
      <span>Threats</span>
    </div>
    <div class="nav-item" data-view="users" onclick="navigate('#users')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zm8 0a3 3 0 11-6 0 3 3 0 016 0zm-4.07 11c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
      <span>Users</span>
    </div>
    <div class="nav-item" data-view="domains" onclick="navigate('#domains')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8a2 2 0 004 0 2 2 0 011.523-1.943A5.977 5.977 0 0116 10c0 .34-.028.675-.083 1H15a2 2 0 00-2 2v2.197A5.973 5.973 0 0110 16v-2a2 2 0 00-2-2 2 2 0 01-2-2 2 2 0 00-1.668-1.973z" clip-rule="evenodd"/></svg>
      <span>Domains</span>
    </div>
    <div class="nav-item" data-view="campaigns" onclick="navigate('#campaigns')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M7 3a1 1 0 000 2h6a1 1 0 100-2H7zM4 7a1 1 0 011-1h10a1 1 0 110 2H5a1 1 0 01-1-1zm-2 4a2 2 0 012-2h12a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4z"/></svg>
      <span>Campaigns</span>
    </div>
    <div class="nav-item" data-view="policies" onclick="navigate('#policies')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
      <span>Policies</span>
    </div>
    <div class="nav-item" data-view="models" onclick="navigate('#models')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path d="M13 7H7v6h6V7z"/><path fill-rule="evenodd" d="M7 2a1 1 0 012 0v1h2V2a1 1 0 112 0v1h2a2 2 0 012 2v2h1a1 1 0 110 2h-1v2h1a1 1 0 110 2h-1v2a2 2 0 01-2 2h-2v1a1 1 0 11-2 0v-1H9v1a1 1 0 11-2 0v-1H5a2 2 0 01-2-2v-2H2a1 1 0 110-2h1V9H2a1 1 0 010-2h1V5a2 2 0 012-2h2V2zM5 5h10v10H5V5z" clip-rule="evenodd"/></svg>
      <span>Models</span>
    </div>
    <div class="nav-item" data-view="health" onclick="window.open('/admin/ui','_blank')">
      <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clip-rule="evenodd"/></svg>
      <span>Health</span>
    </div>
  </div>
</nav>

<!-- Main Content -->
<div class="main">
  <div class="topbar">
    <h2 id="view-title">Executive Overview</h2>
    <select id="org-select"><option value="">Loading orgs...</option></select>
    <div class="topbar-right">
      <button class="theme-btn" id="theme-toggle" onclick="toggleTheme()">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/></svg>
        <span id="theme-label">Light</span>
      </button>
    </div>
  </div>
  <div class="content" id="app">
    <div class="empty">Select an organization to get started.</div>
  </div>
</div>

<!-- Drawer Overlay -->
<div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-header">
    <strong id="drawer-title">Details</strong>
    <button class="drawer-close" onclick="closeDrawer()">&times;</button>
  </div>
  <div class="drawer-body" id="drawer-body"></div>
</div>

<div class="toast" id="toast"></div>

<script>
// ── State ──────────────────────────────────────────────────────────────
let currentOrg = localStorage.getItem("etdp_soc_org") || "";
let currentTheme = localStorage.getItem("etdp_theme") || "dark";
let verdictCache = [];
let selectedRows = new Set();

// ── Apply theme ────────────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.setAttribute("data-theme", currentTheme);
  const label = document.getElementById("theme-label");
  if (label) label.textContent = currentTheme === "dark" ? "Light" : "Dark";
}
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem("etdp_theme", currentTheme);
  applyTheme();
}
applyTheme();

// ── Helpers ────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function ago(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function fmtPct(n) { return (n * 100).toFixed(1) + "%"; }
function fmtNum(n) { return Number(n || 0).toLocaleString(); }

function scoreClass(score) {
  if (score > 3) return "score-high";
  if (score >= 1) return "score-med";
  return "score-low";
}

function sevClass(score) {
  if (score >= 8) return "sev-crit";
  if (score >= 5) return "sev-high";
  if (score >= 2) return "sev-med";
  if (score >= 0.5) return "sev-low";
  return "sev-info";
}

function verdictBadge(v) {
  return '<span class="badge ' + esc(v) + '">' + esc(v) + '</span>';
}

function labelBadge(l) {
  return '<span class="badge ' + esc(l) + '">' + esc(l) + '</span>';
}

function statusBadge(s) {
  return '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>';
}

function showToast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + (type || "success");
  t.style.display = "block";
  setTimeout(() => t.style.display = "none", 4000);
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "HTTP " + res.status);
  }
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "HTTP " + res.status);
  }
  return res.json();
}

// ── IOC Extraction ─────────────────────────────────────────────────────
function extractIOCs(text) {
  const urls = [], domains = [], ips = [], hashes = [];
  if (!text) return { urls, domains, ips, hashes };
  const str = typeof text === "string" ? text : JSON.stringify(text);

  const urlRe = /https?:\\/\\/[^\\s"'<>)\\]]+/gi;
  let m;
  while ((m = urlRe.exec(str)) !== null) { if (!urls.includes(m[0])) urls.push(m[0]); }

  const ipRe = /\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b/g;
  while ((m = ipRe.exec(str)) !== null) { if (!ips.includes(m[0])) ips.push(m[0]); }

  const hashRe = /\\b[a-f0-9]{64}\\b|\\b[a-f0-9]{40}\\b|\\b[a-f0-9]{32}\\b/gi;
  while ((m = hashRe.exec(str)) !== null) { if (!hashes.includes(m[0])) hashes.push(m[0]); }

  for (const u of urls) {
    try { const host = new URL(u).hostname; if (!domains.includes(host)) domains.push(host); } catch {}
  }
  const domRe = /\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:com|net|org|io|top|xyz|info|biz|ru|cn|tk|ml|ga|cf|gq)\\b/gi;
  while ((m = domRe.exec(str)) !== null) { if (!domains.includes(m[0])) domains.push(m[0]); }

  return { urls, domains, ips, hashes };
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast("Copied!", "success")).catch(() => {});
}

// ── SVG Charts ─────────────────────────────────────────────────────────
function drawDonut(data, size) {
  size = size || 160;
  const total = data.reduce((a, d) => a + d.value, 0);
  if (total === 0) return '<div class="empty">No data</div>';
  const cx = size / 2, cy = size / 2, r = size * 0.4, inner = size * 0.25;
  let startAngle = -Math.PI / 2, paths = "";

  for (const d of data) {
    if (d.value === 0) continue;
    const pct = d.value / total;
    const endAngle = startAngle + pct * 2 * Math.PI;
    const largeArc = pct > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + inner * Math.cos(endAngle), iy1 = cy + inner * Math.sin(endAngle);
    const ix2 = cx + inner * Math.cos(startAngle), iy2 = cy + inner * Math.sin(startAngle);
    paths += '<path d="M' + x1.toFixed(2) + ',' + y1.toFixed(2) +
      ' A' + r + ',' + r + ' 0 ' + largeArc + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) +
      ' L' + ix1.toFixed(2) + ',' + iy1.toFixed(2) +
      ' A' + inner + ',' + inner + ' 0 ' + largeArc + ' 0 ' + ix2.toFixed(2) + ',' + iy2.toFixed(2) +
      ' Z" fill="' + d.color + '"><title>' + esc(d.label) + ': ' + d.value + '</title></path>';
    startAngle = endAngle;
  }

  const legend = data.map(d =>
    '<div style="display:flex;align-items:center;gap:6px;font-size:11px;">' +
    '<span style="width:8px;height:8px;border-radius:2px;background:' + d.color + ';display:inline-block;flex-shrink:0;"></span>' +
    esc(d.label) + ': ' + d.value + ' (' + (total ? Math.round(d.value / total * 100) : 0) + '%)' +
    '</div>'
  ).join("");

  return '<div style="display:flex;align-items:center;gap:20px;">' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' + paths +
    '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" fill="var(--text)" font-size="20" font-weight="700">' + total + '</text>' +
    '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" fill="var(--muted)" font-size="10">total</text>' +
    '</svg><div style="display:flex;flex-direction:column;gap:4px;">' + legend + '</div></div>';
}

function drawSparkline(points, width, height, color) {
  if (!points || points.length === 0) return '';
  width = width || 300; height = height || 50;
  const max = Math.max(...points.map(p => p.value), 1);
  const stepX = width / Math.max(points.length - 1, 1);
  let pathD = "";
  let areaD = "";
  points.forEach((p, i) => {
    const x = i * stepX;
    const y = height - (p.value / max * (height - 4)) - 2;
    pathD += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    areaD += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
  });
  areaD += " L" + ((points.length - 1) * stepX).toFixed(1) + "," + height + " L0," + height + " Z";

  return '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
    '<path d="' + areaD + '" fill="' + color + '" opacity="0.15"/>' +
    '<path d="' + pathD + '" fill="none" stroke="' + color + '" stroke-width="2"/>' +
    '</svg>';
}

function drawHBar(items, maxVal) {
  if (!items || items.length === 0) return '<div class="empty">No data</div>';
  maxVal = maxVal || Math.max(...items.map(i => i.value), 1);
  return items.map(i => {
    const pct = (i.value / maxVal * 100).toFixed(0);
    return '<div style="margin-bottom:6px;">' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px;">' +
      '<span>' + esc(i.label) + '</span><span style="color:var(--muted);">' + i.value + '</span></div>' +
      '<div style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;">' +
      '<div style="width:' + pct + '%;height:100%;background:' + (i.color || 'var(--accent)') + ';border-radius:3px;"></div>' +
      '</div></div>';
  }).join("");
}

function drawAttackChain(signals, verdict) {
  const engines = {};
  for (const s of (signals || [])) {
    if (!engines[s.engine]) engines[s.engine] = { count: 0, maxScore: 0 };
    engines[s.engine].count++;
    engines[s.engine].maxScore = Math.max(engines[s.engine].maxScore, s.score || 0);
  }
  const engineNames = Object.keys(engines);
  const boxW = 100, boxH = 50, gap = 16, arrowW = 24;
  const totalW = 80 + engineNames.length * (boxW + gap + arrowW) + 80 + boxW;

  let svg = '<svg width="' + totalW + '" height="80" viewBox="0 0 ' + totalW + ' 80">';
  // Email box
  let x = 0;
  svg += '<rect x="' + x + '" y="15" width="70" height="' + boxH + '" rx="6" fill="var(--surface2)" stroke="var(--border)"/>';
  svg += '<text x="35" y="44" text-anchor="middle" fill="var(--text)" font-size="11">Email</text>';
  x += 80;

  for (const name of engineNames) {
    const e = engines[name];
    const col = e.maxScore >= 3 ? 'var(--crit)' : e.maxScore >= 1 ? 'var(--med)' : 'var(--low)';
    // Arrow
    svg += '<line x1="' + (x - 10) + '" y1="40" x2="' + x + '" y2="40" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#arrowhead)"/>';
    // Box
    svg += '<rect x="' + x + '" y="15" width="' + boxW + '" height="' + boxH + '" rx="6" fill="var(--surface2)" stroke="' + col + '"/>';
    svg += '<text x="' + (x + boxW / 2) + '" y="36" text-anchor="middle" fill="var(--text)" font-size="10">' + esc(name.replace(/^e\\d+_/, '')) + '</text>';
    svg += '<text x="' + (x + boxW / 2) + '" y="52" text-anchor="middle" fill="' + col + '" font-size="10" font-weight="600">' + e.count + ' signals</text>';
    x += boxW + gap + arrowW;
  }

  // Arrow to verdict
  svg += '<line x1="' + (x - 10) + '" y1="40" x2="' + x + '" y2="40" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#arrowhead)"/>';
  const vCol = verdict === 'block' ? 'var(--crit)' : verdict === 'quarantine' ? 'var(--med)' : 'var(--low)';
  svg += '<rect x="' + x + '" y="15" width="' + boxW + '" height="' + boxH + '" rx="6" fill="var(--surface2)" stroke="' + vCol + '"/>';
  svg += '<text x="' + (x + boxW / 2) + '" y="44" text-anchor="middle" fill="' + vCol + '" font-size="12" font-weight="700">' + esc((verdict || '').toUpperCase()) + '</text>';

  svg += '<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">' +
    '<polygon points="0 0, 8 3, 0 6" fill="var(--muted)"/></marker></defs>';
  svg += '</svg>';
  return svg;
}

// ── Drawer ─────────────────────────────────────────────────────────────
function openDrawer(title, html) {
  document.getElementById("drawer-title").textContent = title;
  document.getElementById("drawer-body").innerHTML = html;
  document.getElementById("drawer-overlay").classList.add("open");
  document.getElementById("drawer").classList.add("open");
}

function closeDrawer() {
  document.getElementById("drawer-overlay").classList.remove("open");
  document.getElementById("drawer").classList.remove("open");
}

// ── Auth signal extraction ─────────────────────────────────────────────
function extractAuth(signals) {
  const auth = { spf: "none", dkim: "none", dmarc: "none" };
  for (const s of (signals || [])) {
    if (s.engine !== "e1_rspamd") continue;
    const sig = (s.signal || "").toLowerCase();
    const det = typeof s.detail === "string" ? s.detail.toLowerCase() : JSON.stringify(s.detail || "").toLowerCase();
    if (sig.includes("spf")) auth.spf = det.includes("pass") ? "pass" : det.includes("fail") ? "fail" : "none";
    if (sig.includes("dkim")) auth.dkim = det.includes("pass") ? "pass" : det.includes("fail") ? "fail" : "none";
    if (sig.includes("dmarc")) auth.dmarc = det.includes("pass") ? "pass" : det.includes("fail") ? "fail" : "none";
  }
  return auth;
}

function renderAuthChips(auth) {
  return ['SPF', 'DKIM', 'DMARC'].map(name => {
    const v = auth[name.toLowerCase()];
    return '<span class="auth-chip ' + v + '">' + name + ': ' + v.toUpperCase() + '</span>';
  }).join(' ');
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 1: Executive Overview (#overview)
// ═══════════════════════════════════════════════════════════════════════
async function renderOverview() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization to get started.</div>'; return; }
  document.getElementById("app").innerHTML = '<div class="empty">Loading...</div>';

  try {
    const [stats, recent, timeline, topSenders] = await Promise.all([
      api("/v1/stats?org_id=" + encodeURIComponent(currentOrg)),
      api("/v1/verdicts?org_id=" + encodeURIComponent(currentOrg) + "&limit=10"),
      api("/v1/dashboard/timeline?org_id=" + encodeURIComponent(currentOrg) + "&days=7").catch(() => ({ points: [] })),
      api("/v1/dashboard/top-senders?org_id=" + encodeURIComponent(currentOrg) + "&limit=5").catch(() => ({ senders: [] })),
    ]);

    const breakdown = stats.breakdown || [];
    let totalN = 0, blocked = 0, quarantined = 0, allowed = 0, phishCount = 0, becCount = 0;
    const labelCounts = {};
    let totalConf = 0;
    for (const r of breakdown) {
      const n = Number(r.n);
      totalN += n;
      if (r.verdict === "block") blocked += n;
      else if (r.verdict === "quarantine") quarantined += n;
      else allowed += n;
      labelCounts[r.label] = (labelCounts[r.label] || 0) + n;
      if (r.label === "phishing") phishCount += n;
    }
    const avgConf = totalN > 0 ? "—" : "—";

    // FP rate placeholder (would need feedback data)
    const fpRate = "—";

    const donutData = [
      { label: "Phishing", value: labelCounts["phishing"] || 0, color: "#f85149" },
      { label: "Spam", value: labelCounts["spam"] || 0, color: "#d29922" },
      { label: "Ham", value: labelCounts["ham"] || 0, color: "#3fb950" },
    ];

    const labelBarData = Object.entries(labelCounts).map(([k, v]) => ({
      label: k, value: v,
      color: k === "phishing" ? "#f85149" : k === "spam" ? "#d29922" : "#3fb950"
    }));

    const sparkline = drawSparkline(timeline.points || [], 280, 50, "#58a6ff");

    const senderRows = (topSenders.senders || []).map(s =>
      '<tr><td>' + esc(s.sender) + '</td><td>' + esc(s.sender_domain || "") + '</td>' +
      '<td class="' + sevClass(s.avg_score || 0) + '">' + Number(s.avg_score || 0).toFixed(1) + '</td>' +
      '<td>' + s.count + '</td></tr>'
    ).join("");

    const criticalRows = (recent.verdicts || []).filter(v => v.threat_score > 10).slice(0, 5);
    const recentRows = (recent.verdicts || []).map(v =>
      '<tr class="clickable" onclick="navigate(\\'#incident/' +
        encodeURIComponent(v.org_id) + '/' + encodeURIComponent(v.message_id) + '\\')">' +
      '<td>' + esc(v.sender) + '</td><td>' + labelBadge(v.label) + '</td>' +
      '<td>' + verdictBadge(v.verdict) + '</td>' +
      '<td class="' + scoreClass(v.threat_score) + '">' + Number(v.threat_score).toFixed(1) + '</td>' +
      '<td>' + esc(ago(v.created_at)) + '</td></tr>'
    ).join("");

    document.getElementById("app").innerHTML =
      '<div class="kpis">' +
        '<div class="kpi info"><div class="value">' + fmtNum(totalN) + '</div><div class="label">Total Analyzed</div></div>' +
        '<div class="kpi crit"><div class="value">' + fmtNum(blocked) + '</div><div class="label">Blocked</div></div>' +
        '<div class="kpi warn"><div class="value">' + fmtNum(quarantined) + '</div><div class="label">Quarantined</div></div>' +
        '<div class="kpi good"><div class="value">' + fmtNum(allowed) + '</div><div class="label">Allowed</div></div>' +
        '<div class="kpi crit"><div class="value">' + fmtNum(phishCount) + '</div><div class="label">Phishing</div></div>' +
        '<div class="kpi warn"><div class="value">' + fmtNum(labelCounts["spam"] || 0) + '</div><div class="label">Spam</div></div>' +
        '<div class="kpi info"><div class="value">' + avgConf + '</div><div class="label">Avg Confidence</div></div>' +
        '<div class="kpi"><div class="value">' + fpRate + '</div><div class="label">FP Rate</div></div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="panel"><h3>7-Day Threat Volume</h3><div class="sparkline-container">' + sparkline + '</div></div>' +
        '<div class="panel"><h3>Verdict Breakdown</h3>' + drawDonut(donutData) + '</div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="panel"><h3>Label Distribution</h3>' + drawHBar(labelBarData) + '</div>' +
        '<div class="panel"><h3>Top Malicious Senders</h3>' +
          (senderRows ? '<table><thead><tr><th>Sender</th><th>Domain</th><th>Avg Score</th><th>Count</th></tr></thead><tbody>' + senderRows + '</tbody></table>'
           : '<div class="empty">No data</div>') +
        '</div>' +
      '</div>' +
      '<div class="panel"><h3>Recent Threats</h3>' +
        (recentRows ? '<table><thead><tr><th>Sender</th><th>Label</th><th>Verdict</th><th>Score</th><th>Time</th></tr></thead><tbody>' + recentRows + '</tbody></table>'
         : '<div class="empty">No recent verdicts</div>') +
      '</div>';
  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error loading data: ' + esc(e.message) + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 2: Threat Detection Center (#threats)
// ═══════════════════════════════════════════════════════════════════════
async function renderThreats() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization.</div>'; return; }

  document.getElementById("app").innerHTML =
    '<div class="filters" id="threat-filters">' +
      '<select id="tf-label"><option value="">All Labels</option>' +
        '<option value="ham">Ham</option><option value="spam">Spam</option><option value="phishing">Phishing</option></select>' +
      '<select id="tf-verdict"><option value="">All Verdicts</option>' +
        '<option value="allow">Allow</option><option value="quarantine">Quarantine</option><option value="block">Block</option></select>' +
      '<input type="date" id="tf-since">' +
      '<input type="text" id="tf-search" placeholder="Search sender/recipient...">' +
      '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);">Score &ge; <input type="number" id="tf-score" min="0" step="0.5" value="0" style="width:60px;"></label>' +
    '</div>' +
    '<div class="bulk-bar" id="bulk-bar">' +
      '<span id="bulk-count">0 selected</span>' +
      '<button class="btn danger" onclick="bulkAction(\\'confirm_block\\')">Block</button>' +
      '<button class="btn" onclick="bulkAction(\\'quarantine\\')">Quarantine</button>' +
      '<button class="btn success" onclick="bulkAction(\\'release\\')">Release</button>' +
      '<button class="btn" onclick="bulkAction(\\'ham\\')">Mark Ham</button>' +
    '</div>' +
    '<div id="threat-table-wrap"><div class="empty">Loading...</div></div>';

  document.getElementById("tf-label").onchange = () => loadThreats();
  document.getElementById("tf-verdict").onchange = () => loadThreats();
  document.getElementById("tf-since").onchange = () => loadThreats();
  document.getElementById("tf-score").onchange = () => loadThreats();
  let searchTimeout;
  document.getElementById("tf-search").oninput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadThreats(), 300);
  };
  loadThreats();
}

async function loadThreats() {
  const labelEl = document.getElementById("tf-label");
  const verdictEl = document.getElementById("tf-verdict");
  const sinceEl = document.getElementById("tf-since");
  const searchEl = document.getElementById("tf-search");
  const scoreEl = document.getElementById("tf-score");

  let url = "/v1/verdicts?org_id=" + encodeURIComponent(currentOrg) + "&limit=200";
  if (labelEl && labelEl.value) url += "&label=" + encodeURIComponent(labelEl.value);
  if (verdictEl && verdictEl.value) url += "&verdict=" + encodeURIComponent(verdictEl.value);
  if (sinceEl && sinceEl.value) url += "&since=" + encodeURIComponent(sinceEl.value);

  try {
    const data = await api(url);
    let rows = data.verdicts || [];
    const search = searchEl ? searchEl.value.toLowerCase() : "";
    const minScore = scoreEl ? Number(scoreEl.value) || 0 : 0;

    if (search) {
      rows = rows.filter(v => (v.sender || "").toLowerCase().includes(search) ||
                               (v.recipient || "").toLowerCase().includes(search) ||
                               (v.message_id || "").toLowerCase().includes(search));
    }
    if (minScore > 0) {
      rows = rows.filter(v => Number(v.threat_score) >= minScore);
    }

    verdictCache = rows;
    selectedRows.clear();
    updateBulkBar();

    const wrap = document.getElementById("threat-table-wrap");
    if (!wrap) return;

    if (rows.length === 0) {
      wrap.innerHTML = '<div class="empty">No verdicts found.</div>';
      return;
    }

    const tbody = rows.map((v, i) =>
      '<tr class="clickable">' +
      '<td class="check-cell"><input type="checkbox" data-idx="' + i + '" onclick="toggleRow(event,' + i + ')"></td>' +
      '<td onclick="openThreatDrawer(' + i + ')">' + esc(ago(v.created_at)) + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')">' + esc(v.sender) + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')">' + esc(v.recipient) + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')">' + labelBadge(v.label) + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')">' + verdictBadge(v.verdict) + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')" class="' + scoreClass(v.threat_score) + '">' + Number(v.threat_score).toFixed(1) + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')" style="color:var(--muted);">' + (v.confidence ? fmtPct(v.confidence) : '—') + '</td>' +
      '<td onclick="openThreatDrawer(' + i + ')" style="color:var(--muted);">' + (v.fast_path_ms != null ? Number(v.fast_path_ms).toFixed(0) + 'ms' : '—') + '</td>' +
      '</tr>'
    ).join("");

    wrap.innerHTML = '<table><thead><tr>' +
      '<th class="check-cell"><input type="checkbox" onclick="toggleAllRows(this)"></th>' +
      '<th>Time</th><th>Sender</th><th>Recipient</th><th>Label</th><th>Verdict</th><th>Score</th><th>Confidence</th><th>Speed</th>' +
      '</tr></thead><tbody>' + tbody + '</tbody></table>';
  } catch (e) {
    const wrap = document.getElementById("threat-table-wrap");
    if (wrap) wrap.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

function toggleRow(e, idx) {
  e.stopPropagation();
  if (selectedRows.has(idx)) selectedRows.delete(idx);
  else selectedRows.add(idx);
  updateBulkBar();
}

function toggleAllRows(el) {
  if (el.checked) { verdictCache.forEach((_, i) => selectedRows.add(i)); }
  else { selectedRows.clear(); }
  document.querySelectorAll('#threat-table-wrap input[type="checkbox"][data-idx]').forEach(cb => {
    cb.checked = el.checked;
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById("bulk-bar");
  const count = document.getElementById("bulk-count");
  if (!bar) return;
  if (selectedRows.size > 0) {
    bar.classList.add("visible");
    count.textContent = selectedRows.size + " selected";
  } else {
    bar.classList.remove("visible");
  }
}

async function bulkAction(action) {
  for (const idx of selectedRows) {
    const v = verdictCache[idx];
    if (!v) continue;
    try {
      await apiPost("/v1/feedback", {
        org_id: v.org_id, message_id: v.message_id,
        action: action, source: "soc_dashboard"
      });
    } catch {}
  }
  showToast("Applied " + action + " to " + selectedRows.size + " emails", "success");
  selectedRows.clear();
  updateBulkBar();
  loadThreats();
}

function openThreatDrawer(idx) {
  const v = verdictCache[idx];
  if (!v) return;

  // Fetch full detail for drawer
  api("/v1/verdicts/" + encodeURIComponent(v.org_id) + "/" + encodeURIComponent(v.message_id))
    .then(data => {
      const d = data.verdict;
      const feedback = data.feedback || [];
      const signals = (typeof d.signals === "string" ? JSON.parse(d.signals) : d.signals) || [];
      const pipeline = (typeof d.pipeline === "string" ? JSON.parse(d.pipeline) : d.pipeline) || {};
      signals.sort((a, b) => (b.score || 0) - (a.score || 0));

      const auth = extractAuth(signals);
      let iocSource = d.reason || "";
      for (const s of signals) { if (s.detail) iocSource += " " + (typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)); }
      const iocs = extractIOCs(iocSource);

      const signalRows = signals.map(s => {
        const sev = s.score >= 5 ? "sev-crit" : s.score >= 3 ? "sev-high" : s.score >= 1 ? "sev-med" : "sev-low";
        return '<tr><td>' + esc(s.engine) + '</td><td>' + esc(s.signal) + '</td>' +
          '<td class="' + sev + '">' + Number(s.score || 0).toFixed(1) + '</td>' +
          '<td style="font-size:11px;color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;">' +
          esc(typeof s.detail === "object" ? JSON.stringify(s.detail) : s.detail) + '</td></tr>';
      }).join("");

      const hasIOCs = iocs.urls.length || iocs.domains.length || iocs.ips.length || iocs.hashes.length;

      let html = '<div class="drawer-section">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
        verdictBadge(d.verdict) + ' ' + labelBadge(d.label) + '</div>' +
        '<div class="detail-meta">Message: <code style="font-size:11px;">' + esc(d.message_id) + '</code></div>' +
        '<div class="detail-meta">From: <strong>' + esc(d.sender) + '</strong> &rarr; ' + esc(d.recipient) + '</div>' +
        '<div class="detail-meta">Score: <span class="' + scoreClass(d.threat_score) + '">' + Number(d.threat_score).toFixed(1) + '</span>' +
        '  |  Confidence: ' + (d.confidence ? fmtPct(d.confidence) : '—') +
        '  |  ' + fmtDate(d.created_at) + '</div>' +
        '</div>';

      // Auth
      html += '<div class="drawer-section"><h4>Authentication</h4>' + renderAuthChips(auth) + '</div>';

      // Signals
      html += '<div class="drawer-section"><h4>Signals (' + signals.length + ')</h4>' +
        (signals.length ? '<table><thead><tr><th>Engine</th><th>Signal</th><th>Score</th><th>Detail</th></tr></thead><tbody>' + signalRows + '</tbody></table>' : '<div class="empty">No signals</div>') +
        '</div>';

      // IOCs
      if (hasIOCs) {
        html += '<div class="drawer-section"><h4>IOCs</h4>';
        if (iocs.urls.length) html += '<div style="margin-bottom:4px;"><strong style="font-size:11px;color:var(--muted);">URLs:</strong><div class="ioc-list">' + iocs.urls.map(u => '<span class="ioc-tag">' + esc(u) + ' <button class="copy-btn" onclick="copyToClipboard(\\''+esc(u)+'\\')">copy</button></span>').join("") + '</div></div>';
        if (iocs.domains.length) html += '<div style="margin-bottom:4px;"><strong style="font-size:11px;color:var(--muted);">Domains:</strong><div class="ioc-list">' + iocs.domains.map(d => '<span class="ioc-tag">' + esc(d) + '</span>').join("") + '</div></div>';
        if (iocs.ips.length) html += '<div style="margin-bottom:4px;"><strong style="font-size:11px;color:var(--muted);">IPs:</strong><div class="ioc-list">' + iocs.ips.map(ip => '<span class="ioc-tag">' + esc(ip) + '</span>').join("") + '</div></div>';
        if (iocs.hashes.length) html += '<div style="margin-bottom:4px;"><strong style="font-size:11px;color:var(--muted);">Hashes:</strong><div class="ioc-list">' + iocs.hashes.map(h => '<span class="ioc-tag">' + esc(h) + ' <button class="copy-btn" onclick="copyToClipboard(\\''+esc(h)+'\\')">copy</button></span>').join("") + '</div></div>';
        html += '</div>';
      }

      // Pipeline
      html += '<div class="drawer-section"><h4>Pipeline</h4><div class="pipeline-bar">' +
        '<div class="pipeline-item">Fast: <span>' + (pipeline.fast_path_ms != null ? Number(pipeline.fast_path_ms).toFixed(0) + 'ms' : '—') + '</span></div>' +
        '<div class="pipeline-item">Deep: <span>' + (pipeline.deep_path_ms != null ? Number(pipeline.deep_path_ms).toFixed(0) + 'ms' : '—') + '</span></div>' +
        '<div class="pipeline-item">Engines: <span>' + esc((pipeline.engines_invoked || []).join(", ")) + '</span></div>' +
        '</div></div>';

      // Actions
      html += '<div class="drawer-section"><h4>Actions</h4><div class="actions">' +
        '<button class="btn success" onclick="drawerFeedback(\\'release\\',\\'' + esc(d.org_id) + '\\',\\'' + esc(d.message_id) + '\\')">Release</button>' +
        '<button class="btn danger" onclick="drawerFeedback(\\'confirm_block\\',\\'' + esc(d.org_id) + '\\',\\'' + esc(d.message_id) + '\\')">Confirm Block</button>' +
        '<button class="btn" onclick="drawerFeedback(\\'ham\\',\\'' + esc(d.org_id) + '\\',\\'' + esc(d.message_id) + '\\')">Mark Ham</button>' +
        '<button class="btn" onclick="drawerFeedback(\\'spam\\',\\'' + esc(d.org_id) + '\\',\\'' + esc(d.message_id) + '\\')">Mark Spam</button>' +
        '<button class="btn" onclick="drawerFeedback(\\'phishing\\',\\'' + esc(d.org_id) + '\\',\\'' + esc(d.message_id) + '\\')">Mark Phishing</button>' +
        '</div></div>';

      // Open full investigation link
      html += '<div class="drawer-section" style="text-align:center;">' +
        '<a href="#incident/' + encodeURIComponent(d.org_id) + '/' + encodeURIComponent(d.message_id) + '" ' +
        'onclick="closeDrawer()" style="font-size:13px;">Open Full Investigation &rarr;</a></div>';

      // Feedback history
      if (feedback.length > 0) {
        html += '<div class="drawer-section"><h4>Feedback History</h4>' +
          feedback.map(f => '<div class="feedback-entry"><strong>' + esc(f.source) + '</strong> — ' + esc(f.action) +
            (f.notes ? ' — "' + esc(f.notes) + '"' : '') + ' — ' + esc(ago(f.created_at)) + '</div>').join("") +
          '</div>';
      }

      openDrawer("Threat Detail", html);
    })
    .catch(e => openDrawer("Error", '<div class="empty">' + esc(e.message) + '</div>'));
}

async function drawerFeedback(action, orgId, messageId) {
  try {
    await apiPost("/v1/feedback", { org_id: orgId, message_id: messageId, action, source: "soc_dashboard" });
    showToast("Feedback recorded: " + action, "success");
    closeDrawer();
    loadThreats();
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 3: Incident Investigation (#incident/:org/:msg)
// ═══════════════════════════════════════════════════════════════════════
async function renderIncident(orgId, messageId) {
  document.getElementById("app").innerHTML = '<div class="empty">Loading investigation...</div>';

  try {
    const data = await api("/v1/verdicts/" + encodeURIComponent(orgId) + "/" + encodeURIComponent(messageId));
    const v = data.verdict;
    const feedback = data.feedback || [];
    const signals = (typeof v.signals === "string" ? JSON.parse(v.signals) : v.signals) || [];
    const pipeline = (typeof v.pipeline === "string" ? JSON.parse(v.pipeline) : v.pipeline) || {};
    signals.sort((a, b) => (b.score || 0) - (a.score || 0));

    const auth = extractAuth(signals);
    let iocSource = v.reason || "";
    for (const s of signals) { if (s.detail) iocSource += " " + (typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)); }
    const iocs = extractIOCs(iocSource);
    const hasIOCs = iocs.urls.length || iocs.domains.length || iocs.ips.length || iocs.hashes.length;

    // Threat narrative
    const topSignals = signals.slice(0, 3).map(s => s.signal).join(", ");
    const narrative = "This email from <strong>" + esc(v.sender) + "</strong> to <strong>" + esc(v.recipient) +
      "</strong> was classified as <strong>" + esc(v.label) + "</strong> with verdict <strong>" + esc(v.verdict) +
      "</strong> (score: " + Number(v.threat_score).toFixed(1) + "). " +
      (topSignals ? "Key signals: " + esc(topSignals) + ". " : "") +
      (v.reason ? esc(v.reason) : "");

    // Signal table
    const signalRows = signals.map(s => {
      const sev = s.score >= 5 ? "sev-crit" : s.score >= 3 ? "sev-high" : s.score >= 1 ? "sev-med" : "sev-low";
      return '<tr>' +
        '<td>' + esc(s.engine) + '</td>' +
        '<td>' + esc(s.signal) + '</td>' +
        '<td class="' + sev + '">' + Number(s.score || 0).toFixed(1) + '</td>' +
        '<td style="font-size:12px;color:var(--muted);">' + esc(typeof s.detail === "object" ? JSON.stringify(s.detail) : s.detail) + '</td>' +
        '</tr>';
    }).join("");

    // IOC rendering with copy
    function iocSection(label, items) {
      if (!items || items.length === 0) return "";
      return '<div style="margin-bottom:8px;"><strong style="font-size:11px;color:var(--muted);">' + esc(label) + ':</strong>' +
        '<div class="ioc-list" style="margin-top:4px;">' +
        items.map(i => '<span class="ioc-tag">' + esc(i) + ' <button class="copy-btn" onclick="copyToClipboard(\\'' + esc(i).replace(/'/g, "\\\\'") + '\\')">copy</button></span>').join("") +
        '</div></div>';
    }

    // Feedback history
    const feedbackHtml = feedback.length === 0
      ? '<div style="color:var(--muted);font-size:12px;">No feedback yet.</div>'
      : feedback.map(f =>
          '<div class="feedback-entry"><strong>' + esc(f.source) + '</strong> — ' + esc(f.action) +
          (f.notes ? ' — "' + esc(f.notes) + '"' : '') + ' — ' + esc(ago(f.created_at)) + '</div>'
        ).join("");

    window._detailCtx = { org_id: orgId, message_id: messageId };

    document.getElementById("app").innerHTML =
      // Header
      '<div class="incident-header">' +
        '<button class="back-btn" onclick="history.back()">&larr; Back</button>' +
        verdictBadge(v.verdict) + ' ' + labelBadge(v.label) +
        '<code style="font-size:11px;color:var(--muted);">' + esc(v.message_id) + '</code>' +
      '</div>' +

      // Narrative
      '<div class="section"><h4>Threat Narrative</h4><div style="font-size:13px;line-height:1.6;">' + narrative + '</div></div>' +

      // Attack chain
      '<div class="section"><h4>Attack Chain</h4><div class="attack-chain">' + drawAttackChain(signals, v.verdict) + '</div></div>' +

      // Meta
      '<div class="section">' +
        '<div class="detail-meta">From: <strong>' + esc(v.sender) + '</strong> &rarr; ' + esc(v.recipient) + '</div>' +
        '<div class="detail-meta">Score: <span class="' + scoreClass(v.threat_score) + '">' + Number(v.threat_score).toFixed(1) + '</span>' +
        '  |  Confidence: ' + (v.confidence ? fmtPct(v.confidence) : '—') +
        '  |  ' + fmtDate(v.created_at) + '</div>' +
      '</div>' +

      // Auth
      '<div class="section"><h4>Authentication Results</h4>' + renderAuthChips(auth) + '</div>' +

      // Signals
      '<div class="section"><h4>Signals (' + signals.length + ')</h4>' +
        (signals.length === 0 ? '<div class="empty">No signals recorded.</div>'
         : '<table><thead><tr><th>Engine</th><th>Signal</th><th>Score</th><th>Detail</th></tr></thead><tbody>' + signalRows + '</tbody></table>') +
      '</div>' +

      // IOCs
      (hasIOCs ? '<div class="section"><h4>Indicators of Compromise</h4>' +
        iocSection("URLs", iocs.urls) + iocSection("Domains", iocs.domains) +
        iocSection("IPs", iocs.ips) + iocSection("Hashes", iocs.hashes) +
      '</div>' : '') +

      // Pipeline
      '<div class="section"><h4>Pipeline Timing</h4><div class="pipeline-bar">' +
        '<div class="pipeline-item">Fast Path: <span>' + (pipeline.fast_path_ms != null ? Number(pipeline.fast_path_ms).toFixed(0) + 'ms' : '—') + '</span></div>' +
        '<div class="pipeline-item">Deep Path: <span>' + (pipeline.deep_path_ms != null ? Number(pipeline.deep_path_ms).toFixed(0) + 'ms' : '—') + '</span></div>' +
        '<div class="pipeline-item">Engines Invoked: <span>' + esc((pipeline.engines_invoked || []).join(", ")) + '</span></div>' +
        (pipeline.async_deep_path ? '<div class="pipeline-item" style="color:var(--med);">Async deep path</div>' : '') +
      '</div></div>' +

      // Related (link)
      '<div class="section"><h4>Related Messages</h4>' +
        '<a href="#threats" onclick="setTimeout(function(){var el=document.getElementById(\\'tf-search\\');if(el){el.value=\\'' + esc(v.sender ? v.sender.split('@')[1] || '' : '') + '\\';el.dispatchEvent(new Event(\\'input\\'));}},100);">' +
        'View emails from ' + esc(v.sender ? v.sender.split('@')[1] || v.sender : '') + ' &rarr;</a></div>' +

      // Actions
      '<div class="section"><h4>Actions</h4><div class="actions">' +
        '<button class="btn success" onclick="submitFeedback(\\'release\\')">Release</button>' +
        '<button class="btn danger" onclick="submitFeedback(\\'confirm_block\\')">Confirm Block</button>' +
        '<button class="btn" onclick="submitFeedback(\\'ham\\')">Mark Ham</button>' +
        '<button class="btn" onclick="submitFeedback(\\'phishing\\')">Mark Phishing</button>' +
        '<button class="btn" onclick="submitFeedback(\\'spam\\')">Mark Spam</button>' +
      '</div>' +
      '<div class="notes-form">' +
        '<input type="text" id="feedback-notes" placeholder="Add investigation notes...">' +
        '<button onclick="submitFeedbackWithNotes()">Submit Note</button>' +
      '</div></div>' +

      // Feedback timeline
      '<div class="section"><h4>Feedback Timeline</h4><div id="feedback-history">' + feedbackHtml + '</div></div>';

  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error loading investigation: ' + esc(e.message) + '</div>';
  }
}

// ── Feedback Submission ────────────────────────────────────────────────
async function submitFeedback(action) {
  const ctx = window._detailCtx;
  if (!ctx) return;
  const notes = document.getElementById("feedback-notes");
  try {
    await apiPost("/v1/feedback", {
      org_id: ctx.org_id, message_id: ctx.message_id,
      action, source: "soc_dashboard",
      notes: notes ? notes.value || null : null,
    });
    showToast("Feedback recorded: " + action, "success");
    if (notes) notes.value = "";
    renderIncident(ctx.org_id, ctx.message_id);
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

function submitFeedbackWithNotes() {
  const notes = document.getElementById("feedback-notes");
  if (!notes || !notes.value.trim()) { showToast("Please enter a note first", "error"); return; }
  submitFeedback("confirm_block");
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 4: User Risk Dashboard (#users)
// ═══════════════════════════════════════════════════════════════════════
async function renderUsers() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization.</div>'; return; }
  document.getElementById("app").innerHTML = '<div class="empty">Loading users...</div>';

  try {
    const [users, vips] = await Promise.all([
      api("/v1/dashboard/users?org_id=" + encodeURIComponent(currentOrg)).catch(() => ({ users: [] })),
      api("/v1/dashboard/vips?org_id=" + encodeURIComponent(currentOrg)).catch(() => ({ vips: [] })),
    ]);

    const userList = users.users || [];
    const vipList = vips.vips || [];

    let html = '';

    // VIP section
    if (vipList.length > 0) {
      html += '<div class="panel" style="margin-bottom:16px;"><h3>VIP Users</h3>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">' +
        vipList.map(u =>
          '<div class="user-card">' +
            '<div class="user-card-header"><strong>' + esc(u.address || u.email) + '</strong>' +
            (u.trust_score != null ? '<span class="badge ' + (u.trust_score > 0.7 ? 'allow' : u.trust_score > 0.4 ? 'quarantine' : 'block') + '">Trust: ' + Number(u.trust_score).toFixed(2) + '</span>' : '') +
            '</div>' +
            (u.display_name ? '<div style="font-size:12px;color:var(--muted);margin-bottom:4px;">' + esc(u.display_name) + '</div>' : '') +
            '<div class="user-stats">' +
              (u.sent_count != null ? '<span>Sent: ' + u.sent_count + '</span>' : '') +
              (u.recv_count != null ? '<span>Recv: ' + u.recv_count + '</span>' : '') +
              (u.threat_count != null ? '<span style="color:var(--crit);">Threats: ' + u.threat_count + '</span>' : '') +
            '</div>' +
          '</div>'
        ).join("") +
        '</div></div>';
    }

    // Top targeted table
    html += '<div class="panel"><h3>Top Targeted Recipients</h3>';
    if (userList.length > 0) {
      html += '<table><thead><tr><th>Recipient</th><th>Blocked</th><th>Quarantined</th><th>Allowed</th><th>Total</th><th>Avg Score</th></tr></thead><tbody>' +
        userList.map(u =>
          '<tr><td>' + esc(u.recipient) + '</td>' +
          '<td class="sev-crit">' + (u.blocked || 0) + '</td>' +
          '<td class="sev-med">' + (u.quarantined || 0) + '</td>' +
          '<td class="sev-low">' + (u.allowed || 0) + '</td>' +
          '<td>' + (u.total || 0) + '</td>' +
          '<td class="' + sevClass(u.avg_score || 0) + '">' + Number(u.avg_score || 0).toFixed(1) + '</td></tr>'
        ).join("") +
        '</tbody></table>';
    } else {
      html += '<div class="empty">No user data available yet.</div>';
    }
    html += '</div>';

    document.getElementById("app").innerHTML = html;
  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 5: Domain Protection (#domains)
// ═══════════════════════════════════════════════════════════════════════
async function renderDomains() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization.</div>'; return; }
  document.getElementById("app").innerHTML = '<div class="empty">Loading domains...</div>';

  try {
    const [domainData, urlData] = await Promise.all([
      api("/v1/dashboard/domains?org_id=" + encodeURIComponent(currentOrg)).catch(() => ({ domains: [] })),
      api("/v1/dashboard/urls?limit=50").catch(() => ({ urls: [] })),
    ]);

    const domainList = domainData.domains || [];
    const urlList = urlData.urls || [];

    let html = '<div class="panel" style="margin-bottom:16px;"><h3>Domain Reputation</h3>';
    if (domainList.length > 0) {
      html += '<table><thead><tr><th>Domain</th><th>First Seen</th><th>Emails</th><th>Avg Score</th><th>Freemail</th></tr></thead><tbody>' +
        domainList.map(d =>
          '<tr><td>' + esc(d.domain) + '</td>' +
          '<td>' + esc(ago(d.first_seen)) + '</td>' +
          '<td>' + (d.total_emails_from || 0) + '</td>' +
          '<td class="' + sevClass(d.avg_threat_score || 0) + '">' + Number(d.avg_threat_score || 0).toFixed(1) + '</td>' +
          '<td>' + (d.is_freemail ? '<span class="badge quarantine">Yes</span>' : '<span class="badge allow">No</span>') + '</td></tr>'
        ).join("") +
        '</tbody></table>';
    } else {
      html += '<div class="empty">No domain data available yet.</div>';
    }
    html += '</div>';

    // URL intelligence
    if (urlList.length > 0) {
      html += '<div class="panel"><h3>URL Intelligence</h3>' +
        '<table><thead><tr><th>URL</th><th>Final URL</th><th>Risk Score</th><th>Hops</th><th>Scanned</th></tr></thead><tbody>' +
        urlList.map(u =>
          '<tr><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.url) + '</td>' +
          '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.final_url || '') + '</td>' +
          '<td class="' + sevClass(u.risk_score || 0) + '">' + Number(u.risk_score || 0).toFixed(1) + '</td>' +
          '<td>' + (u.redirect_hops || 0) + '</td>' +
          '<td>' + esc(ago(u.scanned_at)) + '</td></tr>'
        ).join("") +
        '</tbody></table></div>';
    }

    document.getElementById("app").innerHTML = html;
  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 6: Campaign Analysis (#campaigns)
// ═══════════════════════════════════════════════════════════════════════
async function renderCampaigns() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization.</div>'; return; }
  document.getElementById("app").innerHTML = '<div class="empty">Loading campaigns...</div>';

  try {
    const data = await api("/v1/verdicts?org_id=" + encodeURIComponent(currentOrg) + "&limit=200");
    const rows = data.verdicts || [];

    // Cluster by sender_domain within 1-hour windows
    const clusters = {};
    for (const v of rows) {
      const domain = (v.sender || "").split("@")[1] || "unknown";
      const hour = new Date(v.created_at).toISOString().slice(0, 13);
      const key = domain + "|" + hour;
      if (!clusters[key]) clusters[key] = { domain, hour, emails: [], labels: new Set(), targets: new Set() };
      clusters[key].emails.push(v);
      clusters[key].labels.add(v.label);
      clusters[key].targets.add(v.recipient);
    }

    const campaigns = Object.values(clusters)
      .filter(c => c.emails.length >= 2)
      .sort((a, b) => b.emails.length - a.emails.length);

    if (campaigns.length === 0) {
      document.getElementById("app").innerHTML = '<div class="empty">No campaign clusters detected. Campaigns are auto-detected when multiple emails from the same domain arrive within the same hour.</div>';
      return;
    }

    document.getElementById("app").innerHTML = campaigns.map((c, i) => {
      const first = c.emails[0];
      const last = c.emails[c.emails.length - 1];
      const labelsArr = Array.from(c.labels);
      const targetsArr = Array.from(c.targets);

      const emailRows = c.emails.map(v =>
        '<tr class="clickable" onclick="navigate(\\'#incident/' + encodeURIComponent(v.org_id) + '/' + encodeURIComponent(v.message_id) + '\\')">' +
        '<td>' + esc(v.sender) + '</td><td>' + esc(v.recipient) + '</td>' +
        '<td>' + verdictBadge(v.verdict) + '</td>' +
        '<td class="' + scoreClass(v.threat_score) + '">' + Number(v.threat_score).toFixed(1) + '</td>' +
        '<td>' + esc(ago(v.created_at)) + '</td></tr>'
      ).join("");

      return '<div class="campaign-card" id="campaign-' + i + '" onclick="toggleCampaign(' + i + ')">' +
        '<div class="campaign-header">' +
          '<div><strong style="font-size:14px;">' + esc(c.domain) + '</strong>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:2px;">' + c.emails.length + ' emails | ' +
            targetsArr.length + ' targets | ' + labelsArr.map(l => '<span class="badge ' + l + '" style="font-size:10px;">' + l + '</span>').join(" ") +
          '</div></div>' +
          '<div style="font-size:12px;color:var(--muted);">' + esc(ago(first.created_at)) + '</div>' +
        '</div>' +
        '<div class="campaign-details">' +
          '<table><thead><tr><th>Sender</th><th>Recipient</th><th>Verdict</th><th>Score</th><th>Time</th></tr></thead>' +
          '<tbody>' + emailRows + '</tbody></table>' +
        '</div>' +
      '</div>';
    }).join("");

  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

function toggleCampaign(idx) {
  const el = document.getElementById("campaign-" + idx);
  if (el) el.classList.toggle("expanded");
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 7: Policy & Thresholds (#policies)
// ═══════════════════════════════════════════════════════════════════════
async function renderPolicies() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization.</div>'; return; }
  document.getElementById("app").innerHTML = '<div class="empty">Loading policies...</div>';

  try {
    const [orgData, statusData] = await Promise.all([
      api("/v1/orgs/" + encodeURIComponent(currentOrg)),
      api("/admin/status").catch(() => []),
    ]);

    const thresholds = typeof orgData.thresholds === "string" ? JSON.parse(orgData.thresholds) : (orgData.thresholds || {});

    // Calculate cold-start ramp
    const onboarded = orgData.onboarded_at ? new Date(orgData.onboarded_at) : null;
    const daysSince = onboarded ? (Date.now() - onboarded.getTime()) / 86400000 : 0;
    const statsRamp = Math.min(Math.max(daysSince / 30, 0), 1);
    const graphRamp = Math.min(Math.max(daysSince / 60, 0), 1);

    // Engine status cards
    const engineCards = (Array.isArray(statusData) ? statusData : []).map(s => {
      const dot = s.status === "ok" ? "low" : "crit";
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--surface2);border-radius:6px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:var(--' + dot + ');"></span>' +
        '<span style="font-size:12px;">' + esc(s.name) + '</span>' +
        '<span style="margin-left:auto;font-size:11px;color:var(--muted);">' + (s.status === "ok" ? s.latency_ms + 'ms' : 'down') + '</span></div>';
    }).join("");

    document.getElementById("app").innerHTML =
      '<div class="grid-2">' +
        // Thresholds
        '<div class="panel"><h3>Scoring Thresholds</h3>' +
          '<div class="threshold-editor">' +
            '<label>Block &ge;<input type="number" id="th-block" value="' + (thresholds.block || 15) + '" step="0.5"></label>' +
            '<label>Quarantine &ge;<input type="number" id="th-quarantine" value="' + (thresholds.quarantine || 8) + '" step="0.5"></label>' +
            '<button class="btn primary" onclick="saveThresholds()">Save Thresholds</button>' +
          '</div>' +
          '<div style="margin-top:12px;font-size:12px;color:var(--muted);">Industry: ' + esc(orgData.industry) + ' | Timezone: ' + esc(orgData.timezone) +
          ' | Business hours: ' + orgData.business_hours_start + ':00 — ' + orgData.business_hours_end + ':00</div>' +
        '</div>' +

        // Cold-start ramp
        '<div class="panel"><h3>Cold-Start Ramp Progress</h3>' +
          '<div style="margin-bottom:12px;">' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span>Stats DB (30d)</span><span>' + fmtPct(statsRamp) + '</span></div>' +
            '<div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;">' +
              '<div style="width:' + (statsRamp * 100) + '%;height:100%;background:var(--accent);border-radius:4px;"></div></div>' +
          '</div>' +
          '<div>' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span>Graph DB (60d)</span><span>' + fmtPct(graphRamp) + '</span></div>' +
            '<div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;">' +
              '<div style="width:' + (graphRamp * 100) + '%;height:100%;background:var(--info);border-radius:4px;"></div></div>' +
          '</div>' +
          (onboarded ? '<div style="margin-top:8px;font-size:11px;color:var(--muted);">Onboarded: ' + fmtDate(orgData.onboarded_at) + ' (' + Math.floor(daysSince) + ' days ago)</div>' : '') +
        '</div>' +
      '</div>' +

      // Engine status
      '<div class="panel"><h3>Engine Status</h3>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;">' + engineCards + '</div>' +
      '</div>';

  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

async function saveThresholds() {
  const block = Number(document.getElementById("th-block").value);
  const quarantine = Number(document.getElementById("th-quarantine").value);
  if (isNaN(block) || isNaN(quarantine)) { showToast("Invalid threshold values", "error"); return; }
  if (quarantine >= block) { showToast("Quarantine threshold must be less than block", "error"); return; }
  try {
    await apiPut("/v1/orgs/" + encodeURIComponent(currentOrg) + "/thresholds", { block, quarantine });
    showToast("Thresholds saved!", "success");
  } catch (e) { showToast("Error: " + e.message, "error"); }
}

// ═══════════════════════════════════════════════════════════════════════
// VIEW 8: ML Models (#models)
// ═══════════════════════════════════════════════════════════════════════
async function renderModels() {
  if (!currentOrg) { document.getElementById("app").innerHTML = '<div class="empty">Select an organization.</div>'; return; }
  document.getElementById("app").innerHTML = '<div class="empty">Loading models...</div>';

  try {
    const [models, deployments, jobs] = await Promise.all([
      api("/v1/orgs/" + encodeURIComponent(currentOrg) + "/models"),
      api("/v1/orgs/" + encodeURIComponent(currentOrg) + "/deployments"),
      api("/v1/orgs/" + encodeURIComponent(currentOrg) + "/training_jobs"),
    ]);

    const modelList = models.models || [];
    const deployList = Array.isArray(deployments) ? deployments : [];
    const jobList = jobs.jobs || [];

    // Deployments
    let html = '<div class="panel" style="margin-bottom:16px;"><h3>Active Deployments</h3>';
    if (deployList.length > 0) {
      // Traffic split visualization
      const incumbent = deployList.find(d => d.role === "incumbent");
      const canary = deployList.find(d => d.role === "canary");
      const incPct = incumbent ? Number(incumbent.traffic_pct || 100) : 100;
      const canPct = canary ? Number(canary.traffic_pct || 0) : 0;

      html += '<div class="traffic-bar">' +
        (incumbent ? '<div class="seg" style="width:' + (100 - canPct) + '%;background:var(--low);">Incumbent ' + (100 - canPct) + '%</div>' : '') +
        (canary ? '<div class="seg" style="width:' + canPct + '%;background:var(--med);">Canary ' + canPct + '%</div>' : '') +
        '</div>';

      html += '<table><thead><tr><th>Role</th><th>Version</th><th>Traffic</th><th>Accuracy</th></tr></thead><tbody>' +
        deployList.map(d =>
          '<tr><td>' + statusBadge(d.role) + '</td>' +
          '<td>' + esc(d.model_version) + '</td>' +
          '<td>' + d.traffic_pct + '%</td>' +
          '<td>' + (d.val_accuracy != null ? fmtPct(d.val_accuracy) : '—') + '</td></tr>'
        ).join("") +
        '</tbody></table>';
    } else {
      html += '<div class="empty">No active deployments. Train a model to get started.</div>';
    }
    html += '</div>';

    // Model registry
    html += '<div class="panel" style="margin-bottom:16px;"><h3>Model Registry</h3>';
    if (modelList.length > 0) {
      html += '<table><thead><tr><th>Version</th><th>Kind</th><th>Accuracy</th><th>Precision</th><th>Recall</th><th>FP Rate</th><th>Trained</th><th>Status</th></tr></thead><tbody>' +
        modelList.map(m =>
          '<tr><td>' + esc(m.version) + '</td>' +
          '<td>' + esc(m.model_kind) + '</td>' +
          '<td>' + (m.val_accuracy != null ? fmtPct(m.val_accuracy) : '—') + '</td>' +
          '<td>' + (m.val_precision != null ? fmtPct(m.val_precision) : '—') + '</td>' +
          '<td>' + (m.val_recall != null ? fmtPct(m.val_recall) : '—') + '</td>' +
          '<td>' + (m.val_fp_rate != null ? fmtPct(m.val_fp_rate) : '—') + '</td>' +
          '<td>' + esc(ago(m.trained_at)) + '</td>' +
          '<td>' + statusBadge(m.status) + '</td></tr>'
        ).join("") +
        '</tbody></table>';
    } else {
      html += '<div class="empty">No models trained yet.</div>';
    }
    html += '</div>';

    // Training jobs
    html += '<div class="panel"><h3>Training Jobs</h3>';
    if (jobList.length > 0) {
      html += '<table><thead><tr><th>ID</th><th>Started</th><th>Finished</th><th>Status</th><th>Labels</th><th>Version</th></tr></thead><tbody>' +
        jobList.map(j =>
          '<tr><td>' + esc(j.id) + '</td>' +
          '<td>' + esc(ago(j.started_at)) + '</td>' +
          '<td>' + (j.finished_at ? esc(ago(j.finished_at)) : '—') + '</td>' +
          '<td>' + statusBadge(j.status) + '</td>' +
          '<td>' + (j.labels_used || '—') + '</td>' +
          '<td>' + esc(j.resulting_version || '—') + '</td></tr>'
        ).join("") +
        '</tbody></table>';
    } else {
      html += '<div class="empty">No training jobs recorded.</div>';
    }
    html += '</div>';

    document.getElementById("app").innerHTML = html;
  } catch (e) {
    document.getElementById("app").innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Navigation & Routing
// ═══════════════════════════════════════════════════════════════════════
const VIEW_TITLES = {
  overview: "Executive Overview",
  threats: "Threat Detection Center",
  incident: "Incident Investigation",
  users: "User Risk Dashboard",
  domains: "Domain Protection",
  campaigns: "Campaign Analysis",
  policies: "Policy & Thresholds",
  models: "ML Models & A/B Testing",
};

function navigate(hash) {
  location.hash = hash;
}

function route() {
  const hash = location.hash || "#overview";
  const navItems = document.querySelectorAll(".nav-item[data-view]");

  closeDrawer();

  if (hash.startsWith("#incident/")) {
    navItems.forEach(n => n.classList.remove("active"));
    document.getElementById("view-title").textContent = VIEW_TITLES.incident;
    const parts = hash.slice(10).split("/");
    const orgId = decodeURIComponent(parts[0] || "");
    const msgId = decodeURIComponent(parts.slice(1).join("/") || "");
    renderIncident(orgId, msgId);
    return;
  }

  // Legacy route support
  if (hash.startsWith("#verdict/")) {
    const parts = hash.slice(9).split("/");
    const orgId = decodeURIComponent(parts[0] || "");
    const msgId = decodeURIComponent(parts.slice(1).join("/") || "");
    navigate("#incident/" + encodeURIComponent(orgId) + "/" + encodeURIComponent(msgId));
    return;
  }

  const view = hash.slice(1) || "overview";
  navItems.forEach(n => n.classList.toggle("active", n.dataset.view === view));
  document.getElementById("view-title").textContent = VIEW_TITLES[view] || view;

  switch (view) {
    case "overview": renderOverview(); break;
    case "threats": renderThreats(); break;
    case "users": renderUsers(); break;
    case "domains": renderDomains(); break;
    case "campaigns": renderCampaigns(); break;
    case "policies": renderPolicies(); break;
    case "models": renderModels(); break;
    default: renderOverview();
  }
}

// ── Org selector ───────────────────────────────────────────────────────
async function loadOrgs() {
  try {
    const orgs = await api("/v1/orgs");
    const sel = document.getElementById("org-select");
    sel.innerHTML = '<option value="">— Select Org —</option>' +
      orgs.map(o => '<option value="' + esc(o.org_id) + '"' +
        (o.org_id === currentOrg ? ' selected' : '') + '>' +
        esc(o.name || o.org_id) + ' (' + esc(o.industry) + ')' +
      '</option>').join("");

    sel.onchange = function() {
      currentOrg = this.value;
      localStorage.setItem("etdp_soc_org", currentOrg);
      route();
    };
  } catch (e) {
    document.getElementById("org-select").innerHTML = '<option value="">Error loading orgs</option>';
  }
}

// ── Init ───────────────────────────────────────────────────────────────
window.addEventListener("hashchange", route);
window.navigate = navigate;
window.submitFeedback = submitFeedback;
window.submitFeedbackWithNotes = submitFeedbackWithNotes;
window.toggleCampaign = toggleCampaign;
window.openThreatDrawer = openThreatDrawer;
window.drawerFeedback = drawerFeedback;
window.closeDrawer = closeDrawer;
window.toggleRow = toggleRow;
window.toggleAllRows = toggleAllRows;
window.bulkAction = bulkAction;
window.saveThresholds = saveThresholds;
window.toggleTheme = toggleTheme;
window.copyToClipboard = copyToClipboard;

loadOrgs();
route();
</script>
</body>
</html>`;
}
