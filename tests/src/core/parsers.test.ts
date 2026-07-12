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
import { MAX_DEPTH, collectList, collectTable, parseBlocks, parseDocument, parseInline } from '@src/core'

// The markdown parser's parse-behavior surface — parseDocument (the block phase
// entry point), parseInline (the inline phase entry point), and their block-phase
// helpers parseBlocks / collectList / collectTable. The AST is the contract: each
// construct (heading / paragraph / list / GFM table / fenced + inline code / link /
// emphasis / blockquote / thematic break) parses to the right discriminated node.
// Pure + total: malformed markdown degrades to text, never throws, and a MAX_DEPTH
// recursion cap degrades pathologically deep input to a single literal node rather
// than exhausting the call stack. Render/HTML behavior lives in helpers.test.ts
// (renderHTML). The AST narrowers and deep-input builders are centralized in
// tests/setup.ts (AGENTS §16).

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
		expect(inlineText(block.element === 'paragraph' ? block.children : [])).toBe('line one\nline two')
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
		const cases: readonly { readonly markdown: string; readonly kinds: readonly string[] }[] = [
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
			expect(assertEmphasisNode(parseInline(`an ${marker}italic${marker} word`)[1]).strong).toBe(false)
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
		expect(assertCodeSpanNode(parseInline('use `const x = *1*` here')[1]).value).toBe('const x = *1*')
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
			list.items[0]?.children.find((child) => child.element === 'list') ?? { element: 'thematicBreak' },
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
		expect(list.items[0]?.children.map((child) => child.element)).toEqual(['paragraph', 'paragraph'])
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('para line')
		expect(inlineText(assertParagraphNode(list.items[0]?.children[1]).children)).toBe('more para')
	})

	it('gathers a lazy continuation line into the same item', () => {
		const list = assertListNode(firstBlock('- one\ncontinued'))
		expect(list.items).toHaveLength(1)
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('one\ncontinued')
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
		const table = assertTableNode(firstBlock('| l | c | r | n |\n| :- | :-: | -: | - |\n| 1 | 2 | 3 | 4 |'))
		expect(table.align).toEqual(['left', 'center', 'right', 'none'])
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
		expect(assertBlockquoteNode(firstBlock('> a quoted line\n> over two')).children[0]?.element).toBe(
			'paragraph',
		)
	})

	it('joins multiple > lines into one paragraph inside the blockquote', () => {
		const quote = assertBlockquoteNode(firstBlock('> line one\n> line two'))
		expect(inlineText(assertParagraphNode(quote.children[0]).children)).toBe('line one\nline two')
	})

	it('nests a heading inside a blockquote', () => {
		expect(assertBlockquoteNode(firstBlock('> ## quoted heading')).children[0]?.element).toBe('heading')
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
		expect(doc.children.map((block) => block.element)).toEqual(['heading', 'paragraph', 'list', 'blockquote'])
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
		expect(nodes.map((node) => node.element)).toEqual(['text', 'emphasis', 'text', 'codeSpan', 'text', 'link'])
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
		const blocks = parseBlocks(['# heading', 'plain'], MAX_DEPTH)
		expect(blocks).toHaveLength(1)
		expect(blocks[0]?.element).toBe('paragraph')
	})

	it('returns an empty array for empty input at depth MAX_DEPTH', () => {
		expect(parseBlocks([], MAX_DEPTH)).toEqual([])
	})

	it('parses normally below MAX_DEPTH', () => {
		const blocks = parseBlocks(['# h', 'para'], 0)
		expect(blocks.map((block) => block.element)).toEqual(['heading', 'paragraph'])
	})
})

describe('collectList', () => {
	it('collects a list slice, returning the node and the index after it', () => {
		const lines = ['- one', '- two', 'after']
		const { node, next } = collectList(lines, 0, 0)
		expect(node.element).toBe('list')
		expect(node.items).toHaveLength(2)
		expect(next).toBe(3)
	})

	it('collects an ordered list slice starting mid-array', () => {
		const lines = ['plain', '3. three', '4. four']
		const { node, next } = collectList(lines, 1, 0)
		expect(node.ordered).toBe(true)
		expect(node.start).toBe(3)
		expect(next).toBe(3)
	})
})

describe('collectTable', () => {
	it('collects a table slice, returning the node and the index after it', () => {
		const lines = ['| a | b |', '| - | - |', '| 1 | 2 |', 'after']
		const { node, next } = collectTable(lines, 0)
		expect(node.element).toBe('table')
		expect(node.header.map(inlineText)).toEqual(['a', 'b'])
		expect(next).toBe(3)
	})

	it('collects a header-only table with no body rows', () => {
		const lines = ['| a |', '| - |']
		const { node, next } = collectTable(lines, 0)
		expect(node.rows).toEqual([])
		expect(next).toBe(2)
	})
})
