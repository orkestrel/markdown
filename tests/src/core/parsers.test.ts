import { describe, expect, it } from 'vitest'
import {
	assertBlockquoteNode,
	assertCodeBlockNode,
	assertCodeSpanNode,
	assertEmphasisNode,
	assertHeadingNode,
	assertLinkNode,
	assertListNode,
	assertParagraphNode,
	assertTableNode,
	buildDeepEmphasisInput,
	buildDeepListInput,
	buildDeepQuoteInput,
	firstBlock,
	inlineText,
} from '../../setup.js'
import {
	MAX_DEPTH,
	parseBlocks,
	parseDocument,
	parseInline,
	parseProvenance,
	splitLines,
	walkNodes,
} from '@src/core'

// The markdown parser's parse-behavior surface — parseDocument (the block phase
// entry point), parseInline (the inline phase entry point), and the block-phase
// recursion parseBlocks. The construct scanners those compose (collectTable /
// collectList) are helpers.ts leaves, covered in helpers.test.ts. The AST is the
// contract: each construct (heading / paragraph / list / GFM table / fenced + inline
// code / link / emphasis / blockquote / thematic break) parses to the right
// discriminated node. Pure + total: malformed markdown degrades to text, never throws,
// and a MAX_DEPTH recursion cap degrades pathologically deep input to a single literal
// node rather than exhausting the call stack. Render/HTML behavior lives in
// compilers.test.ts (renderHTML). The AST narrowers and deep-input builders are
// centralized in tests/setup.ts.

describe('parseDocument — headings', () => {
	it('parses each ATX level (# … ######) to the right heading level', () => {
		for (let level = 1; level <= 6; level += 1) {
			const heading = assertHeadingNode(firstBlock(`${'#'.repeat(level)} Title ${level}`))
			expect(heading.level).toBe(level)
			expect(inlineText(heading.children)).toBe(`Title ${level}`)
		}
	})

	it('does not treat seven #s as a heading (degrades to a paragraph)', () => {
		expect(firstBlock('####### too deep').element).toBe('paragraph')
	})

	it('requires a space after the #s (a bare #tag is a paragraph)', () => {
		expect(firstBlock('#notaheading').element).toBe('paragraph')
	})

	it('strips an optional closing ### run', () => {
		expect(inlineText(assertHeadingNode(firstBlock('## Title ##')).children)).toBe('Title')
	})

	it('parses inline content inside a heading', () => {
		const heading = assertHeadingNode(firstBlock('## A **bold** word'))
		expect(heading.children.some((node) => node.element === 'emphasis')).toBe(true)
	})
})

describe('parseDocument — paragraphs', () => {
	it('wraps a run of plain lines into one paragraph', () => {
		const block = firstBlock('line one\nline two')
		expect(block.element).toBe('paragraph')
		expect(inlineText(block.element === 'paragraph' ? block.children : [])).toBe(
			'line one\nline two',
		)
	})

	it('separates two paragraphs on a blank line', () => {
		const blocks = parseDocument('first\n\nsecond').children
		expect(blocks.map((block) => block.element)).toEqual(['paragraph', 'paragraph'])
	})

	it('starts a heading directly under a paragraph (no blank line required)', () => {
		const blocks = parseDocument('a paragraph\n## a heading').children
		expect(blocks.map((block) => block.element)).toEqual(['paragraph', 'heading'])
	})

	it('stops the paragraph at each block-starting construct without a blank line', () => {
		const cases: ReadonlyArray<{ readonly markdown: string; readonly kinds: readonly string[] }> = [
			{ markdown: 'para\n```\ncode\n```', kinds: ['paragraph', 'codeBlock'] },
			{ markdown: 'para\n---', kinds: ['paragraph', 'thematicBreak'] },
			{ markdown: 'para\n> quote', kinds: ['paragraph', 'blockquote'] },
			{ markdown: 'para\n- item', kinds: ['paragraph', 'list'] },
			{ markdown: 'para\n| a | b |\n| - | - |', kinds: ['paragraph', 'table'] },
		]
		for (const { markdown, kinds } of cases) {
			const blocks = parseDocument(markdown).children
			expect(blocks.map((block) => block.element)).toEqual(kinds)
		}
	})
})

describe('parseInline — emphasis', () => {
	it('parses *italic* / _italic_ to a non-strong emphasis node', () => {
		for (const marker of ['*', '_']) {
			expect(assertEmphasisNode(parseInline(`an ${marker}italic${marker} word`)[1]).strong).toBe(
				false,
			)
		}
	})

	it('parses **bold** / __bold__ to a strong emphasis node', () => {
		for (const marker of ['**', '__']) {
			expect(assertEmphasisNode(parseInline(`a ${marker}bold${marker} word`)[1]).strong).toBe(true)
		}
	})

	it('nests emphasis (a strong wrapping an em)', () => {
		const strong = assertEmphasisNode(parseInline('**bold _and italic_ together**')[0])
		expect(strong.strong).toBe(true)
		expect(strong.children.some((child) => child.element === 'emphasis')).toBe(true)
		expect(inlineText(strong.children)).toBe('bold and italic together')
	})

	it('leaves an unterminated marker as literal text (degrades, never throws)', () => {
		const nodes = parseInline('a *dangling star')
		expect(nodes.every((node) => node.element === 'text')).toBe(true)
		expect(inlineText(nodes)).toBe('a *dangling star')
	})

	it('does not open emphasis on a marker followed by whitespace (* x *)', () => {
		expect(inlineText(parseInline('a * b * c'))).toBe('a * b * c')
		expect(parseInline('a * b * c').every((node) => node.element === 'text')).toBe(true)
	})
})

