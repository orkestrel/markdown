import type {
	BlockquoteNode,
	MarkdownDocument,
	MarkdownNode,
	ParagraphNode,
	TableNode,
} from '@src/core'
import { MAX_DEPTH, markdownToHTML, parseDocument, renderHTML } from '@src/core'
import { HTML, SAFE_ATTRIBUTES, renderHTML as renderHTMLDocument } from '@orkestrel/html'
import { buildDeepEmphasisInput, firstBlock } from '../../setup'
import { describe, expect, expectTypeOf, it } from 'vitest'

// The class-driving compiler surface: renderHTML composes helpers.ts's pure
// markdownToHTML projection with @orkestrel/html's HTML sanitizer and serializer.
// helpers.test.ts covers the pure projection itself; this suite covers the composed
// pipeline - structure, escaping and sanitization, the URL floor, and the depth cap.

describe('renderHTML — structure', () => {
	it('renders headings, paragraphs, emphasis, code, and links to HTML', () => {
		const html = renderHTML(parseDocument('# Hi\n\nA **bold** `x` [link](https://x.dev).'))
		expect(html).toContain('<h1>Hi</h1>')
		expect(html).toContain('<strong>bold</strong>')
		expect(html).toContain('<code>x</code>')
		expect(html).toContain('<a href="https://x.dev">link</a>')
	})

	it('renders a list to <ul>/<ol> with <li> items', () => {
		expect(renderHTML(parseDocument('- a\n- b'))).toBe('<ul><li>a</li><li>b</li></ul>')
		expect(renderHTML(parseDocument('2. a\n3. b'))).toBe('<ol start="2"><li>a</li><li>b</li></ol>')
	})

	it('renders a GFM table with thead/tbody and per-column alignment', () => {
		const html = renderHTML(parseDocument('| a | b |\n| :- | -: |\n| 1 | 2 |'))
		expect(html).toContain('<table>')
		expect(html).toContain('<thead>')
		expect(html).toContain('<tbody>')
		expect(html).toContain('<th align="left">a</th>')
		expect(html).toContain('<td align="right">2</td>')
	})

	it('renders a fenced code block as <pre><code class="language-…">', () => {
		const html = renderHTML(parseDocument('```ts\nconst x = 1\n```'))
		expect(html).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
	})

	it('renders a thematic break as <hr> and a blockquote as <blockquote>', () => {
		expect(renderHTML(parseDocument('---'))).toBe('<hr>')
		expect(renderHTML(parseDocument('> hi'))).toBe('<blockquote><p>hi</p></blockquote>')
	})

	it('renders an inline node tree to an escaped HTML fragment', () => {
		const fragment = parseDocument('a **b** `<c>`')
			.children.flatMap((block) => (block.element === 'paragraph' ? block.children : []))
			.map((node) => renderHTML(node))
			.join('')
		expect(fragment).toBe('a <strong>b</strong> <code>&lt;c&gt;</code>')
	})

	it('renders a document node in canonical compact form', () => {
		const html = renderHTML({
			element: 'document',
			children: [
				{ element: 'thematicBreak' },
				{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] },
			],
		})
		expect(html).toBe('<hr><p>x</p>')
	})

	it('renders exact HTML for a small composite inline snapshot', () => {
		expect(renderHTML(parseDocument('# Hi\n\n_em_ and `code`.'))).toBe(
			'<h1>Hi</h1><p><em>em</em> and <code>code</code>.</p>',
		)
	})
})

describe('renderHTML — escaping & sanitization (no XSS)', () => {
	it('HTML-escapes < > & in text while leaving quotes and apostrophes literal', () => {
		expect(renderHTML(parseDocument(`a <script>alert("x" & 'y')</script> tag`))).toBe(
			`<p>a &lt;script&gt;alert("x" &amp; 'y')&lt;/script&gt; tag</p>`,
		)
	})

	it('HTML-escapes the body of a code block and inline code', () => {
		expect(renderHTML(parseDocument('```\n<b>&</b>\n```'))).toContain('&lt;b&gt;&amp;&lt;/b&gt;')
		expect(renderHTML(parseDocument('`<i>`'))).toContain('<code>&lt;i&gt;</code>')
	})
})

