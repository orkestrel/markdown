import type {
	BlockNode,
	EmphasisNode,
	InlineNode,
	LinkNode,
	ListItemNode,
	ListItemParts,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownNode,
	MarkdownRewriteHandler,
	TableAlign,
	TableNode,
} from './types.js'
import { MAX_DEPTH, SAFE_URL_SCHEMES } from './constants.js'
import {
	isBlockNode,
	isEscapable,
	isInlineNode,
	isQuote,
	isTableStart,
	isThematicBreak,
	isWhitespace,
} from './validators.js'
import { isEmptyString, isNonEmptyArray, isNonEmptyString, parseInteger } from '@orkestrel/contract'

//  Markdown parsing + rendering leaves (pure, total, zero-dependency)
//
// The pure leaf primitives {@link parseDocument} composes: the line / block
// scanners (headings, fences, list items, table rows, quotes, thematic breaks), the
// inline `scan*` engine (emphasis / links / code with backslash escapes), and the HTML
// escaping + URL-sanitization the renderer leans on. Every function is PURE, TOTAL, and
// referentially transparent - malformed input degrades to text, never throws (AGENTS
// §14) - so each is unit-tested in isolation. The ORCHESTRATION that threads these
// together (the block / inline / render recursion) lives in parsers.ts's functions,
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
 *
 * @example
 * ```ts
 * splitLines('a\r\nb\nc') // ['a', 'b', 'c']
 * ```
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
 *
 * @example
 * ```ts
 * leadingIndent('  text') // 2
 * ```
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
 *
 * @example
 * ```ts
 * extractHeading('## Title') // { level: 2, text: 'Title' }
 * ```
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
 *
 * @example
 * ```ts
 * extractFence('```ts') // { marker: '```', lang: 'ts' }
 * ```
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
 *
 * @example
 * ```ts
 * extractListItem('- item') // { ordered: false, start: 1, content: 'item', indent: 0, marker: 2 }
 * ```
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
 *
 * @example
 * ```ts
 * stripQuote('> text') // 'text'
 * ```
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
 *
 * @example
 * ```ts
 * splitTableRow('| a | b |') // ['a', 'b']
 * ```
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
 *
 * @example
 * ```ts
 * tableAlignments('| :--- | ---: |') // ['left', 'right']
 * ```
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
 *
 * @example
 * ```ts
 * startsBlock(['text', '## Heading'], 1) // true
 * ```
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
 *
 * @example
 * ```ts
 * unescapeText('\\*hi\\*') // '*hi*'
 * ```
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
 *
 * @example
 * ```ts
 * coalesceText([{ element: 'text', value: 'a' }, { element: 'text', value: 'b' }])
 * // [{ element: 'text', value: 'ab' }]
 * ```
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
 *
 * @example
 * ```ts
 * scanCode('`code`', 0, 6) // { value: 'code', end: 6 }
 * ```
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
 *
 * @example
 * ```ts
 * scanLink('[text](url)', 0, 11)
 * // { node: { element: 'link', href: 'url', children: [...] }, end: 11 }
 * ```
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
 *
 * @example
 * ```ts
 * scanEmphasis('*em*', 0, 4)
 * // { node: { element: 'emphasis', strong: false, children: [...] }, end: 4 }
 * ```
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
 *
 * @example
 * ```ts
 * scanInline('hi *there*', 0, 10) // [{ element: 'text', value: 'hi ' }, { element: 'emphasis', ... }]
 * ```
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
 *
 * @example
 * ```ts
 * escapeHtml('<a>&"\'') // '&lt;a&gt;&amp;&quot;&#39;'
 * ```
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
 *
 * @example
 * ```ts
 * sanitizeUrl('javascript:alert(1)') // ''
 * sanitizeUrl('/path')               // '/path'
 * ```
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

/**
 * Render a {@link MarkdownNode} (typically a {@link MarkdownDocument}) to a safe HTML
 * string - the recursive AST → HTML engine (headings, paragraphs, lists, GFM tables,
 * fenced code, blockquotes, links, emphasis, inline code), escaping every text run and
 * sanitizing every link `href`.
 *
 * @remarks
 * Total: never throws. At {@link MAX_DEPTH} a value-bearing node (`text` / `codeSpan`)
 * degrades to its escaped `value`; any other node degrades to `''` instead of
 * recursing further, so pathologically deep input cannot exhaust the call stack. The
 * recursive engine and its per-shape sub-steps (inline concatenation, table cell,
 * tight list-item) are nested inner functions - the only exported surface is
 * `renderHTML` itself.
 *
 * @param node - The AST node to render (a full document, or any sub-node)
 * @returns The rendered, XSS-safe HTML string
 *
 * @example
 * ```ts
 * renderHTML({ element: 'document', children: [
 *   { element: 'heading', level: 1, children: [{ element: 'text', value: 'Hi' }] },
 * ] })
 * // '<h1>Hi</h1>'
 * ```
 */
