# Parsers

> The wire + document primitives: parsers that turn raw text into complete decoded units. Two are stateful streaming parsers — a network read never lands on a unit boundary, so a byte stream arrives in whatever-sized pieces the transport felt like (splitting a JSON line or an SSE event anywhere: mid-key, mid-content, exactly on the delimiter). `NDJSONParser` and `SSEParser` absorb that: you feed each chunk to `parse` exactly as it arrives, and they buffer the trailing partial until the rest comes, so the units you get back are identical no matter where the boundaries fell. `NDJSONParser` turns a newline-delimited JSON stream into records (one object per `\n`-terminated line); `SSEParser` turns a Server-Sent-Events stream into events (one per blank line). Both are deliberately **minimal**: pure functional primitives that are **event-free** (no Emitter, no `on` hook — the whole surface is `parse` + `reset`) and **total** (never throw).
>
> The third, `MarkdownParser`, is a whole-document parser — terrain's own zero-dependency, types-first markdown engine. It turns a GitHub-Flavored-Markdown string into a typed **AST** (a discriminated union of node values keyed by `element`) and — SEPARATELY — renders that AST to a safe HTML string. The AST is the contract (render-agnostic, exhaustively testable); the renderer is a downstream projection that HTML-escapes all text + attributes and sanitizes link `href`s so even hostile content cannot inject markup or script. It is the engine the Phase-2 docs site renders the project's own `guides/*.md` with, so it handles the real GFM constructs those guides use: ATX headings, paragraphs, ordered/unordered/nested lists, GFM tables (with column alignment), fenced code blocks + inline code, links, bold/italic emphasis, blockquotes, horizontal rules. Like the streaming parsers it is **total** (malformed markdown degrades to text, never throws) and **zero-dependency** (a hand-written scanner — no regex-only structural parse — and linear-time inline scanning, so no ReDoS).
>
> The fourth, `CSVParser`, is the other whole-document parser — an RFC-4180-style CSV engine in the `MarkdownParser` mold (stateless: no buffer, no `reset`). `parse` turns a CSV string into its rows of **decoded cells**: a `"` opens a quoted run, `""` inside quotes is a literal `"`, and embedded commas AND line breaks inside quotes are content — a multi-line quoted cell reassembles into ONE cell, so one logical row can span several physical lines. `serialize` is the exact inverse: it quotes exactly the cells that need it and joins rows with `\n`, so `parse(serialize(rows))` round-trips. Like its siblings it is **total** (an unterminated quote runs to the end of the input, never throws).
>
> All four are fully **generic** — no provider / server / agent coupling — so they parse _any_ such input and are testable with plain strings: no network, no fakes. The streaming parsers are the wire layer a streaming consumer sits on: a `fetch` NDJSON byte stream drives `NDJSONParser`, and an SSE writer is the EXACT inverse of `SSEParser`. Source: [`src/core/parsers`](../../src/core/parsers). Surfaced through the `@src/core` barrel.

## Surface

Create a streaming parser and feed it chunks as they arrive; each `parse(chunk)` returns the records completed so far, and a trailing partial line is held for the next call:

```ts
import { createNDJSONParser } from '@src/core'

const parser = createNDJSONParser()
parser.parse('{"a":1}\n{"b"') // [{ a: 1 }] — the second line is still partial
parser.parse(':2}\n') // [{ b: 2 }] — the split line reassembled
parser.reset() // drop any buffered partial — ready for a fresh stream
```

How it works: `parse(chunk)` appends `chunk` to its buffer and splits on `\n`. Every line _before_ the last is `\n`-terminated — hence complete — and is parsed to a record; the final segment is the trailing partial line and is held back for the next call. So a line split across calls is reassembled the moment its closing `\n` arrives; a chunk with no `\n` at all emits nothing and buffers entirely; a line that never gets a `\n` is never emitted (incomplete is incomplete, even if the buffered text already happens to be valid JSON). Three filters then decide what comes back: malformed JSON is silently skipped (never thrown), non-object values (arrays / primitives / `null`) are dropped, and empty / whitespace-only lines are ignored — so you only ever see complete, plain records. `reset()` discards any buffered partial so the next `parse` starts a fresh stream.

`SSEParser` is the same shape over the Server-Sent-Events wire — feed it chunks, get back dispatched events:

```ts
import { createSSEParser } from '@src/core'

const parser = createSSEParser()
parser.parse('data: a\ndata: b\n\n') // [{ data: 'a\nb' }] — the two data lines joined by \n
parser.parse('event: ping\ndata: 1') // [] — the event is buffered until its blank line
parser.parse('\n\n') // [{ data: '1', event: 'ping' }]
parser.reset() // drop any buffered partial event — ready for a fresh stream
```

**The SSE wire format**, as the parser implements it. A stream is a sequence of events separated by a **blank line**. Within an event, each line is a `field: value` — one optional space after the colon is stripped; a line with no colon is that field with an empty value; a line _starting_ with a colon is a comment (ignored). Four fields are understood (everything else is ignored):

- **`data`** is appended to the event's data buffer — and **multiple `data:` lines concatenate with `\n`** (`data: a` + `data: b` → `"a\nb"`, no trailing newline). This is why the surface example's two `data:` lines come back as one `'a\nb'`.
- **`event`** sets the event type; **`id`** sets the last-event-id — both last-wins. An `id` whose value contains a NUL is voided per spec (never surfaced).
- **`retry`** sets the reconnection time in ms, integer-only — a non-integer value is ignored, never thrown.

