// E1 rspamd stub. Real impl: rspamd milter + symbol extraction (32 signals).
import { makeApp, listen } from "@etdp/shared/engineBase";

export function analyze(email) {
  const headers = JSON.stringify(email.headers || {}).toLowerCase();
  const signals = [];
  if (headers.includes("spf=fail")) {
    signals.push({ engine: "rspamd", signal: "SPF_FAIL", score: 2.0, detail: {} });
  }
  if (headers.includes("dmarc=fail")) {
    signals.push({ engine: "rspamd", signal: "DMARC_POLICY_REJECT", score: 3.0, detail: {} });
  }
  return signals;
}

const app = makeApp("e1_rspamd", analyze);
listen(app, "e1_rspamd");
