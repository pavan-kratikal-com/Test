// E6 Attachment Analyzer — behavioral attachment analysis.
// Signals: dangerous_extension, attachment_sender_novelty, attachment_entropy_anomaly,
//          attachment_macro_context, attachment_type_mismatch.
import { makeApp, listen } from "@etdp/shared/engineBase";

const DANGEROUS_EXT = [".exe", ".scr", ".js", ".vbs", ".bat", ".jar", ".lnk"];
const MACRO_EXT = [".docm", ".xlsm", ".pptm", ".dotm", ".xltm"];
const FINANCIAL_RE = /\b(invoice|payment|wire|transfer|remittance|bank|payroll|ach)\b/i;

// Magic bytes for common file types.
const MAGIC_BYTES = {
  pdf: "25504446",       // %PDF
  zip: "504b0304",       // PK..
  exe: "4d5a",           // MZ
  rar: "52617221",       // Rar!
  gzip: "1f8b",
  png: "89504e47",
  jpg: "ffd8ff",
  ole: "d0cf11e0",       // OLE compound (doc/xls/ppt)
};

function sig(name, score, detail = {}) {
  return { engine: "attachment", signal: name, score, detail };
}

function getExtension(filename) {
  const m = filename.match(/(\.[a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

function detectMagicType(content) {
  if (!content) return null;
  // content may be base64-encoded or hex. Try to get first few bytes.
  let hex = "";
  if (typeof content === "string") {
    try {
      const buf = Buffer.from(content, "base64");
      hex = buf.subarray(0, 8).toString("hex").toLowerCase();
    } catch {
      hex = content.slice(0, 16).toLowerCase();
    }
  }
  for (const [type, magic] of Object.entries(MAGIC_BYTES)) {
    if (hex.startsWith(magic)) return type;
  }
  return null;
}

function shannonEntropy(content) {
  if (!content || content.length === 0) return 0;
  let data;
  try { data = Buffer.from(content, "base64"); } catch { return 0; }
  if (data.length === 0) return 0;
  const freq = new Array(256).fill(0);
  for (let i = 0; i < data.length; i++) freq[data[i]]++;
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] === 0) continue;
    const p = freq[i] / data.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function analyze(email) {
  const signals = [];
  const attachments = email.attachments || [];
  const senderKnownTypes = email._sender_attachment_types || null;

  for (const att of attachments) {
    const name = (att.filename || "").toLowerCase();
    const ext = getExtension(name);

    // dangerous_extension (existing signal).
    if (DANGEROUS_EXT.some((e) => name.endsWith(e))) {
      signals.push(sig("dangerous_extension", 6.0, { filename: name }));
    }

    // attachment_sender_novelty: sender has never sent this file type before.
    if (senderKnownTypes && ext && !senderKnownTypes.includes(ext)) {
      signals.push(sig("attachment_sender_novelty", 2.25,
        { filename: name, extension: ext, known_types: senderKnownTypes.slice(0, 5) }));
    }

    // attachment_entropy_anomaly: high entropy suggests packed/encrypted payload.
    if (att.content) {
      const entropy = shannonEntropy(att.content);
      if (entropy > 7.5) {
        signals.push(sig("attachment_entropy_anomaly", 2.25,
          { filename: name, entropy: Number(entropy.toFixed(2)) }));
      }
    }

    // attachment_type_mismatch: declared extension doesn't match magic bytes.
    if (att.content && ext) {
      const magicType = detectMagicType(att.content);
      if (magicType) {
        const extMap = { ".pdf": "pdf", ".zip": "zip", ".exe": "exe", ".rar": "rar",
          ".doc": "ole", ".xls": "ole", ".ppt": "ole", ".png": "png", ".jpg": "jpg" };
        const expectedType = extMap[ext];
        if (expectedType && magicType !== expectedType) {
          signals.push(sig("attachment_type_mismatch", 3.0,
            { filename: name, claimed: ext, actual_magic: magicType }));
        }
      }
    }

    // attachment_macro_context: macro-enabled doc + financial language + compound risk.
    if (MACRO_EXT.some((e) => name.endsWith(e))) {
      const bodyText = email.body_text || "";
      if (FINANCIAL_RE.test(bodyText)) {
        signals.push(sig("attachment_macro_context", 3.0,
          { filename: name, has_financial_language: true }));
      }
    }
  }

  // attachment_relationship_anomaly: this pair exchanges different file types than usual.
  const pairKnownTypes = email._pair_attachment_types || null;
  if (pairKnownTypes && attachments.length > 0) {
    const currentExts = attachments.map((a) => getExtension((a.filename || "").toLowerCase())).filter(Boolean);
    const novelExts = currentExts.filter((e) => !pairKnownTypes.includes(e));
    if (novelExts.length > 0 && pairKnownTypes.length >= 3) {
      signals.push(sig("attachment_relationship_anomaly", 2.25,
        { novel_types: novelExts, pair_known_types: pairKnownTypes }));
    }
  }

  return signals;
}

const app = makeApp("e6_attachment", analyze);
listen(app, "e6_attachment");
