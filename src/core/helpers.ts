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
	CodeSpanMatch,
	EmphasisBounds,
	EmphasisScan,
	FenceMatch,
	HeadingMatch,
	InlineNode,
	LinkBounds,
	LinkScan,
	ListCollection,
	ListItemNode,
	ListItemMatch,
	ListNode,
	MarkdownCell,
	MarkdownDerivation,
	MarkdownDocument,
	MarkdownHandlerMap,
	MarkdownInlineScan,
	MarkdownNode,
	MarkdownProjection,
	MarkdownRewriteHandler,
	MarkdownSegment,
	MarkdownSource,
	MarkdownSpan,
	TableAlign,
	TableCollection,
	TableNode,
} from './types.js'
import { EMPTY_PROJECTION, MAX_DEPTH } from './constants.js'
import { isBlockNode, isInlineNode, isTextNode } from './validators.js'
import { parseBlocks } from './parsers.js'
import {
	isEmptyString,
	isNonEmptyArray,
	isNonEmptyString,
	isString,
	parseInteger,
} from '@orkestrel/contract'
import {
	SAFE_URL_SCHEMES,
	TABLE_ALIGNMENTS,
	UNSAFE_ELEMENTS,
	attributeOf,
	collapseSpace,
	foldNode as foldHTMLNode,
	renderText,
	sanitizeURL,
} from '@orkestrel/html'

//  Markdown parsing + rendering leaves (pure and total)
//
// The pure leaf primitives {@link parseDocument} composes: the line / character
// structural predicates (blank lines, quotes, fence closers, thematic breaks, table
// starts, escapable and whitespace characters), the line / block scanners (headings,
// fences, list items, table rows), the `collect*` construct scanners (GFM tables and
// lists), the inline `scan*` engine (emphasis / links / code with backslash escapes),
// and the HTML AST projection the renderer composes with @orkestrel/html. A predicate
// over a raw `string` is a leaf rather than a `Guard<T>`, so it lives here and not in
// validators.ts. Every function is pure, total, and referentially transparent —
// malformed input degrades to text, never throws — so each is unit-tested in isolation.
// The `parse*` entry points that thread these together (the block / inline phase
// entries) live in parsers.ts: a helper is a functional-core leaf, a parser is the
// phase it names. A construct scanner calls back into its phase entry, so helpers.ts
// and parsers.ts are mutually recursive by design. Inline scanning is index-based (no
// backtracking regex) so it is linear-time — no ReDoS on adversarial input.
//
// This file imports no implementation class: the class-driving renderer that composes
// {@link markdownToHTML} with `@orkestrel/html`'s sanitizer lives in compilers.ts.

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
	return Iterator.from(markdown.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g))
		.filter((match) => match.index < markdown.length || markdown.length === 0)
		.map((match): MarkdownSource => {
			const text = match[1] ?? ''
			return {
				text,
				segments: [{ offset: 0, start: match.index, end: match.index + text.length }],
			}
		})
		.toArray()
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
	const segments = source.segments
		.keys()
		.flatMap((index): readonly MarkdownSegment[] => {
			const segment = source.segments[index]
			if (segment === undefined) return []
			const next = source.segments[index + 1]
			const limit = Math.min(
				segment.offset + (segment.end - segment.start),
				next === undefined ? source.text.length : next.offset,
			)
			const overlapStart = Math.max(start, segment.offset)
			const overlapEnd = Math.min(end, limit)
			const empty = segment.offset === limit && overlapStart === segment.offset
			if (overlapStart >= overlapEnd && !empty) return []
			const originalStart =
				overlapStart === limit
					? segment.end
					: Math.min(segment.end, segment.start + overlapStart - segment.offset)
			const originalEnd =
				overlapEnd === limit
					? segment.end
					: Math.min(segment.end, segment.start + overlapEnd - segment.offset)
			return [
				{
					offset: overlapStart - start,
					start: originalStart,
					end: originalEnd,
				},
			]
		})
		.toArray()
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
	const parts: string[] = []
	const segments: MarkdownSegment[] = []
	sources.keys().reduce((offset, index) => {
		const source = sources[index]
		if (source === undefined) return offset
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
				segments.push({ offset, start: left.end, end: right.start })
			parts.push(separator)
		}
		const start = offset + (index > 0 ? separator.length : 0)
		for (const segment of source.segments) {
			segments.push({
				offset: start + segment.offset,
				start: segment.start,
				end: segment.end,
			})
		}
		const text = source.text
		parts.push(text)
		return start + text.length
	}, 0)
	return { text: parts.join(''), segments }
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
	const [spanStart, spanEnd] = source.segments
		.keys()
		.reduce<readonly [number | undefined, number | undefined, boolean]>(
			([start, end, found], index) => {
				if (found) return [start, end, found]
				const segment = source.segments[index]
				if (segment === undefined) return [start, end, false]
				const next = source.segments[index + 1]
				const limit = Math.min(
					segment.offset + (segment.end - segment.start),
					next === undefined ? source.text.length : next.offset,
				)
				if (from === to && from >= segment.offset && from <= limit) {
					if (next !== undefined && from === next.offset) return [start, end, false]
					const position =
						from === limit
							? segment.end
							: Math.min(segment.end, segment.start + from - segment.offset)
					return [position, position, true]
				}
				return [
					start === undefined && from >= segment.offset && from < limit
						? segment.start + from - segment.offset
						: start,
					to > segment.offset && to <= limit
						? to === limit
							? segment.end
							: Math.min(segment.end, segment.start + to - segment.offset)
						: end,
					false,
				]
			},
			[undefined, undefined, false],
		)
	return spanStart === undefined || spanEnd === undefined
		? undefined
		: { start: spanStart, end: spanEnd }
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
 * Counts the leading space / tab characters on `line` (a tab counts as one) — the
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
	return line.match(/^[ \t]*/)?.[0].length ?? 0
}

//  Line + character structural predicates
//
// Boolean predicates over a raw `string` (or a character of one) that the block and
// inline phases test lines with. None narrows a type, so none is a `Guard<T>` and none
// belongs in validators.ts; `isFenceClose` and `isTableStart` take two arguments, which
// no guard signature admits.

/**
 * Checks whether `character` is whitespace under the emphasis flanking rule — a space, a
 * tab, or a newline.
 *
 * @param character - The character to test
 * @returns True if the flanking rule counts it as whitespace; false otherwise
 *
 * @example
 * ```ts
 * isFlankingWhitespace(' ') // true
 * isFlankingWhitespace('a') // false
 * ```
 */
export function isFlankingWhitespace(character: string): boolean {
	return character === ' ' || character === '\t' || character === '\n'
}

/**
 * Checks whether `character` is escapable by a leading backslash — the ASCII punctuation
 * markdown gives meaning to (so `\*` becomes `*` but `\.` stays `\.`).
 *
 * @param character - The single character after a backslash
 * @returns True if a backslash before it is an escape; false otherwise
 *
 * @example
 * ```ts
 * isEscapable('*') // true
 * isEscapable('a') // false
 * ```
 */
export function isEscapable(character: string): boolean {
	return /[\\`*_{}[\]()#+\-.!>~|]/.test(character)
}

/**
 * Checks whether `line` is blank — empty, or containing only whitespace — the markdown
 * definition of a blank line that block parsing uses to separate paragraphs, skip
 * gaps, and end list continuations.
 *
 * @param line - The candidate line
 * @returns True if the line is blank; false otherwise
 *
 * @example
 * ```ts
 * isBlankLine('   ') // true
 * ```
 */
export function isBlankLine(line: string): boolean {
	return isEmptyString(line.trim())
}

/**
 * Checks whether `line` is a blockquote line (`>` optionally indented up to three spaces) —
 * its content is de-quoted by {@link stripQuote}.
 *
 * @param line - The candidate line
 * @returns True if the line begins a blockquote; false otherwise
 *
 * @example
 * ```ts
 * isQuote('> quoted') // true
 * ```
 */
export function isQuote(line: string): boolean {
	return /^\s{0,3}>/.test(line)
}

/**
 * Checks whether `line` closes a fence opened by `marker` — the same fence character, a run
 * at least as long, and nothing else but surrounding whitespace.
 *
 * @param line - The candidate closing line
 * @param marker - The opening fence's marker run (from {@link extractFence})
 * @returns True if `line` closes the fence; false otherwise
 *
 * @example
 * ```ts
 * isFenceClose('```', '```') // true
 * ```
 */
export function isFenceClose(line: string, marker: string): boolean {
	const character = marker[0] === '~' ? '~' : '`'
	const trimmed = line.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '')
	return (
		trimmed.length >= marker.length && Iterator.from(trimmed).every((value) => value === character)
	)
}

/**
 * Checks whether `character` is a regex-`\s`-equivalent whitespace character — the
 * character class {@link isFenceClose}'s scan treats as surrounding padding.
 *
 * @param character - The single character to test, or `undefined` past the end of a line
 * @returns True if it is whitespace; false otherwise
 *
 * @example
 * ```ts
 * isFenceWhitespace(' ')         // true
 * isFenceWhitespace(undefined)   // false
 * ```
 */