export function renderHTML(node: MarkdownNode): string {
	function render(current: MarkdownNode, depth: number): string {
		if (depth >= MAX_DEPTH)
			return 'value' in current && typeof current.value === 'string'
				? escapeHtml(current.value)
				: ''
		switch (current.element) {
			case 'document':
				return current.children.map((child) => render(child, depth + 1)).join('\n')
			case 'heading':
				return `<h${current.level}>${renderInline(current.children, depth)}</h${current.level}>`
			case 'paragraph':
				return `<p>${renderInline(current.children, depth)}</p>`
			case 'thematicBreak':
				return '<hr>'
			case 'blockquote':
				return `<blockquote>\n${current.children.map((child) => render(child, depth + 1)).join('\n')}\n</blockquote>`
			case 'codeBlock': {
				const open =
					current.lang === undefined
						? '<code>'
						: `<code class="language-${escapeHtml(current.lang)}">`
				return `<pre>${open}${escapeHtml(current.code)}</code></pre>`
			}
			case 'list': {
				const items = current.items.map((item) => render(item, depth + 1)).join('\n')
				if (!current.ordered) return `<ul>\n${items}\n</ul>`
				const start = current.start !== 1 ? ` start="${current.start}"` : ''
				return `<ol${start}>\n${items}\n</ol>`
			}
			case 'listItem':
				return `<li>${renderItem(current.children, depth)}</li>`
			case 'table': {
				const head = `<tr>${current.header.map((cell, column) => renderCell('th', cell, current.align[column], depth)).join('')}</tr>`
				const body = current.rows
					.map(
						(row) =>
							`<tr>${row.map((cell, column) => renderCell('td', cell, current.align[column], depth)).join('')}</tr>`,
					)
					.join('\n')
				const bodyHtml = isNonEmptyArray(current.rows) ? `\n<tbody>\n${body}\n</tbody>` : ''
				return `<table>\n<thead>\n${head}\n</thead>${bodyHtml}\n</table>`
			}
			case 'text':
				return escapeHtml(current.value)
			case 'emphasis':
				return current.strong
					? `<strong>${renderInline(current.children, depth + 1)}</strong>`
					: `<em>${renderInline(current.children, depth + 1)}</em>`
			case 'codeSpan':
				return `<code>${escapeHtml(current.value)}</code>`
			case 'link':
				return `<a href="${sanitizeUrl(current.href)}">${renderInline(current.children, depth + 1)}</a>`
			default:
				return ''
		}
	}

	function renderInline(nodes: readonly InlineNode[], depth: number): string {
		return nodes.map((child) => render(child, depth + 1)).join('')
	}

	function renderCell(
		tag: 'th' | 'td',
		cell: readonly InlineNode[],
		align: TableAlign | undefined,
		depth: number,
	): string {
		const style =
			align === 'left' || align === 'right' || align === 'center'
				? ` style="text-align:${align}"`
				: ''
		return `<${tag}${style}>${renderInline(cell, depth + 1)}</${tag}>`
	}

	function renderItem(children: readonly BlockNode[], depth: number): string {
		if (children.length === 1) {
			const only = children[0]
			if (only !== undefined && only.element === 'paragraph')
				return renderInline(only.children, depth)
		}
		return children.map((child) => render(child, depth + 1)).join('\n')
	}

	return render(node, 0)
}

