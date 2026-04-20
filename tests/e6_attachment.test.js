import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../services/e6_attachment/index.js";

function email(o = {}) {
  return { org_id: "o", message_id: "m", sender: "a@b.com",
    recipients: ["c@d.com"], subject: "", body_text: "", body_html: null,
    headers: {}, attachments: [], prior_signals: [], ...o };
}

test("E6: no attachments → no signals", () => {
  assert.equal(analyze(email()).length, 0);
});

test("E6: dangerous_extension fires for .exe/.scr/.js/.vbs/.bat/.jar/.lnk", () => {
  for (const ext of [".exe", ".scr", ".js", ".vbs", ".bat", ".jar", ".lnk"]) {
    const s = analyze(email({ attachments: [{ filename: `payload${ext}` }] }));
    const hit = s.find((x) => x.signal === "dangerous_extension");
    assert.ok(hit, `expected dangerous_extension for ${ext}`);
    assert.equal(hit.detail.filename, `payload${ext}`);
  }
});

test("E6: PDF/DOCX attachments do not fire dangerous_extension", () => {
  const s = analyze(email({ attachments: [
    { filename: "report.pdf" }, { filename: "notes.docx" },
  ] }));
  assert.equal(s.length, 0);
});

test("E6: extension check is case-insensitive", () => {
  const s = analyze(email({ attachments: [{ filename: "MALWARE.EXE" }] }));
  assert.ok(s.some((x) => x.signal === "dangerous_extension"));
});

// ── attachment_sender_novelty ───────────────────────────────────────

test("E6: attachment_sender_novelty fires when sender never sent this file type", () => {
  const s = analyze(email({
    attachments: [{ filename: "report.xlsm" }],
    _sender_attachment_types: [".pdf", ".docx", ".png"],
  }));
  assert.ok(s.some((x) => x.signal === "attachment_sender_novelty"));
  assert.equal(s.find((x) => x.signal === "attachment_sender_novelty").detail.extension, ".xlsm");
});

test("E6: attachment_sender_novelty does NOT fire when extension is known", () => {
  const s = analyze(email({
    attachments: [{ filename: "report.pdf" }],
    _sender_attachment_types: [".pdf", ".docx", ".png"],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_sender_novelty"), false);
});

test("E6: attachment_sender_novelty does NOT fire when _sender_attachment_types is absent", () => {
  const s = analyze(email({
    attachments: [{ filename: "report.xlsm" }],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_sender_novelty"), false);
});

// ── attachment_entropy_anomaly ──────────────────────────────────────

test("E6: attachment_entropy_anomaly fires when Shannon entropy > 7.5", () => {
  // High-entropy content: all 256 byte values cycled to maximize Shannon entropy
  const buf = Buffer.alloc(1024);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
  // Shuffle to avoid any ordering patterns
  for (let i = buf.length - 1; i > 0; i--) {
    const j = (i * 7 + 13) % (i + 1);
    [buf[i], buf[j]] = [buf[j], buf[i]];
  }
  const highEntropyContent = buf.toString("base64");
  const s = analyze(email({
    attachments: [{ filename: "payload.bin", content: highEntropyContent }],
  }));
  assert.ok(s.some((x) => x.signal === "attachment_entropy_anomaly"));
});

test("E6: attachment_entropy_anomaly does NOT fire for low-entropy content", () => {
  // Repetitive content has low entropy
  const lowEntropyContent = Buffer.from("AAAAAAAAAA".repeat(100)).toString("base64");
  const s = analyze(email({
    attachments: [{ filename: "notes.txt", content: lowEntropyContent }],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_entropy_anomaly"), false);
});

// ── attachment_type_mismatch ────────────────────────────────────────

test("E6: attachment_type_mismatch fires when magic bytes don't match extension", () => {
  // MZ header (exe) but .pdf extension
  const exeContent = Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).toString("base64");
  const s = analyze(email({
    attachments: [{ filename: "document.pdf", content: exeContent }],
  }));
  assert.ok(s.some((x) => x.signal === "attachment_type_mismatch"));
  const hit = s.find((x) => x.signal === "attachment_type_mismatch");
  assert.equal(hit.detail.claimed, ".pdf");
  assert.equal(hit.detail.actual_magic, "exe");
});

test("E6: attachment_type_mismatch does NOT fire when magic bytes match extension", () => {
  // %PDF header with .pdf extension
  const pdfContent = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]).toString("base64");
  const s = analyze(email({
    attachments: [{ filename: "report.pdf", content: pdfContent }],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_type_mismatch"), false);
});

// ── attachment_macro_context ────────────────────────────────────────

test("E6: attachment_macro_context fires for macro-enabled doc with financial language", () => {
  const s = analyze(email({
    body_text: "Please review the attached invoice for wire transfer payment.",
    attachments: [{ filename: "invoice.xlsm" }],
  }));
  assert.ok(s.some((x) => x.signal === "attachment_macro_context"));
});

test("E6: attachment_macro_context does NOT fire without financial language", () => {
  const s = analyze(email({
    body_text: "Here are the meeting notes from today.",
    attachments: [{ filename: "notes.xlsm" }],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_macro_context"), false);
});

test("E6: attachment_macro_context does NOT fire for non-macro extensions", () => {
  const s = analyze(email({
    body_text: "Please review the attached invoice for wire transfer payment.",
    attachments: [{ filename: "invoice.xlsx" }],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_macro_context"), false);
});

// ── attachment_relationship_anomaly ─────────────────────────────────

test("E6: attachment_relationship_anomaly fires for novel file type in established pair", () => {
  const s = analyze(email({
    attachments: [{ filename: "payload.exe" }],
    _pair_attachment_types: [".pdf", ".docx", ".xlsx"],
  }));
  assert.ok(s.some((x) => x.signal === "attachment_relationship_anomaly"));
});

test("E6: attachment_relationship_anomaly does NOT fire when extension is known for pair", () => {
  const s = analyze(email({
    attachments: [{ filename: "report.pdf" }],
    _pair_attachment_types: [".pdf", ".docx", ".xlsx"],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_relationship_anomaly"), false);
});

test("E6: attachment_relationship_anomaly does NOT fire when pair history is short (<3)", () => {
  const s = analyze(email({
    attachments: [{ filename: "payload.exe" }],
    _pair_attachment_types: [".pdf"],
  }));
  assert.equal(s.some((x) => x.signal === "attachment_relationship_anomaly"), false);
});
