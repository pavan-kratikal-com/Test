// E7 Visual / Screenshot stub. Real impl: Playwright render + DOM analysis,
// brand logo similarity (CLIP/ResNet-18), OCR, 18 signals.
import { makeApp, listen } from "@etdp/shared/engineBase";

export function analyze(email) {
  const html = (email.body_html || "").toLowerCase();
  const signals = [];
  if (html.includes('type="password"') || html.includes("type='password'")) {
    signals.push({
      engine: "visual",
      signal: "credential_form_detected",
      score: 4.5,
      detail: {},
    });
  }
  return signals;
}

const app = makeApp("e7_visual", analyze);
listen(app, "e7_visual");
