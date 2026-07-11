# Markdown

> A zero-dependency, types-first markdown parser and renderer — a hand-written, linear-time scanner that turns a markdown string into a typed AST and (separately) projects that AST to a safe HTML string. Source: [`src/core`](../../src/core). Surfaced through the `@src/core` barrel.

Markdown here is two separate, pure, total operations over one shared AST. `parse` runs a block phase (headings / paragraphs / lists / GFM tables / fenced code / blockquotes / thematic breaks) then an inline phase (emphasis / inline code / links) over each block's text, and returns a render-agnostic {@link MarkdownDocument} — a discriminated union of node values keyed by `element` (the axis that varies, AGENTS §4.4: never `kind` / `type`). `render` is a downstream, separate projection from AST → HTML string; it never assumes its input came from `parse` on trusted markdown, so it unconditionally HTML-escapes text/attributes and sanitizes link `href`s. Neither method ever throws: malformed input degrades to literal text, and adversarially deep nesting degrades at a fixed recursion cap rather than exhausting the call stack (no ReDoS, no stack overflow). The AST itself is the primary contract — render-agnostic and exhaustively testable — with a from-unknown validation surface (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) for when an AST arrives from outside `parse` (a deserialized document, a value crossing a process/RPC boundary).

## Surface

### Types

The full node shape and parser contract, from [`types.ts`](../../src/core/types.ts). `element` is the discriminant every node carries; block nodes carry document structure, inline nodes carry the inline content of a heading / paragraph / list item / table cell.

