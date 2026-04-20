// E7 Visual / Screenshot — behavioral visual analysis.
// Signals: credential_form_detected, visual_brand_behavioral,
//          visual_harvesting_ux, visual_internal_tool_mimic.
import { makeApp, listen } from "@etdp/shared/engineBase";

const BRAND_PATTERNS = [
  { name: "microsoft", re: /microsoft|office\s*365|outlook|onedrive|teams/i },
  { name: "google", re: /google|gmail|g\s*suite|workspace/i },
  { name: "apple", re: /apple|icloud|apple\s*id/i },
  { name: "paypal", re: /paypal/i },
  { name: "amazon", re: /amazon|aws/i },
  { name: "docusign", re: /docusign/i },
  { name: "dropbox", re: /dropbox/i },
];

// UX patterns commonly used in credential harvesting pages.
const HARVESTING_UX_PATTERNS = [
  /session.{0,20}(expired|timeout)/i,
  /account.{0,20}(suspended|locked|disabled|verify)/i,
  /countdown|timer.*\d+/i,
  /progress.{0,10}(bar|indicator)/i,
  /loading.*please\s*wait/i,
  /security.{0,20}(alert|warning|notice)/i,
  /confirm.{0,20}identity/i,
];

function sig(name, score, detail = {}) {
  return { engine: "visual", signal: name, score, detail };
}

export function analyze(email) {
  const html = (email.body_html || "").toLowerCase();
  const signals = [];
  if (!html) return signals;

  // credential_form_detected: password field in email HTML.
  if (html.includes('type="password"') || html.includes("type='password'")) {
    signals.push(sig("credential_form_detected", 4.5));
  }

  // visual_brand_behavioral: email impersonates a known brand.
  const senderDomain = email.sender?.includes("@")
    ? email.sender.split("@")[1].toLowerCase() : "";
  for (const brand of BRAND_PATTERNS) {
    if (brand.re.test(html) || brand.re.test(email.subject || "")) {
      // Check if sender domain actually belongs to that brand.
      if (senderDomain && !senderDomain.includes(brand.name)) {
        signals.push(sig("visual_brand_behavioral", 3.0,
          { brand: brand.name, sender_domain: senderDomain }));
        break;
      }
    }
  }

  // visual_harvesting_ux: UX patterns of credential harvesting.
  const uxHits = HARVESTING_UX_PATTERNS.filter((re) => re.test(html));
  if (uxHits.length >= 2) {
    signals.push(sig("visual_harvesting_ux", 2.25,
      { patterns_matched: uxHits.length }));
  }

  // visual_internal_tool_mimic: email mimics org's SSO/portal.
  const orgDomains = email._org_internal_domains || [];
  if (orgDomains.length > 0 && (html.includes("sso") || html.includes("single sign")
      || html.includes("company portal") || html.includes("employee login"))) {
    if (senderDomain && !orgDomains.includes(senderDomain)) {
      signals.push(sig("visual_internal_tool_mimic", 3.75,
        { sender_domain: senderDomain, mimics: "internal_sso" }));
    }
  }

  return signals;
}

const app = makeApp("e7_visual", analyze);
listen(app, "e7_visual");
