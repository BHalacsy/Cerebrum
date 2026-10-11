/**
 * Web search via a self-hosted SearXNG instance (e.g. on a Raspberry Pi).
 *
 * Configuration:
 *   SEARXNG_URL — base URL of the instance (default: http://100.84.228.114:8080)
 *     - Tailscale IP of hextor (reachable via Windows Tailscale from WSL)
 *     - Tailscale:      http://<pi-magicdns-name>:8080
 *     - Tailscale funnel: https://<pi>.<tailnet>.ts.net
 *   SEARXNG_USERNAME / SEARXNG_PASSWORD — HTTP basic auth (optional). May also
 *     be embedded as userinfo in SEARXNG_URL, e.g. https://user:pass@<pi>.<tailnet>.ts.net
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const rawUrl = process.env.SEARXNG_URL ?? "http://100.84.228.114:8080";
const parsedUrl = new URL(rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`);
const SEARXNG_USERNAME = process.env.SEARXNG_USERNAME ?? (parsedUrl.username || undefined);
const SEARXNG_PASSWORD = process.env.SEARXNG_PASSWORD ?? (parsedUrl.password || undefined);
parsedUrl.username = "";
parsedUrl.password = "";
const SEARXNG_URL = parsedUrl.toString().replace(/\/+$/, "");

interface SearxResult {
	title?: string;
	url?: string;
	content?: string;
	engine?: string;
	score?: number;
}

const websearchTool = defineTool({
	name: "websearch",
	label: "Web search",
	description:
		`Search the web via a self-hosted SearXNG metasearch engine (${SEARXNG_URL}). ` +
		"Returns ranked results with title, URL and snippet. " +
		"Use for current events, documentation lookups, and facts you are unsure about. " +
		"Follow up on promising URLs with curl via bash if full page content is needed.",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		max_results: Type.Optional(
			Type.Number({ description: "Maximum number of results to return (default 8, max 20)", default: 8, minimum: 1, maximum: 20 }),
		),
		categories: Type.Optional(
			Type.String({ description: "Comma-separated SearXNG categories, e.g. 'general', 'it', 'news', 'science' (default: general)" }),
		),
		language: Type.Optional(Type.String({ description: "BCP-47 language, e.g. 'en', 'hu' (default: instance default)" })),
	}),

	async execute(_toolCallId, params, signal) {
		const url = new URL("/search", SEARXNG_URL);
		url.searchParams.set("q", params.query);
		url.searchParams.set("format", "json");
		if (params.categories) url.searchParams.set("categories", params.categories);
		if (params.language) url.searchParams.set("language", params.language);

		const max = Math.min(Math.max(params.max_results ?? 8, 1), 20);

		const headers: Record<string, string> = { Accept: "application/json" };
		if (SEARXNG_USERNAME) {
			headers.Authorization = `Basic ${Buffer.from(`${SEARXNG_USERNAME}:${SEARXNG_PASSWORD ?? ""}`).toString("base64")}`;
		}

		let res: Response;
		try {
			res = await fetch(url, { signal, headers });
		} catch (e) {
			throw new Error(
				`Could not reach SearXNG at ${SEARXNG_URL}: ${e instanceof Error ? e.message : String(e)}. ` +
					"Check SEARXNG_URL, Tailscale connectivity, and that the instance allows format=json.",
			);
		}
		if (!res.ok) {
			throw new Error(`SearXNG returned HTTP ${res.status}. If it is 403, enable JSON in settings.yml under search.formats.`);
		}

		const data = (await res.json()) as {
			results?: SearxResult[];
			answers?: string[];
			number_of_results?: number;
		};

		const results = (data.results ?? []).slice(0, max);
		if (results.length === 0 && (data.answers ?? []).length === 0) {
			return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: { count: 0 } };
		}

		const lines: string[] = [];
		if ((data.answers ?? []).length > 0) {
			lines.push("Instant answers:", ...data.answers!.slice(0, 3).map((a) => `- ${a}`), "");
		}
		lines.push(`Results for "${params.query}" (${results.length} shown):`, "");
		results.forEach((r, i) => {
			lines.push(`${i + 1}. ${r.title ?? "(untitled)"}`);
			lines.push(`   ${r.url ?? "(no url)"}`);
			if (r.content) lines.push(`   ${r.content.slice(0, 300)}`);
		});
		lines.push("", "Use bash (curl) to fetch full page content for any of these URLs if needed.");

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { count: results.length, query: params.query },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(websearchTool);
}
