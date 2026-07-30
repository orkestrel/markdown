import type { ElementNode, HTMLNode } from '@orkestrel/html'
import type {
	BlockNode,
	BlockquoteNode,
	InlineNode,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownNode,
	ParagraphNode,
	TableNode,
} from '@src/core'
import {
	MAX_DEPTH,
	coalesceText,
	extractFence,
	extractHeading,
	extractListItem,
	flattenText,
	foldNode,
	htmlToMarkdown,
	leadingIndent,
	markdownToHTML,
	mergeProjections,
	normalizeInlines,
	parseDocument,
	projectHTMLLeaf,
	projectHTMLNode,
	projectionToBlocks,
	projectionToInlines,
	renderHTML,
	renderMarkdown,
	rewriteDocument,
	scanCode,
	scanEmphasis,
	scanInline,
	scanLink,
	splitLines,
	splitTableRow,
	startsBlock,
	stripQuote,
	tableAlignments,
	trimInlines,
	unescapeText,
	walkNodes,
} from '@src/core'
import {
	HTML,
	SAFE_ATTRIBUTES,
	parseDocument as parseHTMLDocument,
	renderHTML as renderHTMLDocument,
} from '@orkestrel/html'
import {
	MARKDOWN_FIXPOINT_CORPUS,
	PROJECTION_CORPUS,
	assertTableNode,
	buildDeepEmphasisInput,
	buildProjection,
	firstBlock,
	projectHTML,
} from '../../setup'
import { describe, expect, expectTypeOf, it } from 'vitest'

// The markdown parser's pure helper surface (block extractors, inline scanners,
// escaping / sanitization primitives) plus the AST-level surface (renderHTML,
// renderMarkdown, walkNodes, foldNode, rewriteDocument, flattenText). Each is pure
// and total; malformed input degrades instead of throwing. parsers.test.ts covers
// the composed parse-behavior corpus. This suite mirrors every exported helpers.ts
// symbol (AGENTS §16).

describe('splitLines', () => {
	it('splits on \\n', () => {
		expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
	})

	it('normalizes CRLF and bare CR to \\n', () => {
		expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
	})

	it('normalizes mixed line endings in one document', () => {
		expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd'])
	})

	it('drops a single trailing-newline empty line but keeps interior blanks', () => {
		expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b'])
	})

	it('keeps multiple trailing blank lines except the very last', () => {
		expect(splitLines('a\n\n\n')).toEqual(['a', '', ''])
	})

	it('returns a single empty line for an empty string', () => {
		expect(splitLines('')).toEqual([''])
	})
})

describe('leadingIndent', () => {
	it('counts leading spaces and tabs', () => {
		expect(leadingIndent('   x')).toBe(3)
		expect(leadingIndent('\t\tx')).toBe(2)
		expect(leadingIndent('x')).toBe(0)
	})

	it('counts mixed spaces and tabs, stopping at the first non-whitespace', () => {
		expect(leadingIndent(' \t x')).toBe(3)
	})

	it('returns the full length for an all-whitespace line', () => {
		expect(leadingIndent('   ')).toBe(3)
	})

	it('returns 0 for an empty string', () => {
		expect(leadingIndent('')).toBe(0)
	})
})

describe('extractHeading', () => {
	it('extracts every level 1-6 with its level and text', () => {
		expect(extractHeading('# A')).toEqual({ level: 1, text: 'A' })
		expect(extractHeading('## A')).toEqual({ level: 2, text: 'A' })
		expect(extractHeading('### A')).toEqual({ level: 3, text: 'A' })
		expect(extractHeading('#### A')).toEqual({ level: 4, text: 'A' })
		expect(extractHeading('##### A')).toEqual({ level: 5, text: 'A' })
		expect(extractHeading('###### A')).toEqual({ level: 6, text: 'A' })
	})

	it('rejects a no-space #tag', () => {
		expect(extractHeading('#tag')).toBeUndefined()
	})

	it('rejects a run of 7+ #s', () => {
		expect(extractHeading('####### x')).toBeUndefined()
	})

	it('strips a closing ### run and trailing whitespace', () => {
		expect(extractHeading('## Title ##')).toEqual({ level: 2, text: 'Title' })
		expect(extractHeading('# Title   ')).toEqual({ level: 1, text: 'Title' })
	})

	it('yields empty text for a bare heading marker with no text', () => {
		expect(extractHeading('###')).toEqual({ level: 3, text: '' })
	})
})

describe('extractFence', () => {
	it('extracts a backtick fence and its language', () => {
		expect(extractFence('```ts')).toEqual({ marker: '```', lang: 'ts' })
		expect(extractFence('```')).toEqual({ marker: '```', lang: undefined })
		expect(extractFence('~~~js extra')).toEqual({ marker: '~~~', lang: 'js' })
	})

	it('accepts a tilde fence with no info string', () => {
		expect(extractFence('~~~')).toEqual({ marker: '~~~', lang: undefined })
	})

	it('accepts longer-than-minimum fence runs', () => {
		expect(extractFence('`````python')).toEqual({ marker: '`````', lang: 'python' })
		expect(extractFence('~~~~~~')).toEqual({ marker: '~~~~~~', lang: undefined })
	})

	it('takes only the first word of the info string as lang', () => {
		expect(extractFence('```ts extra stuff')).toEqual({ marker: '```', lang: 'ts' })
	})

	it('rejects a backtick fence whose info string contains a backtick', () => {
		expect(extractFence('```a`b')).toBeUndefined()
	})

	it('rejects a fence under the minimum length', () => {
		expect(extractFence('``')).toBeUndefined()
		expect(extractFence('~~')).toBeUndefined()
	})

	it('rejects a non-fence line', () => {
		expect(extractFence('plain')).toBeUndefined()
	})
})

describe('extractListItem', () => {
	it('extracts every bullet marker', () => {
		expect(extractListItem('- hello')).toMatchObject({
			ordered: false,
			start: 1,
			content: 'hello',
			indent: 0,
		})
		expect(extractListItem('* hello')).toMatchObject({ ordered: false, content: 'hello' })
		expect(extractListItem('+ hello')).toMatchObject({ ordered: false, content: 'hello' })
	})

	it('extracts an ordered item with N. and N)', () => {
		expect(extractListItem('3. third')).toMatchObject({ ordered: true, start: 3, content: 'third' })
		expect(extractListItem('1) one')).toMatchObject({ ordered: true, start: 1, content: 'one' })
	})

	it('parses ordered-item start values at the boundaries', () => {
		expect(extractListItem('1. x')?.start).toBe(1)
		expect(extractListItem('7. x')?.start).toBe(7)
		expect(extractListItem('999999999. x')?.start).toBe(999999999)
	})

	it('measures indent and marker width for a bullet', () => {
		const item = extractListItem('  - x')
		expect(item?.indent).toBe(2)
		expect(item?.marker).toBe(4)
	})

	it('measures indent and marker width for an ordered item', () => {
		const item = extractListItem('   1. x')
		expect(item?.indent).toBe(3)
		expect(item?.marker).toBe(6)
	})

	it('rejects a non-item line and a bullet with no following space', () => {
		expect(extractListItem('plain')).toBeUndefined()
		expect(extractListItem('-no-space')).toBeUndefined()
	})

	it('rejects an ordinal over 9 digits (outside \\d{1,9})', () => {
		expect(extractListItem('1234567890. x')).toBeUndefined()
	})
})

describe('stripQuote', () => {
	it('de-quotes a blockquote line, with or without the following space', () => {
		expect(stripQuote('> hi')).toBe('hi')
		expect(stripQuote('>hi')).toBe('hi')
	})

	it('strips up to 3 leading spaces before the marker', () => {
		expect(stripQuote('   > hi')).toBe('hi')
	})
})

describe('splitTableRow / tableAlignments', () => {
	it('splits cells and drops outer pipes (inner cell whitespace preserved)', () => {
		expect(splitTableRow('| a | b | c |')).toEqual([' a ', ' b ', ' c '])
		expect(splitTableRow('a | b')).toEqual(['a ', ' b'])
	})

	it('treats an escaped pipe as a literal, not a separator', () => {
		expect(splitTableRow('a \\| b | c')).toEqual(['a | b ', ' c'])
	})

	it('preserves empty cells', () => {
		expect(splitTableRow('| a || c |')).toEqual([' a ', '', ' c '])
	})

	it('handles a row with no outer pipes and no separators', () => {
		expect(splitTableRow('single')).toEqual(['single'])
	})

	it('derives per-column alignment (left / right / center / absence)', () => {
		expect(tableAlignments('| :- | :-: | -: | - |')).toEqual(['left', 'center', 'right', null])
	})
})

