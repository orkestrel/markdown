import type {
	BlockNode,
	BlockquoteNode,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownNode,
	ParagraphNode,
	TextNode,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { collectStream } from '@orkestrel/test'
import { buildDeepQuoteInput, firstBlock, projectHTML } from '../../setup.js'
import { Markdown, isHeadingNode, isMarkdownDocument, isTextNode } from '@src/core'

// The Markdown CLASS — the stateful wrapper around a parsed MarkdownDocument AST,
// exposing query (find/filter/reduce/iteration), rewrite (map), fold, and streaming
// operations. Parse-behavior corpora and render-output corpora live in their own
// mirrored suites (parsers.test.ts / helpers.test.ts) — this suite covers only the
// CLASS's own contract: construction, traversal order, immutability, and the fold
// catamorphism. A handful of small parses are used purely as vehicles.

describe('Markdown — construction', () => {
	it('parses a markdown string into the document tree', () => {
		const markdown = new Markdown('# Title\n\nA paragraph.')
		expect(markdown.document.element).toBe('document')
		expect(markdown.document.children.map((block) => block.element)).toEqual([
			'heading',
			'paragraph',
		])
	})

	it('adopts an existing MarkdownDocument by reference', () => {
		const document: MarkdownDocument = { element: 'document', children: [] }
		const markdown = new Markdown(document)
		expect(markdown.document).toBe(document)
	})

	it('produces zero children for an empty string', () => {
		expect(new Markdown('').document.children).toEqual([])
	})
})

describe('Markdown — document getter', () => {
	it('returns the stored root, stable across repeated access', () => {
		const markdown = new Markdown('# Title')
		const first = markdown.document
		const second = markdown.document
		expect(first).toBe(second)
		expect(first.element).toBe('document')
	})
})

describe('Markdown — span', () => {
	it('reports the region of the original input each parsed node came from', () => {
		const source = '# Title\n\npara'
		const markdown = new Markdown(source)
		const heading = markdown.find(isHeadingNode)
		if (heading === undefined) throw new Error('expected a heading')
		const span = markdown.span(heading)
		if (span === undefined) throw new Error('expected heading provenance')
		expect(source.slice(span.start, span.end)).toBe('# Title')
		expect(markdown.span(markdown.document)).toEqual({ start: 0, end: source.length })
	})

	it('covers the marker a heading value drops, so the region opens before its text', () => {
		const source = '# Title\n\nA **bold** word.'
		const markdown = new Markdown(source)
		const heading = markdown.find(isHeadingNode)
		if (heading === undefined) throw new Error('expected a heading')
		const region = markdown.span(heading)
		expect(region).toEqual({ start: 0, end: 7 })
		if (region === undefined) throw new Error('expected heading provenance')
		expect(source.slice(region.start, region.end)).toBe('# Title')
	})

	it('slices the constructor string verbatim where the value decoded an escape', () => {
		const source = 'a \\* b *c*'
		const markdown = new Markdown(source)
		const [text] = markdown.filter(isTextNode)
		expect(text?.value).toBe('a * b ')
		const region = text === undefined ? undefined : markdown.span(text)
		expect(region).toEqual({ start: 0, end: 7 })
		if (region === undefined) throw new Error('expected text provenance')
		expect(source.slice(region.start, region.end)).toBe('a \\* b ')
	})

	it('returns a fresh value per call, so a mutated return never reaches the next', () => {
		const markdown = new Markdown('# Title')
		const first = markdown.span(markdown.document)
		const second = markdown.span(markdown.document)
		if (first === undefined || second === undefined) throw new Error('expected provenance')
		expect(first).not.toBe(second)
		expect(first).toEqual(second)
		Object.assign(first, { start: 999 })
		expect(markdown.span(markdown.document)).toEqual({ start: 0, end: 7 })
	})

	it('reports undefined for a foreign node and for every node of an adopted document', () => {
		const markdown = new Markdown('# Title')
		const foreign = new Markdown('# Other')
		expect(markdown.span(foreign.document)).toBeUndefined()
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const adopted = new Markdown(document)
		expect([...adopted.walk()].map((node) => adopted.span(node))).toEqual([
			undefined,
			undefined,
			undefined,
		])
	})

	it('reports undefined for every node of a document projected in from HTML', () => {
		const imported = new Markdown(projectHTML('<div>text<p>para</p></div>'))
		expect(imported.span(imported.document)).toBeUndefined()
		const nodes = [...imported.walk()]
		expect(nodes.length).toBeGreaterThan(1)
		expect(nodes.every((node) => imported.span(node) === undefined)).toBe(true)
	})

	it('keeps two handles over the same text on independent maps', () => {
		const source = '# Title'
		const first = new Markdown(source)
		const second = new Markdown(source)
		const firstHeading = first.find(isHeadingNode)
		const secondHeading = second.find(isHeadingNode)
		if (firstHeading === undefined || secondHeading === undefined)
			throw new Error('expected a heading in each handle')
		expect(firstHeading).not.toBe(secondHeading)
		expect(first.span(secondHeading)).toBeUndefined()
		expect(second.span(firstHeading)).toBeUndefined()
		expect(first.span(firstHeading)).toEqual(second.span(secondHeading))
	})
})

describe('Markdown — find', () => {
	it('narrows via a type guard overload', () => {
		const markdown = new Markdown('# Title')
		const heading = markdown.find(isHeadingNode)
		if (heading === undefined) throw new Error('expected a heading')
		expect(heading.level).toBe(1)
	})

	it('accepts a boolean predicate overload', () => {
		const markdown = new Markdown('# Title')
		const found = markdown.find((node) => node.element === 'heading')
		expect(found?.element).toBe('heading')
	})

	it('returns the FIRST match in depth-first pre-order (a nested heading before a later top-level one)', () => {
		const markdown = new Markdown('> ## nested heading\n\n## later heading')
		const heading = markdown.find(isHeadingNode)
		expect(
			heading?.children.some((child) => isTextNode(child) && child.value === 'nested heading'),
		).toBe(true)
	})

	it('returns undefined when no node matches', () => {
		const markdown = new Markdown('plain paragraph')
		expect(markdown.find(isHeadingNode)).toBeUndefined()
	})

	it('the root document itself is visitable', () => {
		const markdown = new Markdown('plain paragraph')
		expect(markdown.find(isMarkdownDocument)).toBe(markdown.document)
	})
})

describe('Markdown — filter', () => {
	it('collects every narrowed match in walk order', () => {
		const markdown = new Markdown('# one\n\npara\n\n## two')
		const headings = markdown.filter(isHeadingNode)
		expect(headings.map((heading) => heading.level)).toEqual([1, 2])
	})

	it('returns an empty array when nothing matches', () => {
		const markdown = new Markdown('plain paragraph')
		expect(markdown.filter(isHeadingNode)).toEqual([])
	})

	it('returns a fresh array on every call', () => {
		const markdown = new Markdown('# one')
		expect(markdown.filter(isHeadingNode)).not.toBe(markdown.filter(isHeadingNode))
	})

	it('accepts a boolean predicate overload', () => {
		const markdown = new Markdown('# one\n\npara')
		expect(markdown.filter((node) => node.element === 'text')).toHaveLength(2)
	})
})

describe('Markdown — map', () => {
	function upper(node: MarkdownNode): MarkdownNode {
		return isTextNode(node) ? { element: 'text', value: node.value.toUpperCase() } : node
	}

	it('an identity rewrite returns a NEW Markdown instance reusing the document tree', () => {
		const markdown = new Markdown('# Title\n\npara')
		const rewritten = markdown.map((node) => node)
		expect(rewritten).not.toBe(markdown)
		expect(rewritten.document).toBe(markdown.document)
	})

	it('never mutates the original instance (copy-on-write)', () => {
		const markdown = new Markdown('a lowercase paragraph')
		const rewritten = markdown.map(upper)
		expect(firstBlock('a lowercase paragraph').element).toBe('paragraph')
		const originalText = markdown.filter(isTextNode)[0]
		const rewrittenText = rewritten.filter(isTextNode)[0]
		expect(originalText?.value).toBe('a lowercase paragraph')
		expect(rewrittenText?.value).toBe('A LOWERCASE PARAGRAPH')
	})

	it('rewrites bottom-up — children are already rewritten when the parent is visited', () => {
		const markdown = new Markdown('# Title')
		const seenAtHeadingTime: string[] = []
		markdown.map((node) => {
			if (node.element === 'heading') {
				const child = node.children[0]
				if (child !== undefined && isTextNode(child)) seenAtHeadingTime.push(child.value)
			}
			return node
		})
		expect(seenAtHeadingTime).toEqual(['Title'])
	})

	it('never passes the document root to the rewrite callback', () => {
		const markdown = new Markdown('# Title\n\npara')
		const seen: string[] = []
		markdown.map((node) => {
			seen.push(node.element)
			return node
		})
		expect(seen).not.toContain('document')
	})

	it('chains — md.map(a).map(b) applies both rewrites', () => {
		function shout(node: MarkdownNode): MarkdownNode {
			return isTextNode(node) ? { element: 'text', value: `${node.value}!` } : node
		}
		const markdown = new Markdown('hi')
		const chained = markdown.map(upper).map(shout)
		const text = chained.filter(isTextNode)[0]
		expect(text?.value).toBe('HI!')
	})
})

describe('Markdown — map provenance', () => {
	it('carries every region through an identity rewrite', () => {
		const markdown = new Markdown('# Title\n\npara')
		const rewritten = markdown.map((node) => node)
		expect([...rewritten.walk()].map((node) => rewritten.span(node))).toEqual(
			[...markdown.walk()].map((node) => markdown.span(node)),
		)
	})

	it('gives a one-source replacement its source region and a rebuilt ancestor its original one', () => {
		const markdown = new Markdown('# Title\n\npara')
		const rewritten = markdown.map((node) =>
			isTextNode(node) && node.value === 'para' ? { element: 'text', value: 'PARA' } : node,
		)
		const replaced = rewritten.find((node) => isTextNode(node) && node.value === 'PARA')
		if (replaced === undefined) throw new Error('expected the replacement text node')
		expect(rewritten.span(replaced)).toEqual({ start: 9, end: 13 })
		expect(rewritten.span(rewritten.document)).toEqual({ start: 0, end: 13 })
		const heading = rewritten.find(isHeadingNode)
		if (heading === undefined) throw new Error('expected the untouched heading')
		expect(rewritten.span(heading)).toEqual({ start: 0, end: 7 })
	})

	it('gives a lowercased text node the region its input occupied in the original', () => {
		const markdown = new Markdown('# Hi\n\nText.')
		const lowered = markdown.map((node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
		)
		const [first] = lowered.filter(isTextNode)
		expect(first?.value).toBe('hi')
		expect(first === undefined ? undefined : lowered.span(first)).toEqual({ start: 2, end: 4 })
	})

	it('keeps the own region of an already-spanned node returned for several inputs', () => {
		const markdown = new Markdown('a *b* c')
		const [first] = markdown.filter(isTextNode)
		if (first === undefined) throw new Error('expected a text node')
		expect(markdown.span(first)).toEqual({ start: 0, end: 2 })
		const kept = markdown.map((node) => (isTextNode(node) ? first : node))
		expect(kept.filter(isTextNode)).toHaveLength(3)
		expect(kept.span(first)).toEqual({ start: 0, end: 2 })
	})

	it('leaves an output node assembled from separate sources without a region', () => {
		const shared: TextNode = { element: 'text', value: 'z' }
		const markdown = new Markdown('one\n\ntwo')
		const merged = markdown.map((node) => (isTextNode(node) ? shared : node))
		expect(merged.filter(isTextNode)).toEqual([shared, shared])
		expect(merged.span(shared)).toBeUndefined()
	})

	it('resolves a moved original to its own region and its replacement to the region it vacated', () => {
		const markdown = new Markdown('# Title\n\npara')
		const [headingText, bodyText] = markdown.filter(isTextNode)
		if (headingText === undefined || bodyText === undefined)
			throw new Error('expected two text nodes')
		expect(markdown.span(headingText)).toEqual({ start: 2, end: 7 })
		expect(markdown.span(bodyText)).toEqual({ start: 9, end: 13 })
		const replacement: TextNode = { element: 'text', value: 'REPLACED' }
		const swapped = markdown.map((node) =>
			node === headingText ? replacement : node === bodyText ? headingText : node,
		)
		expect(swapped.span(replacement)).toEqual({ start: 2, end: 7 })
		expect(swapped.span(headingText)).toEqual({ start: 2, end: 7 })
	})

	it('does not cross an input identity into its separate output derivation', () => {
		const markdown = new Markdown('a\n\nb\n\nc')
		const [first, second, third] = markdown.document.children
		if (
			first?.element !== 'paragraph' ||
			second?.element !== 'paragraph' ||
			third?.element !== 'paragraph'
		)
			throw new Error('expected three paragraphs')
		const shared: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'shared' }],
		}
		const merged = markdown.map((node) => (node === first || node === second ? shared : node))
		expect(merged.span(shared)).toBeUndefined()

		const replacement: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'replacement' }],
		}
		const chained = merged.map((node) =>
			node === shared ? replacement : node === third ? shared : node,
		)

		expect(chained.document.children[0]).toBe(replacement)
		expect(chained.document.children[1]).toBe(replacement)
		expect(chained.document.children[2]).toBe(shared)
		expect(chained.span(replacement)).toBeUndefined()
		expect(chained.span(shared)).toEqual({ start: 6, end: 7 })
	})
})

