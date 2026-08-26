//  Markdown AST
//
// A {@link MarkdownInterface} parses a markdown document into a typed AST - a
// discriminated union of node values keyed by their `element` (the axis that
// varies, AGENTS §4.4: never `kind` / `type`). The AST is the primary contract
// (render-agnostic, exhaustively testable); three separate projections carry it out
// to sanitized HTML, out to canonical markdown, and in from an HTML AST. Block nodes
// carry document structure;
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
export interface ListItemMatch {
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
 * A half-open region of the ORIGINAL markdown string, in UTF-16 code units -
 * `start` inclusive, `end` exclusive. The provenance a parse records for a node and
 * {@link MarkdownInterface.span} reads back.
 *
 * @remarks
 * The coordinates address the string the handle was constructed from, never the
 * line text a later phase walks, so `markdown.slice(span.start, span.end)` returns
 * the source the node was parsed from. The region's length is `end - start`; no
 * length member exists to drift from the two offsets.
 */
export interface MarkdownSpan {
	/** The first code unit of the region, inclusive. */
	readonly start: number
	/** The code unit one past the region's last, exclusive. */
	readonly end: number
}

/**
 * One run of a {@link MarkdownSource} - the mapping from a stretch of derived text
 * back to the region of the ORIGINAL markdown string it was taken from.
 *
 * @remarks
 * `offset` addresses {@link MarkdownSource.text}; `start` and `end` address the
 * original string. The run's original length derives from `end - start` rather than
 * being stored beside them, so no length member exists to drift, and a position `p`
 * inside the run projects back to `start + (p - offset)`. The run's DERIVED extent
 * ends where the next segment's `offset` begins, so a run may cover more of the
 * original than it holds derived: the separator run `joinSources` records over a
 * normalized `\r\n` terminator is one derived code unit over a two-unit original
 * region, and the run's end boundary claims that whole region. Every strip, trim, and
 * join the block phase performs is affine at this granularity, which is what lets a
 * derived offset carry an original coordinate.
 */
export interface MarkdownSegment {
	/** The first code unit of the run inside {@link MarkdownSource.text}. */
	readonly offset: number
	/** The first code unit of the original-string region the run came from, inclusive. */
	readonly start: number
	/** The code unit one past that region's last, exclusive. */
	readonly end: number
}

/**
 * A piece of derived markdown text paired with the runs mapping it back to the
 * original string - what `splitLines` returns per line, so every phase downstream of
 * it keeps original coordinates instead of reconstructing them from node values.
 *
 * @remarks
 * `text` is the line a parser reads: its terminator, `>` quote marker, or leading
 * indent already removed. `segments` cover `text` in ascending `offset` order, one
 * run per contiguous stretch of the original; a piece assembled from separate
 * stretches carries one segment per stretch.
 */
export interface MarkdownSource {
	/** The derived text a parser reads. */
	readonly text: string
	/** The runs mapping `text` back to the original string, in ascending `offset` order. */
	readonly segments: readonly MarkdownSegment[]
}

/**
 * A run of plain text - the leaf inline node. `value` is the decoded text with
 * markdown escapes (`\*`, `\_`, …) already resolved to their literal characters;
 * html's text encoder escapes `&`, `<`, `>` on the way out; `"` and `'` stay literal
 * in character data.
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

/** A GFM hard line break - two or more trailing spaces before a newline. */
export interface LineBreakNode {
	readonly element: 'break'
}

/**
 * An inline link - `[text](href)`. `children` are the inline nodes of the link text.
 * At render, html's floor removes a refused `href` attribute and the link keeps its
 * text; {@link htmlToMarkdown} instead stores a refused destination as `''`.
 */
export interface LinkNode {
	readonly element: 'link'
	/** The link destination (sanitized + attribute-escaped at render). */
	readonly href: string
	/** The inline content of the link text. */
	readonly children: readonly InlineNode[]
}

/**
 * An inline image - `![alt](src)`. `children` are the inline nodes of the
 * alternative content and `src` is the image destination.
 */
export interface ImageNode {
	readonly element: 'image'
	/** The image destination. */
	readonly src: string
	/** The inline alternative content. */
	readonly children: readonly InlineNode[]
}

/** A node that can appear inside inline content (a heading / paragraph / cell / list item / link text). */
export type InlineNode =
	| TextNode
	| EmphasisNode
	| CodeSpanNode
	| LineBreakNode
	| LinkNode
	| ImageNode

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
	readonly header: ReadonlyArray<readonly InlineNode[]>
	/** The body rows - each a list of cells, each cell inline content. */
	readonly rows: ReadonlyArray<ReadonlyArray<readonly InlineNode[]>>
	/**
	 * The per-column alignment from the delimiter row, in column order. `null`
	 * represents a bare `---` delimiter because this positional array requires one
	 * entry per column, JSON cannot carry `undefined` in an array, and the delimiter
	 * is an explicit no-alignment marker rather than an omitted value.
	 */
	readonly align: ReadonlyArray<TableAlign | null>
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
 * a {@link ListItemNode}, or an {@link InlineNode}. The exhaustive set every
 * projection's `switch` covers.
 */
export type MarkdownNode = MarkdownDocument | BlockNode | ListItemNode | InlineNode

/** One projected table cell - the inline content and alignment of a `th` / `td`. */
export interface MarkdownCell {
	/** The alignment the cell's `align` attribute declared; `undefined` when it declared none. */
	readonly align: TableAlign | undefined
	/** The cell's inline content - a table cell is inline-only, so block content flattens to text. */
	readonly inlines: readonly InlineNode[]
}

/**
 * What one HTML node projects to on the way to markdown - the fold value
 * `htmlToMarkdown` carries up the AST.
 *
 * @remarks
 * A node projects to several things at once because markdown decides late what a
 * given HTML subtree becomes: a `td`'s content is inline in a table and a paragraph
 * outside one, and a `code` body is a code span in prose and a verbatim code block
 * under a `pre`. Rather than guess, each node reports every view its ancestors could
 * need, and the ancestor that knows the context takes the one it wants.
 *
 * - `blocks` / `inlines` - the block and inline views. They are exclusive by
 *   construction: as soon as a node contributes a block, the inline runs around it
 *   are wrapped into paragraphs, so `blocks` being non-empty means `inlines` is
 *   empty and no interleaving is ever lost.
 * - `text` - the raw, uncollapsed, unescaped subtree text a code span and a
 *   `pre > code` body need verbatim. An `UNSAFE_ELEMENTS` subtree contributes none
 *   of it, so a script body can never resurface as prose.
 * - `cells` / `rows` - table structure in flight. A cell travels up to its `tr` and a
 *   row up to its `table`, passing through the `thead` / `tbody` wrappers between
 *   them untouched; whatever never reaches a table degrades to paragraphs.
 */
export interface MarkdownProjection {
	/** The node's block content, with any surrounding inline runs already wrapped into paragraphs. */
	readonly blocks: readonly BlockNode[]
	/** The node's inline content; empty whenever `blocks` is not. */
	readonly inlines: readonly InlineNode[]
	/** The raw subtree text, whitespace uncollapsed and escapes unresolved. */
	readonly text: string
	/** The cells this node contributes to an enclosing row. */
	readonly cells: readonly MarkdownCell[]
	/** The rows this node contributes to an enclosing table - each its cells, in column order. */
	readonly rows: ReadonlyArray<readonly MarkdownCell[]>
}

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
	/** Folds a {@link LineBreakNode} (leaf - always called with an empty children list). */
	readonly break: MarkdownHandler<LineBreakNode, T>
	/** Folds a {@link LinkNode} from its already-folded inline children. */
	readonly link: MarkdownHandler<LinkNode, T>
	/** Folds an {@link ImageNode} from its already-folded alternative content. */
	readonly image: MarkdownHandler<ImageNode, T>
}

