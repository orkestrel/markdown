import type { MarkdownDocument, TextNode } from '@src/core'
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
	buildDeepBlockNode,
	buildDeepEmphasisInput,
	buildDeepListInput,
	buildDeepQuoteInput,
	firstBlock,
	inlineText,
} from '../../setup.js'
import { isMarkdownNode, MarkdownParser, scanInline } from '@src/core'

// The markdown parser — terrain's zero-dependency, types-first markdown primitive.
// The AST is the contract: each construct (heading / paragraph / list / GFM table /
// fenced + inline code / link / emphasis / blockquote / thematic break) parses to the
// right discriminated node, and a SEPARATE renderer projects the AST to a safe HTML
// string (text + code HTML-escaped, link hrefs sanitized — no XSS). Pure + total:
// malformed markdown degrades to text, never throws, and a MAX_DEPTH recursion cap
// (block phase, inline phase, and render) degrades pathologically deep input to a
// single literal node rather than exhausting the call stack. Driven entirely with
// plain inline strings — self-contained, no disk reads. The AST narrowers and
// deep-input builders are centralized in tests/setup.ts (AGENTS §16).

describe('MarkdownParser — headings', () => {
	it('parses each ATX level (# … ######) to the right heading level', () => {
		const parser = new MarkdownParser()
		for (let level = 1; level <= 6; level += 1) {
			const heading = assertHeadingNode(firstBlock(parser, `${'#'.repeat(level)} Title ${level}`))
			expect(heading.level).toBe(level)
			expect(inlineText(heading.children)).toBe(`Title ${level}`)
		}
	})

	it('does not treat seven #s as a heading (degrades to a paragraph)', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '####### too deep').element).toBe('paragraph')
	})

	it('requires a space after the #s (a bare #tag is a paragraph)', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '#notaheading').element).toBe('paragraph')
	})

	it('strips an optional closing ### run', () => {
		const parser = new MarkdownParser()
		expect(inlineText(assertHeadingNode(firstBlock(parser, '## Title ##')).children)).toBe('Title')
	})

	it('parses inline content inside a heading', () => {
		const parser = new MarkdownParser()
		const heading = assertHeadingNode(firstBlock(parser, '## A **bold** word'))
		expect(heading.children.some((node) => node.element === 'emphasis')).toBe(true)
	})
})

describe('MarkdownParser — paragraphs', () => {
	it('wraps a run of plain lines into one paragraph', () => {
		const parser = new MarkdownParser()
		const block = firstBlock(parser, 'line one\nline two')
		expect(block.element).toBe('paragraph')
		expect(inlineText(block.element === 'paragraph' ? block.children : [])).toBe(
			'line one\nline two',
		)
	})

	it('separates two paragraphs on a blank line', () => {
		const parser = new MarkdownParser()
		const blocks = parser.parse('first\n\nsecond').children
		expect(blocks.map((block) => block.element)).toEqual(['paragraph', 'paragraph'])
	})

	it('starts a heading directly under a paragraph (no blank line required)', () => {
		const parser = new MarkdownParser()
		const blocks = parser.parse('a paragraph\n## a heading').children
		expect(blocks.map((block) => block.element)).toEqual(['paragraph', 'heading'])
	})

	it('stops the paragraph at each block-starting construct without a blank line', () => {
		const parser = new MarkdownParser()
		const cases: readonly { readonly markdown: string; readonly kinds: readonly string[] }[] = [
			{ markdown: 'para\n```\ncode\n```', kinds: ['paragraph', 'codeBlock'] },
			{ markdown: 'para\n---', kinds: ['paragraph', 'thematicBreak'] },
			{ markdown: 'para\n> quote', kinds: ['paragraph', 'blockquote'] },
			{ markdown: 'para\n- item', kinds: ['paragraph', 'list'] },
			{ markdown: 'para\n| a | b |\n| - | - |', kinds: ['paragraph', 'table'] },
		]
		for (const { markdown, kinds } of cases) {
			const blocks = parser.parse(markdown).children
			expect(blocks.map((block) => block.element)).toEqual(kinds)
		}
	})
})