describe('Markdown — reduce', () => {
	it('the node count matches the walk() spread length', () => {
		const markdown = new Markdown('# Title\n\npara with **bold** text')
		const count = markdown.reduce((accumulator) => accumulator + 1, 0)
		expect(count).toBe([...markdown.walk()].length)
	})

	it('accumulates in depth-first pre-order for a known small document', () => {
		const markdown = new Markdown('# Title\n\npara')
		const elements = markdown.reduce<string[]>((accumulator, node) => {
			accumulator.push(node.element)
			return accumulator
		}, [])
		expect(elements).toEqual(['document', 'heading', 'text', 'paragraph', 'text'])
	})
})

describe('Markdown — fold', () => {
	const countHandlers: MarkdownHandlers<number> = {
		document: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		heading: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		paragraph: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		thematicBreak: () => 1,
		blockquote: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		codeBlock: () => 1,
		list: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		listItem: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		table: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		text: () => 1,
		emphasis: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		codeSpan: () => 1,
		break: () => 1,
		link: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
		image: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	}

	it('a 15-key handler table reconstructs a total node count matching reduce', () => {
		const markdown = new Markdown(
			'# Title\n\npara with **bold** text, [a link](x), and ![an image](x.png).  \nNext.',
		)
		const folded = markdown.fold(countHandlers)
		const reduced = markdown.reduce((accumulator) => accumulator + 1, 0)
		expect(folded).toBe(reduced)
	})

	it('a table handler receives folded cells as a flat readonly array (header then row cells, in walk order)', () => {
		const markdown = new Markdown('| a | b |\n| - | - |\n| 1 | 2 |')
		const cellHandlers: MarkdownHandlers<string> = {
			document: (_node, children) => children.join(''),
			heading: (_node, children) => children.join(''),
			paragraph: (_node, children) => children.join(''),
			thematicBreak: () => '',
			blockquote: (_node, children) => children.join(''),
			codeBlock: () => '',
			list: (_node, children) => children.join(''),
			listItem: (_node, children) => children.join(''),
			table: (_node, children) => children.join(','),
			text: (node) => node.value,
			emphasis: (_node, children) => children.join(''),
			codeSpan: () => '',
			break: () => '',
			link: (_node, children) => children.join(''),
			image: (_node, children) => children.join(''),
		}
		expect(markdown.fold(cellHandlers)).toBe('a,b,1,2')
	})

	it('folds children before the parent — a fold table can reconstruct a rendered form', () => {
		const markdown = new Markdown('# Hi')
		const htmlLikeHandlers: MarkdownHandlers<string> = {
			document: (_node, children) => children.join('\n'),
			heading: (node, children) => `<h${node.level}>${children.join('')}</h${node.level}>`,
			paragraph: (_node, children) => `<p>${children.join('')}</p>`,
			thematicBreak: () => '<hr>',
			blockquote: (_node, children) => children.join(''),
			codeBlock: () => '',
			list: (_node, children) => children.join(''),
			listItem: (_node, children) => children.join(''),
			table: (_node, children) => children.join(''),
			text: (node) => node.value,
			emphasis: (_node, children) => children.join(''),
			codeSpan: () => '',
			break: () => '<br>',
			link: (_node, children) => children.join(''),
			image: (_node, children) => children.join(''),
		}
		expect(markdown.fold(htmlLikeHandlers)).toBe('<h1>Hi</h1>')
	})

	it('does not throw over a ~70-deep valid blockquote chain, and the MAX_DEPTH cap hands the innermost handler empty children', () => {
		const markdown = new Markdown(buildDeepQuoteInput(70, 'leaf'))
		const seenEmptyChildren: boolean[] = []
		const cappedHandlers: MarkdownHandlers<number> = {
			document: (_node, children) => children.length,
			heading: (_node, children) => children.length,
			paragraph: (_node, children) => children.length,
			thematicBreak: () => 0,
			blockquote: (_node, children) => {
				seenEmptyChildren.push(children.length === 0)
				return children.length === 0 ? 0 : Math.max(...children)
			},
			codeBlock: () => 0,
			list: (_node, children) => children.length,
			listItem: (_node, children) => children.length,
			table: (_node, children) => children.length,
			text: () => 0,
			emphasis: (_node, children) => children.length,
			codeSpan: () => 0,
			break: () => 0,
			link: (_node, children) => children.length,
			image: (_node, children) => children.length,
		}
		expect(() => markdown.fold(cappedHandlers)).not.toThrow()
		expect(seenEmptyChildren.includes(true)).toBe(true)
	})
})