/**
 * Render a {@link MarkdownNode} to its CANONICAL markdown source - the inverse
 * projection of `renderHTML`, and the serializer a `parse(renderMarkdown(doc))`
 * round-trip is built on. Canonical forms: `*em*` / `**strong**` (underscore emphasis
 * normalizes to asterisks), `- ` bullets, `N. ` sequential ordinals (from the list's
 * `start`), `---` thematic breaks, fenced code blocks (backtick run widened past any
 * 3+ backtick run inside the body), ATX headings, `> `-prefixed blockquote lines, GFM
 * tables (1-space-padded cells, `\|`-escaped pipes, an alignment delimiter row), and
 * `[text](href)` links. A `text` node's literal content is backslash-escaped wherever
 * it would otherwise re-parse as markup (AGENTS §14 parse↔render soundness).
 *
 * @remarks
 * Total: never throws. At {@link MAX_DEPTH} a value-bearing node degrades to its
 * escaped `value`; any other node degrades to `''`. Blocks are joined by exactly one
 * blank line; a document with zero blocks renders `''`.
 *
 * @param node - The AST node to render (a full document, or any sub-node)
 * @returns The canonical markdown source
 *
 * @example
 * ```ts
 * renderMarkdown({ element: 'document', children: [
 *   { element: 'heading', level: 2, children: [{ element: 'text', value: 'Hi' }] },
 * ] })
 * // '## Hi'
 * ```
 */
export function renderMarkdown(node: MarkdownNode): string {
	function escapeText(value: string): string {
		let out = ''
		for (let index = 0; index < value.length; index += 1) {
			const character = value[index] ?? ''
			const atLineStart = index === 0 || value[index - 1] === '\n'
			if (
				character === '\\' ||
				character === '*' ||
				character === '_' ||
				character === '`' ||
				character === '[' ||
				character === ']'
			) {
				out += `\\${character}`
				continue
			}
			if (atLineStart) {
				if (character === '#' || character === '>') {
					out += `\\${character}`
					continue
				}
				if ((character === '-' || character === '+') && (value[index + 1] ?? ' ') === ' ') {
					out += `\\${character}`
					continue
				}
				if (/[0-9]/.test(character)) {
					let end = index
					while (end < value.length && /[0-9]/.test(value[end] ?? '')) end += 1
					const marker = value[end]
					if ((marker === '.' || marker === ')') && value[end + 1] === ' ') {
						out += `${value.slice(index, end)}\\${marker}`
						index = end
						continue
					}
				}
			}
			out += character
		}
		return out
	}

	function fenceFor(body: string, minimum: number): string {
		let longest = 0
		let run = 0
		for (const character of body) {
			if (character === '`') {
				run += 1
				longest = Math.max(longest, run)
			} else {
				run = 0
			}
		}
		return '`'.repeat(Math.max(minimum, longest + 1))
	}

	function renderInline(nodes: readonly InlineNode[], depth: number): string {
		return nodes.map((child) => render(child, depth + 1)).join('')
	}

	function renderBlocks(blocks: readonly BlockNode[], depth: number): string {
		return blocks.map((block) => render(block, depth + 1)).join('\n\n')
	}

	function renderItem(item: ListItemNode, marker: string, depth: number): string {
		const body = renderBlocks(item.children, depth + 1)
		const pad = ' '.repeat(marker.length)
		return body
			.split('\n')
			.map((line, index) => (index === 0 ? marker + line : line === '' ? '' : pad + line))
			.join('\n')
	}

	function renderCell(cell: readonly InlineNode[], depth: number): string {
		return renderInline(cell, depth + 1).replace(/\|/g, '\\|')
	}

	function renderTable(current: TableNode, depth: number): string {
		const columns = current.header.length
		const headerRow = `| ${current.header.map((cell) => renderCell(cell, depth)).join(' | ')} |`
		const delimiterRow = `| ${current.align
			.map((align) => {
				if (align === 'left') return ':--'
				if (align === 'right') return '--:'
				if (align === 'center') return ':-:'
				return '---'
			})
			.join(' | ')} |`
		const bodyRows = current.rows.map((row) => {
			const cells: string[] = []
			for (let column = 0; column < columns; column += 1) {
				const cell = row[column]
				cells.push(cell === undefined ? '' : renderCell(cell, depth))
			}
			return `| ${cells.join(' | ')} |`
		})
		return [headerRow, delimiterRow, ...bodyRows].join('\n')
	}

	function render(current: MarkdownNode, depth: number): string {
		if (depth >= MAX_DEPTH)
			return 'value' in current && typeof current.value === 'string'
				? escapeText(current.value)
				: ''
		switch (current.element) {
			case 'document':
				return renderBlocks(current.children, depth)
			case 'heading': {
				const text = renderInline(current.children, depth)
				// A trailing `#` run reads back as an ATX closing sequence on reparse -
				// escape the FIRST `#` of that run so it can't be stripped. Only fire when
				// the char preceding the run isn't a backslash - escapeText already escapes
				// a line-start `#`, and re-escaping it here would double-escape (`## #` -> text
				// "#" -> escapeText "\#" -> would become "\\#" and break round-trip).
				const escaped = text.replace(/(^|[^\\])(#+)$/, (_match, pre: string, hashes: string) => {
					const first = hashes[0] ?? ''
					return `${pre}\\${first}${hashes.slice(1)}`
				})
				return `${'#'.repeat(current.level)} ${escaped}`
			}
			case 'paragraph':
				return renderInline(current.children, depth)
			case 'thematicBreak':
				return '---'
			case 'blockquote': {
				const inner = renderBlocks(current.children, depth)
				return inner
					.split('\n')
					.map((line) => (line === '' ? '>' : `> ${line}`))
					.join('\n')
			}
			case 'codeBlock': {
				const fence = fenceFor(current.code, 3)
				const lang = current.lang === undefined ? '' : current.lang
				return `${fence}${lang}\n${current.code}\n${fence}`
			}
			case 'list': {
				let ordinal = current.start
				const items = current.items.map((item) => {
					const marker = current.ordered ? `${ordinal++}. ` : '- '
					return renderItem(item, marker, depth)
				})
				return items.join('\n')
			}
			case 'listItem':
				return renderBlocks(current.children, depth)
			case 'table':
				return renderTable(current, depth)
			case 'text':
				return escapeText(current.value)
			case 'emphasis': {
				const marker = current.strong ? '**' : '*'
				return `${marker}${renderInline(current.children, depth)}${marker}`
			}
			case 'codeSpan': {
				const fence = fenceFor(current.value, 1)
				const pad = current.value.startsWith('`') || current.value.endsWith('`') ? ' ' : ''
				return `${fence}${pad}${current.value}${pad}${fence}`
			}
			case 'link': {
				// Mirror scanLink's unescape - a href containing `\`, `(`, or `)` must
				// round-trip through the same balanced-paren + backslash-escape scan.
				const href = current.href.replace(/[\\()]/g, (character) => `\\${character}`)
				return `[${renderInline(current.children, depth)}](${href})`
			}
			default:
				return ''
		}
	}

	return render(node, 0)
}

