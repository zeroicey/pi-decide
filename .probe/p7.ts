import { QuestionnaireDialog, type DialogOutcome } from "../src/ui/dialog.ts";
import { fakeTheme, fakeTui, KEY, makeHarness } from "../test/harness.ts";
const opts = [ { label: "LRU", description: "a" }, { label: "TTL", description: "b" } ];
function open(q: any) {
  const outcomes: DialogOutcome[] = [];
  const dialog = new QuestionnaireDialog({ questionnaire: q, tui: fakeTui() as never, theme: fakeTheme(), keybindings: {} as never, done: (o) => outcomes.push(o) });
  return { dialog, h: makeHarness(dialog), outcomes };
}
const one = { questions: [{ header: "A", question: "QA?", options: opts }] };
{
  const { h, outcomes } = open(one);
  h.press(KEY.down, KEY.down, KEY.enter); // Type something -> editor
  h.press("dr", "a", "f", "t");
  console.log("in editor:", h.lastText().includes("Your answer:"));
  h.press(KEY.tab);
  console.log("after tab focus type:", h.lastText().includes("Your answer:"), "outcomes:", JSON.stringify(outcomes.map(o=>o.kind)));
  console.log(h.lastText());
}