describe('Markdown — stream', () => {
	it('returns a web-standard ReadableStream', () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		expect(markdown.stream()).toBeInstanceOf(ReadableStream)
	})

	it('yields exactly the document children, in order, via a reader loop', async () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		const reader = markdown.stream().getReader()
		const blocks: BlockNode[] = []
		for (let result = await reader.read(); !result.done; result = await reader.read()) {
			blocks.push(result.value)
		}
		expect(blocks).toEqual(markdown.document.children)
	})

	it('preserves image children and hard breaks inside a streamed paragraph block', async () => {
		const markdown = new Markdown('![alt](x.png)  \nNext.')
		const blocks = await collectStream(markdown.stream())
		expect(blocks).toEqual(markdown.document.children)
		expect([...markdown.walk()].map((node) => node.element)).toEqual([
			'document',
			'paragraph',
			'image',
			'text',
			'break',
			'text',
		])
	})

	it('reports done after the last block, with no extra values', async () => {
		const markdown = new Markdown('# Title')
		const reader = markdown.stream().getReader()
		await reader.read()
		const final = await reader.read()
		expect(final).toEqual({ done: true, value: undefined })
	})

	it('is pull-based — a single read yields exactly one block without exhausting the rest', async () => {
		const markdown = new Markdown('# a\n\n# b\n\n# c')
		const reader = markdown.stream().getReader()
		const first = await reader.read()
		expect(first.done).toBe(false)
		expect(first.value?.element).toBe('heading')
		await reader.cancel()

		const replay = [...(await collectStream(markdown.stream()))]
		expect(replay).toHaveLength(3)
	})

	it('cancel() mid-stream resolves and further reads report done', async () => {
		const markdown = new Markdown('# a\n\n# b\n\n# c')
		const reader = markdown.stream().getReader()
		await reader.read()
		await expect(reader.cancel()).resolves.toBeUndefined()
		await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
	})

	it('each call returns a distinct, fully replayable stream', async () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		const first = await collectStream(markdown.stream())
		const second = await collectStream(markdown.stream())
		expect(first).toEqual(markdown.document.children)
		expect(second).toEqual(markdown.document.children)
	})

	it('is shallow — yields top-level block nodes only, not their descendants', async () => {
		const markdown = new Markdown('# Title with **bold**')
		const blocks = await collectStream(markdown.stream())
		expect(blocks).toHaveLength(1)
		expect(blocks[0]?.element).toBe('heading')
	})

	it('pipes through a TransformStream to a mapped, collected array', async () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		const toElementName = new TransformStream<BlockNode, string>({
			transform(block, controller) {
				controller.enqueue(block.element)
			},
		})
		const reader = markdown.stream().pipeThrough(toElementName).getReader()
		const names: string[] = []
		for (let result = await reader.read(); !result.done; result = await reader.read()) {
			names.push(result.value)
		}
		expect(names).toEqual(['heading', 'paragraph', 'thematicBreak'])
	})
})