/**
 * Depth-first, pre-order, root-inclusive traversal of a {@link MarkdownNode} - yields
 * the node itself, then recurses into its children (block children, list items, table
 * header/row cells' inline nodes) in walk order.
 *
 * @remarks
 * Total: never throws. Descent stops at {@link MAX_DEPTH} (the node at the cap is
 * still yielded; its children are not) so pathologically deep input cannot exhaust
 * the call stack.
 *
 * @param node - The AST node to walk (a full document, or any sub-node)
 * @returns A generator yielding every visited node, pre-order
 *
 * @example
 * ```ts
 * const doc = { element: 'document', children: [{ element: 'thematicBreak' }] } as const
 * [...walkNodes(doc)].map((node) => node.element) // ['document', 'thematicBreak']
 * ```
 */
export function* walkNodes(node: MarkdownNode): Generator<MarkdownNode> {
	function* walk(current: MarkdownNode, depth: number): Generator<MarkdownNode> {
		yield current
		if (depth >= MAX_DEPTH) return
		switch (current.element) {
			case 'document':
			case 'heading':
			case 'paragraph':
			case 'blockquote':
			case 'listItem':
			case 'emphasis':
			case 'link':
				for (const child of current.children) yield* walk(child, depth + 1)
				return
			case 'list':
				for (const item of current.items) yield* walk(item, depth + 1)
				return
			case 'table':
				for (const cell of current.header) for (const inline of cell) yield* walk(inline, depth + 1)
				for (const row of current.rows)
					for (const cell of row) for (const inline of cell) yield* walk(inline, depth + 1)
				return
			default:
				return
		}
	}
	yield* walk(node, 0)
}

