# pi-natives

Rust-native capabilities from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `@oh-my-pi/pi-natives`
N-API addon, wired into Pi. MIT licensed.

## Why this exists

The npm package's own JS loader is **Bun-only** (`import.meta.dir`, `Bun.zstdDecompressSync`) and throws
under Node, which Pi uses. `natives.ts` bypasses it: the addon is standard N-API, so we require the
platform package's `.node` binary directly (`@oh-my-pi/pi-natives-<platform>-<arch>`), picking the AVX2
"modern" build when the CPU supports it (override with `PI_NATIVE_VARIANT=modern|baseline`). The addon
loads lazily on first use (~10 ms).

## What it does

### Overrides (built-in names, built-in schemas, built-in renderers)

Fall back to the built-in implementation if the addon fails to load or errors.

| Tool | Change |
|---|---|
| `grep` | In-process ripgrep engine instead of spawning `rg`. Same output format. |
| `find` | In-process glob walker instead of spawning `fd`. Differences: skips `node_modules` unless the pattern mentions it; directories are included with a trailing `/`. |
| `read` | `.pdf` files are converted to Markdown (cached by path+mtime+size); `offset`/`limit` page through the Markdown lines. Everything else delegates to the built-in read. |

### New tools

| Tool | What it does |
|---|---|
| `webfetch` | Fetch a URL: HTML → clean Markdown (boilerplate removed unless `raw=true`), PDF → Markdown, text types pass through. `offset`/`limit` page through. 30 s timeout, 20 MB cap. |
| `clipboard` | `action=read`: clipboard text, or image if no text (`image=true` prefers image, resized via pi's own image pipeline). `action=write`: copy text. |
| `mermaid` | Render Mermaid diagrams to Unicode box-drawing art. Labels must use `-- label -->` (`-->\|label\|` is rewritten automatically). |

### Command

`/natives` — shows addon version and which `.node` binary was loaded.

## Enabling grep/find

Like the built-ins, the overrides are registered **inactive**. Enabled in `~/.pi/agent/settings.json`:

```json
"defaultTools": ["+grep", "+find"]
```

or per-session via `/tools` or `pi --tools +grep +find`.

## Updating the addon

Pinned in `~/.pi/agent/package.json`. The platform package must match the main package version exactly
(they publish together). omp ships very frequently; bump deliberately, then re-run `tsc` against the
types if signatures changed.

## Not wired up (available in the addon, unused here)

`highlightCode`, `astGrep`/`astMatch`/`astEdit`, `countTokens`, `rasterizeSvg`, `encodeSixel`,
`fuzzyFind`, `diffLines`/`diffWords`, `search` (in-memory grep), `renderSnapcompactPng`,
`Shell`/`PtySession`, `VcsGitRepo`, `DesktopSession` (screen capture), `AudioCapture/Playback`.
The `edit*`/`hashline*` exports are omp-edit-format internals — not useful to Pi.
