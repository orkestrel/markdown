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
	SAFE_URL_SCHEMES,
	coalesceText,
	escapeHtml,
	extractFence,
	extractHeading,
	extractListItem,
	flattenText,
	foldNode,
	leadingIndent,
	parseDocument,
	renderHTML,
	renderMarkdown,
	rewriteDocument,
	sanitizeUrl,
	scanCode,
	scanEmphasis,
	scanInline,
	scanLink,
	splitLines,
	splitTableRow,
	startsBlock,
	stripQuote,
	tableAlignments,
	unescapeText,
	walkNodes,
} from '@src/core'
import {
	URL_SAFETY_GROUPS,
	buildDeepEmphasisInput,
	buildURLSafetyCorpus,
	assertTableNode,
	firstBlock,
} from '../../setup'
import { describe, expect, it } from 'vitest'

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

describe('escapeHtml', () => {
	it('escapes the five HTML-significant characters', () => {
		expect(escapeHtml('<a href="x" & \'q\'>')).toBe(
			'&lt;a href=&quot;x&quot; &amp; &#39;q&#39;&gt;',
		)
	})

	it('leaves ordinary text untouched', () => {
		expect(escapeHtml('plain text 123')).toBe('plain text 123')
	})

	it('double-escapes already-escaped text (not idempotent)', () => {
		const once = escapeHtml('<x>')
		expect(once).toBe('&lt;x&gt;')
		expect(escapeHtml(once)).toBe('&amp;lt;x&amp;gt;')
	})

	it('returns an empty string for an empty input', () => {
		expect(escapeHtml('')).toBe('')
	})
})

describe('sanitizeUrl', () => {
	describe('kept destinations', () => {
		it('keeps safe schemes', () => {
			expect(sanitizeUrl('http://x.dev')).toBe('http://x.dev')
			expect(sanitizeUrl('https://x.dev/a')).toBe('https://x.dev/a')
			expect(sanitizeUrl('mailto:a@b.dev')).toBe('mailto:a@b.dev')
			expect(sanitizeUrl('tel:+15551234567')).toBe('tel:+15551234567')
		})

		it('keeps relative paths', () => {
			expect(sanitizeUrl('./a')).toBe('./a')
			expect(sanitizeUrl('../a')).toBe('../a')
			expect(sanitizeUrl('a/b')).toBe('a/b')
		})

		it('keeps an anchor destination', () => {
			expect(sanitizeUrl('#anchor')).toBe('#anchor')
		})

		it('keeps a query-only destination', () => {
			expect(sanitizeUrl('?x')).toBe('?x')
		})

		it('keeps an empty string', () => {
			expect(sanitizeUrl('')).toBe('')
		})

		it('HTML-escapes a quote in an otherwise-safe url', () => {
			expect(sanitizeUrl('https://x.dev/"q')).toBe('https://x.dev/&quot;q')
		})

		it('is case-insensitive on the scheme (safe scheme in unusual case is kept)', () => {
			expect(sanitizeUrl('HTTPS://x.dev')).toBe('HTTPS://x.dev')
		})
	})

	describe('rejected destinations (dropped to empty string)', () => {
		it('drops javascript:, data:, vbscript:, file: schemes', () => {
			expect(sanitizeUrl('javascript:alert(1)')).toBe('')
			expect(sanitizeUrl('data:text/html,x')).toBe('')
			expect(sanitizeUrl('vbscript:x')).toBe('')
			expect(sanitizeUrl('file:///etc/passwd')).toBe('')
		})

		it('drops a mixed-case unsafe scheme', () => {
			expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBe('')
			expect(sanitizeUrl('JavaScript:alert(1)')).toBe('')
		})

		it('drops a scheme spoofed with an embedded tab or newline', () => {
			expect(sanitizeUrl('java\tscript:alert(1)')).toBe('')
			expect(sanitizeUrl('java\nscript:alert(1)')).toBe('')
			expect(sanitizeUrl('java\rscript:alert(1)')).toBe('')
		})

		it('drops a scheme spoofed with an embedded C0/C1 control codepoint', () => {
			expect(sanitizeUrl('javascript:alert(1)')).toBe('')
			expect(sanitizeUrl('javascript:alert(1)')).toBe('')
		})

		it('drops a protocol-relative destination', () => {
			expect(sanitizeUrl('//evil.com')).toBe('')
			expect(sanitizeUrl('//evil.com/path')).toBe('')
			expect(sanitizeUrl('//')).toBe('')
		})

		it('drops a protocol-relative destination spoofed via stripped whitespace', () => {
			expect(sanitizeUrl('/\t/evil.com')).toBe('')
		})

		it('drops backslash-variant protocol-relative destinations (browser-normalized)', () => {
			expect(sanitizeUrl('\\\\evil.com')).toBe('')
			expect(sanitizeUrl('/\\evil.com')).toBe('')
			expect(sanitizeUrl('\\/evil.com')).toBe('')
		})
	})

	describe('single leading slash/backslash (same-origin relative, kept)', () => {
		it('keeps a single leading backslash destination', () => {
			expect(sanitizeUrl('\\evil.com')).toBe('\\evil.com')
		})
	})
})

