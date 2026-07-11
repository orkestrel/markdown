import type {
	BlockNode,
	InlineNode,
	ListItemNode,
	ListNode,
	MarkdownDocument,
	MarkdownNode,
	MarkdownParserInterface,
	TableAlign,
	TableNode,
} from './types.js'
import {
	coalesceText,
	escapeHtml,
	leadingIndent,
	extractFence,
	extractHeading,
	extractListItem,
	sanitizeUrl,
	scanInline,
	splitLines,
	splitTableRow,
	startsBlock,
	stripQuote,
	tableAlignments,
} from './helpers.js'
import { isFenceClose, isQuote, isTableStart, isThematicBreak } from './validators.js'
import { isEmptyString } from '@orkestrel/contract'

/**
 * A zero-dependency, types-first markdown parser - turn a markdown string into a
 * typed {@link MarkdownDocument} AST, and (separately) render an AST to a safe HTML
 * string.
 *
 * @remarks
 * - **The AST is the contract.** `parse(markdown)` runs a block phase
 *   (headings / paragraphs / lists / GFM tables / fenced code / blockquotes /
 *   thematic breaks) then an inline phase (emphasis / inline code / links) over each
 *   block's text, producing a render-agnostic {@link MarkdownDocument} - a
 *   discriminated union of node values keyed by `element`. Render is a SEPARATE
 *   downstream projection: parse never produces HTML.
 * - **Total - never throws.** Malformed markdown degrades to text (an unterminated
 *   `**` stays literal, a broken table falls back to a paragraph), so hostile or
 *   half-written input can never crash the parser. Linear-time inline scanning (no
 *   backtracking regex) means no ReDoS on adversarial input.
 * - **Render is XSS-safe.** `render(node)` HTML-escapes every text run, code body,
 *   and attribute value, and SANITIZES every link `href` (an unsafe scheme -
 *   `javascript:` / `data:` / … - is dropped to an empty `href`). Even though the
 *   docs site renders trusted guide content, escaping is unconditional (defence in
 *   depth).
 *
 * @example
 * ```ts
 * const parser = new MarkdownParser()
 * const ast = parser.parse('# Title\n\nA **bold** [link](https://x.dev).')
 * ast.children[0] // { element: 'heading', level: 1, children: [{ element: 'text', value: 'Title' }] }
 * parser.render(ast) // '<h1>Title</h1>\n<p>A <strong>bold</strong> <a href="https://x.dev">link</a>.</p>'
 * ```
 */
