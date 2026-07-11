import type { EmphasisNode, InlineNode, LinkNode, ListItemParts, TableAlign } from './types.js'
import { MAX_DEPTH, SAFE_URL_SCHEMES } from './constants.js'
import { isEscapable, isQuote, isTableStart, isThematicBreak, isWhitespace } from './validators.js'
import { isEmptyString, isNonEmptyArray, isNonEmptyString, parseInteger } from '@orkestrel/contract'

//  Markdown parsing + rendering leaves (pure, total, zero-dependency)
//
// The pure leaf primitives the {@link MarkdownParser} composes: the line / block
// scanners (headings, fences, list items, table rows, quotes, thematic breaks), the
// inline `scan*` engine (emphasis / links / code with backslash escapes), and the HTML
// escaping + URL-sanitization the renderer leans on. Every function is PURE, TOTAL, and
// referentially transparent - malformed input degrades to text, never throws (AGENTS
// §14) - so each is unit-tested in isolation. The ORCHESTRATION that threads these
// together (the block / inline / render recursion) lives in MarkdownParser's methods,
// not here (AGENTS §5): a helper is a functional-core leaf, a method is the
// composition. Inline scanning is index-based (no backtracking regex) so it is
// linear-time - no ReDoS on adversarial input.

//  Text + line utilities

/**
 * Normalize line endings to `\n` and split a markdown document into its lines - CRLF
 * (`\r\n`) and bare CR (`\r`) both collapse to `\n` first, so a Windows-origin
 * document parses identically. A single trailing newline does not yield a final
 * empty line.
 *
 * @param markdown - The raw markdown source
 * @returns The document's lines, line-terminators stripped
 */
export function splitLines(markdown: string): readonly string[] {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
	return lines
}

/**
 * The count of leading space / tab characters on `line` (a tab counts as one) - the
 * indent that decides whether a list item's continuation belongs to the item.
 *
 * @param line - The line to measure
 * @returns The number of leading space / tab characters
 */
export function leadingIndent(line: string): number {
	let count = 0
	for (const character of line) {
		if (character === ' ' || character === '\t') count += 1
		else break
	}
	return count
}

//  Block-level detection

/**
 * Extract an ATX heading line (`#` … `######` followed by text) into its
 * `{ level, text }`, or `undefined` when `line` is not a heading. A run of more than 6
 * `#`s, or `#`s not followed by whitespace + text, is not a
 * heading; an optional closing `###` run is stripped.
 *
 * @param line - The candidate line
 * @returns The heading level (1–6) and its raw inline text, or `undefined`
 */
export function extractHeading(
	line: string,
): { readonly level: number; readonly text: string } | undefined {
	const match = /^(#{1,6})(?:\s+(.*))?$/.exec(line.trimStart())
	if (!match || match[1] === undefined) return undefined
	const level = match[1].length
	const text = (match[2] ?? '').replace(/\s+#+\s*$/, '').trim()
	return { level, text }
}

/**
 * Extract a fenced-code opening line (```` ``` ```` or `~~~`, optionally with an info
 * string) into its `{ marker, lang }`, or `undefined` when `line` is not a fence
 * opener. `marker` is the exact fence run (the closer must match the same character +
 * at least the same length); `lang` is the first word of the info string.
 *
 * @param line - The candidate line
 * @returns The fence marker run and its language tag, or `undefined`
 */
export function extractFence(
	line: string,
): { readonly marker: string; readonly lang: string | undefined } | undefined {
	const match = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line)
	if (!match || match[1] === undefined) return undefined
	const info = (match[2] ?? '').trim()
	// A backtick in a backtick fence's info string is invalid (ambiguous with a span).
	if (match[1].startsWith('`') && info.includes('`')) return undefined
	const lang = isNonEmptyString(info) ? info.split(/\s+/)[0] : undefined
	return { marker: match[1], lang }
}

/**
 * Extract a list-item line (`-` / `*` / `+` bullet, or `1.` / `1)` ordinal, followed by
 * a space) into its {@link ListItemParts}, or `undefined` when `line` is not a list
 * item. `content` is the text after the marker; `marker` is the full marker-plus-space
 * width (for measuring a continuation's indent).
 *
 * @param line - The candidate line
 * @returns The list-item parts, or `undefined` when not a list item
 */
export function extractListItem(line: string): ListItemParts | undefined {
	const unordered = /^(\s*)([-*+])\s+(.*)$/.exec(line)
	if (unordered && unordered[1] !== undefined) {
		const indent = unordered[1].length
		const content = unordered[3] ?? ''
		return { ordered: false, start: 1, content, indent, marker: line.length - content.length }
	}
	const ordered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line)
	if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
		const indent = ordered[1].length
		const content = ordered[3] ?? ''
		return {
			ordered: true,
			start: parseInteger(ordered[2]) ?? 1,
			content,
			indent,
			marker: line.length - content.length,
		}
	}
	return undefined
}

