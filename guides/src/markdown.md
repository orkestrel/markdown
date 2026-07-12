# Markdown

> A zero-dependency, types-first markdown parser and renderer — a hand-written, linear-time scanner that turns a markdown string into a typed AST held by a stateful `Markdown` workspace, and a set of standalone writer functions that project that AST back out (to safe HTML, or to canonical markdown source). Source: [`src/core`](../../src/core). Surfaced through the `@src/core` barrel.

Markdown here is: parse once into a stateful `Markdown` workspace, then treat every output as a projection of it. `parseDocument` runs a block phase (headings / paragraphs / lists / GFM tables / fenced code / blockquotes / thematic breaks) then an inline phase (emphasis / inline code / links) over each block's text, and returns a render-agnostic {@link MarkdownDocument} — a discriminated union of node values keyed by `element` (the axis that varies, AGENTS §4.4: never `kind` / `type`). A `Markdown` instance wraps that AST with query (`find` / `filter` / `reduce` / iteration), rewrite (`map`), fold, and streaming operations. The writers — `renderHTML` and `renderMarkdown` — are separate, standalone, downstream projections from AST → string; neither assumes its input came from `parseDocument` on trusted markdown. `renderHTML` never throws: it unconditionally HTML-escapes text/attributes and sanitizes link `href`s. Neither writer ever throws: malformed input degrades to literal text, and adversarially deep nesting degrades at a fixed recursion cap rather than exhausting the call stack (no ReDoS, no stack overflow). The AST itself is the primary contract — render-agnostic and exhaustively testable — with a from-unknown validation surface (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) for when an AST arrives from outside `parseDocument` (a deserialized document, a value crossing a process/RPC boundary).

## Surface

### Types

The full node shape and workspace contract, from [`types.ts`](../../src/core/types.ts). `element` is the discriminant every node carries; block nodes carry document structure, inline nodes carry the inline content of a heading / paragraph / list item / table cell.

| Type                        | Kind      | Shape                                                                                                                                                                                                                          |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TableAlign`                | type      | `'none' \| 'left' \| 'right' \| 'center'` — a GFM table column's declared alignment.                                                                                                                                           |
| `ListItemParts`             | interface | `{ ordered, start, content, indent, marker }` — the block phase's parsed list-item-line result.                                                                                                                                |
| `TextNode`                  | interface | `{ element: 'text', value: string }` — a plain-text inline leaf (escapes resolved, not yet HTML-escaped).                                                                                                                      |
| `EmphasisNode`              | interface | `{ element: 'emphasis', strong: boolean, children: readonly InlineNode[] }` — `*em*` / `**strong**`.                                                                                                                           |
| `CodeSpanNode`              | interface | `{ element: 'codeSpan', value: string }` — `` `code` ``, verbatim (no inner markdown).                                                                                                                                         |
| `LinkNode`                  | interface | `{ element: 'link', href: string, children: readonly InlineNode[] }` — `[text](href)`.                                                                                                                                         |
| `InlineNode`                | type      | `TextNode \| EmphasisNode \| CodeSpanNode \| LinkNode` — anything that can appear inside inline content.                                                                                                                       |
| `HeadingNode`               | interface | `{ element: 'heading', level: number, children: readonly InlineNode[] }` — an ATX heading, `level` 1–6.                                                                                                                        |
| `ParagraphNode`             | interface | `{ element: 'paragraph', children: readonly InlineNode[] }`.                                                                                                                                                                   |
| `ListItemNode`              | interface | `{ element: 'listItem', children: readonly BlockNode[] }` — one item of a `ListNode`.                                                                                                                                          |
| `ListNode`                  | interface | `{ element: 'list', ordered: boolean, start: number, items: readonly ListItemNode[] }`.                                                                                                                                        |
| `TableNode`                 | interface | `{ element: 'table', header, rows, align }` — a GFM table; `header`/`rows` are inline-content cells, `align` per-column.                                                                                                       |
| `CodeBlockNode`             | interface | `{ element: 'codeBlock', lang?: string, code: string }` — a fenced code block, verbatim (no inner markdown).                                                                                                                   |
| `BlockquoteNode`            | interface | `{ element: 'blockquote', children: readonly BlockNode[] }` — `>`-prefixed lines, de-quoted and re-parsed as blocks.                                                                                                           |
| `ThematicBreakNode`         | interface | `{ element: 'thematicBreak' }` — a horizontal rule; carries no fields beyond its discriminant.                                                                                                                                 |
| `BlockNode`                 | type      | `HeadingNode \| ParagraphNode \| ListNode \| TableNode \| CodeBlockNode \| BlockquoteNode \| ThematicBreakNode`.                                                                                                               |
| `MarkdownDocument`          | interface | `{ element: 'document', children: readonly BlockNode[] }` — the AST root a `Markdown` instance's `document` holds.                                                                                                             |
| `MarkdownNode`              | type      | `MarkdownDocument \| BlockNode \| ListItemNode \| InlineNode` — the exhaustive set the writers' `switch` covers.                                                                                                               |
| `MarkdownHandler<TNode, T>` | type      | `(node: TNode, children: readonly T[]) => T` — one catamorphism step; the building block of a `MarkdownHandlers` table.                                                                                                        |
| `MarkdownHandlers<T>`       | interface | One `MarkdownHandler` per AST element (`document`, `heading`, `paragraph`, `thematicBreak`, `blockquote`, `codeBlock`, `list`, `listItem`, `table`, `text`, `emphasis`, `codeSpan`, `link`) — the total table `fold` requires. |
| `MarkdownRewriteHandler`    | type      | `(node: MarkdownNode) => MarkdownNode` — a bottom-up, copy-on-write node rewrite for `map`.                                                                                                                                    |
| `MarkdownInterface`         | interface | `{ document, walk, find, filter, map, reduce, fold, stream }`, `stream(): ReadableStream<BlockNode>` — see [`## Methods`](#methods) below.                                                                                     |

