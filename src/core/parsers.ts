import type {
	BlockNode,
	InlineNode,
	MarkdownDocument,
	MarkdownNode,
	MarkdownParseResult,
	MarkdownSource,
	MarkdownSpan,
} from './types.js'
import {
	coalesceText,
	collectList,
	collectTable,
	extractFence,
	extractHeading,
	extractListItem,
	isBlankLine,
	isFenceClose,
	isQuote,
	isTableStart,
	isThematicBreak,
	joinSources,
	normalizeParagraphLine,
	projectSpan,
	scanInline,
	scanInlineSource,
	sliceSource,
	splitLines,
	startsBlock,
	stripQuote,
} from './helpers.js'
import { MAX_DEPTH } from './constants.js'
import { isNonEmptyArray } from '@orkestrel/contract'

/**
 * Parses a run of markdown lines into a block AST, recursing into nested
 * blockquotes, list items, and depth-capped degrade paragraphs.
 *
 * @param lines - The markdown lines to parse.
 * @param depth - The current recursion depth (blockquotes/lists increment it).
 * @param spans - The optional operation-owned node span recorder.
 * @param end - The original-source end of this line run, including a removed terminator.
 * @returns The parsed block nodes.
 *
 * @example
 * ```ts
 * parseBlocks(splitLines('# Hi'), 0) // [{ element: 'heading', level: 1, children: [...] }]
 * ```
 */
export function parseBlocks(
	lines: readonly MarkdownSource[],
	depth: number,
	spans = new Map<MarkdownNode, MarkdownSpan>(),
	end?: number,
): readonly BlockNode[] {
	const text = lines.map((line) => line.text)
	if (depth >= MAX_DEPTH) {
		if (lines.length === 0) return []
		const source = joinSources(lines, '\n')
		const inline: InlineNode = { element: 'text', value: source.text }
		const paragraph: BlockNode = { element: 'paragraph', children: [inline] }
		const span = projectSpan(source, 0, source.text.length)
		if (span !== undefined) {
			spans.set(inline, span)
			spans.set(paragraph, span)
		}
		return [paragraph]
	}
	const blocks: BlockNode[] = []
	let index = 0
	while (index < lines.length) {
		const line = text[index] ?? ''
		if (isBlankLine(line)) {
			index += 1
			continue
		}
		const fence = extractFence(line)
		if (fence) {
			const start = index
			const body: MarkdownSource[] = []
			let closed = false
			index += 1
			while (index < lines.length && !isFenceClose(text[index] ?? '', fence.marker)) {
				const bodyLine = lines[index]
				if (bodyLine !== undefined) body.push(bodyLine)
				index += 1
			}
			if (index < lines.length) {
				closed = true
				index += 1
			}
			const node: BlockNode = {
				element: 'codeBlock',
				...(fence.lang === undefined ? {} : { lang: fence.lang }),
				code: joinSources(body, '\n').text,
			}
			const source = joinSources(lines.slice(start, index), '\n')
			const span = projectSpan(source, 0, source.text.length)
			if (span !== undefined)
				spans.set(node, !closed && end !== undefined ? { start: span.start, end } : span)
			blocks.push(node)
			continue
		}
		if (isThematicBreak(line)) {
			const node: BlockNode = { element: 'thematicBreak' }
			const source = lines[index]
			const span = source === undefined ? undefined : projectSpan(source, 0, source.text.length)
			if (span !== undefined) spans.set(node, span)
			blocks.push(node)
			index += 1
			continue
		}
		const heading = extractHeading(line)
		if (heading) {
			const source = lines[index]
			const content =
				source === undefined
					? { text: heading.text, segments: [] }
					: sliceSource(source, heading.offset, heading.offset + heading.text.length)
			const node: BlockNode = {
				element: 'heading',
				level: heading.level,
				children: coalesceText(scanInlineSource(content, 0, content.text.length, spans), spans),
			}
			const span = source === undefined ? undefined : projectSpan(source, 0, source.text.length)
			if (span !== undefined) spans.set(node, span)
			blocks.push(node)
			index += 1
			continue
		}
		if (isQuote(line)) {
			const start = index
			const quoted: MarkdownSource[] = []
			while (index < lines.length && isQuote(text[index] ?? '')) {
				const quotedLine = lines[index]
				if (quotedLine === undefined) break
				quoted.push(stripQuote(quotedLine))
				index += 1
			}
			const source = joinSources(lines.slice(start, index), '\n')
			const span = projectSpan(source, 0, source.text.length)
			const node: BlockNode = {
				element: 'blockquote',
				children: parseBlocks(
					quoted,
					depth + 1,
					spans,
					index === lines.length && end !== undefined ? end : span?.end,
				),
			}
			if (span !== undefined) spans.set(node, span)
			blocks.push(node)
			continue
		}
		if (isTableStart(line, text[index + 1])) {
			const table = collectTable(lines, index, spans)
			blocks.push(table.node)
			index = table.next
			continue
		}
		if (extractListItem(line)) {
			const list = collectList(lines, index, depth, spans, end)
			blocks.push(list.node)
			index = list.next
			continue
		}
		const start = index
		const paragraph: MarkdownSource[] = []
		while (
			index < lines.length &&
			!isBlankLine(text[index] ?? '') &&
			!(isNonEmptyArray(paragraph) && startsBlock(text, index))
		) {
			const paragraphLine = lines[index]
			if (paragraphLine !== undefined) paragraph.push(paragraphLine)
			index += 1
		}
		const source = joinSources(
			paragraph.map((paragraphLine, position) =>
				normalizeParagraphLine(paragraphLine, position < paragraph.length - 1),
			),
			'\n',
		)
		const node: BlockNode = {
			element: 'paragraph',
			children: coalesceText(scanInlineSource(source, 0, source.text.length, spans), spans),
		}
		const region = joinSources(lines.slice(start, index), '\n')
		const span = projectSpan(region, 0, region.text.length)
		if (span !== undefined) spans.set(node, span)
		blocks.push(node)
	}
	return blocks
}