/**
 * Strip one level of blockquote marker (`>` plus one optional following space) from a
 * blockquote line, so the de-quoted lines re-parse as nested blocks.
 *
 * @param line - A blockquote line (per {@link isQuote})
 * @returns The line with its leading `>` (and one space) removed
 */
export function stripQuote(line: string): string {
	return line.replace(/^\s{0,3}>\s?/, '')
}

/**
 * Split one GFM table row into its cell strings - outer pipes are optional, an escaped
 * pipe (`\|`) inside a cell is NOT a separator (it becomes a literal `|`), and the
 * empty leading / trailing cell produced by an outer `|` is dropped.
 *
 * @param row - The raw table row line
 * @returns The row's cells, in column order
 */
export function splitTableRow(row: string): readonly string[] {
	const cells: string[] = []
	let current = ''
	const trimmed = row.trim()
	for (let index = 0; index < trimmed.length; index += 1) {
		const character = trimmed[index]
		if (character === '\\' && trimmed[index + 1] === '|') {
			current += '|'
			index += 1
		} else if (character === '|') {
			cells.push(current)
			current = ''
		} else {
			current += character
		}
	}
	cells.push(current)
	if (isNonEmptyArray<string>(cells) && isEmptyString((cells[0] ?? '').trim())) cells.shift()
	if (isNonEmptyArray<string>(cells) && isEmptyString((cells[cells.length - 1] ?? '').trim()))
		cells.pop()
	return cells
}

/**
 * Derive the per-column {@link TableAlign} list from a GFM delimiter row - `:---`
 * left, `---:` right, `:---:` center, `---` none.
 *
 * @param delimiter - The table's delimiter row
 * @returns One alignment per column, in column order
 */
export function tableAlignments(delimiter: string): readonly TableAlign[] {
	return splitTableRow(delimiter).map((cell) => {
		const text = cell.trim()
		const left = text.startsWith(':')
		const right = text.endsWith(':')
		if (left && right) return 'center'
		if (right) return 'right'
		if (left) return 'left'
		return 'none'
	})
}

//  Block phase

/**
 * Whether the line at `index` starts a NEW block kind (heading / fence / thematic
 * break / blockquote / list / table) - the paragraph collector stops at such a line
 * so a block following a paragraph without a blank line still parses (a trusted-input
 * caller writing a `##` heading directly under a paragraph, with no intervening blank
 * line).
 *
 * @param lines - The document's lines
 * @param index - The line index to test
 * @returns `true` when the line begins a different block
 */
export function startsBlock(lines: readonly string[], index: number): boolean {
	const line = lines[index] ?? ''
	return (
		extractHeading(line) !== undefined ||
		extractFence(line) !== undefined ||
		isThematicBreak(line) ||
		isQuote(line) ||
		extractListItem(line) !== undefined ||
		isTableStart(line, lines[index + 1])
	)
}

//  Inline phase

/**
 * Resolve backslash escapes in a raw string to their literal characters - used for a
 * link `href` (which is not otherwise inline-parsed) and any plain text run.
 *
 * @param text - The raw text possibly carrying `\x` escapes
 * @returns The text with escapable `\x` reduced to `x`
 */
export function unescapeText(text: string): string {
	let out = ''
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index] ?? ''
		if (character === '\\' && isEscapable(text[index + 1] ?? '')) {
			out += text[index + 1] ?? ''
			index += 1
		} else {
			out += character
		}
	}
	return out
}

/**
 * Merge adjacent text nodes into one - the inline scanner emits a text node per
 * unrecognized character, so coalescing keeps the AST clean and assertion-friendly.
 *
 * @param nodes - The inline nodes (possibly with adjacent text runs)
 * @returns The nodes with consecutive text nodes concatenated
 */
export function coalesceText(nodes: readonly InlineNode[]): readonly InlineNode[] {
	const out: InlineNode[] = []
	for (const node of nodes) {
		const last = out[out.length - 1]
		if (node.element === 'text' && last !== undefined && last.element === 'text') {
			out[out.length - 1] = { element: 'text', value: last.value + node.value }
		} else {
			out.push(node)
		}
	}
	return out
}

