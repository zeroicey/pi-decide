import { resolvePolicy, type HostKind } from "../src/policy.ts";
import { defaultConfig } from "../src/config.ts";
const modes = ["off", "on", "auto"] as const;
const sessionModes = [undefined, "off", "on", "auto"] as const;
const perCalls = [undefined, "ask", "auto"] as const;
const hosts: HostKind[] = ["tui", "rpc", "none"];
for (const host of hosts) {
  console.log("=== host", host);
  for (const cfgMode of modes) {
    for (const sm of sessionModes) {
      for (const pc of perCalls) {
        const cfg = { ...defaultConfig(), autopilot: { mode: cfgMode, timeoutSeconds: 30 } };
        const r = resolvePolicy({ config: cfg, ...(sm ? { sessionMode: sm } : {}), ...(pc ? { perCallMode: pc } : {}), host });
        console.log(`cfg=${cfgMode} sess=${String(sm)} pc=${String(pc)} -> mode=${r.mode} ask=${r.ask} to=${r.policy.timeoutSeconds} src=${r.policy.source} | ${r.why}`);
      }
    }
  }
}
