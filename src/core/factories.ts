import type { ContractInterface } from '@orkestrel/contract'
import type {
	CodeBlockNode,
	CodeSpanNode,
	LineBreakNode,
	MarkdownDocument,
	MarkdownInterface,
	MarkdownProjection,
	TextNode,
	ThematicBreakNode,
} from './types.js'
import { createContract } from '@orkestrel/contract'
import { EMPTY_PROJECTION } from './constants.js'
import { Markdown } from './Markdown.js'
import {
	codeBlockShape,
	codeSpanShape,
	lineBreakShape,
	textShape,
	thematicBreakShape,
} from './shapers.js'

/**
 * Create an HTML-to-markdown projection with absent fields defaulted from
 * {@link EMPTY_PROJECTION} and the block/inline exclusivity invariant enforced.
 *
 * @remarks
 * A block-bearing projection cannot also expose inline content. Callers may provide
 * both views, but `inlines` is flushed whenever `blocks` is non-empty.
 *
 * @param parts - The projection fields to provide
 * @returns A complete invariant-preserving projection
 *
 * @example
 * ```ts
 * createProjection({
 *   blocks: [{ element: 'thematicBreak' }],
 *   inlines: [{ element: 'text', value: 'discarded' }],
 * })
 * // { blocks: [{ element: 'thematicBreak' }], inlines: [], text: '', cells: [], rows: [] }
 * ```
 */
export function createProjection(parts: Partial<MarkdownProjection> = {}): MarkdownProjection {
	const blocks = parts.blocks ?? EMPTY_PROJECTION.blocks
	return {
		blocks,
		inlines: blocks.length === 0 ? (parts.inlines ?? EMPTY_PROJECTION.inlines) : [],
		text: parts.text ?? EMPTY_PROJECTION.text,
		cells: parts.cells ?? EMPTY_PROJECTION.cells,
		rows: parts.rows ?? EMPTY_PROJECTION.rows,
	}
}

/**
 * Create a stateful markdown handle from a markdown string or an already-parsed
 * {@link MarkdownDocument} - a typed AST plus the query, rewrite, and fold operations
 * {@link MarkdownInterface} exposes.
 *
 * @remarks
 * Given a `string`, runs a block phase (headings / paragraphs / lists / GFM tables /
 * fenced code / blockquotes / thematic breaks) then an inline phase (emphasis /
 * inline code / links / images / hard breaks) to build a render-agnostic
 * {@link MarkdownDocument}. Given a
 * {@link MarkdownDocument}, adopts it AS-IS without re-validation - gate an untrusted
 * value with `isMarkdownDocument` first. Pure + total parse (malformed markdown
 * degrades to text, never throws) and zero-dependency - a hand-written scanner, no
 * regex-only structural parse, linear-time (no ReDoS).
 *
 * @param input - A markdown string to parse, or an already-parsed {@link MarkdownDocument}
 * @returns A working {@link MarkdownInterface}
 *
 * @example
 * ```ts
 * import { createMarkdown } from '@src/core'
 *
 * const markdown = createMarkdown('# Hi\n\nRead the [guide](./guide.md).')
 * markdown.document.children[0] // { element: 'heading', ... }
 * ```
 */
export function createMarkdown(input: string | MarkdownDocument): MarkdownInterface {
	return new Markdown(input)
}

/**
 * Compile the {@link textShape} into a {@link ContractInterface} for
 * {@link TextNode} - a guard, coercing parser, JSON Schema, and seeded
 * generator from one shape declaration (AGENTS §14).
 *
 * @returns A `TextNode` contract bundling `schema` / `is` / `parse` / `generate`
 *
 * @example
 * ```ts
 * import { createTextContract } from '@src/core'
 *
 * const text = createTextContract()
 * text.is({ element: 'text', value: 'hi' }) // true
 * ```
 */
export function createTextContract(): ContractInterface<TextNode> {
	return createContract(textShape)
}

/**
 * Compile the {@link codeSpanShape} into a {@link ContractInterface} for
 * {@link CodeSpanNode} - a guard, coercing parser, JSON Schema, and seeded
 * generator from one shape declaration (AGENTS §14).
 *
 * @returns A `CodeSpanNode` contract bundling `schema` / `is` / `parse` / `generate`
 *
 * @example
 * ```ts
 * import { createCodeSpanContract } from '@src/core'
 *
 * const codeSpan = createCodeSpanContract()
 * codeSpan.is({ element: 'codeSpan', value: 'const x = 1' }) // true
 * ```
 */
export function createCodeSpanContract(): ContractInterface<CodeSpanNode> {
	return createContract(codeSpanShape)
}

/**
 * Compile the {@link lineBreakShape} into a {@link ContractInterface} for
 * {@link LineBreakNode}.
 *
 * @returns A `LineBreakNode` contract bundling `schema` / `is` / `parse` / `generate`
 *
 * @example
 * ```ts
 * import { createLineBreakContract } from '@src/core'
 *
 * createLineBreakContract().is({ element: 'break' }) // true
 * ```
 */
export function createLineBreakContract(): ContractInterface<LineBreakNode> {
	return createContract(lineBreakShape)
}

/**
 * Compile the {@link codeBlockShape} into a {@link ContractInterface} for
 * {@link CodeBlockNode} - a guard, coercing parser, JSON Schema, and seeded
 * generator from one shape declaration (AGENTS §14).
 *
 * @returns A `CodeBlockNode` contract bundling `schema` / `is` / `parse` / `generate`
 *
 * @example
 * ```ts
 * import { createCodeBlockContract } from '@src/core'
 *
 * const codeBlock = createCodeBlockContract()
 * codeBlock.is({ element: 'codeBlock', code: 'x' }) // true
 * ```
 */
export function createCodeBlockContract(): ContractInterface<CodeBlockNode> {
	return createContract(codeBlockShape)
}

/**
 * Compile the {@link thematicBreakShape} into a {@link ContractInterface} for
 * {@link ThematicBreakNode} - a guard, coercing parser, JSON Schema, and
 * seeded generator from one shape declaration (AGENTS §14).
 *
 * @returns A `ThematicBreakNode` contract bundling `schema` / `is` / `parse` / `generate`
 *
 * @example
 * ```ts
 * import { createThematicBreakContract } from '@src/core'
 *
 * const thematicBreak = createThematicBreakContract()
 * thematicBreak.is({ element: 'thematicBreak' }) // true
 * ```
 */
export function createThematicBreakContract(): ContractInterface<ThematicBreakNode> {
	return createContract(thematicBreakShape)
}
