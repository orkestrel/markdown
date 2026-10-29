import type { ElementNode, HTMLDocument } from '@orkestrel/html'
import type { MarkdownProjection } from '@src/core'
import { buildProjection } from './setup.js'
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

export function buildElement(name: string): ElementNode {
	return { category: 'element', name, attributes: [], children: [] }
}

export function buildText(value: string): MarkdownProjection {
	return buildProjection({ inlines: [{ element: 'text', value }], text: value })
}

export const ADOPTION_CASES = [
	{ label: 'a foreign root element', candidate: { element: 'bogus' } },
	{ label: 'a document without children', candidate: { element: 'document' } },
	{
		label: 'a document whose nested text node lacks its value',
		candidate: {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text' }] }],
		},
	},
	{ label: 'a markdown source string', candidate: '# Title' },
	{ label: 'null', candidate: null },
]

export const SURFACE_CASES = [
	{ label: 'an empty source', source: '' },
	{ label: 'prose without a table', source: '# Guide\n\nThe `scanLink` function reads a link.' },
	{ label: 'a table with a header and no body row', source: '| Name |\n| --- |' },
]