describe('startsBlock', () => {
	it('recognizes a heading line', () => {
		expect(startsBlock(['# Heading'], 0)).toBe(true)
	})

	it('recognizes a fence line', () => {
		expect(startsBlock(['```ts'], 0)).toBe(true)
	})

	it('recognizes a thematic break', () => {
		expect(startsBlock(['---'], 0)).toBe(true)
	})

	it('recognizes a blockquote line', () => {
		expect(startsBlock(['> quote'], 0)).toBe(true)
	})

	it('recognizes a list item line', () => {
		expect(startsBlock(['- item'], 0)).toBe(true)
	})

	it('recognizes a table start (header + delimiter row)', () => {
		expect(startsBlock(['a | b', '- | -'], 0)).toBe(true)
	})

	it('rejects a plain paragraph line', () => {
		expect(startsBlock(['plain paragraph'], 0)).toBe(false)
		expect(startsBlock(['just some text | not a table'], 0)).toBe(false)
	})
})

describe('unescapeText', () => {
	it('reduces escapable punctuation to its literal', () => {
		expect(unescapeText('a\\*b')).toBe('a*b')
		expect(unescapeText('a\\.b')).toBe('a.b')
	})

	it('leaves a non-escapable backslash sequence untouched', () => {
		expect(unescapeText('a\\zb')).toBe('a\\zb')
	})

	it('handles a trailing lone backslash', () => {
		expect(unescapeText('a\\')).toBe('a\\')
	})
})

describe('coalesceText', () => {
	it('merges adjacent text nodes', () => {
		expect(
			coalesceText([
				{ element: 'text', value: 'a' },
				{ element: 'text', value: 'b' },
			]),
		).toEqual([{ element: 'text', value: 'ab' }])
	})

	it('does not merge across a non-text node', () => {
		const nodes = coalesceText([
			{ element: 'text', value: 'a' },
			{ element: 'codeSpan', value: 'c' },
			{ element: 'text', value: 'b' },
		])
		expect(nodes).toHaveLength(3)
	})

	it('returns an empty array for an empty input', () => {
		expect(coalesceText([])).toEqual([])
	})
})

describe('scanCode', () => {
	it('reads a backtick span and trims one padding space on each side', () => {
		expect(scanCode('`x`', 0, 3)).toEqual({ value: 'x', end: 3 })
		expect(scanCode('` x `', 0, 5)).toEqual({ value: 'x', end: 5 })
	})

	it('supports multi-backtick runs and a span containing shorter backtick runs', () => {
		expect(scanCode('``a`b``', 0, 7)).toEqual({ value: 'a`b', end: 7 })
	})

	it('returns undefined for an unterminated span', () => {
		expect(scanCode('`open', 0, 5)).toBeUndefined()
	})

	it('does not strip padding when the span is not all-whitespace-bounded content', () => {
		expect(scanCode('` `', 0, 3)).toEqual({ value: ' ', end: 3 })
	})
})

describe('scanLink', () => {
	it('reads [text](href) and returns the node + end', () => {
		const link = scanLink('[a](b)', 0, 6)
		expect(link?.node.href).toBe('b')
		expect(link?.end).toBe(6)
	})

	it('handles nested brackets in the link text', () => {
		const link = scanLink('[a [b] c](x)', 0, 12)
		expect(link?.node.href).toBe('x')
		expect(link?.end).toBe(12)
	})

	it('handles escaped brackets/parens inside the link', () => {
		const link = scanLink('[a\\]b](c\\)d)', 0, 13)
		expect(link?.node.href).toBe('c)d')
	})

	it('returns undefined when there is no matching ) or (', () => {
		expect(scanLink('[a]', 0, 3)).toBeUndefined()
		expect(scanLink('[a](b', 0, 5)).toBeUndefined()
	})

	it('unescapes the href', () => {
		const link = scanLink('[a](b\\*c)', 0, 9)
		expect(link?.node.href).toBe('b*c')
	})
})

describe('scanEmphasis', () => {
	it('reads single * / _ as non-strong emphasis', () => {
		const em = scanEmphasis('*x*', 0, 3)
		expect(em?.node.strong).toBe(false)
		expect(em?.end).toBe(3)
		const under = scanEmphasis('_x_', 0, 3)
		expect(under?.node.strong).toBe(false)
	})

	it('reads doubled markers as strong emphasis', () => {
		const strong = scanEmphasis('**x**', 0, 5)
		expect(strong?.node.strong).toBe(true)
		expect(strong?.end).toBe(5)
	})

	it('rejects a space-flanked opener', () => {
		expect(scanEmphasis('* x*', 0, 4)).toBeUndefined()
	})

	it('returns undefined for an unterminated marker', () => {
		expect(scanEmphasis('*open', 0, 5)).toBeUndefined()
	})

	it('skips over a code span while scanning for the closer', () => {
		const em = scanEmphasis('*a`*`b*', 0, 7)
		expect(em?.node).toBeDefined()
	})
})

describe('scanInline', () => {
	it('emits literal text for an unmatched construct', () => {
		expect(scanInline('a*b', 0, 3)).toEqual([{ element: 'text', value: 'a*b' }])
	})

	it('flushes the pending text run when a real construct interrupts it', () => {
		expect(scanInline('a`c`', 0, 4)).toEqual([
			{ element: 'text', value: 'a' },
			{ element: 'codeSpan', value: 'c' },
		])
	})

	it('parses basic emphasis and strong constructs', () => {
		expect(scanInline('*a*', 0, 3)).toEqual([
			{ element: 'emphasis', strong: false, children: [{ element: 'text', value: 'a' }] },
		])
		expect(scanInline('**a**', 0, 5)).toEqual([
			{ element: 'emphasis', strong: true, children: [{ element: 'text', value: 'a' }] },
		])
	})

	it('parses a link into a link node', () => {
		expect(scanInline('[a](b)', 0, 6)).toEqual([
			{ element: 'link', href: 'b', children: [{ element: 'text', value: 'a' }] },
		])
	})

	it('resolves escapable backslash sequences within plain text runs', () => {
		expect(scanInline('a\\*b', 0, 4)).toEqual([{ element: 'text', value: 'a*b' }])
	})

	it('at depth >= MAX_DEPTH, returns a single literal text node covering the window without scanning markup', () => {
		const source = '*a*'
		expect(scanInline(source, 0, 3, MAX_DEPTH)).toEqual([{ element: 'text', value: '*a*' }])
		expect(scanInline(source, 0, 3, MAX_DEPTH + 5)).toEqual([{ element: 'text', value: '*a*' }])
	})

	it('at depth >= MAX_DEPTH with an empty window, returns no nodes', () => {
		expect(scanInline('abc', 1, 1, MAX_DEPTH)).toEqual([])
	})

	it('does not throw on a pathologically deep nested-emphasis/link source', () => {
		const source = buildDeepEmphasisInput(10000)
		expect(() => scanInline(source, 0, source.length)).not.toThrow()
	})
})

describe('markdownToHTML', () => {
	it('projects raw text and destinations without escaping or sanitizing', () => {
		expect(
			markdownToHTML({
				element: 'link',
				href: 'javascript:alert(1)&x="<',
				children: [{ element: 'text', value: `literal & < > " '` }],
			}),
		).toEqual({
			category: 'document',
			children: [
				{
					category: 'element',
					name: 'a',
					attributes: [{ name: 'href', value: 'javascript:alert(1)&x="<' }],
					children: [{ category: 'text', value: `literal & < > " '` }],
				},
			],
		})
	})

	it('wraps a bare text node in an HTML document', () => {
		expect(markdownToHTML({ element: 'text', value: 'bare' })).toEqual({
			category: 'document',
			children: [{ category: 'text', value: 'bare' }],
		})
	})
})

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

