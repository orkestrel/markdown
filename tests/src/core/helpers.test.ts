import {
	MAX_DEPTH,
	coalesceText,
	escapeHtml,
	extractFence,
	extractHeading,
	extractListItem,
	leadingIndent,
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
} from '@src/core'
import { buildDeepEmphasisInput } from '../../setup'
import { describe, expect, it } from 'vitest'

// The markdown parser's pure helper surface (block extractors, inline scanners, and
// escaping / sanitization primitives). Each is pure and total; malformed input
// degrades instead of throwing. MarkdownParser.test.ts covers the composed parser
// behavior. This suite mirrors every exported helper.ts symbol (AGENTS §16).

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

	it('derives per-column alignment (left / right / center / none)', () => {
		expect(tableAlignments('| :- | :-: | -: | - |')).toEqual(['left', 'center', 'right', 'none'])
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
