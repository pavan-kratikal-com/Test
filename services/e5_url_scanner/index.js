// E5 URL Scanner stub. Real impl: Playwright pool, redirect chains, WHOIS,
// PhishTank/SafeBrowsing/VirusTotal lookups, 29 signals.
import { makeApp, listen } from "@etdp/shared/engineBase";

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const SUSPICIOUS_TLDS = [".zip", ".mov", ".top", ".xyz", ".click"];

function analyze(email) {
  const urls = (email.body_text || "").match(URL_RE) || [];
  const signals = [];
  for (const url of urls) {
    const lower = url.toLowerCase();
    if (SUSPICIOUS_TLDS.some((tld) => lower.includes(tld))) {
      signals.push({
        engine: "url_scanner",
        signal: "suspicious_tld",
        score: 2.0,
        detail: { url },
      });
    }
  }
  if (urls.length > 0) {
    signals.push({
      engine: "url_scanner",
      signal: "urls_present",
      score: 0,
      detail: { count: urls.length },
    });
  }
  return signals;
}

const app = makeApp("e5_url_scanner", analyze);
listen(app, "e5_url_scanner");