describe('renderMarkdown — canonical forms', () => {
	it('normalizes underscore emphasis to asterisks', () => {
		expect(renderMarkdown(parseDocument('_em_'))).toBe('*em*')
		expect(renderMarkdown(parseDocument('__strong__'))).toBe('**strong**')
	})

	it('renders list markers as - and N.', () => {
		expect(renderMarkdown(parseDocument('- a\n- b'))).toBe('- a\n- b')
		expect(renderMarkdown(parseDocument('2. a\n3. b'))).toBe('2. a\n3. b')
	})

	it('renders a thematic break as ---', () => {
		expect(renderMarkdown(parseDocument('***'))).toBe('---')
	})

	it('renders a fenced code block with a backtick fence', () => {
		expect(renderMarkdown(parseDocument('```ts\nconst x = 1\n```'))).toBe('```ts\nconst x = 1\n```')
	})

	it('renders an ATX heading with # repeated per level', () => {
		expect(renderMarkdown(parseDocument('### Title'))).toBe('### Title')
	})

	it('renders a blockquote with > -prefixed lines', () => {
		expect(renderMarkdown(parseDocument('> hi'))).toBe('> hi')
	})

	it('renders a table alignment row with :---/---:/:---: delimiters', () => {
		const markdown = renderMarkdown(
			parseDocument('| l | c | r |\n| :- | :-: | -: |\n| 1 | 2 | 3 |'),
		)
		expect(markdown).toContain('| :--- | :---: | ---: |')
	})

	it('renders a link as [text](href) with the raw href', () => {
		expect(renderMarkdown(parseDocument('[a](https://x.dev)'))).toBe('[a](https://x.dev)')
	})

	it('renders an image as ![alt](src)', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'image',
							src: 'x.png',
							children: [{ element: 'text', value: 'alt' }],
						},
					],
				},
			],
		}
		expect(renderMarkdown(document)).toBe('![alt](x.png)')
	})

	it('renders a hard break as exactly two spaces followed by a newline', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: 'first' },
						{ element: 'break' },
						{ element: 'text', value: 'second' },
					],
				},
			],
		}
		expect(renderMarkdown(document)).toBe('first  \nsecond')
	})

	it('escapes image destinations exactly like link destinations', () => {
		const link: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'link',
							href: 'a\\b(c)',
							children: [{ element: 'text', value: 'alt' }],
						},
					],
				},
			],
		}
		const image: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'image',
							src: 'a\\b(c)',
							children: [{ element: 'text', value: 'alt' }],
						},
					],
				},
			],
		}
		expect(renderMarkdown(image)).toBe(`!${renderMarkdown(link)}`)
	})

	it('backslash-escapes text specials that would otherwise re-parse as markup', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: '*[x]*' }] }],
		}
		const rendered = renderMarkdown(document)
		expect(rendered).toBe('\\*\\[x\\]\\*')
		expect(parseDocument(rendered)).toEqual(document)
	})
})

describe('renderMarkdown — round-trip (parse ∘ render = identity)', () => {
	const composite = [
		'# Title',
		'',
		'An intro with **bold**, _italic_, `code`, and a [link](./guide.md).',
		'prose with \\![not an image](x) stays text',
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

	it('round-trips a rich combined document (parse(render(doc)) deep-equals doc)', () => {
		const document = parseDocument(composite)
		expect(parseDocument(renderMarkdown(document))).toEqual(document)
	})

	for (const entry of MARKDOWN_FIXPOINT_CORPUS) {
		it(`alternates emphasis markers by nesting parity: ${entry.name}`, () => {
			const document = parseDocument(entry.source)
			const rendered = renderMarkdown(document)

			expect(rendered).toBe(entry.rendered)
			expect(parseDocument(rendered)).toEqual(document)
		})
	}

	it('round-trips the **b *c***-shaped tail nesting without delimiter collision', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'emphasis',
							strong: true,
							children: [
								{ element: 'text', value: 'b ' },
								{
									element: 'emphasis',
									strong: false,
									children: [{ element: 'text', value: 'c' }],
								},
							],
						},
					],
				},
			],
		}
		const rendered = renderMarkdown(document)

		expect(rendered).toBe('**b _c_**')
		expect(parseDocument(rendered)).toEqual(document)
	})

	it('round-trips the exact triple-nested HTML emphasis projection', () => {
		const projected = projectHTML('<em>x <em>a <strong>c</strong> b</em> y</em>')
		const rendered = renderMarkdown(projected)

		expect(rendered).toBe('*x _a **c** b_ y*')
		expect(parseDocument(rendered)).toEqual(projected)
	})

	it('escapes line-start dash and tilde runs that would become block syntax', () => {
		const dash = parseDocument('\\---')
		const tilde: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: '~~~' }] }],
		}
		const stars: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: '***' }] }],
		}

		expect(renderMarkdown(dash)).toBe('\\---')
		expect(parseDocument(renderMarkdown(dash))).toEqual(dash)
		expect(renderMarkdown(tilde)).toBe('\\~~~')
		expect(parseDocument(renderMarkdown(tilde))).toEqual(tilde)
		expect(renderMarkdown(stars)).toBe('\\*\\*\\*')
		expect(parseDocument(renderMarkdown(stars))).toEqual(stars)
	})

	it('keeps a table-first list item unambiguous', () => {
		const source = '- \n  | h |\n  | --- |\n  | x |'
		const document = parseDocument(source)
		const rendered = renderMarkdown(document)

		expect(rendered).toBe(source)
		expect(parseDocument(rendered)).toEqual(document)
	})

	it('round-trips awkward text carrying literal markup characters (* _ ` [ x ])', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'a * b _ c ` d [ e ] f' }] },
			],
		}
		expect(parseDocument(renderMarkdown(document))).toEqual(document)
	})

	it('round-trips images, hard breaks, and prose containing literal ![not an image]', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: 'before ' },
						{
							element: 'image',
							src: 'a\\b(c).png',
							children: [
								{ element: 'text', value: 'an ' },
								{
									element: 'emphasis',
									strong: false,
									children: [{ element: 'text', value: 'important' }],
								},
								{ element: 'text', value: ' image' },
							],
						},
						{ element: 'break' },
						{ element: 'text', value: 'literal ![not an image]' },
					],
				},
			],
		}
		const rendered = renderMarkdown(document)
		expect(rendered).toContain('literal !\\[not an image\\]')
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('escapes the image-adjacent bang in the exact parser-produced counterexample', () => {
		const source = 'prose with \\![not an image](x) stays text'
		const document = parseDocument(source)
		const rendered = renderMarkdown(document)
		expect(rendered).toBe(source)
		expect(parseDocument(rendered)).toEqual(document)
	})

	it('pins the bang adjacency matrix without unnecessary or double escaping', () => {
		const beforeImage: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: '!' },
						{
							element: 'image',
							src: 'x',
							children: [{ element: 'text', value: 'alt' }],
						},
					],
				},
			],
		}
		const atEnd: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: '!' }] }],
		}
		const midText: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: 'mid!text' },
						{
							element: 'link',
							href: 'x',
							children: [{ element: 'text', value: 'link' }],
						},
					],
				},
			],
		}
		const escaped: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: '\\!' },
						{
							element: 'link',
							href: 'x',
							children: [{ element: 'text', value: 'link' }],
						},
					],
				},
			],
		}

		expect(renderMarkdown(beforeImage)).toBe('!![alt](x)')
		expect(parseDocument(renderMarkdown(beforeImage))).toEqual(beforeImage)
		expect(renderMarkdown(atEnd)).toBe('!')
		expect(parseDocument(renderMarkdown(atEnd))).toEqual(atEnd)
		expect(renderMarkdown(midText)).toBe('mid!text[link](x)')
		expect(parseDocument(renderMarkdown(midText))).toEqual(midText)
		expect(renderMarkdown(escaped)).toBe(`${'\\'.repeat(3)}![link](x)`)
		expect(parseDocument(renderMarkdown(escaped))).toEqual(escaped)
		expect(renderMarkdown(parseDocument(renderMarkdown(escaped)))).toBe(renderMarkdown(escaped))
	})

	it('round-trips a hand-built text-ending-bang directly before a link', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: '!' },
						{
							element: 'link',
							href: 'x',
							children: [{ element: 'text', value: 'link' }],
						},
					],
				},
			],
		}
		const rendered = renderMarkdown(document)
		expect(rendered).toBe('\\![link](x)')
		expect(parseDocument(rendered)).toEqual(document)
	})

	it('round-trips a text line that starts with #, >, or 1. as literal text (not markup)', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: '# not a heading' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: '> not a quote' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: '1. not a list' }] },
			],
		}
		expect(parseDocument(renderMarkdown(document))).toEqual(document)
	})

	it('round-trips a table cell containing a literal pipe', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'table',
					header: [[{ element: 'text', value: 'a|b' }]],
					rows: [[[{ element: 'text', value: 'c|d' }]]],
					align: [null],
				},
			],
		}
		expect(parseDocument(renderMarkdown(document))).toEqual(document)
	})

	it('round-trips an absent table alignment through parse, render, and parse', () => {
		const source = '| a |\n| --- |'
		const document = parseDocument(source)
		const table = assertTableNode(firstBlock(source))

		expect(table.align).toEqual([null])
		const rendered = renderMarkdown(document)
		expect(rendered).toBe('| a |\n| --- |')
		expect(parseDocument(rendered)).toEqual(document)
	})

	it('round-trips inline code containing backticks', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'codeSpan', value: 'a`b' }] }],
		}
		expect(parseDocument(renderMarkdown(document))).toEqual(document)
	})

	it('round-trips a single-space code span without growing on reparse', () => {
		const document = parseDocument('` `')
		expect(document).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'codeSpan', value: ' ' }] }],
		})
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a multi-space code span without growing on reparse', () => {
		const document = parseDocument('`   `')
		expect(document).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'codeSpan', value: '   ' }] }],
		})
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a heading whose inline text ends in a `#` run', () => {
		const document = parseDocument('# foo \\#')
		const heading = document.children[0]
		expect(heading?.element === 'heading' ? flattenText(heading) : undefined).toBe('foo #')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a heading whose inline text is a single `#`', () => {
		const document = parseDocument('## #')
		const heading = document.children[0]
		expect(heading?.element === 'heading' ? flattenText(heading) : undefined).toBe('#')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a heading whose inline text is a `#` run', () => {
		const document = parseDocument('## ##')
		const heading = document.children[0]
		expect(heading?.element === 'heading' ? flattenText(heading) : undefined).toBe('##')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a heading with a word followed by a trailing `#` run', () => {
		const document = parseDocument('# a \\##')
		const heading = document.children[0]
		expect(heading?.element === 'heading' ? flattenText(heading) : undefined).toBe('a ##')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a link href containing an escaped closing paren', () => {
		const document = parseDocument('[x](a\\)b)')
		const paragraph = document.children[0]
		const link = paragraph?.element === 'paragraph' ? paragraph.children[0] : undefined
		expect(link?.element === 'link' ? link.href : undefined).toBe('a)b')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a link href containing an escaped opening paren', () => {
		const document = parseDocument('[x](a\\(b)')
		const paragraph = document.children[0]
		const link = paragraph?.element === 'paragraph' ? paragraph.children[0] : undefined
		expect(link?.element === 'link' ? link.href : undefined).toBe('a(b')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('round-trips a link href containing a literal backslash', () => {
		const document = parseDocument('[x](a\\qb)')
		const paragraph = document.children[0]
		const link = paragraph?.element === 'paragraph' ? paragraph.children[0] : undefined
		expect(link?.element === 'link' ? link.href : undefined).toBe('a\\qb')
		const rendered = renderMarkdown(document)
		expect(parseDocument(rendered)).toEqual(document)
		expect(renderMarkdown(parseDocument(rendered))).toBe(rendered)
	})

	it('is idempotent (rendering an already-canonical document twice yields the same source)', () => {
		const once = renderMarkdown(parseDocument(composite))
		const twice = renderMarkdown(parseDocument(once))
		expect(once).toBe(twice)
	})

	it('renders an empty document to the empty string', () => {
		expect(renderMarkdown({ element: 'document', children: [] })).toBe('')
	})

	it('does not throw on a fabricated deep AST (total)', () => {
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		let node: BlockquoteNode | ParagraphNode = leaf
		for (let level = 0; level < 200; level += 1) node = { element: 'blockquote', children: [node] }
		expect(() => renderMarkdown(node)).not.toThrow()
	})
})

