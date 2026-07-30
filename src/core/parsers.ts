import type {
	BlockNode,
	InlineNode,
	ListItemNode,
	ListItemParts,
	ListNode,
	MarkdownDocument,
	TableAlign,
	TableNode,
} from './types.js'
import {
	coalesceText,
	leadingIndent,
	extractFence,
	extractHeading,
	extractListItem,
	scanInline,
	splitLines,
	splitTableRow,
	startsBlock,
	stripQuote,
	tableAlignments,
} from './helpers.js'
import { isBlankLine, isFenceClose, isQuote, isTableStart, isThematicBreak } from './validators.js'
import { MAX_DEPTH } from './constants.js'
import { isNonEmptyArray } from '@orkestrel/contract'

/**
 * Parses a run of markdown lines into a block AST, recursing into nested
 * blockquotes, list items, and depth-capped degrade paragraphs.
 *
 * @param lines - The markdown lines to parse.
 * @param depth - The current recursion depth (blockquotes/lists increment it).
 * @returns The parsed block nodes.
 *
 * @example
 * ```ts
 * parseBlocks(['# Hi'], 0) // [{ element: 'heading', level: 1, children: [...] }]
 * ```
 */
export function parseBlocks(lines: readonly string[], depth: number): readonly BlockNode[] {
	if (depth >= MAX_DEPTH) {
		return lines.length > 0
			? [{ element: 'paragraph', children: [{ element: 'text', value: lines.join('\n') }] }]
			: []
	}
	const blocks: BlockNode[] = []
	let index = 0
	while (index < lines.length) {
		const line = lines[index] ?? ''
		if (isBlankLine(line)) {
			index += 1
			continue
		}
		const fence = extractFence(line)
		if (fence) {
			const body: string[] = []
			index += 1
			while (index < lines.length && !isFenceClose(lines[index] ?? '', fence.marker)) {
				body.push(lines[index] ?? '')
				index += 1
			}
			index += 1 // step past the closing fence (a no-op past EOF)
			blocks.push({
				element: 'codeBlock',
				...(fence.lang === undefined ? {} : { lang: fence.lang }),
				code: body.join('\n'),
			})
			continue
		}
		if (isThematicBreak(line)) {
			blocks.push({ element: 'thematicBreak' })
			index += 1
			continue
		}
		const heading = extractHeading(line)
		if (heading) {
			blocks.push({
				element: 'heading',
				level: heading.level,
				children: parseInline(heading.text),
			})
			index += 1
			continue
		}
		if (isQuote(line)) {
			const quoted: string[] = []
			while (index < lines.length && isQuote(lines[index] ?? '')) {
				quoted.push(stripQuote(lines[index] ?? ''))
				index += 1
			}
			blocks.push({ element: 'blockquote', children: parseBlocks(quoted, depth + 1) })
			continue
		}
		if (isTableStart(line, lines[index + 1])) {
			const table = collectTable(lines, index)
			blocks.push(table.node)
			index = table.next
			continue
		}
		if (extractListItem(line)) {
			const list = collectList(lines, index, depth)
			blocks.push(list.node)
			index = list.next
			continue
		}
		const paragraph: string[] = []
		while (
			index < lines.length &&
			!isBlankLine(lines[index] ?? '') &&
			!(isNonEmptyArray(paragraph) && startsBlock(lines, index))
		) {
			paragraph.push((lines[index] ?? '').trim())
			index += 1
		}
		blocks.push({ element: 'paragraph', children: parseInline(paragraph.join('\n')) })
	}
	return blocks
}

/**
 * Collects a GFM table starting at a header row, parsing the header, the
 * alignment row, and every contiguous body row that follows.
 *
 * @param lines - The markdown lines to scan.
 * @param start - The index of the header row.
 * @returns The parsed table node and the index of the first line after it.
 *
 * @example
 * ```ts
 * collectTable(['| a |', '| - |'], 0) // { node: { element: 'table', ... }, next: 2 }
 * ```
 */
export function collectTable(
	lines: readonly string[],
	start: number,
): { readonly node: TableNode; readonly next: number } {
	const headerCells = splitTableRow(lines[start] ?? '')
	const columns = headerCells.length
	const header = headerCells.map((cell) => parseInline(cell.trim()))
	const align = tableAlignments(lines[start + 1] ?? '')
	const padded: (TableAlign | null)[] = []
	for (let column = 0; column < columns; column += 1) padded.push(align[column] ?? null)
	const rows: (readonly InlineNode[])[][] = []
	let index = start + 2
	while (
		index < lines.length &&
		!isBlankLine(lines[index] ?? '') &&
		(lines[index] ?? '').includes('|')
	) {
		const cells = splitTableRow(lines[index] ?? '')
		const row: (readonly InlineNode[])[] = []
		for (let column = 0; column < columns; column += 1)
			row.push(parseInline((cells[column] ?? '').trim()))
		rows.push(row)
		index += 1
	}
	return { node: { element: 'table', header, rows, align: padded }, next: index }
}