describe('MarkdownParser — emphasis', () => {
	it('parses *italic* / _italic_ to a non-strong emphasis node', () => {
		const parser = new MarkdownParser()
		for (const marker of ['*', '_']) {
			expect(
				assertEmphasisNode(parser.parseInline(`an ${marker}italic${marker} word`)[1]).strong,
			).toBe(false)
		}
	})

	it('parses **bold** / __bold__ to a strong emphasis node', () => {
		const parser = new MarkdownParser()
		for (const marker of ['**', '__']) {
			expect(
				assertEmphasisNode(parser.parseInline(`a ${marker}bold${marker} word`)[1]).strong,
			).toBe(true)
		}
	})

	it('nests emphasis (a strong wrapping an em)', () => {
		const parser = new MarkdownParser()
		const strong = assertEmphasisNode(parser.parseInline('**bold _and italic_ together**')[0])
		expect(strong.strong).toBe(true)
		expect(strong.children.some((child) => child.element === 'emphasis')).toBe(true)
		expect(inlineText(strong.children)).toBe('bold and italic together')
	})

	it('leaves an unterminated marker as literal text (degrades, never throws)', () => {
		const parser = new MarkdownParser()
		const nodes = parser.parseInline('a *dangling star')
		expect(nodes.every((node) => node.element === 'text')).toBe(true)
		expect(inlineText(nodes)).toBe('a *dangling star')
	})

	it('does not open emphasis on a marker followed by whitespace (* x *)', () => {
		const parser = new MarkdownParser()
		expect(inlineText(parser.parseInline('a * b * c'))).toBe('a * b * c')
		expect(parser.parseInline('a * b * c').every((node) => node.element === 'text')).toBe(true)
	})
})

describe('MarkdownParser — inline code', () => {
	it('parses `code` to a codeSpan with no inner markdown', () => {
		const parser = new MarkdownParser()
		expect(assertCodeSpanNode(parser.parseInline('use `const x = *1*` here')[1]).value).toBe(
			'const x = *1*',
		)
	})

	it('lets a double-backtick span contain a single backtick', () => {
		const parser = new MarkdownParser()
		expect(assertCodeSpanNode(parser.parseInline('`` a`b ``')[0]).value).toBe('a`b')
	})

	it('lets a triple-backtick span contain a double-backtick run', () => {
		const parser = new MarkdownParser()
		expect(assertCodeSpanNode(parser.parseInline('``` a``b ```')[0]).value).toBe('a``b')
	})

	it('strips exactly one leading + trailing space when the span is space-padded', () => {
		const parser = new MarkdownParser()
		expect(assertCodeSpanNode(parser.parseInline('` a `')[0]).value).toBe('a')
	})

	it('does not strip padding from an all-whitespace span', () => {
		const parser = new MarkdownParser()
		expect(assertCodeSpanNode(parser.parseInline('`  `')[0]).value).toBe('  ')
	})

	it('leaves an unterminated backtick as literal text', () => {
		const parser = new MarkdownParser()
		expect(inlineText(parser.parseInline('a `dangling'))).toBe('a `dangling')
	})
})

