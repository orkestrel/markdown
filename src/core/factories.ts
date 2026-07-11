import type { ContractInterface } from '@orkestrel/contract'
import type {
	CodeBlockNode,
	CodeSpanNode,
	MarkdownParserInterface,
	TextNode,
	ThematicBreakNode,
} from './types.js'
import { createContract } from '@orkestrel/contract'
import { MarkdownParser } from './MarkdownParser.js'
import { codeBlockShape, codeSpanShape, textShape, thematicBreakShape } from './shapers.js'

/**
 * Create a markdown parser - a stateless handle that turns a markdown string into a
 * typed {@link MarkdownDocument} AST and (separately) renders an AST to a safe HTML
 * string.
 *
 * @remarks
 * `parse(markdown)` runs a block phase (headings / paragraphs / lists / GFM tables /
 * fenced code / blockquotes / thematic breaks) then an inline phase (emphasis /
 * inline code / links) and returns a render-agnostic {@link MarkdownDocument}.
 * `render(node)` is a SEPARATE projection to HTML that HTML-escapes all text +
 * attributes and sanitizes link `href`s (an unsafe scheme - `javascript:` / `data:`
 * / … - is dropped), so even hostile content cannot inject markup or script.
 * `parseInline(text)` exposes the inline phase alone. Pure + total (malformed
 * markdown degrades to text, never throws) and zero-dependency - a hand-written
 * scanner, no regex-only structural parse, linear-time (no ReDoS). Stateless and
 * event-free, so a handle is freely reused.
 *
 * @returns A working {@link MarkdownParserInterface}
 *
 * @example
 * ```ts
 * import { createMarkdownParser } from '@src/core'
 *
 * const parser = createMarkdownParser()
 * const ast = parser.parse('# Hi\n\nRead the [guide](./guide.md).')
 * parser.render(ast) // '<h1>Hi</h1>\n<p>Read the <a href="./guide.md">guide</a>.</p>'
 * ```
 */
export function createMarkdownParser(): MarkdownParserInterface {
	return new MarkdownParser()
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
