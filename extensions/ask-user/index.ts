/**
 * ask_user — lets the agent ask you clarifying questions instead of guessing.
 *
 * Batches several questions in one call (fewer round trips/tokens). Each question can offer options
 * (single choice, with an "other" free-text escape) or be free text. Uses only ctx.ui.select/input,
 * so it works in the TUI and over RPC (e.g. a remote/mobile client). Without UI it tells the model to
 * proceed on stated assumptions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER = "Other (type answer)";
const SKIP = "Skip question";

interface QA {
	question: string;
	answer: string | null;
}

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user one or more clarifying questions and wait for answers. Use when requirements are ambiguous, a decision depends on user preference, or required context (credentials, environment, intent) is missing. Batch related questions into one call. Do not use for things you can find out by reading the code.",
		promptSnippet: "Ask the user clarifying questions (batch them) when context is missing or ambiguous",
		promptGuidelines: [
			"Use ask_user instead of guessing when an assumption would materially change the result; otherwise proceed and state the assumption.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The question. Include brief context so it can be answered without scrolling back." }),
					options: Type.Optional(Type.Array(Type.String(), { description: "Suggested answers (single choice). The user may still type their own." })),
				}),
				{ minItems: 1, maxItems: 8 },
			),
			context: Type.Optional(Type.String({ description: "One-line reason for asking, shown above the questions" })),
		}),
		exposure: "model-only",
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No user is available to answer. Proceed with your best judgment and state your assumptions explicitly." }],
					details: { answers: [] as QA[] },
				};
			}
			const answers: QA[] = [];
			const total = params.questions.length;
			for (let i = 0; i < total; i++) {
				if (signal?.aborted) break;
				const q = params.questions[i];
				const header = `${params.context ? `${params.context}\n\n` : ""}? ${total > 1 ? `(${i + 1}/${total}) ` : ""}${q.question}`;
				let answer: string | undefined;
				if (q.options?.length) {
					const choice = await ctx.ui.select(header, [...q.options, OTHER, SKIP], { signal });
					if (choice === OTHER) answer = await ctx.ui.input(header, "Your answer", { signal });
					else if (choice !== SKIP) answer = choice;
				} else {
					answer = await ctx.ui.input(header, "Your answer (empty = skip)", { signal });
				}
				answers.push({ question: q.question, answer: answer?.trim() ? answer.trim() : null });
			}
			const lines = answers.map((a) => `Q: ${a.question}\nA: ${a.answer ?? "(skipped — use your judgment and state the assumption)"}`);
			if (answers.length < total) lines.push("(user cancelled the remaining questions)");
			return { content: [{ type: "text", text: lines.join("\n\n") }], details: { answers } };
		},
		renderCall(args, theme) {
			const qs = Array.isArray(args.questions) ? args.questions : [];
			const body = qs.map((q: { question?: string }, i: number) => theme.fg("muted", `  ${i + 1}. ${q?.question ?? ""}`)).join("\n");
			return new Text(`${theme.fg("toolTitle", theme.bold("ask_user"))}${args.context ? theme.fg("dim", ` ${args.context}`) : ""}\n${body}`, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const answers = (result.details as { answers?: QA[] } | undefined)?.answers;
			if (!answers?.length) {
				const first = result.content[0];
				return new Text(theme.fg("warning", first?.type === "text" ? first.text : "no answers"), 0, 0);
			}
			return new Text(
				answers.map((a) => (a.answer ? theme.fg("success", "✓ ") + theme.fg("accent", a.answer) : theme.fg("warning", "– skipped"))).join("\n"),
				0,
				0,
			);
		},
	});
}
