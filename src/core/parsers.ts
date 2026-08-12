import type { BlockNode, InlineNode, MarkdownDocument } from './types.js'
import {
	coalesceText,
	collectList,
	collectTable,
	extractFence,
	extractHeading,
	extractListItem,
	scanInline,
	splitLines,
	startsBlock,
	stripQuote,
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
			paragraph.push(lines[index] ?? '')
			index += 1
		}
		const source = paragraph
			.map((paragraphLine, position) =>
				position < paragraph.length - 1 && paragraphLine.endsWith('  ')
					? `${paragraphLine.trim()}  `
					: paragraphLine.trim(),
			)
			.join('\n')
		blocks.push({ element: 'paragraph', children: parseInline(source) })
	}
	return blocks
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
 * Parses inline markdown text (emphasis, code spans, links, images, and hard
 * breaks) into inline AST nodes, coalescing adjacent text runs.
 *
 * @param text - The inline markdown text to parse.
 * @returns The parsed inline nodes.
 */
export function parseInline(text: string): readonly InlineNode[] {
	return coalesceText(scanInline(text, 0, text.length))
}
