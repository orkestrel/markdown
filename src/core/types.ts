//  Markdown AST
//
// A {@link MarkdownInterface} parses a markdown document into a typed AST - a
// discriminated union of node values keyed by their `element` (the axis that
// varies, AGENTS §4.4: never `kind` / `type`). The AST is the primary contract
// (render-agnostic, exhaustively testable); the renderer is a separate, downstream
// projection from AST → HTML string. Block nodes carry document structure;
// {@link InlineNode}s carry the inline content of a heading / paragraph / list item
// / table cell. Every node is plain readonly data - no behaviour.

/**
 * The horizontal alignment of a GFM table column, as declared by its delimiter row
 * (`:---` left, `---:` right, `:---:` center). A bare `---` delimiter is represented
 * by `null` in {@link TableNode.align}: the positional array requires one entry per
 * column, JSON cannot carry `undefined` in an array, and the bare delimiter is an
 * explicit no-alignment marker rather than an omitted value.
 */
export type TableAlign = 'left' | 'right' | 'center'

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
export interface CodeSpanNode {
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
export type InlineNode = TextNode | EmphasisNode | CodeSpanNode | LinkNode

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
	/**
	 * The per-column alignment from the delimiter row, in column order. `null`
	 * represents a bare `---` delimiter because this positional array requires one
	 * entry per column, JSON cannot carry `undefined` in an array, and the delimiter
	 * is an explicit no-alignment marker rather than an omitted value.
	 */
	readonly align: readonly (TableAlign | null)[]
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
 * document. The value {@link MarkdownInterface.document} holds.
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
 * A fold handler for one AST element - receives the node and its children
 * ALREADY folded to `T`, and produces the node's own `T`. The building block of a
 * {@link MarkdownHandlers} catamorphism table.
 */
export type MarkdownHandler<TNode, T> = (node: TNode, children: readonly T[]) => T

/**
 * The total catamorphism table for {@link MarkdownInterface.fold} - one
 * {@link MarkdownHandler} per AST element, keyed by its `element` discriminant. Every
 * key is required: a fold is total over the AST, so there is no element it can skip.
 */
export interface MarkdownHandlers<T> {
	/** Folds a {@link MarkdownDocument} root from its already-folded block children. */
	readonly document: MarkdownHandler<MarkdownDocument, T>
	/** Folds a {@link HeadingNode} from its already-folded inline children. */
	readonly heading: MarkdownHandler<HeadingNode, T>
	/** Folds a {@link ParagraphNode} from its already-folded inline children. */
	readonly paragraph: MarkdownHandler<ParagraphNode, T>
	/** Folds a {@link ThematicBreakNode} (leaf - always called with an empty children list). */
	readonly thematicBreak: MarkdownHandler<ThematicBreakNode, T>
	/** Folds a {@link BlockquoteNode} from its already-folded block children. */
	readonly blockquote: MarkdownHandler<BlockquoteNode, T>
	/** Folds a {@link CodeBlockNode} (leaf - always called with an empty children list). */
	readonly codeBlock: MarkdownHandler<CodeBlockNode, T>
	/** Folds a {@link ListNode} from its already-folded item children. */
	readonly list: MarkdownHandler<ListNode, T>
	/** Folds a {@link ListItemNode} from its already-folded block children. */
	readonly listItem: MarkdownHandler<ListItemNode, T>
	/**
	 * Folds a {@link TableNode} from its cells' already-folded inline nodes, flattened
	 * to ONE folded `T` per inline node - header cells first (column order), then body
	 * rows' cells (row order, then column order). It is NOT a leaf: recover cell
	 * boundaries from `node.header[c].length` / `node.rows[r][c].length` against the
	 * flat `children` list.
	 */
	readonly table: MarkdownHandler<TableNode, T>
	/** Folds a {@link TextNode} (leaf - always called with an empty children list). */
	readonly text: MarkdownHandler<TextNode, T>
	/** Folds an {@link EmphasisNode} from its already-folded inline children. */
	readonly emphasis: MarkdownHandler<EmphasisNode, T>
	/** Folds a {@link CodeSpanNode} (leaf - always called with an empty children list). */
	readonly codeSpan: MarkdownHandler<CodeSpanNode, T>
	/** Folds a {@link LinkNode} from its already-folded inline children. */
	readonly link: MarkdownHandler<LinkNode, T>
}

/**
 * A copy-on-write node rewrite applied bottom-up by {@link MarkdownInterface.map} -
 * receives one node (its own children already rewritten) and returns its
 * replacement (the same node, unchanged, or a new node).
 */
export type MarkdownRewriteHandler = (node: MarkdownNode) => MarkdownNode

/**
 * A stateful, parsed markdown document: the typed {@link MarkdownDocument} AST plus
 * the query, rewrite, and fold operations over it.
 *
 * @remarks
 * - **Immutable.** {@link MarkdownInterface.map} never mutates the stored AST - it
 *   returns a NEW {@link MarkdownInterface} instance; the document root invariant
 *   (`element: 'document'`) always holds.
 * - **Traversal order.** `walk` / `find` / `filter` / `reduce` walk the AST
 *   depth-first, pre-order, root-inclusive; `stream` is shallow - only the
 *   document's direct block children.
 * - **`stream`.** Returns a web-standard {@link ReadableStream} over the top-level
 *   blocks - a fresh, pull-based source per call: exactly one block is enqueued per
 *   `pull`, so a slow consumer's backpressure is respected and no work happens ahead
 *   of demand. Cancellable via the returned stream's own `cancel()`, async-iterable
 *   wherever the platform supports it (Node, Deno, and browsers that ship the
 *   proposal), and pipeable through any {@link TransformStream} / {@link WritableStream}.
 * - **The seven-method surface.** `document` (the AST root), `walk` (the deep
 *   traversal), `find` / `filter` / `reduce` (queries built on `walk`), `map` (the
 *   bottom-up rewrite), `fold` (the total catamorphism), and `stream` (the shallow,
 *   backpressured top-level source).
 */
export interface MarkdownInterface {
	/** The stored {@link MarkdownDocument} AST root. */
	readonly document: MarkdownDocument
	/**
	 * THE deep traversal - a lazy, depth-first, pre-order, root-inclusive
	 * {@link Generator} over every {@link MarkdownNode} in the document. The sync
	 * `for (const node of markdown.walk())` surface is also consumable by
	 * `for await (const node of markdown.walk())` (JavaScript accepts a sync
	 * iterable in a `for await`), so async pipelines need no separate iterator.
	 * Contrast with {@link stream}: `walk` is deep, every-node, and sync; `stream`
	 * is shallow (top-level blocks only) and backpressure-respecting.
	 */
	walk(): Generator<MarkdownNode>
	/** Finds the first node (depth-first, pre-order) narrowed by a type guard. */
	find<T extends MarkdownNode>(guard: (node: MarkdownNode) => node is T): T | undefined
	/** Finds the first node (depth-first, pre-order) matching a predicate. */
	find(predicate: (node: MarkdownNode) => boolean): MarkdownNode | undefined
	/** Collects every node (depth-first, pre-order) narrowed by a type guard. */
	filter<T extends MarkdownNode>(guard: (node: MarkdownNode) => node is T): readonly T[]
	/** Collects every node (depth-first, pre-order) matching a predicate. */
	filter(predicate: (node: MarkdownNode) => boolean): readonly MarkdownNode[]
	/** Rewrites the AST bottom-up (copy-on-write) and returns a new {@link MarkdownInterface}. */
	map(rewrite: MarkdownRewriteHandler): MarkdownInterface
	/** Folds the AST depth-first, pre-order into an accumulator. */
	reduce<T>(callback: (accumulator: T, node: MarkdownNode) => T, initial: T): T
	/** Runs a total catamorphism over the document using a {@link MarkdownHandlers} table. */
	fold<T>(handlers: MarkdownHandlers<T>): T
	/**
	 * A web-standard {@link ReadableStream} over the document's top-level block nodes
	 * (shallow, source order) - a lazy, pull-based, backpressure-respecting source. A
	 * fresh, independently-replayable stream every call; never mutates the document.
	 */
	stream(): ReadableStream<BlockNode>
}