describe('parseInline — inline code', () => {
	it('parses `code` to a codeSpan with no inner markdown', () => {
		expect(assertCodeSpanNode(parseInline('use `const x = *1*` here')[1]).value).toBe(
			'const x = *1*',
		)
	})

	it('lets a double-backtick span contain a single backtick', () => {
		expect(assertCodeSpanNode(parseInline('`` a`b ``')[0]).value).toBe('a`b')
	})

	it('lets a triple-backtick span contain a double-backtick run', () => {
		expect(assertCodeSpanNode(parseInline('``` a``b ```')[0]).value).toBe('a``b')
	})

	it('strips exactly one leading + trailing space when the span is space-padded', () => {
		expect(assertCodeSpanNode(parseInline('` a `')[0]).value).toBe('a')
	})

	it('does not strip padding from an all-whitespace span', () => {
		expect(assertCodeSpanNode(parseInline('`  `')[0]).value).toBe('  ')
	})

	it('leaves an unterminated backtick as literal text', () => {
		expect(inlineText(parseInline('a `dangling'))).toBe('a `dangling')
	})
})

describe('parseInline — links', () => {
	it('parses [text](href) to a link node with inline children', () => {
		const link = assertLinkNode(parseInline('see [the **docs**](https://x.dev/a)')[1])
		expect(link.href).toBe('https://x.dev/a')
		expect(inlineText(link.children)).toBe('the docs')
		expect(link.children.some((child) => child.element === 'emphasis')).toBe(true)
	})

	it('keeps a relative / anchor href', () => {
		expect(assertLinkNode(parseInline('[a](./guide.md)')[0]).href).toBe('./guide.md')
	})

	it('parses nested brackets in the link text as a balanced unit', () => {
		const link = assertLinkNode(parseInline('[a [b] c](url)')[0])
		expect(inlineText(link.children)).toBe('a [b] c')
		expect(link.href).toBe('url')
	})

	it('unescapes backslash-escaped characters in the href', () => {
		expect(assertLinkNode(parseInline('[a](url\\)with\\)parens)')[0]).href).toBe('url)with)parens')
	})

	it('allows an empty link text and an empty href', () => {
		const link = assertLinkNode(parseInline('[]()')[0])
		expect(link.children).toEqual([])
		expect(link.href).toBe('')
	})

	it('leaves a bare [text] with no destination as literal text', () => {
		expect(inlineText(parseInline('a [bracketed] word'))).toBe('a [bracketed] word')
	})

	it('leaves an unterminated [text]( as literal text', () => {
		expect(inlineText(parseInline('a [text](unterminated'))).toBe('a [text](unterminated')
	})
})

describe('parseInline — images', () => {
	it('parses ![alt](src) to an image node', () => {
		const image = parseInline('![alt](x.png)')[0]
		expect(image).toEqual({
			element: 'image',
			src: 'x.png',
			children: [{ element: 'text', value: 'alt' }],
		})
	})

	it('parses emphasis inside image alternative content', () => {
		const image = parseInline('![an *important* image](x.png)')[0]
		if (image?.element !== 'image') throw new Error(`expected image, got ${image?.element}`)
		expect(image.children.map((child) => child.element)).toEqual(['text', 'emphasis', 'text'])
		expect(inlineText(image.children)).toBe('an important image')
	})

	it('allows empty alternative content and an empty destination', () => {
		const image = parseInline('![]()')[0]
		expect(image).toEqual({ element: 'image', src: '', children: [] })
	})

	it('handles balanced brackets and destination escapes exactly like links', () => {
		const image = parseInline('![a [b] c](x\\)y)')[0]
		if (image?.element !== 'image') throw new Error(`expected image, got ${image?.element}`)
		expect(inlineText(image.children)).toBe('a [b] c')
		expect(image.src).toBe('x)y')
	})

	it('leaves ![alt] without a destination as literal text', () => {
		const nodes = parseInline('before ![alt] after')
		expect(nodes).toEqual([{ element: 'text', value: 'before ![alt] after' }])
	})

	it('parses an image inside a link text', () => {
		const link = assertLinkNode(parseInline('[![alt](image.png)](page.html)')[0])
		expect(link.children).toEqual([
			{
				element: 'image',
				src: 'image.png',
				children: [{ element: 'text', value: 'alt' }],
			},
		])
	})

	it('parses an image inside a table cell', () => {
		const table = assertTableNode(firstBlock('| image |\n| --- |\n| ![alt](image.png) |'))
		expect(table.rows[0]?.[0]?.[0]).toEqual({
			element: 'image',
			src: 'image.png',
			children: [{ element: 'text', value: 'alt' }],
		})
	})
})