describe('Markdown — walk', () => {
	it('the first yielded element is the document root itself', () => {
		const markdown = new Markdown('# Title')
		const [first] = [...markdown.walk()]
		expect(first).toBe(markdown.document)
	})

	it('matches a hand-walked depth-first pre-order sequence for a known document', () => {
		const markdown = new Markdown('# Title\n\npara')
		expect([...markdown.walk()].map((node) => node.element)).toEqual([
			'document',
			'heading',
			'text',
			'paragraph',
			'text',
		])
	})

	it('works with for…of', () => {
		const markdown = new Markdown('# Title')
		const elements: string[] = []
		for (const node of markdown.walk()) elements.push(node.element)
		expect(elements).toEqual(['document', 'heading', 'text'])
	})

	it('is lazy — taking one node does not force the rest of the traversal', () => {
		const markdown = new Markdown('# Title\n\npara')
		const iterator = markdown.walk()
		const first = iterator.next()
		expect(first.done).toBe(false)
		expect(first.value).toBe(markdown.document)
	})

	it('an early break terminates cleanly without throwing', () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		const collected: MarkdownNode[] = []
		expect(() => {
			for (const node of markdown.walk()) {
				collected.push(node)
				if (node.element === 'heading') break
			}
		}).not.toThrow()
		expect(collected.map((node) => node.element)).toEqual(['document', 'heading'])
	})
})