A **blank line dispatches** the accumulated event — but it emits an `SSEEvent` _only when the data buffer is non-empty_, so a comment-only or field-only block produces nothing. After a dispatch the data buffer + event type reset for the next event, while `id` / `retry` ride out on the emitted event for the consumer to track as connection state. The parser is robust about the wire's edges: `\r\n`, `\r`, and `\n` are all valid terminators (normalized — even a CRLF whose halves straddle a chunk boundary), and a leading byte-order mark on the very first chunk is stripped. And like `NDJSONParser`, an event split across chunk boundaries is buffered and reassembled, and an un-terminated final event stays buffered until its blank line.

`MarkdownParser` is the whole-document parser — give it a markdown string, get back a typed AST; render the AST to HTML separately:

```ts
import { createMarkdownParser } from '@src/core'

const parser = createMarkdownParser()
const ast = parser.parse('# Title\n\nRead the [guide](./guide.md) — it is **good**.')
ast.children[0] // { element: 'heading', level: 1, children: [{ element: 'text', value: 'Title' }] }
parser.render(ast) // '<h1>Title</h1>\n<p>Read the <a href="./guide.md">guide</a> — it is <strong>good</strong>.</p>'
parser.parseInline('a `code` span') // [{ element: 'text', value: 'a ' }, { element: 'codeSpan', value: 'code' }, …]
```

**Two phases, one AST.** `parse(markdown)` runs a **block phase** (headings / paragraphs / lists / GFM tables / fenced code / blockquotes / thematic breaks) then an **inline phase** (emphasis / inline code / links) over each block's text, producing a `MarkdownDocument` — the root of a discriminated union keyed by `element` (`'document'` / `'heading'` / `'paragraph'` / `'list'` / `'listItem'` / `'table'` / `'codeBlock'` / `'blockquote'` / `'thematicBreak'` and the inline `'text'` / `'emphasis'` / `'codeSpan'` / `'link'`). The AST is the primary contract — render-agnostic and exhaustively testable. `parseInline(text)` exposes the inline phase alone (no block structure).

**Render is a separate, safe projection.** `render(node)` walks the AST to an HTML string. It is kept distinct from parse so the AST stays the single source of truth — and it is XSS-safe by construction: every text run, code body, and attribute value is HTML-escaped (`<` / `>` / `&` / `"` / `'`), and every link `href` is sanitized — a destination whose scheme is not `http` / `https` / `mailto` / `tel` (notably `javascript:` / `data:` / `vbscript:`) is dropped to an empty `href`, while a relative / anchor / scheme-less destination is kept. The docs site renders TRUSTED guide content, but the escaping is unconditional (defence in depth).

**The supported GFM subset** (a pragmatic subset covering the real guides): ATX headings `#`–`######` (a `#`-run of 7+ or one not followed by a space degrades to a paragraph; an optional closing `###` is stripped); paragraphs (a block may follow a paragraph without a blank line); `-` / `*` / `+` bulleted and `1.` / `1)` ordered lists with arbitrary nesting (an ordered list carries its `start`); GFM tables (a header row immediately followed by a `:?-+:?` delimiter row — per-column `left` / `right` / `center` / `none` alignment, short rows padded, over-long rows truncated); ` ``` `/`~~~` fenced code blocks (info-string language tag, content verbatim — no inner markdown) and inline `` `code` `` spans; `[text](href)` links; `*` / `_` emphasis and `**` / `__` strong (nesting + backslash escapes); `>` blockquotes (nested blocks); and `---` / `***` / `___` thematic breaks. Deliberately **not** supported (out of scope for the guides): setext (underline) headings, reference-style / autolink links, HTML blocks / raw inline HTML (raw `<…>` is escaped as text, never passed through), images, task-list checkboxes, footnotes, and `~~strikethrough~~`.

`CSVParser` is the other whole-document parser — give it a CSV string, get back its rows of decoded cells; serialize rows back to a CSV string separately:

```ts
import { createCSVParser } from '@src/core'

const parser = createCSVParser()
parser.parse('id,city\n1,"Miami, FL"') // [['id', 'city'], ['1', 'Miami, FL']] — the quoted comma is content
parser.parse('a,"multi\nline",z') // [['a', 'multi\nline', 'z']] — one logical row across two physical lines
parser.serialize([['a', 'say "hi"']]) // 'a,"say ""hi"""' — quoted exactly where needed
```

**Quote-aware, RFC-4180-style.** A `"` opens a quoted run, `""` inside quotes is a literal `"`, and embedded commas AND line breaks inside quotes are content — a multi-line quoted cell reassembles into ONE cell (this is why the parser reads the WHOLE document instead of splitting on lines first). Outside quotes `\n`, `\r\n`, and `\r` all end a row. The edges are pinned: a trailing final terminator adds NO extra empty row (`'a,b\n'` is one row), an interior empty line is a one-empty-cell row (`['']`), and the empty string parses to `[]`. **Total** — an unterminated quote runs to the end of the input and adversarial garbage degrades to cells, never a throw. **`serialize` is the exact inverse:** each cell goes through `escapeCSVCell` (quoted + internal quotes doubled only when it contains a `,` / `"` / line break), cells join with `,`, rows join with `\n` with no trailing newline — so `parse(serialize(rows))` round-trips. Stateless like `MarkdownParser` (no buffer, no `reset`), so one handle serves any number of documents.