describe('parseDocument — hard breaks', () => {
	it('parses two or more trailing spaces before a paragraph newline as a hard break', () => {
		for (const spaces of ['  ', '   ', '    ']) {
			const paragraph = assertParagraphNode(firstBlock(`first${spaces}\nsecond`))
			expect(paragraph.children).toEqual([
				{ element: 'text', value: 'first' },
				{ element: 'break' },
				{ element: 'text', value: 'second' },
			])
		}
	})

	it('does not emit a hard break for trailing spaces at paragraph end', () => {
		const paragraph = assertParagraphNode(firstBlock('line  '))
		expect(paragraph.children).toEqual([{ element: 'text', value: 'line' }])
	})

	it('keeps backslash-newline literal because the scanner does not escape line endings', () => {
		const paragraph = assertParagraphNode(firstBlock('first\\\nsecond'))
		expect(paragraph.children).toEqual([{ element: 'text', value: 'first\\\nsecond' }])
	})
})

describe('parseDocument — lists', () => {
	it('parses a bulleted list (-, *, +) to an unordered list', () => {
		for (const bullet of ['-', '*', '+']) {
			const list = assertListNode(firstBlock(`${bullet} one\n${bullet} two`))
			expect(list.ordered).toBe(false)
			expect(list.items).toHaveLength(2)
		}
	})

	it('parses a numbered list (1. / 1)) to an ordered list carrying its start', () => {
		const list = assertListNode(firstBlock('3. three\n4. four'))
		expect(list.ordered).toBe(true)
		expect(list.start).toBe(3)
		expect(list.items).toHaveLength(2)
	})

	it('parses the closing-paren ordinal marker (1))', () => {
		const list = assertListNode(firstBlock('7) seven\n8) eight'))
		expect(list.ordered).toBe(true)
		expect(list.start).toBe(7)
	})

	it('parses a large 9-digit start ordinal via the integer contract', () => {
		const list = assertListNode(firstBlock('999999999. last\n1000000000. over'))
		expect(list.ordered).toBe(true)
		expect(list.start).toBe(999999999)
		// The second line's 10-digit ordinal no longer matches the marker regex (\d{1,9}),
		// so it is not a sibling list item — it stops the top loop after the first item.
		expect(list.items).toHaveLength(1)
	})

	it('nests a deeper-indented list inside its parent item', () => {
		const list = assertListNode(firstBlock('- parent\n  - child\n  - child2\n- sibling'))
		expect(list.items).toHaveLength(2)
		const nested = list.items[0]?.children.find((child) => child.element === 'list')
		expect(assertListNode(nested ?? { element: 'thematicBreak' }).items).toHaveLength(2)
	})

	it('nests a three-level indented list structurally correctly', () => {
		const list = assertListNode(firstBlock(buildDeepListInput(3, 'leaf')))
		const level2 = assertListNode(
			list.items[0]?.children.find((child) => child.element === 'list') ?? {
				element: 'thematicBreak',
			},
		)
		const level3 = assertListNode(
			level2.items[0]?.children.find((child) => child.element === 'list') ?? {
				element: 'thematicBreak',
			},
		)
		expect(inlineText(assertParagraphNode(level3.items[0]?.children[0]).children)).toBe('leaf')
	})

	it('carries each item content as inline text', () => {
		const list = assertListNode(firstBlock('- a **bold** item'))
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('a bold item')
	})

	it('splits a blank-line-separated continuation into two paragraphs within one item', () => {
		const list = assertListNode(firstBlock('- para line\n\n  more para'))
		expect(list.items).toHaveLength(1)
		expect(list.items[0]?.children.map((child) => child.element)).toEqual([
			'paragraph',
			'paragraph',
		])
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('para line')
		expect(inlineText(assertParagraphNode(list.items[0]?.children[1]).children)).toBe('more para')
	})

	it('gathers a lazy continuation line into the same item', () => {
		const list = assertListNode(firstBlock('- one\ncontinued'))
		expect(list.items).toHaveLength(1)
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe(
			'one\ncontinued',
		)
	})
})