export function isFenceWhitespace(character: string | undefined): boolean {
	return (
		character === ' ' ||
		character === '\t' ||
		character === '\n' ||
		character === '\r' ||
		character === '\f' ||
		character === '\v'
	)
}

/**
 * Checks whether `line` is a thematic break (horizontal rule) — three or more of the same
 * marker `-`, `*`, or `_` (optionally space-separated) and nothing else (`---`,
 * `***`, `___`, `- - -`).
 *
 * @param line - The candidate line
 * @returns True if the line is a thematic break; false otherwise
 *
 * @example
 * ```ts
 * isThematicBreak('---') // true
 * ```
 */
export function isThematicBreak(line: string): boolean {
	const stripped = line.trim().replace(/\s+/g, '')
	if (stripped.length < 3) return false
	const marker = stripped[0]
	if (marker !== '-' && marker !== '*' && marker !== '_') return false
	return [...stripped].every((character) => character === marker)
}

/**
 * Checks whether the pair (`header`, `delimiter`) opens a GFM table — `delimiter` is a row of
 * `|`-separated cells each matching `:?-+:?`, the GFM rule that a table requires a
 * header row immediately followed by a delimiter row.
 *
 * @param header - The candidate header line
 * @param delimiter - The line after it (the candidate delimiter)
 * @returns True if the two lines open a table; false otherwise
 *
 * @example
 * ```ts
 * isTableStart('| a |', '| - |') // true
 * ```
 */
export function isTableStart(header: string, delimiter: string | undefined): boolean {
	if (delimiter === undefined || !header.includes('|')) return false
	const cells = splitTableRow(delimiter)
	if (cells.length === 0) return false
	return cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
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
export function extractHeading(line: string): HeadingMatch | undefined {
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
 * Extracts a fenced-code opening line (```` ``` ```` or `~~~`, optionally with an info
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
export function extractFence(line: string): FenceMatch | undefined {
	const match = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line)
	if (!match || match[1] === undefined) return undefined
	const info = (match[2] ?? '').trim()
	// A backtick in a backtick fence's info string is invalid (ambiguous with a span).
	if (match[1].startsWith('`') && info.includes('`')) return undefined
	const lang = isNonEmptyString(info) ? info.split(/\s+/)[0] : undefined
	return { marker: match[1], lang }
}

/**
 * Extracts a list-item line (`-` / `*` / `+` bullet, or `1.` / `1)` ordinal, followed by
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
 * Splits one GFM table row into its cell strings — outer pipes are optional, a pipe
 * escaped by a leading backslash inside a cell is not a separator (it becomes a literal
 * pipe character), and the empty leading / trailing cell an outer pipe produces is
 * dropped. Derives the string form from {@link splitTableSources}, which owns the
 * escaped-pipe splitting rule.
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
	const pieces: MarkdownSource[] = []
	const [tailStart, tailOffset] = Iterator.from(source.text.matchAll(/\\\||\|/g)).reduce<
		readonly [number, number]
	>(
		([start, offset], match) => {
			const index = match.index
			pieces.push(sliceSource(source, start, index))
			if (match[0] === '\\|') {
				const span = projectSpan(source, index, index + 2)
				pieces.push({
					text: '|',
					segments: span === undefined ? [] : [{ offset: 0, start: span.start, end: span.end }],
				})
				return [index + 2, offset]
			}
			cells.push(joinSources(pieces.slice(offset), ''))
			return [index + 1, pieces.length]
		},
		[0, 0],
	)
	pieces.push(sliceSource(source, tailStart, source.text.length))
	cells.push(joinSources(pieces.slice(tailOffset), ''))
	const first = isEmptyString((cells[0]?.text ?? '').trim()) ? 1 : 0
	const end = isEmptyString((cells.at(-1)?.text ?? '').trim()) ? cells.length - 1 : cells.length
	return cells.slice(first, end)
}

/**
 * Derives the per-column {@link TableAlign} list from a GFM delimiter row — `:---`
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
 * Checks whether the line at `index` starts a new block kind (heading / fence / thematic
 * break / blockquote / list / table) — the paragraph collector stops at such a line
 * so a block following a paragraph without a blank line still parses (a trusted-input
 * caller writing a `##` heading directly under a paragraph, with no intervening blank
 * line).
 *
 * @param lines - The document's lines
 * @param index - The line index to test
 * @returns True if the line begins a different block; false otherwise
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
 * Resolves backslash escapes in a raw string to their literal characters — used for a
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
	return text.replace(/\\([\s\S])/g, (match, character: string) =>
		isEscapable(character) ? character : match,
	)
}