describe('walkNodes', () => {
	it('yields the exact DFS pre-order sequence for a known document', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{ element: 'thematicBreak' },
				{
					element: 'heading',
					level: 1,
					children: [
						{ element: 'text', value: 'Hi' },
						{ element: 'emphasis', strong: false, children: [{ element: 'text', value: 'x' }] },
					],
				},
			],
		}
		const sequence = [...walkNodes(document)].map((node) => node.element)
		expect(sequence).toEqual(['document', 'thematicBreak', 'heading', 'text', 'emphasis', 'text'])
	})

	it('is root-inclusive (the first yielded node is the passed-in node itself)', () => {
		const node = firstBlock('hello')
		const [first] = [...walkNodes(node)]
		expect(first).toBe(node)
	})

	it('visits table cell inline nodes header-then-rows', () => {
		const table = firstBlock('| a | b |\n| - | - |\n| `c` | d |')
		const sequence = [...walkNodes(table)].map((node) => node.element)
		expect(sequence).toEqual(['table', 'text', 'text', 'codeSpan', 'text'])
	})

	it('descends through image alternative content and visits hard breaks as leaves', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'image',
							src: 'x.png',
							children: [
								{ element: 'emphasis', strong: false, children: [{ element: 'text', value: 'x' }] },
							],
						},
						{ element: 'break' },
					],
				},
			],
		}
		expect([...walkNodes(document)].map((node) => node.element)).toEqual([
			'document',
			'paragraph',
			'image',
			'emphasis',
			'text',
			'break',
		])
	})

	it('does not throw on a depth-capped deep block chain', () => {
		expect(() => [...walkNodes(firstBlock(buildDeepEmphasisInput(100_000)))]).not.toThrow()
	})
})

