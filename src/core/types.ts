//  Markdown AST
//
// A {@link MarkdownParser} parses a markdown document into a typed AST - a
// discriminated union of node values keyed by their `element` (the axis that
// varies, AGENTS §4.4: never `kind` / `type`). The AST is the primary contract
// (render-agnostic, exhaustively testable); the renderer is a separate, downstream
// projection from AST → HTML string. Block nodes carry document structure;
// {@link InlineNode}s carry the inline content of a heading / paragraph / list item
// / table cell. Every node is plain readonly data - no behaviour.

/**
 * The horizontal alignment of a GFM table column, as declared by its delimiter row
 * (`:---` left, `---:` right, `:---:` center) - `'none'` when the delimiter carries
 * no alignment colon. One entry per column, in column order.
 */
export type TableAlign = 'none' | 'left' | 'right' | 'center'

/**
 * The parsed parts of a single list-item line - the value the block phase's
 * list detector returns for a `-` / `*` / `+` bullet or a `1.` / `1)` ordinal line.
 */
export interface ListItemParts {
	/** `true` for an ordered (`1.` / `1)`) item, `false` for a bullet (`-` / `*` / `+`). */
	readonly ordered: boolean
	/** The ordinal of an ordered item (its number); `1` for a bullet. */
	readonly start: number
	/** The item's text after the marker. */
	readonly content: string
	/** The leading-space indent of the marker. */
	readonly indent: number
	/** The full marker width (indent + bullet/ordinal + the following space) - the continuation indent. */
	readonly marker: number
}

/**
 * A run of plain text - the leaf inline node. `value` is the decoded text with
 * markdown escapes (`\*`, `\_`, …) already resolved to their literal characters; the
 * renderer HTML-escapes it (`<` / `>` / `&` / `"`) on the way out.
 */
export interface TextNode {
	readonly element: 'text'
	/** The literal text content (escapes resolved, NOT yet HTML-escaped). */
	readonly value: string
}

/**
 * Emphasized inline content - `*italic*` / `_italic_` (`strong: false`) or
 * `**bold**` / `__bold__` (`strong: true`). `children` are the nested inline nodes,
 * so emphasis composes (a `**bold _and italic_**` is a strong node wrapping a text
 * node and an emphasis node).
 */
export interface EmphasisNode {
	readonly element: 'emphasis'
	/** `true` for strong (`**` / `__`, → `<strong>`); `false` for ordinary emphasis (`*` / `_`, → `<em>`). */
	readonly strong: boolean
	/** The emphasized inline content. */
	readonly children: readonly InlineNode[]
}

/**
 * An inline code span - `` `code` ``. `value` is the verbatim span text; no inner
 * markdown is parsed (code is literal), and the renderer HTML-escapes it inside a
 * `<code>` element.
 */
export interface InlineCodeNode {
	readonly element: 'codeSpan'
	/** The verbatim code text (no inner markdown; HTML-escaped at render). */
	readonly value: string
}

/**
 * An inline link - `[text](href)`. `children` are the inline nodes of the link text;
 * `href` is the destination, sanitized at render (a `javascript:` / other unsafe
 * scheme is dropped to an empty `href`, and the value is HTML-attribute-escaped).
 */
export interface LinkNode {
	readonly element: 'link'
	/** The link destination (sanitized + attribute-escaped at render). */
	readonly href: string
	/** The inline content of the link text. */
	readonly children: readonly InlineNode[]
}

/** A node that can appear inside inline content (a heading / paragraph / cell / list item / link text). */
export type InlineNode = TextNode | EmphasisNode | InlineCodeNode | LinkNode

/**
 * An ATX heading - `#` … `######`. `level` is 1–6 (the number of leading `#`),
 * `children` the inline content of the heading text.
 */
export interface HeadingNode {
	readonly element: 'heading'
	/** The heading level, 1 (`#`) through 6 (`######`). */
	readonly level: number
	/** The inline content of the heading text. */
	readonly children: readonly InlineNode[]
}

/** A paragraph - a run of non-blank lines that is not another block; `children` its inline content. */
export interface ParagraphNode {
	readonly element: 'paragraph'
	/** The inline content of the paragraph. */
	readonly children: readonly InlineNode[]
}

/** One item of a {@link ListNode} - `children` the block content of the item (typically one paragraph, plus any nested list). */
export interface ListItemNode {
	readonly element: 'listItem'
	/** The block content of the list item (its text as a paragraph, plus any nested list). */
	readonly children: readonly BlockNode[]
}

/**
 * A list - bulleted (`-` / `*` / `+`, `ordered: false`) or numbered (`1.` / `1)`,
 * `ordered: true`). `start` is the first ordinal of an ordered list (usually `1`).
 * Nesting is expressed by a {@link ListNode} appearing in a {@link ListItemNode}'s
 * `children`.
 */
