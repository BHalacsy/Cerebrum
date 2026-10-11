/**
 * Convert Mermaid edge-label syntax to the form the renderer supports.
 * `-->|yes|` is not parsed; `-- yes -->` is. Labels containing "|" fall through unmodified.
 */
function rewriteEdgeLabels(src: string): string {
	return src.replace(/(\S)\s*(-[.\-]*-|={2,})>\s*\|([^|\n]+)\|\s*/g, "$1 $2 $3 --> ");
}

/** html-to-markdown-rs prepends a YAML front-matter block of <title>/<meta> tags — strip it. */
function stripFrontMatter(md: string): string {
	return md.replace(/^---\n(?:[^\n]*\n)*?---\n*/, "");
}

/**
 * pi-natives — Rust-native capabilities from oh-my-pi's `@oh-my-pi/pi-natives` N-API addon.
 *
 * Overrides (same schema, output format and renderers as pi's built-ins; fall back to the
 * built-in implementation if the addon fails to load or errors):
 *   grep  — in-process ripgrep engine instead of spawning `rg`
 *   find  — in-process glob walker instead of spawning `fd` (skips node_modules unless the
 *           pattern mentions it; directories get a trailing "/")
 *   read  — `.pdf` files are converted to Markdown (offset/limit page through the Markdown);
 *           every other file goes to the built-in read
 *
 * New tools:
 *   webfetch  — fetch a URL; HTML → Markdown, PDF → Markdown, text passes through
 *   clipboard — read text/image from, or write text to, the system clipboard
 *   mermaid   — render a Mermaid diagram to Unicode/ASCII art
 *
 * Command: /natives — show addon status.
 *
 * grep and find are inactive by default in pi; enable them with `"defaultTools": ["+grep", "+find"]`
 * in settings.json or via /tools.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatDimensionNote,
	formatSize,
	resizeImage,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { natives, nativesStatus, resolveToolPath } from "./natives.ts";

const GREP_DEFAULT_LIMIT = 100;
const FIND_DEFAULT_LIMIT = 1000;

function text(t: string): TextContent {
	return { type: "text", text: t };
}

function isAbort(signal: AbortSignal | undefined, err: unknown): boolean {
	return !!signal?.aborted || (err instanceof Error && /abort/i.test(err.message));
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeLine(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
}

// ---------------------------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------------------------

function registerGrep(pi: ExtensionAPI) {
	const base = createGrepToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		defaultActive: false, // same as the built-in: opt in via defaultTools / --tools / /tools
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd || process.cwd();
			const searchPath = resolveToolPath(params.path, cwd);
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}
			const isDirectory = stat.isDirectory();
			const limit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);
			const contextValue = params.context && params.context > 0 ? params.context : 0;

			let result: Awaited<ReturnType<ReturnType<typeof natives>["grep"]>>;
			try {
				result = await natives().grep({
					pattern: params.literal ? escapeRegex(params.pattern) : params.pattern,
					path: searchPath,
					glob: params.glob,
					ignoreCase: params.ignoreCase ?? false,
					hidden: true,
					gitignore: true,
					maxCount: limit,
					contextBefore: contextValue || undefined,
					contextAfter: contextValue || undefined,
					signal,
				});
			} catch (err) {
				if (isAbort(signal, err)) throw new Error("Operation aborted");
				return base.execute(toolCallId, params, signal, onUpdate, ctx);
			}

			if (result.matches.length === 0) return { content: [text("No matches found")], details: undefined };

			const formatPath = (p: string) => (isDirectory ? p.replace(/\\/g, "/") : path.basename(p));
			let linesTruncated = false;
			const fmt = (s: string) => {
				const t = truncateLine(sanitizeLine(s));
				if (t.wasTruncated) linesTruncated = true;
				return t.text;
			};
			const out: string[] = [];
			for (const m of result.matches) {
				const p = formatPath(m.path);
				for (const c of m.contextBefore ?? []) out.push(`${p}-${c.lineNumber}- ${fmt(c.line)}`);
				out.push(`${p}:${m.lineNumber}: ${fmt(m.line)}`);
				for (const c of m.contextAfter ?? []) out.push(`${p}-${c.lineNumber}- ${fmt(c.line)}`);
			}

			const truncation = truncateHead(out.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: { truncation?: typeof truncation; matchLimitReached?: number; linesTruncated?: boolean } = {};
			const notices: string[] = [];
			if (result.limitReached || result.matches.length >= limit) {
				notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
				details.matchLimitReached = limit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
				details.linesTruncated = true;
			}
			if (notices.length) output += `\n\n[${notices.join(". ")}]`;
			return { content: [text(output)], details: Object.keys(details).length ? details : undefined };
		},
	});
}

// ---------------------------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------------------------

function registerFind(pi: ExtensionAPI) {
	const base = createFindToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		description: `${base.description} Skips node_modules unless the pattern mentions it. Directories end with "/".`,
		defaultActive: false,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd || process.cwd();
			const searchPath = resolveToolPath(params.path, cwd);
			try {
				await fs.access(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}
			const limit = Math.max(1, params.limit ?? FIND_DEFAULT_LIMIT);
			// Mirror the built-in: path-containing patterns match at any depth.
			let pattern = params.pattern;
			if (pattern.includes("/") && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
				pattern = `**/${pattern}`;
			}

			let result: Awaited<ReturnType<ReturnType<typeof natives>["glob"]>>;
			try {
				result = await natives().glob({
					pattern,
					path: searchPath,
					hidden: true,
					gitignore: true,
					maxResults: limit,
					signal,
				});
			} catch (err) {
				if (isAbort(signal, err)) throw new Error("Operation aborted");
				return base.execute(toolCallId, params, signal, onUpdate, ctx);
			}

			if (result.matches.length === 0) {
				return { content: [text("No files found matching pattern")], details: undefined };
			}
			const lines = result.matches.map((m) => {
				const p = m.path.replace(/\\/g, "/");
				return m.fileType === 2 ? `${p}/` : p;
			});
			const truncation = truncateHead(lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let output = truncation.content;
			const details: { truncation?: typeof truncation; resultLimitReached?: number } = {};
			const notices: string[] = [];
			if (lines.length >= limit) {
				notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
				details.resultLimitReached = limit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length) output += `\n\n[${notices.join(". ")}]`;
			return { content: [text(output)], details: Object.keys(details).length ? details : undefined };
		},
	});
}

// ---------------------------------------------------------------------------------------------
// read (PDF support)
// ---------------------------------------------------------------------------------------------

interface PdfDoc {
	key: string;
	markdown: string;
	title?: string;
	pageCount: number;
	pagesNeedingOcr: number[];
	hasEncodingIssues: boolean;
}

const pdfCache = new Map<string, PdfDoc>();

async function convertPdf(bytes: Uint8Array, key: string): Promise<PdfDoc> {
	const hit = pdfCache.get(key);
	if (hit) return hit;
	const r = await natives().pdfToMarkdown(bytes);
	const doc: PdfDoc = { key, ...r };
	pdfCache.set(key, doc);
	if (pdfCache.size > 16) pdfCache.delete(pdfCache.keys().next().value!);
	return doc;
}

function pdfHeader(doc: PdfDoc): string {
	const parts = [`PDF converted to Markdown`, `${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`];
	if (doc.title) parts.unshift(`"${doc.title}"`);
	let h = `[${parts.join(", ")}]`;
	if (doc.pagesNeedingOcr.length) {
		h += `\n[No text layer (scanned/image) on pages: ${doc.pagesNeedingOcr.join(", ")} — content may be missing]`;
	}
	if (doc.hasEncodingIssues) h += "\n[Text encoding issues detected — some characters may be garbled]";
	return h;
}

/** Page through Markdown lines like the built-in read does for text files. */
function pageText(content: string, offset: number | undefined, limit: number | undefined): string {
	const all = content.split("\n");
	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= all.length) return `[Offset ${offset} is beyond end of document (${all.length} lines)]`;
	const end = limit ? Math.min(all.length, start + limit) : all.length;
	const truncation = truncateHead(all.slice(start, end).join("\n"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let out = truncation.content;
	const shownEnd = start + truncation.outputLines;
	if (truncation.truncated || end < all.length) {
		const lastShown = truncation.truncated ? shownEnd : end;
		out += `\n\n[Showing lines ${start + 1}-${lastShown} of ${all.length}. Use offset=${lastShown + 1} to continue.]`;
	}
	return out;
}

function registerRead(pi: ExtensionAPI) {
	const base = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		description: `${base.description} PDF files are converted to Markdown; offset/limit page through the Markdown lines.`,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd || process.cwd();
			const abs = resolveToolPath(params.path, cwd);
			if (!/\.pdf$/i.test(abs)) return base.execute(toolCallId, params, signal, onUpdate, ctx);

			let bytes: Buffer;
			let key: string;
			try {
				const st = await fs.stat(abs);
				key = `${abs}:${st.size}:${st.mtimeMs}`;
				bytes = await fs.readFile(abs);
			} catch {
				return base.execute(toolCallId, params, signal, onUpdate, ctx); // let the built-in report the error
			}
			let doc: PdfDoc;
			try {
				doc = await convertPdf(new Uint8Array(bytes), key);
			} catch (err) {
				throw new Error(`Failed to convert PDF ${abs}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const body = `${pdfHeader(doc)}\n\n${pageText(doc.markdown, params.offset, params.limit)}`;
			return { content: [text(body)], details: undefined, structuredContent: body };
		},
	});
}