describe('Markdown — async iteration', () => {
	it('for await…of collects the exact same sequence as sync walk()', async () => {
		const markdown = new Markdown('# Title\n\npara with **bold** text and [a link](x)')
		const collected: MarkdownNode[] = []
		for await (const node of markdown.walk()) collected.push(node)
		expect(collected).toEqual([...markdown.walk()])
	})

	it('works inside an async pipeline — an async helper counting nodes returns the right count', async () => {
		const markdown = new Markdown('# Title\n\npara')
		async function countNodes(source: Iterable<MarkdownNode>): Promise<number> {
			let count = 0
			for await (const node of source) if (node !== undefined) count += 1
			return count
		}
		expect(await countNodes(markdown.walk())).toBe([...markdown.walk()].length)
	})

	it('for await…of over stream() yields the top-level blocks (native ReadableStream async iteration)', async () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		const blocks: string[] = []
		for await (const block of markdown.stream()) blocks.push(block.element)
		expect(blocks).toEqual(['heading', 'paragraph', 'thematicBreak'])
	})

	it('an early break from for await…of does not throw and terminates cleanly', async () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		const collected: MarkdownNode[] = []
		await expect(
			(async () => {
				for await (const node of markdown.walk()) {
					collected.push(node)
					if (node.element === 'heading') break
				}
			})(),
		).resolves.toBeUndefined()
		expect(collected.map((node) => node.element)).toEqual(['document', 'heading'])
	})

	it('completes without throwing over a pathologically deep (10,000-deep) document', async () => {
		const markdown = new Markdown(buildDeepQuoteInput(10_000))
		let count = 0
		await expect(
			(async () => {
				for await (const node of markdown.walk()) if (node !== undefined) count += 1
			})(),
		).resolves.toBeUndefined()
		expect(count).toBeGreaterThan(0)
	})
})

