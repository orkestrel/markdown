import {
	booleanShape,
	integerShape,
	literalShape,
	objectShape,
	optionalShape,
	stringShape,
} from '@orkestrel/contract'

// AGENTS section 14 / 4.6.1: shapers are `ContractShape` VALUES, not functions
// or types - a JSON-Schema blueprint the compilers (factories.ts) turn into a
// guard / parser / schema / generator in lockstep. Only the NON-recursive
// parts of the markdown AST (types.ts) can be expressed here: a shape tree has
// no lazy/self-referential node, so any type whose fields recurse into
// `BlockNode` / `InlineNode` / `MarkdownNode` (EmphasisNode, LinkNode,
// HeadingNode, ParagraphNode, ListItemNode, ListNode, TableNode,
// BlockquoteNode, MarkdownDocument) is skipped here and stays guard-only
// (validators.ts) via `lazyOf`.

/**
 * The shape of a {@link TextNode} - a plain-text leaf inline run.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { textShape } from '@src/core'
 *
 * const text = createContract(textShape)
 * text.is({ element: 'text', value: 'hi' }) // true
 * ```
 */
export const textShape = objectShape({
	element: literalShape(['text']),
	value: stringShape(),
})

/**
 * The shape of a {@link CodeSpanNode} - an inline code span (`` `code` ``).
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { codeSpanShape } from '@src/core'
 *
 * const codeSpan = createContract(codeSpanShape)
 * codeSpan.is({ element: 'codeSpan', value: 'const x = 1' }) // true
 * ```
 */
export const codeSpanShape = objectShape({
	element: literalShape(['codeSpan']),
	value: stringShape(),
})

/**
 * The shape of a {@link CodeBlockNode} - a fenced code block. `lang` is
 * optional (absent when the opening fence carries no info-string).
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { codeBlockShape } from '@src/core'
 *
 * const codeBlock = createContract(codeBlockShape)
 * codeBlock.is({ element: 'codeBlock', code: 'x' })                    // true
 * codeBlock.is({ element: 'codeBlock', code: 'x', lang: 'ts' })        // true
 * ```
 */
export const codeBlockShape = objectShape({
	element: literalShape(['codeBlock']),
	lang: optionalShape(stringShape()),
	code: stringShape(),
})

/**
 * The shape of a {@link ThematicBreakNode} - a horizontal rule. Carries no
 * fields beyond its `element` discriminant.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { thematicBreakShape } from '@src/core'
 *
 * const thematicBreak = createContract(thematicBreakShape)
 * thematicBreak.is({ element: 'thematicBreak' }) // true
 * ```
 */
export const thematicBreakShape = objectShape({
	element: literalShape(['thematicBreak']),
})

/**
 * The shape of a {@link TableAlign} - the per-column GFM table alignment
 * literal.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { tableAlignShape } from '@src/core'
 *
 * const tableAlign = createContract(tableAlignShape)
 * tableAlign.is('left')   // true
 * tableAlign.is('center') // true
 * tableAlign.is('top')    // false
 * ```
 */
export const tableAlignShape = literalShape(['left', 'right', 'center'])

/**
 * The shape of {@link ListItemParts} - the parsed parts of a single list-item
 * line the block phase's list detector returns. Fully non-recursive (no
 * nested node fields), so every field shapes directly.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { listItemPartsShape } from '@src/core'
 *
 * const listItemParts = createContract(listItemPartsShape)
 * listItemParts.is({ ordered: false, start: 1, content: 'hi', indent: 0, marker: 2 }) // true
 * ```
 */
export const listItemPartsShape = objectShape({
	ordered: booleanShape(),
	start: integerShape(),
	content: stringShape(),
	indent: integerShape(),
	marker: integerShape(),
})
