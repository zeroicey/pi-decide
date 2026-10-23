import { QuestionnaireDialog, type DialogOutcome } from "../src/ui/dialog.ts";
import { fakeTheme, fakeTui, KEY, makeHarness, stripAnsi } from "../test/harness.ts";
const opts = [
  { label: "LRU", description: "a" },
  { label: "TTL", description: "b" },
];
const qOne = { questions: [{ header: "A", question: "Q?", options: opts }] };
function open(q: any, timeoutSeconds = 0) {
  const outcomes: DialogOutcome[] = [];
  const dialog = new QuestionnaireDialog({ questionnaire: q, ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}), tui: fakeTui() as never, theme: fakeTheme(), keybindings: {} as never, done: (o) => outcomes.push(o) });
  const h = makeHarness(dialog);
  return { dialog, h, outcomes };
}

// 1: keys after settle
{
  const { h, outcomes } = open(qOne);
  h.press(KEY.enter);
  console.log("after submit outcomes:", outcomes.length, JSON.stringify(outcomes[0]));
  try { h.press(KEY.down, KEY.up, KEY.enter, KEY.esc, KEY.tab, "x", KEY.ctrlRightBracket); console.log("post-settle keys: no throw, outcomes=", outcomes.length, JSON.stringify(outcomes.map(o=>o.kind))); } catch(e) { console.log("post-settle THREW:", (e as Error).message); }
}

// 2: 'n' twice 
{
  const { h } = open(qOne);
  h.press(KEY.note, "hello", KEY.note);
  console.log("n twice text:", h.lastText().split("\n").filter(l=>l.includes("hello")||l.includes("Note")).join(" | "));
  h.press(KEY.enter, KEY.enter);
}

// 3: note then Esc then Enter: stale text?
{
  const { h, outcomes } = open({ questions: [{ header: "A", question: "Q?", options: opts }, { header: "B", question: "R?", options: opts }] });
  h.press(KEY.note, "secret note", KEY.esc);
  console.log("after esc in note, screen contains prompt?", h.lastText().includes("secret note"));
  h.press(KEY.enter); // answer A
  h.press(KEY.enter); // answer B -> submit
  h.press(KEY.enter); // submit
  console.log("note leak:", JSON.stringify([...((outcomes[0] as any)?.answers?.entries?.() ?? [])]));
}