// ---------------------------------------------------------------------------------------------
// webfetch
// ---------------------------------------------------------------------------------------------

const MAX_FETCH_BYTES = 20 * 1024 * 1024;

function registerWebfetch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web fetch",
		description:
			"Fetch a URL and return its content as Markdown. HTML pages are converted to clean Markdown (navigation, headers and footers removed unless raw=true); PDFs are converted to Markdown; plain text, JSON and other text types are returned as-is. Use offset/limit to page through long documents.",
		promptSnippet: "Fetch a URL as Markdown (HTML/PDF converted)",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL to fetch" }),
			raw: Type.Optional(Type.Boolean({ description: "Keep full page (no boilerplate removal) for HTML (default: false)" })),
			offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			const url = new URL(params.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
			const timeout = AbortSignal.timeout(30_000);
			const res = await fetch(url, {
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				redirect: "follow",
				headers: {
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) pi-webfetch",
					Accept: "text/html,application/xhtml+xml,application/pdf,text/*;q=0.9,*/*;q=0.5",
				},
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${res.url}`);
			const len = Number(res.headers.get("content-length") ?? 0);
			if (len > MAX_FETCH_BYTES) throw new Error(`Response too large (${formatSize(len)})`);
			const buf = new Uint8Array(await res.arrayBuffer());
			if (buf.byteLength > MAX_FETCH_BYTES) throw new Error(`Response too large (${formatSize(buf.byteLength)})`);
			const type = (res.headers.get("content-type") ?? "").toLowerCase();
			const isPdf = type.includes("application/pdf") || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);

			let header: string;
			let body: string;
			if (isPdf) {
				const doc = await convertPdf(buf, `url:${res.url}:${buf.byteLength}`);
				header = `${res.url}\n${pdfHeader(doc)}`;
				body = doc.markdown;
			} else {
				const decoded = new TextDecoder("utf-8", { fatal: false }).decode(buf);
				const isHtml = type.includes("html") || (!type && /^\s*<(!doctype html|html)/i.test(decoded));
				if (isHtml) {
					body = stripFrontMatter(await natives().htmlToMarkdown(decoded, { cleanContent: !params.raw }));
					header = `${res.url}\n[HTML converted to Markdown]`;
				} else if (type.startsWith("text/") || /json|xml|javascript|yaml|toml|csv/.test(type) || !type) {
					body = decoded;
					header = `${res.url}\n[${type || "unknown content type"}]`;
				} else {
					throw new Error(`Unsupported content type: ${type} (${formatSize(buf.byteLength)})`);
				}
			}
			const out = `${header}\n\n${pageText(body.trim(), params.offset, params.limit)}`;
			return { content: [text(out)], details: { url: res.url, contentType: type, bytes: buf.byteLength } };
		},
	});
}

// ---------------------------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------------------------

function registerClipboard(pi: ExtensionAPI) {
	pi.registerTool({
		name: "clipboard",
		label: "Clipboard",
		description:
			"Access the system clipboard. action=read returns the clipboard text, or the clipboard image if there is no text (set image=true to prefer the image, e.g. a pasted screenshot). action=write copies text to the clipboard. Only use when the user asks to read from or copy to the clipboard.",
		promptSnippet: "Read text/images from or write text to the system clipboard",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "read or write" }),
			text: Type.Optional(Type.String({ description: "Text to copy (action=write)" })),
			image: Type.Optional(Type.Boolean({ description: "action=read: prefer the clipboard image over text" })),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			const n = natives();
			if (params.action === "write") {
				if (params.text === undefined) throw new Error("text is required for action=write");
				n.copyToClipboard(params.text);
				return { content: [text(`Copied ${params.text.length} characters to the clipboard.`)], details: undefined };
			}
			const readImage = async (): Promise<(TextContent | ImageContent)[] | undefined> => {
				const img = await n.readImageFromClipboard();
				if (!img) return undefined;
				const resized = await resizeImage(img.data, img.mimeType);
				if (!resized) return [text(`Clipboard holds a ${img.mimeType} image (${formatSize(img.data.byteLength)}) that is too large to attach.`)];
				const note = formatDimensionNote(resized);
				return [text(`Clipboard image${note ? ` ${note}` : ""}`), { type: "image", data: resized.data, mimeType: resized.mimeType }];
			};
			if (params.image) {
				const c = await readImage();
				if (c) return { content: c, details: undefined };
			}
			const t = await n.readTextFromClipboard();
			if (t) {
				const tr = truncateHead(t);
				const suffix = tr.truncated ? `\n\n[Clipboard text truncated: ${tr.outputLines} of ${tr.totalLines} lines shown]` : "";
				return { content: [text(tr.content + suffix)], details: undefined };
			}
			if (!params.image) {
				const c = await readImage();
				if (c) return { content: c, details: undefined };
			}
			return { content: [text("Clipboard is empty.")], details: undefined };
		},
	});
}

// ---------------------------------------------------------------------------------------------
// mermaid
// ---------------------------------------------------------------------------------------------

function registerMermaid(pi: ExtensionAPI) {
	pi.registerTool({
		name: "mermaid",
		label: "Mermaid",
		description:
			"Render a Mermaid diagram (flowchart/graph, stateDiagram-v2, sequenceDiagram, classDiagram, erDiagram, xychart) to Unicode box-drawing art. Use to show diagrams in the terminal; include the rendered result in your reply inside a code block. The first line must be a diagram header such as 'graph TD' or 'sequenceDiagram' (statements on separate lines, not ';'-joined on the header line). Use '-- label -->' for labelled edges; the '-->|label|' form is rewritten automatically.",
		promptSnippet: "Render Mermaid diagrams to text art for the terminal",
		parameters: Type.Object({
			source: Type.String({ description: "Mermaid diagram source" }),
			ascii: Type.Optional(Type.Boolean({ description: "Use plain ASCII (+-|>) instead of Unicode box drawing" })),
			direction: Type.Optional(
				Type.Union([Type.Literal("TD"), Type.Literal("LR"), Type.Literal("BT"), Type.Literal("RL")], {
					description: "Override layout direction (flowchart/state)",
				}),
			),
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_id, params) {
			// Accept "graph TD; A-->B" one-liners by splitting statements onto lines.
			let src = params.source.trim();
			const firstNl = src.indexOf("\n");
			const firstLine = firstNl === -1 ? src : src.slice(0, firstNl);
			if (firstLine.includes(";")) src = src.replace(/;\s*/g, "\n");
			const art = natives().renderMermaidAscii(rewriteEdgeLabels(src), { useAscii: params.ascii ?? false, direction: params.direction, colorMode: "none" });
			return { content: [text(art)], details: undefined };
		},
	});
}

// ---------------------------------------------------------------------------------------------

export default function piNatives(pi: ExtensionAPI) {
	registerGrep(pi);
	registerFind(pi);
	registerRead(pi);
	registerWebfetch(pi);
	registerClipboard(pi);
	registerMermaid(pi);

	pi.registerCommand("natives", {
		description: "Show pi-natives addon status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(nativesStatus(), "info");
		},
	});
}
