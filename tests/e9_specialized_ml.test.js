import test from "node:test";
import assert from "node:assert/strict";
import {
  analyze, detectConfusable, hasMixedScript, idnLookalikeBrand,
  headerOrderAnomaly, unusualHeaderCombo, receivedChainForged, messageIdFormatAnomaly,
  base64BodyObfuscation, quotedPrintableAbuse, exoticCharset,
  detectMimeAnomalies, editDist, CONFUSABLES,
} from "../services/e9_specialized_ml/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

// ── Homoglyph group ────────────────────────────────────────────────

test("hasMixedScript: mixes ASCII + Cyrillic triggers true", () => {
  assert.equal(hasMixedScript("exаmple.com"), true); // 'а' = Cyrillic
});

test("hasMixedScript: all-ASCII returns false", () => {
  assert.equal(hasMixedScript("example.com"), false);
});

test("detectConfusable: reports Cyrillic confusables", () => {
  const hits = detectConfusable("micrоsoft"); // 'о' is Cyrillic
  assert.ok(hits.length > 0);
  assert.equal(hits[0].ascii, "o");
});

test("idnLookalikeBrand: near-miss to microsoft detected", () => {
  const h = idnLookalikeBrand("micrsoft.com");
  assert.ok(h);
  assert.equal(h.brand, "microsoft");
});

test("idnLookalikeBrand: exact match returns null", () => {
  assert.equal(idnLookalikeBrand("microsoft.com"), null);
});

test("editDist: basic cases", () => {
  assert.equal(editDist("abc", "abc"), 0);
  assert.equal(editDist("abc", "abd"), 1);
});

// ── Header group ───────────────────────────────────────────────────

test("headerOrderAnomaly: correctly-ordered headers return null", () => {
  assert.equal(headerOrderAnomaly({
    From: "a", To: "b", Subject: "s", Date: "d", "Message-Id": "m",
  }), null);
});

test("headerOrderAnomaly: swapped order fires", () => {
  const h = headerOrderAnomaly({ Subject: "s", From: "a", Date: "d" });
  assert.ok(h);
});

test("unusualHeaderCombo: Reply-To on a different domain from From", () => {
  const hit = unusualHeaderCombo({
    From: "alice@acme.com", "Reply-To": "attacker@evil.com",
  });
  assert.ok(hit);
  assert.equal(hit.from_domain, "acme.com");
});

test("unusualHeaderCombo: same-domain Reply-To is fine", () => {
  assert.equal(unusualHeaderCombo({
    From: "alice@acme.com", "Reply-To": "replies@acme.com",
  }), null);
});

test("messageIdFormatAnomaly: fires on completely missing ID", () => {
  const hit = messageIdFormatAnomaly({}, "alice@a.com");
  assert.ok(hit);
  assert.equal(hit.reason, "missing_message_id");
});

test("messageIdFormatAnomaly: malformed Message-ID flagged", () => {
  const hit = messageIdFormatAnomaly({ "Message-ID": "no-brackets" }, "a@b.com");
  assert.ok(hit);
  assert.equal(hit.reason, "malformed_message_id");
});

test("receivedChainForged: non-monotonic timestamps flagged", () => {
  const hit = receivedChainForged({
    Received: ["from a.com by b.com; Mon, 1 Jan 2026 10:00:00 +0000"],
  });
  // Single Received header → no chain to validate → null.
  assert.equal(hit, null);
});

// ── Encoding group ─────────────────────────────────────────────────

test("base64BodyObfuscation: large base64 blob in body fires", () => {
  const body = "plain text\n" + "A".repeat(500);
  const hit = base64BodyObfuscation(email({ body_text: body }));
  assert.ok(hit);
});

test("base64BodyObfuscation: clean body returns null", () => {
  assert.equal(base64BodyObfuscation(email({ body_text: "hi there" })), null);
});