describe('MarkdownParser — links', () => {
	it('parses [text](href) to a link node with inline children', () => {
		const parser = new MarkdownParser()
		const link = assertLinkNode(parser.parseInline('see [the **docs**](https://x.dev/a)')[1])
		expect(link.href).toBe('https://x.dev/a')
		expect(inlineText(link.children)).toBe('the docs')
		expect(link.children.some((child) => child.element === 'emphasis')).toBe(true)
	})

	it('keeps a relative / anchor href', () => {
		const parser = new MarkdownParser()
		expect(assertLinkNode(parser.parseInline('[a](./guide.md)')[0]).href).toBe('./guide.md')
	})

	it('parses nested brackets in the link text as a balanced unit', () => {
		const parser = new MarkdownParser()
		const link = assertLinkNode(parser.parseInline('[a [b] c](url)')[0])
		expect(inlineText(link.children)).toBe('a [b] c')
		expect(link.href).toBe('url')
	})

	it('unescapes backslash-escaped characters in the href', () => {
		const parser = new MarkdownParser()
		expect(assertLinkNode(parser.parseInline('[a](url\\)with\\)parens)')[0]).href).toBe(
			'url)with)parens',
		)
	})

	it('allows an empty link text and an empty href', () => {
		const parser = new MarkdownParser()
		const link = assertLinkNode(parser.parseInline('[]()')[0])
		expect(link.children).toEqual([])
		expect(link.href).toBe('')
	})

	it('leaves a bare [text] with no destination as literal text', () => {
		const parser = new MarkdownParser()
		expect(inlineText(parser.parseInline('a [bracketed] word'))).toBe('a [bracketed] word')
	})

	it('leaves an unterminated [text]( as literal text', () => {
		const parser = new MarkdownParser()
		expect(inlineText(parser.parseInline('a [text](unterminated'))).toBe('a [text](unterminated')
	})
})

describe('MarkdownParser — lists', () => {
	it('parses a bulleted list (-, *, +) to an unordered list', () => {
		const parser = new MarkdownParser()
		for (const bullet of ['-', '*', '+']) {
			const list = assertListNode(firstBlock(parser, `${bullet} one\n${bullet} two`))
			expect(list.ordered).toBe(false)
			expect(list.items).toHaveLength(2)
		}
	})

	it('parses a numbered list (1. / 1)) to an ordered list carrying its start', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '3. three\n4. four'))
		expect(list.ordered).toBe(true)
		expect(list.start).toBe(3)
		expect(list.items).toHaveLength(2)
	})

	it('parses the closing-paren ordinal marker (1))', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '7) seven\n8) eight'))
		expect(list.ordered).toBe(true)
		expect(list.start).toBe(7)
	})

	it('parses a large 9-digit start ordinal via the integer contract', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '999999999. last\n1000000000. over'))
		expect(list.ordered).toBe(true)
		expect(list.start).toBe(999999999)
		// The second line's 10-digit ordinal no longer matches the marker regex (\d{1,9}),
		// so it is not a sibling list item — it stops the top loop after the first item.
		expect(list.items).toHaveLength(1)
	})

	it('nests a deeper-indented list inside its parent item', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '- parent\n  - child\n  - child2\n- sibling'))
		expect(list.items).toHaveLength(2)
		const nested = list.items[0]?.children.find((child) => child.element === 'list')
		expect(assertListNode(nested ?? { element: 'thematicBreak' }).items).toHaveLength(2)
	})

	it('nests a three-level indented list structurally correctly', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, buildDeepListInput(3, 'leaf')))
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
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '- a **bold** item'))
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('a bold item')
	})

	it('splits a blank-line-separated continuation into two paragraphs within one item', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '- para line\n\n  more para'))
		expect(list.items).toHaveLength(1)
		expect(list.items[0]?.children.map((child) => child.element)).toEqual([
			'paragraph',
			'paragraph',
		])
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('para line')
		expect(inlineText(assertParagraphNode(list.items[0]?.children[1]).children)).toBe('more para')
	})

	it('gathers a lazy continuation line into the same item', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '- one\ncontinued'))
		expect(list.items).toHaveLength(1)
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe(
			'one\ncontinued',
		)
	})
})