/**
 * Merges adjacent text nodes into one — the inline scanner emits a text node per
 * unrecognized character, so coalescing keeps the AST clean and assertion-friendly.
 *
 * @param nodes - The inline nodes (possibly with adjacent text runs)
 * @param spans - The optional operation-owned span memo; inserts merged-node entries
 *   without deleting or replacing constituent entries
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
	return splitTextRuns(nodes)
		.map((run): InlineNode | undefined => {
			const first = run[0]
			if (first === undefined || run.length === 1) return first
			const merged: InlineNode = {
				element: 'text',
				value: run
					.filter(isTextNode)
					.map((part) => part.value)
					.join(''),
			}
			const last = run.at(-1)
			const left = spans?.get(first)
			const right = last === undefined ? undefined : spans?.get(last)
			if (left !== undefined && right !== undefined)
				spans?.set(merged, { start: left.start, end: right.end })
			return merged
		})
		.filter((node) => node !== undefined)
}

/**
 * Scans an inline code span at `start` (a `` ` ``-run … a matching `` ` ``-run of the
 * same length, the CommonMark rule that lets a span contain backticks). Returns the
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
export function scanCode(source: string, start: number, to: number): CodeSpanMatch | undefined {
	const run = source[start] === '`' ? countMarkdownRun(source, start, to) : 0
	const open = '`'.repeat(run)
	const attempts = walkMarkdownCharacters(source, 0, source.length + 2)
	const [, result] = attempts.reduce<readonly [number, CodeSpanMatch | undefined]>(
		([search]) => {
			const closeAt = source.indexOf(open, search)
			if (closeAt === -1 || closeAt + run > to) {
				attempts.return(undefined)
				return [search, undefined]
			}
			if (source[closeAt - 1] !== '`' && source[closeAt + run] !== '`') {
				attempts.return(undefined)
				const raw = source.slice(start + run, closeAt)
				const value =
					raw.length > 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim().length > 0
						? raw.slice(1, -1)
						: raw
				return [search, { value, end: closeAt + run }]
			}
			return [closeAt + 1, undefined]
		},
		[start + run, undefined],
	)
	return result
}

/**
 * Locates a link `[text](href)` at `start` — the text runs to a balanced `]`, then `(`
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
export function locateLink(source: string, start: number, to: number): LinkBounds | undefined {
	const close = locateMarkdownDelimiter(source, start, to, '[', ']')
	if (close === undefined || source[close + 1] !== '(') return undefined
	const end = locateMarkdownDelimiter(source, close + 1, to, '(', ')')
	return end === undefined ? undefined : { close, end: end + 1 }
}

/**
 * Scans a link `[text](href)` at `start` — the text runs to a balanced `]`, then `(`
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
): LinkScan | undefined {
	const located = locateLink(source, start, to)
	if (located === undefined) return undefined
	const href = unescapeText(source.slice(located.close + 2, located.end - 1).trim())
	const children = scanInline(source, start + 1, located.close, depth + 1)
	return { node: { element: 'link', href, children }, end: located.end }
}

/**
 * Locates an emphasis run at `start` (`*` / `_`, doubled for strong) — finds the nearest
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
): EmphasisBounds | undefined {
	const marker = source[start] ?? ''
	const run = Math.min(2, countMarkdownRun(source, start, to))
	const strong = run === 2
	const openEnd = start + run
	if (openEnd >= to || isFlankingWhitespace(source[openEnd] ?? '')) return undefined
	const characters = walkMarkdownCharacters(source, openEnd, to)
	const [, result] = characters.reduce<readonly [number, EmphasisBounds | undefined]>(
		([next], [index, character]) => {
			if (index < next) return [next, undefined]
			if (character === '\\') return [index + 2, undefined]
			if (character === '`') {
				const span = scanCode(source, index, to)
				return [span ? span.end : index + 1, undefined]
			}
			if ((character === '*' || character === '_') && character !== marker) {
				const nested = locateEmphasis(source, index, to)
				if (nested !== undefined) return [nested.end, undefined]
			}
			if (character === marker) {
				const closeRun = countMarkdownRun(source, index, to)
				if (closeRun >= run && !isFlankingWhitespace(source[index - 1] ?? '')) {
					characters.return(undefined)
					return [index + run, { strong, open: openEnd, close: index, end: index + run }]
				}
				return [index + closeRun, undefined]
			}
			return [index + 1, undefined]
		},
		[openEnd, undefined],
	)
	return result
}

/**
 * Scans an emphasis run at `start` (`*` / `_`, doubled for strong) — finds the nearest
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
): EmphasisScan | undefined {
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
 * Scans the window `[from, to)` of `source` into inline nodes — the single recursive
 * engine the inline phase runs on (emphasis, link text, and image alternative
 * content recurse through it). Linear:
 * each character is consumed once; a failed construct emits its opening character as
 * text and advances by one, so there is no re-scan (no ReDoS).
 *
 * @param source - The inline source text
 * @param from - The inclusive start of the scan window
 * @param to - The exclusive end of the scan window
 * @param depth - The current inline-recursion depth (defaults to 0 at the entry point);
 *   incremented by one on every recursive descent {@link scanInlineSource} makes into
 *   itself for a link's text, an image's alternative content, or an emphasis run's
 *   children. At {@link MAX_DEPTH} the window is never scanned for markup — it emits as
 *   a single literal text node — so pathological nesting (`[[[[…`, `****…`) cannot
 *   exhaust the call stack.
 * @returns The parsed inline nodes (not yet coalesced)
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
 * @param depth - The current inline-recursion depth, incremented by one on every
 *   recursive descent this function makes into itself for a link's text, an image's
 *   alternative content, or an emphasis run's children
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
	const parts: string[] = []
	const [end, pendingStart, partOffset] = walkMarkdownCharacters(source.text, from, to).reduce<
		readonly [number, number, number]
	>(
		([next, start, offset], [index, character]) => {
			if (index < next) return [next, start, offset]
			if (character === '\\' && index + 1 < to && isEscapable(source.text[index + 1] ?? '')) {
				parts.push(source.text[index + 1] ?? '')
				return [index + 2, start, offset]
			}
			const scanned = scanMarkdownInline(source, index, to, spans, depth)
			if (scanned !== undefined) {
				recordMarkdownText(source, parts.slice(offset).join(''), start, index, spans, nodes)
				const span = projectSpan(source, index, scanned.end)
				if (span !== undefined) spans.set(scanned.node, span)
				nodes.push(scanned.node)
				return [scanned.end, scanned.end, parts.length]
			}
			parts.push(character)
			return [index + 1, start, offset]
		},
		[from, from, 0],
	)
	recordMarkdownText(source, parts.slice(partOffset).join(''), pendingStart, end, spans, nodes)
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
): TableCollection {
	const headerCells = splitTableSources(lines[start] ?? { text: '', segments: [] })
	const columns = headerCells.length
	const header = headerCells.map((cell) => {
		const source = trimSource(cell)
		return coalesceText(scanInlineSource(source, 0, source.text.length, spans), spans)
	})
	const align = delimiterToAlignments(lines[start + 1]?.text ?? '')
	const padded = Array.from({ length: columns }, (_, column) => align[column] ?? null)
	const entries: Array<readonly [number, ReadonlyArray<readonly InlineNode[]>]> = []
	for (const index of walkMarkdownLines(lines, start + 2)) {
		if (isBlankLine(lines[index]?.text ?? '') || !(lines[index]?.text ?? '').includes('|')) break
		const cells = splitTableSources(lines[index] ?? { text: '', segments: [] })
		const row = Array.from({ length: columns }, (_, column) => {
			const source = trimSource(cells[column] ?? { text: '', segments: [] })
			return coalesceText(scanInlineSource(source, 0, source.text.length, spans), spans)
		})
		entries.push([index, row])
	}
	const index = entries.length === 0 ? start + 2 : (entries.at(-1)?.[0] ?? start + 1) + 1
	const rows = entries.map(([, row]) => row)
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
): ListCollection {
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
	const nested = walkMarkdownLines(lines, start).every((cursor) => {
		const parsed = extractListItem(text[cursor] ?? '')
		const previous = chain[chain.length - 1]
		if (
			parsed === undefined ||
			(previous !== undefined && (previous.content.length > 0 || parsed.indent !== previous.marker))
		) {
			return false
		}
		chain.push(parsed)
		return true
	})
	const remaining = MAX_DEPTH - depth
	if (nested && remaining > 0 && chain.length > remaining) {
		const terminal = chain[remaining - 1]
		const terminalLine = lines[start + remaining - 1]
		if (terminal !== undefined && terminalLine !== undefined) {
			const sources: MarkdownSource[] = [
				sliceSource(terminalLine, terminal.marker, terminalLine.text.length),
			]
			for (const cursor of walkMarkdownLines(lines, start + remaining)) {
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
			const levels = Array.from({ length: Math.ceil(remaining) }, (_, step) => step)
			const node = levels.reduce<ListNode | undefined>((child, step) => {
				const cursor = remaining - 1 - step
				const children: readonly BlockNode[] = child === undefined ? [paragraph] : [child]
				const parsed = chain[cursor]
				if (parsed === undefined) return child
				const item: ListItemNode = { element: 'listItem', children }
				const parent: ListNode = {
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
					spans.set(parent, span)
				}
				return parent
			}, undefined)
			if (node !== undefined) return { node, next: lines.length }
		}
	}
	const positions = walkMarkdownLines(lines, start)
	const finish = positions.reduce((index, position) => {
		if (position < index) return index
		const parsed = extractListItem(text[index] ?? '')
		// A sibling item shares the list's (top) indent + ordering; anything else stops
		// the top loop (a deeper item is a nested list, gathered as continuation below).
		if (!parsed || parsed.indent > topIndent || parsed.ordered !== ordered) {
			positions.return(undefined)
			return index
		}
		const itemStart = index
		const itemLine = lines[index]
		if (itemLine === undefined) {
			positions.return(undefined)
			return index
		}
		const entries: Array<readonly [number, MarkdownSource]> = [
			[index, sliceSource(itemLine, parsed.marker, itemLine.text.length)],
		]
		const continuation = parsed.marker
		for (const cursor of walkMarkdownLines(lines, index + 1)) {
			const nextSource = lines[cursor]
			if (nextSource === undefined) break
			const next = nextSource.text
			if (isBlankLine(next)) {
				const after = lines[cursor + 1]?.text ?? ''
				if (
					cursor + 1 < lines.length &&
					!isBlankLine(after) &&
					countIndent(after) >= continuation
				) {
					entries.push([cursor, sliceSource(nextSource, 0, 0)])
					continue
				}
				break
			}
			if (countIndent(next) >= continuation) {
				entries.push([cursor, sliceSource(nextSource, continuation, next.length)])
				continue
			}
			if (extractListItem(next) || startsBlock(text, cursor)) break
			entries.push([cursor, trimSource(nextSource)]) // a lazy paragraph-continuation line
		}
		const next = (entries.at(-1)?.[0] ?? index) + 1
		const itemLines = entries.map(([, line]) => line)
		const tail = itemLines[itemLines.length - 1]
		const segment = tail?.segments[tail.segments.length - 1]
		const itemEnd = next === lines.length && end !== undefined ? end : segment?.end
		const item: ListItemNode = {
			element: 'listItem',
			children: parseBlocks(itemLines, depth + 1, spans, itemEnd),
		}
		const source = joinSources(lines.slice(itemStart, next), '\n')
		const span = projectSpan(source, 0, source.text.length)
		if (span !== undefined) spans.set(item, span)
		items.push(item)
		return next
	}, start)
	const node: ListNode = { element: 'list', ordered, start: startOrdinal, items }
	const source = joinSources(lines.slice(start, finish), '\n')
	const span = projectSpan(source, 0, source.text.length)
	if (span !== undefined) spans.set(node, span)
	return { node, next: finish }
}

//  Rendering (Markdown AST → HTML AST → sanitized HTML string)

/**
 * Projects a {@link MarkdownNode} into an unsanitized {@link HTMLDocument}.
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
					'value' in current && isString(current.value)
						? { category: 'text', value: current.value }
						: undefined,
				)
				continue
			}
			const children: MarkdownNode[] = []
			const depth =
				frame.depth + (current.element === 'document' ? 0 : current.element === 'table' ? 4 : 1)
			switch (current.element) {
				case 'document':
					for (const child of current.children) if (child !== undefined) children.push(child)
					break
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
					break
				case 'list':
					for (const child of current.items) if (child !== undefined) children.push(child)
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
					break
			}
			if (current.element === 'codeBlock' && frame.depth + 2 > MAX_DEPTH) {
				values.push(undefined)
				continue
			}
			stack.push({ ...frame, expanded: true, count: children.length })
			for (const index of children.keys().toArray().toReversed()) {
				const child = children[index]
				if (child !== undefined) stack.push({ node: child, depth, expanded: false, count: 0 })
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		const value = projectMarkdownNode(current, children)
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
 * Projects one markdown node from its already projected children.
 *
 * @example
 * ```ts
 * projectMarkdownNode({ element: 'text', value: 'hi' }, []) // { category: 'text', value: 'hi' }
 * ```
 */
