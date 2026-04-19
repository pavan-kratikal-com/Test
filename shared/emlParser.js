// EML parser — converts raw RFC 2822 MIME to Email schema fields.
// Uses mailparser's simpleParser for battle-tested MIME handling.
import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";

/**
 * Parse a raw EML string into fields matching the Email schema.
 * @param {string} rawMimeString - Raw RFC 2822 MIME content
 * @returns {Promise<object>} Parsed email fields
 */
export async function parseEml(rawMimeString) {
  const parsed = await simpleParser(rawMimeString);

  // Extract sender email from From header
  const fromAddr = parsed.from?.value?.[0];
  const sender = fromAddr
    ? (fromAddr.name ? `${fromAddr.name} <${fromAddr.address}>` : fromAddr.address)
    : "";

  // Collect all recipients from To + Cc
  const recipients = [];
  if (parsed.to?.value) {
    for (const addr of parsed.to.value) recipients.push(addr.address);
  }
  if (parsed.cc?.value) {
    for (const addr of parsed.cc.value) recipients.push(addr.address);
  }

  // Flatten all headers into Record<string, string>
  const headers = {};
  if (parsed.headers) {
    for (const [key, value] of parsed.headers) {
      // mailparser returns structured objects for some headers; stringify those
      headers[key] = typeof value === "string" ? value
        : (value?.text || value?.value || JSON.stringify(value));
    }
  }

  // Build attachments array with checksum
  const attachments = (parsed.attachments || []).map((att) => ({
    filename: att.filename || "unnamed",
    contentType: att.contentType || "application/octet-stream",
    size: att.size || att.content?.length || 0,
    checksum: att.content
      ? createHash("sha256").update(att.content).digest("hex")
      : null,
  }));

  return {
    message_id: parsed.messageId || `eml-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sender,
    recipients,
    subject: parsed.subject || "",
    body_text: parsed.text || "",
    body_html: parsed.html || null,
    headers,
    attachments,
    received_at: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
    raw_mime: rawMimeString,
  };
}
