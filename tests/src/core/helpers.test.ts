import {
	coalesceText,
	escapeCSVCell,
	escapeHtml,
	extractFence,
	extractHeading,
	extractListItem,
	leadingIndent,
	sanitizeUrl,
	scanCode,
	scanCSVCell,
	scanEmphasis,
	scanInline,
	scanLink,
	serializeCSVRow,
	splitLines,
	splitTableRow,
	startsBlock,
	stripQuote,
	tableAlignments,
	unescapeText,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// The markdown parser's pure helper surface (block extractors, inline scanners, and
// escaping / sanitization primitives) plus the CSV leaves (the quote-aware cell
// scanner and the escaping / serialization pair). Each is pure and total; malformed
// input degrades instead of throwing. MarkdownParser.test.ts and CSVParser.test.ts
// cover the composed parser behavior.

describe('splitLines', () => {
	it('splits on \\n', () => {
		expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
	})

	it('normalizes CRLF and bare CR to \\n', () => {
		expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c'])
	})

	it('drops a single trailing-newline empty line but keeps interior blanks', () => {
		expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b'])
	})
})

describe('leadingIndent', () => {
	it('counts leading spaces and tabs', () => {
		expect(leadingIndent('   x')).toBe(3)
		expect(leadingIndent('\t\tx')).toBe(2)
		expect(leadingIndent('x')).toBe(0)
	})
})

describe('extractHeading', () => {
	it('extracts 1-6 #s with their level and text', () => {
		expect(extractHeading('### Title')).toEqual({ level: 3, text: 'Title' })
		expect(extractHeading('# A')).toEqual({ level: 1, text: 'A' })
	})

	it('rejects 7+ #s and a no-space #tag', () => {
		expect(extractHeading('####### x')).toBeUndefined()
		expect(extractHeading('#tag')).toBeUndefined()
	})

	it('strips a closing ### run', () => {
		expect(extractHeading('## Title ##')).toEqual({ level: 2, text: 'Title' })
	})
})

describe('extractFence', () => {
	it('extracts a backtick fence and its language', () => {
		expect(extractFence('```ts')).toEqual({ marker: '```', lang: 'ts' })
		expect(extractFence('```')).toEqual({ marker: '```', lang: undefined })
		expect(extractFence('~~~js extra')).toEqual({ marker: '~~~', lang: 'js' })
	})

	it('rejects a non-fence line', () => {
		expect(extractFence('``')).toBeUndefined()
		expect(extractFence('plain')).toBeUndefined()
	})
})

describe('extractListItem', () => {
	it('extracts a bullet item', () => {
		expect(extractListItem('- hello')).toMatchObject({
			ordered: false,
			start: 1,
			content: 'hello',
			indent: 0,
		})
	})

	it('extracts an ordered item with its ordinal', () => {
		expect(extractListItem('3. third')).toMatchObject({ ordered: true, start: 3, content: 'third' })
		expect(extractListItem('1) one')).toMatchObject({ ordered: true, start: 1, content: 'one' })
	})

	it('measures indent and marker width', () => {
		const item = extractListItem('  - x')
		expect(item?.indent).toBe(2)
		expect(item?.marker).toBe(4)
	})

	it('measures an indented ordered item the same way', () => {
		const item = extractListItem('   1. x')
		expect(item?.indent).toBe(3)
		expect(item?.marker).toBe(6)
	})

	it('rejects a non-item line', () => {
		expect(extractListItem('plain')).toBeUndefined()
		expect(extractListItem('-no-space')).toBeUndefined()
	})
})

describe('stripQuote', () => {
	it('de-quotes a blockquote line', () => {
		expect(stripQuote('> hi')).toBe('hi')
		expect(stripQuote('>hi')).toBe('hi')
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

	it('derives per-column alignment', () => {
		expect(tableAlignments('| :- | :-: | -: | - |')).toEqual(['left', 'center', 'right', 'none'])
	})
})

describe('startsBlock', () => {
	it('recognizes every block-start line kind and rejects a plain paragraph', () => {
		expect(startsBlock(['# Heading'], 0)).toBe(true)
		expect(startsBlock(['```ts'], 0)).toBe(true)
		expect(startsBlock(['> quote'], 0)).toBe(true)
		expect(startsBlock(['- item'], 0)).toBe(true)
		expect(startsBlock(['---'], 0)).toBe(true)
		expect(startsBlock(['a | b', '- | -'], 0)).toBe(true)
		expect(startsBlock(['plain paragraph'], 0)).toBe(false)
	})
})

describe('unescapeText', () => {
	it('reduces an escaped punctuation char to its literal', () => {
		expect(unescapeText('a\\*b')).toBe('a*b')
		expect(unescapeText('a\\.b')).toBe('a.b')
		expect(unescapeText('a\\zb')).toBe('a\\zb')
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
})

describe('scanCode / scanLink / scanEmphasis (inline sub-scanners)', () => {
	it('scanCode reads a backtick span and trims one padding space', () => {
		expect(scanCode('`x`', 0, 3)).toEqual({ value: 'x', end: 3 })
		expect(scanCode('` x `', 0, 5)).toEqual({ value: 'x', end: 5 })
		expect(scanCode('`open', 0, 5)).toBeUndefined()
	})

	it('scanLink reads [text](href) and returns the node + end', () => {
		const link = scanLink('[a](b)', 0, 6)
		expect(link?.node.href).toBe('b')
		expect(link?.end).toBe(6)
		expect(scanLink('[a]', 0, 3)).toBeUndefined()
	})

	it('scanEmphasis reads * / ** and rejects a space-flanked opener', () => {
		const em = scanEmphasis('*x*', 0, 3)
		expect(em?.node.strong).toBe(false)
		const strong = scanEmphasis('**x**', 0, 5)
		expect(strong?.node.strong).toBe(true)
		expect(scanEmphasis('* x*', 0, 4)).toBeUndefined()
		expect(scanEmphasis('*open', 0, 5)).toBeUndefined()
	})

	it('scanInline emits literal text for an unmatched construct', () => {
		expect(scanInline('a*b', 0, 3)).toEqual([{ element: 'text', value: 'a*b' }])
	})

	it('scanInline flushes the pending run when a real construct interrupts it', () => {
		expect(scanInline('a`c`', 0, 4)).toEqual([
			{ element: 'text', value: 'a' },
			{ element: 'codeSpan', value: 'c' },
		])
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
})

describe('sanitizeUrl', () => {
	it('keeps safe schemes and relative / anchor destinations', () => {
		expect(sanitizeUrl('https://x.dev/a')).toBe('https://x.dev/a')
		expect(sanitizeUrl('mailto:a@b.dev')).toBe('mailto:a@b.dev')
		expect(sanitizeUrl('./guide.md')).toBe('./guide.md')
		expect(sanitizeUrl('#anchor')).toBe('#anchor')
	})

	it('drops an unsafe scheme to an empty string', () => {
		expect(sanitizeUrl('javascript:alert(1)')).toBe('')
		expect(sanitizeUrl('data:text/html,x')).toBe('')
		expect(sanitizeUrl('vbscript:x')).toBe('')
	})

	it('strips control characters that try to break the scheme check', () => {
		expect(sanitizeUrl('java\tscript:alert(1)')).toBe('')
		expect(sanitizeUrl('java\nscript:alert(1)')).toBe('')
	})

	it('HTML-escapes a quote in an otherwise-safe url', () => {
		expect(sanitizeUrl('https://x.dev/"q')).toBe('https://x.dev/&quot;q')
	})

	it('is case-insensitive on the scheme', () => {
		expect(sanitizeUrl('JavaScript:alert(1)')).toBe('')
		expect(sanitizeUrl('HTTPS://x.dev')).toBe('HTTPS://x.dev')
	})
})

describe('scanCSVCell', () => {
	it('scans up to a comma terminator (end is the next cell start)', () => {
		expect(scanCSVCell('a,b', 0)).toEqual({ value: 'a', end: 2, terminator: 'comma' })
	})

	it('scans up to an LF break', () => {
		expect(scanCSVCell('a\nb', 0)).toEqual({ value: 'a', end: 2, terminator: 'break' })
	})

	it('consumes a CRLF break as one terminator', () => {
		expect(scanCSVCell('a\r\nb', 0)).toEqual({ value: 'a', end: 3, terminator: 'break' })
	})

	it('scans up to a bare-CR break', () => {
		expect(scanCSVCell('a\rb', 0)).toEqual({ value: 'a', end: 2, terminator: 'break' })
	})

	it('ends at the end of input', () => {
		expect(scanCSVCell('abc', 0)).toEqual({ value: 'abc', end: 3, terminator: 'end' })
	})

	it('scans an empty cell at the end of input (index === length)', () => {
		expect(scanCSVCell('a,', 2)).toEqual({ value: '', end: 2, terminator: 'end' })
	})

	it('starts at any index offset', () => {
		expect(scanCSVCell('a,b,c', 2)).toEqual({ value: 'b', end: 4, terminator: 'comma' })
		expect(scanCSVCell('a,b,c', 4)).toEqual({ value: 'c', end: 5, terminator: 'end' })
	})

	it('keeps a comma inside a quoted run as content', () => {
		expect(scanCSVCell('"b,c",d', 0)).toEqual({ value: 'b,c', end: 6, terminator: 'comma' })
	})

	it('resolves a doubled quote inside a quoted run to a literal "', () => {
		expect(scanCSVCell('"say ""hi""",x', 0)).toEqual({
			value: 'say "hi"',
			end: 13,
			terminator: 'comma',
		})
	})

	it('keeps line breaks inside a quoted run as content (multi-line cell)', () => {
		expect(scanCSVCell('"a\nb\r\nc",d', 0)).toEqual({
			value: 'a\nb\r\nc',
			end: 9,
			terminator: 'comma',
		})
	})

	it('joins a quoted run opened mid-cell with the surrounding content', () => {
		expect(scanCSVCell('a"b"c,d', 0)).toEqual({ value: 'abc', end: 6, terminator: 'comma' })
	})

	it('runs an unterminated quote to the end of the input (total, no throw)', () => {
		expect(scanCSVCell('"abc\ndef', 0)).toEqual({ value: 'abc\ndef', end: 8, terminator: 'end' })
	})
})

describe('escapeCSVCell', () => {
	it('passes a plain value through verbatim', () => {
		expect(escapeCSVCell('plain')).toBe('plain')
		expect(escapeCSVCell('')).toBe('')
	})

	it('quotes a value containing a comma / quote / line break', () => {
		expect(escapeCSVCell('b,c')).toBe('"b,c"')
		expect(escapeCSVCell('say "hi"')).toBe('"say ""hi"""')
		expect(escapeCSVCell('a\nb')).toBe('"a\nb"')
		expect(escapeCSVCell('a\rb')).toBe('"a\rb"')
	})
})

describe('serializeCSVRow', () => {
	it('escapes each cell and joins with a comma', () => {
		expect(serializeCSVRow(['a', 'b,c', 'say "hi"'])).toBe('a,"b,c","say ""hi"""')
	})

	it('serializes an empty row to the empty string', () => {
		expect(serializeCSVRow([])).toBe('')
	})
})
