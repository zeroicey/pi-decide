import { validateQuestionnaire } from "../src/tool/validate.ts";
import { defaultConfig } from "../src/config.ts";
const limits = defaultConfig().limits;
const show = (name: string, raw: unknown) => {
  let out: string;
  try { out = JSON.stringify(validateQuestionnaire(raw as never, limits)); } catch (e) { out = "THREW " + (e as Error).message; }
  console.log(name, "=>", out.slice(0, 300));
};
const ok2 = (label1: unknown, label2: unknown, extra: Record<string, unknown> = {}) => ({
  questions: [{ header: "H", question: "Q?", options: [{ label: label1, description: "d1" }, { label: label2, description: "d2" }], ...extra }],
});
show("label number", ok2(5, "B"));
show("label null", ok2(null, "B"));
show("label object", ok2({}, "B"));
show("description number", ok2("A", "B"));
show("desc NaN", { questions: [{ header: "H", question: "Q?", options: [{ label: "A", description: Number.NaN }, { label: "B", description: "d" }] }] });
show("desc number", { questions: [{ header: "H", question: "Q?", options: [{ label: "A", description: 42 }, { label: "B", description: "d" }] }] });
show("recommended number", ok2("A", "B", { recommended: 5 }));
show("recommended obj", ok2("A", "B", { recommended: { label: "A" } }));
show("recommendedBecause number", ok2("A", "B", { recommended: "A", recommendedBecause: 42 }));
show("category number", ok2("A", "B", { category: 42 }));
show("category obj", ok2("A", "B", { category: { a: 1 } }));
show("context number", { questions: [{ header: "H", question: "Q?", options: [{ label: "A", description: "d" }, { label: "B", description: "d" }] }], context: 42 });
show("mode object", { ...ok2("A", "B"), mode: { x: 1 } });
show("multiSelect string", ok2("A", "B", { multiSelect: "true" }));
show("preview number", { questions: [{ header: "H", question: "Q?", options: [{ label: "A", description: "d", preview: 42 }, { label: "B", description: "d" }] }] });
show("sparse questions", { questions: new Array(3) });
show("question number", { questions: [{ header: "H", question: 42, options: [{ label: "A", description: "d" }, { label: "B", description: "d" }] }] });
show("header number", { questions: [{ header: 42, question: "Q?", options: [{ label: "A", description: "d" }, { label: "B", description: "d" }] }] });
show("options string", { questions: [{ header: "H", question: "Q?", options: "ab" }] });
show("zwsp labels", ok2("LRU\u200b", "LRU"));
show("fullwidth", ok2("LRU", "ＬＲＵ"));
show("nbsp only labels", ok2("\u00a0", "B"));
show("fullwidth space collapse", ok2("A\u3000B", "A B"));
show("zero width label", ok2("\u200b", "B"));
show("nfd vs nfc", ok2("café", "cafe\u0301"));
