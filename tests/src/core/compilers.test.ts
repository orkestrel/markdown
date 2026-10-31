import type { BlockquoteNode, MarkdownDocument, MarkdownNode, ParagraphNode } from '@src/core'
import { isFabricatedNode, isFabricatedTable, narrowFixture } from '../../setup.js'
import { markdownToHTML, parseMarkdown, renderMarkdownHTML } from '@src/core'
import { HTML, MAX_DEPTH, SAFE_ATTRIBUTES, renderHTML as renderHTMLDocument } from '@orkestrel/html'
import { buildDeepEmphasisInput, firstBlock } from '../../setup'
import { describe, expect, expectTypeOf, it } from 'vitest'

// The class-driving compiler surface: renderMarkdownHTML composes helpers.ts's pure
// markdownToHTML projection with @orkestrel/html's HTML sanitizer and serializer.
// helpers.test.ts covers the pure projection itself; this suite covers the composed
// pipeline - structure, escaping and sanitization, the URL floor, and the depth cap.

describe('renderMarkdownHTML — structure', () => {
	it('renders headings, paragraphs, emphasis, code, and links to HTML', () => {
		const html = renderMarkdownHTML(parseMarkdown('# Hi\n\nA **bold** `x` [link](https://x.dev).'))
		expect(html).toContain('<h1>Hi</h1>')
		expect(html).toContain('<strong>bold</strong>')
		expect(html).toContain('<code>x</code>')
		expect(html).toContain('<a href="https://x.dev">link</a>')
	})

	it('renders a list to <ul>/<ol> with <li> items', () => {
		expect(renderMarkdownHTML(parseMarkdown('- a\n- b'))).toBe('<ul><li>a</li><li>b</li></ul>')
		expect(renderMarkdownHTML(parseMarkdown('2. a\n3. b'))).toBe(
			'<ol start="2"><li>a</li><li>b</li></ol>',
		)
	})

	it('renders a GFM table with thead/tbody and per-column alignment', () => {
		const html = renderMarkdownHTML(parseMarkdown('| a | b |\n| :- | -: |\n| 1 | 2 |'))
		expect(html).toContain('<table>')
		expect(html).toContain('<thead>')
		expect(html).toContain('<tbody>')
		expect(html).toContain('<th align="left">a</th>')
		expect(html).toContain('<td align="right">2</td>')
	})

	it('renders a fenced code block as <pre><code class="language-…">', () => {
		const html = renderMarkdownHTML(parseMarkdown('```ts\nconst x = 1\n```'))
		expect(html).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
	})

	it('renders a thematic break as <hr> and a blockquote as <blockquote>', () => {
		expect(renderMarkdownHTML(parseMarkdown('---'))).toBe('<hr>')
		expect(renderMarkdownHTML(parseMarkdown('> hi'))).toBe('<blockquote><p>hi</p></blockquote>')
	})

	it('renders an inline node tree to an escaped HTML fragment', () => {
		const fragment = parseMarkdown('a **b** `<c>`')
			.children.flatMap((block) => (block.element === 'paragraph' ? block.children : []))
			.map((node) => renderMarkdownHTML(node))
			.join('')
		expect(fragment).toBe('a <strong>b</strong> <code>&lt;c&gt;</code>')
	})

	it('renders a document node in canonical compact form', () => {
		const html = renderMarkdownHTML({
			element: 'document',
			children: [
				{ element: 'thematicBreak' },
				{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] },
			],
		})
		expect(html).toBe('<hr><p>x</p>')
	})

	it('renders exact HTML for a small composite inline snapshot', () => {
		expect(renderMarkdownHTML(parseMarkdown('# Hi\n\n_em_ and `code`.'))).toBe(
			'<h1>Hi</h1><p><em>em</em> and <code>code</code>.</p>',
		)
	})
})

describe('renderMarkdownHTML — escaping & sanitization (no XSS)', () => {
	it('HTML-escapes < > & in text while leaving quotes and apostrophes literal', () => {
		expect(renderMarkdownHTML(parseMarkdown(`a <script>alert("x" & 'y')</script> tag`))).toBe(
			`<p>a &lt;script&gt;alert("x" &amp; 'y')&lt;/script&gt; tag</p>`,
		)
	})

	it('HTML-escapes the body of a code block and inline code', () => {
		expect(renderMarkdownHTML(parseMarkdown('```\n<b>&</b>\n```'))).toContain(
			'&lt;b&gt;&amp;&lt;/b&gt;',
		)
		expect(renderMarkdownHTML(parseMarkdown('`<i>`'))).toContain('<code>&lt;i&gt;</code>')
	})
})