describe('MarkdownParser — GFM tables', () => {
	const source = '| Name | Age |\n| :--- | ---: |\n| Ada | 36 |\n| Grace | 45 |'

	it('parses a header + delimiter + rows into a table node', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, source))
		expect(table.header.map(inlineText)).toEqual(['Name', 'Age'])
		expect(table.rows).toHaveLength(2)
		expect(table.rows.map((row) => row.map(inlineText))).toEqual([
			['Ada', '36'],
			['Grace', '45'],
		])
	})

	it('reads per-column alignment from the delimiter row (all four combinations)', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(
			firstBlock(parser, '| l | c | r | n |\n| :- | :-: | -: | - |\n| 1 | 2 | 3 | 4 |'),
		)
		expect(table.align).toEqual(['left', 'center', 'right', 'none'])
	})

	it('parses inline content inside a cell', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(
			firstBlock(parser, '| api | kind |\n| - | - |\n| `parse` | function |'),
		)
		expect(table.rows[0]?.[0]?.[0]?.element).toBe('codeSpan')
	})

	it('pads a short body row to the header column count', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, '| a | b | c |\n| - | - | - |\n| 1 |'))
		expect(table.rows[0]).toHaveLength(3)
		expect(table.rows[0]?.map(inlineText)).toEqual(['1', '', ''])
	})

	it('truncates a long body row to the header column count', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, '| a | b |\n| - | - |\n| 1 | 2 | 3 | 4 |'))
		expect(table.rows[0]).toHaveLength(2)
		expect(table.rows[0]?.map(inlineText)).toEqual(['1', '2'])
	})

	it('treats an escaped pipe inside a cell as literal, not a separator', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, '| a | b |\n| - | - |\n| x\\|y | z |'))
		expect(table.rows[0]?.map(inlineText)).toEqual(['x|y', 'z'])
	})

	it('parses a table without outer pipes', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, 'a | b\n- | -\n1 | 2'))
		expect(table.header.map(inlineText)).toEqual(['a', 'b'])
		expect(table.rows.map((row) => row.map(inlineText))).toEqual([['1', '2']])
	})

	it('parses a header-only table (no body rows)', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, '| a | b |\n| - | - |'))
		expect(table.header.map(inlineText)).toEqual(['a', 'b'])
		expect(table.rows).toEqual([])
	})

	it('parses a single-column table', () => {
		const parser = new MarkdownParser()
		const table = assertTableNode(firstBlock(parser, '| only |\n| - |\n| x |'))
		expect(table.header.map(inlineText)).toEqual(['only'])
		expect(table.rows.map((row) => row.map(inlineText))).toEqual([['x']])
	})

	it('does NOT form a table without a delimiter row (a lone pipe line is a paragraph)', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '| a | b |\njust text').element).toBe('paragraph')
	})
})

describe('MarkdownParser — fenced code blocks', () => {
	it('parses a ```lang block, preserving content verbatim and capturing the language', () => {
		const parser = new MarkdownParser()
		const block = assertCodeBlockNode(firstBlock(parser, '```ts\nconst x = *1*\nif (x) y()\n```'))
		expect(block.lang).toBe('ts')
		expect(block.code).toBe('const x = *1*\nif (x) y()')
	})

	it('omits the language when the fence has no info string', () => {
		const parser = new MarkdownParser()
		expect(assertCodeBlockNode(firstBlock(parser, '```\nplain\n```')).lang).toBeUndefined()
	})

	it('does not parse markdown inside a code block', () => {
		const parser = new MarkdownParser()
		const block = assertCodeBlockNode(firstBlock(parser, '```\n# not a heading\n- not a list\n```'))
		expect(block.code).toBe('# not a heading\n- not a list')
	})

	it('supports a ~~~ fence too', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '~~~\ncode\n~~~').element).toBe('codeBlock')
	})

	it('runs an unterminated fence to EOF, capturing all remaining lines as code', () => {
		const parser = new MarkdownParser()
		const block = assertCodeBlockNode(firstBlock(parser, '```ts\nline one\nline two'))
		expect(block.code).toBe('line one\nline two')
		expect(block.lang).toBe('ts')
	})

	it('closes on a longer closing-fence run than the opener', () => {
		const parser = new MarkdownParser()
		const block = assertCodeBlockNode(firstBlock(parser, '```\ncode\n`````'))
		expect(block.code).toBe('code')
	})

	it('closes on a closing fence with trailing whitespace', () => {
		const parser = new MarkdownParser()
		const block = assertCodeBlockNode(firstBlock(parser, '```\ncode\n```   '))
		expect(block.code).toBe('code')
	})

	it('does not close a backtick fence with a tilde run (and vice versa)', () => {
		const parser = new MarkdownParser()
		const backtickBlock = assertCodeBlockNode(firstBlock(parser, '```\ncode\n~~~\nmore'))
		expect(backtickBlock.code).toBe('code\n~~~\nmore')
		const tildeBlock = assertCodeBlockNode(firstBlock(parser, '~~~\ncode\n```\nmore'))
		expect(tildeBlock.code).toBe('code\n```\nmore')
	})
})

