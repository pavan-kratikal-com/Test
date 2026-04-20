// Self-contained signup wizard SPA — no external dependencies.
export function renderSignupPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETDP — Organization Signup</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
         background: #0d1117; color: #c9d1d9; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; }
  a { color: #58a6ff; }
  .wizard { width: 100%; max-width: 640px; padding: 24px; }
  .brand { text-align: center; margin-bottom: 32px; }
  .brand h1 { font-size: 22px; font-weight: 700; color: #e6edf3; }
  .brand p { font-size: 13px; color: #8b949e; margin-top: 4px; }

  /* stepper */
  .stepper { display: flex; gap: 4px; margin-bottom: 28px; }
  .step-dot { flex: 1; height: 4px; border-radius: 2px; background: #21262d; transition: background .3s; }
  .step-dot.done { background: #3fb950; }
  .step-dot.active { background: #58a6ff; }

  /* card */
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 24px; }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; color: #e6edf3; }
  .card .sub { font-size: 13px; color: #8b949e; margin-bottom: 20px; }

  /* form elements */
  label { display: block; font-size: 13px; font-weight: 500; color: #8b949e;
          margin-bottom: 4px; margin-top: 14px; }
  label:first-of-type { margin-top: 0; }
  input, select { width: 100%; padding: 8px 12px; font-size: 14px; border-radius: 6px;
                  border: 1px solid #30363d; background: #0d1117; color: #c9d1d9;
                  font-family: inherit; outline: none; }
  input:focus, select:focus { border-color: #58a6ff; }
  .slug-preview { font-size: 12px; color: #8b949e; margin-top: 2px; }

  /* buttons */
  .actions { display: flex; justify-content: space-between; margin-top: 24px; }
  .btn { padding: 8px 20px; font-size: 14px; font-weight: 500; border-radius: 6px;
         border: 1px solid #30363d; background: #21262d; color: #c9d1d9;
         cursor: pointer; font-family: inherit; }
  .btn:hover { background: #30363d; border-color: #8b949e; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn.primary { background: #238636; border-color: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .btn.primary:disabled { background: #238636; }

  /* domain list */
  .domain-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .domain-row input { flex: 1; }
  .domain-table { width: 100%; margin-top: 12px; border-collapse: collapse; font-size: 13px; }
  .domain-table th { text-align: left; padding: 6px 8px; color: #8b949e; font-weight: 500;
                     border-bottom: 1px solid #30363d; font-size: 11px; text-transform: uppercase; }
  .domain-table td { padding: 6px 8px; border-bottom: 1px solid #21262d; }
  .remove-btn { background: none; border: none; color: #f85149; cursor: pointer;
                font-size: 13px; padding: 2px 6px; }
  .remove-btn:hover { text-decoration: underline; }

  /* integration cards */
  .int-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
  .int-card { background: #0d1117; border: 2px solid #30363d; border-radius: 8px;
              padding: 16px; cursor: pointer; transition: border-color .2s; text-align: center; }
  .int-card:hover { border-color: #8b949e; }
  .int-card.selected { border-color: #58a6ff; background: #58a6ff10; }
  .int-card h3 { font-size: 14px; font-weight: 600; color: #e6edf3; margin-bottom: 4px; }
  .int-card p { font-size: 12px; color: #8b949e; }

  /* setup instructions */
  .instructions { background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
                  padding: 14px; font-size: 13px; line-height: 1.7; margin-top: 12px; }
  .instructions code { background: #21262d; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .instructions h4 { font-size: 13px; color: #58a6ff; margin-bottom: 6px; margin-top: 12px; }
  .instructions h4:first-child { margin-top: 0; }
  .connect-btn { display: inline-block; padding: 8px 16px; font-size: 13px; border-radius: 6px;
                 border: 1px solid #30363d; background: #21262d; color: #c9d1d9;
                 cursor: pointer; margin-top: 8px; margin-right: 8px; text-decoration: none; }
  .connect-btn:hover { background: #30363d; }

  /* verify panel */
  .verify-row { display: flex; align-items: center; gap: 10px; padding: 8px 0;
                border-bottom: 1px solid #21262d; font-size: 13px; }
  .verify-row:last-child { border-bottom: none; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.ok { background: #3fb950; }
  .status-dot.pending { background: #d29922; }
  .status-dot.fail { background: #f85149; }
  .verify-label { flex: 1; }
  .verify-status { font-size: 12px; color: #8b949e; }

  /* toast */
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 10px 16px;
           border-radius: 8px; font-size: 13px; display: none; z-index: 10; }
  .toast.error { background: #f8514926; border: 1px solid #f85149; color: #f85149; }
  .toast.success { background: #3fb95026; border: 1px solid #3fb950; color: #3fb950; }

  /* responsive */
  @media (max-width: 540px) {
    .int-grid { grid-template-columns: 1fr; }
    .wizard { padding: 16px; }
  }
</style>
</head>
<body>
<div class="wizard">
  <div class="brand">
    <h1>ETDP Security</h1>
    <p>Email Threat Detection Platform — Organization Setup</p>
  </div>

  <div class="stepper" id="stepper"></div>
  <div class="card" id="card"></div>
</div>
<div class="toast" id="toast"></div>

<script>
const STEPS = ["Create Account", "Org Details", "Add Domains", "Integration", "Setup", "Verify"];
let step = 0;
let account = { name: "", email: "", password: "" };
let org = { name: "", org_id: "", industry: "general", timezone: "UTC" };
let domains = [];
let integration = "smtp_relay";
let oauthProvider = "";
let createdOrgId = null;

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function esc(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

function toast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast " + type;
  t.style.display = "block";
  setTimeout(() => t.style.display = "none", 4000);
}

function renderStepper() {
  document.getElementById("stepper").innerHTML = STEPS.map((_, i) =>
    '<div class="step-dot ' + (i < step ? "done" : i === step ? "active" : "") + '"></div>'
  ).join("");
}

function render() {
  renderStepper();
  const c = document.getElementById("card");
  if (step === 0) renderStepAccount(c);
  else if (step === 1) renderStep0(c);
  else if (step === 2) renderStep1(c);
  else if (step === 3) renderStep2(c);
  else if (step === 4) renderStep3(c);
  else if (step === 5) renderStep4(c);
}

// ── Step 0: Create Account ────────────────────────────────
function renderStepAccount(c) {
  c.innerHTML = \`
    <h2>Create Account</h2>
    <p class="sub">Create your account to get started.</p>

    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
      <a class="btn" href="/auth/sso/google" style="display:flex;align-items:center;justify-content:center;gap:10px;text-decoration:none">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.9 33.5 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.2-2.7-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.3 15.3 18.8 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.2 26.7 36 24 36c-5.3 0-9.8-3.5-11.3-8.3l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C36.7 39.4 44 34 44 24c0-1.3-.2-2.7-.4-3.9z"/></svg>
        Sign up with Google
      </a>
      <a class="btn" href="/auth/sso/microsoft" style="display:flex;align-items:center;justify-content:center;gap:10px;text-decoration:none">
        <svg width="18" height="18" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
        Sign up with Microsoft
      </a>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin:20px 0">
      <div style="flex:1;height:1px;background:#30363d"></div>
      <span style="font-size:12px;color:#8b949e;text-transform:uppercase">or</span>
      <div style="flex:1;height:1px;background:#30363d"></div>
    </div>
    <label>Full Name</label>
    <input id="f-acct-name" value="\${esc(account.name)}" placeholder="Jane Smith">
    <label>Email</label>
    <input id="f-acct-email" type="email" value="\${esc(account.email)}" placeholder="you@company.com">
    <label>Password</label>
    <input id="f-acct-password" type="password" placeholder="Min 8 characters">
    <div class="actions">
      <span></span>
      <button class="btn primary" onclick="nextStepAccount()">Create Account</button>
    </div>
    <div style="text-align:center;margin-top:16px;font-size:13px;color:#8b949e">
      Already have an account? <a href="/login">Sign in</a>
    </div>\`;
}

async function nextStepAccount() {
  account.name = document.getElementById("f-acct-name").value.trim();
  account.email = document.getElementById("f-acct-email").value.trim();
  account.password = document.getElementById("f-acct-password").value;
  if (!account.name) { toast("Name is required", "error"); return; }
  if (!account.email) { toast("Email is required", "error"); return; }
  if (account.password.length < 8) { toast("Password must be at least 8 characters", "error"); return; }

  try {
    const res = await fetch("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: account.name,
        email: account.email,
        password: account.password,
      }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || "Registration failed", "error"); return; }
  } catch (e) {
    toast("Network error: " + e.message, "error"); return;
  }
  step = 1; render();
}

// ── Step 0: Org Details ──────────────────────────────────
function renderStep0(c) {
  c.innerHTML = \`
    <h2>Organization Details</h2>
    <p class="sub">Tell us about your organization.</p>
    <label>Organization Name</label>
    <input id="f-name" value="\${esc(org.name)}" placeholder="Acme Corporation">
    <div class="slug-preview" id="slug-preview">org_id: \${esc(org.org_id || "—")}</div>
    <label>Industry</label>
    <select id="f-industry">
      <option value="general"\${org.industry==="general"?" selected":""}>General</option>
      <option value="banking"\${org.industry==="banking"?" selected":""}>Banking / Finance</option>
      <option value="tech"\${org.industry==="tech"?" selected":""}>Technology</option>
      <option value="government"\${org.industry==="government"?" selected":""}>Government</option>
      <option value="healthcare"\${org.industry==="healthcare"?" selected":""}>Healthcare</option>
      <option value="legal"\${org.industry==="legal"?" selected":""}>Legal</option>
      <option value="retail"\${org.industry==="retail"?" selected":""}>Retail</option>
    </select>
    <label>Timezone</label>
    <select id="f-tz">
      <option value="UTC"\${org.timezone==="UTC"?" selected":""}>UTC</option>
      <option value="America/New_York"\${org.timezone==="America/New_York"?" selected":""}>Eastern (US)</option>
      <option value="America/Chicago"\${org.timezone==="America/Chicago"?" selected":""}>Central (US)</option>
      <option value="America/Denver"\${org.timezone==="America/Denver"?" selected":""}>Mountain (US)</option>
      <option value="America/Los_Angeles"\${org.timezone==="America/Los_Angeles"?" selected":""}>Pacific (US)</option>
      <option value="Europe/London"\${org.timezone==="Europe/London"?" selected":""}>London</option>
      <option value="Europe/Berlin"\${org.timezone==="Europe/Berlin"?" selected":""}>Berlin</option>
      <option value="Asia/Kolkata"\${org.timezone==="Asia/Kolkata"?" selected":""}>India (IST)</option>
      <option value="Asia/Tokyo"\${org.timezone==="Asia/Tokyo"?" selected":""}>Tokyo</option>
    </select>
    <div class="actions">
      <button class="btn" onclick="step=0;render()">Back</button>
      <button class="btn primary" onclick="nextStep0()">Next</button>
    </div>\`;

  const nameInput = document.getElementById("f-name");
  nameInput.addEventListener("input", () => {
    org.name = nameInput.value;
    org.org_id = slugify(nameInput.value);
    document.getElementById("slug-preview").textContent = "org_id: " + (org.org_id || "—");
  });
}

async function nextStep0() {
  org.name = document.getElementById("f-name").value.trim();
  org.org_id = slugify(org.name);
  org.industry = document.getElementById("f-industry").value;
  org.timezone = document.getElementById("f-tz").value;
  if (!org.name) { toast("Organization name is required", "error"); return; }
  step = 2; render();
}

// ── Step 1: Add Domains ──────────────────────────────────
function renderStep1(c) {
  const rows = domains.map((d, i) => \`
    <tr>
      <td>\${esc(d)}</td>
      <td><button class="remove-btn" onclick="removeDomain(\${i})">Remove</button></td>
    </tr>\`).join("");

  c.innerHTML = \`
    <h2>Add Domains</h2>
    <p class="sub">Add the email domains your organization uses. You'll verify ownership later.</p>
    <div class="domain-row">
      <input id="f-domain" placeholder="example.com" onkeydown="if(event.key==='Enter')addDomain()">
      <button class="btn" onclick="addDomain()">Add</button>
    </div>
    \${domains.length ? \`<table class="domain-table">
      <thead><tr><th>Domain</th><th></th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\` : ""}
    <div class="actions">
      <button class="btn" onclick="step=1;render()">Back</button>
      <button class="btn primary" onclick="nextStep1()" \${domains.length===0?"disabled":""}>Next</button>
    </div>\`;
}

async function addDomain() {
  const input = document.getElementById("f-domain");
  const d = input.value.trim().toLowerCase();
  if (!d || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    toast("Enter a valid domain (e.g. example.com)", "error"); return;
  }
  if (domains.includes(d)) { toast("Domain already added", "error"); return; }
  domains.push(d);
  render();
}

function removeDomain(i) { domains.splice(i, 1); render(); }

function nextStep1() {
  if (domains.length === 0) { toast("Add at least one domain", "error"); return; }
  step = 3; render();
}

// ── Step 2: Choose Integration ───────────────────────────
function renderStep2(c) {
  c.innerHTML = \`
    <h2>Choose Integration</h2>
    <p class="sub">How should ETDP connect to your email system?</p>
    <div class="int-grid">
      <div class="int-card \${integration==="smtp_relay"?"selected":""}" onclick="pickInt('smtp_relay')">
        <h3>SMTP Relay</h3>
        <p>Route mail through ETDP via MX records or gateway config. Works with any provider.</p>
      </div>
      <div class="int-card \${integration==="oauth"?"selected":""}" onclick="pickInt('oauth')">
        <h3>OAuth (API)</h3>
        <p>Connect directly via Google or Microsoft Graph API. No MX changes needed.</p>
      </div>
    </div>
    \${integration === "oauth" ? \`
    <label style="margin-top:16px">OAuth Provider</label>
    <div class="int-grid">
      <div class="int-card \${oauthProvider==="google"?"selected":""}" onclick="pickOAuth('google')" style="padding:12px">
        <h3>Google Workspace</h3>
      </div>
      <div class="int-card \${oauthProvider==="microsoft"?"selected":""}" onclick="pickOAuth('microsoft')" style="padding:12px">
        <h3>Microsoft 365</h3>
      </div>
    </div>\` : ""}
    <div class="actions">
      <button class="btn" onclick="step=2;render()">Back</button>
      <button class="btn primary" onclick="nextStep2()" \${integration==="oauth"&&!oauthProvider?"disabled":""}>Next</button>
    </div>\`;
}

function pickInt(t) { integration = t; if (t !== "oauth") oauthProvider = ""; render(); }
function pickOAuth(p) { oauthProvider = p; render(); }

async function nextStep2() {
  if (integration === "oauth" && !oauthProvider) { toast("Choose an OAuth provider", "error"); return; }

  // Create the org + domains on the server
  const intType = integration === "oauth" ? "oauth_" + oauthProvider : "smtp_relay";
  try {
    const res = await fetch("/v1/orgs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org_id: org.org_id,
        name: org.name,
        industry: org.industry,
        timezone: org.timezone,
        domains: domains,
        integration_type: intType,
      }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || "Failed to create org", "error"); return; }
    createdOrgId = data.org_id;
  } catch (e) {
    toast("Network error: " + e.message, "error"); return;
  }
  step = 4; render();
}

// ── Step 3: Setup Instructions ───────────────────────────
function renderStep3(c) {
  const intType = integration === "oauth" ? "oauth_" + oauthProvider : "smtp_relay";
  let body = "";

  if (intType === "smtp_relay") {
    body = \`
      <div class="instructions">
        <h4>Option A — Google Workspace</h4>
        <ol style="padding-left:18px; line-height:2">
          <li>Open <b>Google Admin Console</b> → Apps → Google Workspace → Gmail → Routing</li>
          <li>Under <b>Inbound gateway</b>, click Configure</li>
          <li>Add your ETDP gateway IP/hostname as the gateway</li>
          <li>Set port to <code>2525</code> (or your configured SMTP port)</li>
          <li>Save changes</li>
        </ol>
        <h4>Option B — Microsoft 365</h4>
        <ol style="padding-left:18px; line-height:2">
          <li>Open <b>Exchange Admin Center</b> → Mail flow → Connectors</li>
          <li>Create a new connector: Connection from <b>Partner organization</b></li>
          <li>Set the gateway host to your ETDP instance</li>
          <li>Configure port <code>2525</code></li>
          <li>Save and test mail flow</li>
        </ol>
        <h4>Option C — MX Record (Generic)</h4>
        <ol style="padding-left:18px; line-height:2">
          <li>Add MX record: priority <code>10</code> → <code>gateway.youretdp.example.com</code></li>
          <li>Lower original MX to priority <code>20</code></li>
          <li>Add SPF include: <code>include:youretdp.example.com</code></li>
          <li>Allow 24-48 hours for DNS propagation</li>
        </ol>
      </div>\`;
  } else if (intType === "oauth_google") {
    body = \`
      <div class="instructions">
        <h4>Connect Google Workspace</h4>
        <p>Click below to authorize ETDP to read and monitor your organization's email via Gmail API.</p>
        <p style="margin-top:8px;color:#8b949e;font-size:12px">Scopes: gmail.readonly, gmail.modify</p>
      </div>
      <a class="connect-btn" href="/v1/oauth/google/start?org_id=\${encodeURIComponent(createdOrgId)}">
        Connect Google Account
      </a>\`;
  } else {
    body = \`
      <div class="instructions">
        <h4>Connect Microsoft 365</h4>
        <p>Click below to authorize ETDP to read and monitor your organization's email via Microsoft Graph API.</p>
        <p style="margin-top:8px;color:#8b949e;font-size:12px">Scopes: Mail.Read, Mail.ReadWrite, offline_access</p>
      </div>
      <a class="connect-btn" href="/v1/oauth/microsoft/start?org_id=\${encodeURIComponent(createdOrgId)}">
        Connect Microsoft Account
      </a>\`;
  }

  c.innerHTML = \`
    <h2>Setup Instructions</h2>
    <p class="sub">\${intType === "smtp_relay" ? "Configure your email provider to route through ETDP." : "Connect your email provider."}</p>
    \${body}
    <div class="actions">
      <button class="btn" onclick="step=3;render()">Back</button>
      <button class="btn primary" onclick="step=5;render()">Next — Verify</button>
    </div>\`;
}

// ── Step 4: Verify & Complete ────────────────────────────
function renderStep4(c) {
  c.innerHTML = \`
    <h2>Verify & Complete</h2>
    <p class="sub">Check domain verification and integration status before completing setup.</p>
    <div id="verify-list" style="margin-top:12px">
      <p style="color:#8b949e;font-size:13px">Loading status...</p>
    </div>
    <div id="int-status" style="margin-top:16px"></div>
    <div class="actions">
      <button class="btn" onclick="step=4;render()">Back</button>
      <button class="btn" onclick="refreshVerify()" style="margin-right:auto;margin-left:8px">Refresh</button>
      <button class="btn primary" id="complete-btn" onclick="completeSetup()">Complete Setup</button>
    </div>\`;
  refreshVerify();
}

async function refreshVerify() {
  if (!createdOrgId) return;

  // Domain status
  try {
    const res = await fetch("/v1/orgs/" + encodeURIComponent(createdOrgId) + "/domains");
    const data = await res.json();
    const el = document.getElementById("verify-list");
    if (data.domains && data.domains.length) {
      el.innerHTML = "<h3 style='font-size:13px;color:#8b949e;margin-bottom:8px'>DOMAINS</h3>" +
        data.domains.map(d => \`
          <div class="verify-row">
            <span class="status-dot \${d.verified ? "ok" : "pending"}"></span>
            <span class="verify-label">\${esc(d.domain)}</span>
            <span class="verify-status">\${d.verified ? "Verified" : "Pending"}</span>
            \${!d.verified ? '<button class="btn" style="padding:3px 10px;font-size:12px" onclick="verifyDomain(\\'' +
              esc(d.domain) + '\\')">Verify</button>' : ""}
          </div>\`).join("");
    } else {
      el.innerHTML = "<p style='color:#8b949e;font-size:13px'>No domains found.</p>";
    }
  } catch (e) {
    document.getElementById("verify-list").innerHTML =
      "<p style='color:#f85149;font-size:13px'>Failed to load domains.</p>";
  }

  // Integration status
  try {
    const res = await fetch("/v1/orgs/" + encodeURIComponent(createdOrgId) + "/integration-status");
    const data = await res.json();
    const el = document.getElementById("int-status");
    const statusClass = data.status === "connected" ? "ok" : "pending";
    el.innerHTML = \`
      <h3 style="font-size:13px;color:#8b949e;margin-bottom:8px">INTEGRATION</h3>
      <div class="verify-row">
        <span class="status-dot \${statusClass}"></span>
        <span class="verify-label">\${esc(data.integration_type || "none")}</span>
        <span class="verify-status">\${esc(data.status || "not configured")}</span>
      </div>\`;
  } catch {}
}

async function verifyDomain(domain) {
  try {
    const res = await fetch(
      "/v1/orgs/" + encodeURIComponent(createdOrgId) + "/domains/" + encodeURIComponent(domain) + "/verify",
      { method: "POST" }
    );
    const data = await res.json();
    if (data.verified) {
      toast("Domain verified!", "success");
    } else {
      toast("Verification pending — add TXT record: _etdp-verify." + domain + " = " + (data.verify_token || ""), "error");
    }
    refreshVerify();
  } catch (e) {
    toast("Verification failed: " + e.message, "error");
  }
}

function completeSetup() {
  window.location.href = "/admin/dashboard?org=" + encodeURIComponent(createdOrgId);
}

render();
</script>
</body>
</html>`;
}
