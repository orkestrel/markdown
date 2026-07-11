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
	firstBlock,
	inlineText,
} from '../../setup.js'
import { MarkdownParser } from '@src/core'

// The markdown parser — terrain's zero-dependency, types-first markdown primitive.
// The AST is the contract: each construct (heading / paragraph / list / GFM table /
// fenced + inline code / link / emphasis / blockquote / thematic break) parses to the
// right discriminated node, and a SEPARATE renderer projects the AST to a safe HTML
// string (text + code HTML-escaped, link hrefs sanitized — no XSS). Pure + total:
// malformed markdown degrades to text, never throws. Driven entirely with plain inline
// strings — self-contained, no disk reads; the real project guides are dogfooded
// separately by the guides-parity suite (tests/guides). The AST narrowers are
// centralized in tests/setup.ts (AGENTS §16).

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

	it('leaves a bare [text] with no destination as literal text', () => {
		const parser = new MarkdownParser()
		expect(inlineText(parser.parseInline('a [bracketed] word'))).toBe('a [bracketed] word')
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

	it('nests a deeper-indented list inside its parent item', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '- parent\n  - child\n  - child2\n- sibling'))
		expect(list.items).toHaveLength(2)
		const nested = list.items[0]?.children.find((child) => child.element === 'list')
		expect(assertListNode(nested ?? { element: 'thematicBreak' }).items).toHaveLength(2)
	})

	it('carries each item content as inline text', () => {
		const parser = new MarkdownParser()
		const list = assertListNode(firstBlock(parser, '- a **bold** item'))
		expect(inlineText(assertParagraphNode(list.items[0]?.children[0]).children)).toBe('a bold item')
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

	it('reads per-column alignment from the delimiter row', () => {
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
})

describe('MarkdownParser — blockquotes and thematic breaks', () => {
	it('parses > lines into a blockquote of nested blocks', () => {
		const parser = new MarkdownParser()
		expect(
			assertBlockquoteNode(firstBlock(parser, '> a quoted line\n> over two')).children[0]?.element,
		).toBe('paragraph')
	})

	it('nests a heading inside a blockquote', () => {
		const parser = new MarkdownParser()
		expect(
			assertBlockquoteNode(firstBlock(parser, '> ## quoted heading')).children[0]?.element,
		).toBe('heading')
	})

	it('parses ---, ***, ___ as a thematic break', () => {
		const parser = new MarkdownParser()
		for (const rule of ['---', '***', '___']) {
			expect(firstBlock(parser, rule).element).toBe('thematicBreak')
		}
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
		'a\0b\uFFFF',
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
})

describe('MarkdownParser — round-trip over a self-contained composite document', () => {
	// One inline fixture exercising every construct the guides are built from, proving
	// the parser handles a realistic WHOLE document (not just one construct at a time)
	// and renders it to safe HTML — with NO disk reads. The real project guides are
	// dogfooded through this same parser by the guides-parity suite (tests/guides).
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