describe('MarkdownParser — thematic breaks', () => {
	it('parses ---, ***, ___ as a thematic break', () => {
		const parser = new MarkdownParser()
		for (const rule of ['---', '***', '___']) {
			expect(firstBlock(parser, rule).element).toBe('thematicBreak')
		}
	})

	it('parses a spaced thematic break variant (- - -)', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '- - -').element).toBe('thematicBreak')
	})

	it('a two-character run (--) is NOT a thematic break — parses as a paragraph', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '--').element).toBe('paragraph')
	})

	it('a single dash followed by a space is a list item, not a thematic break', () => {
		const parser = new MarkdownParser()
		expect(firstBlock(parser, '- item').element).toBe('list')
	})
})

describe('MarkdownParser — blockquotes', () => {
	it('parses > lines into a blockquote of nested blocks', () => {
		const parser = new MarkdownParser()
		expect(
			assertBlockquoteNode(firstBlock(parser, '> a quoted line\n> over two')).children[0]?.element,
		).toBe('paragraph')
	})

	it('joins multiple > lines into one paragraph inside the blockquote', () => {
		const parser = new MarkdownParser()
		const quote = assertBlockquoteNode(firstBlock(parser, '> line one\n> line two'))
		expect(inlineText(assertParagraphNode(quote.children[0]).children)).toBe('line one\nline two')
	})

	it('nests a heading inside a blockquote', () => {
		const parser = new MarkdownParser()
		expect(
			assertBlockquoteNode(firstBlock(parser, '> ## quoted heading')).children[0]?.element,
		).toBe('heading')
	})

	it('nests a blockquote two levels deep with correct AST shape', () => {
		const parser = new MarkdownParser()
		const outer = assertBlockquoteNode(firstBlock(parser, '> > inner text'))
		const inner = assertBlockquoteNode(outer.children[0] ?? { element: 'thematicBreak' })
		expect(inlineText(assertParagraphNode(inner.children[0]).children)).toBe('inner text')
	})

	it('nests a blockquote three levels deep with correct AST shape', () => {
		const parser = new MarkdownParser()
		const level1 = assertBlockquoteNode(firstBlock(parser, buildDeepQuoteInput(3, 'deep leaf')))
		const level2 = assertBlockquoteNode(level1.children[0] ?? { element: 'thematicBreak' })
		const level3 = assertBlockquoteNode(level2.children[0] ?? { element: 'thematicBreak' })
		expect(inlineText(assertParagraphNode(level3.children[0]).children)).toBe('deep leaf')
	})

	it('ends the blockquote when a line is no longer prefixed with >', () => {
		const parser = new MarkdownParser()
		const blocks = parser.parse('> quoted\nnot quoted').children
		expect(blocks.map((block) => block.element)).toEqual(['blockquote', 'paragraph'])
	})
})

