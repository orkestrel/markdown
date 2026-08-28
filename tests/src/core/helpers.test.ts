import type { ElementNode, HTMLDocument, HTMLNode } from '@orkestrel/html'
import type {
	BlockNode,
	BlockquoteNode,
	InlineNode,
	MarkdownDocument,
	MarkdownHandlers,
	MarkdownNode,
	ParagraphNode,
	MarkdownSource,
	MarkdownSpan,
	TableNode,
} from '@src/core'
import {
	EMPTY_PROJECTION,
	MAX_DEPTH,
	coalesceText,
	collectList,
	collectTable,
	createProjection,
	extractFence,
	extractHeading,
	extractListItem,
	flattenText,
	foldNode,
	htmlToMarkdown,
	countIndent,
	isBlankLine,
	isEscapable,
	isFenceClose,
	isFenceWhitespace,
	isQuote,
	isTableStart,
	isThematicBreak,
	isWhitespace,
	markdownToHTML,
	joinSources,
	locateEmphasis,
	locateLink,
	mergeProjections,
	normalizeInlines,
	normalizeParagraphLine,
	parseDocument,
	projectHTMLLeaf,
	projectHTMLNode,
	projectSpan,
	projectionToBlocks,
	projectionToInlines,
	renderHTML,
	renderMarkdown,
	rewriteDocument,
	scanCode,
	scanEmphasis,
	scanInline,
	scanInlineSource,
	scanLink,
	sliceSource,
	splitLines,
	splitTableRow,
	splitTableSources,
	startsBlock,
	stripQuote,
	delimiterToAlignments,
	trimInlines,
	trimSource,
	unescapeText,
	walkNodes,
} from '@src/core'
import { parseDocument as parseHTMLDocument } from '@orkestrel/html'
import {
	MARKDOWN_FIXPOINT_CORPUS,
	PROJECTION_CORPUS,
	assertEmphasisNode,
	assertTableNode,
	buildDeepEmphasisInput,
	buildProjection,
	firstBlock,
	inlineText,
	projectHTML,
} from '../../setup'
import { describe, expect, it } from 'vitest'

// The markdown parser's pure helper surface (line and character predicates, block
// extractors, inline scanners, construct scanners, escaping / sanitization primitives)
// plus the AST-level surface (markdownToHTML, renderMarkdown, walkNodes, foldNode,
// rewriteDocument, flattenText, createProjection). Each is pure and total; malformed
// input degrades instead of throwing. parsers.test.ts covers the composed
// parse-behavior corpus, and compilers.test.ts covers the class-driving renderHTML
// pipeline. This suite mirrors every exported helpers.ts symbol.

describe('splitLines', () => {
	it('splits on \\n', () => {
		expect(splitLines('a\nb\nc').map((line) => line.text)).toEqual(['a', 'b', 'c'])
	})

	it('normalizes CRLF and bare CR to \\n', () => {
		expect(splitLines('a\r\nb\rc').map((line) => line.text)).toEqual(['a', 'b', 'c'])
	})

	it('normalizes mixed line endings in one document', () => {
		expect(splitLines('a\r\nb\nc\rd').map((line) => line.text)).toEqual(['a', 'b', 'c', 'd'])
	})

	it('drops a single trailing-newline empty line but keeps interior blanks', () => {
		expect(splitLines('a\n\nb\n').map((line) => line.text)).toEqual(['a', '', 'b'])
	})

	it('drops one trailing LF, CR, or CRLF terminator', () => {
		expect(splitLines('a\n').map((line) => line.text)).toEqual(['a'])
		expect(splitLines('a\r').map((line) => line.text)).toEqual(['a'])
		expect(splitLines('a\r\n').map((line) => line.text)).toEqual(['a'])
	})

	it('keeps multiple trailing blank lines except the very last', () => {
		expect(splitLines('a\n\n\n').map((line) => line.text)).toEqual(['a', '', ''])
	})

	it('returns a single empty line for an empty string', () => {
		expect(splitLines('').map((line) => line.text)).toEqual([''])
	})

	it('maps normalized lines to their original UTF-16 offsets', () => {
		const markdown = 'alpha\r\nbeta\rgamma\0🙂\nomega\n'
		const lines = splitLines(markdown)
		expect(lines).toEqual([
			{ text: 'alpha', segments: [{ offset: 0, start: 0, end: 5 }] },
			{ text: 'beta', segments: [{ offset: 0, start: 7, end: 11 }] },
			{ text: 'gamma\0🙂', segments: [{ offset: 0, start: 12, end: 20 }] },
			{ text: 'omega', segments: [{ offset: 0, start: 21, end: 26 }] },
		])
		for (const line of lines) {
			const segment = line.segments[0]
			if (segment === undefined) continue
			expect(markdown.slice(segment.start, segment.end)).toBe(line.text)
		}
	})
})

