// E9 Specialized ML stub. Real impl: homoglyph detector, header anomaly model,
// encoding-abuse detector, MIME structural anomaly detector — 13 signals.
import { makeApp, listen } from "@etdp/shared/engineBase";

function hasMixedScript(text) {
  // Lightweight check: flag if string mixes ASCII letters with non-ASCII letters.
  let asciiAlpha = false;
  let nonAsciiAlpha = false;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (!/\p{L}/u.test(ch)) continue;
    if (code < 128) asciiAlpha = true;
    else nonAsciiAlpha = true;
  }
  return asciiAlpha && nonAsciiAlpha;
}

function analyze(email) {
  const signals = [];
  const domain = email.sender.includes("@") ? email.sender.split("@")[1] : "";
  if (domain && hasMixedScript(domain)) {
    signals.push({
      engine: "specialized_ml",
      signal: "mixed_script_domain",
      score: 3.0,
      detail: { domain },
    });
  }
  return signals;
}

const app = makeApp("e9_specialized_ml", analyze);
listen(app, "e9_specialized_ml");