describe('parseDocument — GFM tables', () => {
	const source = '| Name | Age |\n| :--- | ---: |\n| Ada | 36 |\n| Grace | 45 |'

	it('parses a header + delimiter + rows into a table node', () => {
		const table = assertTableNode(firstBlock(source))
		expect(table.header.map(inlineText)).toEqual(['Name', 'Age'])
		expect(table.rows).toHaveLength(2)
		expect(table.rows.map((row) => row.map(inlineText))).toEqual([
			['Ada', '36'],
			['Grace', '45'],
		])
	})

	it('reads per-column alignment from the delimiter row (all four combinations)', () => {
		const table = assertTableNode(
			firstBlock('| l | c | r | n |\n| :- | :-: | -: | - |\n| 1 | 2 | 3 | 4 |'),
		)
		expect(table.align).toEqual(['left', 'center', 'right', null])
	})

	it('pads a short delimiter row with absent alignment entries', () => {
		const table = assertTableNode(firstBlock('| a | b |\n| :- |'))

		expect(table.align).toEqual(['left', null])
	})

	it('parses inline content inside a cell', () => {
		const table = assertTableNode(firstBlock('| api | kind |\n| - | - |\n| `parse` | function |'))
		expect(table.rows[0]?.[0]?.[0]?.element).toBe('codeSpan')
	})

	it('pads a short body row to the header column count', () => {
		const table = assertTableNode(firstBlock('| a | b | c |\n| - | - | - |\n| 1 |'))
		expect(table.rows[0]).toHaveLength(3)
		expect(table.rows[0]?.map(inlineText)).toEqual(['1', '', ''])
	})

	it('truncates a long body row to the header column count', () => {
		const table = assertTableNode(firstBlock('| a | b |\n| - | - |\n| 1 | 2 | 3 | 4 |'))
		expect(table.rows[0]).toHaveLength(2)
		expect(table.rows[0]?.map(inlineText)).toEqual(['1', '2'])
	})

	it('treats an escaped pipe inside a cell as literal, not a separator', () => {
		const table = assertTableNode(firstBlock('| a | b |\n| - | - |\n| x\\|y | z |'))
		expect(table.rows[0]?.map(inlineText)).toEqual(['x|y', 'z'])
	})

	it('parses a table without outer pipes', () => {
		const table = assertTableNode(firstBlock('a | b\n- | -\n1 | 2'))
		expect(table.header.map(inlineText)).toEqual(['a', 'b'])
		expect(table.rows.map((row) => row.map(inlineText))).toEqual([['1', '2']])
	})

	it('parses a header-only table (no body rows)', () => {
		const table = assertTableNode(firstBlock('| a | b |\n| - | - |'))
		expect(table.header.map(inlineText)).toEqual(['a', 'b'])
		expect(table.rows).toEqual([])
	})

	it('parses a single-column table', () => {
		const table = assertTableNode(firstBlock('| only |\n| - |\n| x |'))
		expect(table.header.map(inlineText)).toEqual(['only'])
		expect(table.rows.map((row) => row.map(inlineText))).toEqual([['x']])
	})

	it('does NOT form a table without a delimiter row (a lone pipe line is a paragraph)', () => {
		expect(firstBlock('| a | b |\njust text').element).toBe('paragraph')
	})
})

describe('parseDocument — fenced code blocks', () => {
	it('parses a ```lang block, preserving content verbatim and capturing the language', () => {
		const block = assertCodeBlockNode(firstBlock('```ts\nconst x = *1*\nif (x) y()\n```'))
		expect(block.lang).toBe('ts')
		expect(block.code).toBe('const x = *1*\nif (x) y()')
	})

	it('omits the language when the fence has no info string', () => {
		expect(assertCodeBlockNode(firstBlock('```\nplain\n```')).lang).toBeUndefined()
	})

	it('does not parse markdown inside a code block', () => {
		const block = assertCodeBlockNode(firstBlock('```\n# not a heading\n- not a list\n```'))
		expect(block.code).toBe('# not a heading\n- not a list')
	})

	it('supports a ~~~ fence too', () => {
		expect(firstBlock('~~~\ncode\n~~~').element).toBe('codeBlock')
	})

	it('runs an unterminated fence to EOF, capturing all remaining lines as code', () => {
		const block = assertCodeBlockNode(firstBlock('```ts\nline one\nline two'))
		expect(block.code).toBe('line one\nline two')
		expect(block.lang).toBe('ts')
	})

	it('closes on a longer closing-fence run than the opener', () => {
		const block = assertCodeBlockNode(firstBlock('```\ncode\n`````'))
		expect(block.code).toBe('code')
	})

	it('closes on a closing fence with trailing whitespace', () => {
		const block = assertCodeBlockNode(firstBlock('```\ncode\n```   '))
		expect(block.code).toBe('code')
	})

	it('does not close a backtick fence with a tilde run (and vice versa)', () => {
		const backtickBlock = assertCodeBlockNode(firstBlock('```\ncode\n~~~\nmore'))
		expect(backtickBlock.code).toBe('code\n~~~\nmore')
		const tildeBlock = assertCodeBlockNode(firstBlock('~~~\ncode\n```\nmore'))
		expect(tildeBlock.code).toBe('code\n```\nmore')
	})
})

describe('parseDocument — thematic breaks', () => {
	it('parses ---, ***, ___ as a thematic break', () => {
		for (const rule of ['---', '***', '___']) {
			expect(firstBlock(rule).element).toBe('thematicBreak')
		}
	})

	it('parses a spaced thematic break variant (- - -)', () => {
		expect(firstBlock('- - -').element).toBe('thematicBreak')
	})

	it('a two-character run (--) is NOT a thematic break — parses as a paragraph', () => {
		expect(firstBlock('--').element).toBe('paragraph')
	})

	it('a single dash followed by a space is a list item, not a thematic break', () => {
		expect(firstBlock('- item').element).toBe('list')
	})
})