/**
 * Collects a list starting at the first item, gathering sibling items at the
 * same indent/ordering and recursing into each item's own block content.
 *
 * @param lines - The markdown lines to scan.
 * @param start - The index of the first list item.
 * @param depth - The current recursion depth (each item recurses at `depth + 1`).
 * @returns The parsed list node and the index of the first line after it.
 *
 * @example
 * ```ts
 * collectList(['- item'], 0, 0) // { node: { element: 'list', ... }, next: 1 }
 * ```
 */
export function collectList(
	lines: readonly string[],
	start: number,
	depth: number,
): { readonly node: ListNode; readonly next: number } {
	const first = extractListItem(lines[start] ?? '')
	const ordered = first?.ordered ?? false
	const startOrdinal = first?.start ?? 1
	const topIndent = first?.indent ?? 0
	const items: ListItemNode[] = []
	// A single nested-item chain would otherwise rescan and slice the whole suffix
	// once per level before reaching the cap. Recognize that shape in one pass and
	// build the same bounded AST bottom-up.
	const chain: ListItemParts[] = []
	let nested = true
	for (let cursor = start; cursor < lines.length; cursor += 1) {
		const parsed = extractListItem(lines[cursor] ?? '')
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
		if (terminal !== undefined) {
			const source = [terminal.content]
			for (let cursor = start + remaining; cursor < lines.length; cursor += 1) {
				source.push((lines[cursor] ?? '').slice(terminal.marker))
			}
			let children: readonly BlockNode[] = [
				{ element: 'paragraph', children: [{ element: 'text', value: source.join('\n') }] },
			]
			let node: ListNode | undefined
			for (let cursor = remaining - 1; cursor >= 0; cursor -= 1) {
				const parsed = chain[cursor]
				if (parsed === undefined) continue
				node = {
					element: 'list',
					ordered: parsed.ordered,
					start: parsed.start,
					items: [{ element: 'listItem', children }],
				}
				children = [node]
			}
			if (node !== undefined) return { node, next: lines.length }
		}
	}
	let index = start
	while (index < lines.length) {
		const parsed = extractListItem(lines[index] ?? '')
		// A sibling item shares the list's (top) indent + ordering; anything else stops
		// the top loop (a deeper item is a nested list, gathered as continuation below).
		if (!parsed || parsed.indent > topIndent || parsed.ordered !== ordered) break
		const itemLines: string[] = [parsed.content]
		const continuation = parsed.marker
		index += 1
		while (index < lines.length) {
			const next = lines[index] ?? ''
			if (isBlankLine(next)) {
				const after = lines[index + 1] ?? ''
				if (
					index + 1 < lines.length &&
					!isBlankLine(after) &&
					leadingIndent(after) >= continuation
				) {
					itemLines.push('')
					index += 1
					continue
				}
				break
			}
			if (leadingIndent(next) >= continuation) {
				itemLines.push(next.slice(continuation))
				index += 1
				continue
			}
			if (extractListItem(next) || startsBlock(lines, index)) break
			itemLines.push(next.trim()) // a lazy paragraph-continuation line
			index += 1
		}
		items.push({ element: 'listItem', children: parseBlocks(itemLines, depth + 1) })
	}
	return { node: { element: 'list', ordered, start: startOrdinal, items }, next: index }
}

/**
 * Parses a markdown string into a typed {@link MarkdownDocument} AST via the
 * block phase.
 *
 * @param markdown - The markdown source to parse.
 * @returns The parsed document.
 */
export function parseDocument(markdown: string): MarkdownDocument {
	return { element: 'document', children: parseBlocks(splitLines(markdown), 0) }
}

/**
 * Parses inline markdown text (emphasis, code spans, links) into inline AST
 * nodes, coalescing adjacent text runs.
 *
 * @param text - The inline markdown text to parse.
 * @returns The parsed inline nodes.
 */
export function parseInline(text: string): readonly InlineNode[] {
	return coalesceText(scanInline(text, 0, text.length))
}