/**
 * Scan an inline code span at `start` (a `` ` ``-run … a matching `` ` ``-run of the
 * SAME length, the CommonMark rule that lets a span contain backticks). Returns the
 * span's literal text + end index, or `undefined` when no matching closer exists (it
 * then degrades to literal backticks).
 *
 * @param source - The inline source text
 * @param start - The index of the opening backtick
 * @param to - The exclusive end of the scan window
 * @returns The span text + end index, or `undefined`
 */
export function scanCode(
	source: string,
	start: number,
	to: number,
): { readonly value: string; readonly end: number } | undefined {
	let run = 0
	while (start + run < to && source[start + run] === '`') run += 1
	const open = '`'.repeat(run)
	let search = start + run
	for (;;) {
		const closeAt = source.indexOf(open, search)
		if (closeAt === -1 || closeAt + run > to) return undefined
		// The closer must be EXACTLY `run` backticks (not bordered by another backtick).
		if (source[closeAt - 1] !== '`' && source[closeAt + run] !== '`') {
			let value = source.slice(start + run, closeAt)
			if (
				value.length > 2 &&
				value.startsWith(' ') &&
				value.endsWith(' ') &&
				value.trim().length > 0
			) {
				value = value.slice(1, -1)
			}
			return { value, end: closeAt + run }
		}
		search = closeAt + 1
	}
}

/**
 * Scan a link `[text](href)` at `start` - the text runs to a BALANCED `]`, then `(`
 * must immediately follow and the destination runs to the matching `)` (both respect
 * nested delimiters + escapes). Returns the link node, or `undefined` when the shape
 * does not hold (it then degrades to a literal `[`).
 *
 * @param source - The inline source text
 * @param start - The index of the opening `[`
 * @param to - The exclusive end of the scan window
 * @param depth - The current inline-recursion depth (defaults to 0 at the entry point);
 *   at {@link MAX_DEPTH} the link's text children degrade to literal text instead of
 *   recursing further
 * @returns The parsed {@link LinkNode} + end index, or `undefined`
 */
export function scanLink(
	source: string,
	start: number,
	to: number,
	depth = 0,
): { readonly node: LinkNode; readonly end: number } | undefined {
	let bracketDepth = 0
	let close = -1
	for (let index = start; index < to; index += 1) {
		const character = source[index] ?? ''
		if (character === '\\') {
			index += 1
			continue
		}
		if (character === '[') bracketDepth += 1
		else if (character === ']') {
			bracketDepth -= 1
			if (bracketDepth === 0) {
				close = index
				break
			}
		}
	}
	if (close === -1 || source[close + 1] !== '(') return undefined
	let parenDepth = 0
	let parenClose = -1
	for (let index = close + 1; index < to; index += 1) {
		const character = source[index] ?? ''
		if (character === '\\') {
			index += 1
			continue
		}
		if (character === '(') parenDepth += 1
		else if (character === ')') {
			parenDepth -= 1
			if (parenDepth === 0) {
				parenClose = index
				break
			}
		}
	}
	if (parenClose === -1) return undefined
	const href = unescapeText(source.slice(close + 2, parenClose).trim())
	const children = scanInline(source, start + 1, close, depth + 1)
	return { node: { element: 'link', href, children }, end: parenClose + 1 }
}

/**
 * Scan an emphasis run at `start` (`*` / `_`, doubled for strong) - finds the nearest
 * matching closing run of the same marker + width, requiring non-space immediately
 * inside both delimiters (the CommonMark flanking simplification that blocks `* x *`).
 * Returns the emphasis node, or `undefined` when no valid closer exists (it then
 * degrades to a literal marker).
 *
 * @param source - The inline source text
 * @param start - The index of the opening marker
 * @param to - The exclusive end of the scan window
 * @param depth - The current inline-recursion depth (defaults to 0 at the entry point);
 *   at {@link MAX_DEPTH} the emphasis's children degrade to literal text instead of
 *   recursing further
 * @returns The parsed {@link EmphasisNode} + end index, or `undefined`
 */
export function scanEmphasis(
	source: string,
	start: number,
	to: number,
	depth = 0,
): { readonly node: EmphasisNode; readonly end: number } | undefined {
	const marker = source[start] ?? ''
	let run = 0
	while (start + run < to && source[start + run] === marker && run < 2) run += 1
	const strong = run === 2
	const openEnd = start + run
	if (openEnd >= to || isWhitespace(source[openEnd] ?? '')) return undefined
	let index = openEnd
	while (index < to) {
		const character = source[index] ?? ''
		if (character === '\\') {
			index += 2
			continue
		}
		if (character === '`') {
			const span = scanCode(source, index, to)
			index = span ? span.end : index + 1
			continue
		}
		if (character === marker) {
			let closeRun = 0
			while (index + closeRun < to && source[index + closeRun] === marker) closeRun += 1
			if (closeRun >= run && !isWhitespace(source[index - 1] ?? '')) {
				return {
					node: {
						element: 'emphasis',
						strong,
						children: scanInline(source, openEnd, index, depth + 1),
					},
					end: index + run,
				}
			}
			index += closeRun
			continue
		}
		index += 1
	}
	return undefined
}