/**
 * Fold a {@link MarkdownNode} into a `T` via a total catamorphism - children are
 * folded first (post-order), then the node's own {@link MarkdownHandler} is invoked
 * with the already-folded children.
 *
 * @remarks
 * **Table contract.** A {@link TableNode} has no single `children` array - its cells
 * live in `header` (one inline-node list per column) and `rows` (a list of such
 * rows). The `table` handler receives ONE folded `T` per inline node, flattened in
 * walk order across ALL cells - every header cell's inline nodes (column order), then
 * every body row's cells' inline nodes (row order, then column order) - and reads
 * `node.header[c].length` / `node.rows[r][c].length` off the table node itself to
 * recover cell boundaries within the flat list.
 *
 * Total: never throws. At `depth >= {@link MAX_DEPTH}` the node's handler is invoked
 * with an empty children list instead of recursing further.
 *
 * @param node - The AST node to fold
 * @param handlers - The total {@link MarkdownHandlers} table, one handler per element
 * @param depth - The starting recursion depth (pass `0` at the entry point)
 * @returns The folded `T`
 *
 * @example
 * ```ts
 * const countHandlers: MarkdownHandlers<number> = {
 *   document: (_, children) => children.reduce((a, b) => a + b, 1),
 *   // ...one handler per element, each summing its folded children
 * }
 * foldNode(document, countHandlers, 0) // total node count
 * ```
 */
export function foldNode<T>(node: MarkdownNode, handlers: MarkdownHandlers<T>, depth: number): T {
	function dispatch(current: MarkdownNode, children: readonly T[]): T {
		switch (current.element) {
			case 'document':
				return handlers.document(current, children)
			case 'heading':
				return handlers.heading(current, children)
			case 'paragraph':
				return handlers.paragraph(current, children)
			case 'thematicBreak':
				return handlers.thematicBreak(current, children)
			case 'blockquote':
				return handlers.blockquote(current, children)
			case 'codeBlock':
				return handlers.codeBlock(current, children)
			case 'list':
				return handlers.list(current, children)
			case 'listItem':
				return handlers.listItem(current, children)
			case 'table':
				return handlers.table(current, children)
			case 'text':
				return handlers.text(current, children)
			case 'emphasis':
				return handlers.emphasis(current, children)
			case 'codeSpan':
				return handlers.codeSpan(current, children)
			case 'link':
				return handlers.link(current, children)
		}
	}

	function childNodes(current: MarkdownNode): readonly MarkdownNode[] {
		switch (current.element) {
			case 'document':
			case 'heading':
			case 'paragraph':
			case 'blockquote':
			case 'listItem':
			case 'emphasis':
			case 'link':
				return current.children
			case 'list':
				return current.items
			case 'table': {
				const header = current.header.flatMap((cell) => cell)
				const rows = current.rows.flatMap((row) => row.flatMap((cell) => cell))
				return [...header, ...rows]
			}
			default:
				return []
		}
	}

	function fold(current: MarkdownNode, level: number): T {
		if (level >= MAX_DEPTH) return dispatch(current, [])
		const children = childNodes(current).map((child) => fold(child, level + 1))
		return dispatch(current, children)
	}

	return fold(node, depth)
}

/**
 * Rewrite a {@link MarkdownDocument} bottom-up (copy-on-write) - each node's children
 * are rewritten first (post-order), then `rewrite` is applied to the node itself; the
 * document ROOT is never passed to `rewrite` (the `element: 'document'` invariant
 * always holds). A table's inline cells and a list's items ARE rewritten.
 *
 * @remarks
 * Never mutates `document` - every level is rebuilt into a fresh object/array, even
 * when `rewrite` returns its input unchanged. When `rewrite` returns a node whose
 * `element` does not fit the slot it was called for (a block slot handed a
 * non-{@link BlockNode}, an inline slot handed a non-{@link InlineNode}, a list-item
 * slot handed a non-`listItem`), the ill-fitting result is discarded and the
 * freshly-rebuilt (unrewritten-at-this-level) node is kept instead - `rewriteDocument`
 * stays total and never produces a structurally invalid document.
 *
 * Descent is capped at {@link MAX_DEPTH}, the same cap {@link walkNodes} and
 * {@link foldNode} observe: at `depth >= MAX_DEPTH` the subtree is passed through
 * UNCHANGED (by reference, not rebuilt, and `rewrite` is not invoked on it) instead of
 * recursing further, so a pathologically deep adopted document cannot exhaust the
 * call stack. {@link MarkdownInterface.map} inherits this cap since it delegates here.
 *
 * @param document - The document AST to rewrite
 * @param rewrite - The bottom-up {@link MarkdownRewriteHandler}
 * @returns A new, rewritten {@link MarkdownDocument}
 *
 * @example
 * ```ts
 * rewriteDocument(document, (node) =>
 *   node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
 * )
 * ```
 */
