import type { HTMLDocument } from '@orkestrel/html'
import type { MarkdownDocument } from '@src/core'
import { Markdown } from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildProjection } from './setup.js'
import {
	ADOPTION_CASES,
	SURFACE_CASES,
	adopt,
	buildElement,
	buildText,
	extractSurfaceNames,
	projectKbdNode,
} from './setupServer.js'

// The subject is `tests/setupServer.ts`, the helpers the `guides` project transcribes from the
// guide's fences. Each expectation is a literal fixture written from the guide's claim, so a
// helper that drifts from the fence it stands for fails here before the guide suite reads it.

describe('adopt', () => {
	it('adopts a valid document as the handle document itself', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'Ada' }] }],
		}
		const markdown = adopt(document)

		expect(markdown).toBeInstanceOf(Markdown)
		expect(markdown?.document).toBe(document)
	})

	it.each(ADOPTION_CASES)('refuses $label', ({ candidate }) => {
		expect(adopt(candidate)).toBeUndefined()
	})
})

describe('projectKbdNode', () => {
	it('projects a kbd element as one code span over its children raw text', () => {
		const projection = projectKbdNode(buildElement('kbd'), [
			buildText('Ctrl'),
			buildText('+'),
			buildText('C'),
		])

		expect(projection).toEqual({
			blocks: [],
			inlines: [{ element: 'codeSpan', value: 'Ctrl+C' }],
			text: 'Ctrl+C',
			cells: [],
			rows: [],
		})
	})

	it('drops the markup of a nested child and keeps its text inside the code span', () => {
		const strong = buildProjection({
			inlines: [
				{ element: 'emphasis', strong: true, children: [{ element: 'text', value: 'Esc' }] },
			],
			text: 'Esc',
		})

		expect(projectKbdNode(buildElement('kbd'), [strong]).inlines).toEqual([
			{ element: 'codeSpan', value: 'Esc' },
		])
	})

	it('delegates an element other than kbd to the default projection', () => {
		expect(projectKbdNode(buildElement('b'), [buildText('Esc')]).inlines).toEqual([
			{ element: 'emphasis', strong: true, children: [{ element: 'text', value: 'Esc' }] },
		])
		expect(projectKbdNode(buildElement('hr'), [])).toEqual({
			blocks: [{ element: 'thematicBreak' }],
			inlines: [],
			text: '',
			cells: [],
			rows: [],
		})
	})

	it('delegates the document root to the default projection', () => {
		const root: HTMLDocument = { category: 'document', children: [] }

		expect(projectKbdNode(root, [buildText('Esc')]).inlines).toEqual([
			{ element: 'text', value: 'Esc' },
		])
	})
})

describe('extractSurfaceNames', () => {
	it('reads the first body cell of every table in source order', () => {
		const source = [
			'## Surface',
			'',
			'| Name | Kind |',
			'| --- | --- |',
			'| `scanLink` | function |',
			'| **LinkScan** | interface |',
			'',
			'## Types',
			'',
			'| Name | Kind |',
			'| --- | --- |',
			'| `MarkdownHandlerMap<T>` | type |',
		].join('\n')

		expect(extractSurfaceNames(source)).toEqual(['scanLink', 'LinkScan', 'MarkdownHandlerMap<T>'])
	})

	it.each(SURFACE_CASES)('finds no name in $label', ({ source }) => {
		expect(extractSurfaceNames(source)).toEqual([])
	})
})