| Type                      | Kind      | Shape                                                                                                                          |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `TableAlign`               | type      | `'none' \| 'left' \| 'right' \| 'center'` — a GFM table column's declared alignment.                                            |
| `ListItemParts`            | interface | `{ ordered, start, content, indent, marker }` — the block phase's parsed list-item-line result.                                |
| `TextNode`                 | interface | `{ element: 'text', value: string }` — a plain-text inline leaf (escapes resolved, not yet HTML-escaped).                      |
| `EmphasisNode`             | interface | `{ element: 'emphasis', strong: boolean, children: readonly InlineNode[] }` — `*em*` / `**strong**`.                           |
| `CodeSpanNode`             | interface | `{ element: 'codeSpan', value: string }` — `` `code` ``, verbatim (no inner markdown).                                         |
| `LinkNode`                 | interface | `{ element: 'link', href: string, children: readonly InlineNode[] }` — `[text](href)`.                                        |
| `InlineNode`               | type      | `TextNode \| EmphasisNode \| CodeSpanNode \| LinkNode` — anything that can appear inside inline content.                       |
| `HeadingNode`              | interface | `{ element: 'heading', level: number, children: readonly InlineNode[] }` — an ATX heading, `level` 1–6.                        |
| `ParagraphNode`            | interface | `{ element: 'paragraph', children: readonly InlineNode[] }`.                                                                    |
| `ListItemNode`             | interface | `{ element: 'listItem', children: readonly BlockNode[] }` — one item of a `ListNode`.                                          |
| `ListNode`                 | interface | `{ element: 'list', ordered: boolean, start: number, items: readonly ListItemNode[] }`.                                        |
| `TableNode`                | interface | `{ element: 'table', header, rows, align }` — a GFM table; `header`/`rows` are inline-content cells, `align` per-column.        |
| `CodeBlockNode`            | interface | `{ element: 'codeBlock', lang?: string, code: string }` — a fenced code block, verbatim (no inner markdown).                   |
| `BlockquoteNode`           | interface | `{ element: 'blockquote', children: readonly BlockNode[] }` — `>`-prefixed lines, de-quoted and re-parsed as blocks.           |
| `ThematicBreakNode`        | interface | `{ element: 'thematicBreak' }` — a horizontal rule; carries no fields beyond its discriminant.                                  |
| `BlockNode`                | type      | `HeadingNode \| ParagraphNode \| ListNode \| TableNode \| CodeBlockNode \| BlockquoteNode \| ThematicBreakNode`.                |
| `MarkdownDocument`         | interface | `{ element: 'document', children: readonly BlockNode[] }` — the AST root `MarkdownParserInterface.parse` returns.              |
| `MarkdownNode`             | type      | `MarkdownDocument \| BlockNode \| ListItemNode \| InlineNode` — the exhaustive set the renderer's `switch` covers.              |
| `MarkdownParserInterface`  | interface | `{ parse, parseInline, render }` — see [`## Methods`](#methods) below.                                                          |

### Constants

From [`constants.ts`](../../src/core/constants.ts).

| Constant           | Kind  | Behavior                                                                                                                                                                    |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE_URL_SCHEMES`  | const | `ReadonlySet<string>` — `{'http', 'https', 'mailto', 'tel'}`, frozen, lower-case. Any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`, …) is dropped at render. |
| `MAX_DEPTH`         | const | `64` — the recursion cap the block phase, inline phase, and renderer all honor before degrading to literal text (§ [Depth degrade semantics](#depth-degrade-semantics)). |

### Helpers

Pure, total, zero-dependency parsing + rendering leaves from [`helpers.ts`](../../src/core/helpers.ts) — the functional core `MarkdownParser`'s methods compose (AGENTS §5). Every function is unit-testable in isolation; malformed input degrades to text, never throws.

| Helper             | Kind     | Signature                                                                                    | Behavior                                                                                                                          |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `splitLines`        | function | `(markdown: string) => readonly string[]`                                                     | Normalizes `\r\n` / `\r` to `\n` and splits into lines; a single trailing newline yields no final empty line.                     |
| `leadingIndent`     | function | `(line: string) => number`                                                                    | Count of leading space/tab characters (a tab counts as one).                                                                      |
| `extractHeading`    | function | `(line: string) => { level: number, text: string } \| undefined`                              | Parses an ATX heading line (`#`…`######`); `undefined` when not a heading.                                                        |
| `extractFence`      | function | `(line: string) => { marker: string, lang: string \| undefined } \| undefined`                | Parses a fenced-code opening line (`` ``` `` / `~~~`, optional info string); `undefined` when not a fence opener.                 |
| `extractListItem`   | function | `(line: string) => ListItemParts \| undefined`                                                | Parses a bullet (`-`/`*`/`+`) or ordinal (`1.`/`1)`) list-item line; `undefined` when not a list item.                            |
| `stripQuote`        | function | `(line: string) => string`                                                                    | Strips one level of `>` blockquote marker (plus one optional space).                                                              |
| `splitTableRow`     | function | `(row: string) => readonly string[]`                                                          | Splits a GFM table row into cells; outer pipes optional, `\|` escaped inside a cell is literal.                                   |
| `tableAlignments`   | function | `(delimiter: string) => readonly TableAlign[]`                                                | Derives per-column alignment from a GFM delimiter row.                                                                            |
| `startsBlock`       | function | `(lines: readonly string[], index: number) => boolean`                                        | Whether the line at `index` starts a NEW block kind — stops paragraph collection without a blank-line separator.                  |
| `unescapeText`      | function | `(text: string) => string`                                                                    | Resolves backslash escapes (`\*` → `*`) to their literal characters.                                                              |
| `coalesceText`      | function | `(nodes: readonly InlineNode[]) => readonly InlineNode[]`                                     | Merges adjacent text nodes into one.                                                                                              |
| `scanCode`          | function | `(source, start, to) => { value: string, end: number } \| undefined`                          | Scans an inline code span (matching backtick-run closer); `undefined` when unterminated.                                         |
| `scanLink`          | function | `(source, start, to, depth = 0) => { node: LinkNode, end: number } \| undefined`               | Scans `[text](href)`; `undefined` when the shape doesn't hold. `depth` gates the text-children recursion at `MAX_DEPTH`.          |
| `scanEmphasis`      | function | `(source, start, to, depth = 0) => { node: EmphasisNode, end: number } \| undefined`           | Scans `*em*` / `**strong**`; `undefined` when no valid closer exists. `depth` gates the children recursion at `MAX_DEPTH`.        |
| `scanInline`        | function | `(source: string, from: number, to: number, depth = 0) => readonly InlineNode[]`               | The recursive inline-scanning engine (emphasis / link text recurse through it); linear-time, no backtracking. See [depth degrade](#depth-degrade-semantics). |
| `escapeHtml`        | function | `(text: string) => string`                                                                    | HTML-escapes `&` `<` `>` `"` `'` to entities.                                                                                     |
| `sanitizeUrl`       | function | `(href: string) => string`                                                                    | Sanitizes + attribute-escapes a link `href` (§ [Sanitization policy](#sanitization-policy)).                                      |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`) from [`shapers.ts`](../../src/core/shapers.ts) — one shape compiles into a guard, coercing parser, JSON Schema, and seeded generator (the compilers live in `@orkestrel/contract`, invoked here via `createContract` in `factories.ts`). Only the NON-recursive node types shape here; any type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` stays guard-only (`validators.ts`, via `lazyOf`) — see [Relationship with @orkestrel/contract](#relationship-with-orkestrelcontract).

| Shaper                | Kind     | Builds                                                                                             |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `textShape`            | const    | The shape of a `TextNode` — `{ element: 'text', value: string }`.                                    |
| `codeSpanShape`        | const    | The shape of a `CodeSpanNode` — `{ element: 'codeSpan', value: string }`.                            |
| `codeBlockShape`       | const    | The shape of a `CodeBlockNode` — `{ element: 'codeBlock', lang?: string, code: string }`.             |
| `thematicBreakShape`   | const    | The shape of a `ThematicBreakNode` — `{ element: 'thematicBreak' }`, no fields beyond the discriminant. |
| `tableAlignShape`      | const    | The shape of a `TableAlign` literal — `'none' \| 'left' \| 'right' \| 'center'`.                     |
| `listItemPartsShape`   | const    | The shape of `ListItemParts` — fully non-recursive, every field shapes directly.                     |

### Validators

Line/character structural predicates plus node guards, from [`validators.ts`](../../src/core/validators.ts). The structural predicates test raw strings during parsing; the `is{Element}Node` guards narrow an ALREADY-PARSED `MarkdownNode` by its `element` tag; the from-unknown guards (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) instead validate an arbitrary `unknown` value against the full node shape, composed from `@orkestrel/contract` combinators.

| Guard                | Kind     | Narrows to / Tests                | Behavior                                                                                                        |
| --------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `isWhitespace`        | function | `character: string`                | `true` for space / tab / newline — the emphasis flanking rule's space test.                                     |
| `isEscapable`         | function | `character: string`                | `true` for a character a leading backslash can escape (ASCII markdown punctuation).                             |
| `isBlankLine`         | function | `line: string`                     | `true` when `line` is empty or contains only whitespace — the markdown blank-line rule used to separate paragraphs, skip gaps, and end list continuations. |
| `isQuote`             | function | `line: string`                     | `true` when `line` opens a blockquote (`>` optionally indented up to 3 spaces).                                 |
| `isFenceClose`        | function | `(line: string, marker: string)`   | `true` when `line` closes a fence opened by `marker` (same character, run at least as long).                    |
| `isFenceWhitespace`   | function | `character: string \| undefined`   | `true` for a regex-`\s`-equivalent whitespace character (fence-close padding).                                  |
| `isThematicBreak`     | function | `line: string`                     | `true` for 3+ of the same `-`/`*`/`_` marker (optionally space-separated) and nothing else.                     |
| `isTableStart`        | function | `(header: string, delimiter: string \| undefined)` | `true` when the pair opens a GFM table (delimiter row of `:?-+:?` cells).                        |
| `isHeadingNode`       | function | `node: MarkdownNode`               | Narrows to `HeadingNode` — `node.element === 'heading'`.                                                        |
| `isParagraphNode`     | function | `node: MarkdownNode`               | Narrows to `ParagraphNode`.                                                                                      |
| `isListNode`          | function | `node: MarkdownNode`               | Narrows to `ListNode`.                                                                                           |
| `isTableNode`         | function | `node: MarkdownNode`               | Narrows to `TableNode`.                                                                                          |
| `isCodeBlockNode`     | function | `node: MarkdownNode`               | Narrows to `CodeBlockNode`.                                                                                      |
| `isBlockquoteNode`    | function | `node: MarkdownNode`               | Narrows to `BlockquoteNode`.                                                                                     |
| `isThematicBreakNode` | function | `node: MarkdownNode`               | Narrows to `ThematicBreakNode`.                                                                                  |
| `isTextNode`          | function | `node: MarkdownNode`               | Narrows to `TextNode`.                                                                                           |
| `isEmphasisNode`      | function | `node: MarkdownNode`               | Narrows to `EmphasisNode`.                                                                                       |
| `isCodeSpanNode`      | function | `node: MarkdownNode`               | Narrows to `CodeSpanNode`.                                                                                       |
| `isLinkNode`          | function | `node: MarkdownNode`               | Narrows to `LinkNode`.                                                                                           |
| `isInlineNode`        | const    | `Guard<InlineNode>`                | Total from-unknown guard: text / emphasis / code span / link, recursively validated via `lazyOf`.               |
| `isBlockNode`         | const    | `Guard<BlockNode>`                 | Total from-unknown guard: heading / paragraph / list / table / code block / blockquote / thematic break.        |
| `isMarkdownNode`      | const    | `Guard<MarkdownNode>`               | Total from-unknown guard: the document root, a block node, a list item, or an inline node.                      |
| `isMarkdownDocument`  | const    | `Guard<MarkdownDocument>`          | Total from-unknown guard: `{ element: 'document', children: readonly BlockNode[] }`.                            |

### `MarkdownParser`

The implementing class of `MarkdownParserInterface`, from [`MarkdownParser.ts`](../../src/core/MarkdownParser.ts). Stateless and event-free — a handle freely reused. See [`## Methods`](#methods) for its public surface.

### Factories

From [`factories.ts`](../../src/core/factories.ts).

| Factory                        | Kind     | Signature                                        | Behavior                                                                                     |
| -------------------------------- | -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `createMarkdownParser`           | function | `() => MarkdownParserInterface`                     | Creates a stateless `MarkdownParser` handle.                                                 |
| `createTextContract`             | function | `() => ContractInterface<TextNode>`                 | Compiles `textShape` into a guard / parser / schema / generator bundle.                      |
| `createCodeSpanContract`         | function | `() => ContractInterface<CodeSpanNode>`             | Compiles `codeSpanShape` into a guard / parser / schema / generator bundle.                  |
| `createCodeBlockContract`        | function | `() => ContractInterface<CodeBlockNode>`            | Compiles `codeBlockShape` into a guard / parser / schema / generator bundle.                 |
| `createThematicBreakContract`    | function | `() => ContractInterface<ThematicBreakNode>`        | Compiles `thematicBreakShape` into a guard / parser / schema / generator bundle.              |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name (AGENTS §22).

#### `MarkdownParserInterface`

| Method        | Returns                    | Behavior                                                                                                                            |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `parse`       | `MarkdownDocument`           | Parses a markdown string into an AST (block phase then inline phase). Never throws.                                                |
| `parseInline` | `readonly InlineNode[]`      | Parses a single line of inline content (emphasis / code / links), no block structure. Never throws.                                |
| `render`      | `string`                     | Renders a parsed `MarkdownNode` (typically a `MarkdownDocument`) to an HTML string — text + attributes escaped, `href`s sanitized. |

## The AST model

Every node is plain, readonly data with no behavior — a discriminated union keyed by `element` (never `kind` / `type`, AGENTS §4.4). Two families:

- **Block nodes** (`BlockNode`) carry document structure: `heading`, `paragraph`, `list` (of `listItem`s), `table`, `codeBlock`, `blockquote`, `thematicBreak`. A `MarkdownDocument` is the root — `{ element: 'document', children: readonly BlockNode[] }`.
- **Inline nodes** (`InlineNode`) carry the inline content of a heading / paragraph / list item / table cell: `text`, `emphasis` (nests further inline children — `**bold _and italic_**` is a strong node wrapping a text node and an emphasis node), `codeSpan` (verbatim, no inner markdown), `link` (nests inline children for its text).

Recursion in the AST is structural, not incidental: a `blockquote`'s `children` re-parse the de-quoted lines as blocks (so quotes nest), a `list`'s `items` each carry `BlockNode[]` (so a nested list is just a `list` block inside a `listItem`'s children), and `emphasis` / `link` nest `InlineNode[]`. `MarkdownNode` is the exhaustive union the renderer's `switch` covers: `MarkdownDocument | BlockNode | ListItemNode | InlineNode`.

## The parse → render pipeline

`parse(markdown)` runs two phases:

1. **Block phase** — splits the document into lines (`splitLines`, CRLF/CR normalized) and walks them, detecting fences, thematic breaks, ATX headings, blockquotes, GFM tables, and lists; anything left over collects into a paragraph. `startsBlock` lets a new block interrupt a paragraph without a separating blank line.
2. **Inline phase** — each block's raw text runs through `scanInline` (backslash escapes, code spans, links, emphasis), then `coalesceText` merges adjacent text runs.

`render(node)` is a **separate**, downstream projection from the resulting AST to an HTML string — it is never fused into `parse`, so a caller can inspect, transform, or validate the AST before rendering (or never render it at all).

**Total / never-throw.** Both `parse` and `render` are total functions: malformed markdown degrades to literal text (an unterminated `**` stays literal, a broken table falls back to a paragraph) rather than throwing. Inline scanning is index-based (no backtracking regex), so it is linear-time — no ReDoS on adversarial input.

### Depth degrade semantics

`MAX_DEPTH` (`64`) bounds three independent recursions, each degrading to a fixed, cheap fallback instead of recursing further:

- **Block recursion** (blockquote / list nesting, `MarkdownParser`'s private `#blocks`) — past the cap, the remaining lines collapse into **one literal paragraph** containing those lines joined by `\n`, instead of continuing to parse nested structure.
- **Inline recursion** (`scanInline`, and the `depth` threaded through `scanLink` / `scanEmphasis`) — past the cap, the scan window is not scanned for markup at all; it emits as a **single literal text node**.
- **Render recursion** (`MarkdownParser.render`) — past the cap, a node is not rendered structurally; it yields the HTML-escaped `value` of a node that carries one (a `TextNode`, `CodeSpanNode`, …), or an **empty string** for a node with no `value` field.

Together these bound pathological or hostile input (deeply nested blockquotes, runaway emphasis, adversarially deep ASTs) so the parser and renderer can never exhaust the call stack.

## Sanitization policy

`render` treats every text run, code body, and link `href` as untrusted, unconditionally:

- **Text + attribute escaping.** `escapeHtml` escapes `&` `<` `>` `"` `'` to entities on every text run and code body, so markdown content can never inject markup.
- **`href` sanitization** (`sanitizeUrl`) — strips every whitespace and C0/C1 control codepoint from the href first (blocking `java\tscript:`-style scheme-spoofing evasions), then:
  - a **protocol-relative** destination (`//host/path`, which inherits whatever scheme the embedding page is served over) is dropped to an empty string;
  - a destination whose scheme is **not** in `SAFE_URL_SCHEMES` (`http`, `https`, `mailto`, `tel` — notably excluding `javascript:` / `data:` / `vbscript:` / `file:`) is dropped to an empty string;
  - a relative / anchor / scheme-less (and non-protocol-relative) destination is kept;
  - the surviving value is then HTML-attribute-escaped.

This is defence-in-depth: `render` applies it even when a caller only ever feeds the parser trusted markdown, because `render` accepts any `MarkdownNode` — including one a caller constructed or accepted from elsewhere, not only one `parse` produced.

## Relationship with `@orkestrel/contract`

Markdown's validation surface is a thin, purpose-built layer over `@orkestrel/contract`'s guard/combinator/shape machinery (AGENTS §14):

- **From-unknown guards for untrusted ASTs.** `isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument` (`validators.ts`) are `Guard<T>` values composed from `recordOf` / `arrayOf` / `unionOf` / `literalOf` / `lazyOf` — each is total (never throws, even on cyclic or adversarially deep input) because every combinator involved is throw-contained by `@orkestrel/contract`'s guard contract. These validate a value that did **not** necessarily come from `parse` — a deserialized document, a value crossing a process/RPC boundary.
- **Leaf shapes + compiled contracts, in lockstep.** `shapers.ts` declares `ContractShape` values (`textShape`, `codeSpanShape`, `codeBlockShape`, `thematicBreakShape`, `tableAlignShape`, `listItemPartsShape`) for the AST's non-recursive node types. `factories.ts` compiles four of them through `createContract` into `ContractInterface<T>` bundles — `schema` / `is` / `parse` / `generate` derived from one declaration, so they can never drift from each other.
- **Why recursive nodes are guard-only.** A `ContractShape` tree has no lazy/self-referential node — it is a finite, developer-authored tree the compilers can walk exhaustively. Any AST type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` (`EmphasisNode`, `LinkNode`, `HeadingNode`, `ParagraphNode`, `ListItemNode`, `ListNode`, `TableNode`, `BlockquoteNode`, `MarkdownDocument`) is therefore **not** shaped — it stays guard-only, expressed directly in `validators.ts` with `@orkestrel/contract`'s `lazyOf` (the sanctioned recursion entry point: the thunk defers construction so a self-referential guard never references itself before it exists).

## Patterns

### Parsing and rendering

```ts
import { createMarkdownParser } from '@src/core'

const parser = createMarkdownParser()
const ast = parser.parse('# Title\n\nA **bold** [link](https://x.dev).')
// ast.children[0] === { element: 'heading', level: 1, children: [{ element: 'text', value: 'Title' }] }

parser.render(ast)
// '<h1>Title</h1>\n<p>A <strong>bold</strong> <a href="https://x.dev">link</a>.</p>'
```

### Typed narrowing with the assert-style node guards

```ts
import { createMarkdownParser, isHeadingNode } from '@src/core'

const parser = createMarkdownParser()
const ast = parser.parse('# Hi')
const [first] = ast.children

if (first !== undefined && isHeadingNode(first)) {
	first.level // number — narrowed to HeadingNode
}
```

### Validating untrusted input before render

```ts
import { createMarkdownParser, isMarkdownNode } from '@src/core'

function renderUntrusted(candidate: unknown): string | undefined {
	if (!isMarkdownNode(candidate)) return undefined // total guard - never throws
	return createMarkdownParser().render(candidate)
}

renderUntrusted({ element: 'text', value: 'hi' }) // '<p>hi</p>'... (a rendered TextNode)
renderUntrusted({ element: 'bogus' }) // undefined - rejected before it ever reaches render
```

### Generating fixtures with a compiled contract

```ts
import { createTextContract } from '@src/core'
import { seededRandom } from '@orkestrel/contract'

const text = createTextContract()
text.is({ element: 'text', value: 'hi' }) // true
text.generate(seededRandom(42)) // deterministic seed data: { element: 'text', value: '...' }
```

## Tests

- [`tests/src/core/MarkdownParser.test.ts`](../../tests/src/core/MarkdownParser.test.ts) — `parse` / `parseInline` / `render` behavior, incl. degrade semantics at `MAX_DEPTH` and sanitization.
- [`tests/src/core/validators.test.ts`](../../tests/src/core/validators.test.ts) — structural predicates + per-node guards + the from-unknown AST guards (soundness on cyclic / adversarial input).
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — the pure line/block/inline scanning + escaping/sanitization leaves.
- [`tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) — per-shape guard exactness, JSON Schema essentials, seeded generate round-trips, parse rebuilds, and bidirectional `Infer` ↔ interface type parity.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) — `createMarkdownParser` + the compiled node contracts (`is` / `parse` / `schema` / `generate` round-trips).

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §5 centralized-file pattern, §14 guard totality, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the guides index.