describe('foldNode', () => {
	const countHandlers: MarkdownHandlers<number> = {
		document: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		heading: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		paragraph: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		thematicBreak: () => 1,
		blockquote: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		codeBlock: () => 1,
		list: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		listItem: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		table: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		text: () => 1,
		emphasis: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		codeSpan: () => 1,
		break: () => 1,
		link: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
		image: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
	}

	it('folds image alternative children and counts hard breaks as leaves', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'image',
							src: 'x.png',
							children: [{ element: 'text', value: 'alt' }],
						},
						{ element: 'break' },
					],
				},
			],
		}
		expect(foldNode(document, countHandlers, 0)).toBe(5)
	})

	it('folds children-first (post-order) — a text-collecting fold sees leaves before their parent', () => {
		const order: string[] = []
		const handlers: MarkdownHandlers<string> = {
			document: (node) => {
				order.push(node.element)
				return node.element
			},
			heading: (node) => {
				order.push(node.element)
				return node.element
			},
			paragraph: (node) => {
				order.push(node.element)
				return node.element
			},
			thematicBreak: (node) => {
				order.push(node.element)
				return node.element
			},
			blockquote: (node) => {
				order.push(node.element)
				return node.element
			},
			codeBlock: (node) => {
				order.push(node.element)
				return node.element
			},
			list: (node) => {
				order.push(node.element)
				return node.element
			},
			listItem: (node) => {
				order.push(node.element)
				return node.element
			},
			table: (node) => {
				order.push(node.element)
				return node.element
			},
			text: (node) => {
				order.push(node.element)
				return node.element
			},
			emphasis: (node) => {
				order.push(node.element)
				return node.element
			},
			codeSpan: (node) => {
				order.push(node.element)
				return node.element
			},
			break: (node) => {
				order.push(node.element)
				return node.element
			},
			link: (node) => {
				order.push(node.element)
				return node.element
			},
			image: (node) => {
				order.push(node.element)
				return node.element
			},
		}
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		foldNode(document, handlers, 0)
		expect(order).toEqual(['text', 'paragraph', 'document'])
	})

	it('gives the table handler a flat header-then-rows list of folded cells', () => {
		const cells: string[] = []
		const table: TableNode = {
			element: 'table',
			header: [[{ element: 'text', value: 'h1' }], [{ element: 'text', value: 'h2' }]],
			rows: [[[{ element: 'text', value: 'r1c1' }], [{ element: 'text', value: 'r1c2' }]]],
			align: [null, null],
		}
		const textHandlers: MarkdownHandlers<string> = {
			document: (_, children) => children.join(''),
			heading: (_, children) => children.join(''),
			paragraph: (_, children) => children.join(''),
			thematicBreak: () => '',
			blockquote: (_, children) => children.join(''),
			codeBlock: () => '',
			list: (_, children) => children.join(''),
			listItem: (_, children) => children.join(''),
			table: (_, children) => {
				cells.push(...children)
				return children.join(',')
			},
			text: (node) => node.value,
			emphasis: (_, children) => children.join(''),
			codeSpan: (node) => node.value,
			break: () => '',
			link: (_, children) => children.join(''),
			image: (_, children) => children.join(''),
		}
		expect(foldNode(table, textHandlers, 0)).toBe('h1,h2,r1c1,r1c2')
		expect(cells).toEqual(['h1', 'h2', 'r1c1', 'r1c2'])
	})

	it('caps at MAX_DEPTH — the node at the cap folds with an empty children list', () => {
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		let node: BlockquoteNode | ParagraphNode = leaf
		for (let level = 0; level < 70; level += 1) node = { element: 'blockquote', children: [node] }
		expect(() => foldNode(node, countHandlers, 0)).not.toThrow()
		// Below MAX_DEPTH the fold recurses fully; count is bounded by MAX_DEPTH, never
		// unbounded by the full 70-level chain (proves the cap fired).
		expect(foldNode(node, countHandlers, 0)).toBeLessThanOrEqual(MAX_DEPTH + 1)
	})

	it('a count-fold total equals the walkNodes traversal length', () => {
		const document = parseDocument(
			'# Title\n\nAn intro with **bold**, `code`, and ![alt](x.png).  \nNext.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |',
		)
		expect(foldNode(document, countHandlers, 0)).toBe([...walkNodes(document)].length)
	})

	it('keeps every iterative AST engine total across a very wide document', () => {
		const blocks: BlockNode[] = []
		for (let index = 0; index < 150_000; index += 1) blocks.push({ element: 'thematicBreak' })
		const document: MarkdownDocument = { element: 'document', children: blocks }

		expect(() => renderHTML(document)).not.toThrow()
		expect(() => renderMarkdown(document)).not.toThrow()
		const walked = [...walkNodes(document)].length
		expect(walked).toBe(blocks.length + 1)
		expect(foldNode(document, countHandlers, 0)).toBe(blocks.length + 1)
		expect(rewriteDocument(document, (node) => node).children).toHaveLength(blocks.length)
		expect(flattenText(document)).toBe('')
	})

	it('keeps sparse adopted arrays isolated instead of consuming a sibling result', () => {
		const inlines: InlineNode[] = []
		inlines[1] = { element: 'text', value: 'b' }
		const blocks: BlockNode[] = [
			{ element: 'heading', level: 1, children: [{ element: 'text', value: 'a' }] },
		]
		blocks[2] = { element: 'paragraph', children: inlines }
		const document: MarkdownDocument = { element: 'document', children: blocks }

		expect(renderHTML(document)).toBe('<h1>a</h1><p>b</p>')
		expect(renderMarkdown(document)).toBe('# a\n\nb')
		expect([...walkNodes(document)].map((node) => node.element)).toEqual([
			'document',
			'heading',
			'text',
			'paragraph',
			'text',
		])
		expect(foldNode(document, countHandlers, 0)).toBe(5)
		const rewritten = rewriteDocument(document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		expect(renderHTML(rewritten)).toBe('<h1>A</h1><p>B</p>')
		expect(flattenText(document)).toBe('ab')
	})
})

describe('rewriteDocument', () => {
	it('rewrites bottom-up (children rewritten before the node they belong to)', () => {
		const order: string[] = []
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		rewriteDocument(document, (node) => {
			order.push(node.element)
			return node
		})
		expect(order).toEqual(['text', 'paragraph'])
	})

	it('never passes the document root to rewrite', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const seen: string[] = []
		rewriteDocument(document, (node) => {
			seen.push(node.element)
			return node
		})
		expect(seen).not.toContain('document')
	})

	it('never mutates the input document (copy-on-write)', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const snapshot = JSON.parse(JSON.stringify(document)) as unknown
		rewriteDocument(document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		expect(document).toEqual(snapshot)
	})

	it('reflects a text-value rewrite in the output', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const rewritten = rewriteDocument(document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		const paragraph = rewritten.children[0]
		expect(paragraph?.element === 'paragraph' ? flattenText(paragraph) : undefined).toBe('X')
	})

	it('rewrites image alternative children and preserves hard-break leaves', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'image',
							src: 'x.png',
							children: [{ element: 'text', value: 'alt' }],
						},
						{ element: 'break' },
					],
				},
			],
		}
		const rewritten = rewriteDocument(document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		expect(rewritten).toEqual({
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{
							element: 'image',
							src: 'x.png',
							children: [{ element: 'text', value: 'ALT' }],
						},
						{ element: 'break' },
					],
				},
			],
		})
	})

	it('caps descent at MAX_DEPTH — a subtree at the cap passes through unchanged, by reference', () => {
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		const chain: (BlockquoteNode | ParagraphNode)[] = [leaf]
		for (let level = 0; level < 100; level += 1) {
			const previous = chain[chain.length - 1]
			if (previous === undefined) continue
			chain.push({ element: 'blockquote', children: [previous] })
		}
		const top = chain[chain.length - 1]
		if (top === undefined) throw new Error('unreachable — chain always has 101 entries')
		const document: MarkdownDocument = { element: 'document', children: [top] }
		const rewrite = (node: MarkdownNode): MarkdownNode =>
			node.element === 'text' ? { element: 'text', value: 'X' } : node

		expect(() => rewriteDocument(document, rewrite)).not.toThrow()

		const rewritten = rewriteDocument(document, rewrite)
		let atCap: BlockNode | undefined = rewritten.children[0]
		for (let level = 0; level < MAX_DEPTH; level += 1) {
			if (atCap === undefined || atCap.element !== 'blockquote')
				throw new Error('unreachable — chain is a pure blockquote run down to the cap')
			atCap = atCap.children[0]
		}
		// The node AT the cap (and everything below it) is the SAME reference as the
		// original input — never rebuilt, `rewrite` never invoked on it.
		expect(atCap).toBe(chain[chain.length - 1 - MAX_DEPTH])
	})
})

describe('flattenText', () => {
	it('concatenates text + codeSpan + codeBlock content in order', () => {
		const paragraph: ParagraphNode = {
			element: 'paragraph',
			children: [
				{ element: 'text', value: 'a ' },
				{ element: 'codeSpan', value: 'b' },
			],
		}
		expect(flattenText(paragraph)).toBe('a b')
		expect(flattenText({ element: 'codeBlock', code: 'c' })).toBe('c')
	})

	it('flattens a heading', () => {
		expect(flattenText(firstBlock('# Hi **there**'))).toBe('Hi there')
	})

	it('flattens a paragraph with mixed inline content', () => {
		expect(flattenText(firstBlock('a **b** `c`'))).toBe('a b c')
	})

	it('flattens image alternative content and contributes nothing for hard breaks', () => {
		expect(flattenText(firstBlock('![alt](x.png)  \nNext.'))).toBe('altNext.')
	})

	it('flattens a table (header cells then row cells)', () => {
		const table = firstBlock('| a | b |\n| - | - |\n| 1 | 2 |')
		expect(flattenText(table)).toBe('ab12')
	})

	it('does not throw on a deeply nested parsed emphasis/link chain', () => {
		expect(() => flattenText(firstBlock(buildDeepEmphasisInput(10_000)))).not.toThrow()
	})
})

// ── HTML → markdown projection ────────────────────────────────────────────────
// `htmlToMarkdown` and the four pure leaves it folds with. The suites below cover
// one row of the element mapping each (with the observed projected AST), the
// adversarial inputs the fold must survive, and the round-trip anchor law
// `parseDocument(renderMarkdown(htmlToMarkdown(x)))` deep-equals `htmlToMarkdown(x)`
// over `PROJECTION_CORPUS`.

