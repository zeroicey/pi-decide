import { QuestionnaireDialog, type DialogOutcome } from "../src/ui/dialog.ts";
import { fakeTheme, fakeTui, KEY, makeHarness } from "../test/harness.ts";
const opts = [
  { label: "LRU", description: "a" },
  { label: "TTL", description: "b" },
];
function open(q: any, timeoutSeconds = 0) {
  const outcomes: DialogOutcome[] = [];
  const dialog = new QuestionnaireDialog({ questionnaire: q, ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}), tui: fakeTui() as never, theme: fakeTheme(), keybindings: {} as never, done: (o) => outcomes.push(o) });
  const h = makeHarness(dialog);
  return { dialog, h, outcomes, dump: () => [...h.lastScreen()].length };
}
const two = { questions: [{ header: "A", question: "QA?", options: opts, multiSelect: true }, { header: "B", question: "QB?", options: opts }] };

// multiSelect state survives tab round-trip
{
  const { h, outcomes } = open(two);
  h.press(KEY.space); // check LRU on A
  h.press(KEY.tab);   // to B
  console.log("B screen has QB:", h.lastText().includes("QB?"));
  h.press(KEY.tab);   // to Submit
  console.log("submit screen:", h.lastText().split("\n").filter(l => l.includes("A ")||l.includes("unanswered")).join(" | "));
  h.press(KEY.tab);   // back to A
  console.log("A still checked:", h.lastText().includes("◉ LRU"));
}

// free-text draft leak: type in A, don't commit; tab away
{
  const { h } = open(two);
  h.press(KEY.down, KEY.down, KEY.down); // Type something
  h.press(KEY.enter); // open editor
  h.press("dr", "a", "f", "t");
  console.log("draft in editor:", h.lastText().includes("draft"));
  h.press(KEY.tab); // is Tab swallowed by editor or moves tab?
  console.log("after tab, still in editor?:", h.lastText().includes("Your answer:"));
  h.press(KEY.esc);
  h.press(KEY.tab);
  console.log("on B now:", h.lastText().includes("QB?"));
  h.press(KEY.enter); // answer B
  h.press(KEY.tab); // to submit
  console.log("submit text:", h.lastText().split("\n").filter(l=>l.includes("draft")||l.includes("(selected)")||l.includes("unanswered")).join(" | "));
}

// space/down in editor
{
  const { h, outcomes } = open(two);
  h.press(KEY.down, KEY.down, KEY.down, KEY.enter);
  h.press("a", "b");
  h.press(KEY.space);
  h.press("c");
  h.press(KEY.down);
  console.log("editor text after space+down:", h.lastText().split("\n").filter(l=>l.includes("ab")).join("|"));
  h.press(KEY.enter);
  console.log("outcome:", JSON.stringify(outcomes.map(o=>o.kind)));
}