describe('sliceSource', () => {
	it('narrows a mapped run to the requested text range', () => {
		const source: MarkdownSource = {
			text: 'alpha',
			segments: [{ offset: 0, start: 10, end: 15 }],
		}
		expect(sliceSource(source, 1, 4)).toEqual({
			text: 'lph',
			segments: [{ offset: 0, start: 11, end: 14 }],
		})
	})

	it('returns no segment for a range that misses every mapped run', () => {
		const source: MarkdownSource = {
			text: 'a_b',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 2, start: 2, end: 3 },
			],
		}
		expect(sliceSource(source, 1, 2)).toEqual({ text: '_', segments: [] })
	})

	it('preserves the whole source at its boundaries', () => {
		const source: MarkdownSource = {
			text: 'edge',
			segments: [{ offset: 0, start: 4, end: 8 }],
		}
		expect(sliceSource(source, 0, 4)).toEqual(source)
	})

	it('keeps a fabricated blank source without inventing a segment', () => {
		expect(sliceSource({ text: '', segments: [] }, 0, 0)).toEqual({ text: '', segments: [] })
	})
})

describe('joinSources', () => {
	it('maps a separator to the original newline between sources', () => {
		const sources: readonly MarkdownSource[] = [
			{ text: 'a', segments: [{ offset: 0, start: 0, end: 1 }] },
			{ text: 'b', segments: [{ offset: 0, start: 2, end: 3 }] },
		]
		expect(joinSources(sources, '\n')).toEqual({
			text: 'a\nb',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 1, start: 1, end: 2 },
				{ offset: 2, start: 2, end: 3 },
			],
		})
	})

	it('maps a normalized separator across an original CRLF boundary', () => {
		const sources: readonly MarkdownSource[] = [
			{ text: 'a', segments: [{ offset: 0, start: 0, end: 1 }] },
			{ text: 'b', segments: [{ offset: 0, start: 3, end: 4 }] },
		]
		const joined = joinSources(sources, '\n')
		expect(joined).toEqual({
			text: 'a\nb',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 1, start: 1, end: 3 },
				{ offset: 2, start: 3, end: 4 },
			],
		})
		expect(projectSpan(joined, 1, 2)).toEqual({ start: 1, end: 3 })
	})

	it('returns an empty source when no sources can contribute', () => {
		expect(joinSources([], '\n')).toEqual({ text: '', segments: [] })
	})

	it('preserves a single source without adding a boundary', () => {
		const source: MarkdownSource = {
			text: 'edge',
			segments: [{ offset: 0, start: 4, end: 8 }],
		}
		expect(joinSources([source], '\n')).toEqual(source)
	})

	it('does not map separators around a fabricated blank source', () => {
		const sources: readonly MarkdownSource[] = [
			{ text: 'a', segments: [{ offset: 0, start: 0, end: 1 }] },
			{ text: '', segments: [] },
			{ text: 'b', segments: [{ offset: 0, start: 2, end: 3 }] },
		]
		expect(joinSources(sources, '\n')).toEqual({
			text: 'a\n\nb',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 3, start: 2, end: 3 },
			],
		})
	})
})