### Constants

From [`constants.ts`](../../src/core/constants.ts).

| Constant           | Kind  | Behavior                                                                                                                                                                                                                                                              |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE_URL_SCHEMES` | const | `ReadonlySet<string>` — `{'http', 'https', 'mailto', 'tel'}`, frozen, lower-case. Any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`, …) is dropped at render.                                                                                            |
| `MAX_DEPTH`        | const | `64` — the recursion cap `parseDocument` (and its `parsers.ts` helpers) and the `helpers.ts` traversal/render functions (`renderHTML`, `renderMarkdown`, `walkNodes`, `foldNode`) all honor before degrading (§ [Depth degrade semantics](#depth-degrade-semantics)). |

### Parsers

The block/inline parsing pipeline, from [`parsers.ts`](../../src/core/parsers.ts) — the orchestration `parseDocument` composes out of `helpers.ts`'s pure scanning leaves (AGENTS §5). `parseBlocks` / `collectTable` / `collectList` are the recursive spine; each is exported and independently testable.

| Parser          | Kind     | Signature                                                                                      | Behavior                                                                                                                                         |
| --------------- | -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseBlocks`   | function | `(lines: readonly string[], depth: number) => readonly BlockNode[]`                            | Parses a run of markdown lines into block nodes, recursing into nested blockquotes/list items; degrades to one literal paragraph at `MAX_DEPTH`. |
| `collectTable`  | function | `(lines: readonly string[], start: number) => { node: TableNode, next: number }`               | Collects a GFM table starting at its header row (header + delimiter + contiguous body rows).                                                     |
| `collectList`   | function | `(lines: readonly string[], start: number, depth: number) => { node: ListNode, next: number }` | Collects a list starting at its first item, gathering same-indent siblings and recursing into each item's block content.                         |
| `parseDocument` | function | `(markdown: string) => MarkdownDocument`                                                       | Parses a markdown string into a `MarkdownDocument` AST via the block phase (`splitLines` + `parseBlocks`). Never throws.                         |
| `parseInline`   | function | `(text: string) => readonly InlineNode[]`                                                      | Parses one line of inline content (emphasis / code / links), no block structure. Never throws.                                                   |

### Helpers

Pure, total, zero-dependency parsing + writing leaves from [`helpers.ts`](../../src/core/helpers.ts) — the functional core `parsers.ts` composes and the projections `Markdown` and callers reach for directly (AGENTS §5). Every function is unit-testable in isolation; malformed input degrades to text, never throws.

| Helper            | Kind     | Signature                                                                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `splitLines`      | function | `(markdown: string) => readonly string[]`                                            | Normalizes `\r\n` / `\r` to `\n` and splits into lines; a single trailing newline yields no final empty line.                                                                                                                                                                                                                                                                                                                                  |
| `leadingIndent`   | function | `(line: string) => number`                                                           | Count of leading space/tab characters (a tab counts as one).                                                                                                                                                                                                                                                                                                                                                                                   |
| `extractHeading`  | function | `(line: string) => { level: number, text: string } \| undefined`                     | Parses an ATX heading line (`#`…`######`); `undefined` when not a heading.                                                                                                                                                                                                                                                                                                                                                                     |
| `extractFence`    | function | `(line: string) => { marker: string, lang: string \| undefined } \| undefined`       | Parses a fenced-code opening line (` ``` ` / `~~~`, optional info string); `undefined` when not a fence opener.                                                                                                                                                                                                                                                                                                                                |
| `extractListItem` | function | `(line: string) => ListItemParts \| undefined`                                       | Parses a bullet (`-`/`*`/`+`) or ordinal (`1.`/`1)`) list-item line; `undefined` when not a list item.                                                                                                                                                                                                                                                                                                                                         |
| `stripQuote`      | function | `(line: string) => string`                                                           | Strips one level of `>` blockquote marker (plus one optional space).                                                                                                                                                                                                                                                                                                                                                                           |
| `splitTableRow`   | function | `(row: string) => readonly string[]`                                                 | Splits a GFM table row into cells; outer pipes optional, `\|` escaped inside a cell is literal.                                                                                                                                                                                                                                                                                                                                                |
| `tableAlignments` | function | `(delimiter: string) => readonly TableAlign[]`                                       | Derives per-column alignment from a GFM delimiter row.                                                                                                                                                                                                                                                                                                                                                                                         |
| `startsBlock`     | function | `(lines: readonly string[], index: number) => boolean`                               | Whether the line at `index` starts a NEW block kind — stops paragraph collection without a blank-line separator.                                                                                                                                                                                                                                                                                                                               |
| `unescapeText`    | function | `(text: string) => string`                                                           | Resolves backslash escapes (`\*` → `*`) to their literal characters.                                                                                                                                                                                                                                                                                                                                                                           |
| `coalesceText`    | function | `(nodes: readonly InlineNode[]) => readonly InlineNode[]`                            | Merges adjacent text nodes into one.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `scanCode`        | function | `(source, start, to) => { value: string, end: number } \| undefined`                 | Scans an inline code span (matching backtick-run closer); `undefined` when unterminated.                                                                                                                                                                                                                                                                                                                                                       |
| `scanLink`        | function | `(source, start, to, depth = 0) => { node: LinkNode, end: number } \| undefined`     | Scans `[text](href)`; `undefined` when the shape doesn't hold. `depth` gates the text-children recursion at `MAX_DEPTH`.                                                                                                                                                                                                                                                                                                                       |
| `scanEmphasis`    | function | `(source, start, to, depth = 0) => { node: EmphasisNode, end: number } \| undefined` | Scans `*em*` / `**strong**`; `undefined` when no valid closer exists. `depth` gates the children recursion at `MAX_DEPTH`.                                                                                                                                                                                                                                                                                                                     |
| `scanInline`      | function | `(source: string, from: number, to: number, depth = 0) => readonly InlineNode[]`     | The recursive inline-scanning engine (emphasis / link text recurse through it); linear-time, no backtracking. See [depth degrade](#depth-degrade-semantics).                                                                                                                                                                                                                                                                                   |
| `escapeHtml`      | function | `(text: string) => string`                                                           | HTML-escapes `&` `<` `>` `"` `'` to entities.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sanitizeUrl`     | function | `(href: string) => string`                                                           | Sanitizes + attribute-escapes a link `href` (§ [Sanitization policy](#sanitization-policy)).                                                                                                                                                                                                                                                                                                                                                   |
| `renderHTML`      | function | `(node: MarkdownNode) => string`                                                     | Renders any `MarkdownNode` (typically a `MarkdownDocument`) to a safe HTML string — text/attributes escaped, `href`s sanitized. Never throws.                                                                                                                                                                                                                                                                                                  |
| `renderMarkdown`  | function | `(node: MarkdownNode) => string`                                                     | Renders any `MarkdownNode` to CANONICAL markdown source — the inverse of `renderHTML`, and the basis of the `parseDocument`↔`renderMarkdown` round-trip (§ [`renderMarkdown` round-trip](#rendermarkdown-round-trip)). Never throws.                                                                                                                                                                                                           |
| `walkNodes`       | function | `(node: MarkdownNode) => Generator<MarkdownNode>`                                    | Depth-first, pre-order, root-inclusive traversal — yields the node itself then its children. `Markdown.find` / `filter` / `reduce` / iteration all walk through this.                                                                                                                                                                                                                                                                          |
| `foldNode`        | function | `<T>(node: MarkdownNode, handlers: MarkdownHandlers<T>, depth: number) => T`         | The total catamorphism `Markdown.fold` delegates to — children folded first (post-order), then the node's own handler runs with the already-folded children. The `table` handler is NOT a leaf: it receives one folded `T` per inline node, flattened across all cells (header cells first in column order, then body rows' cells in row-then-column order) — recover cell boundaries from `node.header[c].length` / `node.rows[r][c].length`. |
| `rewriteDocument` | function | `(document: MarkdownDocument, rewrite: MarkdownRewriteHandler) => MarkdownDocument`  | The bottom-up (copy-on-write) rewrite `Markdown.map` delegates to — the document root is never itself passed to `rewrite`. Capped at `MAX_DEPTH`: a subtree at the cap passes through unchanged instead of recursing further.                                                                                                                                                                                                                  |
| `flattenText`     | function | `(node: MarkdownNode) => string`                                                     | Concatenates the `value`/`code` content of every descendant text/code-span/code-block node, in walk order — a plain-text projection of an AST.                                                                                                                                                                                                                                                                                                 |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`) from [`shapers.ts`](../../src/core/shapers.ts) — one shape compiles into a guard, coercing parser, JSON Schema, and seeded generator (the compilers live in `@orkestrel/contract`, invoked here via `createContract` in `factories.ts`). Only the NON-recursive node types shape here; any type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` stays guard-only (`validators.ts`, via `lazyOf`) — see [Relationship with @orkestrel/contract](#relationship-with-orkestrelcontract).

| Shaper               | Kind  | Builds                                                                                                  |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| `textShape`          | const | The shape of a `TextNode` — `{ element: 'text', value: string }`.                                       |
| `codeSpanShape`      | const | The shape of a `CodeSpanNode` — `{ element: 'codeSpan', value: string }`.                               |
| `codeBlockShape`     | const | The shape of a `CodeBlockNode` — `{ element: 'codeBlock', lang?: string, code: string }`.               |
| `thematicBreakShape` | const | The shape of a `ThematicBreakNode` — `{ element: 'thematicBreak' }`, no fields beyond the discriminant. |
| `tableAlignShape`    | const | The shape of a `TableAlign` literal — `'none' \| 'left' \| 'right' \| 'center'`.                        |
| `listItemPartsShape` | const | The shape of `ListItemParts` — fully non-recursive, every field shapes directly.                        |

### Validators

Line/character structural predicates plus node guards, from [`validators.ts`](../../src/core/validators.ts). The structural predicates test raw strings during parsing; the `is{Element}Node` guards narrow an ALREADY-PARSED `MarkdownNode` by its `element` tag; the from-unknown guards (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) instead validate an arbitrary `unknown` value against the full node shape, composed from `@orkestrel/contract` combinators. Two distinct guard families: the **from-unknown boundary guards** (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) take `unknown` and validate an entire untrusted value from scratch; the **narrowing guards** (`is{Element}Node`, e.g. `isTableNode`) take an already-typed `MarkdownNode` and narrow it to one member of the union by its `element` tag — they assume the value is already a valid node shape.

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
| `isLinkNode`          | function | `node: MarkdownNode`                               | Narrows to `LinkNode`.                                                                                                                                     |
| `isInlineNode`        | const    | `Guard<InlineNode>`                                | Total from-unknown guard: text / emphasis / code span / link, recursively validated via `lazyOf`.                                                          |
| `isBlockNode`         | const    | `Guard<BlockNode>`                                 | Total from-unknown guard: heading / paragraph / list / table / code block / blockquote / thematic break.                                                   |
| `isMarkdownNode`      | const    | `Guard<MarkdownNode>`                              | Total from-unknown guard: the document root, a block node, a list item, or an inline node.                                                                 |
| `isMarkdownDocument`  | const    | `Guard<MarkdownDocument>`                          | Total from-unknown guard: `{ element: 'document', children: readonly BlockNode[] }`.                                                                       |

### `Markdown`

The implementing class of `MarkdownInterface`, from [`Markdown.ts`](../../src/core/Markdown.ts). A stateful, parsed markdown workspace: constructed from a markdown `string` (runs `parseDocument`) or an already-parsed `MarkdownDocument` (adopted AS-IS, not re-validated). Exposes its AST through the `readonly document` member (documented here in Surface prose, per the `ContractInterface` precedent, alongside `walk` — both are part of the documented surface even though `document` carries no row in the [`## Methods`](#methods) table below, which lists only call-signature members). `walk` is the deep traversal — a lazy, depth-first, pre-order, root-inclusive generator over every node; its sync `for (const node of markdown.walk())` surface is also consumable by `for await (const node of markdown.walk())` (JavaScript accepts a sync iterable in a `for await`), so an async pipeline needs no separate iterator. Contrast with `stream`: `walk` is deep (every node) and sync; `stream` is shallow (top-level blocks only) and backpressure-respecting. Immutable — `map` never mutates the stored AST, it returns a new `Markdown`. See [`## Methods`](#methods) for its public call-signature surface.

### Factories

From [`factories.ts`](../../src/core/factories.ts).

| Factory                       | Kind     | Signature                                                  | Behavior                                                                                                         |
| ----------------------------- | -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `createMarkdown`              | function | `(input: string \| MarkdownDocument) => MarkdownInterface` | Creates a `Markdown` workspace from a markdown string (parses it) or an already-parsed document (adopted as-is). |
| `createTextContract`          | function | `() => ContractInterface<TextNode>`                        | Compiles `textShape` into a guard / parser / schema / generator bundle.                                          |
| `createCodeSpanContract`      | function | `() => ContractInterface<CodeSpanNode>`                    | Compiles `codeSpanShape` into a guard / parser / schema / generator bundle.                                      |
| `createCodeBlockContract`     | function | `() => ContractInterface<CodeBlockNode>`                   | Compiles `codeBlockShape` into a guard / parser / schema / generator bundle.                                     |
| `createThematicBreakContract` | function | `() => ContractInterface<ThematicBreakNode>`               | Compiles `thematicBreakShape` into a guard / parser / schema / generator bundle.                                 |

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
- **Inline nodes** (`InlineNode`) carry the inline content of a heading / paragraph / list item / table cell: `text`, `emphasis` (nests further inline children — `**bold _and italic_**` is a strong node wrapping a text node and an emphasis node), `codeSpan` (verbatim, no inner markdown), `link` (nests inline children for its text).

Recursion in the AST is structural, not incidental: a `blockquote`'s `children` re-parse the de-quoted lines as blocks (so quotes nest), a `list`'s `items` each carry `BlockNode[]` (so a nested list is just a `list` block inside a `listItem`'s children), and `emphasis` / `link` nest `InlineNode[]`. `MarkdownNode` is the exhaustive union the writers' `switch` covers: `MarkdownDocument | BlockNode | ListItemNode | InlineNode`.

## The parse pipeline

`parseDocument(markdown)` runs two phases:

1. **Block phase** — splits the document into lines (`splitLines`, CRLF/CR normalized) and walks them, detecting fences, thematic breaks, ATX headings, blockquotes, GFM tables, and lists (`parseBlocks`, `collectTable`, `collectList`); anything left over collects into a paragraph. `startsBlock` lets a new block interrupt a paragraph without a separating blank line.
2. **Inline phase** — each block's raw text runs through `scanInline` (backslash escapes, code spans, links, emphasis) via `parseInline`, then `coalesceText` merges adjacent text runs.

`new Markdown(markdown)` (or `createMarkdown(markdown)`) calls `parseDocument` internally and stores the result as its `document`. `renderHTML(node)` and `renderMarkdown(node)` are **separate**, downstream, standalone projections from an AST to a string — never fused into parsing, so a caller can inspect, transform, or fold the AST (via `Markdown`'s `find` / `filter` / `map` / `reduce` / `fold`) before ever calling a writer, or never call one at all.

**Total / never-throw.** `parseDocument`, `renderHTML`, and `renderMarkdown` are all total functions: malformed markdown degrades to literal text (an unterminated `**` stays literal, a broken table falls back to a paragraph) rather than throwing. Inline scanning is index-based (no backtracking regex), so it is linear-time — no ReDoS on adversarial input.

### Depth degrade semantics

`MAX_DEPTH` (`64`) bounds several independent recursions, each degrading to a fixed, cheap fallback instead of recursing further:

- **Block recursion** (blockquote / list nesting, `parsers.ts`'s `parseBlocks`) — past the cap, the remaining lines collapse into **one literal paragraph** containing those lines joined by `\n`, instead of continuing to parse nested structure.
- **Inline recursion** (`scanInline`, and the `depth` threaded through `scanLink` / `scanEmphasis`) — past the cap, the scan window is not scanned for markup at all; it emits as a **single literal text node**.
- **`renderHTML` recursion** — past the cap, a node is not rendered structurally; it yields the HTML-escaped `value` of a node that carries one (a `TextNode`, `CodeSpanNode`, …), or an **empty string** for a node with no `value` field. A table cell's inline content renders at `depth + 1` from the table's own depth (never reset to `0`), so a fabricated table-in-cell chain shares the same depth budget as everything else and cannot escape the cap. The internal `switch` also carries a `default` arm returning `''`, so a fabricated node with an `element` outside the exhaustive set (bypassing the type system, e.g. via an untyped/deserialized value) renders as an empty string instead of `undefined` — `renderHTML` is total even against a hostile `MarkdownNode`.
- **`renderMarkdown` recursion** — the same cap and the same value-bearing-vs-empty degrade rule, applied to canonical markdown source instead of HTML.
- **`walkNodes` / `foldNode` recursion** — descent stops at the cap; the node AT the cap is still yielded/folded (with an empty children list for `foldNode`), its children are not.
- **`rewriteDocument` / `Markdown.map` recursion** — the same cap, shared by both (`map` delegates to `rewriteDocument`): at the cap, the subtree is passed through UNCHANGED (by reference — not rebuilt, and `rewrite` is not invoked on it) instead of recursing further, so a pathologically deep adopted document cannot exhaust the call stack.

Together these bound pathological or hostile input (deeply nested blockquotes, runaway emphasis, adversarially deep ASTs) so no parsing or writing function can ever exhaust the call stack.

## Sanitization policy

`renderHTML` treats every text run, code body, and link `href` as untrusted, unconditionally:

- **Text + attribute escaping.** `escapeHtml` escapes `&` `<` `>` `"` `'` to entities on every text run and code body, so markdown content can never inject markup.
- **`href` sanitization** (`sanitizeUrl`) — strips every whitespace and C0/C1 control codepoint from the href first (blocking `java\tscript:`-style scheme-spoofing evasions), then:
  - a **protocol-relative** destination — `//host/path`, or a backslash variant a browser normalizes to the same effect (`\\host`, `/\host`, `\/host`; any two leading characters both drawn from `/` or `\`) — is dropped to an empty string; a **single** leading `/` or `\` is same-origin relative and is kept;
  - a destination whose scheme is **not** in `SAFE_URL_SCHEMES` (`http`, `https`, `mailto`, `tel` — notably excluding `javascript:` / `data:` / `vbscript:` / `file:`) is dropped to an empty string;
  - a relative / anchor / scheme-less (and non-protocol-relative) destination is kept;
  - the surviving value is then HTML-attribute-escaped.
- **Table cell `align` clamping.** A table cell's `style="text-align:…"` attribute is only ever emitted when the column's `TableAlign` is the literal `'left'`, `'right'`, or `'center'` — `'none'` (or anything else a fabricated `TableNode` might carry) emits no `style` attribute at all, so the interpolated value can never escape that closed, literal set.

This is defence-in-depth: `renderHTML` applies it even when a caller only ever feeds `parseDocument` trusted markdown, because `renderHTML` accepts any `MarkdownNode` — including one a caller constructed, rewrote via `map`, or accepted from elsewhere, not only one `parseDocument` produced. `renderMarkdown` is NOT a sanitization boundary — it emits canonical markdown source, not HTML, so escaping there exists only to keep the round-trip lossless (§ below), not to defend against injection.

## `renderMarkdown` round-trip

`renderMarkdown` is the inverse of `parseDocument`: for any `MarkdownDocument` produced by `parseDocument`, `parseDocument(renderMarkdown(doc))` deep-equals `doc`, and `renderMarkdown` is idempotent — `renderMarkdown(parseDocument(renderMarkdown(doc))) === renderMarkdown(doc)`. It writes every node to one CANONICAL markdown form, never the source's original (possibly variant) spelling:

| Construct          | Canonical form                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Emphasis           | `*em*` / `**strong**` — underscore emphasis (`_em_`, `__strong__`) normalizes to asterisks.                                                                                                                        |
| Bulleted list item | `- ` (a single hyphen + space), regardless of source marker (`*` / `+`).                                                                                                                                           |
| Ordered list item  | `N. ` — sequential ordinals starting from the list's `start`, `.`-style (never `)`)                                                                                                                                |
| Thematic break     | `---`, regardless of source marker (`***` / `___` / spaced variants).                                                                                                                                              |
| Fenced code block  | Backtick fences, widened past any 3+ backtick run already inside the body.                                                                                                                                         |
| Blockquote         | `> `-prefixed lines (`>` alone for an otherwise-empty line).                                                                                                                                                       |
| GFM table          | 1-space-padded cells, `\|`-escaped literal pipes, an explicit alignment delimiter row.                                                                                                                             |
| Link               | `[text](href)` — `href` with `\`, `(`, `)` backslash-escaped (mirroring the parser's unescape) so a paren in the destination round-trips; sanitization remains an HTML-render concern, not a markdown-writing one. |
| Block separation   | Exactly ONE blank line between top-level blocks; a document with zero blocks renders `''`.                                                                                                                         |

A `text` node's literal content is backslash-escaped wherever it would otherwise re-parse as different markup (a leading `#`, a leading list marker, a literal `*`/`_`/`` ` ``/`[`/`]`); a heading whose inline text ends in a `#` run (with or without leading whitespace) has that run's FIRST `#` backslash-escaped so it cannot be mistaken for an ATX closing sequence on reparse — the round-trip soundness AGENTS §14 requires between a parser and its inverse.

This guarantee is scoped to documents `parseDocument` produced (or an equivalent well-formed `MarkdownDocument`). A value fabricated via `map` (or constructed by hand) that stuffs block-significant content or an embedded newline into a node field `renderMarkdown` treats as literal text (a `TextNode.value`, a `LinkNode.href`, …) has NO round-trip guarantee — `renderMarkdown` still never throws, but the resulting source is not guaranteed to reparse back to the same AST.

## Relationship with `@orkestrel/contract`

Markdown's validation surface is a thin, purpose-built layer over `@orkestrel/contract`'s guard/combinator/shape machinery (AGENTS §14):

- **From-unknown guards for untrusted ASTs.** `isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument` (`validators.ts`) are `Guard<T>` values composed from `recordOf` / `arrayOf` / `unionOf` / `literalOf` / `lazyOf` — each is total (never throws, even on cyclic or adversarially deep input) because every combinator involved is throw-contained by `@orkestrel/contract`'s guard contract. These validate a value that did **not** necessarily come from `parseDocument` — a deserialized document, a value crossing a process/RPC boundary.
- **Leaf shapes + compiled contracts, in lockstep.** `shapers.ts` declares `ContractShape` values (`textShape`, `codeSpanShape`, `codeBlockShape`, `thematicBreakShape`, `tableAlignShape`, `listItemPartsShape`) for the AST's non-recursive node types. `factories.ts` compiles four of them through `createContract` into `ContractInterface<T>` bundles — `schema` / `is` / `parse` / `generate` derived from one declaration, so they can never drift from each other.
- **Why recursive nodes are guard-only.** A `ContractShape` tree has no lazy/self-referential node — it is a finite, developer-authored tree the compilers can walk exhaustively. Any AST type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` (`EmphasisNode`, `LinkNode`, `HeadingNode`, `ParagraphNode`, `ListItemNode`, `ListNode`, `TableNode`, `BlockquoteNode`, `MarkdownDocument`) is therefore **not** shaped — it stays guard-only, expressed directly in `validators.ts` with `@orkestrel/contract`'s `lazyOf` (the sanctioned recursion entry point: the thunk defers construction so a self-referential guard never references itself before it exists).

## Patterns

Every feature below has a compact, runnable example. Together they cover every `MarkdownInterface`
method, every standalone writer/traversal helper, and the contract-factory fixture path.

### Construct from a string and narrow with a guard

```ts
import { Markdown, isHeadingNode } from '@src/core'

const markdown = new Markdown('# Title\n\nA **bold** [link](https://x.dev).')
markdown.document.children[0] // { element: 'heading', level: 1, children: [...] }

const heading = markdown.find(isHeadingNode) // HeadingNode | undefined, narrowed
if (heading !== undefined) heading.level // number — narrowed to HeadingNode
```

### Construct from an adopted document

```ts
import { Markdown, isMarkdownDocument } from '@src/core'
import type { MarkdownDocument } from '@src/core'

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
import { Markdown, isLinkNode, flattenText } from '@src/core'

const markdown = new Markdown('See [one](https://a.dev) and [two](https://b.dev).')
const links = markdown.filter(isLinkNode) // readonly LinkNode[]
const labels = links.map((link) => flattenText(link)) // ['one', 'two']
```

### Chain `map` rewrites, then write back with `renderMarkdown`

```ts
import { Markdown, renderMarkdown } from '@src/core'

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
transform pipeline is a chain of small, composable, side-effect-free rewrites ending in a writer.

### Reduce into an accumulator

```ts
import { Markdown, isHeadingNode } from '@src/core'

const markdown = new Markdown('# One\n\n## Two\n\nBody text.')

const levels = markdown.reduce<readonly number[]>(
	(accumulator, node) => (isHeadingNode(node) ? [...accumulator, node.level] : accumulator),
	[],
) // [1, 2]
```

### Environment-agnostic fold

```ts
import { Markdown } from '@src/core'
import type { MarkdownHandlers } from '@src/core'

// Mirrors what a browser DOM build would do with document.createElement — environment-agnostic:
// no DOM, no browser, no HTML-string coupling baked into the handler table itself.
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
	link: (node, children) => `<a href="${node.href}">${children.join('')}</a>`,
}

const markdown = new Markdown('# Hi')
markdown.fold(toHTML) // '<h1>Hi</h1>'
```

### Shallow streaming with `stream()`

`stream()` returns a web-standard `ReadableStream<BlockNode>` — a fresh, pull-based stream every
call (one block enqueued per `pull`, so a slow reader's backpressure is respected). Two equivalent
ways to consume it:

```ts
import { Markdown } from '@src/core'

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
import { Markdown } from '@src/core'

const markdown = new Markdown('# Title\n\nA **bold** word.')

const all: string[] = []
for (const node of markdown.walk()) all.push(node.element) // deep, depth-first, pre-order
```

### Async iteration with `for await…of`

```ts
import { Markdown } from '@src/core'

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

### Standalone writers and traversal on a bare node

```ts
import {
	Markdown,
	renderHTML,
	renderMarkdown,
	walkNodes,
	foldNode,
	rewriteDocument,
	parseInline,
	parseDocument,
} from '@src/core'
import type { MarkdownHandlers } from '@src/core'

const markdown = new Markdown('# Hi\n\nText.')

renderHTML(markdown.document) // '<h1>Hi</h1>\n<p>Text.</p>'

// renderMarkdown round-trip: parseDocument(renderMarkdown(doc)) deep-equals doc.
const roundTripped = parseDocument(renderMarkdown(markdown.document))

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
	link: (_, children) => 1 + children.reduce((a, b) => a + b, 0),
}
const nodeCount = foldNode(heading, countHandlers, 0) // 2

const rewritten = rewriteDocument(markdown.document, (node) =>
	node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
)

const fragment = parseInline('a **bold** span') // readonly InlineNode[], no block structure
```

### Guide-parity extraction

```ts
import { Markdown, isTableNode, flattenText } from '@src/core'

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
import { createTextContract } from '@src/core'
import { seededRandom } from '@orkestrel/contract'

const text = createTextContract()
text.schema // the compiled JSON Schema for TextNode
const fixture = text.generate(seededRandom(42)) // reproducible seed data
text.is(fixture) // true — guard / generator stay in lockstep
```

## Tests

- [`tests/src/core/Markdown.test.ts`](../../tests/src/core/Markdown.test.ts) — `walk` / `find` / `filter` / `map` / `reduce` / `fold` / `stream` behavior, construction from a string vs. an already-parsed document.
- [`tests/src/core/parsers.test.ts`](../../tests/src/core/parsers.test.ts) — `parseDocument` / `parseInline` / `parseBlocks` / `collectTable` / `collectList`, incl. degrade semantics at `MAX_DEPTH`.
- [`tests/src/core/validators.test.ts`](../../tests/src/core/validators.test.ts) — structural predicates + per-node guards + the from-unknown AST guards (soundness on cyclic / adversarial input).
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — the pure line/block/inline scanning leaves, `renderHTML` / `renderMarkdown` / `walkNodes` / `foldNode` / `rewriteDocument` / `flattenText`, and sanitization.
- [`tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) — per-shape guard exactness, JSON Schema essentials, seeded generate round-trips, parse rebuilds, and bidirectional `Infer` ↔ interface type parity.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createMarkdown` + the compiled node contracts (`is` / `parse` / `schema` / `generate` round-trips).

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §5 centralized-file pattern, §14 guard totality, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the guides index.
</content>
