import { renderDialog, type ViewState } from "../src/ui/view.ts";
import { ansiPalette } from "../src/ui/palette.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
function mk(over: Partial<ViewState> = {}): ViewState {
  return { tabs: [{ header: "A", question: "Which one?", answered: false }], tab: 0,
    options: [{ kind: "option", label: "LRU", description: "evict least recently used", recommended: true }, { kind: "custom", label: "Type something." }, { kind: "note", label: "Add a note" }],
    index: 0, focus: "browse", ...over };
}
const states: Record<string, ViewState> = {
  plain: mk(),
  tabs8: mk({ tabs: Array.from({ length: 8 }, (_, i) => ({ header: `Question${i}`, question: "x?", answered: i % 2 === 0 })), tab: 3 }),
  emptyLabel: mk({ options: [{ kind: "option", label: "", description: "" }, { kind: "note", label: "" }] }),
  countdown0: mk({ countdown: 0 }),
  preview: mk({ options: [{ kind: "option", label: "P", description: "d", preview: "\tcol1\tcol2\n" + "x".repeat(200) + "\n\u001b[31mred\u001b[0m" }] }),
  submit: mk({ tab: 1, tabs: [{ header: "A", question: "q?", answered: true, text: "t", note: "n" }] }),
  editor: mk({ focus: "type", editorLines: ["x".repeat(300)] }),
  cjk: mk({ tabs: [{ header: "缓存策略", question: "选哪个?", answered: false }], options: [{ kind: "option", label: "缓存", description: "描述" }] }),
  emoji: mk({ tabs: [{ header: "🤖👨‍👩‍👧‍👦", question: "😀".repeat(50), answered: false }], options: [{ kind: "option", label: "🎉".repeat(10), description: "🎉".repeat(40), preview: "🎉".repeat(100) }] }),
  bidi: mk({ tabs: [{ header: "\u202eabc", question: "x\u202dy", answered: false }] }),
  longword: mk({ options: [{ kind: "option", label: "y".repeat(200), description: "z".repeat(300) }] }),
  countdownNeg: mk({ countdown: -5 }),
  bigHint: mk({ autopilotHint: "h".repeat(200), countdown: 30 }),
};
let bad = 0;
for (const [name, st] of Object.entries(states)) {
  for (let w = 24; w <= 120; w++) {
    let lines: string[];
    try { lines = renderDialog(st, ansiPalette(), w); } catch (e) { console.log("THREW", name, w, (e as Error).message); bad++; continue; }
    for (const line of lines) {
      const vw = visibleWidth(line);
      if (vw > w) { console.log("OVERWIDE", name, "w=", w, "vw=", vw, JSON.stringify(line.slice(0, 100))); bad++; break; }
    }
  }
}
console.log("bad", bad);