describe('projectSpan', () => {
	it('projects a range across mapped source runs', () => {
		const source: MarkdownSource = {
			text: 'a\nb',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 1, start: 1, end: 2 },
				{ offset: 2, start: 2, end: 3 },
			],
		}
		expect(projectSpan(source, 0, 3)).toEqual({ start: 0, end: 3 })
	})

	it('returns undefined when either boundary misses every segment', () => {
		const source: MarkdownSource = {
			text: '_a_',
			segments: [{ offset: 1, start: 4, end: 5 }],
		}
		expect(projectSpan(source, 0, 2)).toBeUndefined()
		expect(projectSpan(source, 1, 3)).toBeUndefined()
	})

	it('projects exact segment boundaries', () => {
		const source: MarkdownSource = {
			text: 'edge',
			segments: [{ offset: 0, start: 4, end: 8 }],
		}
		expect(projectSpan(source, 0, 4)).toEqual({ start: 4, end: 8 })
	})

	it('projects a zero-width abutment through the later segment', () => {
		const source: MarkdownSource = {
			text: 'ab',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 1, start: 5, end: 6 },
			],
		}
		expect(projectSpan(source, 1, 1)).toEqual({ start: 5, end: 5 })
	})

	it('resolves a zero-width position shared by several segments through the last one at that offset', () => {
		const source: MarkdownSource = {
			text: 'ab',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 1, start: 5, end: 5 },
				{ offset: 1, start: 9, end: 10 },
			],
		}
		expect(projectSpan(source, 1, 1)).toEqual({ start: 9, end: 9 })
	})

	it('bridges an uncovered interior when both range boundaries resolve', () => {
		const source: MarkdownSource = {
			text: 'a\nb',
			segments: [
				{ offset: 0, start: 0, end: 1 },
				{ offset: 2, start: 1, end: 2 },
			],
		}
		expect(projectSpan(source, 0, 3)).toEqual({ start: 0, end: 2 })
		expect(projectSpan(source, 1, 2)).toBeUndefined()
		expect(projectSpan(source, 2, 3)).toEqual({ start: 1, end: 2 })
	})

	it('returns undefined for a fabricated blank source', () => {
		expect(projectSpan({ text: '', segments: [] }, 0, 0)).toBeUndefined()
	})
})

describe('trimSource / normalizeParagraphLine', () => {
	it('trims through source coordinates', () => {
		const source = splitLines('  text  ')[0]
		if (source === undefined) throw new Error('expected a source line')
		expect(trimSource(source)).toEqual({
			text: 'text',
			segments: [{ offset: 0, start: 2, end: 6 }],
		})
	})

	it('maps a normalized hard-break suffix to the whole trailing-space run', () => {
		const source = splitLines('  text   \r\nnext')[0]
		if (source === undefined) throw new Error('expected a source line')
		expect(normalizeParagraphLine(source, true)).toEqual({
			text: 'text  ',
			segments: [
				{ offset: 0, start: 2, end: 6 },
				{ offset: 4, start: 6, end: 9 },
			],
		})
	})
})

describe('countIndent', () => {
	it('counts leading spaces and tabs', () => {
		expect(countIndent('   x')).toBe(3)
		expect(countIndent('\t\tx')).toBe(2)
		expect(countIndent('x')).toBe(0)
	})

	it('counts mixed spaces and tabs, stopping at the first non-whitespace', () => {
		expect(countIndent(' \t x')).toBe(3)
	})

	it('returns the full length for an all-whitespace line', () => {
		expect(countIndent('   ')).toBe(3)
	})

	it('returns 0 for an empty string', () => {
		expect(countIndent('')).toBe(0)
	})
})