describe('parseDocument — blockquotes', () => {
	it('parses > lines into a blockquote of nested blocks', () => {
		expect(
			assertBlockquoteNode(firstBlock('> a quoted line\n> over two')).children[0]?.element,
		).toBe('paragraph')
	})

	it('joins multiple > lines into one paragraph inside the blockquote', () => {
		const quote = assertBlockquoteNode(firstBlock('> line one\n> line two'))
		expect(inlineText(assertParagraphNode(quote.children[0]).children)).toBe('line one\nline two')
	})

	it('nests a heading inside a blockquote', () => {
		expect(assertBlockquoteNode(firstBlock('> ## quoted heading')).children[0]?.element).toBe(
			'heading',
		)
	})

	it('nests a blockquote two levels deep with correct AST shape', () => {
		const outer = assertBlockquoteNode(firstBlock('> > inner text'))
		const inner = assertBlockquoteNode(outer.children[0] ?? { element: 'thematicBreak' })
		expect(inlineText(assertParagraphNode(inner.children[0]).children)).toBe('inner text')
	})

	it('nests a blockquote three levels deep with correct AST shape', () => {
		const level1 = assertBlockquoteNode(firstBlock(buildDeepQuoteInput(3, 'deep leaf')))
		const level2 = assertBlockquoteNode(level1.children[0] ?? { element: 'thematicBreak' })
		const level3 = assertBlockquoteNode(level2.children[0] ?? { element: 'thematicBreak' })
		expect(inlineText(assertParagraphNode(level3.children[0]).children)).toBe('deep leaf')
	})

	it('ends the blockquote when a line is no longer prefixed with >', () => {
		const blocks = parseDocument('> quoted\nnot quoted').children
		expect(blocks.map((block) => block.element)).toEqual(['blockquote', 'paragraph'])
	})
})

describe('parseDocument — MAX_DEPTH recursion cap (block phase)', () => {
	it('degrades a blockquote nested past MAX_DEPTH to one literal paragraph', () => {
		const document = parseDocument(buildDeepQuoteInput(100, 'too deep'))
		// The outer 63 levels still nest normally; the recursion caps at MAX_DEPTH=64 and
		// the remaining lines degrade to a single literal paragraph rather than recursing
		// further, so the resulting AST never throws and stays bounded.
		expect(document.children).toHaveLength(1)
		let node = document.children[0]
		let guard = 0
		while (node !== undefined && node.element === 'blockquote' && guard < 200) {
			const next = node.children[0]
			node = next
			guard += 1
		}
		expect(node?.element).toBe('paragraph')
	})

	it('pins the exact blockquote nesting depth MAX_DEPTH(=64) caps at', () => {
		const document = parseDocument(buildDeepQuoteInput(100, 'too deep'))
		let node = document.children[0]
		let depth = 0
		while (node !== undefined && node.element === 'blockquote') {
			depth += 1
			node = node.children[0]
		}
		expect(depth).toBe(64)
	})

	it('degrades a deeply indented nested list past MAX_DEPTH without throwing', () => {
		expect(() => parseDocument(buildDeepListInput(200, 'leaf'))).not.toThrow()
	})

	it('pins deep-list degradation at MAX_DEPTH and retains the residual source', () => {
		let node = firstBlock(buildDeepListInput(100, 'leaf'))
		let depth = 0
		while (node.element === 'list') {
			const item = assertListNode(node).items[0]
			if (item === undefined) throw new Error('expected a nested list item')
			const child = item.children[0]
			if (child === undefined) throw new Error('expected nested list content')
			node = child
			depth += 1
		}
		const paragraph = assertParagraphNode(node)
		const residual = inlineText(paragraph.children)
		expect(depth).toBe(MAX_DEPTH)
		expect(residual.startsWith('\n- ')).toBe(true)
		expect(residual.endsWith('leaf')).toBe(true)
	})
})

describe('parseDocument — total / malformed input never throws', () => {
	const cases = [
		'',
		'   ',
		'\n\n\n',
		'**',
		'`',
		'[',
		'](',
		'| | |',
		'```',
		'> > > deeply nested',
		'#'.repeat(100),
		'*'.repeat(1000), // adversarial run — must stay linear-time (no ReDoS) and not throw
		'[a](javascript:alert(1))',
		'a\0b￿',
	]

	for (const markdown of cases) {
		it(`parses ${JSON.stringify(markdown.slice(0, 24))} without throwing`, () => {
			expect(() => parseDocument(markdown)).not.toThrow()
		})
	}

	it('produces an empty document for blank-only input (total)', () => {
		expect(parseDocument('\n\n  \n').children).toEqual([])
	})

	it('returns a document whose children carry the parsed blocks', () => {
		const document = parseDocument('# hi')
		expect(document.element).toBe('document')
		expect(document.children).toHaveLength(1)
	})

	it('dispatches each line to its block kind', () => {
		const doc = parseDocument('# h\n\npara\n\n- item\n\n> quote')
		expect(doc.children.map((block) => block.element)).toEqual([
			'heading',
			'paragraph',
			'list',
			'blockquote',
		])
	})

	it('parses a long emphasis-marker run quickly (linear-time, no ReDoS)', () => {
		const start = Date.now()
		parseDocument('a'.repeat(20_000) + '*'.repeat(20_000))
		expect(Date.now() - start).toBeLessThan(1000)
	})

	it('parses a pathologically deep blockquote (10,000 levels) without throwing', () => {
		expect(() => parseDocument(buildDeepQuoteInput(10_000)).children.length).not.toThrow()
	})

	it('parses a pathologically deep indented list (2,000 levels) without throwing', () => {
		expect(() => parseDocument(buildDeepListInput(2_000)).children.length).not.toThrow()
	})

	it('parses a pathologically deep emphasis/link chain (10,000 levels) without throwing', () => {
		expect(() => parseDocument(buildDeepEmphasisInput(10_000)).children.length).not.toThrow()
	})
})