describe('renderHTML — @orkestrel/html URL-floor composition', () => {
	it('refuses a tab-spliced javascript scheme', () => {
		expect(renderHTML(parseDocument('[x](java\tscript:alert(1))'))).toBe('<p><a>x</a></p>')
	})

	it('preserves a mixed-case allowed HTTPS scheme', () => {
		expect(renderHTML(parseDocument('[x](HtTpS://ok.dev)'))).toBe(
			'<p><a href="HtTpS://ok.dev">x</a></p>',
		)
	})

	it('refuses a protocol-relative double slash', () => {
		expect(renderHTML(parseDocument('[x](//evil.dev)'))).toBe('<p><a>x</a></p>')
	})

	it('retains a single leading backslash', () => {
		expect(renderHTML(parseDocument('[x](\\evil.dev)'))).toBe('<p><a href="\\evil.dev">x</a></p>')
	})

	it('retains an anchor', () => {
		expect(renderHTML(parseDocument('[x](#anchor)'))).toBe('<p><a href="#anchor">x</a></p>')
	})

	it('refuses an unlisted scheme through the allowlist composition', () => {
		expect(renderHTML(parseDocument('[x](ftp://host)'))).toBe('<p><a>x</a></p>')
	})

	it('refuses a decimal-entity-obfuscated javascript scheme after decoding', () => {
		expect(renderHTML(parseDocument('[x](&#106;avascript:x)'))).toBe('<p><a>x</a></p>')
	})

	it('normalizes an entity-obfuscated allowed scheme', () => {
		expect(renderHTML(parseDocument('[x](https&colon;&sol;&sol;ok.dev)'))).toBe(
			'<p><a href="https://ok.dev">x</a></p>',
		)
	})

	it('encodes an ampersand in a retained query exactly once', () => {
		expect(renderHTML(parseDocument('[x](?a=1&b=2)'))).toBe('<p><a href="?a=1&amp;b=2">x</a></p>')
	})

	it('exposes no sanitizer options and hard-refuses hostile link and image schemes', () => {
		expectTypeOf(renderHTML).parameters.toEqualTypeOf<[node: MarkdownNode]>()
		expect(renderHTML.length).toBe(1)
		expect(renderHTML(parseDocument('[x](javascript:unit) ![alt](data:unit)'))).toBe(
			'<p><a>x</a> <img alt="alt"></p>',
		)
	})

	it('sanitizes every hostile destination in a hand-built markdown document', () => {
		const hostile: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'link',
							href: 'javascript:alert(1)',
							children: [{ element: 'text', value: 'link' }],
						},
						{ element: 'text', value: ' ' },
						{
							element: 'image',
							src: 'da\u0000ta:text/html,alert(1)',
							children: [{ element: 'text', value: 'image' }],
						},
						{ element: 'text', value: ' ' },
						{
							element: 'link',
							href: '&#106;avascript:alert(2)',
							children: [{ element: 'text', value: 'entity' }],
						},
					],
				},
			],
		}

		expect(renderHTML(hostile)).toBe('<p><a>link</a> <img alt="image"> <a>entity</a></p>')
	})
})

describe('renderHTML — composed elements', () => {
	it('keeps and sanitizes a safe image source', () => {
		expect(renderHTML(parseDocument('![a **bold**](https://x.dev/a?x=1&y=2)'))).toBe(
			'<p><img src="https://x.dev/a?x=1&amp;y=2" alt="a bold"></p>',
		)
	})

	it('refuses a hostile image source while preserving plain-text alt content', () => {
		expect(renderHTML(parseDocument('![a **bold**](javascript:alert(1))'))).toBe(
			'<p><img alt="a bold"></p>',
		)
	})

	it('renders a hard break as a void br element', () => {
		expect(renderHTML(parseDocument('a  \nb'))).toBe('<p>a<br>b</p>')
	})

	it('renders table alignment on header and body cells and omits it for a null column', () => {
		expect(renderHTML(parseDocument('| a | b | c |\n| :--- | ---: | --- |\n| 1 | 2 | 3 |'))).toBe(
			'<table><thead><tr><th align="left">a</th><th align="right">b</th><th>c</th></tr></thead><tbody><tr><td align="left">1</td><td align="right">2</td><td>3</td></tr></tbody></table>',
		)
	})
})

describe('renderHTML — MAX_DEPTH recursion cap + degrade arms', () => {
	it('projects exactly 64 elements and degrades once before html sanitization', () => {
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		let node: BlockquoteNode | ParagraphNode = leaf
		for (let level = 0; level < 70; level += 1) node = { element: 'blockquote', children: [node] }
		const html = renderHTML(node)
		expect(html).toBe('<blockquote>'.repeat(MAX_DEPTH) + '</blockquote>'.repeat(MAX_DEPTH))
		const sanitized = new HTML(markdownToHTML(node)).sanitize({
			attributes: [...SAFE_ATTRIBUTES, 'src'],
		})
		expect(sanitized.sanitize({ attributes: [...SAFE_ATTRIBUTES, 'src'] }).document).toEqual(
			sanitized.document,
		)
		expect(renderHTMLDocument(sanitized.document)).toBe(html)
	})

	it('renders a fabricated node with an unknown element as an empty string (total default arm)', () => {
		// A minimal, deliberately-loose type predicate (no `as`) that lets a
		// structurally-invalid node reach `renderHTML` directly, bypassing the strict
		// `isMarkdownNode` guard — exercising the switch's default arm. Narrowing happens
		// through the helper's return type (never a conditional `expect`).
		function isFabricatedNode(value: unknown): value is MarkdownDocument {
			return typeof value === 'object' && value !== null
		}
		function narrow<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T {
			if (!guard(value)) throw new Error('fixture did not match the expected fabricated shape')
			return value
		}
		const fabricated = narrow({ element: 'bogus' }, isFabricatedNode)
		expect(renderHTML(fabricated)).toBe('')
	})

	it('renders a fabricated TableNode with an out-of-set align without injecting a style attribute', () => {
		function isFabricatedTable(value: unknown): value is TableNode {
			return typeof value === 'object' && value !== null
		}
		function narrow<T>(value: unknown, guard: (candidate: unknown) => candidate is T): T {
			if (!guard(value)) throw new Error('fixture did not match the expected fabricated shape')
			return value
		}
		const fabricated = narrow(
			{
				element: 'table',
				header: [[{ element: 'text', value: 'a' }]],
				rows: [],
				align: ['"onmouseover=alert(1) style="text-align:center'],
			},
			isFabricatedTable,
		)
		const html = renderHTML(fabricated)
		expect(html).not.toContain('style=')
		expect(html).not.toContain('onmouseover')
	})

	it('does not throw rendering a deeply nested parsed emphasis/link chain', () => {
		expect(() => renderHTML(firstBlock(buildDeepEmphasisInput(10_000)))).not.toThrow()
	})
})