describe('line predicates', () => {
	it('recognizes inline whitespace characters', () => {
		expect(isWhitespace(' ')).toBe(true)
		expect(isWhitespace('\t')).toBe(true)
		expect(isWhitespace('\n')).toBe(true)
		expect(isWhitespace('x')).toBe(false)
	})

	it('recognizes blank lines (empty or whitespace-only)', () => {
		expect(isBlankLine('')).toBe(true)
		expect(isBlankLine('  ')).toBe(true)
		expect(isBlankLine('\t')).toBe(true)
		expect(isBlankLine(' \t ')).toBe(true)
		expect(isBlankLine('a')).toBe(false)
		expect(isBlankLine(' a ')).toBe(false)
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

	it('recognizes fence-close whitespace characters, rejects everything else', () => {
		expect(isFenceWhitespace(' ')).toBe(true)
		expect(isFenceWhitespace('\t')).toBe(true)
		expect(isFenceWhitespace('\n')).toBe(true)
		expect(isFenceWhitespace('\r')).toBe(true)
		expect(isFenceWhitespace('\f')).toBe(true)
		expect(isFenceWhitespace('\v')).toBe(true)
		expect(isFenceWhitespace('x')).toBe(false)
		expect(isFenceWhitespace(undefined)).toBe(false)
	})

	it('matches a closing fence of at least the opener length', () => {
		expect(isFenceClose('```', '```')).toBe(true)
		expect(isFenceClose('````', '```')).toBe(true)
		expect(isFenceClose('``', '```')).toBe(false)
		expect(isFenceClose('~~~', '```')).toBe(false)
	})

	it('exercises the full isFenceClose semantics table (regex-free scan)', () => {
		// exact-length close
		expect(isFenceClose('```', '```')).toBe(true)
		// longer close
		expect(isFenceClose('````', '```')).toBe(true)
		// shorter run fails
		expect(isFenceClose('``', '```')).toBe(false)
		// wrong char fails (tilde marker vs backtick close)
		expect(isFenceClose('```', '~~~')).toBe(false)
		expect(isFenceClose('~~', '~~~')).toBe(false)
		// leading whitespace allowed
		expect(isFenceClose('   ```', '```')).toBe(true)
		// trailing whitespace allowed
		expect(isFenceClose('```   ', '```')).toBe(true)
		// leading + trailing whitespace allowed
		expect(isFenceClose('  ```  ', '```')).toBe(true)
		// interior text fails
		expect(isFenceClose('``` js', '```')).toBe(false)
		expect(isFenceClose('x```', '```')).toBe(false)
		// empty line never closes
		expect(isFenceClose('', '```')).toBe(false)
		// tilde fence, tilde close
		expect(isFenceClose('~~~~', '~~~')).toBe(true)
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

	it('rejects a table start with no delimiter line at all', () => {
		expect(isTableStart('| a | b |', undefined)).toBe(false)
	})
})

describe('extractHeading', () => {
	it('extracts every level 1-6 with its level and text', () => {
		expect(extractHeading('# A')).toEqual({ level: 1, text: 'A', offset: 2 })
		expect(extractHeading('## A')).toEqual({ level: 2, text: 'A', offset: 3 })
		expect(extractHeading('### A')).toEqual({ level: 3, text: 'A', offset: 4 })
		expect(extractHeading('#### A')).toEqual({ level: 4, text: 'A', offset: 5 })
		expect(extractHeading('##### A')).toEqual({ level: 5, text: 'A', offset: 6 })
		expect(extractHeading('###### A')).toEqual({ level: 6, text: 'A', offset: 7 })
	})

	it('rejects a no-space #tag', () => {
		expect(extractHeading('#tag')).toBeUndefined()
	})

	it('rejects a run of 7+ #s', () => {
		expect(extractHeading('####### x')).toBeUndefined()
	})

	it('strips a closing ### run and trailing whitespace', () => {
		expect(extractHeading('## Title ##')).toEqual({ level: 2, text: 'Title', offset: 3 })
		expect(extractHeading('# Title   ')).toEqual({ level: 1, text: 'Title', offset: 2 })
	})

	it('yields empty text for a bare heading marker with no text', () => {
		expect(extractHeading('###')).toEqual({ level: 3, text: '', offset: 3 })
	})

	it('locates trimmed heading text inside the original line', () => {
		expect(extractHeading('  ##   Title ##  ')).toEqual({ level: 2, text: 'Title', offset: 7 })
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
		expect(stripQuote({ text: '> hi', segments: [{ offset: 0, start: 0, end: 4 }] })).toEqual({
			text: 'hi',
			segments: [{ offset: 0, start: 2, end: 4 }],
		})
		expect(stripQuote({ text: '>hi', segments: [{ offset: 0, start: 5, end: 8 }] })).toEqual({
			text: 'hi',
			segments: [{ offset: 0, start: 6, end: 8 }],
		})
	})

	it('strips up to 3 leading spaces before the marker', () => {
		expect(stripQuote({ text: '   > hi', segments: [{ offset: 0, start: 10, end: 17 }] })).toEqual({
			text: 'hi',
			segments: [{ offset: 0, start: 15, end: 17 }],
		})
	})
})

describe('splitTableRow / delimiterToAlignments', () => {
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
		expect(delimiterToAlignments('| :- | :-: | -: | - |')).toEqual([
			'left',
			'center',
			'right',
			null,
		])
	})
})

describe('splitTableSources', () => {
	it('keeps an escaped pipe cell mapped to its complete source spelling', () => {
		const source = splitLines('| a\\|b |')[0]
		if (source === undefined) throw new Error('expected a table source')
		const cell = trimSource(splitTableSources(source)[0] ?? { text: '', segments: [] })
		expect(cell.text).toBe('a|b')
		expect(projectSpan(cell, 0, cell.text.length)).toEqual({ start: 2, end: 6 })
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

	it('maps a joined text node across the whole coalesced source run', () => {
		const left: InlineNode = { element: 'text', value: 'a' }
		const right: InlineNode = { element: 'text', value: 'b' }
		const spans = new Map<MarkdownNode, MarkdownSpan>([
			[left, { start: 2, end: 3 }],
			[right, { start: 6, end: 8 }],
		])
		const merged = coalesceText([left, right], spans)[0]
		if (merged === undefined) throw new Error('expected coalesced text')
		expect(spans.get(merged)).toEqual({ start: 2, end: 8 })
		expect(spans.has(left)).toBe(false)
		expect(spans.has(right)).toBe(false)
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

describe('locateLink', () => {
	it('locates the label close and the consumed syntax end', () => {
		expect(locateLink('[a [b]](c)', 0, 10)).toEqual({ close: 6, end: 10 })
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

describe('locateEmphasis', () => {
	it('locates the content and consumed syntax boundaries', () => {
		expect(locateEmphasis('**text**', 0, 8)).toEqual({
			strong: true,
			open: 2,
			close: 6,
			end: 8,
		})
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

describe('scanInlineSource', () => {
	it('records nested inline nodes against offset-bearing fragments', () => {
		const source = splitLines('before **bold** after')[0]
		if (source === undefined) throw new Error('expected inline source')
		const spans = new Map<MarkdownNode, MarkdownSpan>()
		const nodes = scanInlineSource(source, 7, 15, spans)
		const emphasis = assertEmphasisNode(nodes[0])
		const child = emphasis.children[0]
		if (child === undefined) throw new Error('expected emphasis text')
		expect(spans.get(emphasis)).toEqual({ start: 7, end: 15 })
		expect(spans.get(child)).toEqual({ start: 9, end: 13 })
	})
})

// The inline phase's offset-bearing entry point. `scanInlineSource` runs the same scan
// `parseInline` composes and records each emitted node into a caller-owned recorder, so a
// caller writing its own block phase over `splitLines` output keeps original coordinates.
describe('scanInlineSource — coordinates inside one line', () => {
	it('records each emitted node against the original coordinates of the scanned line', () => {
		const [line] = splitLines('> a *b*')
		const spans = new Map<MarkdownNode, MarkdownSpan>()
		const nodes = line === undefined ? [] : scanInlineSource(line, 2, line.text.length, spans, 0)
		const [text, emphasis] = nodes
		expect(text === undefined ? undefined : spans.get(text)).toEqual({ start: 2, end: 4 })
		expect(emphasis === undefined ? undefined : spans.get(emphasis)).toEqual({ start: 4, end: 7 })
	})
})

describe('collectTable', () => {
	it('collects a table slice, returning the node and the index after it', () => {
		const lines = splitLines('| a | b |\n| - | - |\n| 1 | 2 |\nafter')
		const { node, next } = collectTable(lines, 0)
		expect(node.element).toBe('table')
		expect(node.header.map(inlineText)).toEqual(['a', 'b'])
		expect(next).toBe(3)
	})

	it('collects a header-only table with no body rows', () => {
		const lines = splitLines('| a |\n| - |')
		const { node, next } = collectTable(lines, 0)
		expect(node.rows).toEqual([])
		expect(next).toBe(2)
	})
})

describe('collectList', () => {
	it('collects a list slice, returning the node and the index after it', () => {
		const lines = splitLines('- one\n- two\nafter')
		const { node, next } = collectList(lines, 0, 0)
		expect(node.element).toBe('list')
		expect(node.items).toHaveLength(2)
		expect(next).toBe(3)
	})

	it('collects an ordered list slice starting mid-array', () => {
		const lines = splitLines('plain\n3. three\n4. four')
		const { node, next } = collectList(lines, 1, 0)
		expect(node.ordered).toBe(true)
		expect(node.start).toBe(3)
		expect(next).toBe(3)
	})

	it('preserves mixed markers and residual source when a mid-array chain reaches the cap', () => {
		const lines = splitLines('plain\n- \n  3. \n     - leaf')
		const { node, next } = collectList(lines, 1, MAX_DEPTH - 2)

		expect(next).toBe(lines.length)
		expect(node).toEqual({
			element: 'list',
			ordered: false,
			start: 1,
			items: [
				{
					element: 'listItem',
					children: [
						{
							element: 'list',
							ordered: true,
							start: 3,
							items: [
								{
									element: 'listItem',
									children: [
										{
											element: 'paragraph',
											children: [{ element: 'text', value: '\n- leaf' }],
										},
									],
								},
							],
						},
					],
				},
			],
		})
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

	it('keeps every iterative AST engine total while an identity rewrite reuses a wide document', () => {
		const blocks: BlockNode[] = []
		for (let index = 0; index < 150_000; index += 1) blocks.push({ element: 'thematicBreak' })
		const document: MarkdownDocument = { element: 'document', children: blocks }

		expect(() => renderHTML(document)).not.toThrow()
		expect(() => renderMarkdown(document)).not.toThrow()
		const walked = [...walkNodes(document)].length
		expect(walked).toBe(blocks.length + 1)
		expect(foldNode(document, countHandlers, 0)).toBe(blocks.length + 1)
		const [rewritten] = rewriteDocument(document, (node) => node)
		expect(rewritten).toBe(document)
		expect(rewritten.children).toHaveLength(blocks.length)
		expect(flattenText(document)).toBe('')
	})

	it('keeps sparse adopted arrays isolated while rebuilding each changed spine', () => {
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
		const [rewritten] = rewriteDocument(document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		expect(renderHTML(rewritten)).toBe('<h1>A</h1><p>B</p>')
		expect(flattenText(document)).toBe('ab')
	})
})

describe('rewriteDocument', () => {
	it('keeps the document identity and records no derivations when the rewrite changes nothing', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'same' }] }],
		}

		const [rewritten, derivations] = rewriteDocument(document, (node) => node)

		expect(rewritten).toBe(document)
		expect([...derivations]).toEqual([])
	})

	it('rebuilds and maps only the changed text spine while reusing its sibling subtree', () => {
		const changed: InlineNode = { element: 'text', value: 'change' }
		const paragraph: ParagraphNode = { element: 'paragraph', children: [changed] }
		const sibling: ParagraphNode = {
			element: 'paragraph',
			children: [{ element: 'codeSpan', value: 'same' }],
		}
		const document: MarkdownDocument = { element: 'document', children: [paragraph, sibling] }

		const [rewritten, derivations] = rewriteDocument(document, (node) =>
			node === changed ? { element: 'text', value: 'changed' } : node,
		)
		const rewrittenParagraph = rewritten.children[0]
		const rewrittenSibling = rewritten.children[1]
		if (rewrittenParagraph?.element !== 'paragraph')
			throw new Error('expected the rewritten paragraph')
		const rewrittenText = rewrittenParagraph.children[0]
		if (rewrittenText === undefined) throw new Error('expected the rewritten text')

		expect(rewritten).not.toBe(document)
		expect(rewrittenParagraph).not.toBe(paragraph)
		expect(rewrittenText).not.toBe(changed)
		expect(rewrittenSibling).toBe(sibling)
		expect(
			rewrittenSibling?.element === 'paragraph' ? rewrittenSibling.children[0] : undefined,
		).toBe(sibling.children[0])
		expect(derivations).toEqual(
			new Map<MarkdownNode, MarkdownNode | undefined>([
				[rewrittenText, changed],
				[rewrittenParagraph, paragraph],
				[rewritten, document],
			]),
		)
		expect(derivations.has(sibling)).toBe(false)
	})

	it('maps a handler replacement to the input node it replaces', () => {
		const source: InlineNode = { element: 'text', value: 'source' }
		const paragraph: ParagraphNode = { element: 'paragraph', children: [source] }
		const document: MarkdownDocument = { element: 'document', children: [paragraph] }
		const replacement: InlineNode = { element: 'codeSpan', value: 'replacement' }

		const [rewritten, derivations] = rewriteDocument(document, (node) =>
			node === source ? replacement : node,
		)
		const rewrittenParagraph = rewritten.children[0]
		if (rewrittenParagraph?.element !== 'paragraph')
			throw new Error('expected the rewritten paragraph')

		expect(rewrittenParagraph.children[0]).toBe(replacement)
		expect(derivations.get(replacement)).toBe(source)
		expect(derivations.get(rewrittenParagraph)).toBe(paragraph)
		expect(derivations.get(rewritten)).toBe(document)
	})

	it('leaves joined, normalized, and synthesized replacement descendants without derivations', () => {
		const joined = coalesceText([
			{ element: 'text', value: 'joined ' },
			{ element: 'text', value: 'text' },
		])[0]
		const normalized = normalizeInlines(
			[
				{ element: 'text', value: 'normalized' },
				{ element: 'break' },
				{ element: 'text', value: 'text' },
			],
			false,
		)[0]
		if (joined === undefined || normalized === undefined)
			throw new Error('expected joined and normalized text')
		const projection = mergeProjections([
			buildProjection({ blocks: [{ element: 'thematicBreak' }] }),
			buildProjection({
				inlines: [joined, { element: 'codeSpan', value: 'separator' }, normalized],
			}),
		])
		const synthesized = projection.blocks[1]
		if (synthesized?.element !== 'paragraph') throw new Error('expected a synthesized paragraph')
		const source: BlockquoteNode = {
			element: 'blockquote',
			children: [{ element: 'codeBlock', code: 'source' }],
		}
		const replacement: BlockquoteNode = { element: 'blockquote', children: projection.blocks }
		const document: MarkdownDocument = { element: 'document', children: [source] }

		const [rewritten, derivations] = rewriteDocument(document, (node) =>
			node === source ? replacement : node,
		)

		expect(rewritten.children[0]).toBe(replacement)
		expect(derivations.get(replacement)).toBe(source)
		expect(derivations.has(synthesized)).toBe(false)
		expect(derivations.has(joined)).toBe(false)
		expect(derivations.has(normalized)).toBe(false)
	})

	it('keeps a slot-mismatch child by identity and records no derivation for that reuse', () => {
		const child: InlineNode = { element: 'text', value: 'source' }
		const paragraph: ParagraphNode = { element: 'paragraph', children: [child] }
		const document: MarkdownDocument = { element: 'document', children: [paragraph] }

		const [rewritten, derivations] = rewriteDocument(document, (node) =>
			node === child ? { element: 'thematicBreak' } : node,
		)

		expect(rewritten).toBe(document)
		expect(rewritten.children[0]).toBe(paragraph)
		expect(paragraph.children[0]).toBe(child)
		expect(derivations.has(child)).toBe(false)
		expect([...derivations]).toEqual([])
	})

	it('rewrites bottom-up (children rewritten before the node they belong to)', () => {
		const order: string[] = []
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const [rewritten] = rewriteDocument(document, (node) => {
			order.push(node.element)
			return node
		})
		expect(order).toEqual(['text', 'paragraph'])
		expect(rewritten).toBe(document)
	})

	it('never passes the document root to rewrite', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const seen: string[] = []
		const [rewritten] = rewriteDocument(document, (node) => {
			seen.push(node.element)
			return node
		})
		expect(seen).not.toContain('document')
		expect(rewritten).toBe(document)
	})

	it('never mutates the input document (copy-on-write)', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const snapshot: unknown = JSON.parse(JSON.stringify(document))
		const [rewritten] = rewriteDocument(document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		expect(document).toEqual(snapshot)
		expect(rewritten).not.toBe(document)
	})

	it('reflects a text-value rewrite in the output', () => {
		const document: MarkdownDocument = {
			element: 'document',
			children: [{ element: 'paragraph', children: [{ element: 'text', value: 'x' }] }],
		}
		const [rewritten] = rewriteDocument(document, (node) =>
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
		const [rewritten] = rewriteDocument(document, (node) =>
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
		const chain: Array<BlockquoteNode | ParagraphNode> = [leaf]
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

		const [rewritten] = rewriteDocument(document, rewrite)
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

describe('createProjection', () => {
	it('defaults every absent field from the frozen empty projection', () => {
		expect(Object.isFrozen(EMPTY_PROJECTION)).toBe(true)
		expect(createProjection({ text: 'raw' })).toEqual({
			blocks: [],
			inlines: [],
			text: 'raw',
			cells: [],
			rows: [],
		})
	})

	it('flushes inline content whenever block content is present', () => {
		expect(
			createProjection({
				blocks: [{ element: 'thematicBreak' }],
				inlines: [{ element: 'text', value: 'discarded' }],
			}),
		).toEqual({
			blocks: [{ element: 'thematicBreak' }],
			inlines: [],
			text: '',
			cells: [],
			rows: [],
		})
	})
})

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
	it('carries nested emphasis, alignment, an image, and a link through the grand round trip', () => {
		const source =
			'# Title\n\n_a **c** b_\n\n| Left | Right |\n| :--- | ---: |\n| ![shot](a.png) | [read](/guide) |'
		const canonical =
			'# Title\n\n*a __c__ b*\n\n| Left | Right |\n| :--- | ---: |\n| ![shot](a.png) | [read](/guide) |'
		const projected = htmlToMarkdown(parseHTMLDocument(renderHTML(parseDocument(source))))
		expect(projected).toEqual(parseDocument(source))
		expect(parseDocument(renderMarkdown(projected))).toEqual(projected)
		expect(renderMarkdown(projected)).toBe(canonical)
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

	it('refuses hostile destinations and unsafe text in a hand-built HTML document', () => {
		const hostile: HTMLDocument = {
			category: 'document',
			children: [
				{
					category: 'element',
					name: 'p',
					attributes: [],
					children: [
						{
							category: 'element',
							name: 'a',
							attributes: [{ name: 'href', value: 'javascript:alert(1)' }],
							children: [{ category: 'text', value: 'text' }],
						},
						{ category: 'text', value: ' ' },
						{
							category: 'element',
							name: 'img',
							attributes: [
								{ name: 'src', value: 'da\u0009ta:text/html,alert(2)' },
								{ name: 'alt', value: 'alt' },
							],
							children: [],
						},
						{
							category: 'element',
							name: 'script',
							attributes: [],
							children: [{ category: 'text', value: 'unsafe text' }],
						},
					],
				},
			],
		}
		const projected = htmlToMarkdown(hostile)

		expect(projected).toEqual({
			element: 'document',
			children: [
				{
					element: 'paragraph',
					children: [
						{ element: 'link', href: '', children: [{ element: 'text', value: 'text' }] },
						{ element: 'text', value: ' ' },
						{ element: 'image', src: '', children: [{ element: 'text', value: 'alt' }] },
					],
				},
			],
		})
		expect(renderMarkdown(projected)).toBe('[text]() ![alt]()')
	})
})
