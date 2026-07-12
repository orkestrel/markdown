import type {
	BlockquoteNode,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownNode,
	ParagraphNode,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildDeepQuoteInput, firstBlock } from '../../setup.js'
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

	it('an identity rewrite returns a NEW Markdown instance with a deep-equal document', () => {
		const markdown = new Markdown('# Title\n\npara')
		const rewritten = markdown.map((node) => node)
		expect(rewritten).not.toBe(markdown)
		expect(rewritten.document).toEqual(markdown.document)
	})

	it('never mutates the original instance (copy-on-write)', () => {
		const markdown = new Markdown('a lowercase paragraph')
		const rewritten = markdown.map(upper)
		expect((firstBlock('a lowercase paragraph') as { element: string }).element).toBe('paragraph')
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

describe('Markdown — reduce', () => {
	it('the node count matches the spread-iteration length', () => {
		const markdown = new Markdown('# Title\n\npara with **bold** text')
		const count = markdown.reduce((accumulator) => accumulator + 1, 0)
		expect(count).toBe([...markdown].length)
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
		link: (_node, children) => 1 + children.reduce((sum, value) => sum + value, 0),
	}

	it('a 13-key handler table reconstructs a total node count matching reduce', () => {
		const markdown = new Markdown('# Title\n\npara with **bold** text and [a link](x)')
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
			link: (_node, children) => children.join(''),
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
			link: (_node, children) => children.join(''),
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
			link: (_node, children) => children.length,
		}
		expect(() => markdown.fold(cappedHandlers)).not.toThrow()
		expect(seenEmptyChildren.includes(true)).toBe(true)
	})
})

describe('Markdown — stream', () => {
	it('yields exactly the document children, in order', () => {
		const markdown = new Markdown('# Title\n\npara\n\n---')
		expect([...markdown.stream()]).toEqual(markdown.document.children)
	})

	it('is lazy — one item can be taken without exhausting the generator', () => {
		const markdown = new Markdown('# a\n\n# b\n\n# c')
		const generator = markdown.stream()
		const first = generator.next()
		expect(first.done).toBe(false)
		expect(first.value.element).toBe('heading')
	})

	it('is shallow — yields top-level block nodes only, not their descendants', () => {
		const markdown = new Markdown('# Title with **bold**')
		const blocks = [...markdown.stream()]
		expect(blocks).toHaveLength(1)
		expect(blocks[0]?.element).toBe('heading')
	})
})

describe('Markdown — iteration', () => {
	it('the first yielded element is the document root itself', () => {
		const markdown = new Markdown('# Title')
		const [first] = [...markdown]
		expect(first).toBe(markdown.document)
	})

	it('matches a hand-walked depth-first pre-order sequence for a known document', () => {
		const markdown = new Markdown('# Title\n\npara')
		expect([...markdown].map((node) => node.element)).toEqual([
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
		for (const node of markdown) elements.push(node.element)
		expect(elements).toEqual(['document', 'heading', 'text'])
	})
})

describe('Markdown — async iteration', () => {
	it('for await…of collects the exact same sequence as [...md]', async () => {
		const markdown = new Markdown('# Title\n\npara with **bold** text and [a link](x)')
		const collected: MarkdownNode[] = []
		for await (const node of markdown) collected.push(node)
		expect(collected).toEqual([...markdown])
	})

	it('works inside an async pipeline — an async helper counting nodes returns the right count', async () => {
		const markdown = new Markdown('# Title\n\npara')
		async function countNodes(source: AsyncIterable<MarkdownNode>): Promise<number> {
			let count = 0
			for await (const node of source) if (node !== undefined) count += 1
			return count
		}
		expect(await countNodes(markdown)).toBe([...markdown].length)
	})

	it('for await…of over stream() yields the top-level blocks (sync-generator fallback semantics)', async () => {
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
				for await (const node of markdown) {
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
				for await (const node of markdown) if (node !== undefined) count += 1
			})(),
		).resolves.toBeUndefined()
		expect(count).toBeGreaterThan(0)
	})
})

describe('Markdown — adversarial (deep input)', () => {
	it('constructs from a 10,000-deep blockquote chain without throwing', () => {
		expect(() => new Markdown(buildDeepQuoteInput(10_000))).not.toThrow()
	})

	it('iterates, filters, and reduces over a pathologically deep document without throwing', () => {
		const markdown = new Markdown(buildDeepQuoteInput(10_000))
		expect(() => [...markdown]).not.toThrow()
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