### Factories

| API                    | Kind     | Summary                                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `createNDJSONParser`   | function | Create an `NDJSONParserInterface` — a stateful NDJSON stream parser over `parse` / `reset`.               |
| `createSSEParser`      | function | Create an `SSEParserInterface` — a stateful Server-Sent-Events stream parser over `parse` / `reset`.      |
| `createMarkdownParser` | function | Create a `MarkdownParserInterface` — a stateless markdown parser over `parse` / `parseInline` / `render`. |
| `createCSVParser`      | function | Create a `CSVParserInterface` — a stateless, quote-aware CSV parser over `parse` / `serialize`.           |

### Entities

| API              | Kind  | Summary                                                                                                                         |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NDJSONParser`   | class | A stateful NDJSON stream parser that emits complete `\n`-terminated lines as records and buffers a trailing partial.            |
| `SSEParser`      | class | A stateful Server-Sent-Events stream parser that dispatches events on blank lines and buffers an in-progress event.             |
| `MarkdownParser` | class | A stateless markdown parser — `parse` to a typed AST (block then inline phase), `render` to a safe HTML string.                 |
| `CSVParser`      | class | A stateless, quote-aware CSV parser — `parse` to rows of decoded cells (multi-line quoted cells reassembled), `serialize` back. |

### Constants

| Constant           | Kind  | Value                                                                                                            |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `NUL`              | const | The NUL byte (`U+0000`) — an SSE `id:` whose value contains it is voided per spec, so the `id` never surfaces.   |
| `BOM`              | const | The byte-order mark (`U+FEFF`) stripped from the very first chunk of an SSE stream (later chunks' are content).  |
| `SAFE_URL_SCHEMES` | const | The link-`href` scheme allowlist the renderer permits (`http` / `https` / `mailto` / `tel`); others are dropped. |

### Helpers

The block / inline phases expose their **pure, total leaf helpers** — the line + block extractors, the inline sub-scanners, and the escaping primitives — as exported functions; `MarkdownParser` composes them and keeps the state-touching recursion (block / list / table collection and the whole renderer) as private methods (AGENTS §5). The CSV engine follows the same split: the quote-aware cell scanner and the escaping / serialization pair are exported leaves, and `CSVParser`'s `parse` is the cell → row assembly composition. Each leaf is individually unit-testable.

| API               | Kind     | Summary                                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `splitLines`      | function | Normalize line endings to `\n` and split a markdown document into its lines.                |
| `leadingIndent`   | function | The count of leading space / tab characters on a line.                                      |
| `extractHeading`  | function | Extract an ATX heading line into its `{ level, text }`, or `undefined`.                     |
| `extractFence`    | function | Extract a fenced-code opening line into its `{ marker, lang }`, or `undefined`.             |
| `extractListItem` | function | Extract a list-item line into its `ListItemParts`, or `undefined`.                          |
| `stripQuote`      | function | Strip one level of blockquote marker (`>` + optional space) from a line.                    |
| `splitTableRow`   | function | Split one GFM table row into its cell strings (escaped `\|` literal, outer pipes dropped).  |
| `tableAlignments` | function | Derive the per-column `TableAlign` list from a GFM delimiter row.                           |
| `startsBlock`     | function | Whether the line at an index starts a NEW block kind (the paragraph-collector stop test).   |
| `unescapeText`    | function | Resolve backslash escapes in a raw string to their literal characters.                      |
| `coalesceText`    | function | Merge adjacent text nodes in an inline-node list into one.                                  |
| `scanCode`        | function | Scan an inline code span at an index, or `undefined`.                                       |
| `scanLink`        | function | Scan a `[text](href)` link at an index into its `LinkNode` + end, or `undefined`.           |
| `scanEmphasis`    | function | Scan an emphasis run at an index into its `EmphasisNode` + end, or `undefined`.             |
| `scanInline`      | function | Scan a window of inline source into inline nodes — the recursive inline engine.             |
| `escapeHtml`      | function | HTML-escape text content (`&` / `<` / `>` / `"` / `'`).                                     |
| `sanitizeUrl`     | function | Sanitize + attribute-escape a link `href` (an unsafe scheme is dropped to an empty string). |
| `scanCSVCell`     | function | Scan ONE CSV cell at an index into its `CSVCellParts` — quote-aware, total.                 |
| `escapeCSVCell`   | function | Escape one cell for CSV output — quoted + quotes doubled only when it needs it.             |
| `serializeCSVRow` | function | Serialize one CSV row — each cell escaped, joined with `,` (no row terminator).             |

### Validators

Total line predicates and AST node guards. The line predicates test raw strings during parsing; the node guards narrow a `MarkdownNode` to one node type by its single-word `element` discriminant (AGENTS §14). A non-match returns `false`, never throws.