describe('MarkdownParser — MAX_DEPTH recursion cap (block phase)', () => {
	it('degrades a blockquote nested past MAX_DEPTH to one literal paragraph', () => {
		const parser = new MarkdownParser()
		const document = parser.parse(buildDeepQuoteInput(100, 'too deep'))
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

	it('degrades a deeply indented nested list past MAX_DEPTH without throwing', () => {
		const parser = new MarkdownParser()
		expect(() => parser.parse(buildDeepListInput(200, 'leaf'))).not.toThrow()
	})
})

describe('MarkdownParser — total / malformed input never throws', () => {
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
			const parser = new MarkdownParser()
			expect(() => parser.render(parser.parse(markdown))).not.toThrow()
		})
	}

	it('parses a long emphasis-marker run quickly (linear-time, no ReDoS)', () => {
		const parser = new MarkdownParser()
		const start = Date.now()
		parser.parse('a'.repeat(20_000) + '*'.repeat(20_000))
		expect(Date.now() - start).toBeLessThan(1000)
	})

	it('parses a pathologically deep blockquote (10,000 levels) without throwing', () => {
		const parser = new MarkdownParser()
		let document: MarkdownDocument | undefined
		expect(() => {
			document = parser.parse(buildDeepQuoteInput(10_000))
		}).not.toThrow()
		expect(document?.children.length).toBeGreaterThanOrEqual(1)
	})

	it('parses a pathologically deep indented list (2,000 levels) without throwing', () => {
		const parser = new MarkdownParser()
		let document: MarkdownDocument | undefined
		expect(() => {
			document = parser.parse(buildDeepListInput(2_000))
		}).not.toThrow()
		expect(document?.children.length).toBeGreaterThanOrEqual(1)
	})

	it('parses a pathologically deep emphasis/link chain (10,000 levels) without throwing', () => {
		const parser = new MarkdownParser()
		let document: MarkdownDocument | undefined
		expect(() => {
			document = parser.parse(buildDeepEmphasisInput(10_000))
		}).not.toThrow()
		expect(document?.children.length).toBeGreaterThanOrEqual(1)
	})

	it('the real isMarkdownNode guard never throws on an adversarial deep block chain', () => {
		// buildDeepBlockNode returns `unknown` by design (an adversarial builder) — the
		// guard must stay total (never throw) on it. At extreme depth the guard's own
		// totality-containment MAY legitimately report `false` (not every unbounded
		// structural shape is guaranteed accepted) — that is acceptable; only a throw is
		// a failure. When the guard DOES accept the shape, render must also not throw.
		const hostile = buildDeepBlockNode(10_000)
		expect(() => isMarkdownNode(hostile)).not.toThrow()
		const parser = new MarkdownParser()
		expect(() => {
			if (isMarkdownNode(hostile)) parser.render(hostile)
			// else: guard rejected the extreme-depth chain — acceptable, render is skipped.
		}).not.toThrow()
	})
})

describe('MarkdownParser — parse (the block phase)', () => {
	it('dispatches each line to its block kind', () => {
		const parser = new MarkdownParser()
		const doc = parser.parse('# h\n\npara\n\n- item\n\n> quote')
		expect(doc.children.map((block) => block.element)).toEqual([
			'heading',
			'paragraph',
			'list',
			'blockquote',
		])
	})

	it('produces an empty document for blank-only input (total)', () => {
		const parser = new MarkdownParser()
		expect(parser.parse('\n\n  \n').children).toEqual([])
	})

	it('returns a MarkdownDocument whose children carries the parsed blocks', () => {
		const parser = new MarkdownParser()
		const document = parser.parse('# hi')
		expect(document.element).toBe('document')
		expect(document.children).toHaveLength(1)
	})
})