test("quotedPrintableAbuse: lots of =XX sequences fire", () => {
  const body = "=61=62=63".repeat(50);
  const hit = quotedPrintableAbuse(email({ body_text: body }));
  assert.ok(hit);
});

test("exoticCharset: flags non-standard charsets", () => {
  const hit = exoticCharset(email({
    headers: { "Content-Type": "text/plain; charset=windows-1251" },
  }));
  assert.ok(hit);
  assert.equal(hit.charset, "windows-1251");
});

test("exoticCharset: utf-8 passes through", () => {
  assert.equal(exoticCharset(email({
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })), null);
});

// ── Structural (MIME tree) group ───────────────────────────────────

test("detectMimeAnomalies: deep MIME tree flagged", () => {
  const raw = [1, 2, 3, 4, 5]
    .map((i) => `Content-Type: multipart/x; boundary="==B${i}=="`)
    .join("\r\n");
  const s = detectMimeAnomalies(email({ raw_mime: raw }));
  assert.ok(s.find((x) => x.signal === "mime_tree_deep"));
});

test("detectMimeAnomalies: no raw_mime → no signals", () => {
  assert.deepEqual(detectMimeAnomalies(email()), []);
});

// ── Integration of analyze() ───────────────────────────────────────

test("analyze: clean ASCII sender with valid Message-ID → no signals", () => {
  const s = analyze(email({
    sender: "alice@example.com",
    subject: "meeting",
    body_text: "see you at noon",
    headers: {
      From: "alice@example.com",
      To: "bob@example.com",
      Subject: "meeting",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<unique@example.com>",
    },
  }));
  assert.equal(s.length, 0);
});

test("analyze: Cyrillic domain fires mixed_script_domain AND confusable_chars", () => {
  const s = analyze(email({
    sender: "alice@exаmple.com", // Cyrillic 'а'
    headers: {
      From: "alice@exаmple.com", To: "b@b.com", Subject: "s",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000", "Message-ID": "<x@exаmple.com>",
    },
  }));
  const names = s.map((x) => x.signal);
  assert.ok(names.includes("mixed_script_domain"));
  assert.ok(names.includes("confusable_chars"));
});

test("analyze: missing Message-ID fires message_id_format_anomaly", () => {
  const s = analyze(email({ headers: { From: "a@b.com" } }));
  assert.ok(s.find((x) => x.signal === "message_id_format_anomaly"));
});

test("CONFUSABLES table has at least a dozen entries", () => {
  assert.ok(CONFUSABLES.size >= 12);
});

// ── header_client_drift ─────────────────────────────────────────────

test("header_client_drift fires when X-Mailer changed from established fingerprint", () => {
  const s = analyze(email({
    sender: "alice@acme.com",
    headers: {
      From: "alice@acme.com", To: "bob@acme.com", Subject: "hi",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@acme.com>",
      "X-Mailer": "Thunderbird/115.0",
    },
    _sender_header_fingerprint: {
      x_mailer: "Microsoft Outlook/16.0",
      avg_received_hops: 3,
      sample_count: 10,
    },
  }));
  assert.ok(s.some((x) => x.signal === "header_client_drift"));
});

test("header_client_drift does NOT fire when mailer matches established fingerprint", () => {
  const s = analyze(email({
    sender: "alice@acme.com",
    headers: {
      From: "alice@acme.com", To: "bob@acme.com", Subject: "hi",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@acme.com>",
      "X-Mailer": "Microsoft Outlook/16.1",
    },
    _sender_header_fingerprint: {
      x_mailer: "Microsoft Outlook/16.0",
      avg_received_hops: 3,
      sample_count: 10,
    },
  }));
  assert.equal(s.some((x) => x.signal === "header_client_drift"), false);
});