| Guard              | Kind     | Narrows to / tests                                                     |
| ------------------ | -------- | ---------------------------------------------------------------------- |
| `isWhitespace`     | function | Whether a character is inline whitespace (the emphasis flanking test). |
| `isEscapable`      | function | Whether a character is escapable by a leading backslash.               |
| `isQuote`          | function | Whether a line begins a blockquote (`>`).                              |
| `isFenceClose`     | function | Whether a line closes a fence opened by a given marker run.            |
| `isThematicBreak`  | function | Whether a line is a thematic break (`---` / `***` / `___`).            |
| `isTableStart`     | function | Whether a header + delimiter pair opens a GFM table.                   |
| `isHeadingNode`    | function | A `HeadingNode` (`element: 'heading'`).                                |
| `isParagraphNode`  | function | A `ParagraphNode` (`element: 'paragraph'`).                            |
| `isListNode`       | function | A `ListNode` (`element: 'list'`).                                      |
| `isTableNode`      | function | A `TableNode` (`element: 'table'`).                                    |
| `isCodeBlockNode`  | function | A `CodeBlockNode` (`element: 'codeBlock'`).                            |
| `isBlockquoteNode` | function | A `BlockquoteNode` (`element: 'blockquote'`).                          |
| `isTextNode`       | function | A `TextNode` (`element: 'text'`).                                      |
| `isEmphasisNode`   | function | An `EmphasisNode` (`element: 'emphasis'`).                             |
| `isCodeSpanNode`   | function | An `InlineCodeNode` (`element: 'codeSpan'`).                           |
| `isLinkNode`       | function | A `LinkNode` (`element: 'link'`).                                      |

### Types

| Type                      | Kind      | Shape                                                                                                                                       |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `NDJSONParserInterface`   | interface | The `parse(chunk) => readonly Record<string, unknown>[]` and `reset()` methods — a stateful NDJSON stream parser's contract.                |
| `SSEParserInterface`      | interface | The `parse(chunk) => readonly SSEEvent[]` and `reset()` methods — a stateful SSE stream parser's contract.                                  |
| `SSEEvent`                | interface | One dispatched Server-Sent Event: `readonly data: string` + optional `event` / `id` / `retry` (the blank-line-flushed value).               |
| `MarkdownParserInterface` | interface | The `parse(markdown)` / `parseInline(text)` / `render(node)` methods — the markdown parser's contract.                                      |
| `CSVParserInterface`      | interface | The `parse(text) => readonly CSVRow[]` and `serialize(rows) => string` methods — the CSV parser's contract.                                 |
| `CSVRow`                  | type      | One parsed CSV row — the decoded cell strings of a single logical record (`readonly string[]`), in column order.                            |
| `CSVCellParts`            | interface | The parsed parts of one CSV cell — the decoded `value`, the resume index `end`, and the `terminator` (`'comma'` / `'break'` / `'end'`).     |
| `MarkdownDocument`        | interface | The AST root — `element: 'document'` + the ordered `children: readonly BlockNode[]`.                                                        |
| `MarkdownNode`            | type      | Any AST node — the `MarkdownDocument` root, a `BlockNode`, a `ListItemNode`, or an `InlineNode`.                                            |
| `BlockNode`               | type      | A block-level node — `HeadingNode` / `ParagraphNode` / `ListNode` / `TableNode` / `CodeBlockNode` / `BlockquoteNode` / `ThematicBreakNode`. |
| `InlineNode`              | type      | An inline node — `TextNode` / `EmphasisNode` / `InlineCodeNode` / `LinkNode`.                                                               |
| `HeadingNode`             | interface | An ATX heading — `element: 'heading'` + `level` (1–6) + inline `children`.                                                                  |
| `ParagraphNode`           | interface | A paragraph — `element: 'paragraph'` + inline `children`.                                                                                   |
| `ListNode`                | interface | A list — `element: 'list'` + `ordered` + `start` + `items: readonly ListItemNode[]`.                                                        |
| `ListItemNode`            | interface | One list item — `element: 'listItem'` + the block `children` of the item.                                                                   |
| `ListItemParts`           | interface | The parsed parts of a list-item line — `ordered` / `start` / `content` / `indent` / `marker`.                                               |
| `TableNode`               | interface | A GFM table — `element: 'table'` + `header` + `rows` + per-column `align`.                                                                  |
| `TableAlign`              | type      | A column's alignment — `'none'` / `'left'` / `'right'` / `'center'`.                                                                        |
| `CodeBlockNode`           | interface | A fenced code block — `element: 'codeBlock'` + optional `lang` + verbatim `code`.                                                           |
| `BlockquoteNode`          | interface | A blockquote — `element: 'blockquote'` + the block `children` of the de-quoted lines.                                                       |
| `ThematicBreakNode`       | interface | A thematic break (horizontal rule) — `element: 'thematicBreak'`.                                                                            |
| `TextNode`                | interface | A run of plain text — `element: 'text'` + the literal `value` (escapes resolved, not yet HTML-escaped).                                     |
| `EmphasisNode`            | interface | Emphasized inline content — `element: 'emphasis'` + `strong` + inline `children`.                                                           |
| `InlineCodeNode`          | interface | An inline code span — `element: 'codeSpan'` + the verbatim `value`.                                                                         |
| `LinkNode`                | interface | An inline link — `element: 'link'` + `href` (sanitized at render) + inline `children`.                                                      |

