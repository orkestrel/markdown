// Unit tests for the parser validators. Line predicates test raw strings during
// parsing; node guards narrow parsed AST nodes by their `element` discriminant. Each
// predicate is total and returns false for non-matches (AGENTS section 14).

import {
	createMarkdownParser,
	MarkdownNode,
	isBlockquoteNode,
	isCodeBlockNode,
	isCodeSpanNode,
	isEmphasisNode,
	isEscapable,
	isFenceClose,
	isHeadingNode,
	isLinkNode,
	isListNode,
	isParagraphNode,
	isQuote,
	isTableNode,
	isTableStart,
	isTextNode,
	isThematicBreak,
	isWhitespace,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { assertInlineNode, assertListNode, firstBlock } from '../../../setup.js'

const parser = createMarkdownParser()

interface Sample {
	readonly name: string
	readonly node: MarkdownNode
	readonly guard: (node: MarkdownNode) => boolean
}

const samples: readonly Sample[] = [
	{ name: 'heading', node: firstBlock(parser, '# H'), guard: isHeadingNode },
	{ name: 'paragraph', node: firstBlock(parser, 'text'), guard: isParagraphNode },
	{ name: 'list', node: firstBlock(parser, '- a'), guard: isListNode },
	{
		name: 'table',
		node: firstBlock(parser, '| a | b |\n| --- | --- |\n| 1 | 2 |'),
		guard: isTableNode,
	},
	{ name: 'codeBlock', node: firstBlock(parser, '```\ncode\n```'), guard: isCodeBlockNode },
	{ name: 'blockquote', node: firstBlock(parser, '> q'), guard: isBlockquoteNode },
	{ name: 'text', node: assertInlineNode(parser, 'plain'), guard: isTextNode },
	{ name: 'emphasis', node: assertInlineNode(parser, '*em*'), guard: isEmphasisNode },
	{ name: 'codeSpan', node: assertInlineNode(parser, '`code`'), guard: isCodeSpanNode },
	{ name: 'link', node: assertInlineNode(parser, '[t](https://example.com)'), guard: isLinkNode },
]

describe('line predicates', () => {
	it('recognizes inline whitespace characters', () => {
		expect(isWhitespace(' ')).toBe(true)
		expect(isWhitespace('\t')).toBe(true)
		expect(isWhitespace('\n')).toBe(true)
		expect(isWhitespace('x')).toBe(false)
	})

	it('recognizes markdown punctuation as escapable', () => {
		expect(isEscapable('*')).toBe(true)
		expect(isEscapable('[')).toBe(true)
		expect(isEscapable('a')).toBe(false)
	})

	it('recognizes blockquote lines', () => {
		expect(isQuote('> hi')).toBe(true)
		expect(isQuote('   > hi')).toBe(true)
		expect(isQuote('hi')).toBe(false)
	})

	it('matches a closing fence of at least the opener length', () => {
		expect(isFenceClose('```', '```')).toBe(true)
		expect(isFenceClose('````', '```')).toBe(true)
		expect(isFenceClose('``', '```')).toBe(false)
		expect(isFenceClose('~~~', '```')).toBe(false)
	})

	it('accepts 3+ thematic-break markers, spaced or not', () => {
		expect(isThematicBreak('---')).toBe(true)
		expect(isThematicBreak('***')).toBe(true)
		expect(isThematicBreak('___')).toBe(true)
		expect(isThematicBreak('- - -')).toBe(true)
	})

	it('rejects too-few or mixed thematic-break markers', () => {
		expect(isThematicBreak('--')).toBe(false)
		expect(isThematicBreak('-*-')).toBe(false)
		expect(isThematicBreak('text')).toBe(false)
	})

	it('recognizes a header plus delimiter as a table start', () => {
		expect(isTableStart('| a | b |', '| - | - |')).toBe(true)
		expect(isTableStart('| a | b |', '| :- | -: |')).toBe(true)
		expect(isTableStart('| a | b |', 'not a delimiter')).toBe(false)
		expect(isTableStart('no pipe', '| - |')).toBe(false)
	})
})

describe('parser AST validators', () => {
	for (const sample of samples) {
		it(`matches only ${sample.name}`, () => {
			expect(sample.guard(sample.node)).toBe(true)
			for (const other of samples) {
				if (other.name === sample.name) continue
				expect(sample.guard(other.node)).toBe(false)
			}
		})
	}

	it('stays total across the container nodes no guard covers', () => {
		const document = parser.parse('# H')
		const item = assertListNode(firstBlock(parser, '- a')).items[0]
		if (item === undefined) throw new Error('expected a list item')
		for (const { guard } of samples) {
			expect(guard(document)).toBe(false)
			expect(guard(item)).toBe(false)
		}
	})
})
