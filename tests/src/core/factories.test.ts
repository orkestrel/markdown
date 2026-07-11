import {
	createCSVParser,
	createMarkdownParser,
	createNDJSONParser,
	createSSEParser,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// The parser factories — createNDJSONParser returns a working NDJSONParserInterface,
// createSSEParser a working SSEParserInterface, createMarkdownParser a working
// MarkdownParserInterface, and createCSVParser a working CSVParserInterface. Full
// buffering / malformed / never-terminated behavior lives in NDJSONParser.test.ts and
// SSEParser.test.ts, the full AST + render behavior in MarkdownParser.test.ts, and the
// full quoting / row-break / round-trip behavior in CSVParser.test.ts; here we assert
// each factory hands back a usable handle.

describe('createNDJSONParser', () => {
	it('returns a working NDJSONParserInterface (complete lines → records)', () => {
		const parser = createNDJSONParser()

		expect(parser.parse('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
	})

	it('buffers a split line across calls', () => {
		const parser = createNDJSONParser()

		expect(parser.parse('{"a":')).toEqual([])
		expect(parser.parse('1}\n')).toEqual([{ a: 1 }])
	})

	it('clears the buffer on reset', () => {
		const parser = createNDJSONParser()

		expect(parser.parse('{"partial"')).toEqual([])
		parser.reset()

		expect(parser.parse('{"fresh":true}\n')).toEqual([{ fresh: true }])
	})

	it('hands back independent handles that do not share buffer state', () => {
		const first = createNDJSONParser()
		const second = createNDJSONParser()

		// A partial buffered in `first` must not leak into `second`.
		expect(first.parse('{"a":1,"b')).toEqual([])
		expect(second.parse('{"c":3}\n')).toEqual([{ c: 3 }])
		expect(first.parse('":2}\n')).toEqual([{ a: 1, b: 2 }])
	})
})

describe('createSSEParser', () => {
	it('returns a working SSEParserInterface (data line → event on its blank line)', () => {
		const parser = createSSEParser()

		expect(parser.parse('data: a\ndata: b\n\n')).toEqual([{ data: 'a\nb' }])
	})

	it('buffers an event split across calls until its blank line', () => {
		const parser = createSSEParser()

		expect(parser.parse('data: hel')).toEqual([])
		expect(parser.parse('lo\n\n')).toEqual([{ data: 'hello' }])
	})

	it('clears the buffer on reset', () => {
		const parser = createSSEParser()

		expect(parser.parse('data: partial\n')).toEqual([])
		parser.reset()

		expect(parser.parse('data: fresh\n\n')).toEqual([{ data: 'fresh' }])
	})

	it('hands back independent handles that do not share buffer state', () => {
		const first = createSSEParser()
		const second = createSSEParser()

		// A partial buffered in `first` must not leak into `second`.
		expect(first.parse('data: a')).toEqual([])
		expect(second.parse('data: c\n\n')).toEqual([{ data: 'c' }])
		expect(first.parse('\n\n')).toEqual([{ data: 'a' }])
	})
})

describe('createMarkdownParser', () => {
	it('returns a working MarkdownParserInterface (markdown → AST)', () => {
		const parser = createMarkdownParser()
		const document = parser.parse('# Title\n\nA **bold** word.')

		expect(document.element).toBe('document')
		expect(document.children[0]?.element).toBe('heading')
		expect(document.children[1]?.element).toBe('paragraph')
	})

	it('renders an AST to safe HTML (text escaped, href sanitized)', () => {
		const parser = createMarkdownParser()
		const html = parser.render(parser.parse('[x](javascript:alert(1)) <b>'))

		expect(html).toContain('<a href="">x</a>')
		expect(html).toContain('&lt;b&gt;')
		expect(html).not.toContain('javascript:')
	})

	it('parses inline content alone via parseInline', () => {
		const parser = createMarkdownParser()
		const nodes = parser.parseInline('a `code` and *em*')

		expect(nodes.map((node) => node.element)).toEqual(['text', 'codeSpan', 'text', 'emphasis'])
	})

	it('is total — malformed markdown degrades without throwing', () => {
		const parser = createMarkdownParser()

		expect(() => parser.render(parser.parse('**[`'))).not.toThrow()
	})

	it('hands back independent handles (stateless reuse is consistent)', () => {
		const first = createMarkdownParser()
		const second = createMarkdownParser()

		expect(first.render(first.parse('# A'))).toBe(second.render(second.parse('# A')))
	})
})

describe('createCSVParser', () => {
	it('returns a working CSVParserInterface (rows of decoded cells)', () => {
		const parser = createCSVParser()

		expect(parser.parse('a,b\nc,d')).toEqual([
			['a', 'b'],
			['c', 'd'],
		])
	})

	it('is quote-aware — a multi-line quoted cell reassembles into one cell', () => {
		const parser = createCSVParser()

		expect(parser.parse('a,"multi\nline",z')).toEqual([['a', 'multi\nline', 'z']])
	})

	it('serializes the exact inverse — parse(serialize(rows)) round-trips', () => {
		const parser = createCSVParser()
		const rows = [['a', 'b,c', 'say "hi"'], ['multi\nline']]

		expect(parser.parse(parser.serialize(rows))).toEqual(rows)
	})

	it('hands back independent handles (stateless reuse is consistent)', () => {
		const first = createCSVParser()
		const second = createCSVParser()

		expect(first.parse('a,"b\nc"')).toEqual(second.parse('a,"b\nc"'))
	})
})