describe('trimInlines', () => {
	it('trims the leading whitespace of the first text node and the trailing of the last', () => {
		expect(
			trimInlines([
				{ element: 'text', value: '  a' },
				{ element: 'codeSpan', value: 'x' },
				{ element: 'text', value: 'b  ' },
			]),
		).toEqual([
			{ element: 'text', value: 'a' },
			{ element: 'codeSpan', value: 'x' },
			{ element: 'text', value: 'b' },
		])
	})

	it('drops an edge text node that trims away entirely', () => {
		expect(
			trimInlines([
				{ element: 'text', value: ' ' },
				{ element: 'codeSpan', value: 'x' },
				{ element: 'text', value: '\n' },
			]),
		).toEqual([{ element: 'codeSpan', value: 'x' }])
	})

	it('leaves a non-text edge node untouched and returns an empty run unchanged', () => {
		expect(trimInlines([{ element: 'break' }])).toEqual([{ element: 'break' }])
		expect(trimInlines([])).toEqual([])
	})
})

describe('normalizeInlines', () => {
	it('drops a leading and a trailing hard break', () => {
		expect(
			normalizeInlines(
				[{ element: 'break' }, { element: 'text', value: 'a' }, { element: 'break' }],
				true,
			),
		).toEqual([{ element: 'text', value: 'a' }])
	})

	it('collapses a run of hard breaks to one and strips the whitespace touching it', () => {
		expect(
			normalizeInlines(
				[
					{ element: 'text', value: 'a ' },
					{ element: 'break' },
					{ element: 'break' },
					{ element: 'text', value: ' b' },
				],
				true,
			),
		).toEqual([
			{ element: 'text', value: 'a' },
			{ element: 'break' },
			{ element: 'text', value: 'b' },
		])
	})

	it('replaces every hard break with a space when breaks are not allowed', () => {
		expect(
			normalizeInlines(
				[{ element: 'text', value: 'a' }, { element: 'break' }, { element: 'text', value: 'b' }],
				false,
			),
		).toEqual([{ element: 'text', value: 'a b' }])
	})

	it('coalesces adjacent text and drops empty text nodes', () => {
		expect(
			normalizeInlines(
				[
					{ element: 'text', value: 'a' },
					{ element: 'text', value: '' },
					{ element: 'text', value: 'b' },
				],
				true,
			),
		).toEqual([{ element: 'text', value: 'ab' }])
	})
})

describe('mergeProjections', () => {
	it('keeps a pure-inline run inline and coalesces it', () => {
		const merged = mergeProjections([
			buildProjection({ inlines: [{ element: 'text', value: 'a' }], text: 'a' }),
			buildProjection({ inlines: [{ element: 'text', value: 'b' }], text: 'b' }),
		])
		expect(merged.blocks).toEqual([])
		expect(merged.inlines).toEqual([{ element: 'text', value: 'ab' }])
		expect(merged.text).toBe('ab')
	})

	it('wraps an inline run into a paragraph IN ORDER once any child contributes a block', () => {
		const merged = mergeProjections([
			buildProjection({ blocks: [{ element: 'thematicBreak' }] }),
			buildProjection({ inlines: [{ element: 'text', value: 'tail' }] }),
		])
		expect(merged.blocks).toEqual([
			{ element: 'thematicBreak' },
			{ element: 'paragraph', children: [{ element: 'text', value: 'tail' }] },
		])
		expect(merged.inlines).toEqual([])
	})

	it('drops a whitespace-only run between two blocks', () => {
		const merged = mergeProjections([
			buildProjection({ blocks: [{ element: 'thematicBreak' }] }),
			buildProjection({ inlines: [{ element: 'text', value: '\n  ' }] }),
			buildProjection({ blocks: [{ element: 'thematicBreak' }] }),
		])
		expect(merged.blocks).toEqual([{ element: 'thematicBreak' }, { element: 'thematicBreak' }])
	})

	it('keeps direct cells as one row before later row projections', () => {
		const cell = { align: undefined, inlines: [] }
		const merged = mergeProjections([
			buildProjection({ cells: [cell] }),
			buildProjection({ rows: [[]] }),
		])
		expect(merged.cells).toEqual([])
		expect(merged.rows).toEqual([[cell], []])
	})
})

describe('projectionToBlocks', () => {
	it('wraps a bare inline run into one paragraph', () => {
		expect(
			projectionToBlocks(buildProjection({ inlines: [{ element: 'text', value: ' a ' }] })),
		).toEqual([{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] }])
	})

	it('produces nothing for a blank inline run', () => {
		expect(
			projectionToBlocks(buildProjection({ inlines: [{ element: 'text', value: '  ' }] })),
		).toEqual([])
	})

	it('unwraps a dangling row and a dangling cell into paragraphs', () => {
		const inlines: readonly InlineNode[] = [{ element: 'text', value: 'x' }]
		expect(
			projectionToBlocks(
				buildProjection({
					rows: [[{ align: undefined, inlines }]],
					cells: [{ align: undefined, inlines }],
				}),
			),
		).toEqual([
			{ element: 'paragraph', children: inlines },
			{ element: 'paragraph', children: inlines },
		])
	})
})

describe('projectionToInlines', () => {
	it('returns the inline run of a pure-inline projection', () => {
		expect(
			projectionToInlines(buildProjection({ inlines: [{ element: 'codeSpan', value: 'x' }] })),
		).toEqual([{ element: 'codeSpan', value: 'x' }])
	})

	it('flattens block content to one text node, joined by spaces', () => {
		expect(
			projectionToInlines(
				buildProjection({
					blocks: [
						{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] },
						{ element: 'paragraph', children: [{ element: 'text', value: 'b' }] },
					],
				}),
			),
		).toEqual([{ element: 'text', value: 'a b' }])
	})

	it('flattens block content that carries no text to nothing', () => {
		expect(
			projectionToInlines(buildProjection({ blocks: [{ element: 'thematicBreak' }] })),
		).toEqual([])
	})
})

describe('projectHTMLLeaf', () => {
	it('collapses a text leaf whitespace run to one space and keeps the raw value', () => {
		const projected = projectHTMLLeaf({ category: 'text', value: 'a\n  b' })
		expect(projected.inlines).toEqual([{ element: 'text', value: 'a b' }])
		expect(projected.text).toBe('a\n  b')
	})

	it('keeps a whitespace-only text leaf as the one space it stands for', () => {
		// The space between `<b>one</b>` and `<i>two</i>` is a word boundary, not decoration;
		// it is dropped later, only where a block context proves it cannot be written.
		expect(projectHTMLLeaf({ category: 'text', value: '   ' }).inlines).toEqual([
			{ element: 'text', value: ' ' },
		])
		expect(projectHTMLLeaf({ category: 'text', value: '' }).inlines).toEqual([])
	})

	it('projects a comment and a doctype to nothing at all', () => {
		expect(projectHTMLLeaf({ category: 'comment', value: ' note ' })).toEqual({
			blocks: [],
			inlines: [],
			text: '',
			cells: [],
			rows: [],
		})
		expect(projectHTMLLeaf({ category: 'doctype', name: 'html' }).text).toBe('')
	})
})

describe('projectHTMLNode', () => {
	it('merges the children of a document root', () => {
		expect(
			projectHTMLNode({ category: 'document', children: [] }, [
				buildProjection({ blocks: [{ element: 'thematicBreak' }] }),
			]).blocks,
		).toEqual([{ element: 'thematicBreak' }])
	})

	it('maps an element name to its markdown node', () => {
		expect(
			projectHTMLNode({ category: 'element', name: 'hr', attributes: [], children: [] }, []).blocks,
		).toEqual([{ element: 'thematicBreak' }])
	})

	it('unwraps an unknown element to its children projection', () => {
		const child = buildProjection({ inlines: [{ element: 'text', value: 'x' }], text: 'x' })
		expect(
			projectHTMLNode({ category: 'element', name: 'aside', attributes: [], children: [] }, [
				child,
			]),
		).toEqual(child)
	})
})