describe('renderMarkdownHTML — @orkestrel/html URL-floor composition', () => {
	it('refuses a tab-spliced javascript scheme', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](java\tscript:alert(1))'))).toBe('<p><a>x</a></p>')
	})

	it('preserves a mixed-case allowed HTTPS scheme', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](HtTpS://ok.dev)'))).toBe(
			'<p><a href="HtTpS://ok.dev">x</a></p>',
		)
	})

	it('refuses a protocol-relative double slash', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](//evil.dev)'))).toBe('<p><a>x</a></p>')
	})

	it('retains a single leading backslash', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](\\evil.dev)'))).toBe(
			'<p><a href="\\evil.dev">x</a></p>',
		)
	})

	it('retains an anchor', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](#anchor)'))).toBe('<p><a href="#anchor">x</a></p>')
	})

	it('refuses an unlisted scheme through the allowlist composition', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](ftp://host)'))).toBe('<p><a>x</a></p>')
	})

	it('refuses a decimal-entity-obfuscated javascript scheme after decoding', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](&#106;avascript:x)'))).toBe('<p><a>x</a></p>')
	})

	it('normalizes an entity-obfuscated allowed scheme', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](https&colon;&sol;&sol;ok.dev)'))).toBe(
			'<p><a href="https://ok.dev">x</a></p>',
		)
	})

	it('encodes an ampersand in a retained query exactly once', () => {
		expect(renderMarkdownHTML(parseMarkdown('[x](?a=1&b=2)'))).toBe(
			'<p><a href="?a=1&amp;b=2">x</a></p>',
		)
	})

	it('exposes no sanitizer options and hard-refuses hostile link and image schemes', () => {
		expectTypeOf(renderMarkdownHTML).parameters.toEqualTypeOf<[node: MarkdownNode]>()
		expect(renderMarkdownHTML.length).toBe(1)
		expect(renderMarkdownHTML(parseMarkdown('[x](javascript:unit) ![alt](data:unit)'))).toBe(
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

		expect(renderMarkdownHTML(hostile)).toBe('<p><a>link</a> <img alt="image"> <a>entity</a></p>')
	})
})

describe('renderMarkdownHTML — composed elements', () => {
	it('keeps and sanitizes a safe image source', () => {
		expect(renderMarkdownHTML(parseMarkdown('![a **bold**](https://x.dev/a?x=1&y=2)'))).toBe(
			'<p><img src="https://x.dev/a?x=1&amp;y=2" alt="a bold"></p>',
		)
	})

	it('refuses a hostile image source while preserving plain-text alt content', () => {
		expect(renderMarkdownHTML(parseMarkdown('![a **bold**](javascript:alert(1))'))).toBe(
			'<p><img alt="a bold"></p>',
		)
	})

	it('renders a hard break as a void br element', () => {
		expect(renderMarkdownHTML(parseMarkdown('a  \nb'))).toBe('<p>a<br>b</p>')
	})

	it('renders table alignment on header and body cells and omits it for a null column', () => {
		expect(
			renderMarkdownHTML(parseMarkdown('| a | b | c |\n| :--- | ---: | --- |\n| 1 | 2 | 3 |')),
		).toBe(
			'<table><thead><tr><th align="left">a</th><th align="right">b</th><th>c</th></tr></thead><tbody><tr><td align="left">1</td><td align="right">2</td><td>3</td></tr></tbody></table>',
		)
	})
})

describe('renderMarkdownHTML — MAX_DEPTH recursion cap + degrade arms', () => {
	it('projects exactly 64 elements and degrades once before html sanitization', () => {
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		const node = Array.from({ length: 70 }).reduce<BlockquoteNode | ParagraphNode>(
			(child) => ({ element: 'blockquote', children: [child] }),
			leaf,
		)
		const html = renderMarkdownHTML(node)
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
		// structurally-invalid node reach `renderMarkdownHTML` directly, bypassing the strict
		// `isMarkdownNode` guard — exercising the switch's default arm. Narrowing happens
		// through the helper's return type (never a conditional `expect`).
		const fabricated = narrowFixture({ element: 'bogus' }, isFabricatedNode)
		expect(renderMarkdownHTML(fabricated)).toBe('')
	})

	it('renders a fabricated TableNode with an out-of-set align without injecting a style attribute', () => {
		const fabricated = narrowFixture(
			{
				element: 'table',
				header: [[{ element: 'text', value: 'a' }]],
				rows: [],
				align: ['"onmouseover=alert(1) style="text-align:center'],
			},
			isFabricatedTable,
		)
		const html = renderMarkdownHTML(fabricated)
		expect(html).not.toContain('style=')
		expect(html).not.toContain('onmouseover')
	})

	it('does not throw rendering a deeply nested parsed emphasis/link chain', () => {
		expect(() => renderMarkdownHTML(firstBlock(buildDeepEmphasisInput(10_000)))).not.toThrow()
	})
})