/**
 * A copy-on-write node rewrite applied bottom-up by {@link MarkdownInterface.map} -
 * receives one node (its own children already rewritten) and returns its
 * replacement (the same node, unchanged, or a new node).
 */
export type MarkdownRewriteHandler = (node: MarkdownNode) => MarkdownNode

/**
 * A parsed document paired with the {@link MarkdownSpan} of each of its nodes - what
 * `parseProvenance` returns, and what `parseDocument` projects the document out of.
 *
 * @remarks
 * `spans` is keyed by node identity, so it addresses the nodes of THAT document and
 * no other; a node built from separate regions of the source, or from none, is
 * absent rather than mapped to a placeholder region. Destructure it as
 * `const [document, spans] = parseProvenance(markdown)`.
 */
export type MarkdownParseResult = readonly [
	document: MarkdownDocument,
	spans: ReadonlyMap<MarkdownNode, MarkdownSpan>,
]

/**
 * A rewritten value paired with the input node each rewritten node came from - what
 * `rewriteDocument` returns, so provenance survives a rewrite instead of ending at
 * it. `T` is the rewritten value: the document for a whole-document rewrite.
 *
 * @remarks
 * `derivations` is keyed by the nodes of the OUTPUT and read against the source
 * handle's own spans:
 *
 * - a node mapped to an input node takes that input's span;
 * - a node mapped to `undefined` was produced from separate sources - a joined text
 *   run, a synthesized paragraph - so no single input covers it and it has no span;
 * - an absent entry means the output node kept its own identity, unchanged by the
 *   rewrite, so the span it already had still stands.
 */
export type MarkdownDerivation<T> = readonly [
	value: T,
	derivations: ReadonlyMap<MarkdownNode, MarkdownNode | undefined>,
]

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
 * - **The surface.** `document` (the AST root), `walk` (the deep traversal), `find` /
 *   `filter` / `reduce` (queries built on `walk`), `span` (the region of the original
 *   markdown a node was parsed from), `map` (the bottom-up rewrite), `fold` (the
 *   total catamorphism), and `stream` (the shallow, backpressured top-level source).
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
	/**
	 * Reads the region of the original markdown string a node was parsed from.
	 *
	 * @param node - A node of this handle's document.
	 * @returns A fresh {@link MarkdownSpan}, or `undefined` when the node has no single
	 * source region.
	 *
	 * @remarks
	 * Provenance is per handle and per node identity, so a node reports a region
	 * only where THIS handle parsed it from a string. A handle constructed from
	 * an adopted {@link MarkdownDocument} reports `undefined` for every node: it parsed
	 * no string, so no coordinates exist to report. A node assembled from separate
	 * sources - a joined text run, a synthesized paragraph - reports `undefined` too,
	 * because no single region of the original covers it. Each call returns a fresh
	 * value rather than the stored one.
	 */
	span(node: MarkdownNode): MarkdownSpan | undefined
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
