import { createMarkdownParser } from '@src/core'
import { describe, expect, it } from 'vitest'

// The parser factories — createNDJSONParser returns a working NDJSONParserInterface,
// createSSEParser a working SSEParserInterface, createMarkdownParser a working
// MarkdownParserInterface, and createCSVParser a working CSVParserInterface. Full
// buffering / malformed / never-terminated behavior lives in NDJSONParser.test.ts and
// SSEParser.test.ts, the full AST + render behavior in MarkdownParser.test.ts, and the
// full quoting / row-break / round-trip behavior in CSVParser.test.ts; here we assert
// each factory hands back a usable handle.

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
