import type { ElementNode, HTMLDocument } from '@orkestrel/html'
import type { MarkdownProjection } from '@src/core'
import {
	Markdown,
	createProjection,
	flattenText,
	isMarkdownDocument,
	isTableNode,
	mergeProjections,
	projectHTMLNode,
} from '@src/core'

/** Adopts a document only when its complete Markdown shape is valid. */
export function adopt(candidate: unknown): Markdown | undefined {
	if (!isMarkdownDocument(candidate)) return undefined
	return new Markdown(candidate)
}

/** Projects a `kbd` element as a code span and delegates every other container. */
export function projectKbdNode(
	node: ElementNode | HTMLDocument,
	children: readonly MarkdownProjection[],
): MarkdownProjection {
	if (node.category === 'element' && node.name === 'kbd') {
		const merged = mergeProjections(children)
		return createProjection({
			inlines: [{ element: 'codeSpan', value: merged.text }],
			text: merged.text,
		})
	}
	return projectHTMLNode(node, children)
}

/** Extracts every Surface-table identifier from a guide through Markdown itself. */
export function extractSurfaceNames(source: string): readonly string[] {
	const markdown = new Markdown(source)
	const tables = markdown.filter(isTableNode)
	return tables.flatMap((table) =>
		table.rows.map((row) => flattenText({ element: 'paragraph', children: row[0] ?? [] })),
	)
}
