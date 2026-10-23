import { renderDialog, MIN_WIDTH, type ViewState } from "../src/ui/view.ts";
import { PLAIN_PALETTE } from "../src/ui/palette.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

function mk(over: Partial<ViewState> = {}): ViewState {
  return {
    tabs: [{ header: "A", question: "Which one?", answered: false }],
    tab: 0,
    options: [
      { kind: "option", label: "LRU", description: "evict least recently used", recommended: true },
      { kind: "custom", label: "Type something." },
      { kind: "note", label: "Add a note" },
    ],
    index: 0,
    focus: "browse",
    ...over,
  };
}
// fuzz widths
const states: Record<string, ViewState> = {
  plain: mk(),
  tabs8: mk({ tabs: Array.from({ length: 8 }, (_, i) => ({ header: `Q${i}`, question: "x?", answered: i % 2 === 0 })), tab: 3 }),
  emptyLabel: mk({ options: [{ kind: "option", label: "", description: "" }, { kind: "note", label: "" }] }),
  countdown0: mk({ countdown: 0 }),
  preview: mk({ options: [{ kind: "option", label: "P", description: "d", preview: "\tcol1\tcol2\n" + "x".repeat(200) + "\n\u001b[31mred\u001b[0m" }] }),
  submit: mk({ tab: 1, tabs: [{ header: "A", question: "q?", answered: true, text: "t", note: "n" }] }),
  editor: mk({ focus: "type", editorLines: ["x".repeat(300)] }),
  cjk: mk({ tabs: [{ header: "缓存策略", question: "选哪个?", answered: false }], options: [{ kind: "option", label: "缓存", description: "描述".repeat(20) }] }),
  emoji: mk({ tabs: [{ header: "🤖👨‍👩‍👧‍👦", question: "😀".repeat(50), answered: false }], options: [{ kind: "option", label: "🎉".repeat(10), description: "🎉".repeat(40), preview: "🎉".repeat(100) }] }),
  bidi: mk({ tabs: [{ header: "\u202eabc", question: "x\u202dy", answered: false }] }),
};
let bad = 0;
for (const [name, st] of Object.entries(states)) {
  for (let w = 0; w <= 120; w++) {
    let lines: string[];
    try { lines = renderDialog(st, PLAIN_PALETTE, w); } catch (e) { console.log("THREW", name, w, (e as Error).message); bad++; continue; }
    for (const line of lines) {
      const vw = visibleWidth(line);
      if (widthFor(name, w) && vw > widthFor(name, w)!) { console.log("OVERWIDE", name, "w=", w, "vw=", vw, JSON.stringify(line.slice(0, 90))); bad++; break; }
    }
  }
}
function widthFor(name: string, w: number) { return name ? w : undefined; }
console.log("bad count", bad, "MIN_WIDTH", MIN_WIDTH);