describe('Markdown — adversarial (deep input)', () => {
	it('constructs from a 10,000-deep blockquote chain without throwing', () => {
		expect(() => new Markdown(buildDeepQuoteInput(10_000))).not.toThrow()
	})

	it('walks, filters, and reduces over a pathologically deep document without throwing', () => {
		const markdown = new Markdown(buildDeepQuoteInput(10_000))
		expect(() => [...markdown.walk()]).not.toThrow()
		expect(() => markdown.filter(isHeadingNode)).not.toThrow()
		expect(() => markdown.reduce((accumulator) => accumulator + 1, 0)).not.toThrow()
	})

	it('an identity map over a pathologically deep document does not throw', () => {
		const markdown = new Markdown(buildDeepQuoteInput(10_000))
		expect(() => markdown.map((node) => node)).not.toThrow()
	})

	it('an identity map over an ADOPTED 10,000-deep blockquote-chain document does not throw', () => {
		// Built directly as an AST (not via parseDocument, which caps depth during
		// parsing) and adopted as-is, so map/rewriteDocument sees the FULL depth.
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		let node: BlockquoteNode | ParagraphNode = leaf
		for (let level = 0; level < 10_000; level += 1)
			node = { element: 'blockquote', children: [node] }
		const document: MarkdownDocument = { element: 'document', children: [node] }
		const markdown = new Markdown(document)
		expect(() => markdown.map((current) => current)).not.toThrow()
	})
})