// The scheme/control floor `sanitizeUrl` enforces is re-implemented, deliberately, in
// `@orkestrel/html`'s `sanitizeURL` — one sanitizer per output context, no shared
// function (guides/src/markdown.md § Sanitization policy states why). What the two
// packages share instead is the corpus: `buildURLSafetyCorpus` is mirrored
// vector-for-vector, in the same order and under the same name, in `@orkestrel/html`'s
// `tests/setup.ts`, so a vector missed here is missed there too. The two packages'
// dispositions differ on exactly two groups, and each difference is a named test below
// rather than a quietly relaxed expectation.
describe('sanitizeUrl — mirrored URL-safety corpus (also in @orkestrel/html)', () => {
	it('disposes of every mirrored vector exactly as the corpus records', () => {
		for (const threat of buildURLSafetyCorpus()) {
			expect({ name: threat.name, value: sanitizeUrl(threat.source) }).toEqual({
				name: threat.name,
				value: threat.value ?? '',
			})
		}
	})

	it('covers every mirrored threat group', () => {
		const groups = [...new Set(buildURLSafetyCorpus().map((threat) => threat.group))]
		expect(groups).toEqual([...URL_SAFETY_GROUPS])
	})

	// Divergence 1 — escaping position. markdown escapes INSIDE `sanitizeUrl` because the
	// result is a finished `href` attribute value; `@orkestrel/html` returns the raw value
	// and encodes it later, in its own serializer. Escaping once (never twice) is the
	// claim: a double escape would publish a `&amp;amp;` a reader can see.
	it('escapes a surviving destination exactly once (@orkestrel/html escapes at serialization instead)', () => {
		const source = 'https://ok.dev/?a=1&b=2'
		expect(sanitizeUrl(source)).toBe(escapeHtml(source))
		expect(sanitizeUrl(source)).not.toBe(escapeHtml(escapeHtml(source)))
	})

	// Divergence 2 — the entity-decode pass. `@orkestrel/html` decodes character
	// references to a bounded fixpoint before reading the scheme, because its sanitized
	// value is re-serialized downstream and could decode to `javascript:` later. markdown
	// needs no decode pass precisely because it escapes here: the retained value reaches
	// the browser as literal text, with no `:` that begins a scheme, so it resolves as an
	// inert relative destination instead of executing.
	it('neutralizes an entity-encoded scheme by escaping it (@orkestrel/html refuses it outright)', () => {
		expect(sanitizeUrl('&#106;avascript:x')).toBe('&amp;#106;avascript:x')
		expect(sanitizeUrl('javascript&colon;x')).toBe('javascript&amp;colon;x')
		expect(sanitizeUrl('&sol;&sol;evil.dev')).toBe('&amp;sol;&amp;sol;evil.dev')
	})

	// Divergence 3 — allowlist shape. `SAFE_URL_SCHEMES` here is fixed and closed, so the
	// four dangerous schemes are refused BY the allowlist and a separate hard-ban list
	// would be dead code. `@orkestrel/html` takes its allowlist from the caller (its
	// `SanitizeOptions.schemes` REPLACES the default), so it also carries an unwidenable
	// refusal for `javascript` / `data` / `vbscript` / `file`. markdown cannot express that
	// input at all: `sanitizeUrl` accepts a destination and nothing else.
	it('refuses every dangerous scheme through one closed allowlist', () => {
		expect([...SAFE_URL_SCHEMES].sort()).toEqual(['http', 'https', 'mailto', 'tel'])
		for (const scheme of ['javascript', 'data', 'vbscript', 'file']) {
			expect(SAFE_URL_SCHEMES.has(scheme)).toBe(false)
			expect(sanitizeUrl(`${scheme}:payload`)).toBe('')
		}
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
		expect(renderHTML(parseDocument('- a\n- b'))).toContain('<ul>')
		const ordered = renderHTML(parseDocument('2. a\n3. b'))
		expect(ordered).toContain('<ol start="2">')
	})

	it('renders a GFM table with thead/tbody and per-column alignment', () => {
		const html = renderHTML(parseDocument('| a | b |\n| :- | -: |\n| 1 | 2 |'))
		expect(html).toContain('<table>')
		expect(html).toContain('<thead>')
		expect(html).toContain('<tbody>')
		expect(html).toContain('<th style="text-align:left">a</th>')
		expect(html).toContain('<td style="text-align:right">2</td>')
	})

	it('renders a fenced code block as <pre><code class="language-…">', () => {
		const html = renderHTML(parseDocument('```ts\nconst x = 1\n```'))
		expect(html).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
	})

	it('renders a thematic break as <hr> and a blockquote as <blockquote>', () => {
		expect(renderHTML(parseDocument('---'))).toBe('<hr>')
		expect(renderHTML(parseDocument('> hi'))).toContain('<blockquote>')
	})

	it('renders an inline node tree to an escaped HTML fragment', () => {
		const fragment = parseDocument('a **b** `<c>`')
			.children.flatMap((block) => (block.element === 'paragraph' ? block.children : []))
			.map((node) => renderHTML(node))
			.join('')
		expect(fragment).toBe('a <strong>b</strong> <code>&lt;c&gt;</code>')
	})

	it('renders a document node by joining its blocks with newlines', () => {
		const html = renderHTML({
			element: 'document',
			children: [
				{ element: 'thematicBreak' },
				{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] },
			],
		})
		expect(html).toBe('<hr>\n<p>x</p>')
	})

	it('renders exact HTML for a small composite inline snapshot', () => {
		expect(renderHTML(parseDocument('# Hi\n\n_em_ and `code`.'))).toBe(
			'<h1>Hi</h1>\n<p><em>em</em> and <code>code</code>.</p>',
		)
	})
})