describe('parseInline — coalescing and mixed runs', () => {
	it('coalesces and parses a mixed inline run', () => {
		const nodes = parseInline('a **b** `c` [d](e)')
		expect(nodes.map((node) => node.element)).toEqual([
			'text',
			'emphasis',
			'text',
			'codeSpan',
			'text',
			'link',
		])
	})
})

describe('parseInline — MAX_DEPTH recursion cap', () => {
	it('a pathologically nested emphasis/link chain never throws and collapses well below its raw depth', () => {
		const nodes = parseInline(buildDeepEmphasisInput(200, 'leaf'))
		expect(nodes).toHaveLength(1)
	})

	it('a modest-depth (3-level) emphasis/link chain parses without throwing and keeps the leaf text', () => {
		const nodes = parseInline(buildDeepEmphasisInput(3, 'leaf'))
		expect(inlineText(nodes)).toContain('leaf')
	})
})

describe('parseDocument — line endings', () => {
	const markdown = '# Title\n\n- a\n- b\n\n> quote'

	it('parses CRLF input to the same AST as LF input', () => {
		const crlf = markdown.replace(/\n/g, '\r\n')
		expect(parseDocument(crlf)).toEqual(parseDocument(markdown))
	})

	it('parses lone-CR input to the same AST as LF input', () => {
		const cr = markdown.replace(/\n/g, '\r')
		expect(parseDocument(cr)).toEqual(parseDocument(markdown))
	})
})

describe('parseDocument — round-trip over a self-contained composite document', () => {
	// One inline fixture exercising every construct this parser supports, proving it
	// handles a realistic WHOLE document (not just one construct at a time) — no disk
	// reads.
	const markdown = [
		'# Title',
		'',
		'An intro with **bold**, _italic_, `code`, and a [link](./guide.md).',
		'',
		'## Section',
		'',
		'- one',
		'- two',
		'  - nested',
		'',
		'1. first',
		'2. second',
		'',
		'| Name | Kind |',
		'| :--- | ---: |',
		'| `parse` | function |',
		'',
		'```ts',
		'const x = 1',
		'```',
		'',
		'> a quoted line',
		'',
		'---',
	].join('\n')
	const document = parseDocument(markdown)

	it('parses the composite document into the expected ordered top-level structure', () => {
		expect(document.element).toBe('document')
		expect(document.children.map((block) => block.element)).toEqual([
			'heading',
			'paragraph',
			'heading',
			'list',
			'list',
			'table',
			'codeBlock',
			'blockquote',
			'thematicBreak',
		])
	})

	it('finds the H1 title as the first heading', () => {
		const heading = assertHeadingNode(firstBlock(markdown))
		expect(heading.level).toBe(1)
		expect(inlineText(heading.children)).toBe('Title')
	})
})

describe('parseBlocks', () => {
	it('honors the depth parameter — parseBlocks(lines, MAX_DEPTH) degrades to one literal paragraph', () => {
		const blocks = parseBlocks(splitLines('# heading\nplain'), MAX_DEPTH)
		expect(blocks).toHaveLength(1)
		expect(blocks[0]?.element).toBe('paragraph')
	})

	it('returns an empty array for empty input at depth MAX_DEPTH', () => {
		expect(parseBlocks([], MAX_DEPTH)).toEqual([])
	})

	it('parses normally below MAX_DEPTH', () => {
		const blocks = parseBlocks(splitLines('# h\npara'), 0)
		expect(blocks.map((block) => block.element)).toEqual(['heading', 'paragraph'])
	})
})