export interface ListNode {
	readonly element: 'list'
	/** `true` for an ordered (numbered) list (→ `<ol>`); `false` for a bulleted list (→ `<ul>`). */
	readonly ordered: boolean
	/** The starting ordinal of an ordered list (the first item's number); `1` for a bulleted list. */
	readonly start: number
	/** The list's items, in order. */
	readonly items: readonly ListItemNode[]
}

/**
 * A GFM table - `header` the inline content of each header cell, `rows` the body
 * rows (each a list of cells, each cell inline content), `align` the per-column
 * alignment from the delimiter row. A short body row is padded with empty cells; an
 * over-long one is truncated to the header's column count.
 */
export interface TableNode {
	readonly element: 'table'
	/** The header row - one cell of inline content per column. */
	readonly header: readonly (readonly InlineNode[])[]
	/** The body rows - each a list of cells, each cell inline content. */
	readonly rows: readonly (readonly (readonly InlineNode[])[])[]
	/** The per-column alignment from the delimiter row, in column order. */
	readonly align: readonly TableAlign[]
}

/**
 * A fenced code block - ```` ```lang ````. `code` is the verbatim block content (no
 * inner markdown; the closing fence and the trailing newline are stripped), `lang`
 * the info-string language tag (the first word after the opening fence), absent when
 * none was given.
 */
export interface CodeBlockNode {
	readonly element: 'codeBlock'
	/** The info-string language tag (first word after the opening fence), if any. */
	readonly lang?: string
	/** The verbatim code content (no inner markdown; HTML-escaped at render). */
	readonly code: string
}

/** A blockquote - `>`-prefixed lines; `children` the block content parsed from the de-quoted lines (so quotes nest). */
export interface BlockquoteNode {
	readonly element: 'blockquote'
	/** The block content of the quote (the `>`-stripped lines, re-parsed as blocks). */
	readonly children: readonly BlockNode[]
}

/** A thematic break - a horizontal rule (`---` / `***` / `___` on its own line). */
export interface ThematicBreakNode {
	readonly element: 'thematicBreak'
}

/** A node that can appear at the block level of a document (or inside a list item / blockquote). */
export type BlockNode =
	| HeadingNode
	| ParagraphNode
	| ListNode
	| TableNode
	| CodeBlockNode
	| BlockquoteNode
	| ThematicBreakNode

/**
 * The root of a parsed markdown AST - the ordered block children of the whole
 * document. The value {@link MarkdownParserInterface.parse} returns.
 */
export interface MarkdownDocument {
	readonly element: 'document'
	/** The document's top-level block nodes, in source order. */
	readonly children: readonly BlockNode[]
}

/**
 * Any node in a markdown AST - the {@link MarkdownDocument} root, a {@link BlockNode},
 * a {@link ListItemNode}, or an {@link InlineNode}. The exhaustive set the renderer's
 * `switch` covers.
 */
export type MarkdownNode = MarkdownDocument | BlockNode | ListItemNode | InlineNode

/**
 * A pure, total markdown parser: turn a markdown string into a typed
 * {@link MarkdownDocument} AST, and (separately) render an AST to an HTML string.
 *
 * @remarks
 * - **Two phases.** `parse` runs a block phase (headings / paragraphs / lists /
 *   GFM tables / fenced code / blockquotes / thematic breaks) then an inline phase
 *   (emphasis / inline code / links) over each block's text, producing the AST. The
 *   AST is the contract; `render` is a SEPARATE downstream projection to HTML.
 * - **Total.** Neither method ever throws - malformed markdown degrades to text (an
 *   unterminated emphasis stays literal, a broken table falls back to a paragraph),
 *   never a crash.
 * - **Render is safe.** `render` HTML-escapes all text + attribute values and
 *   sanitizes link `href`s (an unsafe scheme - `javascript:`, `data:`, … - is
 *   dropped), so even hostile content cannot inject markup or script.
 * - **`parseInline`** parses a single line of inline content (no block structure) -
 *   the inline phase exposed for a caller that already has block-free text.
 */
export interface MarkdownParserInterface {
	/** Parse a markdown string into a {@link MarkdownDocument} AST (block then inline phase). Never throws. */
	parse(markdown: string): MarkdownDocument
	/** Parse a single line of inline content (emphasis / code / links) into inline nodes. Never throws. */
	parseInline(text: string): readonly InlineNode[]
	/** Render a parsed {@link MarkdownNode} (typically a {@link MarkdownDocument}) to an HTML string - text + href escaped / sanitized. */
	render(node: MarkdownNode): string
}