describe('MarkdownParser — parseInline (the inline phase)', () => {
	it('coalesces and parses a mixed inline run', () => {
		const parser = new MarkdownParser()
		const nodes = parser.parseInline('a **b** `c` [d](e)')
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

describe('MarkdownParser — MAX_DEPTH recursion cap (inline phase)', () => {
	it('scanInline at depth >= MAX_DEPTH yields a single literal text node covering the window', () => {
		const source = '*text with markup*'
		expect(scanInline(source, 0, source.length, 64)).toEqual([{ element: 'text', value: source }])
	})

	it('scanInline at depth >= MAX_DEPTH returns an empty array for an empty window', () => {
		expect(scanInline('', 0, 0, 64)).toEqual([])
	})

	it('a pathologically nested emphasis/link chain never throws and collapses well below its raw depth', () => {
		const parser = new MarkdownParser()
		const nodes = parser.parseInline(buildDeepEmphasisInput(200, 'leaf'))
		expect(nodes).toHaveLength(1)
	})

	it('a modest-depth (3-level) emphasis/link chain parses without throwing and keeps the leaf text', () => {
		const parser = new MarkdownParser()
		const nodes = parser.parseInline(buildDeepEmphasisInput(3, 'leaf'))
		expect(inlineText(nodes)).toContain('leaf')
	})
})

describe('MarkdownParser — render: structure', () => {
	it('renders headings, paragraphs, emphasis, code, and links to HTML', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('# Hi\n\nA **bold** `x` [link](https://x.dev).'))
		expect(html).toContain('<h1>Hi</h1>')
		expect(html).toContain('<strong>bold</strong>')
		expect(html).toContain('<code>x</code>')
		expect(html).toContain('<a href="https://x.dev">link</a>')
	})

	it('renders a list to <ul>/<ol> with <li> items', () => {
		const parser = new MarkdownParser()
		expect(parser.render(parser.parse('- a\n- b'))).toContain('<ul>')
		const ordered = parser.render(parser.parse('2. a\n3. b'))
		expect(ordered).toContain('<ol start="2">')
	})

	it('renders a GFM table with thead/tbody and per-column alignment', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('| a | b |\n| :- | -: |\n| 1 | 2 |'))
		expect(html).toContain('<table>')
		expect(html).toContain('<thead>')
		expect(html).toContain('<tbody>')
		expect(html).toContain('<th style="text-align:left">a</th>')
		expect(html).toContain('<td style="text-align:right">2</td>')
	})

	it('renders a fenced code block as <pre><code class="language-…">', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('```ts\nconst x = 1\n```'))
		expect(html).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
	})

	it('renders a thematic break as <hr> and a blockquote as <blockquote>', () => {
		const parser = new MarkdownParser()
		expect(parser.render(parser.parse('---'))).toBe('<hr>')
		expect(parser.render(parser.parse('> hi'))).toContain('<blockquote>')
	})
})

describe('MarkdownParser — render: escaping & sanitization (no XSS)', () => {
	it('HTML-escapes < > & " in text', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('a <script>alert("x" & 1)</script> tag'))
		expect(html).toContain('&lt;script&gt;')
		expect(html).toContain('&amp;')
		expect(html).toContain('&quot;')
		expect(html).not.toContain('<script>')
	})

	it('HTML-escapes the body of a code block and inline code', () => {
		const parser = new MarkdownParser()
		expect(parser.render(parser.parse('```\n<b>&</b>\n```'))).toContain('&lt;b&gt;&amp;&lt;/b&gt;')
		expect(parser.render(parser.parse('`<i>`'))).toContain('<code>&lt;i&gt;</code>')
	})

	it('drops a javascript: href to an empty attribute', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('[click](javascript:alert(1))'))
		expect(html).toContain('<a href="">click</a>')
		expect(html).not.toContain('javascript:')
	})

	it('drops other unsafe schemes (data:, vbscript:) and a control-char evasion', () => {
		const parser = new MarkdownParser()
		expect(parser.render(parser.parse('[x](data:text/html,evil)'))).toContain('href=""')
		expect(parser.render(parser.parse('[x](vbscript:msgbox)'))).toContain('href=""')
		// A tab between `java` and `script:` must not slip past the scheme check.
		expect(parser.render(parser.parse('[x](java\tscript:alert(1))'))).toContain('href=""')
	})

	it('drops a protocol-relative href (//host/path) to an empty attribute', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('[x](//evil.example/path)'))
		expect(html).toContain('href=""')
		expect(html).not.toContain('//evil.example')
	})

	it('keeps safe schemes (http/https/mailto) and relative/anchor hrefs', () => {
		const parser = new MarkdownParser()
		expect(parser.render(parser.parse('[a](https://x.dev)'))).toContain('href="https://x.dev"')
		expect(parser.render(parser.parse('[a](mailto:x@y.dev)'))).toContain('href="mailto:x@y.dev"')
		expect(parser.render(parser.parse('[a](#anchor)'))).toContain('href="#anchor"')
		expect(parser.render(parser.parse('[a](../guide.md)'))).toContain('href="../guide.md"')
	})

	it('attribute-escapes a quote inside an otherwise-safe href', () => {
		const parser = new MarkdownParser()
		const html = parser.render(parser.parse('[a](https://x.dev/"onmouseover=alert(1))'))
		expect(html).not.toContain('"onmouseover')
		expect(html).toContain('&quot;')
	})
})