/**
 * Scan the window `[from, to)` of `source` into inline nodes - the single recursive
 * engine the inline phase runs on (emphasis / link text recurse through it). Linear:
 * each character is consumed once; a failed construct emits its opening character as
 * text and advances by one, so there is no re-scan (no ReDoS).
 *
 * @param source - The inline source text
 * @param from - The inclusive start of the scan window
 * @param to - The exclusive end of the scan window
 * @param depth - The current inline-recursion depth (defaults to 0 at the entry point);
 *   incremented by one on every recursive descent through {@link scanLink} /
 *   {@link scanEmphasis}. At {@link MAX_DEPTH} the window is never scanned for markup -
 *   it emits as a single literal text node - so pathological nesting (`[[[[…`,
 *   `****…`) cannot exhaust the call stack.
 * @returns The parsed inline nodes (NOT yet coalesced)
 */
export function scanInline(
	source: string,
	from: number,
	to: number,
	depth = 0,
): readonly InlineNode[] {
	if (depth >= MAX_DEPTH)
		return from < to ? [{ element: 'text', value: source.slice(from, to) }] : []
	const nodes: InlineNode[] = []
	let index = from
	let pending = ''
	const flush = (): void => {
		if (pending.length > 0) {
			nodes.push({ element: 'text', value: pending })
			pending = ''
		}
	}
	while (index < to) {
		const character = source[index] ?? ''
		if (character === '\\' && index + 1 < to && isEscapable(source[index + 1] ?? '')) {
			pending += source[index + 1] ?? ''
			index += 2
			continue
		}
		if (character === '`') {
			const span = scanCode(source, index, to)
			if (span) {
				flush()
				nodes.push({ element: 'codeSpan', value: span.value })
				index = span.end
				continue
			}
		}
		if (character === '[') {
			const link = scanLink(source, index, to, depth)
			if (link) {
				flush()
				nodes.push(link.node)
				index = link.end
				continue
			}
		}
		if (character === '*' || character === '_') {
			const emphasis = scanEmphasis(source, index, to, depth)
			if (emphasis) {
				flush()
				nodes.push(emphasis.node)
				index = emphasis.end
				continue
			}
		}
		pending += character
		index += 1
	}
	flush()
	return nodes
}

//  Rendering (AST HTML string)

/**
 * HTML-escape text content - `&` / `<` / `>` / `"` / `'` to their entities - so text
 * from a markdown document can never inject markup. The renderer applies this to every
 * text run, code body, and (escaped further) attribute value.
 *
 * @param text - The raw text
 * @returns The HTML-escaped text
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Sanitize + HTML-attribute-escape a link `href` - a destination whose scheme is not
 * in {@link SAFE_URL_SCHEMES} (notably `javascript:` / `data:` / `vbscript:`), or that
 * is protocol-relative (`//host/path`, or a backslash variant a browser normalizes to
 * the same effect - `\\host`, `/\host`, `\/host` - inherits whatever scheme the
 * embedding page is served over, including an unsafe one), is dropped to an empty
 * string; a relative / anchor / scheme-less (and non-protocol-relative) destination
 * (including a SINGLE leading `/` or `\`) is kept;
 * the surviving value is then HTML-escaped. Defence-in-depth against an XSS `href`,
 * even though the input is trusted.
 *
 * @param href - The raw link destination
 * @returns A safe, escaped `href` (empty when the scheme is unsafe or protocol-relative)
 */
export function sanitizeUrl(href: string): string {
	// Strip every whitespace + C0/C1 control codepoint (≤ U+0020 or U+007F–U+009F)
	// anywhere - a `java\tscript:` / embedded-newline scheme-spoofing evasion - by
	// codepoint, not a control-character regex class (AGENTS §1: no disables).
	let cleaned = ''
	for (const character of href) {
		const code = character.codePointAt(0) ?? 0
		if (code > 0x20 && !(code >= 0x7f && code <= 0x9f)) cleaned += character
	}
	if (/^[/\\]{2}/.exec(cleaned)) return ''
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)
	if (scheme && scheme[1] !== undefined && !SAFE_URL_SCHEMES.has(scheme[1].toLowerCase())) return ''
	return escapeHtml(cleaned)
}