describe('parseProvenance — original-source spans', () => {
	it('records the document span through a trailing terminator', () => {
		const markdown = '# Head\n'
		const [document, spans] = parseProvenance(markdown)
		const span = spans.get(document)
		if (span === undefined) throw new Error('expected a document span')
		expect(markdown.slice(span.start, span.end)).toBe(markdown)
	})

	it('spans the whole input on the document a handle-free parse returns', () => {
		const [document, spans] = parseProvenance('# Title\n\nA **bold** word.')
		expect(spans.get(document)).toEqual({ start: 0, end: 25 })
	})

	it('records heading and heading-text spans', () => {
		const markdown = '  ## Head ##  '
		const [document, spans] = parseProvenance(markdown)
		const heading = assertHeadingNode(document.children[0])
		const headingSpan = spans.get(heading)
		const text = heading.children[0]
		const textSpan = text === undefined ? undefined : spans.get(text)
		if (headingSpan === undefined || textSpan === undefined)
			throw new Error('expected heading spans')
		expect(markdown.slice(headingSpan.start, headingSpan.end)).toBe(markdown)
		expect(markdown.slice(textSpan.start, textSpan.end)).toBe('Head')
	})

	it('records paragraph and coalesced text spans over consumed spelling', () => {
		const markdown = '  escaped \\* text  '
		const [document, spans] = parseProvenance(markdown)
		const paragraph = assertParagraphNode(document.children[0])
		const text = paragraph.children[0]
		const paragraphSpan = spans.get(paragraph)
		const textSpan = text === undefined ? undefined : spans.get(text)
		if (paragraphSpan === undefined || textSpan === undefined)
			throw new Error('expected paragraph spans')
		expect(markdown.slice(paragraphSpan.start, paragraphSpan.end)).toBe(markdown)
		expect(markdown.slice(textSpan.start, textSpan.end)).toBe('escaped \\* text')
	})

	it('records blockquote and nested block spans', () => {
		const markdown = '> quote\n> **bold**'
		const [document, spans] = parseProvenance(markdown)
		const quote = assertBlockquoteNode(document.children[0])
		const paragraph = assertParagraphNode(quote.children[0])
		const quoteSpan = spans.get(quote)
		const paragraphSpan = spans.get(paragraph)
		if (quoteSpan === undefined || paragraphSpan === undefined)
			throw new Error('expected blockquote spans')
		expect(markdown.slice(quoteSpan.start, quoteSpan.end)).toBe(markdown)
		expect(markdown.slice(paragraphSpan.start, paragraphSpan.end)).toBe('quote\n> **bold**')
	})

	it('records list and list-item spans through indented and lazy continuations', () => {
		const markdown = '- item\n  indented\nlazy\n- next'
		const [document, spans] = parseProvenance(markdown)
		const list = assertListNode(document.children[0])
		const first = list.items[0]
		const second = list.items[1]
		const listSpan = spans.get(list)
		const firstSpan = first === undefined ? undefined : spans.get(first)
		const secondSpan = second === undefined ? undefined : spans.get(second)
		if (listSpan === undefined || firstSpan === undefined || secondSpan === undefined)
			throw new Error('expected list spans')
		expect(markdown.slice(listSpan.start, listSpan.end)).toBe(markdown)
		expect(markdown.slice(firstSpan.start, firstSpan.end)).toBe('- item\n  indented\nlazy')
		expect(markdown.slice(secondSpan.start, secondSpan.end)).toBe('- next')
	})

	it('preserves spans through nested-list and blank-continuation branches', () => {
		const nestedMarkdown = '- parent\n  - child'
		const [nestedDocument, nestedSpans] = parseProvenance(nestedMarkdown)
		const outer = assertListNode(nestedDocument.children[0])
		const nested = assertListNode(outer.items[0]?.children[1])
		const nestedItem = nested.items[0]
		const nestedSpan = nestedSpans.get(nested)
		const nestedItemSpan = nestedItem === undefined ? undefined : nestedSpans.get(nestedItem)
		if (nestedSpan === undefined || nestedItemSpan === undefined)
			throw new Error('expected nested-list spans')
		expect(nestedMarkdown.slice(nestedSpan.start, nestedSpan.end)).toBe('- child')
		expect(nestedMarkdown.slice(nestedItemSpan.start, nestedItemSpan.end)).toBe('- child')

		const continuationMarkdown = '- first\n\n  second'
		const [continuationDocument, continuationSpans] = parseProvenance(continuationMarkdown)
		const list = assertListNode(continuationDocument.children[0])
		const item = list.items[0]
		const itemSpan = item === undefined ? undefined : continuationSpans.get(item)
		if (itemSpan === undefined) throw new Error('expected a blank-continuation span')
		expect(continuationMarkdown.slice(itemSpan.start, itemSpan.end)).toBe(continuationMarkdown)
	})

	it('records table and cell-inline spans through escaped pipes', () => {
		const markdown = '| head |\n| --- |\n| a\\|b |'
		const [document, spans] = parseProvenance(markdown)
		const table = assertTableNode(document.children[0])
		const header = table.header[0]?.[0]
		const cell = table.rows[0]?.[0]?.[0]
		const tableSpan = spans.get(table)
		const headerSpan = header === undefined ? undefined : spans.get(header)
		const cellSpan = cell === undefined ? undefined : spans.get(cell)
		if (tableSpan === undefined || headerSpan === undefined || cellSpan === undefined)
			throw new Error('expected table spans')
		expect(markdown.slice(tableSpan.start, tableSpan.end)).toBe(markdown)
		expect(markdown.slice(headerSpan.start, headerSpan.end)).toBe('head')
		expect(markdown.slice(cellSpan.start, cellSpan.end)).toBe('a\\|b')
	})

	it('records fenced-code and thematic-break spans', () => {
		const markdown = '```ts\ncode\n```\n---'
		const [document, spans] = parseProvenance(markdown)
		const fence = assertCodeBlockNode(document.children[0])
		const rule = document.children[1]
		const fenceSpan = spans.get(fence)
		const ruleSpan = rule === undefined ? undefined : spans.get(rule)
		if (fenceSpan === undefined || ruleSpan === undefined)
			throw new Error('expected leaf block spans')
		expect(markdown.slice(fenceSpan.start, fenceSpan.end)).toBe('```ts\ncode\n```')
		expect(markdown.slice(ruleSpan.start, ruleSpan.end)).toBe('---')
	})

	it('runs an unclosed fence span through the original input end', () => {
		const markdown = '```ts\r\ncode\r\n'
		const [document, spans] = parseProvenance(markdown)
		const fence = assertCodeBlockNode(document.children[0])
		const span = spans.get(fence)
		if (span === undefined) throw new Error('expected an unclosed-fence span')
		expect(markdown.slice(span.start, span.end)).toBe(markdown)
	})

	it('records emphasis, code-span, link, image, and descendant text spans', () => {
		const markdown = '**bold** `code` [link](target) ![alt](image)'
		const [document, spans] = parseProvenance(markdown)
		const paragraph = assertParagraphNode(document.children[0])
		const emphasis = assertEmphasisNode(paragraph.children[0])
		const code = assertCodeSpanNode(paragraph.children[2])
		const link = assertLinkNode(paragraph.children[4])
		const image = paragraph.children[6]
		if (image?.element !== 'image') throw new Error('expected an image node')
		const emphasisSpan = spans.get(emphasis)
		const codeSpan = spans.get(code)
		const linkSpan = spans.get(link)
		const imageSpan = spans.get(image)
		const bold = emphasis.children[0]
		const label = link.children[0]
		const alt = image.children[0]
		const boldSpan = bold === undefined ? undefined : spans.get(bold)
		const labelSpan = label === undefined ? undefined : spans.get(label)
		const altSpan = alt === undefined ? undefined : spans.get(alt)
		if (
			emphasisSpan === undefined ||
			codeSpan === undefined ||
			linkSpan === undefined ||
			imageSpan === undefined ||
			boldSpan === undefined ||
			labelSpan === undefined ||
			altSpan === undefined
		)
			throw new Error('expected inline spans')
		expect(markdown.slice(emphasisSpan.start, emphasisSpan.end)).toBe('**bold**')
		expect(markdown.slice(codeSpan.start, codeSpan.end)).toBe('`code`')
		expect(markdown.slice(linkSpan.start, linkSpan.end)).toBe('[link](target)')
		expect(markdown.slice(imageSpan.start, imageSpan.end)).toBe('![alt](image)')
		expect(markdown.slice(boldSpan.start, boldSpan.end)).toBe('bold')
		expect(markdown.slice(labelSpan.start, labelSpan.end)).toBe('link')
		expect(markdown.slice(altSpan.start, altSpan.end)).toBe('alt')
	})

	it('assigns the whole trailing-space run and CRLF terminator to a hard break', () => {
		const markdown = 'start   \r\nend'
		const [document, spans] = parseProvenance(markdown)
		const paragraph = assertParagraphNode(document.children[0])
		const lineBreak = paragraph.children[1]
		if (lineBreak?.element !== 'break') throw new Error('expected a hard break')
		const span = spans.get(lineBreak)
		if (span === undefined) throw new Error('expected a hard-break span')
		expect(markdown.slice(span.start, span.end)).toBe('   \r\n')
	})

	it('keeps every composite node value byte-identical to the pre-threading parse', () => {
		const markdown = [
			'# Head',
			'',
			'Plain \\*literal\\* **bold** `code` [link](target) ![alt](image)  ',
			'next',
			'',
			'> quote',
			'',
			'- item',
			'  continuation',
			'',
			'| head |',
			'| --- |',
			'| cell |',
			'',
			'```ts',
			'code',
			'```',
			'',
			'---',
		].join('\n')
		const [document, spans] = parseProvenance(markdown)
		expect(JSON.stringify(document)).toBe(
			'{"element":"document","children":[{"element":"heading","level":1,"children":[{"element":"text","value":"Head"}]},{"element":"paragraph","children":[{"element":"text","value":"Plain *literal* "},{"element":"emphasis","strong":true,"children":[{"element":"text","value":"bold"}]},{"element":"text","value":" "},{"element":"codeSpan","value":"code"},{"element":"text","value":" "},{"element":"link","href":"target","children":[{"element":"text","value":"link"}]},{"element":"text","value":" "},{"element":"image","src":"image","children":[{"element":"text","value":"alt"}]},{"element":"break"},{"element":"text","value":"next"}]},{"element":"blockquote","children":[{"element":"paragraph","children":[{"element":"text","value":"quote"}]}]},{"element":"list","ordered":false,"start":1,"items":[{"element":"listItem","children":[{"element":"paragraph","children":[{"element":"text","value":"item\\ncontinuation"}]}]}]},{"element":"table","header":[[{"element":"text","value":"head"}]],"rows":[[[{"element":"text","value":"cell"}]]],"align":[null]},{"element":"codeBlock","lang":"ts","code":"code"},{"element":"thematicBreak"}]}',
		)
		for (const node of walkNodes(document)) expect(spans.has(node)).toBe(true)
	})
})
