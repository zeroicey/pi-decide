import { renderDialog, renderCollapsed, type ViewState } from "../src/ui/view.ts";
import { PLAIN_PALETTE } from "../src/ui/palette.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
const base = (o: Partial<ViewState> = {}): ViewState => ({ tabs: [{ header: "A", question: "Q?", answered: false }], tab: 0, options: [{ kind: "option", label: "LRU", description: "d" }], index: 0, focus: "browse", ...o });
const cases: Record<string, ViewState> = {
  newlineLabel: base({ options: [{ kind: "option", label: "A\nB", description: "d\ne" }] }),
  newlineHeader: base({ tabs: [{ header: "H\nI", question: "q\nr", answered: false }] }),
  cr: base({ options: [{ kind: "option", label: "A\rB", description: "d\re" }] }),
  longHeader: base({ tabs: [{ header: "H".repeat(300), question: "q?", answered: false }] }),
  longHeader2: base({ tabs: Array.from({length:8},(_, i)=>({header:"Long header name number "+i, question:"q?", answered:false})), tab: 2 }),
};
for (const [name, st] of Object.entries(cases)) {
  for (const w of [24, 40, 80]) {
    let lines: string[] = [];
    try { lines = renderDialog(st, PLAIN_PALETTE, w); } catch (e) { console.log("THREW", name, w, (e as Error).message); continue; }
    const bad = lines.filter(l => visibleWidth(l) > w);
    if (bad.length) console.log("OVERWIDE", name, "w=", w, bad.map(l=>visibleWidth(l)+":"+JSON.stringify(l.slice(0,60))));
    const embedded = lines.filter(l => /[\r\n]/.test(l));
    if (embedded.length) console.log("EMBEDDED-NEWLINE", name, w, JSON.stringify(embedded.slice(0,2)).slice(0,160));
  }
}
// collapsed
for (const [name, st] of Object.entries(cases)) {
  const line = renderCollapsed(st, PLAIN_PALETTE);
  console.log("collapsed", name, "width=", visibleWidth(line));
}
// narrow widths
for (const w of [1, 5, 10, 23, 24]) {
  const lines = renderDialog(base(), PLAIN_PALETTE, w);
  console.log("narrow w=", w, "max=", Math.max(...lines.map(visibleWidth)));
}
