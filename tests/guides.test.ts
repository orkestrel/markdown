// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants below are this
// package's own, and are the only part a sibling package changes. The executed half
// sits at the end of the file, under `flagship fences`.

import type { ElementNode, HTMLDocument } from '@orkestrel/html'
import type {
	MarkdownDocument,
	MarkdownHandlerMap,
	MarkdownNode,
	MarkdownProjection,
	MarkdownSpan,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import { seededRandom } from '@orkestrel/contract'
import { foldNode as foldHTMLNode, parseDocument as parseHTML } from '@orkestrel/html'
import {
	Markdown,
	createProjection,
	createTextContract,
	flattenText,
	foldNode,
	htmlToMarkdown,
	isHeadingNode,
	isLinkNode,
	isMarkdownDocument,
	isTableNode,
	isTextNode,
	markdownToHTML,
	mergeProjections,
	parseDocument,
	parseInline,
	parseProvenance,
	projectHTMLLeaf,
	projectHTMLNode,
	projectionToBlocks,
	renderHTML,
	renderMarkdown,
	rewriteDocument,
	scanEmphasis,
	scanInline,
	scanInlineSource,
	scanLink,
	splitLines,
	walkNodes,
} from '@src/core'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['text', 'ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/markdown': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// ── Fence helpers ─────────────────────────────────────────────────────────────
// The adoption fence and the house-rule fence of `guides/markdown.md` each declare a
// named function of their own. A transcription that kept the declaration inside its
// case would nest a function in a body, which `AGENTS.md` refuses, so each one sits
// here at module scope with the fence's own body and the fence's own name.

/** The adopt-a-document fence's guarded constructor. */
function adopt(candidate: unknown): Markdown | undefined {
	if (!isMarkdownDocument(candidate)) return undefined
	return new Markdown(candidate)
}

/** The house-rule fence's element handler: a `kbd` reads as a code span, everything else defaults. */
function projectKbdNode(
	node: ElementNode | HTMLDocument,
	children: readonly MarkdownProjection[],
): MarkdownProjection {
	if (node.category === 'element' && node.name === 'kbd') {
		const merged = mergeProjections(children)
		return createProjection({
			inlines: [{ element: 'codeSpan', value: merged.text }],
			text: merged.text,
		})
	}
	return projectHTMLNode(node, children)
}

/** The guide-parity fence's extractor: every Surface-table first-column identifier of a guide. */
function extractSurfaceNames(source: string): readonly string[] {
	const markdown = new Markdown(source)
	const tables = markdown.filter(isTableNode)
	return tables.flatMap((table) =>
		table.rows.map((row) => flattenText({ element: 'paragraph', children: row[0] ?? [] })),
	)
}

// The EXECUTED half. Every preceding check reads a name — from the guide text or from
// the barrel — and a name that resolves proves nothing about a sentence beside it, so a
// fence whose comment claims a value the code contradicts passes all of them. The cases
// here run the flagship fences of `guides/markdown.md` and assert the values their
// comments claim. Each transcription is followed by a presence guard that reads the
// transcribed lines back out of the guide, so the pair cannot drift: change a fence,
// change the transcription beside it. The transcriptions import through `@src/core`
// because that is the specifier this project resolves; the fences use the published
// `@orkestrel/markdown`, and `MODULES` maps both to the same source.
describe('flagship fences', () => {
	const guideText = requireValue(files['guides/markdown.md'], 'Missing file: guides/markdown.md')

	it('reads a heading back to the region of the original string it was parsed from', () => {
		const source = '# Title\n\nA **bold** word.'
		const markdown = new Markdown(source)

		const heading = requireValue(markdown.find(isHeadingNode), 'expected a heading')
		const region = requireValue(markdown.span(heading), 'expected a region')

		expect(region).toEqual({ start: 0, end: 7 })
		expect(source.slice(region.start, region.end)).toBe('# Title')
	})

	it('carries the provenance fence lines the transcription copies', () => {
		expect(guideText).toContain("const source = '# Title\\n\\nA **bold** word.'")
		expect(guideText).toContain('region // { start: 0, end: 7 }')
		expect(guideText).toContain("source.slice(region.start, region.end) // '# Title'")
	})

	it('slices the escape spelling for a text node whose value dropped it', () => {
		const source = 'a \\* b *c*'
		const markdown = new Markdown(source)

		const text = requireValue(markdown.filter(isTextNode)[0], 'expected a text node')
		const region = requireValue(markdown.span(text), 'expected a region')

		expect(text.value).toBe('a * b ')
		expect(region).toEqual({ start: 0, end: 7 })
		expect(source.slice(region.start, region.end)).toBe('a \\* b ')
	})

	it('carries the escaped-spelling fence lines the transcription copies', () => {
		expect(guideText).toContain("const source = 'a \\\\* b *c*'")
		expect(guideText).toContain("text?.value // 'a * b '")
		expect(guideText).toContain('region // { start: 0, end: 7 } — the region slices the spelling')
	})

	it('returns the document and its span map together from one handle-free parse', () => {
		const [document, spans] = parseProvenance('# Title\n\nA **bold** word.')

		expect(spans.get(document)).toEqual({ start: 0, end: 25 })
	})

	it('carries the parseProvenance fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"const [document, spans] = parseProvenance('# Title\\n\\nA **bold** word.')",
		)
		expect(guideText).toContain('spans.get(document) // { start: 0, end: 25 }')
	})

	it('keeps a rewritten node on the region its input held in the original source', () => {
		const markdown = new Markdown('# Hi\n\nText.')
		const lowered = markdown.map((node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
		)

		const first = requireValue(lowered.filter(isTextNode)[0], 'expected a text node')

		expect(first.value).toBe('hi')
		expect(lowered.span(first)).toEqual({ start: 2, end: 4 })
	})

	it('carries the rewrite-provenance fence lines the transcription copies', () => {
		expect(guideText).toContain("first?.value // 'hi'")
		expect(guideText).toContain('region // { start: 2, end: 4 }')
	})

	it('reports no region for an adopted projection and for one output built from separate sources', () => {
		const imported = new Markdown(htmlToMarkdown(parseHTML('<div>text<p>para</p></div>')))

		expect(imported.span(imported.document)).toBeUndefined()

		const markdown = new Markdown('a *b* c')
		const joined = { element: 'text', value: 'joined' } as const
		const merged = markdown.map((node) => (node.element === 'text' ? joined : node))
		const text = requireValue(merged.filter(isTextNode)[0], 'expected a text node')

		expect(merged.span(text)).toBeUndefined()
	})

	it('carries the absent-provenance fence lines the transcription copies', () => {
		expect(guideText).toContain('imported.span(imported.document) // undefined')
		expect(guideText).toContain('merged.span(text) // undefined')
	})

	it('records each inline node it emits against the original line coordinates', () => {
		const line = requireValue(splitLines('> a *b*')[0], 'expected a line')
		const spans = new Map<MarkdownNode, MarkdownSpan>()
		const nodes = scanInlineSource(line, 2, line.text.length, spans, 0)

		const text = requireValue(nodes[0], 'expected a text node')
		const emphasis = requireValue(nodes[1], 'expected an emphasis node')

		expect(spans.get(text)).toEqual({ start: 2, end: 4 })
		expect(spans.get(emphasis)).toEqual({ start: 4, end: 7 })
	})

	it('carries the offset-bearing scan fence lines the transcription copies', () => {
		expect(guideText).toContain("const [line] = splitLines('> a *b*')")
		expect(guideText).toContain('spans.get(text) // { start: 2, end: 4 }')
		expect(guideText).toContain('spans.get(emphasis) // { start: 4, end: 7 }')
	})

	it('folds a house-rule element through the exported projection vocabulary', () => {
		const projected = foldHTMLNode<MarkdownProjection>(
			parseHTML('<p>Press <kbd>Esc</kbd> twice.</p>'),
			{
				document: projectKbdNode,
				element: projectKbdNode,
				text: projectHTMLLeaf,
				comment: projectHTMLLeaf,
				doctype: projectHTMLLeaf,
			},
		)

		expect(renderMarkdown({ element: 'document', children: projectionToBlocks(projected) })).toBe(
			'Press `Esc` twice.',
		)
	})

	it('carries the house-rule fence lines the transcription copies', () => {
		expect(guideText).toContain("if (node.category === 'element' && node.name === 'kbd') {")
		expect(guideText).toContain(
			"renderMarkdown(project(parseHTML('<p>Press <kbd>Esc</kbd> twice.</p>'))) // 'Press `Esc` twice.'",
		)
	})

	it('parses a string into a document whose first child a guard narrows to a heading', () => {
		const markdown = new Markdown('# Title\n\nA **bold** [link](https://x.dev).')
		const first = requireValue(markdown.document.children[0], 'expected a block')

		expect(first.element).toBe('heading')

		const heading = requireValue(markdown.find(isHeadingNode), 'expected a heading')

		expect(heading.level).toBe(1)
	})

	it('carries the construct-and-narrow fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"const markdown = new Markdown('# Title\\n\\nA **bold** [link](https://x.dev).')",
		)
		expect(guideText).toContain(
			"markdown.document.children[0] // { element: 'heading', level: 1, children: [...] }",
		)
	})

	it('adopts a valid document and refuses a shape the guard rejects', () => {
		const good: MarkdownDocument = { element: 'document', children: [] }

		expect(adopt(good)).toBeInstanceOf(Markdown)
		expect(adopt({ element: 'bogus' })).toBeUndefined()
	})

	it('carries the adoption fence lines the transcription copies', () => {
		expect(guideText).toContain('adopt(good) // Markdown instance')
		expect(guideText).toContain("adopt({ element: 'bogus' }) // undefined")
	})

	it('collects every link and flattens each one to its label text', () => {
		const markdown = new Markdown('See [one](https://a.dev) and [two](https://b.dev).')
		const links = markdown.filter(isLinkNode)
		const labels = links.map((link) => flattenText(link))

		expect(labels).toEqual(['one', 'two'])
	})

	it('carries the filter-and-flatten fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"const labels = links.map((link) => flattenText(link)) // ['one', 'two']",
		)
	})

	it('chains map rewrites and writes the result back as canonical markdown', () => {
		const markdown = new Markdown('See [one](https://a.dev) and [two](https://b.dev).')

		const shouted = markdown.map((node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
		)
		const linked = shouted.map((node) =>
			node.element === 'link' ? { ...node, href: `${node.href}?ref=guide` } : node,
		)

		expect(renderMarkdown(linked.document)).toBe(
			'SEE [ONE](https://a.dev?ref=guide) AND [TWO](https://b.dev?ref=guide).',
		)
	})

	it('carries the rewrite-chain fence lines the transcription copies', () => {
		expect(guideText).toContain(
			"renderMarkdown(linked.document) // 'SEE [ONE](https://a.dev?ref=guide) AND [TWO](https://b.dev?ref=guide).'",
		)
	})

	it('reduces the traversal into the accumulator the fence declares', () => {
		const markdown = new Markdown('# One\n\n## Two\n\nBody text.')

		const levels = markdown.reduce<readonly number[]>(
			(accumulator, node) => (isHeadingNode(node) ? [...accumulator, node.level] : accumulator),
			[],
		)

		expect(levels).toEqual([1, 2])
	})

	it('carries the reduce fence lines the transcription copies', () => {
		expect(guideText).toContain(') // [1, 2]')
	})

	it('folds a document to a string through a total handler table', () => {
		const toHTML: MarkdownHandlerMap<string> = {
			document: (_, children) => children.join('\n'),
			heading: (node, children) => `<h${node.level}>${children.join('')}</h${node.level}>`,
			paragraph: (_, children) => `<p>${children.join('')}</p>`,
			thematicBreak: () => '<hr>',
			blockquote: (_, children) => `<blockquote>${children.join('\n')}</blockquote>`,
			codeBlock: (node) => `<pre><code>${node.code}</code></pre>`,
			list: (node, children) =>
				node.ordered ? `<ol>${children.join('')}</ol>` : `<ul>${children.join('')}</ul>`,
			listItem: (_, children) => `<li>${children.join('')}</li>`,
			table: (_, children) => `<table>${children.join('')}</table>`,
			text: (node) => node.value,
			emphasis: (node, children) =>
				node.strong ? `<strong>${children.join('')}</strong>` : `<em>${children.join('')}</em>`,
			codeSpan: (node) => `<code>${node.value}</code>`,
			break: () => '<br>',
			link: (node, children) => `<a href="${node.href}">${children.join('')}</a>`,
			image: (node, children) => `<img src="${node.src}" alt="${children.join('')}">`,
		}

		const markdown = new Markdown('# Hi')

		expect(markdown.fold(toHTML)).toBe('<h1>Hi</h1>')
	})

	it('carries the fold fence lines the transcription copies', () => {
		expect(guideText).toContain('const toHTML: MarkdownHandlerMap<string> = {')
		expect(guideText).toContain("markdown.fold(toHTML) // '<h1>Hi</h1>'")
	})

	it('streams the top-level blocks through a reader loop and through async iteration alike', async () => {
		const markdown = new Markdown('# Title\n\nFirst.\n\nSecond.')

		const reader = markdown.stream().getReader()
		const tops: string[] = []
		for (let result = await reader.read(); !result.done; result = await reader.read()) {
			tops.push(result.value.element)
		}

		expect(tops).toEqual(['heading', 'paragraph', 'paragraph'])

		const topsAsync: string[] = []
		for await (const block of markdown.stream()) topsAsync.push(block.element)

		expect(topsAsync).toEqual(tops)
	})

	it('carries the streaming fence lines the transcription copies', () => {
		expect(guideText).toContain('const reader = markdown.stream().getReader()')
		expect(guideText).toContain("// tops: ['heading', 'paragraph', 'paragraph']")
		expect(guideText).toContain(
			'for await (const block of markdown.stream()) topsAsync.push(block.element)',
		)
	})

	it('walks every node deep, depth-first, pre-order, and root first', () => {
		const markdown = new Markdown('# Title\n\nA **bold** word.')

		const all: string[] = []
		for (const node of markdown.walk()) all.push(node.element)

		expect(all).toEqual([
			'document',
			'heading',
			'text',
			'paragraph',
			'text',
			'emphasis',
			'text',
			'text',
		])
	})

	it('carries the sync-iteration fence lines the transcription copies', () => {
		expect(guideText).toContain(
			'for (const node of markdown.walk()) all.push(node.element) // deep, depth-first, pre-order',
		)
	})

	it('yields the same sequence to a for-await loop that the sync walk yields', async () => {
		const markdown = new Markdown('# Title\n\nA **bold** word.')

		const written: string[] = []
		for await (const node of markdown.walk()) written.push(node.element)

		expect(written).toEqual([...markdown.walk()].map((node) => node.element))
	})

	it('carries the async-iteration fence lines the transcription copies', () => {
		expect(guideText).toContain(
			'for await (const node of markdown.walk()) writer.write(node.element) // sync generator, for-await composes fine',
		)
	})

	it('drives every standalone projection and traversal from a bare node', () => {
		const markdown = new Markdown('# Hi\n\nText.')

		expect(renderHTML(markdown.document)).toBe('<h1>Hi</h1><p>Text.</p>')
		expect(markdownToHTML(markdown.document).category).toBe('document')
		expect(parseDocument(renderMarkdown(markdown.document))).toEqual(markdown.document)

		const imported = htmlToMarkdown(parseHTML('<h1>Release notes</h1><p>Ship <b>fast</b>.</p>'))

		expect(renderMarkdown(imported)).toBe('# Release notes\n\nShip **fast**.')

		const heading = requireValue(markdown.document.children[0], 'expected a block')

		expect([...walkNodes(heading)].map((node) => node.element)).toEqual(['heading', 'text'])

		const countHandlers: MarkdownHandlerMap<number> = {
			document: (_, children) => children.reduce((a, b) => a + b, 0),
			heading: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			paragraph: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			thematicBreak: () => 1,
			blockquote: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			codeBlock: () => 1,
			list: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			listItem: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			table: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			text: () => 1,
			emphasis: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			codeSpan: () => 1,
			break: () => 1,
			link: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
			image: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
		}

		expect(foldNode(heading, countHandlers, 0)).toBe(2)

		const [rewritten, derivations] = rewriteDocument(markdown.document, (node) =>
			node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
		)

		expect(rewritten.children.length).toBe(markdown.document.children.length)
		expect(derivations.size).toBeGreaterThan(0)

		const [unchanged] = rewriteDocument(markdown.document, (node) => node)

		expect(unchanged).toBe(markdown.document)
		expect(parseInline('a **bold** span').map((node) => node.element)).toEqual([
			'text',
			'emphasis',
			'text',
		])
	})

	it('carries the standalone fence lines the transcription copies', () => {
		expect(guideText).toContain("renderHTML(markdown.document) // '<h1>Hi</h1><p>Text.</p>'")
		expect(guideText).toContain('markdownToHTML(markdown.document) // { category: ')
		expect(guideText).toContain("renderMarkdown(imported) // '# Release notes\\n\\nShip **fast**.'")
		expect(guideText).toContain(
			"const elements = [...walkNodes(heading)].map((node) => node.element) // ['heading', 'text']",
		)
		expect(guideText).toContain('const nodeCount = foldNode(heading, countHandlers, 0) // 2')
		expect(guideText).toContain('derivations.size > 0 // true')
		expect(guideText).toContain('unchanged === markdown.document // true')
	})

	it('scans one inline construct at a time and degrades an unclosed one to undefined', () => {
		expect(scanInline('a **b** c', 0, 9).map((node) => node.element)).toEqual([
			'text',
			'emphasis',
			'text',
		])

		const link = scanLink('[docs](https://x.dev)', 0, 21)

		expect(link?.node.href).toBe('https://x.dev')
		expect(link?.end).toBe(21)

		const emphasis = scanEmphasis('**bold**', 0, 8)

		expect(emphasis?.node.strong).toBe(true)
		expect(emphasis?.end).toBe(8)
		expect(scanLink('[unclosed', 0, 9)).toBeUndefined()
	})

	it('carries the scanner fence lines the transcription copies', () => {
		expect(guideText).toContain("scanInline('a **b** c', 0, 9)")
		expect(guideText).toContain("link?.node.href // 'https://x.dev'")
		expect(guideText).toContain('link?.end // 21')
		expect(guideText).toContain('emphasis?.node.strong // true')
		expect(guideText).toContain('emphasis?.end // 8')
		expect(guideText).toContain("scanLink('[unclosed', 0, 9) // undefined")
	})

	it('extracts the Surface-table identifiers of this very guide by parsing it as markdown', () => {
		const names = extractSurfaceNames(guideText)

		expect(names).toContain('MarkdownHandlerMap<T>')
		expect(names).toContain('scanLink')
		expect(names).toContain('LinkScan')
	})

	it('carries the guide-parity extraction fence lines the transcription copies', () => {
		expect(guideText).toContain(
			'const tables = markdown.filter(isTableNode) // readonly TableNode[] — narrowed, no cast needed',
		)
		expect(guideText).toContain(
			"table.rows.map((row) => flattenText({ element: 'paragraph', children: row[0] ?? [] })),",
		)
	})

	it('generates a fixture from a seed that its own guard accepts and a repeat reproduces', () => {
		const text = createTextContract()

		expect(text.schema.type).toBe('object')

		const fixture = text.generate(seededRandom(42))

		expect(text.is(fixture)).toBe(true)
		expect(text.generate(seededRandom(42))).toEqual(fixture)
	})

	it('carries the contract-fixture fence lines the transcription copies', () => {
		expect(guideText).toContain('const text = createTextContract()')
		expect(guideText).toContain('text.schema // the compiled JSON Schema for TextNode')
		expect(guideText).toContain(
			'const fixture = text.generate(seededRandom(42)) // reproducible seed data',
		)
		expect(guideText).toContain('text.is(fixture) // true')
	})
})
