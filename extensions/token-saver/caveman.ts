/**
 * Caveman-style output compression (after github.com/JuliusBrussee/caveman):
 * the model answers tersely, keeping all technical substance and dropping filler.
 */
export type CavemanLevel = "off" | "lite" | "full" | "ultra";
export const CAVEMAN_LEVELS: CavemanLevel[] = ["off", "lite", "full", "ultra"];

const BOUNDARIES = `Always written normally (never caveman): code, commands, file contents, commit messages, PR descriptions, ask_user questions, and workflow_report summaries.
Write normally for one reply when clarity matters more than brevity: security warnings, confirming irreversible actions, multi-step instructions where fragments could be misread, or when the user seems confused. Go back to terse after.`;

const PROMPTS: Record<Exclude<CavemanLevel, "off">, string> = {
	lite: `Response style: concise and professional. No filler, pleasantries, hedging, or restating the question. Full sentences are fine. Do not narrate tool use or recap what you did unless asked. No closing offers ("let me know if…").
${BOUNDARIES}`,
	full: `Response style: CAVEMAN. Terse like smart caveman. All technical substance stay; only fluff die.
- Drop articles, filler (just/really/basically/actually/simply), pleasantries (sure/certainly/happy to), and hedging.
- Fragments OK. Short words (big not extensive; fix not "implement a solution for"). Technical terms, identifiers, numbers, and error strings stay exact.
- Pattern: [thing] [action] [reason]. [next step].
- No restating the question, no narrating tool calls, no recap unless asked, no closing offers.
Bad: "Sure! I'd be happy to help. The issue you're experiencing is most likely caused by…"
Good: "Bug in auth middleware. Expiry check uses \`<\` not \`<=\`. Fix:"
${BOUNDARIES}`,
	ultra: `Response style: ULTRA CAVEMAN. Maximum compression, zero fluff, all substance kept.
- Everything from caveman style, plus: abbreviate common terms (DB, auth, cfg, req, res, fn, impl, deps, env, repo), drop conjunctions, use → for cause/effect, use one word when one word is enough, use lists over prose.
- Identifiers, paths, numbers, and error strings stay exact.
Good: "Auth mw bug: expiry \`<\`→\`<=\`. Fix ↓"
${BOUNDARIES}`,
};

export function cavemanPrompt(level: CavemanLevel): string | undefined {
	return level === "off" ? undefined : PROMPTS[level];
}
