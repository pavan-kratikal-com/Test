// Shared Zod models. Mirrors PRD section 6.3.
import { z } from "zod";

export const Verdict = z.enum(["allow", "note", "quarantine", "block"]);

export const Label = z.enum([
  "ham",
  "spam",
  "marketing",
  "promotion",
  "phishing",
  "bec",
  "malware",
  "suspicious",
  "trash",
]);

export const OrgContext = z.object({
  industry: z.string().default("general"),
  timezone: z.string().default("UTC"),
  business_hours_start: z.number().int().default(8),
  business_hours_end: z.number().int().default(20),
  stats_db_weight: z.number().default(1.0),
  thresholds: z.record(z.any()).default({ block: 15, quarantine: 8, note: 5 }),
}).partial();

export const Email = z.object({
  org_id: z.string(),
  message_id: z.string(),
  sender: z.string(),
  recipients: z.array(z.string()),
  subject: z.string().default(""),
  body_text: z.string().default(""),
  body_html: z.string().nullable().optional(),
  headers: z.record(z.string()).default({}),
  attachments: z.array(z.record(z.any())).default([]),
  received_at: z.string().datetime().optional(),
  raw_mime: z.string().nullable().optional(),
  prior_signals: z.array(z.lazy(() => Signal)).default([]),
  org_context: OrgContext.optional(),
});

export const Signal = z.object({
  engine: z.string(),
  signal: z.string(),
  score: z.number().default(0),
  detail: z.record(z.any()).default({}),
});

export const EngineResponse = z.object({
  engine: z.string(),
  latency_ms: z.number(),
  signals: z.array(Signal).default([]),
  error: z.string().nullable().optional(),
});

export const ThreatScore = z.object({
  category: z.string(),
  score: z.number(),
});

export const IOCs = z.object({
  urls: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  ips: z.array(z.string()).default([]),
  hashes: z.array(z.string()).default([]),
});

export const FinalVerdict = z.object({
  verdict: Verdict,
  confidence: z.number(),
  label: Label,
  threat_score: z.number(),
  reason: z.string(),
  threats: z.array(ThreatScore).default([]),
  signals_fired: z.array(Signal).default([]),
  iocs: IOCs.default({ urls: [], domains: [], ips: [], hashes: [] }),
  actions_taken: z.array(z.string()).default([]),
  pipeline: z.record(z.any()).default({}),
  metadata: z.record(z.any()).default({}),
});
