// E6 Attachment Analyzer stub. Real impl: oletools, pefile, pdfminer, yara,
// Docker-isolated analysis, 27 signals.
import { makeApp, listen } from "@etdp/shared/engineBase";

const DANGEROUS_EXT = [".exe", ".scr", ".js", ".vbs", ".bat", ".jar", ".lnk"];

function analyze(email) {
  const signals = [];
  for (const att of email.attachments || []) {
    const name = (att.filename || "").toLowerCase();
    if (DANGEROUS_EXT.some((ext) => name.endsWith(ext))) {
      signals.push({
        engine: "attachment",
        signal: "dangerous_extension",
        score: 4.0,
        detail: { filename: name },
      });
    }
  }
  return signals;
}

const app = makeApp("e6_attachment", analyze);
listen(app, "e6_attachment");
