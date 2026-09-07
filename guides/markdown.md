# Markdown

> A types-first markdown layer over `@orkestrel/html`: a linear-time scanner that parses
> GitHub-Flavored Markdown into a typed AST, a stateful `Markdown` workspace that queries,
> rewrites, folds, and streams that AST, and standalone projections that carry it out to
> sanitized HTML or canonical markdown source and carry an HTML AST back in.

One parse is the whole contract: every later output is a projection of the AST it produced, never a second read of the source. `parseDocument` runs a block phase (headings / paragraphs / lists / GFM tables / fenced code / blockquotes / thematic breaks) then an inline phase (emphasis / inline code / links / images / hard breaks) over each block's text, and returns a render-agnostic `MarkdownDocument` — a discriminated union of node values keyed by `element` (the axis that varies: never `kind` / `type`). The AST itself is the primary contract — render-agnostic and exhaustively testable — with a from-unknown validation surface (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) for when an AST arrives from outside `parseDocument` (a deserialized document, a value crossing a process/RPC boundary). Source: [`src/core`](../src/core). Surfaced through the `@src/core` barrel.

**Each conversion direction lives here**, because what an HTML subtree becomes in markdown — and what a markdown node becomes in HTML — is markdown-format knowledge, not HTML knowledge. `@orkestrel/html` owns the HTML AST, its total parser, its canonical serializer, and its sanitize floor; this package owns the two projections across the boundary and never asks html to know a markdown word. Outbound: `markdownToHTML` projects a `MarkdownNode` onto html's AST, `renderHTML` composes that projection with html's sanitizer and serializer into one sanitized string, and `renderMarkdown` writes canonical markdown source instead (§ [`renderMarkdown` round-trip](#rendermarkdown-round-trip)). Inbound: `htmlToMarkdown` folds an html `HTMLNode` back down to a `MarkdownDocument` (§ [`htmlToMarkdown` projection](#htmltomarkdown-projection)). None of them assumes its input came from a trusted parse, and none of them throws: malformed markdown degrades to literal text, while at the outbound depth cap value-bearing nodes degrade to text and structural nodes degrade to nothing; the inbound trip inherits html's own cap rather than exhausting the call stack (no ReDoS, no stack overflow).

## Surface

### Types

The full node shape and workspace contract, from [`types.ts`](../src/core/types.ts). `element` is the discriminant every node carries; block nodes carry document structure, inline nodes carry the inline content of a heading / paragraph / list item / table cell. `MarkdownInterface`'s call-signature members are documented under [`## Methods`](#methods).

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                        | Kind      | Shape                                                                                                                                         | Summary                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TableAlign`                | type      | `'left' \| 'right' \| 'center'`                                                                                                               | Names the horizontal alignment of a GFM table column, as declared by its delimiter row (`:---` left, `---:` right, `:---:` center). A bare `---` delimiter is represented by `null` in `TableNode.align`: the positional array requires one entry per column, JSON cannot carry `undefined` in an array, and the bare delimiter is an explicit no-alignment marker rather than an omitted value. |
| `ListItemMatch`             | interface | `{ ordered, start, content, indent, marker }`                                                                                                 | Represents the parsed parts of a single list-item line — the value the block phase's list detector returns for a `-` / `*` / `+` bullet or a `1.` / `1)` ordinal line.                                                                                                                                                                                                                           |
| `HeadingMatch`              | interface | `{ level, text, offset }`                                                                                                                     | Represents the parsed parts of a single ATX heading line — the value the block phase's heading detector returns for a `#` … `######` line.                                                                                                                                                                                                                                                       |
| `FenceMatch`                | interface | `{ marker, lang }`                                                                                                                            | Represents the parsed parts of a fenced-code opening line — the value the block phase's fence detector returns for a \`\`\`\` \`\`\` \`\`\`\` or \`~~~\` opener.                                                                                                                                                                                                                                 |
| `CodeSpanMatch`             | interface | `{ value, end }`                                                                                                                              | Represents the located extent of one inline code span — the value the inline phase's code scanner returns for a matched backtick run.                                                                                                                                                                                                                                                            |
| `LinkBounds`                | interface | `{ close, end }`                                                                                                                              | Represents the located syntax bounds of one `[text](href)` link — the value the inline phase's link locator returns for a balanced label followed by a destination.                                                                                                                                                                                                                              |
| `EmphasisBounds`            | interface | `{ strong, open, close, end }`                                                                                                                | Represents the located content and syntax bounds of one emphasis run — the value the inline phase's emphasis locator returns for a matched marker run.                                                                                                                                                                                                                                           |
| `LinkScan`                  | interface | `{ node, end }`                                                                                                                               | Represents the scanned result of one `[text](href)` link — the node the inline phase's link scanner built from `LinkBounds` and where the scan resumes.                                                                                                                                                                                                                                          |
| `EmphasisScan`              | interface | `{ node, end }`                                                                                                                               | Represents the scanned result of one emphasis run — the node the inline phase's emphasis scanner built from `EmphasisBounds` and where the scan resumes.                                                                                                                                                                                                                                         |
| `TableCollection`           | interface | `{ node, next }`                                                                                                                              | Represents the result of collecting one GFM table — the node the construct scanner built and where the block phase resumes.                                                                                                                                                                                                                                                                      |
| `ListCollection`            | interface | `{ node, next }`                                                                                                                              | Represents the result of collecting one list — the node the construct scanner built and where the block phase resumes.                                                                                                                                                                                                                                                                           |
| `MarkdownSpan`              | interface | `{ start, end }`                                                                                                                              | Addresses a half-open region of the original markdown string, in UTF-16 code units — `start` inclusive, `end` exclusive. The provenance a parse records for a node and `MarkdownInterface.span` reads back.                                                                                                                                                                                      |
| `MarkdownSegment`           | interface | `{ offset, start, end }`                                                                                                                      | Maps one run of a `MarkdownSource` back to the region of the original markdown string it was taken from.                                                                                                                                                                                                                                                                                         |
| `MarkdownSource`            | interface | `{ text, segments }`                                                                                                                          | Pairs a piece of derived markdown text with the runs mapping it back to the original string — what `splitLines` returns per line, so every phase downstream of it keeps original coordinates instead of reconstructing them from node values.                                                                                                                                                    |
| `TextNode`                  | interface | `{ element, value }`                                                                                                                          | Represents a run of plain text — the leaf inline node. `value` is the decoded text with markdown escapes (`\*`, `\_`, …) already resolved to their literal characters; html's text encoder escapes `&`, `<`, `>` on the way out; `"` and `'` stay literal in character data.                                                                                                                     |
| `EmphasisNode`              | interface | `{ element, strong, children }`                                                                                                               | Represents emphasized inline content — `*italic*` / `_italic_` (`strong: false`) or `**bold**` / `__bold__` (`strong: true`). `children` are the nested inline nodes, so emphasis composes (a `**bold _and italic_**` is a strong node wrapping a text node and an emphasis node).                                                                                                               |
| `CodeSpanNode`              | interface | `{ element, value }`                                                                                                                          | Represents an inline code span — \`\` \`code\` \`\`. \`value\` is the verbatim span text; no inner markdown is parsed (code is literal), and the renderer HTML-escapes it inside a \`<code>\` element.                                                                                                                                                                                           |
| `LineBreakNode`             | interface | `{ element }`                                                                                                                                 | Represents a GFM hard line break — two or more trailing spaces before a newline in markdown source, a `br` element in HTML.                                                                                                                                                                                                                                                                      |
| `LinkNode`                  | interface | `{ element, href, children }`                                                                                                                 | Represents an inline link — `[text](href)`. `children` are the inline nodes of the link text. At render, html's floor removes a refused `href` attribute and the link keeps its text; `htmlToMarkdown` instead stores a refused destination as `''`.                                                                                                                                             |
| `ImageNode`                 | interface | `{ element, src, children }`                                                                                                                  | Represents an inline image — `![alt](src)`. `children` are the inline nodes of the alternative content and `src` is the image destination.                                                                                                                                                                                                                                                       |
| `InlineNode`                | type      | `TextNode \| EmphasisNode \| CodeSpanNode \| LineBreakNode \| LinkNode \| ImageNode`                                                          | Represents a node that can appear inside inline content (a heading / paragraph / cell / list item / link text).                                                                                                                                                                                                                                                                                  |
| `HeadingNode`               | interface | `{ element, level, children }`                                                                                                                | Represents an ATX heading — `#` … `######`. `level` is 1–6 (the number of leading `#`), `children` the inline content of the heading text.                                                                                                                                                                                                                                                       |
| `ParagraphNode`             | interface | `{ element, children }`                                                                                                                       | Represents a paragraph — a run of non-blank lines that is not another block; `children` its inline content.                                                                                                                                                                                                                                                                                      |
| `ListItemNode`              | interface | `{ element, children }`                                                                                                                       | Represents one item of a `ListNode` — `children` the block content of the item (typically one paragraph, plus any nested list).                                                                                                                                                                                                                                                                  |
| `ListNode`                  | interface | `{ element, ordered, start, items }`                                                                                                          | Represents a list — bulleted (`-` / `*` / `+`, `ordered: false`) or numbered (`1.` / `1)`, `ordered: true`). `start` is the first ordinal of an ordered list (usually `1`). Nesting is expressed by a `ListNode` appearing in a `ListItemNode`'s `children`.                                                                                                                                     |
| `TableNode`                 | interface | `{ element, header, rows, align }`                                                                                                            | Represents a GFM table — `header` the inline content of each header cell, `rows` the body rows (each a list of cells, each cell inline content), `align` the per-column alignment from the delimiter row. A short body row is padded with empty cells; an over-long one is truncated to the header's column count.                                                                               |
| `CodeBlockNode`             | interface | `{ element, lang?, code }`                                                                                                                    | Represents a fenced code block — \`\`\`\` \`\`\`lang \`\`\`\`. \`code\` is the verbatim block content (no inner markdown; the closing fence and the trailing newline are stripped), \`lang\` the info-string language tag (the first word after the opening fence), absent when none was given.                                                                                                  |
| `BlockquoteNode`            | interface | `{ element, children }`                                                                                                                       | Represents a blockquote — `>`-prefixed lines; `children` the block content parsed from the de-quoted lines (so quotes nest).                                                                                                                                                                                                                                                                     |
| `ThematicBreakNode`         | interface | `{ element }`                                                                                                                                 | Represents a thematic break — a horizontal rule (`---` / `***` / `___` on its own line).                                                                                                                                                                                                                                                                                                         |
| `BlockNode`                 | type      | `HeadingNode \| ParagraphNode \| ListNode \| TableNode \| CodeBlockNode \| BlockquoteNode \| ThematicBreakNode`                               | Represents a node that can appear at the block level of a document (or inside a list item / blockquote).                                                                                                                                                                                                                                                                                         |
| `MarkdownDocument`          | interface | `{ element, children }`                                                                                                                       | Represents the root of a parsed markdown AST — the ordered block children of the whole document. The value `MarkdownInterface.document` holds.                                                                                                                                                                                                                                                   |
| `MarkdownNode`              | type      | `MarkdownDocument \| BlockNode \| ListItemNode \| InlineNode`                                                                                 | Represents any node in a markdown AST — the `MarkdownDocument` root, a `BlockNode`, a `ListItemNode`, or an `InlineNode`. The exhaustive set every projection's `switch` covers.                                                                                                                                                                                                                 |
| `MarkdownCell`              | interface | `{ align, inlines }`                                                                                                                          | Represents one projected table cell — the inline content and alignment of a `th` / `td`.                                                                                                                                                                                                                                                                                                         |
| `MarkdownProjection`        | interface | `{ blocks, inlines, text, cells, rows }`                                                                                                      | Represents what one HTML node projects to on the way to markdown — the fold value `htmlToMarkdown` carries up the AST.                                                                                                                                                                                                                                                                           |
| `MarkdownHandler<TNode, T>` | type      | `(node: TNode, children: readonly T[]) => T`                                                                                                  | Represents a fold handler for one AST element — receives the node and its children already folded to `T`, and produces the node's own `T`. The building block of a `MarkdownHandlerMap` catamorphism table.                                                                                                                                                                                      |
| `MarkdownHandlerMap<T>`     | interface | `{ document, heading, paragraph, thematicBreak, blockquote, codeBlock, list, listItem, table, text, emphasis, codeSpan, break, link, image }` | Represents the total catamorphism table for `MarkdownInterface.fold` — one `MarkdownHandler` per AST element, keyed by its `element` discriminant. Every key is required: a fold is total over the AST, so there is no element it can skip.                                                                                                                                                      |
| `MarkdownRewriteHandler`    | type      | `(node: MarkdownNode) => MarkdownNode`                                                                                                        | Represents a copy-on-write node rewrite applied bottom-up by `MarkdownInterface.map` — receives one node (its own children already rewritten) and returns its replacement (the same node, unchanged, or a new node).                                                                                                                                                                             |
| `MarkdownParseResult`       | type      | `readonly [document: MarkdownDocument, spans: ReadonlyMap<MarkdownNode, MarkdownSpan>]`                                                       | Pairs a parsed document with the `MarkdownSpan` of each of its nodes — what `parseProvenance` returns, and what `parseDocument` projects the document out of.                                                                                                                                                                                                                                    |
| `MarkdownDerivation<T>`     | type      | `readonly [value: T, derivations: ReadonlyMap<MarkdownNode, MarkdownNode \| undefined>]`                                                      | Pairs a rewritten value with the input node each rewritten node was produced from — what `rewriteDocument` returns, so provenance survives a rewrite instead of ending at it. `T` is the rewritten value: the document for a whole-document rewrite.                                                                                                                                             |
| `MarkdownInterface`         | interface | `{ document } plus walk, find, filter, span, map, reduce, fold, stream`                                                                       | Represents a stateful, parsed markdown document: the typed `MarkdownDocument` AST plus the query, rewrite, and fold operations over it.                                                                                                                                                                                                                                                          |

### Constants

From [`constants.ts`](../src/core/constants.ts).

| Constant           | Kind  | Value                                                        | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_DEPTH`        | const | `64`                                                         | Caps the recursion depth the parse pipeline (`parseDocument` and its `parsers.ts` helpers), the `helpers.ts` traversal / projection functions (`markdownToHTML`, `renderMarkdown`, `walkNodes`, `foldNode`, `rewriteDocument`), and the `compilers.ts` renderer (`renderHTML`) honor before degrading. It bounds blockquote nesting, inline nesting (emphasis / links), and traversal / projection recursion so pathological or hostile input cannot exhaust the call stack. `htmlToMarkdown` is the inherited exception: its fold and depth cap belong to `@orkestrel/html`. |
| `EMPTY_PROJECTION` | const | `{ blocks: [], inlines: [], text: '', cells: [], rows: [] }` | Holds the frozen empty HTML-to-markdown projection from which projection factories default every absent field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Parsers

The block/inline parsing pipeline, from [`parsers.ts`](../src/core/parsers.ts) — the orchestration `parseDocument` composes out of `helpers.ts`'s pure scanning leaves. `parseBlocks` is the recursive spine; each parser is exported and independently testable. The construct scanners it composes (`collectTable` / `collectList`) are leaves and live in [`helpers.ts`](../src/core/helpers.ts) with the other scanners; each calls back into the phase entry above it, so the two files are mutually recursive by design.

| Parser            | Kind     | Signature                                                                                                                          | Summary                                                                                                                                                                                                                                         |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseBlocks`     | function | `(lines: readonly MarkdownSource[], depth: number, spans?: Map<MarkdownNode, MarkdownSpan>, end?: number) => readonly BlockNode[]` | Parses a run of markdown lines into a block AST, recursing into nested blockquotes, list items, and depth-capped degrade paragraphs.                                                                                                            |
| `parseDocument`   | function | `(markdown: string) => MarkdownDocument`                                                                                           | Parses a markdown string into a typed `MarkdownDocument` AST through the block phase — the document half of what `parseProvenance` returns. Malformed markdown degrades to literal text, so the parse never throws.                             |
| `parseProvenance` | function | `(markdown: string) => MarkdownParseResult`                                                                                        | Parses a markdown string into a document and its original-source spans. Malformed markdown degrades to literal text, so the parse never throws.                                                                                                 |
| `parseInline`     | function | `(text: string) => readonly InlineNode[]`                                                                                          | Parses inline markdown text (emphasis, code spans, links, images, and hard breaks) into inline AST nodes, coalescing adjacent text runs and reading no block structure. Malformed markdown degrades to literal text, so the parse never throws. |

### Helpers

Pure, total leaves from [`helpers.ts`](../src/core/helpers.ts) — the line and character structural predicates the block and inline phases test raw lines with, the scanning functional core `parsers.ts` composes, the AST-crossing projections (`markdownToHTML`, `renderMarkdown`, `htmlToMarkdown`) plus the projection leaves they are built from, and the traversal engines `Markdown` delegates to. Every function is unit-testable in isolation; malformed input degrades to text, never throws. A predicate over a raw `string` narrows no type, so it is a leaf here rather than a guard in `validators.ts`; `renderHTML` drives the `HTML` class, so it sits in [`compilers.ts`](../src/core/compilers.ts) instead (§ [Compilers](#compilers)). `projectHTMLLeaf`'s leaf parameter is html's own `TextNode`, written `HTMLTextNode` in the signature because this package declares a `TextNode` of its own.

| Helper                   | Kind     | Signature                                                                                                                                   | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `splitLines`             | function | `(markdown: string) => readonly MarkdownSource[]`                                                                                           | Splits a markdown document into offset-bearing lines while normalizing CRLF and bare CR terminators at the line boundary. A single trailing terminator does not yield a final empty line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sliceSource`            | function | `(source: MarkdownSource, from: number, to: number) => MarkdownSource`                                                                      | Slices derived markdown text and narrows each intersecting source segment to the same text-relative range.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `joinSources`            | function | `(sources: readonly MarkdownSource[], separator: string) => MarkdownSource`                                                                 | Joins offset-bearing markdown sources while mapping a separator to the original region between adjacent mapped sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `projectSpan`            | function | `(source: MarkdownSource, from: number, to: number) => MarkdownSpan \| undefined`                                                           | Projects a derived text range through its segments to a half-open region of the original markdown string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trimSource`             | function | `(source: MarkdownSource) => MarkdownSource`                                                                                                | Trims an offset-bearing source without losing the coordinates of its retained text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `normalizeParagraphLine` | function | `(source: MarkdownSource, breaks: boolean) => MarkdownSource`                                                                               | Normalizes one paragraph line while retaining the full source run consumed by a trailing-space hard break.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `countIndent`            | function | `(line: string) => number`                                                                                                                  | Counts the leading space / tab characters on `line` (a tab counts as one) — the indent that decides whether a list item's continuation belongs to the item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isFlankingWhitespace`   | function | `(character: string) => boolean`                                                                                                            | Checks whether `character` is whitespace under the emphasis flanking rule — a space, a tab, or a newline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isEscapable`            | function | `(character: string) => boolean`                                                                                                            | Checks whether `character` is escapable by a leading backslash — the ASCII punctuation markdown gives meaning to (so `\*` becomes `*` but `\.` stays `\.`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `isBlankLine`            | function | `(line: string) => boolean`                                                                                                                 | Checks whether `line` is blank — empty, or containing only whitespace — the markdown definition of a blank line that block parsing uses to separate paragraphs, skip gaps, and end list continuations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `isQuote`                | function | `(line: string) => boolean`                                                                                                                 | Checks whether `line` is a blockquote line (`>` optionally indented up to three spaces) — its content is de-quoted by `stripQuote`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isFenceClose`           | function | `(line: string, marker: string) => boolean`                                                                                                 | Checks whether `line` closes a fence opened by `marker` — the same fence character, a run at least as long, and nothing else but surrounding whitespace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `isFenceWhitespace`      | function | `(character: string \| undefined) => boolean`                                                                                               | Checks whether `character` is a regex-`\s`-equivalent whitespace character — the character class `isFenceClose`'s scan treats as surrounding padding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `isThematicBreak`        | function | `(line: string) => boolean`                                                                                                                 | Checks whether `line` is a thematic break (horizontal rule) — three or more of the same marker `-`, `*`, or `_` (optionally space-separated) and nothing else (`---`, `***`, `___`, `- - -`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `isTableStart`           | function | `(header: string, delimiter: string \| undefined) => boolean`                                                                               | Checks whether the pair (`header`, `delimiter`) opens a GFM table — `delimiter` is a row of `\|`-separated cells each matching `:?-+:?`, the GFM rule that a table requires a header row immediately followed by a delimiter row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `extractHeading`         | function | `(line: string) => HeadingMatch \| undefined`                                                                                               | Extracts an ATX heading line (`#` … `######` followed by text) into its level, trimmed text, and the text's offset inside the line. A run of more than 6 `#`s, or `#`s not followed by whitespace + text, is not a heading; an optional closing `###` run is stripped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `extractFence`           | function | `(line: string) => FenceMatch \| undefined`                                                                                                 | Extracts a fenced-code opening line (\`\`\`\` \`\`\` \`\`\`\` or \`~~~\`, optionally with an info string) into its \`{ marker, lang }\`, or \`undefined\` when \`line\` is not a fence opener. \`marker\` is the exact fence run (the closer must match the same character + at least the same length); \`lang\` is the first word of the info string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `extractListItem`        | function | `(line: string) => ListItemMatch \| undefined`                                                                                              | Extracts a list-item line (`-` / `*` / `+` bullet, or `1.` / `1)` ordinal, followed by a space) into its `ListItemMatch`, or `undefined` when `line` is not a list item. `content` is the text after the marker; `marker` is the full marker-plus-space width (for measuring a continuation's indent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `stripQuote`             | function | `(source: MarkdownSource) => MarkdownSource`                                                                                                | Strips one level of blockquote marker (`>` plus one optional following space) from an offset-bearing blockquote line, so the de-quoted source re-parses as nested blocks without losing its original coordinates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `splitTableRow`          | function | `(row: string) => readonly string[]`                                                                                                        | Splits one GFM table row into its cell strings — outer pipes are optional, a pipe escaped by a leading backslash inside a cell is not a separator (it becomes a literal pipe character), and the empty leading / trailing cell an outer pipe produces is dropped. Derives the string form from `splitTableSources`, which owns the escaped-pipe splitting rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `splitTableSources`      | function | `(row: MarkdownSource) => readonly MarkdownSource[]`                                                                                        | Splits an offset-bearing GFM table row into offset-bearing cells, retaining the complete source spelling of an escaped pipe while exposing its literal value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `delimiterToAlignments`  | function | `(delimiter: string) => readonly (TableAlign \| null)[]`                                                                                    | Derives the per-column `TableAlign` list from a GFM delimiter row — `:---` left, `---:` right, `:---:` center, and `---` as the explicit no-alignment marker represented by `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `startsBlock`            | function | `(lines: readonly string[], index: number) => boolean`                                                                                      | Checks whether the line at `index` starts a new block kind (heading / fence / thematic break / blockquote / list / table) — the paragraph collector stops at such a line so a block following a paragraph without a blank line still parses (a trusted-input caller writing a `##` heading directly under a paragraph, with no intervening blank line).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unescapeText`           | function | `(text: string) => string`                                                                                                                  | Resolves backslash escapes in a raw string to their literal characters — used for a link `href` (which is not otherwise inline-parsed) and any plain text run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `coalesceText`           | function | `(nodes: readonly InlineNode[], spans?: Map<MarkdownNode, MarkdownSpan>) => readonly InlineNode[]`                                          | Merges adjacent text nodes into one — the inline scanner emits a text node per unrecognized character, so coalescing keeps the AST clean and assertion-friendly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scanCode`               | function | `(source, start, to) => CodeSpanMatch \| undefined`                                                                                         | Scans an inline code span at `start` (a \`\` \` \`\`-run … a matching \`\` \` \`\`-run of the same length, the CommonMark rule that lets a span contain backticks). Returns the span's literal text + end index, or \`undefined\` when no matching closer exists (it then degrades to literal backticks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scanLink`               | function | `(source, start, to, depth = 0) => LinkScan \| undefined`                                                                                   | Scans a link `[text](href)` at `start` — the text runs to a balanced `]`, then `(` must immediately follow and the destination runs to the matching `)` (both respect nested delimiters + escapes) through `locateLink`, and returns the parsed node and end index. Returns `undefined` when the shape does not hold (it then degrades to a literal `[`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scanEmphasis`           | function | `(source, start, to, depth = 0) => EmphasisScan \| undefined`                                                                               | Scans an emphasis run at `start` (`*` / `_`, doubled for strong) — finds the nearest matching closing run of the same marker + width while skipping complete nested runs from the other marker family, and requires non-space immediately inside both delimiters (the CommonMark flanking simplification that blocks `* x *`) through `locateEmphasis`, and returns the parsed node and end index. Returns `undefined` when no valid closer exists (it then degrades to a literal marker).                                                                                                                                                                                                                                                                                                                                                                         |
| `locateLink`             | function | `(source: string, start: number, to: number) => LinkBounds \| undefined`                                                                    | Locates a link `[text](href)` at `start` — the text runs to a balanced `]`, then `(` must immediately follow and the destination runs to the matching `)` (both respect nested delimiters + escapes). Returns the label close and syntax end, or `undefined` when the shape does not hold (it then degrades to a literal `[`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `locateEmphasis`         | function | `(source: string, start: number, to: number) => EmphasisBounds \| undefined`                                                                | Locates an emphasis run at `start` (`*` / `_`, doubled for strong) — finds the nearest matching closing run of the same marker + width while skipping complete nested runs from the other marker family, and requires non-space immediately inside both delimiters (the CommonMark flanking simplification that blocks `* x *`). Returns the content and syntax bounds, or `undefined` when no valid closer exists (it then degrades to a literal marker).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `scanInline`             | function | `(source: string, from: number, to: number, depth = 0) => readonly InlineNode[]`                                                            | Scans the window `[from, to)` of `source` into inline nodes — the single recursive engine the inline phase runs on (emphasis, link text, and image alternative content recurse through it). Linear: each character is consumed once; a failed construct emits its opening character as text and advances by one, so there is no re-scan (no ReDoS).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scanInlineSource`       | function | `(source: MarkdownSource, from: number, to: number, spans: Map<MarkdownNode, MarkdownSpan>, depth = 0) => readonly InlineNode[]`            | Scans an offset-bearing inline window with the same engine as `scanInline` and records each emitted node against the original markdown string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `collectTable`           | function | `(lines: readonly MarkdownSource[], start: number, spans?: Map<MarkdownNode, MarkdownSpan>) => TableCollection`                             | Collects a GFM table starting at a header row, parsing the header, the alignment row, and every contiguous body row that follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `collectList`            | function | `(lines: readonly MarkdownSource[], start: number, depth: number, spans?: Map<MarkdownNode, MarkdownSpan>, end?: number) => ListCollection` | Collects a list starting at the first item, gathering sibling items at the same indent/ordering and recursing into each item's own block content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `markdownToHTML`         | function | `(node: MarkdownNode) => HTMLDocument`                                                                                                      | Projects a `MarkdownNode` into an unsanitized `HTMLDocument`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `renderMarkdown`         | function | `(node: MarkdownNode) => string`                                                                                                            | Renders a `MarkdownNode` to its canonical markdown source — the inverse projection of `renderHTML`. It is the serializer a `parse(renderMarkdown(doc))` round-trip is built on. Canonical forms: `*` / `**` emphasis at even emphasis nesting depths and `_` / `__` at odd depths, `-` bullets, `N.` sequential ordinals (from the list's `start`), `---` thematic breaks, fenced code blocks (backtick run widened past any 3+ backtick run inside the body), ATX headings, `>`-prefixed blockquote lines, GFM tables (1-space-padded cells, a backslash before each literal pipe, an alignment delimiter row), `[text](href)` links, `![alt](src)` images, and two-space hard breaks. A `text` node's literal content is backslash-escaped wherever it would otherwise re-parse as markup, so parsing the rendered source returns the node it was rendered from. |
| `htmlToMarkdown`         | function | `(node: HTMLNode) => MarkdownDocument`                                                                                                      | Projects an `@orkestrel/html` `HTMLNode` into a `MarkdownDocument` — the HTML→markdown direction, and the inverse of `markdownToHTML`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `createProjection`       | function | `(parts?: Partial<MarkdownProjection>) => MarkdownProjection`                                                                               | Builds an HTML-to-markdown projection with absent fields defaulted from `EMPTY_PROJECTION` and the block/inline exclusivity invariant enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `trimInlines`            | function | `(nodes: readonly InlineNode[]) => readonly InlineNode[]`                                                                                   | Trims the whitespace at the two ends of an inline run — the leading whitespace of a leading text node and the trailing whitespace of a trailing one — dropping either node when nothing survives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `normalizeInlines`       | function | `(nodes: readonly InlineNode[], breaks: boolean) => readonly InlineNode[]`                                                                  | Reduces an inline run to the shape markdown can actually write back: adjacent text coalesced, empty text dropped, and every hard break either kept as a real line ending or spent as a space.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mergeProjections`       | function | `(children: readonly MarkdownProjection[]) => MarkdownProjection`                                                                           | Combines the projections of one node's children into the projection of that node — the single place inline runs become paragraphs, so no ancestor has to decide it twice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `projectHTMLLeaf`        | function | `(leaf: CommentNode \| DoctypeNode \| HTMLTextNode) => MarkdownProjection`                                                                  | Projects one HTML leaf — a text node, a comment, or a doctype — to its `MarkdownProjection`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `projectHTMLNode`        | function | `(node: ElementNode \| HTMLDocument, children: readonly MarkdownProjection[]) => MarkdownProjection`                                        | Projects one HTML container — the document root or an element — from its children's already-computed projections. The element mapping, and the only place that decides what an HTML tag becomes in markdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `projectionToBlocks`     | function | `(projection: MarkdownProjection) => readonly BlockNode[]`                                                                                  | Reads a projection as block content — the view a document, a blockquote, and a list item each need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `projectionToInlines`    | function | `(projection: MarkdownProjection) => readonly InlineNode[]`                                                                                 | Reads a projection as inline content — the view a link, an emphasis, and a table cell each need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `walkNodes`              | function | `(node: MarkdownNode) => Generator<MarkdownNode>`                                                                                           | Walks a `MarkdownNode` depth-first, pre-order, root-inclusive — yields the node itself, then recurses into its children (block children, list items, image/link inline children, table header/row cells' inline nodes) in walk order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `foldNode`               | function | `<T>(node: MarkdownNode, handlers: MarkdownHandlerMap<T>, depth: number) => T`                                                              | Folds a `MarkdownNode` into a `T` through a total catamorphism — children are folded first (post-order), then the node's own `MarkdownHandler` is invoked with the already-folded children.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rewriteDocument`        | function | `(document: MarkdownDocument, rewrite: MarkdownRewriteHandler) => MarkdownDerivation<MarkdownDocument>`                                     | Rewrites a `MarkdownDocument` bottom-up (copy-on-write) — each node's children are rewritten first (post-order), then `rewrite` is applied to the node itself; the document root is never passed to `rewrite` (the `element: 'document'` invariant always holds). A table's inline cells and a list's items are rewritten too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `flattenText`            | function | `(node: MarkdownNode) => string`                                                                                                            | Concatenates the `value` / `code` content of every descendant text / code-span / code-block node under `node`, including image alternative content, in walk order — the plain-text projection of an AST (search indexing, word counts, a text-only preview).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Compilers

From [`compilers.ts`](../src/core/compilers.ts) — the class-driving half of the outbound direction. `helpers.ts` owns the pure `markdownToHTML` projection and imports no implementation class; the compiler below constructs `@orkestrel/html`'s `HTML` class, so it sits above the leaves and consumes them.

| Compiler     | Kind     | Signature                        | Summary                                               |
| ------------ | -------- | -------------------------------- | ----------------------------------------------------- |
| `renderHTML` | function | `(node: MarkdownNode) => string` | Renders a `MarkdownNode` to sanitized canonical HTML. |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`) from [`shapers.ts`](../src/core/shapers.ts) — one shape compiles into a guard, coercing parser, JSON Schema, and seeded generator (the compilers live in `@orkestrel/contract`, invoked here through `createContract` in `factories.ts`). Only the non-recursive node types shape here; any type whose fields recurse into `BlockNode` / `InlineNode` / `MarkdownNode` stays guard-only (`validators.ts`, through `lazyOf`) — see [Relationship with @orkestrel/contract](#relationship-with-orkestrelcontract).

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. In a shaper table a `Shape` cell holds the node shape the value compiles into.

| Shaper               | Kind  | Shape                                         | Summary                                                                                                                                                                                                       |
| -------------------- | ----- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textShape`          | const | `{ element, value }`                          | Describes the shape of a `TextNode` — a plain-text leaf inline run.                                                                                                                                           |
| `codeSpanShape`      | const | `{ element, value }`                          | Describes the shape of a `CodeSpanNode` — an inline code span (\`\` \`code\` \`\`).                                                                                                                           |
| `lineBreakShape`     | const | `{ element }`                                 | Describes the shape of a `LineBreakNode` — a GFM hard line-break leaf.                                                                                                                                        |
| `codeBlockShape`     | const | `{ element, lang?, code }`                    | Describes the shape of a `CodeBlockNode` — a fenced code block. `lang` is optional (absent when the opening fence carries no info-string).                                                                    |
| `thematicBreakShape` | const | `{ element }`                                 | Describes the shape of a `ThematicBreakNode` — a horizontal rule. Carries no fields beyond its `element` discriminant.                                                                                        |
| `tableAlignShape`    | const | `'left' \| 'right' \| 'center'`               | Describes the shape of a `TableAlign` — the per-column GFM table alignment literal. Absence is no member of it, so the shape refuses the `null` a bare `---` delimiter takes in a `TableNode`'s `align` list. |
| `listItemMatchShape` | const | `{ ordered, start, content, indent, marker }` | Describes the shape of `ListItemMatch` — the parsed parts of a single list-item line the block phase's list detector returns. Fully non-recursive (no nested node fields), so every field shapes directly.    |

### Validators

Node guards, from [`validators.ts`](../src/core/validators.ts). The `is{Element}Node` guards narrow an already-parsed `MarkdownNode` by its `element` tag; the from-unknown guards (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) instead validate an arbitrary `unknown` value against the full node shape, composed from `@orkestrel/contract` combinators. Two distinct guard families: the **from-unknown boundary guards** (`isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`) take `unknown` and validate an entire untrusted value from scratch; the **narrowing guards** (`is{Element}Node`, for example `isTableNode`) take an already-typed `MarkdownNode` and narrow it to one member of the union by its `element` tag — they assume the value is already a valid node shape. The line and character structural predicates the parser tests raw strings with narrow nothing, so they are pure leaves in `helpers.ts` (§ [Helpers](#helpers)).

| Guard                 | Kind     | Signature                                           | Summary                                                                                                                                                                    |
| --------------------- | -------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isHeadingNode`       | function | `(node: MarkdownNode) => node is HeadingNode`       | Determines whether a node is a heading block.                                                                                                                              |
| `isParagraphNode`     | function | `(node: MarkdownNode) => node is ParagraphNode`     | Determines whether a node is a paragraph block.                                                                                                                            |
| `isListNode`          | function | `(node: MarkdownNode) => node is ListNode`          | Determines whether a node is a list block.                                                                                                                                 |
| `isTableNode`         | function | `(node: MarkdownNode) => node is TableNode`         | Determines whether a node is a GFM table block.                                                                                                                            |
| `isCodeBlockNode`     | function | `(node: MarkdownNode) => node is CodeBlockNode`     | Determines whether a node is a fenced code block.                                                                                                                          |
| `isBlockquoteNode`    | function | `(node: MarkdownNode) => node is BlockquoteNode`    | Determines whether a node is a blockquote block.                                                                                                                           |
| `isThematicBreakNode` | function | `(node: MarkdownNode) => node is ThematicBreakNode` | Determines whether a node is a thematic break (horizontal rule) block.                                                                                                     |
| `isTextNode`          | function | `(node: MarkdownNode) => node is TextNode`          | Determines whether a node is a plain text run.                                                                                                                             |
| `isEmphasisNode`      | function | `(node: MarkdownNode) => node is EmphasisNode`      | Determines whether a node is an emphasis run (`*em*` / `**strong**`).                                                                                                      |
| `isCodeSpanNode`      | function | `(node: MarkdownNode) => node is CodeSpanNode`      | Determines whether a node is an inline code span.                                                                                                                          |
| `isLineBreakNode`     | function | `(node: MarkdownNode) => node is LineBreakNode`     | Determines whether a node is a GFM hard line break.                                                                                                                        |
| `isLinkNode`          | function | `(node: MarkdownNode) => node is LinkNode`          | Determines whether a node is a link.                                                                                                                                       |
| `isImageNode`         | function | `(node: MarkdownNode) => node is ImageNode`         | Determines whether a node is an image.                                                                                                                                     |
| `isInlineNode`        | const    | `Guard<InlineNode>`                                 | Determines whether an arbitrary value is a valid `InlineNode` — a text run, emphasis, code span, hard break, link, or image, recursively validated.                        |
| `isBlockNode`         | const    | `Guard<BlockNode>`                                  | Determines whether an arbitrary value is a valid `BlockNode` — a heading, paragraph, list, table, code block, blockquote, or thematic break, recursively validated.        |
| `isMarkdownNode`      | const    | `Guard<MarkdownNode>`                               | Determines whether an arbitrary value is a valid `MarkdownNode` — the `MarkdownDocument` root, a `BlockNode`, a `ListItemNode`, or an `InlineNode`, recursively validated. |
| `isMarkdownDocument`  | const    | `Guard<MarkdownDocument>`                           | Determines whether an arbitrary value is a valid `MarkdownDocument` — the parsed-AST root `parseDocument` returns, recursively validated.                                  |

### Classes

The implementing class of `MarkdownInterface`, from [`Markdown.ts`](../src/core/Markdown.ts) —
documented in full under its own heading following this table.

| Name       | Kind  | Summary                                                                                                                                                                                                               |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Markdown` | class | Wraps a typed `MarkdownDocument` AST as a stateful, parsed markdown document with the query (`find` / `filter` / `reduce` / iteration), rewrite (`map`), fold, and streaming operations `MarkdownInterface` declares. |

### `Markdown`

A stateful, parsed markdown workspace, constructed from a markdown `string` (runs `parseDocument`) or an already-parsed `MarkdownDocument` (adopted as-is, not re-validated). Exposes its AST through the `readonly document` member (documented here in Surface prose, per the `ContractInterface` precedent, alongside `walk` — both are part of the documented surface even though `document` carries no row in the [`## Methods`](#methods) table below, which lists only call-signature members). `walk` is the deep traversal — a lazy, depth-first, pre-order, root-inclusive generator over every node; its sync `for (const node of markdown.walk())` surface is also consumable by `for await (const node of markdown.walk())` (JavaScript accepts a sync iterable in a `for await`), so an async pipeline needs no separate iterator. Contrast with `stream`: `walk` is deep (every node) and sync; `stream` is shallow (top-level blocks only) and backpressure-respecting. Immutable — `map` never mutates the stored AST, it returns a new `Markdown`. See [`## Methods`](#methods) for its public call-signature surface.

### Factories

From [`factories.ts`](../src/core/factories.ts).

| Factory                       | Kind     | Signature                                                  | Summary                                                                                                                                                                                   |
| ----------------------------- | -------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMarkdown`              | function | `(input: string \| MarkdownDocument) => MarkdownInterface` | Creates a stateful markdown handle from a markdown string or an already-parsed `MarkdownDocument` — a typed AST plus the query, rewrite, and fold operations `MarkdownInterface` exposes. |
| `createTextContract`          | function | `() => ContractInterface<TextNode>`                        | Compiles the `textShape` into a `ContractInterface` for `TextNode` — a guard, coercing parser, JSON Schema, and seeded generator from one shape declaration.                              |
| `createCodeSpanContract`      | function | `() => ContractInterface<CodeSpanNode>`                    | Compiles the `codeSpanShape` into a `ContractInterface` for `CodeSpanNode` — a guard, coercing parser, JSON Schema, and seeded generator from one shape declaration.                      |
| `createLineBreakContract`     | function | `() => ContractInterface<LineBreakNode>`                   | Compiles the `lineBreakShape` into a `ContractInterface` for `LineBreakNode`.                                                                                                             |
| `createCodeBlockContract`     | function | `() => ContractInterface<CodeBlockNode>`                   | Compiles the `codeBlockShape` into a `ContractInterface` for `CodeBlockNode` — a guard, coercing parser, JSON Schema, and seeded generator from one shape declaration.                    |
| `createThematicBreakContract` | function | `() => ContractInterface<ThematicBreakNode>`               | Compiles the `thematicBreakShape` into a `ContractInterface` for `ThematicBreakNode` — a guard, coercing parser, JSON Schema, and seeded generator from one shape declaration.            |

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name. The `readonly document` member is Surface-documented above, not listed here — this table lists exactly `MarkdownInterface`'s call-signature members.

#### `MarkdownInterface`

| Method   | Returns                                   | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walk`   | `Generator<MarkdownNode>`                 | Returns the deep traversal — a lazy, depth-first, pre-order, root-inclusive `Generator` over every `MarkdownNode` in the document. The sync `for (const node of markdown.walk())` surface is also consumable by `for await (const node of markdown.walk())` (JavaScript accepts a sync iterable in a `for await`), so async pipelines need no separate iterator. Contrast with `stream`: `walk` is deep, every-node, and sync; `stream` is shallow (top-level blocks only) and backpressure-respecting. |
| `find`   | `T \| MarkdownNode \| undefined`          | Finds the first node (depth-first, pre-order) narrowed by a type guard, and returns `undefined` when no node matches; a second overload takes a plain predicate.                                                                                                                                                                                                                                                                                                                                        |
| `filter` | `readonly T[] \| readonly MarkdownNode[]` | Collects every node (depth-first, pre-order) narrowed by a type guard; a second overload takes a plain predicate.                                                                                                                                                                                                                                                                                                                                                                                       |
| `span`   | `MarkdownSpan \| undefined`               | Reads the region of the original markdown string a node was produced from.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `map`    | `MarkdownInterface`                       | Rewrites the AST bottom-up (copy-on-write) and returns a new `MarkdownInterface`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reduce` | `T`                                       | Folds the AST depth-first, pre-order into an accumulator through a reducer callback.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `fold`   | `T`                                       | Runs a total catamorphism over the document using a `MarkdownHandlerMap` table.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `stream` | `ReadableStream<BlockNode>`               | Returns a web-standard `ReadableStream` over the document's top-level block nodes (shallow, source order) — a lazy, pull-based, backpressure-respecting source. A fresh, independently-replayable stream every call; never mutates the document.                                                                                                                                                                                                                                                        |

## The AST model

Every node is plain, readonly data with no behavior — a discriminated union keyed by `element` (never `kind` / `type`). Block nodes and inline nodes:

- **Block nodes** (`BlockNode`) carry document structure: `heading`, `paragraph`, `list` (of `listItem`s), `table`, `codeBlock`, `blockquote`, `thematicBreak`. A `MarkdownDocument` is the root — `{ element: 'document', children: readonly BlockNode[] }`.
- **Inline nodes** (`InlineNode`) carry the inline content of a heading / paragraph / list item / table cell: `text`, `emphasis` (nests further inline children — `**bold _and italic_**` is a strong node wrapping a text node and an emphasis node), `codeSpan` (verbatim, no inner markdown), `break` (a GFM hard line break), `link` (nests inline children for its text), and `image`.

Recursion in the AST is structural, not incidental: a `blockquote`'s `children` re-parse the de-quoted lines as blocks (so quotes nest), a `list`'s `items` each carry `BlockNode[]` (so a nested list is a `list` block inside a `listItem`'s children), and `emphasis` / `link` / `image` nest `InlineNode[]`. `MarkdownNode` is the exhaustive union every projection's `switch` covers: `MarkdownDocument | BlockNode | ListItemNode | InlineNode`.

### Images and hard breaks

An `ImageNode` carries its destination in `src` and its alternative content in `children`, exactly as a `LinkNode` carries `href` and its text — an image is a link that renders its target rather than pointing at it, and giving alt text the same inline children a link's text has means `walk`, `filter`, `map`, `fold`, and `flattenText` reach it without a special case. HTML's `alt` is a flat attribute, so the two directions meet in the middle: `markdownToHTML` writes `alt` from `flattenText`, and `htmlToMarkdown` reads `alt` back into a single text child.

A syntax hazard comes with each of them. An image is written `![alt](src)`, which is a `!` immediately followed by link syntax — so a `text` node that ends in `!` directly before a link would re-parse as an image it never was, and `renderMarkdown` backslash-escapes exactly that `!` and no other. A hard break is written as two trailing spaces before a newline, which is invisible and fragile: a break at either edge of a run has no line to end, a run of breaks reads as the blank line that would end the paragraph, and adjacent whitespace is eaten by line trimming. `renderMarkdown` writes what the AST holds, so keeping a break writable is the producer's job: `normalizeInlines` is the shared leaf that drops, merges, and trims breaks into the one shape markdown can carry, and spends a break as the space it stood for wherever the target is a single line (a heading, a table cell). The inbound projection runs every inline run through it for exactly that reason.

### Alignment and absence

`TableAlign` is `'left' | 'right' | 'center'` — three real GFM delimiter forms, and nothing else. A column that declares no alignment is an absence, not another mode, and the two places absence appears differ because their containers differ:

- `TableNode.align` is positional — one entry per column, in column order — and JSON cannot carry `undefined` inside an array without changing the array's length on a round trip. It uses `null`, which is also the honest reading of the source: GFM's bare `---` is an explicit "no alignment here" marker written by the author, not an omitted field.
- `MarkdownCell.align` is a plain optional property on one cell, so absence is `undefined` there, per the ordinary rule.

`renderHTML` emits an `align` attribute only for those literals; a `null` column emits no attribute at all. `renderMarkdown` writes `:---` / `---:` / `:---:` for them and a bare `---` for `null`, so the delimiter row round-trips exactly.

## The parse pipeline

`parseDocument(markdown)` runs its phases in order:

1. **Block phase** — splits the document into lines (`splitLines`, CRLF/CR normalized) and walks them, detecting fences, thematic breaks, ATX headings, blockquotes, GFM tables, and lists (`parseBlocks`, `collectTable`, `collectList`); anything left over collects into a paragraph. `startsBlock` lets a new block interrupt a paragraph without a separating blank line.
2. **Inline phase** — each block's raw text runs through `scanInline` (backslash escapes, code spans, links, images, emphasis, and the two-trailing-space hard break) through `parseInline`, then `coalesceText` merges adjacent text runs.

**Lines carry coordinates, not only text.** `splitLines` returns a `MarkdownSource` per line rather than a bare string: `{ text, segments }`, where `text` is the line a parser reads and `segments` are the `MarkdownSegment` runs mapping that text back to the original string. Each run is `{ offset, start, end }` — `offset` addresses `text`, `start` and `end` address the original, and the run's original length derives from `end - start` rather than being stored beside them. Every strip, trim, and join the block phase performs (`sliceSource`, `trimSource`, `stripQuote`, `joinSources`, `normalizeParagraphLine`, `splitTableSources`) narrows or remaps those runs instead of discarding them, so `projectSpan` turns a derived range back into an original one by resolving the range's two boundaries against those runs. It reports `undefined` when either boundary lands in a position the runs leave uncovered: joining two abutting regions with a separator leaves that separator's derived position uncovered. It bridges an uncovered interior when both boundaries resolve. That is what lets provenance be read off the source rather than reconstructed from node values, which would be wrong the moment a value differs from its spelling (§ [Source provenance](#source-provenance)).

`new Markdown(markdown)` (or `createMarkdown(markdown)`) calls `parseProvenance` internally and stores the resulting document as its `document`, alongside the span map `span` reads back. `markdownToHTML(node)`, `renderHTML(node)`, and `renderMarkdown(node)` are **separate**, downstream, standalone projections out of an AST — never fused into parsing, so a caller can inspect, transform, or fold the AST (through `Markdown`'s `find` / `filter` / `map` / `reduce` / `fold`) before ever calling one, or never call one at all. `htmlToMarkdown(node)` is the standalone projection in, and produces the same `MarkdownDocument` shape `parseDocument` does, so everything downstream of a parse works identically on a projection.

**Total / never-throw.** `parseDocument`, `markdownToHTML`, `renderHTML`, `renderMarkdown`, and `htmlToMarkdown` are all total functions: malformed markdown degrades to literal text (an unterminated `**` stays literal, a broken table falls back to a paragraph) rather than throwing, and hostile, cyclic, or pathologically deep HTML degrades rather than throwing. Inline scanning is index-based (no backtracking regex), so it is linear-time — no ReDoS on adversarial input.

### Depth degrade semantics

`MAX_DEPTH` (`64`) bounds several independent recursions, each degrading to a fixed, cheap fallback instead of recursing further:

- **Block recursion** (blockquote / list nesting, `parsers.ts`'s `parseBlocks`) — past the cap, the remaining lines collapse into **one literal paragraph** containing those lines joined by `\n`, instead of continuing to parse nested structure.
- **Inline recursion** (`scanInline` and `scanInlineSource`) — the engine recurses into `scanInlineSource` itself for a link's text, an image's alternative content, and an emphasis run's children, incrementing `depth` at each descent. Past the cap, the scan window is not scanned for markup at all; it emits as a **single literal text node**.
- **`markdownToHTML` / `renderHTML` recursion** — past the cap, a node is not projected structurally; it yields a text node carrying the `value` of a node that has one (a `TextNode`, `CodeSpanNode`, …), and **nothing at all** for a node with no `value` field. A table reserves the four levels its `thead` / `tbody` / `tr` / cell scaffolding costs and contributes nothing when they would not fit, and a code block reserves the two its `pre > code` costs, so generated structure is charged to the same budget as authored structure and cannot escape the cap. The internal `switch` also carries a `default` arm, so a fabricated node with an `element` outside the exhaustive set (bypassing the type system, for example through an untyped/deserialized value) contributes nothing rather than `undefined` — the projection is total even against a hostile `MarkdownNode`.
- **`renderMarkdown` recursion** — the same cap and the same value-bearing-vs-empty degrade rule, applied to canonical markdown source instead of HTML.
- **`walkNodes` / `foldNode` recursion** — descent stops at the cap; the node at the cap is still yielded/folded (with an empty children list for `foldNode`), its children are not.
- **`rewriteDocument` / `Markdown.map` recursion** — the same cap, because `map` delegates to `rewriteDocument`: at the cap, the subtree is passed through unchanged (by reference — not rebuilt, and `rewrite` is not invoked on it) instead of recursing further, so a pathologically deep adopted document cannot exhaust the call stack.
- **`htmlToMarkdown` recursion — the one inherited cap.** This is the only recursion here markdown does not own: the fold is `@orkestrel/html`'s `foldNode`, so its depth bound is html's, and html happens to cap at `64` as well. Nesting past it truncates on html's side before markdown ever sees the content, and because the projected chain can end a level or two deeper than `MAX_DEPTH`, `renderMarkdown` may then truncate the result a second time. Deeply nested HTML is therefore bounded by html's cap on the fold and then by `renderMarkdown`'s own, in sequence rather than by a single cap: the anchor law that follows holds within the depth budget, and beyond it only totality is promised.

Together these bound pathological or hostile input (deeply nested blockquotes, runaway emphasis, adversarially deep ASTs) so no parsing, projecting, or writing function can ever exhaust the call stack.

## Source provenance

A parse records the region of the source each node was produced from, and the `Markdown` instance
that ran the parse reads those regions back through `span`:

```ts
import { Markdown, isHeadingNode } from '@orkestrel/markdown'

const source = '# Title\n\nA **bold** word.'
const markdown = new Markdown(source)

const heading = markdown.find(isHeadingNode)
const region = heading === undefined ? undefined : markdown.span(heading)
region // { start: 0, end: 7 }
if (region !== undefined) source.slice(region.start, region.end) // '# Title'
```

These rules fix what a region means, and every one of them is about the string the instance was
constructed from:

- **A region addresses the original constructor string**, never the line text a later phase walks.
  `source.slice(region.start, region.end)` returns the original source the node was produced from,
  which is not the node's value: the region carries the syntax the value drops and the characters
  that normalization removed.
- **A region is half-open and counted in UTF-16 code units** — `start` inclusive, `end` exclusive.
  Its length derives from `end - start`; no length member exists to drift from the two offsets.
- **A parsed node covers the source it was produced from**, markers included, and sometimes more.
  The heading in the preceding fence starts at `0`, not at `2` where its text starts, and an
  emphasis node covers its `**` delimiters. A text node can also cover source its value drops: in
  `'a \nb'` the paragraph phase trims the trailing space, so the text node's `value` is `a\nb`
  while its region is `{ start: 0, end: 4 }` — the whole `a \nb`, trimmed space included.
- **A one-source rewrite keeps its source's region through `map`.** A node the handler replaced
  from one input node reports that input's region; a rebuilt ancestor reports its original's.
- **A node with no region in this handle reports `undefined`** — a foreign node, every node of an
  adopted document, and a rewrite output the handler built fresh from separate source nodes.

**A region always slices the constructor string verbatim; the derived text a phase reads does not.**
`splitLines` treats `\r\n` and a lone `\r` as terminators and drops them with the line boundary, so
a region can span a terminator the derived text no longer holds — that is what the separator segment
`joinSources` records is for. Inside a line the phases rewrite derived text too:
`normalizeParagraphLine` trims trailing spaces, `splitTableSources` turns an escaped `\|` into one
`|`, and the inline scan decodes every escape into the node's `value`. Each rewrite keeps the
original coordinates of what it retained, so a region still slices the constructor string verbatim
while the value it belongs to does not match that slice. Read provenance off the source; never
reconstruct it from a node value.

```ts
import { Markdown, isTextNode } from '@orkestrel/markdown'

const source = 'a \\* b *c*'
const markdown = new Markdown(source)

const [text] = markdown.filter(isTextNode)
text?.value // 'a * b ' — the escape decoded
const region = text === undefined ? undefined : markdown.span(text)
region // { start: 0, end: 7 } — the region slices the spelling `a \* b `, not the value
```

**`parseProvenance` is the handle-free entry point.** It returns the document and the
operation-owned span map together, so a caller that wants coordinates without a `Markdown` instance
gets the document and the map from one parse. `parseDocument` is its document projection, and constructing a `Markdown`
from a string runs it once and copies the map into the instance.

```ts
import { parseProvenance } from '@orkestrel/markdown'

const [document, spans] = parseProvenance('# Title\n\nA **bold** word.')
spans.get(document) // { start: 0, end: 25 } — the whole input
```

The map is keyed by node identity, so it addresses that document's nodes and no other. Two
instances over the same text hold independent maps, and a node from one reports `undefined` in the
other.

**A rewrite carries regions forward through its derivations.** `rewriteDocument` returns a
`MarkdownDerivation`, and `map` resolves each output node against the source instance's map in a
fixed order: an output identity that already holds a region keeps it, an output derived from one
input node takes that input's region, and anything else takes none. The resolution reads the direct
input the rewrite named for that output and stops there — it never follows a second derivation edge
back into an earlier rewrite's input.

```ts
import { Markdown, isTextNode } from '@orkestrel/markdown'

const markdown = new Markdown('# Hi\n\nText.')
const lowered = markdown.map((node) =>
	node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
)

const [first] = lowered.filter(isTextNode)
first?.value // 'hi'
const region = first === undefined ? undefined : lowered.span(first)
region // { start: 2, end: 4 } — where `Hi` sits in the original source
```

**Where provenance stops, and why.** An adopted document, the inbound projection, and a rewrite
output that holds no region of its own and was assembled from separate sources each report
`undefined` rather than an approximate region, because an approximate region is worse than none — it
claims the author wrote something they did not:

- **An adopted document.** `new Markdown(document)` parsed no string, so no coordinates exist to
  report. Adoption keeps the tree by reference and starts with an empty map, including where those
  nodes are shared with an instance that does have regions.
- **The inbound projection.** `htmlToMarkdown` folds an HTML node, which carries no markdown
  coordinates, so nothing it emits has a region — a paragraph `mergeProjections` synthesizes from a
  run of pending siblings least of all. That paragraph has no single source even in principle: it
  was assembled from an HTML wrapper's children, not written as a paragraph anywhere.
- **A rewrite output assembled from separate sources, where that output holds no region of its
  own.** A node the handler built fresh and returned for several input nodes is covered by no single
  region of the original, so `map` resolves it to `undefined`. An identity that already carries a
  region is the exception: returning an existing spanned node for several inputs keeps that node's
  own region, because own-region resolution runs first.

```ts
import { Markdown, htmlToMarkdown, isTextNode } from '@orkestrel/markdown'
import { parseDocument as parseHTML } from '@orkestrel/html'

const imported = new Markdown(htmlToMarkdown(parseHTML('<div>text<p>para</p></div>')))
imported.span(imported.document) // undefined — adopted, and projected from HTML

const markdown = new Markdown('a *b* c')
const joined = { element: 'text', value: 'joined' } as const
const merged = markdown.map((node) => (node.element === 'text' ? joined : node))
const [text] = merged.filter(isTextNode)
text === undefined ? undefined : merged.span(text) // undefined — one output, separate sources
```

`span` builds its return value fresh on every call, so a caller who mutates the object it hands
back changes nothing the next call reports.

### Coordinates inside a line

The block phase carries `MarkdownSource` values rather than strings (§ [The parse
pipeline](#the-parse-pipeline)), and the inline engine has an offset-bearing entry point of its own.
`scanInlineSource` runs the same scan `scanInline` does and records each node it emits into a
recorder the caller owns:

```ts
import { scanInlineSource, splitLines } from '@orkestrel/markdown'
import type { MarkdownNode, MarkdownSpan } from '@orkestrel/markdown'

const [line] = splitLines('> a *b*')
const spans = new Map<MarkdownNode, MarkdownSpan>()
const nodes = line === undefined ? [] : scanInlineSource(line, 2, line.text.length, spans, 0)

const [text, emphasis] = nodes
text === undefined ? undefined : spans.get(text) // { start: 2, end: 4 } — `a `
emphasis === undefined ? undefined : spans.get(emphasis) // { start: 4, end: 7 } — `*b*`
```

Every coordinate leaf is exported for the same reason the projection leaves are: a caller writing
their own block or inline phase over the same lines needs `sliceSource`, `trimSource`,
`joinSources`, `normalizeParagraphLine`, `splitTableSources`, and `projectSpan` to keep coordinates
the way the shipped phases do.

## Sanitization policy

There is one URL floor here, and markdown does not own it. `@orkestrel/html` owns HTML escaping, scheme judgement, and the sanitize floor; this package holds no escaper, no scheme list, and no sanitizer of its own, and composes with html's instead. A second copy would be a second thing to keep correct, and the failure mode of a sanitizer that has drifted from the one it was copied from is silent.

**`renderHTML` sanitizes, unconditionally.** It takes one argument and exposes no options, so there is no call shape that emits unsanitized HTML by accident:

```text
markdownToHTML(node) → new HTML(document).sanitize({ attributes: [...SAFE_ATTRIBUTES, 'src'] }) → renderHTML(document)
```

Only the middle step judges anything. `markdownToHTML` is deliberately inert: it leaves text literal and destinations unsanitized so that the projection stays a pure AST-to-AST mapping and a caller who wants a different policy can supply one. `markdownToHTML` projects only markdown's own node shapes — headings, paragraphs, links, images, emphasis, code, tables, and the rest — and never an `UNSAFE_ELEMENTS` tag such as `script`, the case the fence below exercises: raw HTML written in markdown source has no node shape of its own, so the parser leaves it as literal text and it reaches the output escaped rather than as an element. html's `UNSAFE_ELEMENTS` removal therefore has nothing to remove in this pipeline; what actually judges the projection's output is html's attribute floor, whose full refusal list — the always-stripped attributes and the hard-banned schemes — is [`guides/html.md`](./html.md)'s to state. The fence below shows one member of that floor: a `javascript:` destination stripped from a link's `href` and from an image's `src` while the element and its remaining content survive. This still runs unconditionally: `renderHTML` accepts any `MarkdownNode`, including one a caller constructed by hand, rewrote through `map`, or accepted from elsewhere, so it can never assume its input came from `parseDocument` on trusted markdown, and a hand-built node whose destination or attribute is hostile is still caught at this floor.

**The one widening: `src`.** html's `SAFE_ATTRIBUTES` deliberately omits resource `src`, because a sanitized page that keeps its `alt` text and loses its download is the safer default for a general HTML sanitizer. Markdown cannot accept that default — `![alt](src)` is syntax whose entire content is a destination — so `renderHTML` widens the attribute allowlist by exactly `src`, and by nothing else. The widening is narrow by construction: `src` is a member of html's `URL_ATTRIBUTES`, so every widened value still goes through `sanitizeURL`, and the hard refusals are not part of the allowlist axis at all and cannot be widened by anyone. A refused image keeps its element and its alt text and loses only the destination.

```ts
import { parseDocument, renderHTML } from '@orkestrel/markdown'

const source = [
	'<script>alert(1)</script>',
	'',
	'[link](javascript:alert(1))',
	'',
	'![alt](javascript:alert(1))',
	'',
	'![alt](https://x.dev/pic.png)',
].join('\n')

const html = renderHTML(parseDocument(source))
// '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p><a>link</a></p><p><img alt="alt"></p><p><img src="https://x.dev/pic.png" alt="alt"></p>'
// — the script line has no element shape of its own and renders as escaped text, so no
// script tag ever reaches the output for html's UNSAFE_ELEMENTS floor to remove; the
// javascript: link keeps its text and drops its href; the javascript: image keeps its
// element and its alt and drops only its src; the https: image keeps its src.
```

**What the composed output looks like.** These differences are worth stating plainly, because they are visible in any byte-level comparison against a hand-rolled markdown renderer:

- **`align`, not `style`.** A table cell declares alignment as `align="left"`, not `style="text-align:left"`. html strips `style` unconditionally before any allowlist check, so a style-carrying cell would arrive at the browser with its alignment silently gone; `align` survives because html narrows it to the closed `TABLE_ALIGNMENTS` set on table cells only.
- **Literal quotes in text.** html's text encoder emits `&`, `<`, and `>` and leaves `"` and `'` alone, which is correct for character data and keeps prose readable: `alert("x" & 'y')` renders as `alert("x" &amp; 'y')`. Attribute values are encoded separately and do get their quotes handled.
- **Compact bytes.** Canonical serialization writes no whitespace between blocks: `# Hi\n\nText.` renders as `<h1>Hi</h1><p>Text.</p>`, not as two newline-separated lines.
- **A refused URL loses the whole attribute.** html removes a URL attribute it refuses rather than emptying it, so a hostile link renders `<a>x</a>` and a hostile image `<img alt="x">` — the words survive, the attribute does not appear at all.

**The inbound rule is different, and that asymmetry is deliberate.** Outbound, sanitizing at the very end is right: `markdownToHTML` can stay inert because `renderHTML` is the only door to a string and it always sanitizes. Inbound there is no such door. `htmlToMarkdown` produces a `MarkdownDocument`, and the serializer that document eventually reaches — `renderMarkdown` — is not a sanitization boundary and must not become one: it writes markdown source, where a destination is content rather than an executed attribute, and where a value dropped late could not be told apart from a value the author wrote. So the projection bakes html's `sanitizeURL(value, SAFE_URL_SCHEMES)` in at projection time, on every `href` and every `src`, whether or not the AST was ever sanitized — a hand-built one never was. A refused destination empties to `''` and the link or image is kept (`[text]()`), because a bad URL is no reason to lose the words around it. Two pipelines, two last responsible moments; the rule sits at each one rather than in the same place twice.

**Wanting a stricter policy.** Because the composition is exposed rather than hidden, a caller who needs a narrower floor does not need an option on `renderHTML`: project with `markdownToHTML`, sanitize with `@orkestrel/html`'s own `HTML` class and whatever `SanitizeOptions` they want, and serialize with html's `renderHTML`. That path can narrow the element set, drop `src` again, or replace the scheme list — and it still cannot go below html's floor, which is the point. The inbound counterpart is [bringing your own element policy](#bringing-your-own-element-policy): the same composition seam placed where that direction's element mapping varies.

## `renderMarkdown` round-trip

`renderMarkdown` is the inverse of `parseDocument`: for any `MarkdownDocument` produced by `parseDocument`, `parseDocument(renderMarkdown(doc))` deep-equals `doc`, and `renderMarkdown` is idempotent — `renderMarkdown(parseDocument(renderMarkdown(doc))) === renderMarkdown(doc)`. It writes every node to one canonical markdown form, never the source's original (possibly variant) spelling:

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
| Block separation   | Exactly one blank line between top-level blocks; a document with zero blocks renders `''`.                                                |

Sanitization is not a markdown-writing concern and does not appear in that table. A destination that needed judging was judged earlier — by html's floor on the way out to HTML, or by `htmlToMarkdown` on the way in — so `renderMarkdown` writes what the AST holds and escapes only what re-parsing requires.

**Why emphasis alternates.** A single canonical marker would be canonical and wrong: `**b *c***` closes ambiguously, because three identical markers in a row have more than one reading. Alternating families by nesting parity removes the ambiguity structurally — a nested run never shares a delimiter with the run enclosing it, so `**b _c_**` and `*x _a **c** b_ y*` each have exactly one parse. The form is still canonical in the sense that matters: it is a function of the AST's emphasis depth alone, never of the source's original spelling, so `_a **c** b_` and `*a __c__ b*` both write as `*a __c__ b*` and re-parse to the same tree.

A `text` node's literal content is backslash-escaped wherever it would otherwise re-parse as different markup (a leading `#`, a leading list marker, a leading `---` / `~~~` run, a literal `*`/`_`/`` ` ``/`[`/`]`, a trailing `!` before a link); a heading whose inline text ends in a `#` run (with or without leading whitespace) has that run's first `#` backslash-escaped so it cannot be mistaken for an ATX closing sequence on reparse — the round-trip soundness a parser owes its inverse, so parsing the rendered source returns the document it was rendered from.

This guarantee is scoped to documents `parseDocument` produced (or an equivalent well-formed `MarkdownDocument`). A value fabricated through `map` (or constructed by hand) that stuffs block-significant content or an embedded newline into a node field `renderMarkdown` treats as literal text (a `TextNode.value`, a `LinkNode.href`, …) has no round-trip guarantee — `renderMarkdown` still never throws, but the resulting source is not guaranteed to reparse back to the same AST.

## `htmlToMarkdown` projection

`htmlToMarkdown` is the inbound direction: an `@orkestrel/html` `HTMLNode` in, a `MarkdownDocument` out, structurally identical to one `parseDocument` produces. It lives here rather than in html for the same reason `markdownToHTML` does — deciding that a `<pre>` is a fenced code block, that a `<div>` is nothing at all, and that a `<td>` holding two paragraphs must become one line of text is markdown-format knowledge, and html has no business carrying it.

**The engine is borrowed, the projection is not.** The traversal is html's own `foldNode` catamorphism, driven by a total handler table: `projectHTMLNode` for the containers (`document`, `element`) and `projectHTMLLeaf` for the leaves (`text`, `comment`, `doctype`). That is a deliberate reuse rather than a rebuild: html's fold already owns bottom-up ordering, cycle termination, and depth capping over its own AST, and reimplementing them here would mean maintaining a second, subtly different traversal of somebody else's data structure. What this package contributes is the fold value and the element mapping.

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
| `strong` / `b`, `em` / `i`    | strong and ordinary emphasis; whitespace padding moves outside the markers, because markdown refuses `* x *`               |
| `code`                        | a code span, from the raw subtree text with newline runs collapsed to one space                                            |
| `pre`                         | a code block: verbatim through a first `code` element child (its `language-` class naming the language), else `renderText` |
| `a`, `img`                    | a link and an image, each destination re-sanitized; an `img`'s `alt` becomes one text child                                |
| `ul` / `ol`                   | a list, ordered from the tag and numbered from `start`; one item per `li`, so an empty `li` is still an item               |
| `th` / `td`, `tr`, `table`    | a cell (alignment from its `align`), a row, and a GFM table whose header is the first `th`-bearing row                     |
| any `UNSAFE_ELEMENTS` element | nothing at all, text included                                                                                              |
| anything else                 | unwraps to its children                                                                                                    |

The `pre`, list, and table rows read their own node rather than only their children's projections, because HTML puts the fact in a position rather than in a value: a `pre` takes its body from its `code` child's raw text, a list takes one item per `li` child, and a `tr` accepts only its own direct cells while a `table` derives the header row from its own source structure.

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

`projectHTMLNode` and `projectHTMLLeaf` are exported as handlers, not hidden inside `htmlToMarkdown`, precisely so that the element mapping is replaceable without forking the projection. The vocabulary a replacement needs is exported alongside them: `createProjection` builds one with the exclusivity invariant enforced, `mergeProjections` combines a node's children into it, `projectionToBlocks` and `projectionToInlines` read one back out, and `trimInlines` and `normalizeInlines` reduce an inline run to a shape markdown can actually write. So a caller with a house rule — an element markdown has no opinion about, a wrapper that belongs in a blockquote, a `<kbd>` that reads better as code — writes one handler, delegates everything else to the default, and folds with html's `foldNode` exactly as `htmlToMarkdown` does:

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

Markdown's validation surface is a thin, purpose-built layer over `@orkestrel/contract`'s guard/combinator/shape machinery:

- **From-unknown guards for untrusted ASTs.** `isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument` (`validators.ts`) are `Guard<T>` values composed from `recordOf` / `arrayOf` / `unionOf` / `literalOf` / `lazyOf` — each is total (never throws, even on cyclic or adversarially deep input) because every combinator involved is throw-contained by `@orkestrel/contract`'s guard contract. These validate a value that did **not** necessarily come from `parseDocument` — a deserialized document, a value crossing a process/RPC boundary.
- **Leaf shapes + compiled contracts, in lockstep.** `shapers.ts` declares `ContractShape` values (`textShape`, `codeSpanShape`, `lineBreakShape`, `codeBlockShape`, `thematicBreakShape`, `tableAlignShape`, `listItemMatchShape`) for the AST's non-recursive node types. `factories.ts` compiles the node shapes among them through `createContract` into `ContractInterface<T>` bundles — `schema` / `is` / `parse` / `generate` derived from one declaration, so they can never drift from each other.
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
	return new Markdown(candidate) // adopted as-is, not re-validated
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

Each `map` call returns a new `MarkdownInterface` — the original `markdown` is never mutated, so a
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
import type { MarkdownHandlerMap } from '@orkestrel/markdown'

// A fold is total: one handler per element, no default arm, so a new AST node is a
// compile error here rather than a silent omission at runtime. Reach for `renderHTML`
// for real HTML — this table is the shape of an arbitrary projection, not a renderer.
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
markdown.fold(toHTML) // '<h1>Hi</h1>'
```

### Shallow streaming with `stream()`

`stream()` returns a web-standard `ReadableStream<BlockNode>` — a fresh, pull-based stream every
call (one block enqueued per `pull`, so a slow reader's backpressure is respected). Each of these
ways consumes it:

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
import type { MarkdownHandlerMap } from '@orkestrel/markdown'

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
const nodeCount = foldNode(heading, countHandlers, 0) // 2

// rewriteDocument is copy-on-write and returns a MarkdownDerivation: the rewritten value, plus
// the input node each rewritten node was produced from. An unchanged subtree keeps its
// identity, so an identity rewrite returns the very same document object and records no
// derivation at all.
const [rewritten, derivations] = rewriteDocument(markdown.document, (node) =>
	node.element === 'text' ? { element: 'text', value: node.value.toLowerCase() } : node,
)
rewritten.children.length === markdown.document.children.length // true — same shape, lowercased text
derivations.size > 0 // true — the rebuilt spine, keyed by the output nodes

const [unchanged] = rewriteDocument(markdown.document, (node) => node)
unchanged === markdown.document // true — nothing changed, so nothing was rebuilt

const fragment = parseInline('a **bold** span') // readonly InlineNode[], no block structure
```

### Scan one inline construct

The inline phase's construct scanners are exported leaves, so a caller can run one against a bare
string window without a document around it. Each returns its parsed node and the index its syntax
ended at, or `undefined` when the shape does not hold — the point at which the engine degrades the
opening marker to literal text.

```ts
import { scanEmphasis, scanInline, scanLink } from '@orkestrel/markdown'

scanInline('a **b** c', 0, 9) // readonly InlineNode[] — text, emphasis, text

const link = scanLink('[docs](https://x.dev)', 0, 21)
link?.node.href // 'https://x.dev'
link?.end // 21

const emphasis = scanEmphasis('**bold**', 0, 8)
emphasis?.node.strong // true
emphasis?.end // 8

scanLink('[unclosed', 0, 9) // undefined — degrades to a literal `[`
```

`locateLink` and `locateEmphasis` are the same scans without the node construction: they return the
syntax bounds alone, which is what the offset-bearing path needs to record a region before it builds
anything (§ [Source provenance](#source-provenance)).

`scanLink` and `scanEmphasis` are standalone leaves rather than steps of the engine. A parse runs
`scanInlineSource`, which locates each construct with `locateLink` / `locateEmphasis`, recurses into
itself for the construct's children, and passes that child run through `coalesceText` before storing
it. `scanLink` and `scanEmphasis` skip that step: `node.children` is the raw scan output, which
carries no coalescing guarantee. Apply `coalesceText` yourself when you depend on one.

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

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection (value + type exports), the `MarkdownInterface` ↔ `Markdown` method bijection, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Construct from a string and narrow with a guard` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/Markdown.test.ts`](../tests/src/core/Markdown.test.ts) — `walk` / `find` / `filter` / `map` / `reduce` / `fold` / `stream` behavior, construction from a string vs. an already-parsed document.
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) — `parseDocument` / `parseInline` / `parseBlocks`, incl. degrade semantics at `MAX_DEPTH`.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — structural predicates + per-node guards + the from-unknown AST guards (soundness on cyclic / adversarial input).
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the pure line/block/inline scanning leaves, including the `collectTable` / `collectList` construct scanners; `markdownToHTML` (the unsanitized projection) and `renderMarkdown` (canonical forms, the emphasis-parity corpus, the parse↔render round-trip); the projection leaves (`trimInlines` / `normalizeInlines` / `mergeProjections` / `projectionToBlocks` / `projectionToInlines` / `projectHTMLLeaf` / `projectHTMLNode`) and `htmlToMarkdown` end to end — element mapping, adversarial and cyclic input, the round-trip anchor law over the projection corpus, and the grand markdown → HTML → markdown trip; plus `walkNodes` / `foldNode` / `rewriteDocument` / `flattenText`.
- [`tests/src/core/compilers.test.ts`](../tests/src/core/compilers.test.ts) — `renderHTML` as the composed pipeline: structure, escaping and sanitization, the `@orkestrel/html` URL floor, the `src` widening, composed elements, and the `MAX_DEPTH` degrade arms.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — per-shape guard exactness, JSON Schema essentials, seeded generate round-trips, parse rebuilds, and bidirectional `Infer` ↔ interface type parity.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createMarkdown` + the compiled node contracts (`is` / `parse` / `schema` / `generate` round-trips).

## See also

- [`AGENTS.md`](../AGENTS.md) — the repository rules, including the documentation contract every guide here is held to.
- [`README.md`](README.md) — the guides index.
