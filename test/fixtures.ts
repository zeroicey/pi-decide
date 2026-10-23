/**
 * Fixtures: questionnaires and session entries shaped like the real ones.
 */

import type { Question, Questionnaire } from "../src/types.ts";

export function question(overrides: Partial<Question> = {}): Question {
	return {
		question: "Which cache eviction policy should the session store use?",
		header: "Cache",
		options: [
			{ label: "LRU", description: "Evict the least recently used entry." },
			{ label: "TTL 5m", description: "Expire entries five minutes after write." },
			{ label: "No cache", description: "Drop the cache and always hit the database." },
		],
		...overrides,
	};
}

export function questionnaire(...questions: Question[]): Questionnaire {
	return { questions: questions.length > 0 ? questions : [question()] };
}

export function messageEntry(role: string, content: unknown, extra: Record<string, unknown> = {}) {
	return { type: "message", id: `${role}-${Math.random()}`, message: { role, content, ...extra } };
}

export function textBlock(text: string) {
	return { type: "text", text };
}