/**
 * Parses a markdown string into a typed {@link MarkdownDocument} AST through the
 * block phase.
 *
 * @param markdown - The markdown source to parse.
 * @returns The parsed document.
 *
 * @example
 * ```ts
 * parseDocument('# Hi') // { element: 'document', children: [{ element: 'heading', ... }] }
 * ```
 */
export function parseDocument(markdown: string): MarkdownDocument {
	const [document] = parseProvenance(markdown)
	return document
}

/**
 * Parses a markdown string into a document and its original-source spans.
 *
 * @param markdown - The markdown source to parse.
 * @returns The parsed document and its node-identity span map.
 *
 * @example
 * ```ts
 * const [document, spans] = parseProvenance('# Hi')
 * spans.get(document) // { start: 0, end: 4 }
 * ```
 */
export function parseProvenance(markdown: string): MarkdownParseResult {
	const spans = new Map<MarkdownNode, MarkdownSpan>()
	const document: MarkdownDocument = {
		element: 'document',
		children: parseBlocks(splitLines(markdown), 0, spans, markdown.length),
	}
	spans.set(document, { start: 0, end: markdown.length })
	return [document, spans]
}

/**
 * Parses inline markdown text (emphasis, code spans, links, images, and hard
 * breaks) into inline AST nodes, coalescing adjacent text runs.
 *
 * @param text - The inline markdown text to parse.
 * @returns The parsed inline nodes.
 *
 * @example
 * ```ts
 * parseInline('a *b*') // [{ element: 'text', value: 'a ' }, { element: 'emphasis', ... }]
 * ```
 */
export function parseInline(text: string): readonly InlineNode[] {
	return coalesceText(scanInline(text, 0, text.length))
}
