# Markdown

> A types-first markdown layer over `@orkestrel/html` — a hand-written, linear-time scanner turns a markdown string into a typed AST held by a stateful `Markdown` workspace, and standalone projections carry that AST out (to sanitized HTML, or to canonical markdown source) and carry an HTML AST back in. Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

Markdown here is: parse once into a stateful `Markdown` workspace, then treat every output as a projection of it. `parseDocument` runs a block phase (headings / paragraphs / lists / GFM tables / fenced code / blockquotes / thematic breaks) then an inline phase (emphasis / inline code / links / images / hard breaks) over each block's text, and returns a render-agnostic `MarkdownDocument` — a discriminated union of node values keyed by `element` (the axis that varies, AGENTS §4.4: never `kind` / `type`). A `Markdown` instance wraps that AST with query (`find` / `filter` / `reduce` / iteration), rewrite (`map`), fold, and streaming operations. The AST itself is the primary contract — render-agnostic and exhaustively testable — with a from-unknown validation surface (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) for when an AST arrives from outside `parseDocument` (a deserialized document, a value crossing a process/RPC boundary).

**Both conversion directions live here**, because what an HTML subtree becomes in markdown — and what a markdown node becomes in HTML — is markdown-format knowledge, not HTML knowledge. `@orkestrel/html` owns the HTML AST, its total parser, its canonical serializer, and its sanitize floor; this package owns the two projections across the boundary and never asks html to know a markdown word. Outbound: `markdownToHTML` projects a `MarkdownNode` onto html's AST, `renderHTML` composes that projection with html's sanitizer and serializer into one sanitized string, and `renderMarkdown` writes canonical markdown source instead (§ [`renderMarkdown` round-trip](#rendermarkdown-round-trip)). Inbound: `htmlToMarkdown` folds an html `HTMLNode` back down to a `MarkdownDocument` (§ [`htmlToMarkdown` projection](#htmltomarkdown-projection)). None of the four assumes its input came from a trusted parse, and none of them throws: malformed markdown degrades to literal text, while at the outbound depth cap value-bearing nodes degrade to text and structural nodes degrade to nothing; the inbound trip inherits html's own cap rather than exhausting the call stack (no ReDoS, no stack overflow).

## Surface

### Types

The full node shape and workspace contract, from [`types.ts`](../src/core/types.ts). `element` is the discriminant every node carries; block nodes carry document structure, inline nodes carry the inline content of a heading / paragraph / list item / table cell.

| Type                        | Kind      | Shape                                                                                                                                                                                                                                            |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TableAlign`                | type      | `'left' \| 'right' \| 'center'` — a GFM table column's declared alignment. Absence is `null` in `TableNode.align` and `undefined` on `MarkdownCell.align` (§ [Alignment and absence](#alignment-and-absence)).                                   |
| `ListItemMatch`             | interface | `{ ordered, start, content, indent, marker }` — the block phase's parsed list-item-line result.                                                                                                                                                  |
| `TextNode`                  | interface | `{ element: 'text', value: string }` — a plain-text inline leaf (escapes resolved, not yet HTML-escaped).                                                                                                                                        |
| `EmphasisNode`              | interface | `{ element: 'emphasis', strong: boolean, children: readonly InlineNode[] }` — `*em*` / `**strong**`.                                                                                                                                             |
| `CodeSpanNode`              | interface | `{ element: 'codeSpan', value: string }` — `` `code` ``, verbatim (no inner markdown).                                                                                                                                                           |
| `LineBreakNode`             | interface | `{ element: 'break' }` — a GFM hard break; two trailing spaces before a newline in markdown source, a `br` element in HTML.                                                                                                                      |
| `LinkNode`                  | interface | `{ element: 'link', href: string, children: readonly InlineNode[] }` — `[text](href)`.                                                                                                                                                           |
| `ImageNode`                 | interface | `{ element: 'image', src: string, children: readonly InlineNode[] }` — `![alt](src)`; `children` are the alternative content.                                                                                                                    |
| `InlineNode`                | type      | `TextNode \| EmphasisNode \| CodeSpanNode \| LineBreakNode \| LinkNode \| ImageNode` — anything that can appear inside inline content.                                                                                                           |
| `HeadingNode`               | interface | `{ element: 'heading', level: number, children: readonly InlineNode[] }` — an ATX heading, `level` 1–6.                                                                                                                                          |
| `ParagraphNode`             | interface | `{ element: 'paragraph', children: readonly InlineNode[] }`.                                                                                                                                                                                     |
| `ListItemNode`              | interface | `{ element: 'listItem', children: readonly BlockNode[] }` — one item of a `ListNode`.                                                                                                                                                            |
| `ListNode`                  | interface | `{ element: 'list', ordered: boolean, start: number, items: readonly ListItemNode[] }`.                                                                                                                                                          |
| `TableNode`                 | interface | `{ element: 'table', header, rows, align }` — a GFM table; `header`/`rows` are inline-content cells, `align` a positional `readonly (TableAlign \| null)[]`, one entry per column.                                                               |
| `CodeBlockNode`             | interface | `{ element: 'codeBlock', lang?: string, code: string }` — a fenced code block, verbatim (no inner markdown).                                                                                                                                     |
| `BlockquoteNode`            | interface | `{ element: 'blockquote', children: readonly BlockNode[] }` — `>`-prefixed lines, de-quoted and re-parsed as blocks.                                                                                                                             |
| `ThematicBreakNode`         | interface | `{ element: 'thematicBreak' }` — a horizontal rule; carries no fields beyond its discriminant.                                                                                                                                                   |
| `BlockNode`                 | type      | `HeadingNode \| ParagraphNode \| ListNode \| TableNode \| CodeBlockNode \| BlockquoteNode \| ThematicBreakNode`.                                                                                                                                 |
| `MarkdownDocument`          | interface | `{ element: 'document', children: readonly BlockNode[] }` — the AST root a `Markdown` instance's `document` holds.                                                                                                                               |
| `MarkdownNode`              | type      | `MarkdownDocument \| BlockNode \| ListItemNode \| InlineNode` — the exhaustive set every projection's `switch` covers.                                                                                                                           |
| `MarkdownCell`              | interface | `{ align: TableAlign \| undefined, inlines: readonly InlineNode[] }` — one projected `th` / `td`; table header rows are derived from the source HTML structure.                                                                                  |
| `MarkdownProjection`        | interface | `{ blocks, inlines, text, cells, rows }` — what one HTML node projects to; the fold value `htmlToMarkdown` carries up the AST (§ [`htmlToMarkdown` projection](#htmltomarkdown-projection)).                                                     |
| `MarkdownHandler<TNode, T>` | type      | `(node: TNode, children: readonly T[]) => T` — one catamorphism step; the building block of a `MarkdownHandlers` table.                                                                                                                          |
| `MarkdownHandlers<T>`       | interface | One `MarkdownHandler` per AST element (`document`, `heading`, `paragraph`, `thematicBreak`, `blockquote`, `codeBlock`, `list`, `listItem`, `table`, `text`, `emphasis`, `codeSpan`, `break`, `link`, `image`) — the total table `fold` requires. |
| `MarkdownRewriteHandler`    | type      | `(node: MarkdownNode) => MarkdownNode` — a bottom-up, copy-on-write node rewrite for `map`.                                                                                                                                                      |
| `MarkdownInterface`         | interface | `{ document, walk, find, filter, map, reduce, fold, stream }`, `stream(): ReadableStream<BlockNode>` — see [`## Methods`](#methods) below.                                                                                                       |

### Constants

From [`constants.ts`](../src/core/constants.ts).

| Constant           | Kind  | Behavior                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_DEPTH`        | const | `64` — the recursion cap `parseDocument` (and its `parsers.ts` helpers) and the `helpers.ts` traversal/projection functions (`markdownToHTML`, `renderHTML`, `renderMarkdown`, `walkNodes`, `foldNode`, `rewriteDocument`) all honor before degrading. `htmlToMarkdown` is the exception: its bound is html's, not this one (§ [Depth degrade semantics](#depth-degrade-semantics)). |
| `EMPTY_PROJECTION` | const | Frozen empty `MarkdownProjection` used as the default source for every absent projection field.                                                                                                                                                                                                                                                                                      |

### Parsers

The block/inline parsing pipeline, from [`parsers.ts`](../src/core/parsers.ts) — the orchestration `parseDocument` composes out of `helpers.ts`'s pure scanning leaves (AGENTS §5). `parseBlocks` is the recursive spine; each parser is exported and independently testable. The construct scanners it composes (`collectTable` / `collectList`) are leaves and live in [`helpers.ts`](../src/core/helpers.ts) with the other scanners; each calls back into the phase entry above it, so the two files are mutually recursive by design.

| Parser          | Kind     | Signature                                                           | Behavior                                                                                                                                         |
| --------------- | -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseBlocks`   | function | `(lines: readonly string[], depth: number) => readonly BlockNode[]` | Parses a run of markdown lines into block nodes, recursing into nested blockquotes/list items; degrades to one literal paragraph at `MAX_DEPTH`. |
| `parseDocument` | function | `(markdown: string) => MarkdownDocument`                            | Parses a markdown string into a `MarkdownDocument` AST via the block phase (`splitLines` + `parseBlocks`). Never throws.                         |
| `parseInline`   | function | `(text: string) => readonly InlineNode[]`                           | Parses one line of inline content (emphasis / code / links / images / breaks), no block structure. Never throws.                                 |

### Helpers

Pure, total leaves from [`helpers.ts`](../src/core/helpers.ts) — the scanning functional core `parsers.ts` composes, the four AST-crossing projections (`markdownToHTML`, `renderHTML`, `renderMarkdown`, `htmlToMarkdown`) plus the projection leaves they are built from, and the traversal engines `Markdown` delegates to (AGENTS §5). Every function is unit-testable in isolation; malformed input degrades to text, never throws.

| Helper                  | Kind     | Signature                                                                                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `splitLines`            | function | `(markdown: string) => readonly string[]`                                                            | Normalizes `\r\n` / `\r` to `\n` and splits into lines; a single trailing newline yields no final empty line.                                                                                                                                                                                                                                                                                                                                  |
| `countIndent`           | function | `(line: string) => number`                                                                           | Count of leading space/tab characters (a tab counts as one).                                                                                                                                                                                                                                                                                                                                                                                   |
| `extractHeading`        | function | `(line: string) => { level: number, text: string } \| undefined`                                     | Parses an ATX heading line (`#`…`######`); `undefined` when not a heading.                                                                                                                                                                                                                                                                                                                                                                     |
| `extractFence`          | function | `(line: string) => { marker: string, lang: string \| undefined } \| undefined`                       | Parses a fenced-code opening line (` ``` ` / `~~~`, optional info string); `undefined` when not a fence opener.                                                                                                                                                                                                                                                                                                                                |
| `extractListItem`       | function | `(line: string) => ListItemMatch \| undefined`                                                       | Parses a bullet (`-`/`*`/`+`) or ordinal (`1.`/`1)`) list-item line; `undefined` when not a list item.                                                                                                                                                                                                                                                                                                                                         |
| `stripQuote`            | function | `(line: string) => string`                                                                           | Strips one level of `>` blockquote marker (plus one optional space).                                                                                                                                                                                                                                                                                                                                                                           |
| `splitTableRow`         | function | `(row: string) => readonly string[]`                                                                 | Splits a GFM table row into cells; outer pipes optional, `\|` escaped inside a cell is literal.                                                                                                                                                                                                                                                                                                                                                |
| `delimiterToAlignments` | function | `(delimiter: string) => readonly (TableAlign \| null)[]`                                             | Derives per-column alignment from a GFM delimiter row; a bare `---` column yields `null`.                                                                                                                                                                                                                                                                                                                                                      |
| `startsBlock`           | function | `(lines: readonly string[], index: number) => boolean`                                               | Whether the line at `index` starts a NEW block kind — stops paragraph collection without a blank-line separator.                                                                                                                                                                                                                                                                                                                               |
| `unescapeText`          | function | `(text: string) => string`                                                                           | Resolves backslash escapes (`\*` → `*`) to their literal characters.                                                                                                                                                                                                                                                                                                                                                                           |
| `coalesceText`          | function | `(nodes: readonly InlineNode[]) => readonly InlineNode[]`                                            | Merges adjacent text nodes into one.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scanCode`              | function | `(source, start, to) => { value: string, end: number } \| undefined`                                 | Scans an inline code span (matching backtick-run closer); `undefined` when unterminated.                                                                                                                                                                                                                                                                                                                                                       |
| `scanLink`              | function | `(source, start, to, depth = 0) => { node: LinkNode, end: number } \| undefined`                     | Scans `[text](href)`; `undefined` when the shape doesn't hold. `depth` gates the text-children recursion at `MAX_DEPTH`.                                                                                                                                                                                                                                                                                                                       |
| `scanEmphasis`          | function | `(source, start, to, depth = 0) => { node: EmphasisNode, end: number } \| undefined`                 | Scans `*em*` / `**strong**`; `undefined` when no valid closer exists. `depth` gates the children recursion at `MAX_DEPTH`.                                                                                                                                                                                                                                                                                                                     |
| `scanInline`            | function | `(source: string, from: number, to: number, depth = 0) => readonly InlineNode[]`                     | The recursive inline-scanning engine (emphasis / link text recurse through it); linear-time, no backtracking. See [depth degrade](#depth-degrade-semantics).                                                                                                                                                                                                                                                                                   |
| `collectTable`          | function | `(lines: readonly string[], start: number) => { node: TableNode, next: number }`                     | Collects a GFM table starting at its header row (header + delimiter + contiguous body rows). Cell content recurses through `parseInline`.                                                                                                                                                                                                                                                                                                      |
| `collectList`           | function | `(lines: readonly string[], start: number, depth: number) => { node: ListNode, next: number }`       | Collects a list starting at its first item, gathering same-indent siblings and recursing each item's block content through `parseBlocks`.                                                                                                                                                                                                                                                                                                      |
| `markdownToHTML`        | function | `(node: MarkdownNode) => HTMLDocument`                                                               | Pure, UNSANITIZED projection of any `MarkdownNode` onto the `@orkestrel/html` AST — text and destinations stay literal so the caller picks the HTML policy (§ [Sanitization policy](#sanitization-policy)).                                                                                                                                                                                                                                    |
| `renderHTML`            | function | `(node: MarkdownNode) => string`                                                                     | Composes `markdownToHTML` with `@orkestrel/html`'s sanitize floor and serializer into one sanitized string. One argument, no options, no opt-out; the attribute allowlist is widened by exactly `src`.                                                                                                                                                                                                                                         |
| `renderMarkdown`        | function | `(node: MarkdownNode) => string`                                                                     | Renders any `MarkdownNode` to CANONICAL markdown source — the inverse of `parseDocument`, and the basis of the `parseDocument`↔`renderMarkdown` round-trip (§ [`renderMarkdown` round-trip](#rendermarkdown-round-trip)). Never throws.                                                                                                                                                                                                        |
| `htmlToMarkdown`        | function | `(node: HTMLNode) => MarkdownDocument`                                                               | Projects an `@orkestrel/html` node to a markdown document — the inverse of `markdownToHTML`, folded by html's own `foldNode`. Re-sanitizes every `href` / `src`, drops every `UNSAFE_ELEMENTS` subtree whole, and emits canonical shapes so the projection re-parses to itself (§ [`htmlToMarkdown` projection](#htmltomarkdown-projection)).                                                                                                  |
| `trimInlines`           | function | `(nodes: readonly InlineNode[]) => readonly InlineNode[]`                                            | Trims the whitespace at the two ends of a coalesced inline run, dropping an edge text node that trims away.                                                                                                                                                                                                                                                                                                                                    |
| `normalizeInlines`      | function | `(nodes: readonly InlineNode[], breaks: boolean) => readonly InlineNode[]`                           | Reduces an inline run to what markdown can write back: text coalesced, empty text dropped, and each hard break kept as a real line ending or (when `breaks` is `false`, as in a heading or a cell) spent as a space.                                                                                                                                                                                                                           |
| `mergeProjections`      | function | `(children: readonly MarkdownProjection[]) => MarkdownProjection`                                    | Combines one node's children into its own projection — the single place an inline run becomes a paragraph, in source order.                                                                                                                                                                                                                                                                                                                    |
| `projectHTMLLeaf`       | function | `(leaf: CommentNode \| DoctypeNode \| HTMLTextNode) => MarkdownProjection`                           | Projects one HTML leaf: text with its whitespace runs collapsed (its raw value kept for code), a comment and a doctype to nothing. Its text parameter is html's `TextNode`, imported as `HTMLTextNode` here because markdown has a `TextNode` of its own.                                                                                                                                                                                      |
| `projectHTMLNode`       | function | `(node: ElementNode \| HTMLDocument, children: readonly MarkdownProjection[]) => MarkdownProjection` | THE HTML-to-markdown element mapping: which markdown node each HTML tag becomes, with every other element unwrapped to its children and every `UNSAFE_ELEMENTS` subtree dropped whole.                                                                                                                                                                                                                                                         |
| `projectionToBlocks`    | function | `(projection: MarkdownProjection) => readonly BlockNode[]`                                           | Reads a projection as block content: a bare inline run becomes one paragraph, a blank run becomes nothing, and a cell or row that never reached a table unwraps.                                                                                                                                                                                                                                                                               |
| `projectionToInlines`   | function | `(projection: MarkdownProjection) => readonly InlineNode[]`                                          | Reads a projection as inline content: inline content passes through, block content flattens to one whitespace-collapsed text node.                                                                                                                                                                                                                                                                                                             |
| `walkNodes`             | function | `(node: MarkdownNode) => Generator<MarkdownNode>`                                                    | Depth-first, pre-order, root-inclusive traversal — yields the node itself then its children. `Markdown.find` / `filter` / `reduce` / iteration all walk through this.                                                                                                                                                                                                                                                                          |
| `foldNode`              | function | `<T>(node: MarkdownNode, handlers: MarkdownHandlers<T>, depth: number) => T`                         | The total catamorphism `Markdown.fold` delegates to — children folded first (post-order), then the node's own handler runs with the already-folded children. The `table` handler is NOT a leaf: it receives one folded `T` per inline node, flattened across all cells (header cells first in column order, then body rows' cells in row-then-column order) — recover cell boundaries from `node.header[c].length` / `node.rows[r][c].length`. |
| `rewriteDocument`       | function | `(document: MarkdownDocument, rewrite: MarkdownRewriteHandler) => MarkdownDocument`                  | The bottom-up (copy-on-write) rewrite `Markdown.map` delegates to — the document root is never itself passed to `rewrite`. Capped at `MAX_DEPTH`: a subtree at the cap passes through unchanged instead of recursing further.                                                                                                                                                                                                                  |
| `flattenText`           | function | `(node: MarkdownNode) => string`                                                                     | Concatenates the `value`/`code` content of every descendant text/code-span/code-block node, in walk order — a plain-text projection of an AST.                                                                                                                                                                                                                                                                                                 |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`) from [`shapers.ts`](../src/core/shapers.ts) — one shape compiles into a guard, coercing parser, JSON Schema, and seeded generator (the compilers live in `@orkestrel/contract`, invoked here via `createContract` in `factories.ts`). Only the NON-recursive node types shape here; any type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` stays guard-only (`validators.ts`, via `lazyOf`) — see [Relationship with @orkestrel/contract](#relationship-with-orkestrelcontract).

| Shaper               | Kind  | Builds                                                                                                  |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `textShape`          | const | The shape of a `TextNode` — `{ element: 'text', value: string }`.                                       |
| `codeSpanShape`      | const | The shape of a `CodeSpanNode` — `{ element: 'codeSpan', value: string }`.                               |
| `lineBreakShape`     | const | The shape of a `LineBreakNode` — `{ element: 'break' }`, no fields beyond the discriminant.             |
| `codeBlockShape`     | const | The shape of a `CodeBlockNode` — `{ element: 'codeBlock', lang?: string, code: string }`.               |
| `thematicBreakShape` | const | The shape of a `ThematicBreakNode` — `{ element: 'thematicBreak' }`, no fields beyond the discriminant. |
| `tableAlignShape`    | const | The shape of a `TableAlign` literal — `'left' \| 'right' \| 'center'`; absence is not a member.         |
| `listItemMatchShape` | const | The shape of `ListItemMatch` — fully non-recursive, every field shapes directly.                        |

### Validators

Line/character structural predicates plus node guards, from [`validators.ts`](../src/core/validators.ts). The structural predicates test raw strings during parsing; the `is{Element}Node` guards narrow an ALREADY-PARSED `MarkdownNode` by its `element` tag; the from-unknown guards (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) instead validate an arbitrary `unknown` value against the full node shape, composed from `@orkestrel/contract` combinators. Two distinct guard families: the **from-unknown boundary guards** (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) take `unknown` and validate an entire untrusted value from scratch; the **narrowing guards** (`is{Element}Node`, e.g. `isTableNode`) take an already-typed `MarkdownNode` and narrow it to one member of the union by its `element` tag — they assume the value is already a valid node shape.

| Guard                 | Kind     | Narrows to / Tests                                 | Behavior                                                                                                                                                   |
| --------------------- | -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isWhitespace`        | function | `character: string`                                | `true` for space / tab / newline — the emphasis flanking rule's space test.                                                                                |
| `isEscapable`         | function | `character: string`                                | `true` for a character a leading backslash can escape (ASCII markdown punctuation).                                                                        |
| `isBlankLine`         | function | `line: string`                                     | `true` when `line` is empty or contains only whitespace — the markdown blank-line rule used to separate paragraphs, skip gaps, and end list continuations. |
| `isQuote`             | function | `line: string`                                     | `true` when `line` opens a blockquote (`>` optionally indented up to 3 spaces).                                                                            |
| `isFenceClose`        | function | `(line: string, marker: string)`                   | `true` when `line` closes a fence opened by `marker` (same character, run at least as long).                                                               |
| `isFenceWhitespace`   | function | `character: string \| undefined`                   | `true` for a regex-`\s`-equivalent whitespace character (fence-close padding).                                                                             |
| `isThematicBreak`     | function | `line: string`                                     | `true` for 3+ of the same `-`/`*`/`_` marker (optionally space-separated) and nothing else.                                                                |
| `isTableStart`        | function | `(header: string, delimiter: string \| undefined)` | `true` when the pair opens a GFM table (delimiter row of `:?-+:?` cells).                                                                                  |
| `isHeadingNode`       | function | `node: MarkdownNode`                               | Narrows to `HeadingNode` — `node.element === 'heading'`.                                                                                                   |
| `isParagraphNode`     | function | `node: MarkdownNode`                               | Narrows to `ParagraphNode`.                                                                                                                                |
| `isListNode`          | function | `node: MarkdownNode`                               | Narrows to `ListNode`.                                                                                                                                     |
| `isTableNode`         | function | `node: MarkdownNode`                               | Narrows to `TableNode`.                                                                                                                                    |
| `isCodeBlockNode`     | function | `node: MarkdownNode`                               | Narrows to `CodeBlockNode`.                                                                                                                                |
| `isBlockquoteNode`    | function | `node: MarkdownNode`                               | Narrows to `BlockquoteNode`.                                                                                                                               |
| `isThematicBreakNode` | function | `node: MarkdownNode`                               | Narrows to `ThematicBreakNode`.                                                                                                                            |
| `isTextNode`          | function | `node: MarkdownNode`                               | Narrows to `TextNode`.                                                                                                                                     |
| `isEmphasisNode`      | function | `node: MarkdownNode`                               | Narrows to `EmphasisNode`.                                                                                                                                 |
| `isCodeSpanNode`      | function | `node: MarkdownNode`                               | Narrows to `CodeSpanNode`.                                                                                                                                 |
| `isLineBreakNode`     | function | `node: MarkdownNode`                               | Narrows to `LineBreakNode`.                                                                                                                                |
| `isLinkNode`          | function | `node: MarkdownNode`                               | Narrows to `LinkNode`.                                                                                                                                     |
| `isImageNode`         | function | `node: MarkdownNode`                               | Narrows to `ImageNode`.                                                                                                                                    |
| `isInlineNode`        | const    | `Guard<InlineNode>`                                | Total from-unknown guard: text / emphasis / code span / hard break / link / image, recursively validated via `lazyOf`.                                     |
| `isBlockNode`         | const    | `Guard<BlockNode>`                                 | Total from-unknown guard: heading / paragraph / list / table / code block / blockquote / thematic break.                                                   |
| `isMarkdownNode`      | const    | `Guard<MarkdownNode>`                              | Total from-unknown guard: the document root, a block node, a list item, or an inline node.                                                                 |
| `isMarkdownDocument`  | const    | `Guard<MarkdownDocument>`                          | Total from-unknown guard: `{ element: 'document', children: readonly BlockNode[] }`.                                                                       |

### `Markdown`

The implementing class of `MarkdownInterface`, from [`Markdown.ts`](../src/core/Markdown.ts). A stateful, parsed markdown workspace: constructed from a markdown `string` (runs `parseDocument`) or an already-parsed `MarkdownDocument` (adopted AS-IS, not re-validated). Exposes its AST through the `readonly document` member (documented here in Surface prose, per the `ContractInterface` precedent, alongside `walk` — both are part of the documented surface even though `document` carries no row in the [`## Methods`](#methods) table below, which lists only call-signature members). `walk` is the deep traversal — a lazy, depth-first, pre-order, root-inclusive generator over every node; its sync `for (const node of markdown.walk())` surface is also consumable by `for await (const node of markdown.walk())` (JavaScript accepts a sync iterable in a `for await`), so an async pipeline needs no separate iterator. Contrast with `stream`: `walk` is deep (every node) and sync; `stream` is shallow (top-level blocks only) and backpressure-respecting. Immutable — `map` never mutates the stored AST, it returns a new `Markdown`. See [`## Methods`](#methods) for its public call-signature surface.

### Factories

From [`factories.ts`](../src/core/factories.ts).

| Factory                       | Kind     | Signature                                                     | Behavior                                                                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `createMarkdown`              | function | `(input: string \| MarkdownDocument) => MarkdownInterface`    | Creates a `Markdown` workspace from a markdown string (parses it) or an already-parsed document (adopted as-is). |
| `createProjection`            | function | `(parts?: Partial<MarkdownProjection>) => MarkdownProjection` | Creates a complete projection, defaulting absent fields and flushing `inlines` whenever `blocks` is non-empty.   |
| `createTextContract`          | function | `() => ContractInterface<TextNode>`                           | Compiles `textShape` into a guard / parser / schema / generator bundle.                                          |
| `createCodeSpanContract`      | function | `() => ContractInterface<CodeSpanNode>`                       | Compiles `codeSpanShape` into a guard / parser / schema / generator bundle.                                      |
| `createLineBreakContract`     | function | `() => ContractInterface<LineBreakNode>`                      | Compiles `lineBreakShape` into a guard / parser / schema / generator bundle.                                     |
| `createCodeBlockContract`     | function | `() => ContractInterface<CodeBlockNode>`                      | Compiles `codeBlockShape` into a guard / parser / schema / generator bundle.                                     |
| `createThematicBreakContract` | function | `() => ContractInterface<ThematicBreakNode>`                  | Compiles `thematicBreakShape` into a guard / parser / schema / generator bundle.                                 |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name (AGENTS §22). The `readonly document` member is Surface-documented above, not listed here — this table lists exactly `MarkdownInterface`'s call-signature members.

#### `MarkdownInterface`

| Method   | Returns                                   | Behavior                                                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walk`   | `Generator<MarkdownNode>`                 | THE deep traversal — a lazy, depth-first, pre-order, root-inclusive generator over every node. The sync `for…of` surface is also consumable by `for await…of` (no separate async iterator needed).                                                                                                    |
| `find`   | `T \| MarkdownNode \| undefined`          | Finds the first node (depth-first, pre-order), narrowed by a type guard or matched by a predicate. `undefined` when nothing matches.                                                                                                                                                                  |
| `filter` | `readonly T[] \| readonly MarkdownNode[]` | Collects every node (depth-first, pre-order), narrowed by a type guard or matched by a predicate.                                                                                                                                                                                                     |
| `map`    | `MarkdownInterface`                       | Rewrites the AST bottom-up (copy-on-write) via a `MarkdownRewriteHandler` and returns a NEW `MarkdownInterface`; never mutates the original.                                                                                                                                                          |
| `reduce` | `T`                                       | Folds the AST depth-first, pre-order into an accumulator via a plain reducer callback.                                                                                                                                                                                                                |
| `fold`   | `T`                                       | Runs a total catamorphism over the document using a `MarkdownHandlers<T>` table (one handler per AST element).                                                                                                                                                                                        |
| `stream` | `ReadableStream<BlockNode>`               | A fresh, web-standard, pull-based stream over the document's top-level block nodes only (shallow, source order) — NOT a deep traversal. One block is enqueued per `pull`, so a slow consumer's backpressure is respected; cancellable, and pipeable through any `TransformStream` / `WritableStream`. |

## The AST model

Every node is plain, readonly data with no behavior — a discriminated union keyed by `element` (never `kind` / `type`, AGENTS §4.4). Two families:

- **Block nodes** (`BlockNode`) carry document structure: `heading`, `paragraph`, `list` (of `listItem`s), `table`, `codeBlock`, `blockquote`, `thematicBreak`. A `MarkdownDocument` is the root — `{ element: 'document', children: readonly BlockNode[] }`.
- **Inline nodes** (`InlineNode`) carry the inline content of a heading / paragraph / list item / table cell: `text`, `emphasis` (nests further inline children — `**bold _and italic_**` is a strong node wrapping a text node and an emphasis node), `codeSpan` (verbatim, no inner markdown), `break` (a GFM hard line break), `link` (nests inline children for its text), and `image`.

Recursion in the AST is structural, not incidental: a `blockquote`'s `children` re-parse the de-quoted lines as blocks (so quotes nest), a `list`'s `items` each carry `BlockNode[]` (so a nested list is just a `list` block inside a `listItem`'s children), and `emphasis` / `link` / `image` nest `InlineNode[]`. `MarkdownNode` is the exhaustive union every projection's `switch` covers: `MarkdownDocument | BlockNode | ListItemNode | InlineNode`.

### Images and hard breaks

An `ImageNode` carries its destination in `src` and its ALTERNATIVE content in `children`, exactly as a `LinkNode` carries `href` and its text — an image is a link that renders its target rather than pointing at it, and giving alt text the same inline children a link's text has means `walk`, `filter`, `map`, `fold`, and `flattenText` reach it without a special case. HTML's `alt` is a flat attribute, so the two directions meet in the middle: `markdownToHTML` writes `alt` from `flattenText`, and `htmlToMarkdown` reads `alt` back into a single text child.

Two syntax hazards come with them. An image is written `![alt](src)`, which is a `!` immediately followed by link syntax — so a `text` node that ENDS in `!` directly before a link would re-parse as an image it never was, and `renderMarkdown` backslash-escapes exactly that `!` and no other. A hard break is written as two trailing spaces before a newline, which is invisible and fragile: a break at either edge of a run has no line to end, a run of breaks reads as the blank line that would end the paragraph, and adjacent whitespace is eaten by line trimming. `renderMarkdown` writes what the AST holds, so keeping a break WRITABLE is the producer's job: `normalizeInlines` is the shared leaf that drops, merges, and trims breaks into the one shape markdown can carry, and spends a break as the space it stood for wherever the target is a single line (a heading, a table cell). The inbound projection runs every inline run through it for exactly that reason.

### Alignment and absence

`TableAlign` is `'left' | 'right' | 'center'` — three real GFM delimiter forms, and nothing else. A column that declares no alignment is an ABSENCE, not a fourth mode, and the two places absence appears differ because their containers differ:

- `TableNode.align` is positional — one entry per column, in column order — and JSON cannot carry `undefined` inside an array without changing the array's length on a round trip. It uses `null`, which is also the honest reading of the source: GFM's bare `---` is an explicit "no alignment here" marker written by the author, not an omitted field.
- `MarkdownCell.align` is a plain optional property on one cell, so absence is `undefined` there, per the ordinary rule.

`renderHTML` emits an `align` attribute only for the three literals; a `null` column emits no attribute at all. `renderMarkdown` writes `:---` / `---:` / `:---:` for them and a bare `---` for `null`, so the delimiter row round-trips exactly.

## The parse pipeline

`parseDocument(markdown)` runs two phases:

1. **Block phase** — splits the document into lines (`splitLines`, CRLF/CR normalized) and walks them, detecting fences, thematic breaks, ATX headings, blockquotes, GFM tables, and lists (`parseBlocks`, `collectTable`, `collectList`); anything left over collects into a paragraph. `startsBlock` lets a new block interrupt a paragraph without a separating blank line.
2. **Inline phase** — each block's raw text runs through `scanInline` (backslash escapes, code spans, links, images, emphasis, and the two-trailing-space hard break) via `parseInline`, then `coalesceText` merges adjacent text runs.

`new Markdown(markdown)` (or `createMarkdown(markdown)`) calls `parseDocument` internally and stores the result as its `document`. `markdownToHTML(node)`, `renderHTML(node)`, and `renderMarkdown(node)` are **separate**, downstream, standalone projections out of an AST — never fused into parsing, so a caller can inspect, transform, or fold the AST (via `Markdown`'s `find` / `filter` / `map` / `reduce` / `fold`) before ever calling one, or never call one at all. `htmlToMarkdown(node)` is the standalone projection IN, and produces the same `MarkdownDocument` shape `parseDocument` does, so everything downstream of a parse works identically on a projection.

**Total / never-throw.** `parseDocument`, `markdownToHTML`, `renderHTML`, `renderMarkdown`, and `htmlToMarkdown` are all total functions: malformed markdown degrades to literal text (an unterminated `**` stays literal, a broken table falls back to a paragraph) rather than throwing, and hostile, cyclic, or pathologically deep HTML degrades rather than throwing. Inline scanning is index-based (no backtracking regex), so it is linear-time — no ReDoS on adversarial input.

### Depth degrade semantics

`MAX_DEPTH` (`64`) bounds several independent recursions, each degrading to a fixed, cheap fallback instead of recursing further:

- **Block recursion** (blockquote / list nesting, `parsers.ts`'s `parseBlocks`) — past the cap, the remaining lines collapse into **one literal paragraph** containing those lines joined by `\n`, instead of continuing to parse nested structure.
- **Inline recursion** (`scanInline`, and the `depth` threaded through `scanLink` / `scanEmphasis`) — past the cap, the scan window is not scanned for markup at all; it emits as a **single literal text node**.
- **`markdownToHTML` / `renderHTML` recursion** — past the cap, a node is not projected structurally; it yields a text node carrying the `value` of a node that has one (a `TextNode`, `CodeSpanNode`, …), and **nothing at all** for a node with no `value` field. A table reserves the four levels its `thead` / `tbody` / `tr` / cell scaffolding costs and contributes nothing when they would not fit, and a code block reserves the two its `pre > code` costs, so generated structure is charged to the same budget as authored structure and cannot escape the cap. The internal `switch` also carries a `default` arm, so a fabricated node with an `element` outside the exhaustive set (bypassing the type system, e.g. via an untyped/deserialized value) contributes nothing rather than `undefined` — the projection is total even against a hostile `MarkdownNode`.
- **`renderMarkdown` recursion** — the same cap and the same value-bearing-vs-empty degrade rule, applied to canonical markdown source instead of HTML.
- **`walkNodes` / `foldNode` recursion** — descent stops at the cap; the node AT the cap is still yielded/folded (with an empty children list for `foldNode`), its children are not.
- **`rewriteDocument` / `Markdown.map` recursion** — the same cap, shared by both (`map` delegates to `rewriteDocument`): at the cap, the subtree is passed through UNCHANGED (by reference — not rebuilt, and `rewrite` is not invoked on it) instead of recursing further, so a pathologically deep adopted document cannot exhaust the call stack.
- **`htmlToMarkdown` recursion — the one INHERITED cap.** This is the only recursion here markdown does not own: the fold is `@orkestrel/html`'s `foldNode`, so its depth bound is html's, and html happens to cap at `64` as well. Nesting past it truncates on html's side before markdown ever sees the content, and because the projected chain can end a level or two deeper than `MAX_DEPTH`, `renderMarkdown` may then truncate the result a second time. Deeply nested HTML is therefore bounded by TWO caps in sequence rather than one: the anchor law below holds within the depth budget, and beyond it only totality is promised.

Together these bound pathological or hostile input (deeply nested blockquotes, runaway emphasis, adversarially deep ASTs) so no parsing, projecting, or writing function can ever exhaust the call stack.

## Sanitization policy

There is one URL floor here, and markdown does not own it. `@orkestrel/html` owns HTML escaping, scheme judgement, and the sanitize floor; this package holds no escaper, no scheme list, and no sanitizer of its own, and composes with html's instead. A second copy would be a second thing to keep correct, and the failure mode of a sanitizer that has drifted from the one it was copied from is silent.

**`renderHTML` sanitizes, unconditionally.** It takes ONE argument and exposes no options, so there is no call shape that emits unsanitized HTML by accident:

```text
markdownToHTML(node) → new HTML(document).sanitize({ attributes: [...SAFE_ATTRIBUTES, 'src'] }) → renderHTML(document)
```

Only the middle step judges anything. `markdownToHTML` is deliberately inert: it leaves text literal and destinations unsanitized so that the projection stays a pure AST-to-AST mapping and a caller who wants a different policy can supply one. Everything that makes the output safe comes from html's floor, which no option can lower: an `UNSAFE_ELEMENTS` subtree (`script`, `style`, `template`, `svg`, forms, metadata) is removed WHOLE rather than unwrapped, so its body can never resurface as markup; every `on*` handler attribute and `style` / `srcdoc` / namespaced attribute is removed; a URL attribute is entity-decoded to a bounded fixpoint and stripped of ASCII whitespace and control characters BEFORE its scheme is checked, and `javascript:`, `data:`, `vbscript:`, `file:`, and the protocol-relative forms (`//`, `\\`, `/\`) are refused whatever the allowlist says. This is defence-in-depth: `renderHTML` accepts any `MarkdownNode`, including one a caller constructed by hand, rewrote via `map`, or accepted from elsewhere, so it can never assume its input came from `parseDocument` on trusted markdown.

**The one widening: `src`.** html's `SAFE_ATTRIBUTES` deliberately omits resource `src`, because a sanitized page that keeps its `alt` text and loses its download is the safer default for a general HTML sanitizer. Markdown cannot accept that default — `![alt](src)` is syntax whose entire content is a destination — so `renderHTML` widens the attribute allowlist by exactly `src`, and by nothing else. The widening is narrow by construction: `src` is a member of html's `URL_ATTRIBUTES`, so every widened value still goes through `sanitizeURL`, and the hard refusals are not part of the allowlist axis at all and cannot be widened by anyone. A refused image keeps its element and its alt text and loses only the destination.

**What the composed output looks like.** Four differences are worth stating plainly, because they are visible in any byte-level comparison against a hand-rolled markdown renderer:

- **`align`, not `style`.** A table cell declares alignment as `align="left"`, not `style="text-align:left"`. html strips `style` unconditionally before any allowlist check, so a style-carrying cell would arrive at the browser with its alignment silently gone; `align` survives because html narrows it to the closed `TABLE_ALIGNMENTS` set on table cells only.
- **Literal quotes in text.** html's text encoder emits `&`, `<`, and `>` and leaves `"` and `'` alone, which is correct for character data and keeps prose readable: `alert("x" & 'y')` renders as `alert("x" &amp; 'y')`. Attribute values are encoded separately and do get their quotes handled.
- **Compact bytes.** Canonical serialization writes no whitespace between blocks: `# Hi\n\nText.` renders as `<h1>Hi</h1><p>Text.</p>`, not as two newline-separated lines.
- **A refused URL loses the whole attribute.** html removes a URL attribute it refuses rather than emptying it, so a hostile link renders `<a>x</a>` and a hostile image `<img alt="x">` — the words survive, the attribute does not appear at all.

**The inbound rule is different, and that asymmetry is deliberate.** Outbound, sanitizing at the very end is right: `markdownToHTML` can stay inert because `renderHTML` is the only door to a string and it always sanitizes. Inbound there is no such door. `htmlToMarkdown` produces a `MarkdownDocument`, and the serializer that document eventually reaches — `renderMarkdown` — is NOT a sanitization boundary and must not become one: it writes markdown source, where a destination is content rather than an executed attribute, and where a value dropped late could not be told apart from a value the author wrote. So the projection bakes html's `sanitizeURL(value, SAFE_URL_SCHEMES)` in at PROJECTION time, on every `href` and every `src`, whether or not the AST was ever sanitized — a hand-built one never was. A refused destination empties to `''` and the link or image is KEPT (`[text]()`), because a bad URL is no reason to lose the words around it. Two pipelines, two last responsible moments; the rule sits at each one rather than in the same place twice.

**Wanting a stricter policy.** Because the composition is exposed rather than hidden, a caller who needs a narrower floor does not need an option on `renderHTML`: project with `markdownToHTML`, sanitize with `@orkestrel/html`'s own `HTML` class and whatever `SanitizeOptions` they want, and serialize with html's `renderHTML`. That path can narrow the element set, drop `src` again, or replace the scheme list — and it still cannot go below html's floor, which is the point. The inbound counterpart is [bringing your own element policy](#bringing-your-own-element-policy): the same composition seam placed where that direction's element mapping varies.

## `renderMarkdown` round-trip

`renderMarkdown` is the inverse of `parseDocument`: for any `MarkdownDocument` produced by `parseDocument`, `parseDocument(renderMarkdown(doc))` deep-equals `doc`, and `renderMarkdown` is idempotent — `renderMarkdown(parseDocument(renderMarkdown(doc))) === renderMarkdown(doc)`. It writes every node to one CANONICAL markdown form, never the source's original (possibly variant) spelling:

| Construct          | Canonical form                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Emphasis           | One marker family per nesting parity: `*em*` / `**strong**` at even emphasis depth, `_em_` / `__strong__` at odd. See below.              |
| Bulleted list item | `- ` (a single hyphen + space), regardless of source marker (`*` / `+`).                                                                  |
| Ordered list item  | `N. ` — sequential ordinals starting from the list's `start`, `.`-style (never `)`)                                                       |
| Thematic break     | `---`, regardless of source marker (`***` / `___` / spaced variants).                                                                     |
| Fenced code block  | Backtick fences, widened past any 3+ backtick run already inside the body.                                                                |
| Blockquote         | `> `-prefixed lines (`>` alone for an otherwise-empty line).                                                                              |
| GFM table          | 1-space-padded cells, `\|`-escaped literal pipes, an explicit alignment delimiter row (bare `---` for a `null` column).                   |
| Link               | `[text](href)` — `href` with `\`, `(`, `)` backslash-escaped (mirroring the parser's unescape) so a paren in the destination round-trips. |
| Image              | `![alt](src)` — `src` escaped exactly like a link `href`, alt written from the image's inline children.                                   |
| Hard break         | Exactly two spaces then a newline, and only where a line can end (see [Images and hard breaks](#images-and-hard-breaks)).                 |
| Block separation   | Exactly ONE blank line between top-level blocks; a document with zero blocks renders `''`.                                                |

Sanitization is not a markdown-writing concern and does not appear in that table. A destination that needed judging was judged earlier — by html's floor on the way out to HTML, or by `htmlToMarkdown` on the way in — so `renderMarkdown` writes what the AST holds and escapes only what re-parsing requires.

**Why emphasis alternates.** A single canonical marker would be canonical and wrong: `**b *c***` closes ambiguously, because three identical markers in a row have more than one reading. Alternating families by nesting parity removes the ambiguity structurally — a nested run never shares a delimiter with the run enclosing it, so `**b _c_**` and `*x _a **c** b_ y*` each have exactly one parse. The form is still canonical in the sense that matters: it is a function of the AST's emphasis depth alone, never of the source's original spelling, so `_a **c** b_` and `*a __c__ b*` both write as `*a __c__ b*` and re-parse to the same tree.

A `text` node's literal content is backslash-escaped wherever it would otherwise re-parse as different markup (a leading `#`, a leading list marker, a leading `---` / `~~~` run, a literal `*`/`_`/`` ` ``/`[`/`]`, a trailing `!` before a link); a heading whose inline text ends in a `#` run (with or without leading whitespace) has that run's FIRST `#` backslash-escaped so it cannot be mistaken for an ATX closing sequence on reparse — the round-trip soundness AGENTS §14 requires between a parser and its inverse.

This guarantee is scoped to documents `parseDocument` produced (or an equivalent well-formed `MarkdownDocument`). A value fabricated via `map` (or constructed by hand) that stuffs block-significant content or an embedded newline into a node field `renderMarkdown` treats as literal text (a `TextNode.value`, a `LinkNode.href`, …) has NO round-trip guarantee — `renderMarkdown` still never throws, but the resulting source is not guaranteed to reparse back to the same AST.

## `htmlToMarkdown` projection

`htmlToMarkdown` is the inbound direction: an `@orkestrel/html` `HTMLNode` in, a `MarkdownDocument` out, structurally identical to one `parseDocument` produces. It lives here rather than in html for the same reason `markdownToHTML` does — deciding that a `<pre>` is a fenced code block, that a `<div>` is nothing at all, and that a `<td>` holding two paragraphs must become one line of text is markdown-format knowledge, and html has no business carrying it.

**The engine is borrowed, the projection is not.** The traversal is html's own `foldNode` catamorphism, driven by a total five-key handler table: `projectHTMLNode` for the two containers (`document`, `element`) and `projectHTMLLeaf` for the three leaves (`text`, `comment`, `doctype`). That is a deliberate reuse rather than a rebuild: html's fold already owns bottom-up ordering, cycle termination, and depth capping over its own AST, and reimplementing them here would mean maintaining a second, subtly different traversal of somebody else's data structure. What this package contributes is the fold VALUE and the element mapping.

**The fold value is `MarkdownProjection`.** A node cannot know what it will become, because markdown decides late: a `<td>`'s content is inline inside a table and a paragraph outside one, and a `<code>` body is a code span in prose and a verbatim block under a `<pre>`. Rather than guess, every node reports each view an ancestor could want, and the ancestor that knows the context takes the one it needs:

| Field     | What it carries                                                     | Who consumes it                                  |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| `blocks`  | block content, with surrounding inline runs already made paragraphs | a document, a `blockquote`, an `li`              |
| `inlines` | inline content; empty whenever `blocks` is not                      | a link, an emphasis, a table cell                |
| `text`    | raw subtree text — whitespace uncollapsed, escapes unresolved       | a `code` span, a `pre > code` body               |
| `cells`   | the cells this node gives an enclosing row                          | a `tr`                                           |
| `rows`    | the rows this node gives an enclosing table                         | a `table`, through the `thead` / `tbody` between |

`blocks` and `inlines` are exclusive by construction — `mergeProjections` wraps a pending inline run into a paragraph the moment any sibling contributes a block, at that exact source position — so interleaving is never lost and no ancestor has to decide the same question twice. `projectionToBlocks` and `projectionToInlines` are the two readers, and `createProjection` is the one constructor that enforces the exclusivity invariant.

**The element mapping** is `projectHTMLNode`, and it is the only place that decides what an HTML tag becomes:

| HTML                          | Markdown                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `h1`–`h6`                     | a heading at that level                                                                                                    |
| `p`, `li`                     | their block content, with a bare inline run wrapped in a paragraph                                                         |
| `blockquote`                  | a blockquote over that same block view                                                                                     |
| `hr`, `br`                    | a thematic break, a hard break                                                                                             |
| `strong` / `b`, `em` / `i`    | strong and ordinary emphasis; whitespace padding moves OUTSIDE the markers, since markdown refuses `* x *`                 |
| `code`                        | a code span, from the raw subtree text with newline runs collapsed to one space                                            |
| `pre`                         | a code block: verbatim through a first `code` element child (its `language-` class naming the language), else `renderText` |
| `a`, `img`                    | a link and an image, each destination re-sanitized; an `img`'s `alt` becomes one text child                                |
| `ul` / `ol`                   | a list, ordered from the tag and numbered from `start`; one item per `li`, so an empty `li` is still an item               |
| `th` / `td`, `tr`, `table`    | a cell (alignment from its `align`), a row, and a GFM table whose header is the first `th`-bearing row                     |
| any `UNSAFE_ELEMENTS` element | nothing at all, text included                                                                                              |
| anything else                 | unwraps to its children                                                                                                    |

Three of those read their own node rather than only their children's projections, because HTML puts the fact in a position rather than in a value: a `pre` takes its body from its `code` child's raw text, a list takes one item per `li` child, and a `tr` accepts only its own direct cells while a `table` derives the header row from its own source structure.

**The anchor law.** HTML is richer than markdown, so bytes cannot round-trip and the input document is the wrong fixpoint to promise. The right one is the projected AST:

```text
parseDocument(renderMarkdown(htmlToMarkdown(x))) deep-equals htmlToMarkdown(x)
```

Whatever the projection emits, markdown can write it and re-read it as the same tree. That is why the projection normalizes rather than translates literally — whitespace collapsed, edges trimmed, a blank paragraph dropped, a hard break kept only where a line can end, an emphasis's padding moved outside its markers: a shape markdown cannot write back is a shape this projection has no business producing. The law is proved over a corpus with one entry per construct the projection can emit, and again over the whole corpus concatenated into one document.

**What it loses, honestly.** The projection is lossy by construction, and these are the losses worth knowing before you rely on it:

- **Comments and doctypes vanish.** Neither carries anything markdown can represent, so both project to nothing.
- **Unknown wrappers unwrap.** An element with no markdown meaning contributes its children and disappears, so `<section><div>text</div><p>para</p></section>` keeps two blocks and loses two tags. Wrapper soup melts; content keeps its shape.
- **`UNSAFE_ELEMENTS` subtrees contribute nothing at all — text included.** A `<script>` body is not prose that lost its tag; it is content that never existed. Dropping the subtree whole is what stops it resurfacing.
- **Block content in a table cell flattens.** Markdown has no way to put a paragraph inside a cell, so a cell's blocks become one text node of their words, joined and whitespace-collapsed: a `<td>` holding `<p>a</p><p>b</p>` becomes the cell `a b`.
- **Presentation generally.** Attributes outside the small set the mapping reads (`href`, `src`, `alt`, `class` for a code language, `align` on a cell, `start` on an `ol`) have no markdown home and are not preserved.

Depth is the one bound markdown does not set here; see the inherited cap in [Depth degrade semantics](#depth-degrade-semantics).

### Bringing your own element policy

`projectHTMLNode` and `projectHTMLLeaf` are exported as handlers, not hidden inside `htmlToMarkdown`, precisely so that the element mapping is replaceable without forking the projection. The vocabulary a replacement needs is exported alongside them: `createProjection` builds one with the exclusivity invariant enforced, `mergeProjections` combines a node's children into it, `projectionToBlocks` and `projectionToInlines` read one back out, and `trimInlines` and `normalizeInlines` reduce an inline run to a shape markdown can actually write. So a caller with a house rule — an element markdown has no opinion about, a wrapper that should become a blockquote, a `<kbd>` that reads better as code — writes one handler, delegates everything else to the default, and folds with html's `foldNode` exactly as `htmlToMarkdown` does:

The outbound counterpart is the stricter-policy recipe in [Sanitization policy](#sanitization-policy): the same composition seam placed where that direction's sanitize floor varies.

```ts
import type { ElementNode, HTMLDocument, HTMLNode } from '@orkestrel/html'
import type { MarkdownDocument, MarkdownProjection } from '@orkestrel/markdown'
import { foldNode, parseDocument as parseHTML } from '@orkestrel/html'
import {
	createProjection,
	mergeProjections,
	projectHTMLLeaf,
	projectHTMLNode as projectDefaultHTMLNode,
	projectionToBlocks,
	renderMarkdown,
} from '@orkestrel/markdown'

// House rule: <kbd>Esc</kbd> reads as a code span. Every other element keeps the default.
function projectHTMLNode(
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
	return projectDefaultHTMLNode(node, children)
}

function project(node: HTMLNode): MarkdownDocument {
	return {
		element: 'document',
		children: projectionToBlocks(
			foldNode<MarkdownProjection>(node, {
				document: projectHTMLNode,
				element: projectHTMLNode,
				text: projectHTMLLeaf,
				comment: projectHTMLLeaf,
				doctype: projectHTMLLeaf,
			}),
		),
	}
}

renderMarkdown(project(parseHTML('<p>Press <kbd>Esc</kbd> twice.</p>'))) // 'Press `Esc` twice.'
```

The custom policy inherits everything the default has: the same fold, the same depth bound, the same totality, and the same anchor law for every element it did not override.

## Relationship with `@orkestrel/contract`

Markdown's validation surface is a thin, purpose-built layer over `@orkestrel/contract`'s guard/combinator/shape machinery (AGENTS §14):

- **From-unknown guards for untrusted ASTs.** `isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument` (`validators.ts`) are `Guard<T>` values composed from `recordOf` / `arrayOf` / `unionOf` / `literalOf` / `lazyOf` — each is total (never throws, even on cyclic or adversarially deep input) because every combinator involved is throw-contained by `@orkestrel/contract`'s guard contract. These validate a value that did **not** necessarily come from `parseDocument` — a deserialized document, a value crossing a process/RPC boundary.
- **Leaf shapes + compiled contracts, in lockstep.** `shapers.ts` declares `ContractShape` values (`textShape`, `codeSpanShape`, `lineBreakShape`, `codeBlockShape`, `thematicBreakShape`, `tableAlignShape`, `listItemMatchShape`) for the AST's non-recursive node types. `factories.ts` compiles five of them through `createContract` into `ContractInterface<T>` bundles — `schema` / `is` / `parse` / `generate` derived from one declaration, so they can never drift from each other.
- **Why recursive nodes are guard-only.** A `ContractShape` tree has no lazy/self-referential node — it is a finite, developer-authored tree the compilers can walk exhaustively. Any AST type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` (`EmphasisNode`, `LinkNode`, `ImageNode`, `HeadingNode`, `ParagraphNode`, `ListItemNode`, `ListNode`, `TableNode`, `BlockquoteNode`, `MarkdownDocument`) is therefore **not** shaped — it stays guard-only, expressed directly in `validators.ts` with `@orkestrel/contract`'s `lazyOf` (the sanctioned recursion entry point: the thunk defers construction so a self-referential guard never references itself before it exists).

## Patterns

Every feature below has a compact, runnable example. Together they cover every `MarkdownInterface`
method, every standalone projection and traversal helper, and the contract-factory fixture path.

### Construct from a string and narrow with a guard

```ts
import { Markdown, isHeadingNode } from '@orkestrel/markdown'

const markdown = new Markdown('# Title\n\nA **bold** [link](https://x.dev).')
markdown.document.children[0] // { element: 'heading', level: 1, children: [...] }

const heading = markdown.find(isHeadingNode) // HeadingNode | undefined, narrowed
if (heading !== undefined) heading.level // number — narrowed to HeadingNode
```

### Construct from an adopted document

```ts
import { Markdown, isMarkdownDocument } from '@orkestrel/markdown'
import type { MarkdownDocument } from '@orkestrel/markdown'

function adopt(candidate: unknown): Markdown | undefined {
	if (!isMarkdownDocument(candidate)) return undefined // total guard - never throws
	return new Markdown(candidate) // adopted AS-IS, not re-validated
}

const good: MarkdownDocument = { element: 'document', children: [] }
adopt(good) // Markdown instance
adopt({ element: 'bogus' }) // undefined - rejected before Markdown ever adopts it
```

### Filter and flatten

```ts
import { Markdown, isLinkNode, flattenText } from '@orkestrel/markdown'

const markdown = new Markdown('See [one](https://a.dev) and [two](https://b.dev).')
const links = markdown.filter(isLinkNode) // readonly LinkNode[]
const labels = links.map((link) => flattenText(link)) // ['one', 'two']
```

### Chain `map` rewrites, then write back with `renderMarkdown`

```ts
import { Markdown, renderMarkdown } from '@orkestrel/markdown'

const markdown = new Markdown('See [one](https://a.dev) and [two](https://b.dev).')

const shouted = markdown.map((node) =>
	node.element === 'text' ? { element: 'text', value: node.value.toUpperCase() } : node,
)
const linked = shouted.map((node) =>
	node.element === 'link' ? { ...node, href: `${node.href}?ref=guide` } : node,
)

renderMarkdown(linked.document) // 'SEE [ONE](https://a.dev?ref=guide) AND [TWO](https://b.dev?ref=guide).'
```

Each `map` call returns a NEW `MarkdownInterface` — the original `markdown` is never mutated, so a
transform pipeline is a chain of small, composable, side-effect-free rewrites ending in a projection.

### Reduce into an accumulator

```ts
import { Markdown, isHeadingNode } from '@orkestrel/markdown'

const markdown = new Markdown('# One\n\n## Two\n\nBody text.')

const levels = markdown.reduce<readonly number[]>(
	(accumulator, node) => (isHeadingNode(node) ? [...accumulator, node.level] : accumulator),
	[],
) // [1, 2]
```

### Environment-agnostic fold

```ts
import { Markdown } from '@orkestrel/markdown'
import type { MarkdownHandlers } from '@orkestrel/markdown'

// A fold is total: one handler per element, no default arm, so a new AST node is a
// compile error here rather than a silent omission at runtime. Reach for `renderHTML`
// for real HTML — this table is the shape of an arbitrary projection, not a renderer.
const toHTML: MarkdownHandlers<string> = {
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
markdown.fold(toHTML) // '<h1>Hi</h1>'
```

### Shallow streaming with `stream()`

`stream()` returns a web-standard `ReadableStream<BlockNode>` — a fresh, pull-based stream every
call (one block enqueued per `pull`, so a slow reader's backpressure is respected). Two equivalent
ways to consume it:

```ts
import { Markdown } from '@orkestrel/markdown'

const markdown = new Markdown('# Title\n\nFirst.\n\nSecond.')

// universal — a reader loop works in every ReadableStream-supporting environment
const reader = markdown.stream().getReader()
const tops: string[] = []
for (let result = await reader.read(); !result.done; result = await reader.read()) {
	tops.push(result.value.element) // shallow — top-level blocks only
}
// tops: ['heading', 'paragraph', 'paragraph']

// Node / Deno / Firefox support native async iteration of ReadableStream
const topsAsync: string[] = []
for await (const block of markdown.stream()) topsAsync.push(block.element)
```

### Sync deep iteration

```ts
import { Markdown } from '@orkestrel/markdown'

const markdown = new Markdown('# Title\n\nA **bold** word.')

const all: string[] = []
for (const node of markdown.walk()) all.push(node.element) // deep, depth-first, pre-order
```

### Async iteration with `for await…of`

```ts
import { Markdown } from '@orkestrel/markdown'

const markdown = new Markdown('# Title\n\nA **bold** word.')

async function writeAll(writer: { write(chunk: string): void }): Promise<void> {
	for await (const node of markdown.walk()) writer.write(node.element) // sync generator, for-await composes fine
}

// `for await…of` also works over `stream()` — `ReadableStream` is natively async-iterable in
// Node / Deno / Firefox. Environments without that support use the reader loop above instead.
async function streamAll(writer: { write(chunk: string): void }): Promise<void> {
	for await (const block of markdown.stream()) writer.write(block.element)
}
```

`walk()` is a single lazy, sync generator over every node (deep, depth-first, pre-order,
root-inclusive) — a `for await…of` over it composes naturally with any async pipeline (a stream
writer, a queue) without first collecting the whole traversal into memory or needing a separate
async iterator.

### Standalone projections and traversal on a bare node

```ts
import { parseDocument as parseHTML } from '@orkestrel/html'
import {
	Markdown,
	markdownToHTML,
	renderHTML,
	renderMarkdown,
	htmlToMarkdown,
	walkNodes,
	foldNode,
	rewriteDocument,
	parseInline,
	parseDocument,
} from '@orkestrel/markdown'
import type { MarkdownHandlers } from '@orkestrel/markdown'

const markdown = new Markdown('# Hi\n\nText.')

renderHTML(markdown.document) // '<h1>Hi</h1><p>Text.</p>' — sanitized, canonical, compact

// The intermediate AST, for a caller who wants to apply their own HTML policy.
markdownToHTML(markdown.document) // { category: 'document', children: [...] }

// renderMarkdown round-trip: parseDocument(renderMarkdown(doc)) deep-equals doc.
const roundTripped = parseDocument(renderMarkdown(markdown.document))

// The inbound direction: HTML in, the same MarkdownDocument shape a parse produces.
const imported = htmlToMarkdown(parseHTML('<h1>Release notes</h1><p>Ship <b>fast</b>.</p>'))
renderMarkdown(imported) // '# Release notes\n\nShip **fast**.'

// The class-free path: walkNodes / foldNode / rewriteDocument all operate on a bare MarkdownNode,
// no Markdown instance required.
const heading = markdown.document.children[0]
const elements = [...walkNodes(heading)].map((node) => node.element) // ['heading', 'text']

const countHandlers: MarkdownHandlers<number> = {
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
const nodeCount = foldNode(heading, countHandlers, 0) // 2

const rewritten = rewriteDocument(markdown.document, (node) =>
	node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
)

const fragment = parseInline('a **bold** span') // readonly InlineNode[], no block structure
```

### Guide-parity extraction

```ts
import { Markdown, isTableNode, flattenText } from '@orkestrel/markdown'

// Extract every Surface-table first-column identifier from this very guide.
function extractSurfaceNames(source: string): readonly string[] {
	const markdown = new Markdown(source)
	const tables = markdown.filter(isTableNode) // readonly TableNode[] — narrowed, no cast needed
	return tables.flatMap((table) =>
		table.rows.map((row) => flattenText({ element: 'paragraph', children: row[0] ?? [] })),
	)
}
```

### Contract-backed fixture generation

```ts
import { createTextContract } from '@orkestrel/markdown'
import { seededRandom } from '@orkestrel/contract'

const text = createTextContract()
text.schema // the compiled JSON Schema for TextNode
const fixture = text.generate(seededRandom(42)) // reproducible seed data
text.is(fixture) // true — guard / generator stay in lockstep
```

## Tests

- [`tests/src/core/Markdown.test.ts`](../tests/src/core/Markdown.test.ts) — `walk` / `find` / `filter` / `map` / `reduce` / `fold` / `stream` behavior, construction from a string vs. an already-parsed document.
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) — `parseDocument` / `parseInline` / `parseBlocks`, incl. degrade semantics at `MAX_DEPTH`.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — structural predicates + per-node guards + the from-unknown AST guards (soundness on cyclic / adversarial input).
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the pure line/block/inline scanning leaves, including the `collectTable` / `collectList` construct scanners; `markdownToHTML` / `renderHTML` (structure, escaping, the composed URL floor, the `src` widening, the depth cap) and `renderMarkdown` (canonical forms, the emphasis-parity corpus, the parse↔render round-trip); the projection leaves (`trimInlines` / `normalizeInlines` / `mergeProjections` / `projectionToBlocks` / `projectionToInlines` / `projectHTMLLeaf` / `projectHTMLNode`) and `htmlToMarkdown` end to end — element mapping, adversarial and cyclic input, the round-trip anchor law over the projection corpus, and the grand markdown → HTML → markdown trip; plus `walkNodes` / `foldNode` / `rewriteDocument` / `flattenText`.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — per-shape guard exactness, JSON Schema essentials, seeded generate round-trips, parse rebuilds, and bidirectional `Infer` ↔ interface type parity.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createMarkdown` + the compiled node contracts (`is` / `parse` / `schema` / `generate` round-trips).

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §5 centralized-file pattern, §14 guard totality, §22 documentation-as-contracts.
- [`README.md`](README.md) — the guides index.