describe('renderHTML — escaping & sanitization (no XSS)', () => {
	it('HTML-escapes < > & " in text', () => {
		const html = renderHTML(parseDocument('a <script>alert("x" & 1)</script> tag'))
		expect(html).toContain('&lt;script&gt;')
		expect(html).toContain('&amp;')
		expect(html).toContain('&quot;')
		expect(html).not.toContain('<script>')
	})

	it('HTML-escapes the body of a code block and inline code', () => {
		expect(renderHTML(parseDocument('```\n<b>&</b>\n```'))).toContain('&lt;b&gt;&amp;&lt;/b&gt;')
		expect(renderHTML(parseDocument('`<i>`'))).toContain('<code>&lt;i&gt;</code>')
	})

	it('drops a javascript: href to an empty attribute', () => {
		const html = renderHTML(parseDocument('[click](javascript:alert(1))'))
		expect(html).toContain('<a href="">click</a>')
		expect(html).not.toContain('javascript:')
	})

	it('drops other unsafe schemes (data:, vbscript:) and a control-char evasion', () => {
		expect(renderHTML(parseDocument('[x](data:text/html,evil)'))).toContain('href=""')
		expect(renderHTML(parseDocument('[x](vbscript:msgbox)'))).toContain('href=""')
		// A tab between `java` and `script:` must not slip past the scheme check.
		expect(renderHTML(parseDocument('[x](java\tscript:alert(1))'))).toContain('href=""')
	})

	it('drops a protocol-relative href (//host/path) to an empty attribute', () => {
		const html = renderHTML(parseDocument('[x](//evil.example/path)'))
		expect(html).toContain('href=""')
		expect(html).not.toContain('//evil.example')
	})

	it('keeps safe schemes (http/https/mailto) and relative/anchor hrefs', () => {
		expect(renderHTML(parseDocument('[a](https://x.dev)'))).toContain('href="https://x.dev"')
		expect(renderHTML(parseDocument('[a](mailto:x@y.dev)'))).toContain('href="mailto:x@y.dev"')
		expect(renderHTML(parseDocument('[a](#anchor)'))).toContain('href="#anchor"')
		expect(renderHTML(parseDocument('[a](../guide.md)'))).toContain('href="../guide.md"')
	})

	it('attribute-escapes a quote inside an otherwise-safe href', () => {
		const html = renderHTML(parseDocument('[a](https://x.dev/"onmouseover=alert(1))'))
		expect(html).not.toContain('"onmouseover')
		expect(html).toContain('&quot;')
	})

	it('drops backslash-variant protocol-relative hrefs to an empty attribute', () => {
		// Markdown backslash-escaping unescapes one level (`\\` → `\`) inside the link
		// destination before sanitizeUrl ever sees it, so each two-char prefix below
		// needs its backslashes doubled in the markdown SOURCE to survive as a single
		// backslash in the parsed href.
		expect(renderHTML(parseDocument('[x](\\\\\\\\evil.com)'))).toContain('href=""') // href: \\evil.com
		expect(renderHTML(parseDocument('[x](/\\\\evil.com)'))).toContain('href=""') // href: /\evil.com
		expect(renderHTML(parseDocument('[x](\\\\/evil.com)'))).toContain('href=""') // href: \/evil.com
	})

	it('keeps a single leading backslash href', () => {
		const html = renderHTML(parseDocument('[x](\\evil.com)'))
		expect(html).toContain('href="\\evil.com"')
	})
})