export function rewriteDocument(
	document: MarkdownDocument,
	rewrite: MarkdownRewriteHandler,
): MarkdownDocument {
	function rewriteInline(node: InlineNode, depth: number): InlineNode {
		if (depth >= MAX_DEPTH) return node
		const rebuilt = rebuildInline(node, depth)
		const result = rewrite(rebuilt)
		return isInlineNode(result) ? result : rebuilt
	}

	function rewriteBlock(node: BlockNode, depth: number): BlockNode {
		if (depth >= MAX_DEPTH) return node
		const rebuilt = rebuildBlock(node, depth)
		const result = rewrite(rebuilt)
		return isBlockNode(result) ? result : rebuilt
	}

	function rewriteItem(item: ListItemNode, depth: number): ListItemNode {
		if (depth >= MAX_DEPTH) return item
		const rebuilt: ListItemNode = {
			element: 'listItem',
			children: item.children.map((child) => rewriteBlock(child, depth + 1)),
		}
		const result = rewrite(rebuilt)
		return result.element === 'listItem' ? result : rebuilt
	}

	function rebuildInline(node: InlineNode, depth: number): InlineNode {
		switch (node.element) {
			case 'emphasis':
				return { ...node, children: node.children.map((child) => rewriteInline(child, depth + 1)) }
			case 'link':
				return { ...node, children: node.children.map((child) => rewriteInline(child, depth + 1)) }
			case 'text':
			case 'codeSpan':
				return node
		}
	}

	function rebuildBlock(node: BlockNode, depth: number): BlockNode {
		switch (node.element) {
			case 'heading':
				return { ...node, children: node.children.map((child) => rewriteInline(child, depth + 1)) }
			case 'paragraph':
				return { ...node, children: node.children.map((child) => rewriteInline(child, depth + 1)) }
			case 'blockquote':
				return { ...node, children: node.children.map((child) => rewriteBlock(child, depth + 1)) }
			case 'list':
				return { ...node, items: node.items.map((item) => rewriteItem(item, depth + 1)) }
			case 'table':
				return {
					...node,
					header: node.header.map((cell) => cell.map((inline) => rewriteInline(inline, depth + 1))),
					rows: node.rows.map((row) =>
						row.map((cell) => cell.map((inline) => rewriteInline(inline, depth + 1))),
					),
				}
			case 'codeBlock':
			case 'thematicBreak':
				return node
		}
	}

	return { element: 'document', children: document.children.map((child) => rewriteBlock(child, 0)) }
}

/**
 * Concatenate the `value` / `code` content of every descendant text / code-span /
 * code-block node under `node`, in walk order - the plain-text projection of an AST
 * (search indexing, word counts, a text-only preview).
 *
 * @remarks
 * Total: never throws. Descent stops at {@link MAX_DEPTH} (contributes `''` past the
 * cap instead of recursing further).
 *
 * @param node - The AST node to flatten (a full document, or any sub-node)
 * @returns The concatenated text content
 *
 * @example
 * ```ts
 * flattenText({ element: 'paragraph', children: [
 *   { element: 'text', value: 'a ' },
 *   { element: 'codeSpan', value: 'b' },
 * ] })
 * // 'a b'
 * ```
 */
export function flattenText(node: MarkdownNode): string {
	function flatten(current: MarkdownNode, depth: number): string {
		if (depth >= MAX_DEPTH) return ''
		switch (current.element) {
			case 'text':
				return current.value
			case 'codeSpan':
				return current.value
			case 'codeBlock':
				return current.code
			case 'document':
			case 'heading':
			case 'paragraph':
			case 'blockquote':
			case 'listItem':
			case 'emphasis':
			case 'link':
				return current.children.map((child) => flatten(child, depth + 1)).join('')
			case 'list':
				return current.items.map((item) => flatten(item, depth + 1)).join('')
			case 'table': {
				const header = current.header
					.map((cell) => cell.map((inline) => flatten(inline, depth + 1)).join(''))
					.join('')
				const rows = current.rows
					.map((row) =>
						row.map((cell) => cell.map((inline) => flatten(inline, depth + 1)).join('')).join(''),
					)
					.join('')
				return header + rows
			}
			case 'thematicBreak':
				return ''
			default:
				return ''
		}
	}
	return flatten(node, 0)
}
