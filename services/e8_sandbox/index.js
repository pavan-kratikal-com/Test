// E8 Sandbox stub. Real impl: Cuckoo or custom Docker-based VM execution,
// 13 dynamic-behavior signals. Cloud-only — never runs on appliance.
import { makeApp, listen } from "@etdp/shared/engineBase";

export function analyze(_email) {
  // Gating decision lives in gateway; sandbox itself is async/queued.
  return [];
}

const app = makeApp("e8_sandbox", analyze);
listen(app, "e8_sandbox");
