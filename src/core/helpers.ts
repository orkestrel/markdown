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
 * splitTableRow('|a|b|') // ['a', 'b']
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
 * left, `---:` right, `:---:` center, and `---` as the explicit no-alignment
 * marker represented by `null`.
 *
 * @param delimiter - The table's delimiter row
 * @returns One alignment per column, in column order
 *
 * @example
 * ```ts
 * tableAlignments('| :--- | ---: |') // ['left', 'right']
 * ```
 */
export function tableAlignments(delimiter: string): readonly (TableAlign | null)[] {
	return splitTableRow(delimiter).map((cell) => {
		const text = cell.trim()
		const left = text.startsWith(':')
		const right = text.endsWith(':')
		if (left && right) return 'center'
		if (right) return 'right'
		if (left) return 'left'
		return null
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
 * engine the inline phase runs on (emphasis, link text, and image alternative
 * content recurse through it). Linear:
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
	while (index < to) {
		const character = source[index] ?? ''
		if (character === '\\' && index + 1 < to && isEscapable(source[index + 1] ?? '')) {
			pending += source[index + 1] ?? ''
			index += 2
			continue
		}
		if (character === ' ') {
			let spaceEnd = index
			while (spaceEnd < to && source[spaceEnd] === ' ') spaceEnd += 1
			if (spaceEnd - index >= 2 && source[spaceEnd] === '\n') {
				if (pending.length > 0) {
					nodes.push({ element: 'text', value: pending })
					pending = ''
				}
				nodes.push({ element: 'break' })
				index = spaceEnd + 1
				continue
			}
		}
		let scanned: InlineNode | undefined
		let end = index
		if (character === '`') {
			const span = scanCode(source, index, to)
			if (span) {
				scanned = { element: 'codeSpan', value: span.value }
				end = span.end
			}
		}
		if (character === '!' && source[index + 1] === '[') {
			const link = scanLink(source, index + 1, to, depth)
			if (link) {
				scanned = {
					element: 'image',
					src: link.node.href,
					children: link.node.children,
				}
				end = link.end
			}
		}
		if (character === '[') {
			const link = scanLink(source, index, to, depth)
			if (link) {
				scanned = link.node
				end = link.end
			}
		}
		if (character === '*' || character === '_') {
			const emphasis = scanEmphasis(source, index, to, depth)
			if (emphasis) {
				scanned = emphasis.node
				end = emphasis.end
			}
		}
		if (scanned !== undefined) {
			if (pending.length > 0) {
				nodes.push({ element: 'text', value: pending })
				pending = ''
			}
			nodes.push(scanned)
			index = end
			continue
		}
		pending += character
		index += 1
	}
	if (pending.length > 0) nodes.push({ element: 'text', value: pending })
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
 * recursing further, so pathologically deep input cannot exhaust the call stack.
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
	const stack: {
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
	}[] = [{ node, depth: 0, expanded: false, count: 0 }]
	const values: string[] = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		const current = frame.node
		if (!frame.expanded) {
			if (frame.depth >= MAX_DEPTH) {
				values.push(
					'value' in current && typeof current.value === 'string' ? escapeHtml(current.value) : '',
				)
				continue
			}
			const children: MarkdownNode[] = []
			let depth = frame.depth + 1
			switch (current.element) {
				case 'document':
				case 'heading':
				case 'paragraph':
				case 'blockquote':
					for (const child of current.children) if (child !== undefined) children.push(child)
					break
				case 'listItem': {
					const only = current.children[0]
					if (current.children.length === 1 && only !== undefined && only.element === 'paragraph') {
						for (const child of only.children) if (child !== undefined) children.push(child)
					} else {
						for (const child of current.children) if (child !== undefined) children.push(child)
					}
					break
				}
				case 'emphasis':
				case 'link':
					for (const child of current.children) if (child !== undefined) children.push(child)
					depth += 1
					break
				case 'list':
					for (const child of current.items) if (child !== undefined) children.push(child)
					break
				case 'table':
					for (const cell of current.header)
						if (cell !== undefined)
							for (const child of cell) if (child !== undefined) children.push(child)
					for (const row of current.rows)
						if (row !== undefined)
							for (const cell of row)
								if (cell !== undefined)
									for (const child of cell) if (child !== undefined) children.push(child)
					depth += 1
					break
			}
			stack.push({ ...frame, expanded: true, count: children.length })
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index]
				if (child !== undefined) stack.push({ node: child, depth, expanded: false, count: 0 })
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		let value = ''
		switch (current.element) {
			case 'document':
				value = children.join('\n')
				break
			case 'heading':
				value = `<h${current.level}>${children.join('')}</h${current.level}>`
				break
			case 'paragraph':
				value = `<p>${children.join('')}</p>`
				break
			case 'thematicBreak':
				value = '<hr>'
				break
			case 'blockquote':
				value = `<blockquote>\n${children.join('\n')}\n</blockquote>`
				break
			case 'codeBlock': {
				const open =
					current.lang === undefined
						? '<code>'
						: `<code class="language-${escapeHtml(current.lang)}">`
				value = `<pre>${open}${escapeHtml(current.code)}</code></pre>`
				break
			}
			case 'list': {
				const items = children.join('\n')
				if (!current.ordered) {
					value = `<ul>\n${items}\n</ul>`
					break
				}
				const start = current.start !== 1 ? ` start="${current.start}"` : ''
				value = `<ol${start}>\n${items}\n</ol>`
				break
			}
			case 'listItem':
				value = `<li>${children.join(
					current.children.length === 1 && current.children[0]?.element === 'paragraph' ? '' : '\n',
				)}</li>`
				break
			case 'table': {
				let offset = 0
				const header: string[] = []
				for (const [column, cell] of current.header.entries()) {
					if (cell === undefined) continue
					const align = current.align[column]
					const style =
						align === 'left' || align === 'right' || align === 'center'
							? ` style="text-align:${align}"`
							: ''
					let count = 0
					for (const child of cell) if (child !== undefined) count += 1
					header.push(`<th${style}>${children.slice(offset, offset + count).join('')}</th>`)
					offset += count
				}
				const rows: string[] = []
				for (const row of current.rows) {
					const cells: string[] = []
					for (const [column, cell] of row.entries()) {
						if (cell === undefined) continue
						const align = current.align[column]
						const style =
							align === 'left' || align === 'right' || align === 'center'
								? ` style="text-align:${align}"`
								: ''
						let count = 0
						for (const child of cell) if (child !== undefined) count += 1
						cells.push(`<td${style}>${children.slice(offset, offset + count).join('')}</td>`)
						offset += count
					}
					rows.push(`<tr>${cells.join('')}</tr>`)
				}
				const body = rows.join('\n')
				const bodyHtml = isNonEmptyArray(current.rows) ? `\n<tbody>\n${body}\n</tbody>` : ''
				value = `<table>\n<thead>\n<tr>${header.join('')}</tr>\n</thead>${bodyHtml}\n</table>`
				break
			}
			case 'text':
				value = escapeHtml(current.value)
				break
			case 'emphasis':
				value = current.strong
					? `<strong>${children.join('')}</strong>`
					: `<em>${children.join('')}</em>`
				break
			case 'codeSpan':
				value = `<code>${escapeHtml(current.value)}</code>`
				break
			case 'link':
				value = `<a href="${sanitizeUrl(current.href)}">${children.join('')}</a>`
				break
			default:
				value = ''
				break
		}
		if (stack.length === 0) return value
		values.push(value)
	}
	return ''
}

/**
 * Render a {@link MarkdownNode} to its CANONICAL markdown source - the inverse
 * projection of `renderHTML`, and the serializer a `parse(renderMarkdown(doc))`
 * round-trip is built on. Canonical forms: `*em*` / `**strong**` (underscore emphasis
 * normalizes to asterisks), `- ` bullets, `N. ` sequential ordinals (from the list's
 * `start`), `---` thematic breaks, fenced code blocks (backtick run widened past any
 * 3+ backtick run inside the body), ATX headings, `> `-prefixed blockquote lines, GFM
 * tables (1-space-padded cells, `\|`-escaped pipes, an alignment delimiter row),
 * `[text](href)` links, `![alt](src)` images, and two-space hard breaks. A `text`
 * node's literal content is backslash-escaped wherever it would otherwise re-parse
 * as markup (AGENTS §14 parse↔render soundness).
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
	const stack: {
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
		readonly escaped: string
		readonly escapeBang: boolean
	}[] = [{ node, depth: 0, expanded: false, count: 0, escaped: '', escapeBang: false }]
	const values: string[] = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		const current = frame.node
		if (!frame.expanded) {
			let escaped = ''
			if (
				(frame.depth >= MAX_DEPTH || current.element === 'text') &&
				'value' in current &&
				typeof current.value === 'string'
			) {
				for (let index = 0; index < current.value.length; index += 1) {
					const character = current.value[index] ?? ''
					const atLineStart = index === 0 || current.value[index - 1] === '\n'
					if (
						current.element === 'text' &&
						character === '!' &&
						index === current.value.length - 1 &&
						frame.escapeBang
					) {
						escaped += '\\!'
						continue
					}
					if (
						character === '\\' ||
						character === '*' ||
						character === '_' ||
						character === '`' ||
						character === '[' ||
						character === ']'
					) {
						escaped += `\\${character}`
						continue
					}
					if (atLineStart) {
						if (character === '#' || character === '>') {
							escaped += `\\${character}`
							continue
						}
						if (
							(character === '-' || character === '+') &&
							(current.value[index + 1] ?? ' ') === ' '
						) {
							escaped += `\\${character}`
							continue
						}
						if (/[0-9]/.test(character)) {
							let end = index
							while (end < current.value.length && /[0-9]/.test(current.value[end] ?? '')) end += 1
							const marker = current.value[end]
							if ((marker === '.' || marker === ')') && current.value[end + 1] === ' ') {
								escaped += `${current.value.slice(index, end)}\\${marker}`
								index = end
								continue
							}
						}
					}
					escaped += character
				}
			}
			if (frame.depth >= MAX_DEPTH) {
				values.push(escaped)
				continue
			}
			const groups: (readonly MarkdownNode[])[] = []
			const adjacent: boolean[] = []
			let depth = frame.depth + 1
			switch (current.element) {
				case 'document':
				case 'blockquote':
				case 'listItem':
					groups.push(current.children)
					adjacent.push(false)
					break
				case 'heading':
				case 'paragraph':
				case 'emphasis':
				case 'link':
				case 'image':
					groups.push(current.children)
					adjacent.push(true)
					break
				case 'list':
					groups.push(current.items)
					adjacent.push(false)
					break
				case 'table':
					for (const cell of current.header)
						if (cell !== undefined) {
							groups.push(cell)
							adjacent.push(true)
						}
					for (const row of current.rows) {
						if (row === undefined) continue
						for (let column = 0; column < current.header.length; column += 1) {
							const cell = row[column]
							if (cell !== undefined) {
								groups.push(cell)
								adjacent.push(true)
							}
						}
					}
					depth += 1
					break
			}
			const children: MarkdownNode[] = []
			const escapeBangs: boolean[] = []
			for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
				const group = groups[groupIndex]
				if (group === undefined) continue
				for (let position = 0; position < group.length; position += 1) {
					const child = group[position]
					if (child === undefined) continue
					let escapeBang = false
					if (adjacent[groupIndex] === true) {
						let nextPosition = position + 1
						let next = group[nextPosition]
						while (next === undefined && nextPosition < group.length) {
							nextPosition += 1
							next = group[nextPosition]
						}
						escapeBang = next?.element === 'link'
					}
					children.push(child)
					escapeBangs.push(escapeBang)
				}
			}
			stack.push({ ...frame, expanded: true, count: children.length, escaped })
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index]
				if (child !== undefined)
					stack.push({
						node: child,
						depth,
						expanded: false,
						count: 0,
						escaped: '',
						escapeBang: escapeBangs[index] === true && depth < MAX_DEPTH,
					})
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		let value = ''
		switch (current.element) {
			case 'codeBlock':
			case 'codeSpan': {
				const body = current.element === 'codeBlock' ? current.code : current.value
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
				const fence = '`'.repeat(Math.max(current.element === 'codeBlock' ? 3 : 1, longest + 1))
				if (current.element === 'codeBlock') {
					const lang = current.lang === undefined ? '' : current.lang
					value = `${fence}${lang}\n${current.code}\n${fence}`
					break
				}
				const pad = current.value.startsWith('`') || current.value.endsWith('`') ? ' ' : ''
				value = `${fence}${pad}${current.value}${pad}${fence}`
				break
			}
			case 'break':
				value = '  \n'
				break
			case 'document':
				value = children.join('\n\n')
				break
			case 'heading': {
				const text = children.join('')
				const escaped = text.replace(/(^|[^\\])(#+)$/, (_match, before: string, hashes: string) => {
					const first = hashes[0] ?? ''
					return `${before}\\${first}${hashes.slice(1)}`
				})
				value = `${'#'.repeat(current.level)} ${escaped}`
				break
			}
			case 'paragraph':
				value = children.join('')
				break
			case 'thematicBreak':
				value = '---'
				break
			case 'blockquote':
				value = children
					.join('\n\n')
					.split('\n')
					.map((line) => (line === '' ? '>' : `> ${line}`))
					.join('\n')
				break
			case 'list': {
				const items: string[] = []
				let ordinal = current.start
				for (const body of children) {
					const marker = current.ordered ? `${ordinal}. ` : '- '
					ordinal += 1
					const pad = ' '.repeat(marker.length)
					items.push(
						body
							.split('\n')
							.map((line, index) => (index === 0 ? marker + line : line === '' ? '' : pad + line))
							.join('\n'),
					)
				}
				value = items.join('\n')
				break
			}
			case 'listItem':
				value = children.join('\n\n')
				break
			case 'table': {
				let offset = 0
				const header: string[] = []
				for (const cell of current.header) {
					if (cell === undefined) {
						header.push('')
						continue
					}
					let count = 0
					for (const child of cell) if (child !== undefined) count += 1
					header.push(
						children
							.slice(offset, offset + count)
							.join('')
							.replace(/\|/g, '\\|'),
					)
					offset += count
				}
				const delimiter = current.align.map((align) => {
					if (align === null) return '---'
					if (align === 'left') return ':---'
					if (align === 'right') return '---:'
					if (align === 'center') return ':---:'
					return '---'
				})
				const rows: string[] = []
				for (const row of current.rows) {
					const cells: string[] = []
					for (let column = 0; column < current.header.length; column += 1) {
						const cell = row[column]
						if (cell === undefined) {
							cells.push('')
							continue
						}
						let count = 0
						for (const child of cell) if (child !== undefined) count += 1
						cells.push(
							children
								.slice(offset, offset + count)
								.join('')
								.replace(/\|/g, '\\|'),
						)
						offset += count
					}
					rows.push(`| ${cells.join(' | ')} |`)
				}
				value = [`| ${header.join(' | ')} |`, `| ${delimiter.join(' | ')} |`, ...rows].join('\n')
				break
			}
			case 'text':
				value = frame.escaped
				break
			case 'emphasis': {
				const marker = current.strong ? '**' : '*'
				value = `${marker}${children.join('')}${marker}`
				break
			}
			case 'link':
			case 'image': {
				const destination = current.element === 'link' ? current.href : current.src
				const escaped = destination.replace(/[\\()]/g, (character) => `\\${character}`)
				const prefix = current.element === 'image' ? '!' : ''
				value = `${prefix}[${children.join('')}](${escaped})`
				break
			}
			default:
				value = ''
				break
		}
		if (stack.length === 0) return value
		values.push(value)
	}
	return ''
}

/**
 * Depth-first, pre-order, root-inclusive traversal of a {@link MarkdownNode} - yields
 * the node itself, then recurses into its children (block children, list items,
 * image/link inline children, table header/row cells' inline nodes) in walk order.
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
	const stack: { readonly node: MarkdownNode; readonly depth: number }[] = [{ node, depth: 0 }]
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		yield frame.node
		if (frame.depth >= MAX_DEPTH) continue
		const children: MarkdownNode[] = []
		switch (frame.node.element) {
			case 'document':
			case 'heading':
			case 'paragraph':
			case 'blockquote':
			case 'listItem':
			case 'emphasis':
			case 'link':
			case 'image':
				for (const child of frame.node.children) if (child !== undefined) children.push(child)
				break
			case 'list':
				for (const child of frame.node.items) if (child !== undefined) children.push(child)
				break
			case 'table':
				for (const cell of frame.node.header)
					if (cell !== undefined)
						for (const child of cell) if (child !== undefined) children.push(child)
				for (const row of frame.node.rows)
					if (row !== undefined)
						for (const cell of row)
							if (cell !== undefined)
								for (const child of cell) if (child !== undefined) children.push(child)
				break
		}
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index]
			if (child !== undefined) stack.push({ node: child, depth: frame.depth + 1 })
		}
	}
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
	const stack: {
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
	}[] = [{ node, depth, expanded: false, count: 0 }]
	const values: T[] = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		if (!frame.expanded) {
			const children: MarkdownNode[] = []
			if (frame.depth < MAX_DEPTH) {
				switch (frame.node.element) {
					case 'document':
					case 'heading':
					case 'paragraph':
					case 'blockquote':
					case 'listItem':
					case 'emphasis':
					case 'link':
					case 'image':
						for (const child of frame.node.children) if (child !== undefined) children.push(child)
						break
					case 'list':
						for (const child of frame.node.items) if (child !== undefined) children.push(child)
						break
					case 'table':
						for (const cell of frame.node.header)
							if (cell !== undefined)
								for (const child of cell) if (child !== undefined) children.push(child)
						for (const row of frame.node.rows)
							if (row !== undefined)
								for (const cell of row)
									if (cell !== undefined)
										for (const child of cell) if (child !== undefined) children.push(child)
						break
				}
			}
			stack.push({ ...frame, expanded: true, count: children.length })
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index]
				if (child !== undefined) {
					stack.push({
						node: child,
						depth: frame.depth + 1,
						expanded: false,
						count: 0,
					})
				}
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		let value: T
		switch (frame.node.element) {
			case 'document':
				value = handlers.document(frame.node, children)
				break
			case 'heading':
				value = handlers.heading(frame.node, children)
				break
			case 'paragraph':
				value = handlers.paragraph(frame.node, children)
				break
			case 'thematicBreak':
				value = handlers.thematicBreak(frame.node, children)
				break
			case 'blockquote':
				value = handlers.blockquote(frame.node, children)
				break
			case 'codeBlock':
				value = handlers.codeBlock(frame.node, children)
				break
			case 'list':
				value = handlers.list(frame.node, children)
				break
			case 'listItem':
				value = handlers.listItem(frame.node, children)
				break
			case 'table':
				value = handlers.table(frame.node, children)
				break
			case 'text':
				value = handlers.text(frame.node, children)
				break
			case 'emphasis':
				value = handlers.emphasis(frame.node, children)
				break
			case 'codeSpan':
				value = handlers.codeSpan(frame.node, children)
				break
			case 'break':
				value = handlers.break(frame.node, children)
				break
			case 'link':
				value = handlers.link(frame.node, children)
				break
			case 'image':
				value = handlers.image(frame.node, children)
				break
		}
		if (stack.length === 0) return value
		values.push(value)
	}
	switch (node.element) {
		case 'document':
			return handlers.document(node, [])
		case 'heading':
			return handlers.heading(node, [])
		case 'paragraph':
			return handlers.paragraph(node, [])
		case 'thematicBreak':
			return handlers.thematicBreak(node, [])
		case 'blockquote':
			return handlers.blockquote(node, [])
		case 'codeBlock':
			return handlers.codeBlock(node, [])
		case 'list':
			return handlers.list(node, [])
		case 'listItem':
			return handlers.listItem(node, [])
		case 'table':
			return handlers.table(node, [])
		case 'text':
			return handlers.text(node, [])
		case 'emphasis':
			return handlers.emphasis(node, [])
		case 'codeSpan':
			return handlers.codeSpan(node, [])
		case 'break':
			return handlers.break(node, [])
		case 'link':
			return handlers.link(node, [])
		case 'image':
			return handlers.image(node, [])
	}
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
	const stack: {
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
	}[] = [{ node: document, depth: -1, expanded: false, count: 0 }]
	const values: MarkdownNode[] = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		const current = frame.node
		if (!frame.expanded) {
			if (current.element !== 'document' && frame.depth >= MAX_DEPTH) {
				values.push(current)
				continue
			}
			const children: MarkdownNode[] = []
			switch (current.element) {
				case 'document':
				case 'heading':
				case 'paragraph':
				case 'blockquote':
				case 'listItem':
				case 'emphasis':
				case 'link':
				case 'image':
					for (const child of current.children) if (child !== undefined) children.push(child)
					break
				case 'list':
					for (const child of current.items) if (child !== undefined) children.push(child)
					break
				case 'table':
					for (const cell of current.header)
						if (cell !== undefined)
							for (const child of cell) if (child !== undefined) children.push(child)
					for (const row of current.rows)
						if (row !== undefined)
							for (const cell of row)
								if (cell !== undefined)
									for (const child of cell) if (child !== undefined) children.push(child)
					break
			}
			stack.push({ ...frame, expanded: true, count: children.length })
			const depth = current.element === 'document' ? 0 : frame.depth + 1
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index]
				if (child !== undefined) stack.push({ node: child, depth, expanded: false, count: 0 })
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		let rebuilt: MarkdownNode = current
		switch (current.element) {
			case 'document': {
				const blocks: BlockNode[] = []
				let offset = 0
				for (const block of current.children) {
					if (block === undefined) continue
					const child = children[offset]
					blocks.push(child !== undefined && isBlockNode(child) ? child : block)
					offset += 1
				}
				const result: MarkdownDocument = { element: 'document', children: blocks }
				if (stack.length === 0) return result
				values.push(result)
				continue
			}
			case 'heading':
			case 'paragraph': {
				const inlines: InlineNode[] = []
				let offset = 0
				for (const inline of current.children) {
					if (inline === undefined) continue
					const child = children[offset]
					inlines.push(child !== undefined && isInlineNode(child) ? child : inline)
					offset += 1
				}
				rebuilt = { ...current, children: inlines }
				break
			}
			case 'blockquote': {
				const blocks: BlockNode[] = []
				let offset = 0
				for (const block of current.children) {
					if (block === undefined) continue
					const child = children[offset]
					blocks.push(child !== undefined && isBlockNode(child) ? child : block)
					offset += 1
				}
				rebuilt = { ...current, children: blocks }
				break
			}
			case 'listItem': {
				const blocks: BlockNode[] = []
				let offset = 0
				for (const block of current.children) {
					if (block === undefined) continue
					const child = children[offset]
					blocks.push(child !== undefined && isBlockNode(child) ? child : block)
					offset += 1
				}
				rebuilt = { element: 'listItem', children: blocks }
				break
			}
			case 'emphasis':
			case 'link':
			case 'image': {
				const inlines: InlineNode[] = []
				let offset = 0
				for (const inline of current.children) {
					if (inline === undefined) continue
					const child = children[offset]
					inlines.push(child !== undefined && isInlineNode(child) ? child : inline)
					offset += 1
				}
				rebuilt = { ...current, children: inlines }
				break
			}
			case 'list': {
				const items: ListItemNode[] = []
				let offset = 0
				for (const item of current.items) {
					if (item === undefined) continue
					const child = children[offset]
					items.push(child?.element === 'listItem' ? child : item)
					offset += 1
				}
				rebuilt = { ...current, items }
				break
			}
			case 'table': {
				let offset = 0
				const header: (readonly InlineNode[])[] = []
				for (const cell of current.header) {
					if (cell === undefined) continue
					const inlines: InlineNode[] = []
					for (const inline of cell) {
						if (inline === undefined) continue
						const child = children[offset]
						inlines.push(child !== undefined && isInlineNode(child) ? child : inline)
						offset += 1
					}
					header.push(inlines)
				}
				const rows: (readonly (readonly InlineNode[])[])[] = []
				for (const row of current.rows) {
					if (row === undefined) continue
					const cells: (readonly InlineNode[])[] = []
					for (const cell of row) {
						if (cell === undefined) continue
						const inlines: InlineNode[] = []
						for (const inline of cell) {
							if (inline === undefined) continue
							const child = children[offset]
							inlines.push(child !== undefined && isInlineNode(child) ? child : inline)
							offset += 1
						}
						cells.push(inlines)
					}
					rows.push(cells)
				}
				rebuilt = { ...current, header, rows }
				break
			}
		}
		const result = rewrite(rebuilt)
		let accepted = rebuilt
		switch (current.element) {
			case 'text':
			case 'emphasis':
			case 'codeSpan':
			case 'break':
			case 'link':
			case 'image':
				if (isInlineNode(result)) accepted = result
				break
			case 'heading':
			case 'paragraph':
			case 'list':
			case 'table':
			case 'codeBlock':
			case 'blockquote':
			case 'thematicBreak':
				if (isBlockNode(result)) accepted = result
				break
			case 'listItem':
				if (result.element === 'listItem') accepted = result
				break
		}
		values.push(accepted)
	}
	return { element: 'document', children: [...document.children] }
}

/**
 * Concatenate the `value` / `code` content of every descendant text / code-span /
 * code-block node under `node`, including image alternative content, in walk order -
 * the plain-text projection of an AST (search indexing, word counts, a text-only
 * preview).
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
	const stack: { readonly node: MarkdownNode; readonly depth: number }[] = [{ node, depth: 0 }]
	let value = ''
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined || frame.depth >= MAX_DEPTH) continue
		const children: MarkdownNode[] = []
		switch (frame.node.element) {
			case 'text':
			case 'codeSpan':
				value += frame.node.value
				break
			case 'codeBlock':
				value += frame.node.code
				break
			case 'document':
			case 'heading':
			case 'paragraph':
			case 'blockquote':
			case 'listItem':
			case 'emphasis':
			case 'link':
			case 'image':
				for (const child of frame.node.children) if (child !== undefined) children.push(child)
				break
			case 'list':
				for (const child of frame.node.items) if (child !== undefined) children.push(child)
				break
			case 'table':
				for (const cell of frame.node.header)
					if (cell !== undefined)
						for (const child of cell) if (child !== undefined) children.push(child)
				for (const row of frame.node.rows)
					if (row !== undefined)
						for (const cell of row)
							if (cell !== undefined)
								for (const child of cell) if (child !== undefined) children.push(child)
				break
		}
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index]
			if (child !== undefined) stack.push({ node: child, depth: frame.depth + 1 })
		}
	}
	return value
}