describe('MarkdownParser — render: node-level', () => {
	it('renders an inline node tree to an escaped HTML fragment', () => {
		const parser = new MarkdownParser()
		const fragment = parser
			.parseInline('a **b** `<c>`')
			.map((node) => parser.render(node))
			.join('')
		expect(fragment).toBe('a <strong>b</strong> <code>&lt;c&gt;</code>')
	})

	it('renders a document node by joining its blocks with newlines', () => {
		const parser = new MarkdownParser()
		const html = parser.render({
			element: 'document',
			children: [
				{ element: 'thematicBreak' },
				{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] },
			],
		})
		expect(html).toBe('<hr>\n<p>x</p>')
	})

	it('renders exact HTML for a small composite inline snapshot', () => {
		const parser = new MarkdownParser()
		expect(parser.render(parser.parse('# Hi\n\n_em_ and `code`.'))).toBe(
			'<h1>Hi</h1>\n<p><em>em</em> and <code>code</code>.</p>',
		)
	})
})

describe('MarkdownParser — MAX_DEPTH recursion cap (render)', () => {
	it('renders a node at depth >= MAX_DEPTH as escaped value text, never recursing further', () => {
		const parser = new MarkdownParser()
		const textNode: TextNode = { element: 'text', value: '<x>' }
		expect(parser.render(textNode, 64)).toBe(escapeAmp(textNode.value))
	})

	it('renders a non-value node at depth >= MAX_DEPTH as an empty string', () => {
		const parser = new MarkdownParser()
		expect(parser.render({ element: 'thematicBreak' }, 64)).toBe('')
	})

	function escapeAmp(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	}
})

describe('MarkdownParser — line endings', () => {
	const markdown = '# Title\n\n- a\n- b\n\n> quote'

	it('parses CRLF input to the same AST as LF input', () => {
		const parser = new MarkdownParser()
		const crlf = markdown.replace(/\n/g, '\r\n')
		expect(parser.parse(crlf)).toEqual(parser.parse(markdown))
	})

	it('parses lone-CR input to the same AST as LF input', () => {
		const parser = new MarkdownParser()
		const cr = markdown.replace(/\n/g, '\r')
		expect(parser.parse(cr)).toEqual(parser.parse(markdown))
	})
})

describe('MarkdownParser — round-trip over a self-contained composite document', () => {
	// One inline fixture exercising every construct this parser supports, proving
	// it handles a realistic WHOLE document (not just one construct at a time)
	// and renders it to safe HTML — with NO disk reads.
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
	const parser = new MarkdownParser()
	const document = parser.parse(markdown)

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
		const heading = assertHeadingNode(firstBlock(parser, markdown))
		expect(heading.level).toBe(1)
		expect(inlineText(heading.children)).toBe('Title')
	})

	it('renders the whole document to safe HTML without throwing, emitting each construct', () => {
		let html = ''
		expect(() => {
			html = parser.render(document)
		}).not.toThrow()
		expect(html).toContain('<h1>Title</h1>')
		expect(html).toContain('<table>')
		expect(html).toContain('<pre><code class="language-ts">')
		expect(html).toContain('<blockquote>')
		expect(html).toContain('<a href="./guide.md">link</a>')
		// No raw angle bracket survives the renderer's escaping.
		expect(html).not.toContain('<script>')
	})
})

describe('MarkdownParser — stateless reuse', () => {
	it('produces identical output across repeated parses on one instance', () => {
		const parser = new MarkdownParser()
		const markdown = '# Title\n\n- a\n- b'
		expect(parser.render(parser.parse(markdown))).toBe(parser.render(parser.parse(markdown)))
	})
})
