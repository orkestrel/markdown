import type {
	CommentNode,
	DoctypeNode,
	ElementNode,
	HTMLDocument,
	HTMLNode,
	TextNode as HTMLTextNode,
} from '@orkestrel/html'
import type {
	BlockNode,
	EmphasisNode,
	InlineNode,
	LinkNode,
	ListItemNode,
	ListItemMatch,
	ListNode,
	MarkdownCell,
	MarkdownDerivation,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownNode,
	MarkdownProjection,
	MarkdownRewriteHandler,
	MarkdownSegment,
	MarkdownSource,
	MarkdownSpan,
	TableAlign,
	TableNode,
} from './types.js'
import { MAX_DEPTH } from './constants.js'
import { createProjection } from './factories.js'
import {
	isBlankLine,
	isBlockNode,
	isEscapable,
	isInlineNode,
	isQuote,
	isTableStart,
	isThematicBreak,
	isWhitespace,
} from './validators.js'
import { parseBlocks } from './parsers.js'
import { isEmptyString, isNonEmptyArray, isNonEmptyString, parseInteger } from '@orkestrel/contract'
import {
	HTML,
	SAFE_ATTRIBUTES,
	SAFE_URL_SCHEMES,
	TABLE_ALIGNMENTS,
	UNSAFE_ELEMENTS,
	attributeOf,
	foldNode as foldHTMLNode,
	renderHTML as renderHTMLDocument,
	renderText,
	sanitizeURL,
} from '@orkestrel/html'

//  Markdown parsing + rendering leaves (pure and total)
//
// The pure leaf primitives {@link parseDocument} composes: the line / block
// scanners (headings, fences, list items, table rows, quotes, thematic breaks), the
// `collect*` construct scanners (GFM tables and lists), the inline `scan*` engine
// (emphasis / links / code with backslash escapes), and the HTML AST projection the
// renderer composes with @orkestrel/html. Every function is PURE, TOTAL, and
// referentially transparent - malformed input degrades to text, never throws (AGENTS
// §14) - so each is unit-tested in isolation. The `parse*` ENTRY POINTS that thread
// these together (the block / inline phase entries) live in parsers.ts (AGENTS §5): a
// helper is a functional-core leaf, a parser is the phase it names. A construct scanner
// calls back into its phase entry, so helpers.ts and parsers.ts are mutually recursive
// by design. Inline scanning is index-based (no backtracking regex) so it is
// linear-time - no ReDoS on adversarial input.

//  Text + line utilities

/**
 * Splits a markdown document into offset-bearing lines while normalizing CRLF and
 * bare CR terminators at the line boundary. A single trailing terminator does not
 * yield a final empty line.
 *
 * @param markdown - The raw markdown source
 * @returns The document's lines with their original-string coordinates
 *
 * @example
 * ```ts
 * splitLines('a\r\nb') // [{ text: 'a', segments: [{ offset: 0, start: 0, end: 1 }] }, ...]
 * ```
 */
export function splitLines(markdown: string): readonly MarkdownSource[] {
	const lines: MarkdownSource[] = []
	let start = 0
	let index = 0
	while (index < markdown.length) {
		const character = markdown[index]
		if (character !== '\r' && character !== '\n') {
			index += 1
			continue
		}
		lines.push({
			text: markdown.slice(start, index),
			segments: [{ offset: 0, start, end: index }],
		})
		index += character === '\r' && markdown[index + 1] === '\n' ? 2 : 1
		start = index
	}
	lines.push({
		text: markdown.slice(start),
		segments: [{ offset: 0, start, end: markdown.length }],
	})
	if (lines.length > 1 && lines[lines.length - 1]?.text === '') lines.pop()
	return lines
}

/**
 * Slices derived markdown text and narrows each intersecting source segment to the
 * same text-relative range.
 *
 * @param source - The offset-bearing source to slice
 * @param from - The inclusive text offset
 * @param to - The exclusive text offset
 * @returns The sliced text and its narrowed original-string segments
 *
 * @example
 * ```ts
 * sliceSource({ text: 'abc', segments: [{ offset: 0, start: 4, end: 7 }] }, 1, 3)
 * // { text: 'bc', segments: [{ offset: 0, start: 5, end: 7 }] }
 * ```
 */
export function sliceSource(source: MarkdownSource, from: number, to: number): MarkdownSource {
	const start = Math.max(0, Math.min(from, source.text.length))
	const end = Math.max(start, Math.min(to, source.text.length))
	const segments: MarkdownSegment[] = []
	for (let index = 0; index < source.segments.length; index += 1) {
		const segment = source.segments[index]
		if (segment === undefined) continue
		const next = source.segments[index + 1]
		const limit = Math.min(
			segment.offset + (segment.end - segment.start),
			next === undefined ? source.text.length : next.offset,
		)
		const overlapStart = Math.max(start, segment.offset)
		const overlapEnd = Math.min(end, limit)
		const empty = segment.offset === limit && overlapStart === segment.offset
		if (overlapStart >= overlapEnd && !empty) continue
		const originalStart =
			overlapStart === limit
				? segment.end
				: Math.min(segment.end, segment.start + overlapStart - segment.offset)
		const originalEnd =
			overlapEnd === limit
				? segment.end
				: Math.min(segment.end, segment.start + overlapEnd - segment.offset)
		segments.push({
			offset: overlapStart - start,
			start: originalStart,
			end: originalEnd,
		})
	}
	return { text: source.text.slice(start, end), segments }
}

/**
 * Joins offset-bearing markdown sources while mapping a separator to the original
 * region between adjacent mapped sources.
 *
 * @param sources - The sources to join
 * @param separator - The derived text inserted between sources
 * @returns The joined text and every source-backed segment
 *
 * @example
 * ```ts
 * joinSources(splitLines('a\nb'), '\n')
 * // { text: 'a\nb', segments: [...] }
 * ```
 */
export function joinSources(sources: readonly MarkdownSource[], separator: string): MarkdownSource {
	let text = ''
	const segments: MarkdownSegment[] = []
	for (let index = 0; index < sources.length; index += 1) {
		const source = sources[index]
		if (source === undefined) continue
		if (index > 0) {
			const previous = sources[index - 1]
			const left = previous?.segments[previous.segments.length - 1]
			const right = source.segments[0]
			if (
				separator.length > 0 &&
				left !== undefined &&
				right !== undefined &&
				left.end < right.start
			)
				segments.push({ offset: text.length, start: left.end, end: right.start })
			text += separator
		}
		for (const segment of source.segments) {
			segments.push({
				offset: text.length + segment.offset,
				start: segment.start,
				end: segment.end,
			})
		}
		text += source.text
	}
	return { text, segments }
}

/**
 * Projects a derived text range through its segments to a half-open region of the
 * original markdown string.
 *
 * @param source - The offset-bearing source carrying the range
 * @param from - The inclusive derived-text boundary
 * @param to - The exclusive derived-text boundary
 * @returns The original-string span, or `undefined` when either boundary is unmapped
 *
 * @example
 * ```ts
 * projectSpan({ text: 'a', segments: [{ offset: 0, start: 4, end: 5 }] }, 0, 1)
 * // { start: 4, end: 5 }
 * ```
 */
export function projectSpan(
	source: MarkdownSource,
	from: number,
	to: number,
): MarkdownSpan | undefined {
	if (from < 0 || to < from || to > source.text.length) return undefined
	let start: number | undefined
	let end: number | undefined
	for (let index = 0; index < source.segments.length; index += 1) {
		const segment = source.segments[index]
		if (segment === undefined) continue
		const next = source.segments[index + 1]
		const limit = Math.min(
			segment.offset + (segment.end - segment.start),
			next === undefined ? source.text.length : next.offset,
		)
		if (from === to && from >= segment.offset && from <= limit) {
			if (next !== undefined && from === next.offset) continue
			const position =
				from === limit ? segment.end : Math.min(segment.end, segment.start + from - segment.offset)
			return { start: position, end: position }
		}
		if (start === undefined && from >= segment.offset && from < limit)
			start = segment.start + from - segment.offset
		if (to > segment.offset && to <= limit)
			end = to === limit ? segment.end : Math.min(segment.end, segment.start + to - segment.offset)
	}
	return start === undefined || end === undefined ? undefined : { start, end }
}

/**
 * Trims an offset-bearing source without losing the coordinates of its retained text.
 *
 * @param source - The source to trim
 * @returns The trimmed text and its narrowed original-string segments
 *
 * @example
 * ```ts
 * trimSource({ text: ' a ', segments: [{ offset: 0, start: 4, end: 7 }] })
 * // { text: 'a', segments: [{ offset: 0, start: 5, end: 6 }] }
 * ```
 */
export function trimSource(source: MarkdownSource): MarkdownSource {
	const start = source.text.length - source.text.trimStart().length
	const end = source.text.trimEnd().length
	return sliceSource(source, start, Math.max(start, end))
}

/**
 * Normalizes one paragraph line while retaining the full source run consumed by a
 * trailing-space hard break.
 *
 * @param source - The offset-bearing paragraph line
 * @param breaks - If `true`, preserves a trailing run of at least two spaces as the
 *   scanner's two-space hard-break syntax; if `false`, trims the line normally
 * @returns The normalized line and its original-string segments
 *
 * @example
 * ```ts
 * normalizeParagraphLine(splitLines('text   \nnext')[0], true).text // 'text  '
 * ```
 */
