// Self-contained login page SPA — dark theme matching signup/dashboard.
export function renderLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETDP — Sign In</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
         background: #0d1117; color: #c9d1d9; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; }
  a { color: #58a6ff; }
  .login-wrap { width: 100%; max-width: 400px; padding: 24px; }
  .brand { text-align: center; margin-bottom: 32px; }
  .brand h1 { font-size: 22px; font-weight: 700; color: #e6edf3; }
  .brand p { font-size: 13px; color: #8b949e; margin-top: 4px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 24px; }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; color: #e6edf3; }
  .card .sub { font-size: 13px; color: #8b949e; margin-bottom: 20px; }

  label { display: block; font-size: 13px; font-weight: 500; color: #8b949e;
          margin-bottom: 4px; margin-top: 14px; }
  label:first-of-type { margin-top: 0; }
  input { width: 100%; padding: 8px 12px; font-size: 14px; border-radius: 6px;
          border: 1px solid #30363d; background: #0d1117; color: #c9d1d9;
          font-family: inherit; outline: none; }
  input:focus { border-color: #58a6ff; }

  .btn { display: block; width: 100%; padding: 10px 20px; font-size: 14px; font-weight: 500;
         border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9;
         cursor: pointer; font-family: inherit; text-align: center; text-decoration: none; }
  .btn:hover { background: #30363d; border-color: #8b949e; }
  .btn.primary { background: #238636; border-color: #238636; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .btn.primary:disabled { opacity: .5; cursor: not-allowed; }

  .sso-buttons { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
  .sso-btn { display: flex; align-items: center; justify-content: center; gap: 10px;
             padding: 10px; border-radius: 6px; border: 1px solid #30363d;
             background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 14px;
             font-family: inherit; text-decoration: none; }
  .sso-btn:hover { background: #30363d; border-color: #8b949e; text-decoration: none; }

  .divider { display: flex; align-items: center; gap: 12px; margin: 20px 0; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #30363d; }
  .divider span { font-size: 12px; color: #8b949e; text-transform: uppercase; }

  .error-msg { background: #f8514926; border: 1px solid #f85149; color: #f85149;
               padding: 8px 12px; border-radius: 6px; font-size: 13px;
               margin-bottom: 16px; display: none; }

  .footer { text-align: center; margin-top: 20px; font-size: 13px; color: #8b949e; }
</style>
</head>
<body>
<div class="login-wrap">
  <div class="brand">
    <h1>ETDP Security</h1>
    <p>Email Threat Detection Platform</p>
  </div>

  <div class="card">
    <h2>Sign In</h2>
    <p class="sub">Access your organization's security dashboard.</p>

    <div id="error" class="error-msg"></div>

    <div class="sso-buttons">
      <a class="sso-btn" href="/auth/sso/google">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.9 33.5 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.2-2.7-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.3 15.3 18.8 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.2 26.7 36 24 36c-5.3 0-9.8-3.5-11.3-8.3l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C36.7 39.4 44 34 44 24c0-1.3-.2-2.7-.4-3.9z"/></svg>
        Sign in with Google
      </a>
      <a class="sso-btn" href="/auth/sso/microsoft">
        <svg width="18" height="18" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
        Sign in with Microsoft
      </a>
    </div>

    <div class="divider"><span>or</span></div>

    <form id="login-form" onsubmit="return handleLogin(event)">
      <label>Email</label>
      <input type="email" id="f-email" placeholder="you@company.com" required autocomplete="email">
      <label>Password</label>
      <input type="password" id="f-password" placeholder="Enter password" required autocomplete="current-password">
      <div style="margin-top: 20px">
        <button type="submit" class="btn primary" id="submit-btn">Sign In</button>
      </div>
    </form>
  </div>

  <div class="footer">
    Don't have an account? <a href="/signup">Sign up</a>
  </div>
</div>

<script>
async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById("error");
  const btn = document.getElementById("submit-btn");
  errEl.style.display = "none";
  btn.disabled = true;
  btn.textContent = "Signing in...";

  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("f-email").value.trim(),
        password: document.getElementById("f-password").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || "Login failed";
      errEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Sign In";
      return false;
    }
    window.location.href = "/admin/dashboard";
  } catch (err) {
    errEl.textContent = "Network error: " + err.message;
    errEl.style.display = "block";
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
  return false;
}
</script>
</body>
</html>`;
}