export class MarkdownParser implements MarkdownParserInterface {
	parse(markdown: string): MarkdownDocument {
		return { element: 'document', children: this.#blocks(splitLines(markdown)) }
	}

	parseInline(text: string): readonly InlineNode[] {
		return coalesceText(scanInline(text, 0, text.length))
	}

	render(node: MarkdownNode): string {
		switch (node.element) {
			case 'document':
				return node.children.map((child) => this.render(child)).join('\n')
			case 'heading':
				return `<h${node.level}>${this.#renderInline(node.children)}</h${node.level}>`
			case 'paragraph':
				return `<p>${this.#renderInline(node.children)}</p>`
			case 'thematicBreak':
				return '<hr>'
			case 'blockquote':
				return `<blockquote>\n${node.children.map((child) => this.render(child)).join('\n')}\n</blockquote>`
			case 'codeBlock': {
				const open =
					node.lang === undefined ? '<code>' : `<code class="language-${escapeHtml(node.lang)}">`
				return `<pre>${open}${escapeHtml(node.code)}</code></pre>`
			}
			case 'list': {
				const items = node.items.map((item) => this.render(item)).join('\n')
				if (!node.ordered) return `<ul>\n${items}\n</ul>`
				const start = node.start !== 1 ? ` start="${node.start}"` : ''
				return `<ol${start}>\n${items}\n</ol>`
			}
			case 'listItem':
				return `<li>${this.#renderItem(node.children)}</li>`
			case 'table': {
				const head = `<tr>${node.header.map((cell, column) => this.#renderCell('th', cell, node.align[column])).join('')}</tr>`
				const body = node.rows
					.map(
						(row) =>
							`<tr>${row.map((cell, column) => this.#renderCell('td', cell, node.align[column])).join('')}</tr>`,
					)
					.join('\n')
				const bodyHtml = node.rows.length > 0 ? `\n<tbody>\n${body}\n</tbody>` : ''
				return `<table>\n<thead>\n${head}\n</thead>${bodyHtml}\n</table>`
			}
			case 'text':
				return escapeHtml(node.value)
			case 'emphasis':
				return node.strong
					? `<strong>${this.#renderInline(node.children)}</strong>`
					: `<em>${this.#renderInline(node.children)}</em>`
			case 'codeSpan':
				return `<code>${escapeHtml(node.value)}</code>`
			case 'link':
				return `<a href="${sanitizeUrl(node.href)}">${this.#renderInline(node.children)}</a>`
		}
	}

	//  Block phase (markdown lines → block AST)

	#blocks(lines: readonly string[]): readonly BlockNode[] {
		const blocks: BlockNode[] = []
		let index = 0
		while (index < lines.length) {
			const line = lines[index] ?? ''
			if (isEmptyString(line)) {
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
					children: this.parseInline(heading.text),
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
				blocks.push({ element: 'blockquote', children: this.#blocks(quoted) })
				continue
			}
			if (isTableStart(line, lines[index + 1])) {
				const table = this.#collectTable(lines, index)
				blocks.push(table.node)
				index = table.next
				continue
			}
			if (extractListItem(line)) {
				const list = this.#collectList(lines, index)
				blocks.push(list.node)
				index = list.next
				continue
			}
			const paragraph: string[] = []
			while (
				index < lines.length &&
				!isEmptyString(lines[index] ?? '') &&
				!(paragraph.length > 0 && startsBlock(lines, index))
			) {
				paragraph.push((lines[index] ?? '').trim())
				index += 1
			}
			blocks.push({ element: 'paragraph', children: this.parseInline(paragraph.join('\n')) })
		}
		return blocks
	}

	#collectTable(
		lines: readonly string[],
		start: number,
	): { readonly node: TableNode; readonly next: number } {
		const headerCells = splitTableRow(lines[start] ?? '')
		const columns = headerCells.length
		const header = headerCells.map((cell) => this.parseInline(cell.trim()))
		const align = tableAlignments(lines[start + 1] ?? '')
		const padded: TableAlign[] = []
		for (let column = 0; column < columns; column += 1) padded.push(align[column] ?? 'none')
		const rows: (readonly InlineNode[])[][] = []
		let index = start + 2
		while (
			index < lines.length &&
			!isEmptyString(lines[index] ?? '') &&
			(lines[index] ?? '').includes('|')
		) {
			const cells = splitTableRow(lines[index] ?? '')
			const row: (readonly InlineNode[])[] = []
			for (let column = 0; column < columns; column += 1)
				row.push(this.parseInline((cells[column] ?? '').trim()))
			rows.push(row)
			index += 1
		}
		return { node: { element: 'table', header, rows, align: padded }, next: index }
	}

	#collectList(
		lines: readonly string[],
		start: number,
	): { readonly node: ListNode; readonly next: number } {
		const first = extractListItem(lines[start] ?? '')
		const ordered = first?.ordered ?? false
		const startOrdinal = first?.start ?? 1
		const topIndent = first?.indent ?? 0
		const items: ListItemNode[] = []
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
				if (isEmptyString(next)) {
					const after = lines[index + 1] ?? ''
					if (
						index + 1 < lines.length &&
						!isEmptyString(after) &&
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
			items.push({ element: 'listItem', children: this.#blocks(itemLines) })
		}
		return { node: { element: 'list', ordered, start: startOrdinal, items }, next: index }
	}

	//  Render phase (AST node → safe HTML string)

	#renderInline(nodes: readonly InlineNode[]): string {
		return nodes.map((node) => this.render(node)).join('')
	}

	#renderCell(
		tag: 'th' | 'td',
		cell: readonly InlineNode[],
		align: TableAlign | undefined,
	): string {
		const style = align !== undefined && align !== 'none' ? ` style="text-align:${align}"` : ''
		return `<${tag}${style}>${this.#renderInline(cell)}</${tag}>`
	}

	#renderItem(children: readonly BlockNode[]): string {
		if (children.length === 1) {
			const only = children[0]
			if (only !== undefined && only.element === 'paragraph')
				return this.#renderInline(only.children)
		}
		return children.map((child) => this.render(child)).join('\n')
	}
}