export function normalizeParagraphLine(source: MarkdownSource, breaks: boolean): MarkdownSource {
	if (!breaks || !source.text.endsWith('  ')) return trimSource(source)
	const contentEnd = source.text.trimEnd().length
	const content = trimSource(sliceSource(source, 0, contentEnd))
	const span = projectSpan(source, contentEnd, source.text.length)
	const suffix: MarkdownSource = {
		text: '  ',
		segments: span === undefined ? [] : [{ offset: 0, start: span.start, end: span.end }],
	}
	return joinSources([content, suffix], '')
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
 * countIndent('  text') // 2
 * ```
 */
export function countIndent(line: string): number {
	let count = 0
	for (const character of line) {
		if (character === ' ' || character === '\t') count += 1
		else break
	}
	return count
}

//  Block-level detection

/**
 * Extracts an ATX heading line (`#` … `######` followed by text) into its level,
 * trimmed text, and the text's offset inside the line. A run of more than 6 `#`s, or
 * `#`s not followed by whitespace + text, is not a heading; an optional closing
 * `###` run is stripped.
 *
 * @param line - The candidate line
 * @returns The heading level (1–6), raw inline text, and text offset, or `undefined`
 *
 * @example
 * ```ts
 * extractHeading('## Title') // { level: 2, text: 'Title', offset: 3 }
 * ```
 */
export function extractHeading(
	line: string,
): { readonly level: number; readonly text: string; readonly offset: number } | undefined {
	const trimmed = line.trimStart()
	const match = /^(#{1,6})(?:\s+(.*))?$/.exec(trimmed)
	if (!match || match[1] === undefined) return undefined
	const level = match[1].length
	const raw = match[2] ?? ''
	const withoutClosing = raw.replace(/\s+#+\s*$/, '')
	const text = withoutClosing.trim()
	const found = raw.length === 0 ? trimmed.length : trimmed.indexOf(raw, level)
	const content = found < 0 ? trimmed.length : found
	const offset =
		line.length -
		trimmed.length +
		content +
		withoutClosing.length -
		withoutClosing.trimStart().length
	return { level, text, offset }
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
 * a space) into its {@link ListItemMatch}, or `undefined` when `line` is not a list
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
export function extractListItem(line: string): ListItemMatch | undefined {
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
 * Strips one level of blockquote marker (`>` plus one optional following space) from
 * an offset-bearing blockquote line, so the de-quoted source re-parses as nested
 * blocks without losing its original coordinates.
 *
 * @param source - A blockquote line (per {@link isQuote})
 * @returns The source with its leading `>` and optional space removed
 *
 * @example
 * ```ts
 * stripQuote({ text: '> text', segments: [{ offset: 0, start: 0, end: 6 }] })
 * // { text: 'text', segments: [{ offset: 0, start: 2, end: 6 }] }
 * ```
 */
export function stripQuote(source: MarkdownSource): MarkdownSource {
	const marker = /^\s{0,3}>\s?/.exec(source.text)?.[0] ?? ''
	return sliceSource(source, marker.length, source.text.length)
}

/**
 * Split one GFM table row into its cell strings - outer pipes are optional, an escaped
 * pipe (`\|`) inside a cell is NOT a separator (it becomes a literal `|`), and the
 * empty leading / trailing cell produced by an outer `|` is dropped. Derives the string
 * form from {@link splitTableSources}, which owns the escaped-pipe splitting rule.
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
	return splitTableSources({ text: row, segments: [] }).map((cell) => cell.text)
}

/**
 * Splits an offset-bearing GFM table row into offset-bearing cells, retaining the
 * complete source spelling of an escaped pipe while exposing its literal value.
 *
 * @param row - The offset-bearing table row
 * @returns The row's cells with their original-string coordinates
 *
 * @example
 * ```ts
 * splitTableSources(splitLines('| a\\|b |')[0]).map((cell) => cell.text) // [' a|b ']
 * ```
 */
export function splitTableSources(row: MarkdownSource): readonly MarkdownSource[] {
	const source = trimSource(row)
	const cells: MarkdownSource[] = []
	let pieces: MarkdownSource[] = []
	let start = 0
	for (let index = 0; index < source.text.length; index += 1) {
		const character = source.text[index]
		if (character === '\\' && source.text[index + 1] === '|') {
			pieces.push(sliceSource(source, start, index))
			const span = projectSpan(source, index, index + 2)
			pieces.push({
				text: '|',
				segments: span === undefined ? [] : [{ offset: 0, start: span.start, end: span.end }],
			})
			index += 1
			start = index + 1
			continue
		}
		if (character !== '|') continue
		pieces.push(sliceSource(source, start, index))
		cells.push(joinSources(pieces, ''))
		pieces = []
		start = index + 1
	}
	pieces.push(sliceSource(source, start, source.text.length))
	cells.push(joinSources(pieces, ''))
	if (isNonEmptyArray<MarkdownSource>(cells) && isEmptyString((cells[0]?.text ?? '').trim()))
		cells.shift()
	if (
		isNonEmptyArray<MarkdownSource>(cells) &&
		isEmptyString((cells[cells.length - 1]?.text ?? '').trim())
	)
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
 * delimiterToAlignments('| :--- | ---: |') // ['left', 'right']
 * ```
 */
export function delimiterToAlignments(delimiter: string): ReadonlyArray<TableAlign | null> {
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
 * @param spans - The optional operation-owned node span recorder
 * @returns The nodes with consecutive text nodes concatenated
 *
 * @example
 * ```ts
 * coalesceText([{ element: 'text', value: 'a' }, { element: 'text', value: 'b' }])
 * // [{ element: 'text', value: 'ab' }]
 * ```
 */
export function coalesceText(
	nodes: readonly InlineNode[],
	spans?: Map<MarkdownNode, MarkdownSpan>,
): readonly InlineNode[] {
	const out: InlineNode[] = []
	for (const node of nodes) {
		const last = out[out.length - 1]
		if (node.element === 'text' && last !== undefined && last.element === 'text') {
			const merged: InlineNode = { element: 'text', value: last.value + node.value }
			const left = spans?.get(last)
			const right = spans?.get(node)
			if (spans !== undefined) {
				spans.delete(last)
				spans.delete(node)
				if (left !== undefined && right !== undefined)
					spans.set(merged, { start: left.start, end: right.end })
			}
			out[out.length - 1] = merged
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
 * Locates a link `[text](href)` at `start` - the text runs to a BALANCED `]`, then `(`
 * must immediately follow and the destination runs to the matching `)` (both respect
 * nested delimiters + escapes). Returns the label close and syntax end, or `undefined` when the shape
 * does not hold (it then degrades to a literal `[`).
 *
 * @param source - The inline source text
 * @param start - The index of the opening `[`
 * @param to - The exclusive end of the scan window
 * @returns The label close and syntax end indices, or `undefined`
 *
 * @example
 * ```ts
 * locateLink('[text](url)', 0, 11) // { close: 5, end: 11 }
 * ```
 */
export function locateLink(
	source: string,
	start: number,
	to: number,
): { readonly close: number; readonly end: number } | undefined {
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
	return { close, end: parenClose + 1 }
}

/**
 * Scans a link `[text](href)` at `start` - the text runs to a BALANCED `]`, then `(`
 * must immediately follow and the destination runs to the matching `)` (both respect
 * nested delimiters + escapes) through {@link locateLink}, and returns the parsed node
 * and end index. Returns `undefined` when the shape does not hold (it then degrades to
 * a literal `[`).
 *
 * @param source - The inline source text
 * @param start - The index of the opening `[`
 * @param to - The exclusive end of the scan window
 * @param depth - The current inline-recursion depth, forwarded to {@link scanInline}
 *   incremented by one for the link text's children. At {@link MAX_DEPTH} that
 *   recursion emits the text as a single literal text node instead of scanning it.
 * @returns The parsed link and end index, or `undefined` when the shape does not hold
 *
 * @example
 * ```ts
 * scanLink('[text](url)', 0, 11)
 * // { node: { element: 'link', href: 'url', children: [{ element: 'text', value: 'text' }] }, end: 11 }
 * ```
 */
export function scanLink(
	source: string,
	start: number,
	to: number,
	depth = 0,
): { readonly node: LinkNode; readonly end: number } | undefined {
	const located = locateLink(source, start, to)
	if (located === undefined) return undefined
	const href = unescapeText(source.slice(located.close + 2, located.end - 1).trim())
	const children = scanInline(source, start + 1, located.close, depth + 1)
	return { node: { element: 'link', href, children }, end: located.end }
}

/**
 * Locates an emphasis run at `start` (`*` / `_`, doubled for strong) - finds the nearest
 * matching closing run of the same marker + width while skipping complete nested
 * runs from the other marker family, and requires non-space immediately inside both
 * delimiters (the CommonMark flanking simplification that blocks `* x *`). Returns
 * the content and syntax bounds, or `undefined` when no valid closer exists (it then degrades to
 * a literal marker).
 *
 * @param source - The inline source text
 * @param start - The index of the opening marker
 * @param to - The exclusive end of the scan window
 * @returns The content and syntax bounds, or `undefined`
 *
 * @example
 * ```ts
 * locateEmphasis('*em*', 0, 4) // { strong: false, open: 1, close: 3, end: 4 }
 * ```
 */
export function locateEmphasis(
	source: string,
	start: number,
	to: number,
):
	| {
			readonly strong: boolean
			readonly open: number
			readonly close: number
			readonly end: number
	  }
	| undefined {
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
		if ((character === '*' || character === '_') && character !== marker) {
			const nested = locateEmphasis(source, index, to)
			if (nested !== undefined) {
				index = nested.end
				continue
			}
		}
		if (character === marker) {
			let closeRun = 0
			while (index + closeRun < to && source[index + closeRun] === marker) closeRun += 1
			if (closeRun >= run && !isWhitespace(source[index - 1] ?? '')) {
				return {
					strong,
					open: openEnd,
					close: index,
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
 * Scans an emphasis run at `start` (`*` / `_`, doubled for strong) - finds the nearest
 * matching closing run of the same marker + width while skipping complete nested runs
 * from the other marker family, and requires non-space immediately inside both
 * delimiters (the CommonMark flanking simplification that blocks `* x *`) through
 * {@link locateEmphasis}, and returns the parsed node and end index. Returns
 * `undefined` when no valid closer exists (it then degrades to a literal marker).
 *
 * @param source - The inline source text
 * @param start - The index of the opening marker
 * @param to - The exclusive end of the scan window
 * @param depth - The current inline-recursion depth, forwarded to {@link scanInline}
 *   incremented by one for the run's children. At {@link MAX_DEPTH} that recursion
 *   emits the content as a single literal text node instead of scanning it.
 * @returns The parsed emphasis and end index, or `undefined` when no closer exists
 *
 * @example
 * ```ts
 * scanEmphasis('*em*', 0, 4)
 * // { node: { element: 'emphasis', strong: false, children: [{ element: 'text', value: 'em' }] }, end: 4 }
 * ```
 */
export function scanEmphasis(
	source: string,
	start: number,
	to: number,
	depth = 0,
): { readonly node: EmphasisNode; readonly end: number } | undefined {
	const located = locateEmphasis(source, start, to)
	if (located === undefined) return undefined
	return {
		node: {
			element: 'emphasis',
			strong: located.strong,
			children: scanInline(source, located.open, located.close, depth + 1),
		},
		end: located.end,
	}
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
	return scanInlineSource(
		{
			text: source,
			segments: [{ offset: 0, start: 0, end: source.length }],
		},
		from,
		to,
		new Map<MarkdownNode, MarkdownSpan>(),
		depth,
	)
}

/**
 * Scans an offset-bearing inline window with the same engine as {@link scanInline}
 * and records each emitted node against the original markdown string.
 *
 * @param source - The offset-bearing inline source
 * @param from - The inclusive start of the scan window
 * @param to - The exclusive end of the scan window
 * @param spans - The operation-owned node span recorder
 * @param depth - The current inline-recursion depth
 * @returns The parsed inline nodes before adjacent text coalescing
 *
 * @example
 * ```ts
 * scanInlineSource(
 * 	{ text: 'hi *there*', segments: [{ offset: 0, start: 0, end: 10 }] },
 * 	0,
 * 	10,
 * 	new Map(),
 * )
 * // [{ element: 'text', value: 'hi ' }, { element: 'emphasis', ... }]
 * ```
 */
export function scanInlineSource(
	source: MarkdownSource,
	from: number,
	to: number,
	spans: Map<MarkdownNode, MarkdownSpan>,
	depth = 0,
): readonly InlineNode[] {
	if (depth >= MAX_DEPTH)
		if (from < to) {
			const node: InlineNode = { element: 'text', value: source.text.slice(from, to) }
			const span = projectSpan(source, from, to)
			if (span !== undefined) spans.set(node, span)
			return [node]
		} else return []
	const nodes: InlineNode[] = []
	let index = from
	let pending = ''
	let pendingStart = from
	while (index < to) {
		const character = source.text[index] ?? ''
		if (character === '\\' && index + 1 < to && isEscapable(source.text[index + 1] ?? '')) {
			if (pending.length === 0) pendingStart = index
			pending += source.text[index + 1] ?? ''
			index += 2
			continue
		}
		if (character === ' ') {
			let spaceEnd = index
			while (spaceEnd < to && source.text[spaceEnd] === ' ') spaceEnd += 1
			if (spaceEnd - index >= 2 && source.text[spaceEnd] === '\n') {
				if (pending.length > 0) {
					const node: InlineNode = { element: 'text', value: pending }
					const span = projectSpan(source, pendingStart, index)
					if (span !== undefined) spans.set(node, span)
					nodes.push(node)
					pending = ''
				}
				const node: InlineNode = { element: 'break' }
				const span = projectSpan(source, index, spaceEnd + 1)
				if (span !== undefined) spans.set(node, span)
				nodes.push(node)
				index = spaceEnd + 1
				pendingStart = index
				continue
			}
		}
		let scanned: InlineNode | undefined
		let end = index
		if (character === '`') {
			const span = scanCode(source.text, index, to)
			if (span) {
				scanned = { element: 'codeSpan', value: span.value }
				end = span.end
			}
		}
		if (character === '!' && source.text[index + 1] === '[') {
			const link = locateLink(source.text, index + 1, to)
			if (link !== undefined) {
				scanned = {
					element: 'image',
					src: unescapeText(source.text.slice(link.close + 2, link.end - 1).trim()),
					children: coalesceText(
						scanInlineSource(source, index + 2, link.close, spans, depth + 1),
						spans,
					),
				}
				end = link.end
			}
		}
		if (character === '[') {
			const link = locateLink(source.text, index, to)
			if (link !== undefined) {
				scanned = {
					element: 'link',
					href: unescapeText(source.text.slice(link.close + 2, link.end - 1).trim()),
					children: coalesceText(
						scanInlineSource(source, index + 1, link.close, spans, depth + 1),
						spans,
					),
				}
				end = link.end
			}
		}
		if (character === '*' || character === '_') {
			const emphasis = locateEmphasis(source.text, index, to)
			if (emphasis !== undefined) {
				scanned = {
					element: 'emphasis',
					strong: emphasis.strong,
					children: coalesceText(
						scanInlineSource(source, emphasis.open, emphasis.close, spans, depth + 1),
						spans,
					),
				}
				end = emphasis.end
			}
		}
		if (scanned !== undefined) {
			if (pending.length > 0) {
				const node: InlineNode = { element: 'text', value: pending }
				const span = projectSpan(source, pendingStart, index)
				if (span !== undefined) spans.set(node, span)
				nodes.push(node)
				pending = ''
			}
			const span = projectSpan(source, index, end)
			if (span !== undefined) spans.set(scanned, span)
			nodes.push(scanned)
			index = end
			pendingStart = index
			continue
		}
		if (pending.length === 0) pendingStart = index
		pending += character
		index += 1
	}
	if (pending.length > 0) {
		const node: InlineNode = { element: 'text', value: pending }
		const span = projectSpan(source, pendingStart, index)
		if (span !== undefined) spans.set(node, span)
		nodes.push(node)
	}
	return nodes
}

/**
 * Collects a GFM table starting at a header row, parsing the header, the
 * alignment row, and every contiguous body row that follows.
 *
 * @param lines - The markdown lines to scan.
 * @param start - The index of the header row.
 * @param spans - The optional operation-owned node span recorder.
 * @returns The parsed table node and the index of the first line after it.
 *
 * @example
 * ```ts
 * collectTable(splitLines('| a |\n| - |'), 0) // { node: { element: 'table', ... }, next: 2 }
 * ```
 */
export function collectTable(
	lines: readonly MarkdownSource[],
	start: number,
	spans = new Map<MarkdownNode, MarkdownSpan>(),
): { readonly node: TableNode; readonly next: number } {
	const headerCells = splitTableSources(lines[start] ?? { text: '', segments: [] })
	const columns = headerCells.length
	const header = headerCells.map((cell) => {
		const source = trimSource(cell)
		return coalesceText(scanInlineSource(source, 0, source.text.length, spans), spans)
	})
	const align = delimiterToAlignments(lines[start + 1]?.text ?? '')
	const padded: Array<TableAlign | null> = []
	for (let column = 0; column < columns; column += 1) padded.push(align[column] ?? null)
	const rows: Array<Array<readonly InlineNode[]>> = []
	let index = start + 2
	while (
		index < lines.length &&
		!isBlankLine(lines[index]?.text ?? '') &&
		(lines[index]?.text ?? '').includes('|')
	) {
		const cells = splitTableSources(lines[index] ?? { text: '', segments: [] })
		const row: Array<readonly InlineNode[]> = []
		for (let column = 0; column < columns; column += 1) {
			const source = trimSource(cells[column] ?? { text: '', segments: [] })
			row.push(coalesceText(scanInlineSource(source, 0, source.text.length, spans), spans))
		}
		rows.push(row)
		index += 1
	}
	const node: TableNode = { element: 'table', header, rows, align: padded }
	const source = joinSources(lines.slice(start, index), '\n')
	const span = projectSpan(source, 0, source.text.length)
	if (span !== undefined) spans.set(node, span)
	return { node, next: index }
}

/**
 * Collects a list starting at the first item, gathering sibling items at the
 * same indent/ordering and recursing into each item's own block content.
 *
 * @param lines - The markdown lines to scan.
 * @param start - The index of the first list item.
 * @param depth - The current recursion depth (each item recurses at `depth + 1`).
 * @param spans - The optional operation-owned node span recorder.
 * @param end - The original-source end of this line run, including a removed terminator.
 * @returns The parsed list node and the index of the first line after it.
 *
 * @example
 * ```ts
 * collectList(splitLines('- item'), 0, 0) // { node: { element: 'list', ... }, next: 1 }
 * ```
 */
export function collectList(
	lines: readonly MarkdownSource[],
	start: number,
	depth: number,
	spans = new Map<MarkdownNode, MarkdownSpan>(),
	end?: number,
): { readonly node: ListNode; readonly next: number } {
	const text = lines.map((line) => line.text)
	const first = extractListItem(text[start] ?? '')
	const ordered = first?.ordered ?? false
	const startOrdinal = first?.start ?? 1
	const topIndent = first?.indent ?? 0
	const items: ListItemNode[] = []
	// A single nested-item chain would otherwise rescan and slice the whole suffix
	// once per level before reaching the cap. Recognize that shape in one pass and
	// build the same bounded AST bottom-up.
	const chain: ListItemMatch[] = []
	let nested = true
	for (let cursor = start; cursor < lines.length; cursor += 1) {
		const parsed = extractListItem(text[cursor] ?? '')
		const previous = chain[chain.length - 1]
		if (
			parsed === undefined ||
			(previous !== undefined && (previous.content.length > 0 || parsed.indent !== previous.marker))
		) {
			nested = false
			break
		}
		chain.push(parsed)
	}
	const remaining = MAX_DEPTH - depth
	if (nested && remaining > 0 && chain.length > remaining) {
		const terminal = chain[remaining - 1]
		const terminalLine = lines[start + remaining - 1]
		if (terminal !== undefined && terminalLine !== undefined) {
			const sources: MarkdownSource[] = [
				sliceSource(terminalLine, terminal.marker, terminalLine.text.length),
			]
			for (let cursor = start + remaining; cursor < lines.length; cursor += 1) {
				const line = lines[cursor]
				if (line !== undefined) sources.push(sliceSource(line, terminal.marker, line.text.length))
			}
			const source = joinSources(sources, '\n')
			const textNode: InlineNode = { element: 'text', value: source.text }
			const paragraph: BlockNode = { element: 'paragraph', children: [textNode] }
			const residualSpan = projectSpan(source, 0, source.text.length)
			if (residualSpan !== undefined) {
				spans.set(textNode, residualSpan)
				spans.set(paragraph, residualSpan)
			}
			let children: readonly BlockNode[] = [paragraph]
			let node: ListNode | undefined
			for (let cursor = remaining - 1; cursor >= 0; cursor -= 1) {
				const parsed = chain[cursor]
				if (parsed === undefined) continue
				const item: ListItemNode = { element: 'listItem', children }
				node = {
					element: 'list',
					ordered: parsed.ordered,
					start: parsed.start,
					items: [item],
				}
				const region = joinSources(
					lines
						.slice(start + cursor)
						.map((line) => sliceSource(line, parsed.indent, line.text.length)),
					'\n',
				)
				const span = projectSpan(region, 0, region.text.length)
				if (span !== undefined) {
					spans.set(item, span)
					spans.set(node, span)
				}
				children = [node]
			}
			if (node !== undefined) return { node, next: lines.length }
		}
	}
	let index = start
	while (index < lines.length) {
		const parsed = extractListItem(text[index] ?? '')
		// A sibling item shares the list's (top) indent + ordering; anything else stops
		// the top loop (a deeper item is a nested list, gathered as continuation below).
		if (!parsed || parsed.indent > topIndent || parsed.ordered !== ordered) break
		const itemStart = index
		const itemLine = lines[index]
		if (itemLine === undefined) break
		const itemLines: MarkdownSource[] = [sliceSource(itemLine, parsed.marker, itemLine.text.length)]
		const continuation = parsed.marker
		index += 1
		while (index < lines.length) {
			const nextSource = lines[index]
			if (nextSource === undefined) break
			const next = nextSource.text
			if (isBlankLine(next)) {
				const after = lines[index + 1]?.text ?? ''
				if (index + 1 < lines.length && !isBlankLine(after) && countIndent(after) >= continuation) {
					itemLines.push(sliceSource(nextSource, 0, 0))
					index += 1
					continue
				}
				break
			}
			if (countIndent(next) >= continuation) {
				itemLines.push(sliceSource(nextSource, continuation, next.length))
				index += 1
				continue
			}
			if (extractListItem(next) || startsBlock(text, index)) break
			itemLines.push(trimSource(nextSource)) // a lazy paragraph-continuation line
			index += 1
		}
		const tail = itemLines[itemLines.length - 1]
		const segment = tail?.segments[tail.segments.length - 1]
		const itemEnd = index === lines.length && end !== undefined ? end : segment?.end
		const item: ListItemNode = {
			element: 'listItem',
			children: parseBlocks(itemLines, depth + 1, spans, itemEnd),
		}
		const source = joinSources(lines.slice(itemStart, index), '\n')
		const span = projectSpan(source, 0, source.text.length)
		if (span !== undefined) spans.set(item, span)
		items.push(item)
	}
	const node: ListNode = { element: 'list', ordered, start: startOrdinal, items }
	const source = joinSources(lines.slice(start, index), '\n')
	const span = projectSpan(source, 0, source.text.length)
	if (span !== undefined) spans.set(node, span)
	return { node, next: index }
}

//  Rendering (Markdown AST → HTML AST → sanitized HTML string)

/**
 * Project a {@link MarkdownNode} into an unsanitized {@link HTMLDocument}.
 *
 * @remarks
 * The projection is pure and iterative. Text and attribute values remain literal for
 * `@orkestrel/html` to encode, and URL values remain unsanitized so callers can choose
 * their own HTML policy. Projected HTML element depth, including generated `pre > code`
 * and table scaffolding, never exceeds {@link MAX_DEPTH}. At the cap a node carrying a
 * string `value` degrades to a text node and a structural node contributes nothing.
 *
 * @param node - The markdown document or bare node to project
 * @returns An unsanitized HTML document wrapping the projected node or nodes
 *
 * @example
 * ```ts
 * markdownToHTML({ element: 'text', value: 'a & b' })
 * // { category: 'document', children: [{ category: 'text', value: 'a & b' }] }
 * ```
 */
export function markdownToHTML(node: MarkdownNode): HTMLDocument {
	const stack: Array<{
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
	}> = [{ node, depth: 0, expanded: false, count: 0 }]
	const values: Array<HTMLNode | undefined> = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		const current = frame.node
		if (!frame.expanded) {
			if (frame.depth >= MAX_DEPTH) {
				values.push(
					'value' in current && typeof current.value === 'string'
						? { category: 'text', value: current.value }
						: undefined,
				)
				continue
			}
			const children: MarkdownNode[] = []
			let depth = frame.depth
			switch (current.element) {
				case 'document':
					for (const child of current.children) if (child !== undefined) children.push(child)
					break
				case 'heading':
				case 'paragraph':
				case 'blockquote':
					for (const child of current.children) if (child !== undefined) children.push(child)
					depth += 1
					break
				case 'listItem': {
					const only = current.children[0]
					if (current.children.length === 1 && only !== undefined && only.element === 'paragraph') {
						for (const child of only.children) if (child !== undefined) children.push(child)
					} else {
						for (const child of current.children) if (child !== undefined) children.push(child)
					}
					depth += 1
					break
				}
				case 'emphasis':
				case 'link':
					for (const child of current.children) if (child !== undefined) children.push(child)
					depth += 1
					break
				case 'list':
					for (const child of current.items) if (child !== undefined) children.push(child)
					depth += 1
					break
				case 'table':
					if (frame.depth + 4 > MAX_DEPTH) {
						values.push(undefined)
						continue
					}
					for (const cell of current.header)
						if (cell !== undefined)
							for (const child of cell) if (child !== undefined) children.push(child)
					for (const row of current.rows)
						if (row !== undefined)
							for (const cell of row)
								if (cell !== undefined)
									for (const child of cell) if (child !== undefined) children.push(child)
					depth += 4
					break
			}
			if (current.element === 'codeBlock' && frame.depth + 2 > MAX_DEPTH) {
				values.push(undefined)
				continue
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
		const projected: HTMLNode[] = []
		for (const child of children) if (child !== undefined) projected.push(child)
		let value: HTMLNode | undefined
		switch (current.element) {
			case 'document':
				value = { category: 'document', children: projected }
				break
			case 'heading':
				value = {
					category: 'element',
					name: `h${current.level}`,
					attributes: [],
					children: projected,
				}
				break
			case 'paragraph':
				value = { category: 'element', name: 'p', attributes: [], children: projected }
				break
			case 'thematicBreak':
				value = { category: 'element', name: 'hr', attributes: [], children: [] }
				break
			case 'blockquote':
				value = {
					category: 'element',
					name: 'blockquote',
					attributes: [],
					children: projected,
				}
				break
			case 'codeBlock':
				value = {
					category: 'element',
					name: 'pre',
					attributes: [],
					children: [
						{
							category: 'element',
							name: 'code',
							attributes:
								current.lang === undefined
									? []
									: [{ name: 'class', value: `language-${current.lang}` }],
							children: [{ category: 'text', value: current.code }],
						},
					],
				}
				break
			case 'list':
				value = {
					category: 'element',
					name: current.ordered ? 'ol' : 'ul',
					attributes:
						current.ordered && current.start !== 1
							? [{ name: 'start', value: String(current.start) }]
							: [],
					children: projected,
				}
				break
			case 'listItem':
				value = { category: 'element', name: 'li', attributes: [], children: projected }
				break
			case 'table': {
				let offset = 0
				const header: HTMLNode[] = []
				for (const [column, cell] of current.header.entries()) {
					if (cell === undefined) continue
					const align = current.align[column]
					const attributes =
						align === 'left' || align === 'right' || align === 'center'
							? [{ name: 'align', value: align }]
							: []
					let count = 0
					for (const child of cell) if (child !== undefined) count += 1
					const cellChildren: HTMLNode[] = []
					for (const child of children.slice(offset, offset + count))
						if (child !== undefined) cellChildren.push(child)
					header.push({
						category: 'element',
						name: 'th',
						attributes,
						children: cellChildren,
					})
					offset += count
				}
				const rows: HTMLNode[] = []
				for (const row of current.rows) {
					const cells: HTMLNode[] = []
					for (const [column, cell] of row.entries()) {
						if (cell === undefined) continue
						const align = current.align[column]
						const attributes =
							align === 'left' || align === 'right' || align === 'center'
								? [{ name: 'align', value: align }]
								: []
						let count = 0
						for (const child of cell) if (child !== undefined) count += 1
						const cellChildren: HTMLNode[] = []
						for (const child of children.slice(offset, offset + count))
							if (child !== undefined) cellChildren.push(child)
						cells.push({
							category: 'element',
							name: 'td',
							attributes,
							children: cellChildren,
						})
						offset += count
					}
					rows.push({
						category: 'element',
						name: 'tr',
						attributes: [],
						children: cells,
					})
				}
				const tableChildren: HTMLNode[] = [
					{
						category: 'element',
						name: 'thead',
						attributes: [],
						children: [
							{
								category: 'element',
								name: 'tr',
								attributes: [],
								children: header,
							},
						],
					},
				]
				if (isNonEmptyArray(current.rows)) {
					tableChildren.push({
						category: 'element',
						name: 'tbody',
						attributes: [],
						children: rows,
					})
				}
				value = {
					category: 'element',
					name: 'table',
					attributes: [],
					children: tableChildren,
				}
				break
			}
			case 'text':
				value = { category: 'text', value: current.value }
				break
			case 'emphasis':
				value = {
					category: 'element',
					name: current.strong ? 'strong' : 'em',
					attributes: [],
					children: projected,
				}
				break
			case 'codeSpan':
				value = {
					category: 'element',
					name: 'code',
					attributes: [],
					children: [{ category: 'text', value: current.value }],
				}
				break
			case 'link':
				value = {
					category: 'element',
					name: 'a',
					attributes: [{ name: 'href', value: current.href }],
					children: projected,
				}
				break
			case 'image':
				value = {
					category: 'element',
					name: 'img',
					attributes: [
						{ name: 'src', value: current.src },
						{ name: 'alt', value: flattenText(current) },
					],
					children: [],
				}
				break
			case 'break':
				value = { category: 'element', name: 'br', attributes: [], children: [] }
				break
			default:
				value = undefined
				break
		}
		values.push(value)
	}
	const projected = values[0]
	if (projected?.category === 'document') return projected
	return {
		category: 'document',
		children: projected === undefined ? [] : [projected],
	}
}

/**
 * Render a {@link MarkdownNode} to sanitized canonical HTML.
 *
 * @remarks
 * Markdown widens `@orkestrel/html`'s attribute floor by exactly `src`, because image
 * syntax is meaningless without its source. `src` is still a URL attribute, so the
 * floor refuses `javascript:`, `data:`, `vbscript:`, and `file:` values. A stricter
 * consumer can compose {@link markdownToHTML} with `@orkestrel/html`'s `HTML` class
 * directly.
 *
 * @param node - The markdown document or bare node to render
 * @returns Sanitized canonical HTML
 *
 * @example
 * ```ts
 * renderHTML({ element: 'paragraph', children: [{ element: 'text', value: 'a & b' }] })
 * // '<p>a &amp; b</p>'
 * ```
 */
export function renderHTML(node: MarkdownNode): string {
	return renderHTMLDocument(
		new HTML(markdownToHTML(node)).sanitize({ attributes: [...SAFE_ATTRIBUTES, 'src'] }).document,
	)
}

/**
 * Render a {@link MarkdownNode} to its CANONICAL markdown source - the inverse
 * projection of `renderHTML`, and the serializer a `parse(renderMarkdown(doc))`
 * round-trip is built on. Canonical forms: `*` / `**` emphasis at even emphasis
 * nesting depths and `_` / `__` at odd depths, `- ` bullets, `N. ` sequential
 * ordinals (from the list's `start`), `---` thematic breaks, fenced code blocks
 * (backtick run widened past any 3+ backtick run inside the body), ATX headings,
 * `> `-prefixed blockquote lines, GFM tables (1-space-padded cells, `\|`-escaped
 * pipes, an alignment delimiter row), `[text](href)` links, `![alt](src)` images,
 * and two-space hard breaks. A `text` node's literal content is backslash-escaped
 * wherever it would otherwise re-parse as markup (AGENTS §14 parse↔render
 * soundness).
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
	const stack: Array<{
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
		readonly escaped: string
		readonly escapeBang: boolean
		readonly nesting: number
	}> = [
		{
			node,
			depth: 0,
			expanded: false,
			count: 0,
			escaped: '',
			escapeBang: false,
			nesting: 0,
		},
	]
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
							(character === '-' || character === '~') &&
							current.value[index + 1] === character &&
							current.value[index + 2] === character
						) {
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
			const groups: Array<readonly MarkdownNode[]> = []
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
			const nesting = current.element === 'emphasis' ? frame.nesting + 1 : frame.nesting
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
						nesting,
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
				for (const [position, body] of children.entries()) {
					const marker = current.ordered ? `${ordinal}. ` : '- '
					ordinal += 1
					const pad = ' '.repeat(marker.length)
					if (current.items[position]?.children[0]?.element === 'table') {
						items.push(
							`${marker}\n${body
								.split('\n')
								.map((line) => pad + line)
								.join('\n')}`,
						)
						continue
					}
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
				const marker =
					frame.nesting % 2 === 0 ? (current.strong ? '**' : '*') : current.strong ? '__' : '_'
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

//  Projection (HTML AST → Markdown AST)
//
// The inverse of {@link markdownToHTML}, and the reason markdown owns both
// directions: what an HTML subtree becomes is markdown-format knowledge, not HTML
// knowledge. The engine is `@orkestrel/html`'s own `foldNode` catamorphism - it
// already owns depth capping, cycle safety, and bottom-up folding - so this file
// contributes the projection ONLY: five pure leaves over {@link MarkdownProjection}
// values ({@link trimInlines}, {@link normalizeInlines}, {@link mergeProjections},
// {@link projectionToBlocks}, {@link projectionToInlines}), the two handlers that
// map HTML to markdown ({@link projectHTMLLeaf}, {@link projectHTMLNode}), and the one
// entry point that folds them ({@link htmlToMarkdown}). HTML is richer than
// markdown, so the projection is lossy by construction; what it must never be is
// WRONG, which is what the round-trip anchor law pins down.

/**
 * Trim the whitespace at the two ends of an inline run - the leading whitespace of a
 * leading text node and the trailing whitespace of a trailing one - dropping either
 * node when nothing survives.
 *
 * @remarks
 * Markdown trims every line of a paragraph, a heading's text, and a table cell, so an
 * untrimmed run would come back from a re-parse a different AST. Expects a coalesced
 * run (see {@link coalesceText}): only the outermost node on each side is examined.
 *
 * @param nodes - The inline run to trim
 * @returns The run with its edge whitespace removed
 *
 * @example
 * ```ts
 * trimInlines([{ element: 'text', value: ' a ' }]) // [{ element: 'text', value: 'a' }]
 * ```
 */
export function trimInlines(nodes: readonly InlineNode[]): readonly InlineNode[] {
	const out: InlineNode[] = []
	for (const node of nodes) if (node !== undefined) out.push(node)
	const first = out[0]
	if (first !== undefined && first.element === 'text') {
		const value = first.value.replace(/^\s+/, '')
		if (isEmptyString(value)) out.shift()
		else out[0] = { element: 'text', value }
	}
	const last = out[out.length - 1]
	if (last !== undefined && last.element === 'text') {
		const value = last.value.replace(/\s+$/, '')
		if (isEmptyString(value)) out.pop()
		else out[out.length - 1] = { element: 'text', value }
	}
	return out
}

/**
 * Reduce an inline run to the shape markdown can actually write back: adjacent text
 * coalesced, empty text dropped, and every hard break either kept as a real line
 * ending or spent as a space.
 *
 * @remarks
 * A hard break is `  \n` in markdown source, so it survives a re-parse only BETWEEN
 * two lines of content and only with no whitespace touching it: a leading or trailing
 * break has no line to end, a run of breaks reads as one blank line (which would end
 * the paragraph), and a space beside one is eaten by the parser's line trimming. Where
 * a break cannot be written at all - a heading and a table cell are one line each - it
 * becomes the space it stood for.
 *
 * @param nodes - The inline run to normalize
 * @param breaks - Whether the target context can carry a hard break at all; `false` for
 *   a heading or a table cell, where every break becomes a space
 * @returns The normalized run
 *
 * @example
 * ```ts
 * normalizeInlines([{ element: 'break' }, { element: 'text', value: 'a' }], true)
 * // [{ element: 'text', value: 'a' }] - a leading break has no line to end
 * ```
 */
export function normalizeInlines(
	nodes: readonly InlineNode[],
	breaks: boolean,
): readonly InlineNode[] {
	const spent: InlineNode[] = []
	for (const node of nodes) {
		if (node === undefined) continue
		if (node.element === 'break' && !breaks) spent.push({ element: 'text', value: ' ' })
		else spent.push(node)
	}
	const out: InlineNode[] = []
	for (const node of coalesceText(spent)) {
		if (node === undefined) continue
		const previous = out[out.length - 1]
		if (node.element === 'text') {
			const value = previous?.element === 'break' ? node.value.replace(/^\s+/, '') : node.value
			if (!isEmptyString(value)) out.push({ element: 'text', value })
			continue
		}
		if (node.element === 'break') {
			if (previous === undefined || previous.element === 'break') continue
			if (previous.element === 'text') {
				const value = previous.value.replace(/\s+$/, '')
				if (isEmptyString(value)) out.pop()
				else out[out.length - 1] = { element: 'text', value }
			}
			if (out.length === 0) continue
			out.push(node)
			continue
		}
		out.push(node)
	}
	while (out.length > 0 && out[out.length - 1]?.element === 'break') out.pop()
	return coalesceText(out)
}

/**
 * Combine the projections of one node's children into the projection of that node -
 * the single place inline runs become paragraphs, so no ancestor has to decide it
 * twice.
 *
 * @remarks
 * A child is either inline or block, never both, so merging preserves source order
 * exactly: an inline run is held pending until a block arrives, then written out as a
 * paragraph BEFORE it. That is what keeps `<div>lead<p>a</p></div>` two paragraphs in
 * the order they were written rather than two lists that lost their interleaving. A
 * pending run carrying no text is dropped rather than becoming a blank paragraph.
 * Direct cells become one row before a later row, while cells/rows before a block
 * materialize as paragraphs at that exact source position.
 *
 * @param children - The children's projections, in source order
 * @returns Their combined projection
 *
 * @example
 * ```ts
 * mergeProjections([
 *   createProjection({ inlines: [{ element: 'text', value: 'a' }], text: 'a' }),
 *   createProjection({ blocks: [{ element: 'thematicBreak' }] }),
 * ]).blocks
 * // [{ element: 'paragraph', children: [...] }, { element: 'thematicBreak' }]
 * ```
 */
export function mergeProjections(children: readonly MarkdownProjection[]): MarkdownProjection {
	const blocks: BlockNode[] = []
	const cells: MarkdownCell[] = []
	const rows: Array<readonly MarkdownCell[]> = []
	let pending: InlineNode[] = []
	let text = ''
	for (const child of children) {
		if (child === undefined) continue
		text += child.text
		if (isNonEmptyArray(child.blocks)) {
			const flushed = trimInlines(normalizeInlines(pending, true))
			if (isNonEmptyArray(flushed)) blocks.push({ element: 'paragraph', children: flushed })
			pending = []
			for (const row of rows) {
				for (const cell of row) {
					if (cell !== undefined && isNonEmptyArray(cell.inlines))
						blocks.push({ element: 'paragraph', children: cell.inlines })
				}
			}
			rows.length = 0
			for (const cell of cells) {
				if (cell !== undefined && isNonEmptyArray(cell.inlines))
					blocks.push({ element: 'paragraph', children: cell.inlines })
			}
			cells.length = 0
			for (const block of projectionToBlocks(child)) blocks.push(block)
			continue
		}
		if (isNonEmptyArray(child.rows)) {
			if (isNonEmptyArray(cells)) {
				rows.push([...cells])
				cells.length = 0
			}
			for (const row of child.rows) if (row !== undefined) rows.push(row)
		}
		for (const cell of child.cells) if (cell !== undefined) cells.push(cell)
		for (const inline of child.inlines) if (inline !== undefined) pending.push(inline)
	}
	if (isNonEmptyArray(rows) && isNonEmptyArray(cells)) {
		rows.push([...cells])
		cells.length = 0
	}
	if (!isNonEmptyArray(blocks))
		return createProjection({ inlines: coalesceText(pending), text, cells, rows })
	const flushed = trimInlines(normalizeInlines(pending, true))
	if (isNonEmptyArray(flushed)) blocks.push({ element: 'paragraph', children: flushed })
	return createProjection({ blocks, text, cells, rows })
}

/**
 * Read a projection as BLOCK content - the view a document, a blockquote, and a list
 * item each need.
 *
 * @remarks
 * A bare inline run becomes one paragraph, and a run carrying no text becomes nothing
 * at all, because a blank paragraph is unwritable in markdown. A cell or a row that
 * never reached a table is unwrapped here rather than dropped: a stray `<td>` is still
 * someone's content.
 *
 * @param projection - The projection to read
 * @returns Its block content
 *
 * @example
 * ```ts
 * projectionToBlocks(createProjection({ inlines: [{ element: 'text', value: 'a' }], text: 'a' }))
 * // [{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] }]
 * ```
 */
export function projectionToBlocks(projection: MarkdownProjection): readonly BlockNode[] {
	const blocks: BlockNode[] = []
	for (const block of projection.blocks) if (block !== undefined) blocks.push(block)
	for (const row of projection.rows) {
		if (row === undefined) continue
		for (const cell of row) {
			if (cell === undefined || !isNonEmptyArray(cell.inlines)) continue
			blocks.push({ element: 'paragraph', children: cell.inlines })
		}
	}
	for (const cell of projection.cells) {
		if (cell === undefined || !isNonEmptyArray(cell.inlines)) continue
		blocks.push({ element: 'paragraph', children: cell.inlines })
	}
	const paragraph = trimInlines(normalizeInlines(projection.inlines, true))
	if (isNonEmptyArray(paragraph)) blocks.push({ element: 'paragraph', children: paragraph })
	return blocks
}

/**
 * Read a projection as INLINE content - the view a link, an emphasis, and a table cell
 * each need.
 *
 * @remarks
 * Inline content passes through as itself. Block content cannot: markdown has no way to
 * put a paragraph inside a table cell, so it flattens to one text node of its own words,
 * joined and whitespace-collapsed. Content that carries no text flattens to nothing
 * rather than to an empty text node, which is a shape the parser never produces.
 *
 * @param projection - The projection to read
 * @returns Its inline content
 *
 * @example
 * ```ts
 * projectionToInlines(createProjection({ inlines: [{ element: 'break' }] }))
 * // [{ element: 'break' }]
 * ```
 */
export function projectionToInlines(projection: MarkdownProjection): readonly InlineNode[] {
	if (
		!isNonEmptyArray(projection.blocks) &&
		!isNonEmptyArray(projection.cells) &&
		!isNonEmptyArray(projection.rows)
	) {
		return coalesceText(projection.inlines)
	}
	const value = projectionToBlocks(projection)
		.map(flattenText)
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()
	return isEmptyString(value) ? [] : [{ element: 'text', value }]
}

/**
 * Project one HTML leaf - a text node, a comment, or a doctype - to its
 * {@link MarkdownProjection}.
 *
 * @remarks
 * Text collapses each whitespace run to one space, which is both what HTML means by it
 * and all markdown can write back; the raw value travels on in `text` for the two
 * places that need it verbatim, a code span and a `pre > code` body. A comment and a
 * doctype carry nothing into markdown and project to nothing.
 *
 * @param leaf - The leaf node to project
 * @returns Its projection
 *
 * @example
 * ```ts
 * projectHTMLLeaf({ category: 'text', value: 'a\n  b' }).inlines
 * // [{ element: 'text', value: 'a b' }]
 * ```
 */
export function projectHTMLLeaf(
	leaf: CommentNode | DoctypeNode | HTMLTextNode,
): MarkdownProjection {
	if (leaf.category !== 'text') return createProjection()
	const value = leaf.value.replace(/\s+/g, ' ')
	return createProjection({
		inlines: isEmptyString(value) ? [] : [{ element: 'text', value }],
		text: leaf.value,
	})
}

/**
 * Project one HTML container - the document root or an element - from its children's
 * already-computed projections. THE element mapping, and the only place that decides
 * what an HTML tag becomes in markdown.
 *
 * @remarks
 * `h1`-`h6` become headings; `p` a paragraph; `strong` / `b` and `em` / `i` emphasis;
 * `code` a code span; `pre` a code block, verbatim through a first `code` element child
 * (its `language-` class naming the language) and through `renderText` otherwise; `a`
 * and `img` a link and an image, each destination re-sanitized; `br` and `hr` a hard
 * break and a thematic break; `blockquote` and `li` their block content, with bare
 * inline runs wrapped in paragraphs; `ul` / `ol` a list, ordered from the tag and
 * numbered from `start`; `th` / `td`, `tr`, and `table` a GFM table whose column
 * alignment comes from each header-position cell's `align` attribute. Every
 * `UNSAFE_ELEMENTS` subtree contributes nothing at all, text included. Every OTHER
 * element unwraps to its children, so wrapper soup melts while its content keeps its
 * shape - `<div><p>a</p><p>b</p></div>` stays two paragraphs.
 *
 * Three mappings read their own node rather than only their children's projections,
 * because HTML puts the fact in a position rather than in a value: a `pre` takes its
 * body from its `code` child's raw text, and a list takes one item per `li` child - so
 * an empty `<li>` is still an item, while the whitespace between two of them is not.
 * A `tr` accepts only its own direct cells, and a table derives the first `th`-bearing
 * row from its own source structure.
 *
 * @param node - The document root or element to project
 * @param children - Its children's projections, in source order
 * @returns Its projection
 *
 * @example
 * ```ts
 * projectHTMLNode({ category: 'element', name: 'hr', attributes: [], children: [] }, []).blocks
 * // [{ element: 'thematicBreak' }]
 * ```
 */
export function projectHTMLNode(
	node: ElementNode | HTMLDocument,
	children: readonly MarkdownProjection[],
): MarkdownProjection {
	if (node.category === 'document') return mergeProjections(children)
	if (UNSAFE_ELEMENTS.includes(node.name)) return createProjection()
	const merged = mergeProjections(children)
	const level = /^h([1-6])$/.exec(node.name)
	if (level !== null) {
		return createProjection({
			blocks: [
				{
					element: 'heading',
					level: parseInteger(level[1]) ?? 1,
					children: trimInlines(normalizeInlines(projectionToInlines(merged), false)),
				},
			],
			text: merged.text,
		})
	}
	switch (node.name) {
		case 'p':
		case 'li':
			return createProjection({
				blocks: projectionToBlocks(merged),
				text: merged.text,
			})
		case 'blockquote':
			return createProjection({
				blocks: [{ element: 'blockquote', children: projectionToBlocks(merged) }],
				text: merged.text,
			})
		case 'hr':
			return createProjection({
				blocks: [{ element: 'thematicBreak' }],
				text: '',
			})
		case 'br':
			return createProjection({ inlines: [{ element: 'break' }], text: '\n' })
		case 'strong':
		case 'b':
		case 'em':
		case 'i': {
			const content = projectionToInlines(merged)
			const inner = trimInlines(normalizeInlines(content, true))
			if (!isNonEmptyArray(inner)) return createProjection({ text: merged.text })
			// Markdown refuses emphasis padded with whitespace (`* x *` is literal), so the
			// padding moves OUTSIDE the marker rather than being lost with the word boundary.
			const first = content[0]
			const last = content[content.length - 1]
			const inlines: InlineNode[] = []
			if (first?.element === 'text' && /^\s/.test(first.value))
				inlines.push({ element: 'text', value: ' ' })
			inlines.push({
				element: 'emphasis',
				strong: node.name === 'strong' || node.name === 'b',
				children: inner,
			})
			if (last?.element === 'text' && /\s$/.test(last.value))
				inlines.push({ element: 'text', value: ' ' })
			return createProjection({ inlines, text: merged.text })
		}
		case 'code': {
			const body = merged.text.replace(/\r\n?/g, '\n').replace(/\s*\n\s*/g, ' ')
			// A span padded on BOTH sides is exactly what the parser strips back off, so the
			// canonical value is the stripped one.
			const value =
				body.length > 2 && body.startsWith(' ') && body.endsWith(' ') && !isEmptyString(body.trim())
					? body.trim()
					: body
			return createProjection({
				inlines: isEmptyString(value) ? [] : [{ element: 'codeSpan', value }],
				text: merged.text,
			})
		}
		case 'pre': {
			let position = -1
			for (const [index, child] of node.children.entries()) {
				if (child?.category !== 'element') continue
				position = index
				break
			}
			const source = position === -1 ? undefined : node.children[position]
			const projected = position === -1 ? undefined : children[position]
			if (source?.category === 'element' && source.name === 'code' && projected !== undefined) {
				let lang: string | undefined
				for (const token of (attributeOf(source, 'class') ?? '').split(/\s+/)) {
					if (!token.startsWith('language-') || token.length <= 9 || token.includes('`')) continue
					lang = token.slice(9)
					break
				}
				return createProjection({
					blocks: [
						{
							element: 'codeBlock',
							...(lang === undefined ? {} : { lang }),
							code: projected.text.replace(/\r\n?/g, '\n'),
						},
					],
					text: merged.text,
				})
			}
			return createProjection({
				blocks: [{ element: 'codeBlock', code: renderText(node).replace(/\r\n?/g, '\n') }],
				text: merged.text,
			})
		}
		case 'a':
			return createProjection({
				inlines: [
					{
						element: 'link',
						href: sanitizeURL(attributeOf(node, 'href') ?? '', SAFE_URL_SCHEMES),
						children: normalizeInlines(projectionToInlines(merged), true),
					},
				],
				text: merged.text,
			})
		case 'img': {
			const alt = (attributeOf(node, 'alt') ?? '').replace(/\s+/g, ' ').trim()
			return createProjection({
				inlines: [
					{
						element: 'image',
						src: sanitizeURL(attributeOf(node, 'src') ?? '', SAFE_URL_SCHEMES),
						children: isEmptyString(alt) ? [] : [{ element: 'text', value: alt }],
					},
				],
				text: '',
			})
		}
		case 'th':
		case 'td': {
			// html's set is the gate; the union is the bridge - an alignment markdown has no
			// delimiter for stays absent rather than becoming a decorative label.
			const declared = (attributeOf(node, 'align') ?? '').trim().toLowerCase()
			const align =
				TABLE_ALIGNMENTS.includes(declared) &&
				(declared === 'left' || declared === 'right' || declared === 'center')
					? declared
					: undefined
			return createProjection({
				text: merged.text,
				cells: [
					{
						align,
						inlines: trimInlines(normalizeInlines(projectionToInlines(merged), false)),
					},
				],
			})
		}
		case 'tr': {
			const cells: MarkdownCell[] = []
			for (const [index, child] of children.entries()) {
				const source = node.children[index]
				if (
					source?.category !== 'element' ||
					(source.name !== 'th' && source.name !== 'td') ||
					child === undefined
				) {
					continue
				}
				for (const cell of child.cells) if (cell !== undefined) cells.push(cell)
			}
			return createProjection({ text: merged.text, rows: [cells] })
		}
		case 'ul':
		case 'ol': {
			const items: ListItemNode[] = []
			for (const [index, child] of children.entries()) {
				if (child === undefined) continue
				const source = node.children[index]
				const blocks = projectionToBlocks(child)
				if (source?.category === 'element' && source.name === 'li') {
					items.push({ element: 'listItem', children: blocks })
					continue
				}
				if (isNonEmptyArray(blocks)) items.push({ element: 'listItem', children: blocks })
			}
			if (!isNonEmptyArray(items)) return createProjection({ text: merged.text })
			const ordered = node.name === 'ol'
			const declared = parseInteger(attributeOf(node, 'start'))
			// A start markdown cannot write as an ordinal (`\d{1,9}`) is no start at all.
			const start =
				ordered && declared !== undefined && declared >= 0 && declared <= 999_999_999 ? declared : 1
			return createProjection({
				blocks: [{ element: 'list', ordered, start, items }],
				text: merged.text,
			})
		}
		case 'table': {
			const rows: Array<readonly MarkdownCell[]> = []
			for (const row of merged.rows) if (row !== undefined) rows.push(row)
			if (isNonEmptyArray(merged.cells)) rows.push(merged.cells)
			const headings: boolean[] = []
			const rowed: boolean[] = []
			const sources: Array<{
				children: readonly HTMLNode[]
				index: number
				direct: boolean
			}> = [{ children: node.children, index: 0, direct: false }]
			while (sources.length > 0) {
				const source = sources.pop()
				if (source === undefined) continue
				if (source.index >= source.children.length) continue
				const child = source.children[source.index]
				source.index += 1
				sources.push(source)
				if (child?.category !== 'element') continue
				if (child.name === 'th' || child.name === 'td') {
					if (!source.direct) {
						headings.push(false)
						rowed.push(false)
					}
					source.direct = true
					continue
				}
				source.direct = false
				if (child.name === 'tr') {
					let heading = false
					for (const cell of child.children) {
						if (cell?.category === 'element' && cell.name === 'th') {
							heading = true
							break
						}
					}
					headings.push(heading)
					rowed.push(true)
					continue
				}
				sources.push({ children: child.children, index: 0, direct: false })
			}
			// The header is the first structurally th-bearing row, then the first explicit
			// row; a table made only of direct cells receives an empty synthetic header.
			let position: number | undefined
			for (const [index, heading] of headings.entries()) {
				if (!heading) continue
				position = index
				break
			}
			if (position === undefined) {
				for (const [index, structural] of rowed.entries()) {
					if (!structural) continue
					position = index
					break
				}
			}
			const headerRow = position === undefined ? undefined : rows[position]
			const columns = headerRow?.length ?? rows[0]?.length ?? 0
			if (columns === 0) {
				return createProjection({
					blocks: projectionToBlocks(merged),
					text: merged.text,
				})
			}
			const header: Array<readonly InlineNode[]> = []
			const align: Array<TableAlign | null> = []
			for (let column = 0; column < columns; column += 1) {
				const cell = headerRow?.[column]
				header.push(cell?.inlines ?? [])
				align.push(cell?.align ?? null)
			}
			const body: Array<ReadonlyArray<readonly InlineNode[]>> = []
			for (const [index, row] of rows.entries()) {
				if (row === undefined || index === position) continue
				const cells: Array<readonly InlineNode[]> = []
				for (let column = 0; column < header.length; column += 1)
					cells.push(row[column]?.inlines ?? [])
				body.push(cells)
			}
			return createProjection({
				blocks: [{ element: 'table', header, rows: body, align }],
				text: merged.text,
			})
		}
	}
	return merged
}

/**
 * Project an `@orkestrel/html` {@link HTMLNode} into a {@link MarkdownDocument} - the
 * HTML→markdown direction, and the inverse of {@link markdownToHTML}.
 *
 * @remarks
 * **Engine.** One total handler table - {@link projectHTMLNode} for the containers,
 * {@link projectHTMLLeaf} for the leaves - folded by `@orkestrel/html`'s own `foldNode`, so
 * depth capping, cycle safety, and bottom-up ordering are inherited rather than
 * rebuilt. Total: hostile, cyclic, and pathologically deep input degrades instead of
 * throwing.
 *
 * **Composed depth.** Both packages cap recursion at 64, and html's cap is reached
 * first: a document nested past it projects to a chain bounded by THAT cap, with the
 * content below it truncated before markdown ever sees it. Since the projected chain
 * can be a level or two deeper than {@link MAX_DEPTH}, the serializer's own cap can
 * then truncate again - so the anchor law below is a law within the depth budget, and
 * beyond it only totality is promised.
 *
 * **Safety.** Every `href` and `src` is re-sanitized through
 * `sanitizeURL(value, SAFE_URL_SCHEMES)` whether or not the AST was ever sanitized,
 * because a hand-built one never was. A refused destination empties to `''` and the
 * link or image is KEPT - `[text]()` - since a bad URL is no reason to lose the words
 * around it. An `UNSAFE_ELEMENTS` subtree contributes nothing at all, text included, so
 * a `script` body can never resurface as prose.
 *
 * **The anchor law.** HTML→markdown is lossy, so the fixpoint that matters is the
 * PROJECTED AST, not the input bytes:
 * `parseDocument(renderMarkdown(htmlToMarkdown(x)))` deep-equals `htmlToMarkdown(x)`.
 * The projection therefore emits canonical markdown shapes rather than literal
 * translations - whitespace collapsed, edges trimmed, a blank paragraph dropped, a hard
 * break only where a line can end - because a shape markdown cannot write back is a
 * shape this projection has no business producing.
 *
 * @param node - The HTML document or bare node to project
 * @returns The projected markdown document
 *
 * @example
 * ```ts
 * import { parseDocument } from '@orkestrel/html'
 *
 * htmlToMarkdown(parseDocument('<h1>Title</h1>'))
 * // { element: 'document', children: [{ element: 'heading', level: 1, children: [...] }] }
 * ```
 */
export function htmlToMarkdown(node: HTMLNode): MarkdownDocument {
	return {
		element: 'document',
		children: projectionToBlocks(
			foldHTMLNode<MarkdownProjection>(node, {
				document: projectHTMLNode,
				element: projectHTMLNode,
				text: projectHTMLLeaf,
				comment: projectHTMLLeaf,
				doctype: projectHTMLLeaf,
			}),
		),
	}
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
	const stack: Array<{ readonly node: MarkdownNode; readonly depth: number }> = [{ node, depth: 0 }]
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
	const stack: Array<{
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
	}> = [{ node, depth, expanded: false, count: 0 }]
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
 * Never mutates `document`. An unchanged subtree keeps its input identity. A parent
 * is rebuilt only when an accepted child changes, and the returned derivation map
 * associates each rebuilt output with its input node. When `rewrite` returns a node
 * whose `element` does not fit the slot it was called for (a block slot handed a
 * non-{@link BlockNode}, an inline slot handed a non-{@link InlineNode}, a list-item
 * slot handed a non-`listItem`), the ill-fitting result is discarded and the accepted
 * input child is reused - `rewriteDocument` stays total and never produces a
 * structurally invalid document.
 *
 * Descent is capped at {@link MAX_DEPTH}, the same cap {@link walkNodes} and
 * {@link foldNode} observe: at `depth >= MAX_DEPTH` the subtree is passed through
 * UNCHANGED (by reference, not rebuilt, and `rewrite` is not invoked on it) instead of
 * recursing further, so a pathologically deep adopted document cannot exhaust the
 * call stack. {@link MarkdownInterface.map} inherits this cap since it delegates here.
 *
 * @param document - The document AST to rewrite
 * @param rewrite - The bottom-up {@link MarkdownRewriteHandler}
 * @returns The rewritten document and its output-to-input derivations
 *
 * @example
 * ```ts
 * const [rewritten, derivations] = rewriteDocument(document, (node) =>
 *   node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
 * )
 * ```
 */
export function rewriteDocument(
	document: MarkdownDocument,
	rewrite: MarkdownRewriteHandler,
): MarkdownDerivation<MarkdownDocument> {
	const stack: Array<{
		readonly node: MarkdownNode
		readonly depth: number
		readonly expanded: boolean
		readonly count: number
	}> = [{ node: document, depth: -1, expanded: false, count: 0 }]
	const values: MarkdownNode[] = []
	const derivations = new Map<MarkdownNode, MarkdownNode | undefined>()
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
		let changed = false
		switch (current.element) {
			case 'document': {
				const blocks: BlockNode[] = []
				let offset = 0
				for (const block of current.children) {
					if (block === undefined) continue
					const child = children[offset]
					const accepted = child !== undefined && isBlockNode(child) ? child : block
					blocks.push(accepted)
					if (accepted !== block) changed = true
					offset += 1
				}
				if (changed) rebuilt = { element: 'document', children: blocks }
				break
			}
			case 'heading':
			case 'paragraph': {
				const inlines: InlineNode[] = []
				let offset = 0
				for (const inline of current.children) {
					if (inline === undefined) continue
					const child = children[offset]
					const accepted = child !== undefined && isInlineNode(child) ? child : inline
					inlines.push(accepted)
					if (accepted !== inline) changed = true
					offset += 1
				}
				if (changed) rebuilt = { ...current, children: inlines }
				break
			}
			case 'blockquote': {
				const blocks: BlockNode[] = []
				let offset = 0
				for (const block of current.children) {
					if (block === undefined) continue
					const child = children[offset]
					const accepted = child !== undefined && isBlockNode(child) ? child : block
					blocks.push(accepted)
					if (accepted !== block) changed = true
					offset += 1
				}
				if (changed) rebuilt = { ...current, children: blocks }
				break
			}
			case 'listItem': {
				const blocks: BlockNode[] = []
				let offset = 0
				for (const block of current.children) {
					if (block === undefined) continue
					const child = children[offset]
					const accepted = child !== undefined && isBlockNode(child) ? child : block
					blocks.push(accepted)
					if (accepted !== block) changed = true
					offset += 1
				}
				if (changed) rebuilt = { element: 'listItem', children: blocks }
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
					const accepted = child !== undefined && isInlineNode(child) ? child : inline
					inlines.push(accepted)
					if (accepted !== inline) changed = true
					offset += 1
				}
				if (changed) rebuilt = { ...current, children: inlines }
				break
			}
			case 'list': {
				const items: ListItemNode[] = []
				let offset = 0
				for (const item of current.items) {
					if (item === undefined) continue
					const child = children[offset]
					const accepted = child?.element === 'listItem' ? child : item
					items.push(accepted)
					if (accepted !== item) changed = true
					offset += 1
				}
				if (changed) rebuilt = { ...current, items }
				break
			}
			case 'table': {
				let offset = 0
				const header: Array<readonly InlineNode[]> = []
				for (const cell of current.header) {
					if (cell === undefined) continue
					const inlines: InlineNode[] = []
					for (const inline of cell) {
						if (inline === undefined) continue
						const child = children[offset]
						const accepted = child !== undefined && isInlineNode(child) ? child : inline
						inlines.push(accepted)
						if (accepted !== inline) changed = true
						offset += 1
					}
					header.push(inlines)
				}
				const rows: Array<ReadonlyArray<readonly InlineNode[]>> = []
				for (const row of current.rows) {
					if (row === undefined) continue
					const cells: Array<readonly InlineNode[]> = []
					for (const cell of row) {
						if (cell === undefined) continue
						const inlines: InlineNode[] = []
						for (const inline of cell) {
							if (inline === undefined) continue
							const child = children[offset]
							const accepted = child !== undefined && isInlineNode(child) ? child : inline
							inlines.push(accepted)
							if (accepted !== inline) changed = true
							offset += 1
						}
						cells.push(inlines)
					}
					rows.push(cells)
				}
				if (changed) rebuilt = { ...current, header, rows }
				break
			}
		}
		if (rebuilt !== current) derivations.set(rebuilt, current)
		if (current.element === 'document') {
			const result = rebuilt.element === 'document' ? rebuilt : current
			const output = new Set(walkNodes(result))
			const retained = new Map<MarkdownNode, MarkdownNode | undefined>()
			for (const [node, source] of derivations) if (output.has(node)) retained.set(node, source)
			return [result, retained]
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
		if (accepted !== rebuilt && accepted !== current) {
			if (derivations.has(accepted) && derivations.get(accepted) !== current)
				derivations.set(accepted, undefined)
			else derivations.set(accepted, current)
		}
		values.push(accepted)
	}
	return [document, new Map()]
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
	const stack: Array<{ readonly node: MarkdownNode; readonly depth: number }> = [{ node, depth: 0 }]
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