export function projectMarkdownNode(
	current: MarkdownNode,
	children: ReadonlyArray<HTMLNode | undefined>,
): HTMLNode | undefined {
	const projected: HTMLNode[] = []
	for (const child of children) if (child !== undefined) projected.push(child)
	switch (current.element) {
		case 'document':
			return { category: 'document', children: projected }
		case 'heading':
			return {
				category: 'element',
				name: `h${current.level}`,
				attributes: [],
				children: projected,
			}
		case 'paragraph':
			return { category: 'element', name: 'p', attributes: [], children: projected }
		case 'thematicBreak':
			return { category: 'element', name: 'hr', attributes: [], children: [] }
		case 'blockquote':
			return {
				category: 'element',
				name: 'blockquote',
				attributes: [],
				children: projected,
			}
		case 'codeBlock':
			return {
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
		case 'list':
			return {
				category: 'element',
				name: current.ordered ? 'ol' : 'ul',
				attributes:
					current.ordered && current.start !== 1
						? [{ name: 'start', value: String(current.start) }]
						: [],
				children: projected,
			}
		case 'listItem':
			return { category: 'element', name: 'li', attributes: [], children: projected }
		case 'table': {
			const outputs = children.values()
			const header: HTMLNode[] = []
			for (const [column, cell] of current.header.entries()) {
				if (cell === undefined) continue
				const align = current.align[column]
				const attributes =
					align === 'left' || align === 'right' || align === 'center'
						? [{ name: 'align', value: align }]
						: []
				const count = Iterator.from(cell)
					.filter((child) => child !== undefined)
					.reduce((sum) => sum + 1, 0)
				const cellChildren: HTMLNode[] = []
				for (const child of outputs.take(count).toArray())
					if (child !== undefined) cellChildren.push(child)
				header.push({
					category: 'element',
					name: 'th',
					attributes,
					children: cellChildren,
				})
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
					const count = Iterator.from(cell)
						.filter((child) => child !== undefined)
						.reduce((sum) => sum + 1, 0)
					const cellChildren: HTMLNode[] = []
					for (const child of outputs.take(count).toArray())
						if (child !== undefined) cellChildren.push(child)
					cells.push({
						category: 'element',
						name: 'td',
						attributes,
						children: cellChildren,
					})
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
			return {
				category: 'element',
				name: 'table',
				attributes: [],
				children: tableChildren,
			}
		}
		case 'text':
			return { category: 'text', value: current.value }
		case 'emphasis':
			return {
				category: 'element',
				name: current.strong ? 'strong' : 'em',
				attributes: [],
				children: projected,
			}
		case 'codeSpan':
			return {
				category: 'element',
				name: 'code',
				attributes: [],
				children: [{ category: 'text', value: current.value }],
			}
		case 'link':
			return {
				category: 'element',
				name: 'a',
				attributes: [{ name: 'href', value: current.href }],
				children: projected,
			}
		case 'image':
			return {
				category: 'element',
				name: 'img',
				attributes: [
					{ name: 'src', value: current.src },
					{ name: 'alt', value: flattenText(current) },
				],
				children: [],
			}
		case 'break':
			return { category: 'element', name: 'br', attributes: [], children: [] }
		default:
			return undefined
	}
}

/**
 * Renders a {@link MarkdownNode} to its canonical markdown source — the inverse
 * projection of `renderHTML`. It is the serializer a `parse(renderMarkdown(doc))`
 * round-trip is built on. Canonical forms: `*` / `**` emphasis at even emphasis
 * nesting depths and `_` / `__` at odd depths, `- ` bullets, `N. ` sequential
 * ordinals (from the list's `start`), `---` thematic breaks, fenced code blocks
 * (backtick run widened past any 3+ backtick run inside the body), ATX headings,
 * `> `-prefixed blockquote lines, GFM tables (1-space-padded cells, a backslash
 * before each literal pipe, an alignment delimiter row), `[text](href)` links,
 * `![alt](src)` images, and two-space hard breaks. A `text` node's literal content is backslash-escaped
 * wherever it would otherwise re-parse as markup, so parsing the rendered source
 * returns the node it was rendered from.
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
		readonly emphasis: number
	}> = [
		{
			node,
			depth: 0,
			expanded: false,
			count: 0,
			escaped: '',
			escapeBang: false,
			emphasis: 0,
		},
	]
	const values: string[] = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		const current = frame.node
		if (!frame.expanded) {
			const escaped =
				(frame.depth >= MAX_DEPTH || current.element === 'text') &&
				'value' in current &&
				isString(current.value)
					? escapeMarkdownText(current.value, current.element === 'text' && frame.escapeBang)
					: ''
			if (frame.depth >= MAX_DEPTH) {
				values.push(escaped)
				continue
			}
			const groups: Array<readonly MarkdownNode[]> = []
			const adjacent: boolean[] = []
			const depth = frame.depth + (current.element === 'table' ? 2 : 1)
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
						for (const column of current.header.keys()) {
							const cell = row[column]
							if (cell !== undefined) {
								groups.push(cell)
								adjacent.push(true)
							}
						}
					}
					break
			}
			const children: MarkdownNode[] = []
			const escapeBangs: boolean[] = []
			for (const groupIndex of groups.keys()) {
				const group = groups[groupIndex]
				if (group === undefined) continue
				for (const position of group.keys()) {
					const child = group[position]
					if (child === undefined) continue
					const following =
						adjacent[groupIndex] === true ? findFollowingNode(group, position + 1) : undefined
					const escapeBang = following?.element === 'link'
					children.push(child)
					escapeBangs.push(escapeBang)
				}
			}
			stack.push({ ...frame, expanded: true, count: children.length, escaped })
			const emphasis = current.element === 'emphasis' ? frame.emphasis + 1 : frame.emphasis
			for (const index of children.keys().toArray().toReversed()) {
				const child = children[index]
				if (child !== undefined)
					stack.push({
						node: child,
						depth,
						expanded: false,
						count: 0,
						escaped: '',
						escapeBang: escapeBangs[index] === true && depth < MAX_DEPTH,
						emphasis,
					})
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		const value = renderMarkdownNode(current, children, frame.escaped, frame.emphasis)
		if (stack.length === 0) return value
		values.push(value)
	}
	return ''
}

/**
 * Renders one markdown node from its rendered children and escaped literal text.
 *
 * @example
 * ```ts
 * renderMarkdownNode({ element: 'thematicBreak' }, [], '', 0) // '---'
 * ```
 */
export function renderMarkdownNode(
	current: MarkdownNode,
	children: readonly string[],
	literal: string,
	emphasis: number,
): string {
	switch (current.element) {
		case 'codeBlock':
		case 'codeSpan': {
			const body = current.element === 'codeBlock' ? current.code : current.value
			const longest = Iterator.from(body.matchAll(/`+/g)).reduce(
				(maximum, match) => Math.max(maximum, match[0].length),
				0,
			)
			const fence = '`'.repeat(Math.max(current.element === 'codeBlock' ? 3 : 1, longest + 1))
			if (current.element === 'codeBlock') {
				const lang = current.lang === undefined ? '' : current.lang
				return `${fence}${lang}\n${current.code}\n${fence}`
			}
			const pad = current.value.startsWith('`') || current.value.endsWith('`') ? ' ' : ''
			return `${fence}${pad}${current.value}${pad}${fence}`
		}
		case 'break':
			return '  \n'
		case 'document':
			return children.join('\n\n')
		case 'heading': {
			const text = children.join('')
			const escaped = text.replace(/(^|[^\\])(#+)$/, (_match, before: string, hashes: string) => {
				const first = hashes[0] ?? ''
				return `${before}\\${first}${hashes.slice(1)}`
			})
			return `${'#'.repeat(current.level)} ${escaped}`
		}
		case 'paragraph':
			return children.join('')
		case 'thematicBreak':
			return '---'
		case 'blockquote':
			return children
				.join('\n\n')
				.split('\n')
				.map((line) => (line === '' ? '>' : `> ${line}`))
				.join('\n')
		case 'list': {
			const items: string[] = []
			children.entries().reduce((ordinal, [position, body]) => {
				const marker = current.ordered ? `${ordinal}. ` : '- '
				const pad = ' '.repeat(marker.length)
				if (current.items[position]?.children[0]?.element === 'table') {
					items.push(
						`${marker}\n${body
							.split('\n')
							.map((line) => pad + line)
							.join('\n')}`,
					)
					return ordinal + 1
				}
				items.push(
					body
						.split('\n')
						.map((line, index) => (index === 0 ? marker + line : line === '' ? '' : pad + line))
						.join('\n'),
				)
				return ordinal + 1
			}, current.start)
			return items.join('\n')
		}
		case 'listItem':
			return children.join('\n\n')
		case 'table': {
			const outputs = children.values()
			const header: string[] = []
			for (const cell of current.header) {
				if (cell === undefined) {
					header.push('')
					continue
				}
				const count = Iterator.from(cell)
					.filter((child) => child !== undefined)
					.reduce((sum) => sum + 1, 0)
				header.push(outputs.take(count).toArray().join('').replace(/\|/g, '\\|'))
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
				for (const column of current.header.keys()) {
					const cell = row[column]
					if (cell === undefined) {
						cells.push('')
						continue
					}
					const count = Iterator.from(cell)
						.filter((child) => child !== undefined)
						.reduce((sum) => sum + 1, 0)
					cells.push(outputs.take(count).toArray().join('').replace(/\|/g, '\\|'))
				}
				rows.push(`| ${cells.join(' | ')} |`)
			}
			return [`| ${header.join(' | ')} |`, `| ${delimiter.join(' | ')} |`, ...rows].join('\n')
		}
		case 'text':
			return literal
		case 'emphasis': {
			const marker =
				emphasis % 2 === 0 ? (current.strong ? '**' : '*') : current.strong ? '__' : '_'
			return `${marker}${children.join('')}${marker}`
		}
		case 'link':
		case 'image': {
			const destination = current.element === 'link' ? current.href : current.src
			const escaped = destination.replace(/[\\()]/g, (character) => `\\${character}`)
			const prefix = current.element === 'image' ? '!' : ''
			return `${prefix}[${children.join('')}](${escaped})`
		}
		default:
			return ''
	}
}

//  Projection (HTML AST → Markdown AST)
//
// The inverse of {@link markdownToHTML}, and the reason markdown owns both
// directions: what an HTML subtree becomes is markdown-format knowledge, not HTML
// knowledge. The engine is `@orkestrel/html`'s own `foldNode` catamorphism — it
// already owns depth capping, cycle safety, and bottom-up folding — so this file
// contributes only the projection: five pure leaves over {@link MarkdownProjection}
// values ({@link trimInlines}, {@link normalizeInlines}, {@link mergeProjections},
// {@link projectionToBlocks}, {@link projectionToInlines}), the two handlers that
// map HTML to markdown ({@link projectHTMLLeaf}, {@link projectHTMLNode}), and the one
// entry point that folds them ({@link htmlToMarkdown}). HTML is richer than
// markdown, so the projection is lossy by construction; what it must never be is
// wrong, which is what the round-trip anchor law pins down. {@link createProjection}
// builds those values: it constructs a plain record under an invariant rather than an
// entity, so it is a leaf here and not a factory.

/**
 * Builds an HTML-to-markdown projection with absent fields defaulted from
 * {@link EMPTY_PROJECTION} and the block/inline exclusivity invariant enforced.
 *
 * @remarks
 * A block-bearing projection cannot also expose inline content. Callers may provide
 * both views, but `inlines` is flushed whenever `blocks` is non-empty.
 *
 * @param parts - The projection fields to provide
 * @returns A complete invariant-preserving projection
 *
 * @example
 * ```ts
 * createProjection({
 *   blocks: [{ element: 'thematicBreak' }],
 *   inlines: [{ element: 'text', value: 'discarded' }],
 * })
 * // { blocks: [{ element: 'thematicBreak' }], inlines: [], text: '', cells: [], rows: [] }
 * ```
 */
export function createProjection(parts: Partial<MarkdownProjection> = {}): MarkdownProjection {
	const blocks = parts.blocks ?? EMPTY_PROJECTION.blocks
	return {
		blocks,
		inlines: blocks.length === 0 ? (parts.inlines ?? EMPTY_PROJECTION.inlines) : [],
		text: parts.text ?? EMPTY_PROJECTION.text,
		cells: parts.cells ?? EMPTY_PROJECTION.cells,
		rows: parts.rows ?? EMPTY_PROJECTION.rows,
	}
}

/**
 * Trims the whitespace at the two ends of an inline run — the leading whitespace of a
 * leading text node and the trailing whitespace of a trailing one — dropping either
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
	return trimTrailing(trimLeading(nodes))
}

/**
 * Reduces an inline run to the shape markdown can actually write back: adjacent text
 * coalesced, empty text dropped, and every hard break either kept as a real line
 * ending or spent as a space.
 *
 * @remarks
 * A hard break is `  \n` in markdown source, so it survives a re-parse only between
 * two lines of content and only with no whitespace touching it: a leading or trailing
 * break has no line to end, a run of breaks reads as one blank line (which would end
 * the paragraph), and a space beside one is eaten by the parser's line trimming. Where
 * a break cannot be written at all — a heading and a table cell are one line each — it
 * becomes the space it stood for.
 *
 * @param nodes - The inline run to normalize
 * @param breaks - If `true`, keeps each hard break as a real line ending; if `false`, spends
 *   every break as the space it stood for, as a heading or a table cell requires
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
	const spent = coalesceText(
		Iterator.from(nodes)
			.filter((node) => node !== undefined)
			.map((node): InlineNode =>
				node.element === 'break' && !breaks ? { element: 'text', value: ' ' } : node,
			)
			.toArray(),
	)
	const starts = [
		0,
		...spent.entries().flatMap(([index, node]) => (node.element === 'break' ? [index + 1] : [])),
	]
	const segments = starts.map((start, index) => {
		const end = starts[index + 1]
		const segment = spent
			.slice(start, end === undefined ? spent.length : end - 1)
			.filter((node) => node.element !== 'text' || !isEmptyString(node.value))
		return index < starts.length - 1 ? trimTrailing(segment) : segment
	})
	const first = segments.findIndex((segment) => segment.length > 0)
	const kept = segments
		.map((segment, index) => (index > first ? trimLeading(segment) : segment))
		.filter((segment) => segment.length > 0)
	return coalesceText(
		kept.flatMap((segment, index): readonly InlineNode[] =>
			index === 0 ? segment : [{ element: 'break' }, ...segment],
		),
	)
}

/**
 * Combines the projections of one node's children into the projection of that node —
 * the single place inline runs become paragraphs, so no ancestor has to decide it
 * twice.
 *
 * @remarks
 * A child is either inline or block, never both, so merging preserves source order
 * exactly: an inline run is held pending until a block arrives, then written out as a
 * paragraph before it. That is what keeps `<div>lead<p>a</p></div>` two paragraphs in
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
	const text: string[] = []
	const [tail, remainingCells, remainingRows] = Iterator.from(children).reduce<
		readonly [
			readonly InlineNode[],
			readonly MarkdownCell[],
			ReadonlyArray<readonly MarkdownCell[]>,
		]
	>(
		([pending, cells, rows], child) => {
			if (child === undefined) return [pending, cells, rows]
			text.push(child.text)
			if (isNonEmptyArray(child.blocks)) {
				const flushed = trimInlines(normalizeInlines(pending, true))
				if (isNonEmptyArray(flushed)) blocks.push({ element: 'paragraph', children: flushed })
				for (const row of rows)
					for (const cell of row)
						if (cell !== undefined && isNonEmptyArray(cell.inlines))
							blocks.push({ element: 'paragraph', children: cell.inlines })
				for (const cell of cells)
					if (cell !== undefined && isNonEmptyArray(cell.inlines))
						blocks.push({ element: 'paragraph', children: cell.inlines })
				for (const block of projectionToBlocks(child)) blocks.push(block)
				return [[], [], []]
			}
			const rowed = isNonEmptyArray<readonly MarkdownCell[]>(child.rows)
			const nextRows = rowed
				? [
						...rows,
						...(isNonEmptyArray<MarkdownCell>(cells) ? [[...cells]] : []),
						...Iterator.from(child.rows).filter((row) => row !== undefined),
					]
				: rows
			const nextCells = [
				...(rowed ? [] : cells),
				...Iterator.from(child.cells).filter((cell) => cell !== undefined),
			]
			const nextPending = [
				...pending,
				...Iterator.from(child.inlines).filter((inline) => inline !== undefined),
			]
			return [nextPending, nextCells, nextRows]
		},
		[[], [], []],
	)
	const rowed =
		isNonEmptyArray<readonly MarkdownCell[]>(remainingRows) &&
		isNonEmptyArray<MarkdownCell>(remainingCells)
	const finalRows = rowed ? [...remainingRows, [...remainingCells]] : remainingRows
	const finalCells = rowed ? [] : remainingCells
	if (!isNonEmptyArray(blocks))
		return createProjection({
			inlines: coalesceText(tail),
			text: text.join(''),
			cells: finalCells,
			rows: finalRows,
		})
	const flushed = trimInlines(normalizeInlines(tail, true))
	if (isNonEmptyArray(flushed)) blocks.push({ element: 'paragraph', children: flushed })
	return createProjection({ blocks, text: text.join(''), cells: finalCells, rows: finalRows })
}

/**
 * Reads a projection as block content — the view a document, a blockquote, and a list
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
 * Reads a projection as inline content — the view a link, an emphasis, and a table cell
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
	const value = collapseSpace(projectionToBlocks(projection).map(flattenText).join(' '))
	return isEmptyString(value) ? [] : [{ element: 'text', value }]
}

/**
 * Projects one HTML leaf — a text node, a comment, or a doctype — to its
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
 * Projects one HTML container — the document root or an element — from its children's
 * already-computed projections. The element mapping, and the only place that decides
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
 * `UNSAFE_ELEMENTS` subtree contributes nothing at all, text included. Every other
 * element unwraps to its children, so wrapper soup melts while its content keeps its
 * shape — `<div><p>a</p><p>b</p></div>` stays two paragraphs.
 *
 * Three mappings read their own node rather than only their children's projections,
 * because HTML puts the fact in a position rather than in a value: a `pre` takes its
 * body from its `code` child's raw text, and a list takes one item per `li` child — so
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
			// padding moves outside the marker rather than being lost with the word boundary.
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
			// A span padded on both sides is exactly what the parser strips back off, so the
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
			const position = node.children
				.entries()
				.find(([, child]) => child?.category === 'element')?.[0]
			const source = position === undefined ? undefined : node.children[position]
			const projected = position === undefined ? undefined : children[position]
			if (source?.category === 'element' && source.name === 'code' && projected !== undefined) {
				const lang = (attributeOf(source, 'class') ?? '')
					.split(/\s+/)
					.find(
						(token) => token.startsWith('language-') && token.length > 9 && !token.includes('`'),
					)
					?.slice(9)
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
			const alt = collapseSpace(attributeOf(node, 'alt') ?? '')
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
			// html's set is the gate; the union is the bridge — an alignment markdown has no
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
				readonly children: readonly HTMLNode[]
				readonly index: number
				readonly direct: boolean
			}> = [{ children: node.children, index: 0, direct: false }]
			while (sources.length > 0) {
				const source = sources.pop()
				if (source === undefined) continue
				if (source.index >= source.children.length) continue
				const child = source.children[source.index]
				sources.push({
					...source,
					index: source.index + 1,
					direct:
						child?.category === 'element'
							? child.name === 'th' || child.name === 'td'
							: source.direct,
				})
				if (child?.category !== 'element') continue
				if (child.name === 'th' || child.name === 'td') {
					if (!source.direct) {
						headings.push(false)
						rowed.push(false)
					}
					continue
				}
				if (child.name === 'tr') {
					const heading = Iterator.from(child.children).some(
						(cell) => cell?.category === 'element' && cell.name === 'th',
					)
					headings.push(heading)
					rowed.push(true)
					continue
				}
				sources.push({ children: child.children, index: 0, direct: false })
			}
			// The header is the first structurally th-bearing row, then the first explicit
			// row; a table made only of direct cells receives an empty synthetic header.
			const position =
				headings.entries().find(([, heading]) => heading)?.[0] ??
				rowed.entries().find(([, structural]) => structural)?.[0]
			const headerRow = position === undefined ? undefined : rows[position]
			const columns = headerRow?.length ?? rows[0]?.length ?? 0
			if (columns === 0) {
				return createProjection({
					blocks: projectionToBlocks(merged),
					text: merged.text,
				})
			}
			const headerCells = Array.from({ length: columns }, (_, column) => headerRow?.[column])
			const header = headerCells.map((cell) => cell?.inlines ?? [])
			const align = headerCells.map((cell) => cell?.align ?? null)
			const body: Array<ReadonlyArray<readonly InlineNode[]>> = []
			for (const [index, row] of rows.entries()) {
				if (row === undefined || index === position) continue
				const cells: Array<readonly InlineNode[]> = []
				for (const column of header.keys()) cells.push(row[column]?.inlines ?? [])
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
 * Projects an `@orkestrel/html` {@link HTMLNode} into a {@link MarkdownDocument} — the
 * HTML→markdown direction, and the inverse of {@link markdownToHTML}.
 *
 * @remarks
 * **Engine.** One total handler table — {@link projectHTMLNode} for the containers,
 * {@link projectHTMLLeaf} for the leaves — folded by `@orkestrel/html`'s own `foldNode`, so
 * depth capping, cycle safety, and bottom-up ordering are inherited rather than
 * rebuilt. Total: hostile, cyclic, and pathologically deep input degrades instead of
 * throwing.
 *
 * **Composed depth.** Both packages cap recursion at 64, and html's cap is reached
 * first: a document nested past it projects to a chain bounded by that cap, with the
 * content below it truncated before markdown ever sees it. Since the projected chain
 * can be a level or two deeper than {@link MAX_DEPTH}, the serializer's own cap can
 * then truncate again — so the anchor law that follows is a law within the depth budget, and
 * beyond it only totality is promised.
 *
 * **Safety.** Every `href` and `src` is re-sanitized through
 * `sanitizeURL(value, SAFE_URL_SCHEMES)` whether or not the AST was ever sanitized,
 * because a hand-built one never was. A refused destination empties to `''` and the
 * link or image is kept — `[text]()` — because a bad URL is no reason to lose the words
 * around it. An `UNSAFE_ELEMENTS` subtree contributes nothing at all, text included, so
 * a `script` body can never resurface as prose.
 *
 * **The anchor law.** HTML→markdown is lossy, so the fixpoint that matters is the
 * projected AST, not the input bytes:
 * `parseDocument(renderMarkdown(htmlToMarkdown(x)))` deep-equals `htmlToMarkdown(x)`.
 * The projection therefore emits canonical markdown shapes rather than literal
 * translations — whitespace collapsed, edges trimmed, a blank paragraph dropped, a hard
 * break only where a line can end — because a shape markdown cannot write back is a
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
 * Walks a {@link MarkdownNode} depth-first, pre-order, root-inclusive — yields
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
		const children = listChildren(frame.node)
		for (const index of children.keys().toArray().toReversed()) {
			const child = children[index]
			if (child !== undefined) stack.push({ node: child, depth: frame.depth + 1 })
		}
	}
}

/**
 * Folds a {@link MarkdownNode} into a `T` through a total catamorphism — children are
 * folded first (post-order), then the node's own {@link MarkdownHandler} is invoked
 * with the already-folded children.
 *
 * @remarks
 * **Table contract.** A {@link TableNode} has no single `children` array — its cells
 * live in `header` (one inline-node list per column) and `rows` (a list of such
 * rows). The `table` handler receives one folded `T` per inline node, flattened in
 * walk order across all cells — every header cell's inline nodes (column order), then
 * every body row's cells' inline nodes (row order, then column order) — and reads
 * `node.header[c].length` / `node.rows[r][c].length` off the table node itself to
 * recover cell boundaries within the flat list.
 *
 * Total: never throws. At `depth >= {@link MAX_DEPTH}` the node's handler is invoked
 * with an empty children list instead of recursing further.
 *
 * @param node - The AST node to fold
 * @param handlers - The total {@link MarkdownHandlerMap} table, one handler per element
 * @param depth - The starting recursion depth (pass `0` at the entry point)
 * @returns The folded `T`
 *
 * @example
 * ```ts
 * const countHandlers: MarkdownHandlerMap<number> = {
 *   document: (_, children) => children.reduce((a, b) => a + b, 1),
 *   // ...one handler per element, each summing its folded children
 * }
 * foldNode(document, countHandlers, 0) // total node count
 * ```
 */
export function foldNode<T>(node: MarkdownNode, handlers: MarkdownHandlerMap<T>, depth: number): T {
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
			for (const index of children.keys().toArray().toReversed()) {
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
		const value = foldMarkdownNode(frame.node, handlers, children)
		if (stack.length === 0) return value
		values.push(value)
	}
	return foldMarkdownNode(node, handlers, [])
}

/**
 * Dispatches one markdown node and its folded children to the matching handler.
 *
 * @example
 * ```ts
 * foldMarkdownNode({ element: 'text', value: 'hi' }, countHandlers, []) // 1
 * ```
 */
export function foldMarkdownNode<T>(
	node: MarkdownNode,
	handlers: MarkdownHandlerMap<T>,
	children: readonly T[],
): T {
	switch (node.element) {
		case 'document':
			return handlers.document(node, children)
		case 'heading':
			return handlers.heading(node, children)
		case 'paragraph':
			return handlers.paragraph(node, children)
		case 'thematicBreak':
			return handlers.thematicBreak(node, children)
		case 'blockquote':
			return handlers.blockquote(node, children)
		case 'codeBlock':
			return handlers.codeBlock(node, children)
		case 'list':
			return handlers.list(node, children)
		case 'listItem':
			return handlers.listItem(node, children)
		case 'table':
			return handlers.table(node, children)
		case 'text':
			return handlers.text(node, children)
		case 'emphasis':
			return handlers.emphasis(node, children)
		case 'codeSpan':
			return handlers.codeSpan(node, children)
		case 'break':
			return handlers.break(node, children)
		case 'link':
			return handlers.link(node, children)
		case 'image':
			return handlers.image(node, children)
	}
}

/**
 * Rewrites a {@link MarkdownDocument} bottom-up (copy-on-write) — each node's children
 * are rewritten first (post-order), then `rewrite` is applied to the node itself; the
 * document root is never passed to `rewrite` (the `element: 'document'` invariant
 * always holds). A table's inline cells and a list's items are rewritten too.
 *
 * @remarks
 * Never mutates `document`. An unchanged subtree keeps its input identity. A parent
 * is rebuilt only when an accepted child changes, and the returned derivation map
 * associates each rebuilt output with its input node. When `rewrite` returns a node
 * whose `element` does not fit the slot it was called for (a block slot handed a
 * non-{@link BlockNode}, an inline slot handed a non-{@link InlineNode}, a list-item
 * slot handed a non-`listItem`), the ill-fitting result is discarded and the accepted
 * input child is reused — `rewriteDocument` stays total and never produces a
 * structurally invalid document.
 *
 * Descent is capped at {@link MAX_DEPTH}, the same cap {@link walkNodes} and
 * {@link foldNode} observe: at `depth >= MAX_DEPTH` the subtree is passed through
 * unchanged (by reference, not rebuilt, and `rewrite` is not invoked on it) instead of
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
	const derivations: Array<readonly [MarkdownNode, MarkdownNode, boolean]> = []
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
			for (const index of children.keys().toArray().toReversed()) {
				const child = children[index]
				if (child !== undefined) stack.push({ node: child, depth, expanded: false, count: 0 })
			}
			continue
		}
		const children =
			frame.count === 0 ? [] : values.splice(values.length - frame.count, frame.count)
		const rebuilt = rebuildMarkdownNode(current, children)
		if (rebuilt !== current) derivations.push([rebuilt, current, true])
		if (current.element === 'document') {
			const result = rebuilt.element === 'document' ? rebuilt : current
			const output = new Set(walkNodes(result))
			const retained = new Map(
				Map.groupBy(derivations, ([node]) => node)
					.entries()
					.filter(([node]) => output.has(node))
					.map(([node, steps]): readonly [MarkdownNode, MarkdownNode | undefined] => [
						node,
						steps.reduce<MarkdownNode | undefined>(
							(source, [, input, direct], index) =>
								index === 0 || direct || source === input ? input : undefined,
							undefined,
						),
					]),
			)
			return [result, retained]
		}
		const result = rewrite(rebuilt)
		const accepted = acceptMarkdownNode(current, rebuilt, result)
		if (accepted !== rebuilt && accepted !== current) derivations.push([accepted, current, false])
		values.push(accepted)
	}
	return [document, new Map()]
}

/**
 * Rebuilds one markdown node when accepted child replacements change its identity.
 *
 * @example
 * ```ts
 * const original: ParagraphNode = { element: 'paragraph', children: [] }
 * rebuildMarkdownNode(original, []) === original // true
 * ```
 */
export function rebuildMarkdownNode(
	current: MarkdownNode,
	children: readonly MarkdownNode[],
): MarkdownNode {
	const outputs = children.values()
	switch (current.element) {
		case 'document':
		case 'blockquote':
		case 'listItem': {
			const pairs = Iterator.from(current.children)
				.filter((child) => child !== undefined)
				.map((block): readonly [BlockNode, BlockNode] => {
					const child = outputs.next().value
					return [block, child !== undefined && isBlockNode(child) ? child : block]
				})
				.toArray()
			if (!pairs.some(([input, output]) => input !== output)) return current
			const blocks = pairs.map(([, output]) => output)
			return current.element === 'blockquote'
				? { ...current, children: blocks }
				: { element: current.element, children: blocks }
		}
		case 'heading':
		case 'paragraph':
		case 'emphasis':
		case 'link':
		case 'image': {
			const pairs = Iterator.from(current.children)
				.filter((child) => child !== undefined)
				.map((inline): readonly [InlineNode, InlineNode] => {
					const child = outputs.next().value
					return [inline, child !== undefined && isInlineNode(child) ? child : inline]
				})
				.toArray()
			return pairs.some(([input, output]) => input !== output)
				? { ...current, children: pairs.map(([, output]) => output) }
				: current
		}
		case 'list': {
			const pairs = Iterator.from(current.items)
				.filter((item) => item !== undefined)
				.map((item): readonly [ListItemNode, ListItemNode] => {
					const child = outputs.next().value
					return [item, child?.element === 'listItem' ? child : item]
				})
				.toArray()
			return pairs.some(([input, output]) => input !== output)
				? { ...current, items: pairs.map(([, output]) => output) }
				: current
		}
		case 'table': {
			const pairs: Array<readonly [InlineNode, InlineNode]> = []
			const header = Iterator.from(current.header)
				.filter((cell) => cell !== undefined)
				.map((cell) => rebuildMarkdownCell(cell, outputs, pairs))
				.toArray()
			const rows = Iterator.from(current.rows)
				.filter((row) => row !== undefined)
				.map((row) =>
					Iterator.from(row)
						.filter((cell) => cell !== undefined)
						.map((cell) => rebuildMarkdownCell(cell, outputs, pairs))
						.toArray(),
				)
				.toArray()
			return pairs.some(([input, output]) => input !== output)
				? { ...current, header, rows }
				: current
		}
	}
	return current
}

/**
 * Rebuilds a table cell and records each input and accepted output pair.
 *
 * @example
 * ```ts
 * rebuildMarkdownCell([], [].values(), []) // []
 * ```
 */
export function rebuildMarkdownCell(
	cell: readonly InlineNode[],
	outputs: Iterator<MarkdownNode, undefined>,
	pairs: Array<readonly [InlineNode, InlineNode]>,
): readonly InlineNode[] {
	return Iterator.from(cell)
		.filter((inline) => inline !== undefined)
		.map((inline) => {
			const child = outputs.next().value
			const accepted = child !== undefined && isInlineNode(child) ? child : inline
			pairs.push([inline, accepted])
			return accepted
		})
		.toArray()
}

/**
 * Accepts a rewritten node only when it fits the original node slot.
 *
 * @example
 * ```ts
 * const original: TextNode = { element: 'text', value: 'hi' }
 * acceptMarkdownNode(original, original, { element: 'thematicBreak' }) === original // true
 * ```
 */
export function acceptMarkdownNode(
	current: MarkdownNode,
	rebuilt: MarkdownNode,
	result: MarkdownNode,
): MarkdownNode {
	switch (current.element) {
		case 'text':
		case 'emphasis':
		case 'codeSpan':
		case 'break':
		case 'link':
		case 'image':
			return isInlineNode(result) ? result : rebuilt
		case 'heading':
		case 'paragraph':
		case 'list':
		case 'table':
		case 'codeBlock':
		case 'blockquote':
		case 'thematicBreak':
			return isBlockNode(result) ? result : rebuilt
		case 'listItem':
			return result.element === 'listItem' ? result : rebuilt
	}
	return rebuilt
}

/**
 * Concatenates the `value` / `code` content of every descendant text / code-span /
 * code-block node under `node`, including image alternative content, in walk order —
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
	const parts: string[] = []
	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined || frame.depth >= MAX_DEPTH) continue
		switch (frame.node.element) {
			case 'text':
			case 'codeSpan':
				parts.push(frame.node.value)
				break
			case 'codeBlock':
				parts.push(frame.node.code)
				break
		}
		const children = listChildren(frame.node)
		for (const index of children.keys().toArray().toReversed()) {
			const child = children[index]
			if (child !== undefined) stack.push({ node: child, depth: frame.depth + 1 })
		}
	}
	return parts.join('')
}

/**
 * Yields UTF-16 offsets and characters within a markdown scan window.
 *
 * @example
 * ```ts
 * Array.from(walkMarkdownCharacters('ab', 0, 2)) // [[0, 'a'], [1, 'b']]
 * ```
 */
export function* walkMarkdownCharacters(
	source: string,
	from: number,
	to: number,
): Generator<readonly [number, string], void, unknown> {
	const positions = Array.prototype.keys.call({ length: Math.max(0, Math.ceil(to - from)) })
	for (const position of positions) {
		const index = from + position
		yield [index, source[index] ?? '']
	}
}

/**
 * Counts consecutive copies of the character at the start of a scan window.
 *
 * @example
 * ```ts
 * countMarkdownRun('***x', 0, 4) // 3
 * ```
 */
export function countMarkdownRun(source: string, start: number, to: number): number {
	if (start >= to || source[start] === undefined) return 0
	return /^([\s\S])\1*/.exec(source.slice(start, Math.ceil(to)))?.[0].length ?? 0
}

/**
 * Finds the next defined markdown node at or after an array offset.
 *
 * @example
 * ```ts
 * findFollowingNode([], 0) // undefined
 * ```
 */
export function findFollowingNode(
	nodes: readonly MarkdownNode[],
	start: number,
): MarkdownNode | undefined {
	const found = nodes
		.keys()
		.drop(start)
		.map((index) => nodes[index])
		.find((node) => node !== undefined)
	return found ?? nodes[Math.max(start, nodes.length)]
}

/**
 * Escapes literal text so markdown syntax remains literal when rendered.
 *
 * @example
 * ```ts
 * escapeMarkdownText('*hi*', false) // '\\*hi\\*'
 * ```
 */
export function escapeMarkdownText(value: string, bang: boolean): string {
	const parts: string[] = []
	walkMarkdownCharacters(value, 0, value.length).reduce((next, [index, character]) => {
		if (index < next) return next
		const atLineStart = index === 0 || value[index - 1] === '\n'
		if (character === '!' && index === value.length - 1 && bang) {
			parts.push('\\!')
			return index + 1
		}
		if (
			'\\*_`[]'.includes(character) ||
			(atLineStart && (character === '#' || character === '>')) ||
			(atLineStart &&
				(character === '-' || character === '~') &&
				value[index + 1] === character &&
				value[index + 2] === character) ||
			(atLineStart && (character === '-' || character === '+') && (value[index + 1] ?? ' ') === ' ')
		) {
			parts.push('\\' + character)
			return index + 1
		}
		if (atLineStart && /[0-9]/.test(character)) {
			const end = index + (/^[0-9]+/.exec(value.slice(index))?.[0].length ?? 0)
			const marker = value[end]
			if ((marker === '.' || marker === ')') && value[end + 1] === ' ') {
				parts.push(value.slice(index, end) + '\\' + marker)
				return end + 1
			}
		}
		parts.push(character)
		return index + 1
	}, 0)
	return parts.join('')
}

/**
 * Locates a balanced closing delimiter while skipping backslash escapes.
 *
 * @example
 * ```ts
 * locateMarkdownDelimiter('[a]', 0, 3, '[', ']') // 2
 * ```
 */
export function locateMarkdownDelimiter(
	source: string,
	start: number,
	to: number,
	open: string,
	close: string,
): number | undefined {
	const characters = walkMarkdownCharacters(source, start, to)
	const [, , result] = characters.reduce<readonly [number, number, number | undefined]>(
		([depth, next], [index, character]) => {
			if (index < next) return [depth, next, undefined]
			if (character === '\\') return [depth, index + 2, undefined]
			if (character === open) return [depth + 1, index + 1, undefined]
			if (character !== close) return [depth, index + 1, undefined]
			if (depth === 1) {
				characters.return(undefined)
				return [0, index + 1, index]
			}
			return [depth - 1, index + 1, undefined]
		},
		[0, start, undefined],
	)
	return result
}

/**
 * Appends a nonempty text node and records its original source span.
 *
 * @example
 * ```ts
 * const nodes: InlineNode[] = []
 * recordMarkdownText({ text: 'a', segments: [] }, 'a', 0, 1, new Map(), nodes)
 * nodes // [{ element: 'text', value: 'a' }]
 * ```
 */
export function recordMarkdownText(
	source: MarkdownSource,
	value: string,
	start: number,
	end: number,
	spans: Map<MarkdownNode, MarkdownSpan>,
	nodes: InlineNode[],
): void {
	if (value.length === 0) return
	const node: InlineNode = { element: 'text', value }
	const span = projectSpan(source, start, end)
	if (span !== undefined) spans.set(node, span)
	nodes.push(node)
}

/**
 * Scans one inline construct and records the spans of its nested children.
 *
 * @example
 * ```ts
 * scanMarkdownInline({ text: '`x`', segments: [] }, 0, 3, new Map(), 0)?.end // 3
 * ```
 */
export function scanMarkdownInline(
	source: MarkdownSource,
	index: number,
	to: number,
	spans: Map<MarkdownNode, MarkdownSpan>,
	depth: number,
): MarkdownInlineScan | undefined {
	const character = source.text[index] ?? ''
	if (character === ' ') {
		const end = index + countMarkdownRun(source.text, index, to)
		if (end - index >= 2 && source.text[end] === '\n')
			return { node: { element: 'break' }, end: end + 1 }
	}
	if (character === '`') {
		const span = scanCode(source.text, index, to)
		if (span) return { node: { element: 'codeSpan', value: span.value }, end: span.end }
	}
	if (character === '!' && source.text[index + 1] === '[') {
		const link = locateLink(source.text, index + 1, to)
		if (link !== undefined)
			return {
				node: {
					element: 'image',
					src: unescapeText(source.text.slice(link.close + 2, link.end - 1).trim()),
					children: coalesceText(
						scanInlineSource(source, index + 2, link.close, spans, depth + 1),
						spans,
					),
				},
				end: link.end,
			}
	}
	if (character === '[') {
		const link = locateLink(source.text, index, to)
		if (link !== undefined)
			return {
				node: {
					element: 'link',
					href: unescapeText(source.text.slice(link.close + 2, link.end - 1).trim()),
					children: coalesceText(
						scanInlineSource(source, index + 1, link.close, spans, depth + 1),
						spans,
					),
				},
				end: link.end,
			}
	}
	if (character === '*' || character === '_') {
		const emphasis = locateEmphasis(source.text, index, to)
		if (emphasis !== undefined)
			return {
				node: {
					element: 'emphasis',
					strong: emphasis.strong,
					children: coalesceText(
						scanInlineSource(source, emphasis.open, emphasis.close, spans, depth + 1),
						spans,
					),
				},
				end: emphasis.end,
			}
	}
	return undefined
}

/**
 * Yields line offsets through a closable markdown scan iterator.
 *
 * @example
 * ```ts
 * Array.from(walkMarkdownLines(splitLines('a\nb'), 1)) // [1]
 * ```
 */
export function* walkMarkdownLines(
	lines: readonly MarkdownSource[],
	start: number,
): Generator<number, void, unknown> {
	const positions = Array.prototype.keys.call({
		get length(): number {
			return Math.max(0, Math.ceil(lines.length - start))
		},
	})
	for (const position of positions) yield start + position
}

/**
 * Splits inline nodes into adjacent text runs and singleton non-text runs.
 *
 * @param nodes - The inline nodes in source order
 * @returns The runs with their original node identities
 *
 * @example
 * ```ts
 * splitTextRuns([{ element: 'text', value: 'a' }]).length // 1
 * ```
 */
export function splitTextRuns(nodes: readonly InlineNode[]): ReadonlyArray<readonly InlineNode[]> {
	const starts = nodes
		.entries()
		.flatMap(([index, node]) =>
			index === 0 || node.element !== 'text' || nodes[index - 1]?.element !== 'text' ? [index] : [],
		)
		.toArray()
	return starts.map((start, index) => nodes.slice(start, starts[index + 1]))
}

/**
 * Lists the direct children of a markdown node in traversal order.
 *
 * @param node - The node whose direct children to list
 * @returns The children, with table cells flattened in header then body order
 *
 * @example
 * ```ts
 * listChildren({ element: 'document', children: [] }) // []
 * ```
 */
export function listChildren(node: MarkdownNode): readonly MarkdownNode[] {
	switch (node.element) {
		case 'document':
		case 'heading':
		case 'paragraph':
		case 'blockquote':
		case 'listItem':
		case 'emphasis':
		case 'link':
		case 'image':
			return Iterator.from<MarkdownNode>(node.children)
				.filter((child) => child !== undefined)
				.toArray()
		case 'list':
			return Iterator.from(node.items)
				.filter((child) => child !== undefined)
				.toArray()
		case 'table':
			return [
				...Iterator.from(node.header)
					.filter((cell) => cell !== undefined)
					.flatMap((cell) => Iterator.from(cell).filter((child) => child !== undefined)),
				...Iterator.from(node.rows)
					.filter((row) => row !== undefined)
					.flatMap((row) => Iterator.from(row).filter((cell) => cell !== undefined))
					.flatMap((cell) => Iterator.from(cell).filter((child) => child !== undefined)),
			]
		default:
			return []
	}
}

/**
 * Trims leading whitespace when an inline run starts with a text node.
 *
 * @param nodes - The inline run to trim
 * @returns The run with its leading text trimmed or removed when empty
 *
 * @example
 * ```ts
 * trimLeading([{ element: 'text', value: ' a ' }]) // [{ element: 'text', value: 'a ' }]
 * ```
 */
export function trimLeading(nodes: readonly InlineNode[]): readonly InlineNode[] {
	const present = Iterator.from(nodes)
		.filter((node) => node !== undefined)
		.toArray()
	const first = present[0]
	if (first?.element !== 'text') return present
	const value = first.value.replace(/^\s+/, '')
	return isEmptyString(value) ? present.slice(1) : [{ element: 'text', value }, ...present.slice(1)]
}

/**
 * Trims trailing whitespace when an inline run ends with a text node.
 *
 * @param nodes - The inline run to trim
 * @returns The run with its trailing text trimmed or removed when empty
 *
 * @example
 * ```ts
 * trimTrailing([{ element: 'text', value: ' a ' }]) // [{ element: 'text', value: ' a' }]
 * ```
 */
export function trimTrailing(nodes: readonly InlineNode[]): readonly InlineNode[] {
	const present = Iterator.from(nodes)
		.filter((node) => node !== undefined)
		.toArray()
	const last = present.at(-1)
	if (last?.element !== 'text') return present
	const value = last.value.replace(/\s+$/, '')
	return isEmptyString(value)
		? present.slice(0, -1)
		: [...present.slice(0, -1), { element: 'text', value }]
}
