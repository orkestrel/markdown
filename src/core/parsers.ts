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
	listChildren,
	normalizeParagraphLine,
	projectMarkdownSpan,
	scanInline,
	scanInlineSource,
	sliceSource,
	splitLines,
	startsBlock,
	stripQuote,
} from './helpers.js'
import { MAX_DEPTH } from '@orkestrel/html'
import { MarkdownLineIterator } from './MarkdownLineIterator.js'

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
		const span = projectMarkdownSpan(source, 0, source.text.length)
		if (span !== undefined) {
			spans.set(inline, span)
			spans.set(paragraph, span)
		}
		return [paragraph]
	}
	const blocks: BlockNode[] = []
	const indices = new MarkdownLineIterator(lines.keys())
	indices.reduce((index, step) => {
		if (step < index) return index
		const line = text[index] ?? ''
		if (isBlankLine(line)) {
			return index + 1
		}
		const fence = extractFence(line)
		if (fence) {
			const start = index
			const body: Array<readonly [number, boolean, MarkdownSource | undefined]> = []
			for (const cursor of indices) {
				const closed = isFenceClose(text[cursor] ?? '', fence.marker)
				body.push([cursor, closed, closed ? undefined : lines[cursor]])
				if (closed) break
			}
			const closed = body.at(-1)?.[1] ?? false
			const next = (body.at(-1)?.[0] ?? index) + 1
			const node: BlockNode = {
				element: 'codeBlock',
				...(fence.lang === undefined ? {} : { lang: fence.lang }),
				code: joinSources(
					body.flatMap(([, , source]) => (source === undefined ? [] : [source])),
					'\n',
				).text,
			}
			const source = joinSources(lines.slice(start, next), '\n')
			const span = projectMarkdownSpan(source, 0, source.text.length)
			if (span !== undefined)
				spans.set(node, !closed && end !== undefined ? { start: span.start, end } : span)
			blocks.push(node)
			return next
		}
		if (isThematicBreak(line)) {
			const node: BlockNode = { element: 'thematicBreak' }
			const source = lines[index]
			const span =
				source === undefined ? undefined : projectMarkdownSpan(source, 0, source.text.length)
			if (span !== undefined) spans.set(node, span)
			blocks.push(node)
			return index + 1
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
			const span =
				source === undefined ? undefined : projectMarkdownSpan(source, 0, source.text.length)
			if (span !== undefined) spans.set(node, span)
			blocks.push(node)
			return index + 1
		}
		if (isQuote(line)) {
			const start = index
			const first = lines[index]
			const quoted: Array<readonly [number, MarkdownSource]> =
				first === undefined ? [] : [[index, stripQuote(first)]]
			while (indices.value !== undefined && isQuote(text[indices.value] ?? '')) {
				const cursor = indices.next().value
				if (cursor === undefined) break
				const quotedLine = lines[cursor]
				if (quotedLine === undefined) break
				quoted.push([cursor, stripQuote(quotedLine)])
			}
			const next = quoted.length === 0 ? index : (quoted.at(-1)?.[0] ?? index) + 1
			const source = joinSources(lines.slice(start, next), '\n')
			const span = projectMarkdownSpan(source, 0, source.text.length)
			const node: BlockNode = {
				element: 'blockquote',
				children: parseBlocks(
					quoted.map(([, quotedLine]) => quotedLine),
					depth + 1,
					spans,
					next === lines.length && end !== undefined ? end : span?.end,
				),
			}
			if (span !== undefined) spans.set(node, span)
			blocks.push(node)
			return next
		}
		if (isTableStart(line, text[index + 1])) {
			const table = collectTable(lines, index, spans)
			blocks.push(table.node)
			return table.next
		}
		if (extractListItem(line)) {
			const list = collectList(lines, index, depth, spans, end)
			blocks.push(list.node)
			return list.next
		}
		const start = index
		const paragraph: Array<readonly [number, MarkdownSource | undefined]> = [[index, lines[index]]]
		while (
			indices.value !== undefined &&
			!isBlankLine(text[indices.value] ?? '') &&
			!startsBlock(text, indices.value)
		) {
			const cursor = indices.next().value
			if (cursor === undefined) break
			paragraph.push([cursor, lines[cursor]])
		}
		const next = paragraph.length === 0 ? index : (paragraph.at(-1)?.[0] ?? index) + 1
		const content = paragraph.flatMap(([, source]) => (source === undefined ? [] : [source]))
		const source = joinSources(
			content.map((paragraphLine, position) =>
				normalizeParagraphLine(paragraphLine, position < content.length - 1),
			),
			'\n',
		)
		const node: BlockNode = {
			element: 'paragraph',
			children: coalesceText(scanInlineSource(source, 0, source.text.length, spans), spans),
		}
		const region = joinSources(lines.slice(start, next), '\n')
		const span = projectMarkdownSpan(region, 0, region.text.length)
		if (span !== undefined) spans.set(node, span)
		blocks.push(node)
		return next
	}, 0)
	return blocks
}

/**
 * Parses a markdown string into a typed {@link MarkdownDocument} AST through the
 * block phase — the document half of what {@link parseMarkdownProvenance} returns. Malformed
 * markdown degrades to literal text, so the parse never throws.
 *
 * @param markdown - The markdown source to parse.
 * @returns The parsed document.
 *
 * @example
 * ```ts
 * parseMarkdown('# Hi') // { element: 'document', children: [{ element: 'heading', ... }] }
 * ```
 */
export function parseMarkdown(markdown: string): MarkdownDocument {
	const [document] = parseMarkdownProvenance(markdown)
	return document
}

/**
 * Parses a markdown string into a document and its original-source spans. Malformed
 * markdown degrades to literal text, so the parse never throws.
 *
 * @param markdown - The markdown source to parse.
 * @returns The parsed document and its node-identity span map.
 *
 * @remarks
 * Parsing inserts into a scratch memo. The returned map contains only nodes of the
 * final document, enumerated without the public walk's depth cap.
 *
 * @example
 * ```ts
 * const [document, spans] = parseMarkdownProvenance('# Hi')
 * spans.get(document) // { start: 0, end: 4 }
 * ```
 */
export function parseMarkdownProvenance(markdown: string): MarkdownParseResult {
	const memo = new Map<MarkdownNode, MarkdownSpan>()
	const document: MarkdownDocument = {
		element: 'document',
		children: parseBlocks(splitLines(markdown), 0, memo, markdown.length),
	}
	memo.set(document, { start: 0, end: markdown.length })
	const nodes: MarkdownNode[] = [document]
	for (const node of nodes) for (const child of listChildren(node)) nodes.push(child)
	const present = new Set(nodes)
	const spans = new Map([...memo].filter(([node]) => present.has(node)))
	return [document, spans]
}

/**
 * Parses inline markdown text (emphasis, code spans, links, images, and hard
 * breaks) into inline AST nodes, coalescing adjacent text runs and reading no block
 * structure. Malformed markdown degrades to literal text, so the parse never throws.
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