describe('htmlToMarkdown — element mapping', () => {
	it('projects a text node literally, never escaped', () => {
		expect(projectHTML('<p>a*b*c [x]</p>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'a*b*c [x]' }] }],
		})
	})

	it('projects h1–h6 to a heading at that level', () => {
		expect(projectHTML('<h3>Hi</h3>')).toEqual({
			element: 'document',
			children: [{ element: 'heading', level: 3, children: [{ element: 'text', value: 'Hi' }] }],
		})
		expect(projectHTML('<h6>x</h6>').children[0]?.element).toBe('heading')
	})

	it('projects p to a paragraph and drops a blank one', () => {
		expect(projectHTML('<p>text</p>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'text' }] }],
		})
		expect(projectHTML('<p>  </p>')).toEqual({ element: 'document', children: [] })
	})

	it('projects strong and b to strong emphasis, and empty emphasis to nothing', () => {
		expect(projectHTML('<p><b>bold</b></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{ element: 'emphasis', strong: true, children: [{ element: 'text', value: 'bold' }] },
			],
		})
		expect(projectHTML('<p><strong></strong>x</p>').children[0]).toEqual({
			element: 'paragraph',
			children: [{ element: 'text', value: 'x' }],
		})
	})

	it('projects em and i to ordinary emphasis, keeping the word boundary its padding carried', () => {
		expect(projectHTML('<p><i>soft</i></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{ element: 'emphasis', strong: false, children: [{ element: 'text', value: 'soft' }] },
			],
		})
		expect(projectHTML('<p>a<em> b </em>c</p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{ element: 'text', value: 'a ' },
				{ element: 'emphasis', strong: false, children: [{ element: 'text', value: 'b' }] },
				{ element: 'text', value: ' c' },
			],
		})
	})

	it('projects inline code to a code span, collapsing a newline run to one space', () => {
		expect(projectHTML('<p><code>a\n   b</code></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [{ element: 'codeSpan', value: 'a b' }],
		})
	})

	it('projects a pre whose first element child is a code element to a verbatim code block', () => {
		expect(projectHTML('<pre><code>  a\n  b\n</code></pre>')).toEqual({
			element: 'document',
			children: [{ element: 'codeBlock', code: '  a\n  b\n' }],
		})
	})

	it('reads the language from the first qualifying language- class token', () => {
		expect(projectHTML('<pre><code class="x language-ts y">a</code></pre>').children[0]).toEqual({
			element: 'codeBlock',
			lang: 'ts',
			code: 'a',
		})
		expect(
			projectHTML('<pre><code class="language- language-js">a</code></pre>').children[0],
		).toEqual({ element: 'codeBlock', lang: 'js', code: 'a' })
		expect(projectHTML('<pre><code class="language-">a</code></pre>').children[0]).toEqual({
			element: 'codeBlock',
			code: 'a',
		})
	})

	it('projects any other pre through renderText', () => {
		expect(projectHTML('<pre>plain  text\n  indented</pre>').children[0]).toEqual({
			element: 'codeBlock',
			code: 'plain  text\n  indented',
		})
	})

	it('projects a to a link with a sanitized destination', () => {
		expect(projectHTML('<p><a href="/guide">read</a></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{ element: 'link', href: '/guide', children: [{ element: 'text', value: 'read' }] },
			],
		})
	})

	it('keeps the link and empties the destination when the URL is refused', () => {
		expect(projectHTML('<p><a href="javascript:alert(1)">read</a></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [{ element: 'link', href: '', children: [{ element: 'text', value: 'read' }] }],
		})
	})

	it('projects img to an image whose alt becomes a single text child', () => {
		expect(projectHTML('<p><img src="x.png" alt="a shot"></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{ element: 'image', src: 'x.png', children: [{ element: 'text', value: 'a shot' }] },
			],
		})
	})

	it('keeps the image and empties src and alt when both are refused or absent', () => {
		expect(projectHTML('<p><img src="data:text/html,x" alt=""></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [{ element: 'image', src: '', children: [] }],
		})
	})

	it('projects br to a hard break', () => {
		expect(projectHTML('<p>a<br>b</p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{ element: 'text', value: 'a' },
				{ element: 'break' },
				{ element: 'text', value: 'b' },
			],
		})
	})

	it('projects hr to a thematic break', () => {
		expect(projectHTML('<hr>')).toEqual({
			element: 'document',
			children: [{ element: 'thematicBreak' }],
		})
	})

	it('projects blockquote, wrapping a bare inline run in a paragraph', () => {
		expect(projectHTML('<blockquote>quoted</blockquote>')).toEqual({
			element: 'document',
			children: [
				{
					element: 'blockquote',
					children: [{ element: 'paragraph', children: [{ element: 'text', value: 'quoted' }] }],
				},
			],
		})
	})

	it('projects a list item, wrapping inline-only content in a paragraph', () => {
		expect(projectHTML('<ul><li>a</li></ul>')).toEqual({
			element: 'document',
			children: [
				{
					element: 'list',
					ordered: false,
					start: 1,
					items: [
						{
							element: 'listItem',
							children: [{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] }],
						},
					],
				},
			],
		})
	})

	it('projects ol as ordered and parses start base-10, degrading a junk value to 1', () => {
		const ordered = projectHTML('<ol start="3"><li>a</li></ol>').children[0]
		expect(ordered?.element === 'list' ? [ordered.ordered, ordered.start] : []).toEqual([true, 3])
		const junk = projectHTML('<ol start="abc"><li>a</li></ol>').children[0]
		expect(junk?.element === 'list' ? junk.start : undefined).toBe(1)
		const negative = projectHTML('<ol start="-2"><li>a</li></ol>').children[0]
		expect(negative?.element === 'list' ? negative.start : undefined).toBe(1)
	})

	it('keeps an empty li as an empty item and drops a list with no items', () => {
		const list = projectHTML('<ul><li></li></ul>').children[0]
		expect(list).toEqual({
			element: 'list',
			ordered: false,
			start: 1,
			items: [{ element: 'listItem', children: [] }],
		})
		expect(projectHTML('<ul>   </ul>')).toEqual({ element: 'document', children: [] })
	})

	it('unwraps a standalone cell — td or th — to a paragraph', () => {
		expect(projectHTML('<td>x</td>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		})
		expect(projectHTML('<th>x</th>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		})
	})

	it('unwraps a standalone row to one paragraph per cell', () => {
		expect(projectHTML('<tr><td>a</td><th>b</th></tr>')).toEqual({
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: 'b' }] },
			],
		})
	})

	it('projects a table, taking the first th-bearing row as the header', () => {
		expect(
			projectHTML(
				'<table><tbody><tr><td>skip</td></tr><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
			).children[0],
		).toEqual({
			element: 'table',
			header: [[{ element: 'text', value: 'a' }], [{ element: 'text', value: 'b' }]],
			rows: [
				[[{ element: 'text', value: 'skip' }], []],
				[[{ element: 'text', value: '1' }], [{ element: 'text', value: '2' }]],
			],
			align: [null, null],
		})
	})

	it('pads a short body row and truncates a long one to the header width', () => {
		const table = projectHTML(
			'<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
		).children[0]
		expect(table?.element === 'table' ? table.rows : []).toEqual([
			[[{ element: 'text', value: '1' }], []],
			[[{ element: 'text', value: '1' }], [{ element: 'text', value: '2' }]],
		])
	})

	it('flattens block content inside a cell to inline text joined by spaces', () => {
		const table = projectHTML('<table><tr><td><p>a</p><p>b</p></td></tr></table>').children[0]
		expect(table?.element === 'table' ? table.header : []).toEqual([
			[{ element: 'text', value: 'a b' }],
		])
	})

	it('degrades a table with no rows, and one with no usable header, to its content', () => {
		expect(projectHTML('<table>plain</table>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'plain' }] }],
		})
		expect(projectHTML('<table><tr></tr></table>')).toEqual({ element: 'document', children: [] })
	})

	it('honours an align attribute only when it is exactly one of html TABLE_ALIGNMENTS', () => {
		const aligned = projectHTML(
			'<table><tr><th align=" LEFT ">a</th><th align="middle">b</th><th align="center">c</th></tr></table>',
		).children[0]
		expect(aligned?.element === 'table' ? aligned.align : []).toEqual(['left', null, 'center'])
	})

	it('drops an UNSAFE_ELEMENTS subtree whole, text included', () => {
		expect(projectHTML('<div><script>alert(1)</script><p>kept</p></div>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'kept' }] }],
		})
		expect(JSON.stringify(projectHTML('<style>.a{}</style><p>x</p>'))).not.toContain('.a{}')
	})

	it('unwraps an unknown element, keeping two block children two blocks', () => {
		expect(projectHTML('<section><p>a</p><p>b</p></section>')).toEqual({
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: 'b' }] },
			],
		})
		expect(projectHTML('<span>a</span><del>b</del>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'ab' }] }],
		})
	})

	it('keeps an unwrapped mixed run in source order', () => {
		expect(projectHTML('<div><p>a</p>tail</div>')).toEqual({
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: 'tail' }] },
			],
		})
		expect(projectHTML('<div>lead<p>a</p></div>')).toEqual({
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'lead' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] },
			],
		})
	})

	it('keeps a dangling cell at its exact source position among blocks', () => {
		expect(projectHTML('<div><td>a</td><p>b</p></div>')).toEqual({
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'a' }] },
				{ element: 'paragraph', children: [{ element: 'text', value: 'b' }] },
			],
		})
	})

	it('keeps a direct table cell before later tr-derived rows as a body row', () => {
		expect(projectHTML('<table><td>early</td><tr><th>h</th></tr></table>')).toEqual({
			element: 'document',
			children: [
				{
					element: 'table',
					header: [[{ element: 'text', value: 'h' }]],
					rows: [[[{ element: 'text', value: 'early' }]]],
					align: [null],
				},
			],
		})
	})

	it('keeps a direct table cell before every later tr-derived body row', () => {
		expect(
			projectHTML('<table><td>early</td><tr><td>middle</td></tr><tr><th>h</th></tr></table>'),
		).toEqual({
			element: 'document',
			children: [
				{
					element: 'table',
					header: [[{ element: 'text', value: 'h' }]],
					rows: [[[{ element: 'text', value: 'early' }]], [[{ element: 'text', value: 'middle' }]]],
					align: [null],
				},
			],
		})
	})

	it('treats a direct unrowed cell run as one body row', () => {
		expect(projectHTML('<table><td>a</td><th>b</th></table>')).toEqual({
			element: 'document',
			children: [
				{
					element: 'table',
					header: [[], []],
					rows: [[[{ element: 'text', value: 'a' }], [{ element: 'text', value: 'b' }]]],
					align: [null, null],
				},
			],
		})
	})

	it('projects a comment and a doctype to nothing', () => {
		expect(projectHTML('<!DOCTYPE html><!-- note --><p>x</p>')).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		})
	})

	it('wraps a top-level bare inline run in a paragraph', () => {
		expect(projectHTML('bare <em>text</em>')).toEqual({
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'text', value: 'bare ' },
						{ element: 'emphasis', strong: false, children: [{ element: 'text', value: 'text' }] },
					],
				},
			],
		})
	})

	it('projects nested emphasis as written', () => {
		// Nesting is projected faithfully; choosing markers that survive a re-parse is the
		// serializer's concern, not the projection's.
		expect(projectHTML('<p><em>a <strong>c</strong> b</em></p>').children[0]).toEqual({
			element: 'paragraph',
			children: [
				{
					element: 'emphasis',
					strong: false,
					children: [
						{ element: 'text', value: 'a ' },
						{ element: 'emphasis', strong: true, children: [{ element: 'text', value: 'c' }] },
						{ element: 'text', value: ' b' },
					],
				},
			],
		})
	})

	it('projects text that reads as a block marker as literal text', () => {
		expect(projectHTML('<p>---</p>').children[0]).toEqual({
			element: 'paragraph',
			children: [{ element: 'text', value: '---' }],
		})
		expect(projectHTML('<p># not a heading</p>').children[0]).toEqual({
			element: 'paragraph',
			children: [{ element: 'text', value: '# not a heading' }],
		})
	})

	it('projects a bare HTML node, not only a document', () => {
		const element: ElementNode = {
			category: 'element',
			name: 'h2',
			attributes: [],
			children: [{ category: 'text', value: 'bare' }],
		}
		expect(htmlToMarkdown(element)).toEqual({
			element: 'document',
			children: [{ element: 'heading', level: 2, children: [{ element: 'text', value: 'bare' }] }],
		})
		expect(htmlToMarkdown({ category: 'text', value: 'leaf' })).toEqual({
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'leaf' }] }],
		})
	})
})