`NDJSONParserInterface` and `SSEParserInterface` are all call-signature members, so they carry no `## Surface` data rows — their methods are documented under [Methods](#methods). `MarkdownParserInterface` and `CSVParserInterface` are likewise all methods. `SSEEvent`, `CSVRow`, `CSVCellParts`, and the markdown AST node types are plain-data types: their fields are described in the Types rows above (and the discriminant of every AST node is its single-word `element` — as `CSVCellParts`'s is its `terminator` — the axis that varies, AGENTS §4.4, never `kind` / `type`).

## Methods

The public methods of each parser interface — every call-signature member listed. `NDJSONParser`, `SSEParser`, `MarkdownParser`, and `CSVParser` each implement their interface exactly, so this doubles as each class's instance-method surface (AGENTS §22).

#### `NDJSONParserInterface`

`parse` feeds a chunk and returns the records completed so far; `reset` is the §10 reset — it drops any buffered partial line for a fresh stream.

| Method  | Returns                              | Behavior                                                                                                                                             |
| ------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `readonly Record<string, unknown>[]` | Append `chunk`, then return every COMPLETE `\n`-terminated line parsed to a record (malformed / non-object skipped); retain a trailing partial line. |
| `reset` | `void`                               | Drop any buffered partial line — reset for a fresh stream.                                                                                           |

#### `SSEParserInterface`

`parse` feeds a chunk and returns the events a blank line has dispatched so far; `reset` is the §10 reset — it drops any buffered partial line and in-progress event for a fresh stream.

| Method  | Returns               | Behavior                                                                                                                                                                                             |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `readonly SSEEvent[]` | Append `chunk`, then return every event a blank line DISPATCHED (its `data:` fields joined by `\n`, plus the last `event:` / `id:` / `retry:`); retain an in-progress event + trailing partial line. |
| `reset` | `void`                | Drop any buffered partial line and in-progress event — reset for a fresh stream.                                                                                                                     |

#### `MarkdownParserInterface`

`parse` turns a whole markdown string into a typed `MarkdownDocument` AST; `parseInline` runs the inline phase alone over a single line; `render` projects any AST node to a safe HTML string. All three are pure + total (malformed input degrades, never throws).

| Method        | Returns                 | Behavior                                                                                                                 |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `parse`       | `MarkdownDocument`      | Parse a markdown string into the AST — block phase then inline phase. Never throws.                                      |
| `parseInline` | `readonly InlineNode[]` | Parse a single line of inline content (emphasis / code / links) into inline nodes. Never throws.                         |
| `render`      | `string`                | Render a parsed node (typically the `MarkdownDocument`) to an HTML string — text + code escaped, link `href`s sanitized. |

#### `CSVParserInterface`

`parse` turns a whole CSV string into its rows of decoded cells; `serialize` is the exact inverse. Both are pure + total (an unterminated quote runs to the end of the input, never throws).

| Method      | Returns             | Behavior                                                                                                                         |
| ----------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `parse`     | `readonly CSVRow[]` | Parse a CSV string into rows of decoded cells — quote-aware, incl. multi-line quoted cells. Never throws.                        |
| `serialize` | `string`            | Serialize rows to a CSV string — cells escaped (quoted exactly when needed) + `,`-joined, rows `\n`-joined, no trailing newline. |

## Contract

These invariants hold across `src/core/parsers` ↔ `parsers.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables is a real export of the parsers module, and every export appears as a Surface row — exhaustive, both directions (AGENTS §22).
2. **Partial-line buffering (streaming parsers).** `parse(chunk)` appends `chunk` to an internal buffer, splits the buffer on `\n`, and emits every line BEFORE the last one — each is `\n`-terminated, hence complete — while the final segment (the trailing partial line) is retained for the next call. A line split across two or more calls is reassembled exactly once its closing `\n` arrives; the records come back in stream order regardless of where the chunk boundaries fall (mid-content, mid-key, exactly at the `\n`).
3. **Only complete lines emitted.** A chunk with no `\n` emits nothing and buffers entirely; a final newline-less fragment stays buffered until a `\n` arrives. A never-terminated line is therefore NEVER emitted — incomplete is incomplete, even when the buffered text is itself syntactically valid JSON (a line is complete only when newline-terminated).
4. **Records only, malformed-safe.** Each complete line is `JSON.parse`d inside a `try`/`catch` gated by `isRecord`: a malformed line is silently skipped and NEVER throws (a partial or garbage line cannot crash the parser), and a non-object value (an array, a primitive, `null`) is dropped — only plain records (objects) are returned. Subsequent valid lines after a skipped one still parse.
5. **Empty / whitespace lines skipped.** A `trim`-empty line between records — a blank line, a run of consecutive `\n`, a whitespace-only line — is skipped and contributes no record.
6. **`reset` clears the buffer (§10).** `reset()` discards any buffered partial line; a subsequent `parse` starts fresh (a previously-buffered fragment is gone, and the text that would have completed it is then its own line). `reset()` on an empty buffer is a safe no-op.
7. **Generic and reusable.** The parsers have no provider coupling — they parse ANY such input and are fully testable with plain strings (no network, no fakes). Pair a streaming parser with a `TextDecoder({ stream: true })` when reading a byte stream so multi-byte UTF-8 characters split across reads are handled: the decoder handles partial CHARS, the parser handles partial LINES.
8. **Event-free + total.** All four parsers are pure functional primitives: no Emitter, no `EventMap`, no `on` hook — so the surface above stays minimal — and none ever throws on malformed input (a garbage NDJSON line is skipped; a non-integer SSE `retry` is ignored; malformed markdown degrades to text; an unterminated CSV quote runs to the end of the input).
9. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly `NDJSONParserInterface`'s, `SSEParserInterface`'s, `MarkdownParserInterface`'s, and `CSVParserInterface`'s public methods — exhaustive, both directions — and `NDJSONParser` / `SSEParser` / `MarkdownParser` / `CSVParser` each expose the same public methods, no more (AGENTS §22).
10. **SSE blank-line dispatch.** `SSEParser.parse(chunk)` accumulates `field: value` lines into an in-progress event and emits one `SSEEvent` per **blank line** — but only when the data buffer is non-empty (an empty-data dispatch, e.g. a comment-only or field-only block, emits nothing). After a dispatch the data buffer + event type reset for the next event; `id` / `retry` ride on the emitted event for the consumer to track as connection state.
11. **SSE field rules.** One optional space after the colon is stripped; a no-colon line is that field with an empty value; a line starting with a colon is a comment (ignored); unknown fields are ignored. Multiple `data:` lines concatenate with `\n` (no trailing newline); `event` / `id` are last-wins; an `id` containing a NUL is voided; `retry` is integer-only (a non-integer is ignored, never thrown).
12. **SSE line endings + BOM + cross-chunk.** `\r\n`, `\r`, and `\n` are all valid terminators (normalized, including a CRLF whose halves straddle a chunk boundary — the matching `\n` after a `\r` is swallowed, never read as a spurious blank line); a leading byte-order mark on the very first chunk is stripped (later chunks' leading BOMs are ordinary content). An event split across chunk boundaries is buffered and reassembled — events come back in stream order regardless of where the boundaries fall — and an un-terminated final event stays buffered until its blank line, exactly like `NDJSONParser`'s partial line.
13. **Markdown: AST is the contract; render is separate.** `MarkdownParser.parse(markdown)` returns a render-agnostic `MarkdownDocument` — a discriminated union of node values, each keyed by its single-word `element` discriminant (the axis that varies, never `kind` / `type` — AGENTS §4.4). `render(node)` is a SEPARATE downstream projection from an AST node to an HTML string; parse never produces HTML, and the AST is the single source of truth the renderer reads. `parseInline(text)` runs the inline phase alone.
14. **Markdown: two phases over a fixed GFM subset.** `parse` runs a block phase (ATX headings 1–6 · paragraphs · `-`/`*`/`+` bulleted + `1.`/`1)` ordered lists with nesting · GFM tables with per-column alignment, padded/truncated rows · ` ``` `/`~~~` fenced code blocks · `>` blockquotes · `---`/`***`/`___` thematic breaks) then an inline phase (`*`/`_` emphasis + `**`/`__` strong with nesting · `` `code` `` spans · `[text](href)` links · backslash escapes) over each block's inline text. Code (fenced + inline) is verbatim — no inner markdown is parsed. Constructs outside the subset (setext headings, reference links, raw HTML blocks, images, task lists, footnotes, strikethrough) are not supported and degrade to text / paragraph.
15. **Markdown: total + linear-time.** Neither `parse` nor `render` ever throws — malformed markdown degrades to text (an unterminated `**` / `` ` `` / `[` stays literal, a header line with no delimiter is a paragraph, an unclosed fence runs to EOF), never a crash. Inline scanning is index-based with no backtracking, so an adversarial run (e.g. thousands of `*`s) is parsed in linear time — no ReDoS.
16. **Markdown: render is XSS-safe.** `render` HTML-escapes every text run, code body, and attribute value (`&` / `<` / `>` / `"` / `'`), so raw `<script>` from a document is emitted as `&lt;script&gt;`, never live markup. Every link `href` is run through `sanitizeUrl`: a scheme not in `SAFE_URL_SCHEMES` (`http` / `https` / `mailto` / `tel`) — including `javascript:` / `data:` / `vbscript:` and whitespace/control-character evasions of them — is dropped to an empty `href`, while a relative / anchor / scheme-less destination is kept and attribute-escaped. The escaping is unconditional even though guide content is trusted (defence in depth).
17. **Markdown: stateless + reusable.** `MarkdownParser` holds no state — the same instance parses any number of independent documents with identical results, and the helper functions are pure (same input → same output). It is event-free like the streaming parsers but, unlike them, parses a whole document at once (no buffer, no `reset`).
18. **CSV: RFC-4180-style quoting.** `CSVParser.parse(text)` is quote-aware: a `"` opens a quoted run, `""` inside quotes is a literal `"`, and embedded commas AND line breaks inside quotes are content — a multi-line quoted cell reassembles into ONE cell, so one logical row can span several physical lines (this is why the parser reads the whole document, never splitting on lines first).
19. **CSV: row breaks + pinned edges.** Outside quotes `\n`, `\r\n`, and `\r` all end a row (a `\r\n` is consumed as ONE terminator). A trailing final row terminator adds NO extra empty row (`'a,b\n'` parses to one row); an interior empty line is a one-empty-cell row (`['']`); the empty string parses to `[]`.
20. **CSV: total.** `parse` never throws on any input — an unterminated quote runs to the end of the input and adversarial garbage degrades to cells, never a crash.
21. **CSV: serialize is the exact inverse.** `serialize(rows)` quotes exactly the cells containing a `,` / `"` / line break (doubling internal quotes via `escapeCSVCell`), joins cells with `,` (`serializeCSVRow`) and rows with `\n`, and appends no trailing newline — so `parse(serialize(rows))` round-trips, and `serialize(parse(text))` is content-stable for RFC-shaped input.
22. **CSV: stateless + reusable.** `CSVParser` holds no state — the `MarkdownParser` mold: the same instance parses any number of independent documents with identical results, event-free, no buffer, no `reset`.

## Patterns

### Chunked feeding (streaming parsers)

The dominant use for `NDJSONParser` / `SSEParser`: feed chunks exactly as they arrive — never pre-split by line or event — and let the parser handle reassembly. Each `parse` returns the records completed by that chunk.

```ts
import { createNDJSONParser } from '@src/core'

const parser = createNDJSONParser()
for (const chunk of incomingChunks) {
	for (const record of parser.parse(chunk)) {
		handle(record) // every complete line so far, in stream order
	}
}
```

### Driving a fetch byte stream

The headline streaming consumer: read a `fetch` `ReadableStream`, decode the bytes with a `TextDecoder`, and feed the text into `parse`. The pairing is the point — the **decoder** handles partial CHARS (a multi-byte UTF-8 codepoint split across two reads), the **parser** handles partial LINES (a JSON record split across two reads).

```ts
import { createNDJSONParser } from '@src/core'

const response = await fetch(url, { method: 'POST', body, signal })
const reader = response.body?.getReader()
const decoder = new TextDecoder()
const parser = createNDJSONParser()

if (reader) {
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		for (const record of parser.parse(decoder.decode(value, { stream: true }))) {
			emitDelta(record) // map each record to a streamed chunk
		}
	}
}
```

Because the parser is **total**, this loop is abort-safe: cancel the `signal` mid-stream and `parse` simply stops being fed — the partial line in its buffer is dropped, no throw.

### Reading a Server-Sent-Events stream (a browser client)

The same shape with `SSEParser`: a browser reads a `fetch` SSE `ReadableStream`, decodes with a `TextDecoder`, and feeds the text into `parse`. An SSE writer serializes a message as the EXACT inverse of this parser, so what a server writes is exactly what this parser reassembles.

```ts
import { createSSEParser } from '@src/core'

const response = await fetch(url, { signal })
const reader = response.body?.getReader()
const decoder = new TextDecoder()
const parser = createSSEParser()

if (reader) {
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		for (const event of parser.parse(decoder.decode(value, { stream: true }))) {
			handle(event) // { data, event?, id?, retry? } — one per blank line, in stream order
		}
	}
}
```

### Rendering a markdown document to HTML (the docs site)

The headline `MarkdownParser` use, and how the Phase-2 docs site renders a guide: read the markdown, `parse` it to the AST, `render` the AST to HTML. Because render escapes text + sanitizes hrefs, the output is safe to inject even for untrusted markdown.

```ts
import { createMarkdownParser } from '@src/core'

const parser = createMarkdownParser()
const html = parser.render(parser.parse(markdownSource))
element.innerHTML = html // text escaped, every <script> neutralized, unsafe hrefs dropped
```

### A CSV import / export round-trip

The headline `CSVParser` use: import a user's CSV file into decoded rows, and export rows back to a CSV string. Because `serialize` is the exact inverse of `parse`, what goes out re-imports identically — quoted commas, doubled quotes, and multi-line cells survive the round-trip.

```ts
import { createCSVParser } from '@src/core'

const parser = createCSVParser()
const rows = parser.parse(await file.text()) // decoded cells — quotes resolved, multi-line cells intact
const text = parser.serialize(rows) // the exact inverse: parse(serialize(rows)) round-trips
```

### Walking the AST instead of rendering

Because the AST is the contract, a consumer can walk it directly — build a table of contents from the headings, extract every code block's language, collect outbound links — without rendering. Every node is plain readonly data keyed by its `element`.

```ts
import type { BlockNode } from '@src/core'
import { createMarkdownParser } from '@src/core'

const document = createMarkdownParser().parse(markdownSource)
const headings = document.children.filter((block: BlockNode) => block.element === 'heading')
const toc = headings.map((heading) => (heading.element === 'heading' ? heading : undefined))
```

### Practices

- **Feed chunks as received (streaming)** — do not pre-split by line or event; the streaming parser owns all multi-line / multi-event buffering internally.
- **Pair with `TextDecoder({ stream: true })`** — when reading a byte stream, decode with a streaming decoder so a multi-byte character split across reads is not corrupted; then hand the text to `parse`.
- **`reset()` between streams** — the streaming parsers are stateful; reset before reusing a handle for a new stream so a stale partial line / in-progress event cannot bleed in. `MarkdownParser` and `CSVParser` are stateless — there is nothing to reset.
- **Records / events / rows / nodes only** — `parse` returns complete units; malformed and incomplete input is dropped, buffered, or (for markdown / CSV) degraded to text, so a consumer never sees a half-parsed value.
- **Never pre-split a CSV by lines** — a line break inside quotes is cell content, so line-splitting corrupts multi-line cells; hand `CSVParser.parse` the whole document and let it find the row breaks.
- **The AST is the contract; render is separate** — parse once, then walk the AST for structured needs (a TOC, link extraction) or `render` it for HTML; never re-parse the HTML.
- **Render is the trust boundary** — `render` escapes text + sanitizes hrefs, so its output is XSS-safe even for untrusted markdown; never bypass it by hand-assembling HTML from AST text.
- **No events** — all four are functional primitives; do not reach for an Emitter here.

## Tests

- [`tests/guides/src/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔ `src/core/parsers` bijection (value + type exports) and the `NDJSONParserInterface` ↔ `NDJSONParser`, `SSEParserInterface` ↔ `SSEParser`, `MarkdownParserInterface` ↔ `MarkdownParser`, and `CSVParserInterface` ↔ `CSVParser` method bijections.
- [`tests/src/core/parsers/NDJSONParser.test.ts`](../../tests/src/core/parsers/NDJSONParser.test.ts) — a single complete line → one record and multiple complete lines in one chunk → all records in order; the partial-line buffering headline (split across two/three chunks, a complete line plus a trailing partial); a realistic Ollama-style stream reassembled identically across every two-chunk split point; malformed JSON skipped without throwing; non-object values dropped; empty / whitespace lines skipped; a never-terminated line never emitted; CRLF / escaped-newline handling; and `reset()` discarding a buffered partial.
- [`tests/src/core/parsers/SSEParser.test.ts`](../../tests/src/core/parsers/SSEParser.test.ts) — single + multi-line `data:` concatenation; all fields with last-wins + absent-key omission; the colon+space rule and comment / unknown-field skipping; blank-line dispatch with accumulator reset; the empty-data rule; cross-chunk reassembly across every two-chunk split point; CRLF / bare-CR / LF terminators incl. a CRLF split across chunks; BOM stripped on the first chunk only; integer-only `retry`; a NUL-voided `id`; and `reset()` re-arming BOM stripping.
- [`tests/src/core/parsers/MarkdownParser.test.ts`](../../tests/src/core/parsers/MarkdownParser.test.ts) — each construct parses to the right AST node (heading levels 1–6 + the 7-`#` / no-space degradations, paragraphs + a heading-under-paragraph, `*`/`_`/`**`/`__` emphasis with nesting + the unterminated/space-flanked degradations, inline code incl. a double-backtick span, links with inline children + relative/anchor hrefs, bulleted/ordered/nested lists, GFM tables with alignment + cell inline + short-row padding + the no-delimiter degradation, fenced code preserving content + language incl. `~~~`, blockquotes + a nested heading, thematic breaks); a total suite over adversarial / malformed inputs (incl. a 20k-`*` run asserted linear-time, never throwing); the renderer's structure (headings / lists / tables with alignment / `<pre><code class="language-…">` / `<hr>` / `<blockquote>`); the escaping & sanitization (a `<script>` in text escaped, a `javascript:` / `data:` / `vbscript:` / control-char-evasion href dropped to `href=""`, an attribute-quote escaped, safe schemes kept); and stateless-reuse determinism over self-contained markdown fixtures.
- [`tests/src/core/parsers/CSVParser.test.ts`](../../tests/src/core/parsers/CSVParser.test.ts) — rows/columns; quoted cells with embedded commas + `""` escapes + a quoted run opened mid-cell; the multi-line-quoted-cell headline (one logical row across 3 physical lines, a CRLF inside quotes kept verbatim); LF / CRLF / CR row breaks + mixed terminators; the pinned edges (trailing terminator adds no row, interior empty line → `['']`, empty string → `[]`); the total suite (unterminated quote runs to end, adversarial garbage never throws, unicode cells); `serialize` quoting exactly when needed + `"`-doubling + `\n`-join with no trailing newline; both round-trips (`parse(serialize(rows))` exact, `serialize(parse(text))` content-stable); the 18-column template CSV parsing to 2×18; and stateless reuse (no `reset`).
- [`tests/src/core/parsers/helpers.test.ts`](../../tests/src/core/parsers/helpers.test.ts) — the pure block / inline / render helper functions individually: line splitting + normalization, the block detectors (`extractHeading` / `isThematicBreak` / `extractFence` / `isFenceClose` / `extractListItem` / `isQuote` / `isTableStart`), table-row splitting + alignment derivation, the inline sub-scanners (`scanCode` / `scanLink` / `scanEmphasis` / `scanInline`) and their degradations, escape resolution + text coalescing, and the renderer primitives (`escapeHtml` / `sanitizeUrl` incl. the scheme allowlist + control-char stripping + case-insensitivity); plus the CSV leaves — `scanCSVCell` at every terminator kind, quote state, and index offset (incl. the unterminated-quote total case), and the `escapeCSVCell` / `serializeCSVRow` tables.
- [`tests/src/core/parsers/factories.test.ts`](../../tests/src/core/parsers/factories.test.ts) — `createNDJSONParser` / `createSSEParser` / `createMarkdownParser` / `createCSVParser` each return a working interface (the streaming pair parsing complete units, buffering a split unit, clearing on `reset()`, and handing back independent handles; the markdown factory parsing to the AST, rendering safe HTML, parsing inline alone, degrading total, and reusing statelessly; the CSV factory parsing quote-aware rows, round-tripping through `serialize`, and reusing statelessly).

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §10 lifecycle (`reset`), §4.1 single-word members, §4.4 the discriminant-names-its-axis rule (`element`), §14 boundary-narrowing (`isRecord`-gated parsing) + total guards, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the guides index.