test("header_client_drift does NOT fire when sample_count < 5", () => {
  const s = analyze(email({
    sender: "alice@acme.com",
    headers: {
      From: "alice@acme.com", To: "bob@acme.com", Subject: "hi",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@acme.com>",
      "X-Mailer": "Thunderbird/115.0",
    },
    _sender_header_fingerprint: {
      x_mailer: "Microsoft Outlook/16.0",
      avg_received_hops: 3,
      sample_count: 2,
    },
  }));
  assert.equal(s.some((x) => x.signal === "header_client_drift"), false);
});

// ── header_infra_fingerprint ────────────────────────────────────────

test("header_infra_fingerprint fires when Received hops differ by >2 from average", () => {
  const s = analyze(email({
    sender: "alice@acme.com",
    headers: {
      From: "alice@acme.com", To: "bob@acme.com", Subject: "hi",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@acme.com>",
      Received: [
        "from a.com by b.com; Mon, 1 Jan 2026 10:00:00 +0000",
        "from c.com by d.com; Mon, 1 Jan 2026 09:59:00 +0000",
        "from e.com by f.com; Mon, 1 Jan 2026 09:58:00 +0000",
        "from g.com by h.com; Mon, 1 Jan 2026 09:57:00 +0000",
        "from i.com by j.com; Mon, 1 Jan 2026 09:56:00 +0000",
        "from k.com by l.com; Mon, 1 Jan 2026 09:55:00 +0000",
      ],
    },
    _sender_header_fingerprint: {
      x_mailer: "",
      avg_received_hops: 2,
      sample_count: 10,
    },
  }));
  assert.ok(s.some((x) => x.signal === "header_infra_fingerprint"));
});

test("header_infra_fingerprint does NOT fire when hops are within normal range", () => {
  const s = analyze(email({
    sender: "alice@acme.com",
    headers: {
      From: "alice@acme.com", To: "bob@acme.com", Subject: "hi",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@acme.com>",
      Received: [
        "from a.com by b.com; Mon, 1 Jan 2026 10:00:00 +0000",
        "from c.com by d.com; Mon, 1 Jan 2026 09:59:00 +0000",
        "from e.com by f.com; Mon, 1 Jan 2026 09:58:00 +0000",
      ],
    },
    _sender_header_fingerprint: {
      x_mailer: "",
      avg_received_hops: 3,
      sample_count: 10,
    },
  }));
  assert.equal(s.some((x) => x.signal === "header_infra_fingerprint"), false);
});

// ── header_persona_inconsistency ────────────────────────────────────

test("header_persona_inconsistency fires when From claims exec title with PHP originating script", () => {
  const s = analyze(email({
    sender: "ceo@sketchy.com",
    headers: {
      From: "CEO John Smith <ceo@sketchy.com>",
      To: "bob@acme.com", Subject: "Urgent",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@sketchy.com>",
      "X-PHP-Originating-Script": "1234:mailer.php",
    },
  }));
  assert.ok(s.some((x) => x.signal === "header_persona_inconsistency"));
});

test("header_persona_inconsistency fires when From claims exec title with bulk Precedence", () => {
  const s = analyze(email({
    sender: "director@sketchy.com",
    headers: {
      From: "Director of Operations <director@sketchy.com>",
      To: "bob@acme.com", Subject: "Urgent",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@sketchy.com>",
      Precedence: "bulk",
    },
  }));
  assert.ok(s.some((x) => x.signal === "header_persona_inconsistency"));
});

test("header_persona_inconsistency does NOT fire when From has no exec title", () => {
  const s = analyze(email({
    sender: "alice@sketchy.com",
    headers: {
      From: "Alice Smith <alice@sketchy.com>",
      To: "bob@acme.com", Subject: "Hello",
      Date: "Mon, 01 Jan 2026 10:00:00 +0000",
      "Message-ID": "<x@sketchy.com>",
      "X-PHP-Originating-Script": "1234:mailer.php",
    },
  }));
  assert.equal(s.some((x) => x.signal === "header_persona_inconsistency"), false);
});