describe('htmlToMarkdown — adversarial input', () => {
	it('is total on a cyclic HTML AST', () => {
		const children: HTMLNode[] = []
		const cyclic: ElementNode = { category: 'element', name: 'div', attributes: [], children }
		children.push(cyclic)
		expect(() => htmlToMarkdown(cyclic)).not.toThrow()
		expect(htmlToMarkdown(cyclic)).toEqual({ element: 'document', children: [] })
	})

	it('is total, and bounded, on nesting past the depth cap', () => {
		let node: HTMLNode = { category: 'text', value: 'leaf' }
		for (let level = 0; level < 200; level += 1) {
			node = { category: 'element', name: 'blockquote', attributes: [], children: [node] }
		}
		expect(() => htmlToMarkdown(node)).not.toThrow()
		const projected = htmlToMarkdown(node)
		let depth = 0
		let block: BlockNode | undefined = projected.children[0]
		while (block?.element === 'blockquote') {
			depth += 1
			block = block.children[0]
		}
		// The composed cap is html's, not markdown's: html's fold stops descending first,
		// so 200 levels of source project to a bounded chain (its cap plus the root and the
		// node folded AT the cap) — and the serializer, whose own cap is markdown's, stays
		// total over the result rather than agreeing with it.
		expect(depth).toBeGreaterThan(0)
		expect(depth).toBeLessThanOrEqual(MAX_DEPTH + 2)
		expect(() => parseDocument(renderMarkdown(projected))).not.toThrow()
	})

	it('is total on a very wide document', () => {
		const children: HTMLNode[] = []
		for (let index = 0; index < 20_000; index += 1) {
			children.push({ category: 'element', name: 'hr', attributes: [], children: [] })
		}
		expect(htmlToMarkdown({ category: 'document', children }).children).toHaveLength(20_000)
	})

	it('projects an empty document to an empty document', () => {
		expect(htmlToMarkdown({ category: 'document', children: [] })).toEqual({
			element: 'document',
			children: [],
		})
	})
})

describe('htmlToMarkdown — round-trip anchor law', () => {
	for (const entry of PROJECTION_CORPUS) {
		it(`re-parses its own rendered markdown identically: ${entry.name}`, () => {
			const projected = projectHTML(entry.html)
			expect(parseDocument(renderMarkdown(projected))).toEqual(projected)
		})
	}

	it('holds for the whole corpus rendered as one document', () => {
		const projected = projectHTML(PROJECTION_CORPUS.map((entry) => entry.html).join(''))
		expect(parseDocument(renderMarkdown(projected))).toEqual(projected)
	})
})

describe('htmlToMarkdown — the grand round trip', () => {
	it('carries alignment, an image, and a link through markdown → HTML → markdown', () => {
		const source =
			'# Title\n\n| Left | Right |\n| :--- | ---: |\n| ![shot](a.png) | [read](/guide) |'
		const projected = htmlToMarkdown(parseHTMLDocument(renderHTML(parseDocument(source))))
		expect(projected).toEqual(parseDocument(source))
		expect(renderMarkdown(projected)).toBe(source)
	})

	it('composes every refusal end to end for a hostile document', () => {
		const hostile =
			'<p><a href="javascript:alert(1)">click</a></p><p><img src="data:text/html,alert(1)" alt="shot"></p><script>alert(2)</script>'
		const projected = htmlToMarkdown(parseHTMLDocument(hostile))
		expect(projected).toEqual({
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'link', href: '', children: [{ element: 'text', value: 'click' }] },
					],
				},
				{
					element: 'paragraph',
					children: [{ element: 'image', src: '', children: [{ element: 'text', value: 'shot' }] }],
				},
			],
		})
		expect(renderMarkdown(projected)).toBe('[click]()\n\n![shot]()')
		// html's floor REMOVES a URL attribute it refuses rather than emptying it, so the
		// emptied destination does not even reach the output as an attribute.
		expect(renderHTML(projected)).toBe('<p><a>click</a></p><p><img alt="shot"></p>')
	})
})