describe('renderHTML — MAX_DEPTH recursion cap + degrade arms', () => {
	it('caps render depth on a valid, deeply nested blockquote chain (~70 levels) without throwing', () => {
		const leaf: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'text', value: 'leaf' }],
		}
		let node: BlockquoteNode | ParagraphNode = leaf
		for (let level = 0; level < 70; level += 1) node = { element: 'blockquote', children: [node] }
		expect(() => renderHTML(node)).not.toThrow()
		const html = renderHTML(node)
		// Depth caps well before the innermost leaf, so the literal 'leaf' text never
		// reaches the rendered output.
		expect(html).not.toContain('leaf')
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

	it('round-trips awkward text carrying literal markup characters (* _ ` [ x ])', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [
				{ element: 'paragraph', children: [{ element: 'text', value: 'a * b _ c ` d [ e ] f' }] },
			],
		}
		expect(parseDocument(renderMarkdown(document))).toEqual(document)
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
		link: (_, children) => 1 + children.reduce((total, count) => total + count, 0),
	}

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
			link: (node) => {
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
			link: (_, children) => children.join(''),
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
			'# Title\n\nAn intro with **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |',
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

		expect(renderHTML(document)).toBe('<h1>a</h1>\n<p>b</p>')
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
		expect(renderHTML(rewritten)).toBe('<h1>A</h1>\n<p>B</p>')
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

	it('flattens a table (header cells then row cells)', () => {
		const table = firstBlock('| a | b |\n| - | - |\n| 1 | 2 |')
		expect(flattenText(table)).toBe('ab12')
	})

	it('does not throw on a deeply nested parsed emphasis/link chain', () => {
		expect(() => flattenText(firstBlock(buildDeepEmphasisInput(10_000)))).not.toThrow()
	})
})
