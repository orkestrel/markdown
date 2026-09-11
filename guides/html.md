# HTML

> A types-first HTML toolkit: a hand-written, index-based tokenizer that turns any page or
> fragment into an immutable `HTML` handle over a typed AST, plus the sanitizer, the distiller,
> and the standalone renderers that project that AST back out as canonical HTML or structural
> plain text.

Everything downstream reads the one `HTMLDocument` a parse produces — the queries, the rewrites, the shaping engines, and the renderers alike. `parseDocument` scans a page or a bare fragment — the same shape either way — into an `HTMLDocument`: a discriminated union of plain readonly node values keyed by `category`, the axis that varies. Parsing is total. Every input produces a document, so there are no parse options, no issue list, no strict mode, and no error path; strictness lives in the guards and in the renderer's refusals instead. Nothing is implied or inserted that the source did not write — no synthesized `html` / `head` / `body`, and a `<!DOCTYPE html>` is an ordinary child in source order — which is exactly why a fragment and a whole page need no mode switch between them. An `HTML` handle wraps that AST with query (`walk` / `find` / `filter` / `reduce`), rewrite (`map`), fold, and shallow streaming, and with the document-shaping engines: `sanitize`, which enforces a security floor no option can lower, and `distill`, which extracts the prose a reader — or a language model — actually wants, and hands it back as a handle rather than a string, because the AST is what carries the structure. The renderers (`renderHTML`, `renderText`) are separate, downstream, standalone functions from AST → string; none of them assumes its input came from `parseDocument` on trusted markup, none of them throws, and every one of them degrades at a fixed depth cap rather than exhausting the call stack. The AST itself is the primary contract, with a from-unknown validation surface (`isHTMLNode` / `isHTMLDocument` / `isElementNode` / …) for the moment an AST arrives from somewhere other than this parser. The source is [`src/core`](../src/core), published through `@orkestrel/html` and surfaced in-repo through the `@src/core` barrel, and `@orkestrel/contract` is the one runtime dependency behind the guards, the shapes, and the containment (§ [Relationship with `@orkestrel/contract`](#relationship-with-orkestrelcontract)).

That totality statement governs document parsing. `parseStartTag` is the separate fail-closed source boundary: it returns one unambiguous start tag within the package's deliberately narrow ASCII tag-name grammar and its exact end offset, or `undefined`, without adding a strict mode to `parseDocument` or changing `scanTag` recovery.

## Surface

### Types

The full node shape and handle contract, from [`types.ts`](../src/core/types.ts). `category` is the discriminant every node carries; absence is always `undefined`, never a sentinel. A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. A member's type never appears in a cell, because the declaration carries it and the row's name reaches it. A generic declaration carries its parameter binding beside its literal, so a `TNode` or a `T` in a cell is that declaration's own parameter. The node categories are worked through in § [The AST model](#the-ast-model), and the option interfaces in § [The sanitize floor](#the-sanitize-floor) and § [The distill pass](#the-distill-pass).

| Name                  | Kind      | Shape                                                                                                  | Summary                                                                                                                                                                                                                     |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTMLAttribute`       | interface | `{ name, value? }`                                                                                     | Represents one attribute of an `ElementNode` - its `name` and, when the source wrote one, its `value`.                                                                                                                      |
| `HTMLStartTag`        | interface | `{ name, attributes, slashed, next }`                                                                  | Represents one unambiguous start tag parsed directly from source without recovery.                                                                                                                                          |
| `HTMLTag`             | interface | `{ name, attributes, closing, next }`                                                                  | Represents one start or close tag returned by the total, recovering `scanTag` scanner.                                                                                                                                      |
| `ElementNode`         | interface | `{ category, name, attributes, children }`                                                             | Represents an element - `<p>`, `<table>`, `<my-widget>`, or any other tag, known or custom.                                                                                                                                 |
| `TextNode`            | interface | `{ category, value }`                                                                                  | Represents a run of character data - the leaf node, whose `value` is already-decoded text.                                                                                                                                  |
| `CommentNode`         | interface | `{ category, value }`                                                                                  | Represents a comment - `<!-- … -->` - whose `value` is verbatim inner text, never decoded and never parsed as markup.                                                                                                       |
| `DoctypeNode`         | interface | `{ category, name, public?, system? }`                                                                 | Represents a document type declaration - `<!DOCTYPE html>` and its legacy public/system forms.                                                                                                                              |
| `HTMLDocument`        | interface | `{ category, children }`                                                                               | Represents the root of a parsed AST - the ordered children of the whole input, whether that input was a full page or one fragment. The value `HTMLInterface.document` holds.                                                |
| `HTMLNode`            | type      | `HTMLDocument \| ElementNode \| TextNode \| CommentNode \| DoctypeNode`                                | Represents any node in an HTML AST - the `HTMLDocument` root or one of its descendants. The exhaustive set every guard, traversal, fold table, and renderer covers, discriminated by `category`.                            |
| `HTMLSpan`            | interface | `{ start, end }`                                                                                       | Represents a half-open region of the original HTML input, measured in UTF-16 code units.                                                                                                                                    |
| `HTMLSource`          | type      | `readonly [source: string, offsets: readonly number[]]`                                                | Carries a normalized HTML source beside the boundary map back to its original input.                                                                                                                                        |
| `HTMLOpenPosition`    | interface | `{ overflow, position }`                                                                               | Describes one open element occurrence located across the parser's represented and depth-overflow stacks.                                                                                                                    |
| `HTMLScan`            | interface | `HTMLScan<TNode extends HTMLNode>` = `{ node, next }`                                                  | Describes the node and close boundary returned by a scanner that produces one leaf node.                                                                                                                                    |
| `HTMLParseResult`     | type      | `readonly [document: HTMLDocument, spans: ReadonlyMap<HTMLNode, HTMLSpan>]`                            | Carries the parsed document and its original-input node regions.                                                                                                                                                            |
| `HTMLDerivation`      | type      | `HTMLDerivation<T>` = `readonly [value: T, derivations: ReadonlyMap<HTMLNode, HTMLNode \| undefined>]` | Carries a derived value and the source of each rebuilt node.                                                                                                                                                                |
| `HTMLRawText`         | interface | `{ node, span, next, closed }`                                                                         | Describes the text, source region, and close boundary returned by a raw-text scan.                                                                                                                                          |
| `HTMLHandler`         | type      | `HTMLHandler<TNode, T>` = `(node: TNode, children: readonly T[]) => T`                                 | Represents a fold handler for one node category - receives the node and its children already folded to `T`, and produces the node's own `T`. The building block of an `HTMLHandlerMap` table.                               |
| `HTMLHandlerMap`      | interface | `HTMLHandlerMap<T>` = `{ document, element, text, comment, doctype }`                                  | Represents the total fold table for `HTMLInterface.fold` - one `HTMLHandler` per node category, keyed by that category. Every key is required, because a fold is total over the AST: there is no node it may skip.          |
| `HTMLRewriteHandler`  | type      | `(node: HTMLNode) => HTMLNode`                                                                         | Represents a copy-on-write node rewrite applied bottom-up by `HTMLInterface.map` - receives one node whose children have already been rewritten and returns its replacement: the same node unchanged, or a new one.         |
| `HTMLPruneHandler`    | type      | `(node: HTMLNode) => readonly HTMLNode[]`                                                              | Represents a bottom-up pruning handler applied by `pruneDocument` - receives one node whose children have already been pruned and returns the nodes that replace it.                                                        |
| `HTMLSanitizeOptions` | interface | `{ elements?, attributes?, schemes?, comments? }`                                                      | Describes the options for `HTMLInterface.sanitize`. Each allowlist key replaces its default rather than extending it, so a caller who passes one narrows or redirects that one axis and leaves the others alone.            |
| `HTMLDistillOptions`  | interface | `{ base?, elements?, boilerplate? }`                                                                   | Describes the options for `HTMLInterface.distill` - the content-extraction pass that reduces a page to the prose a reader (or a language model) actually wants.                                                             |
| `HTMLInterface`       | interface | `{ document } plus span, walk, find, filter, map, reduce, fold, stream, sanitize, distill`             | Represents a parsed HTML document: the typed `HTMLDocument` AST plus the query (`walk` / `find` / `filter` / `reduce`), rewrite (`map`), fold, streaming, and document-shaping (`sanitize` / `distill`) operations over it. |

### Constants

The element vocabularies, allowlists, entity table, and depth bound every engine reads, from [`constants.ts`](../src/core/constants.ts). Every collection is a frozen array, or — for the keyed tables — a frozen record read through `Object.hasOwn`, so nothing a consumer can reach changes what an engine sees (§ [The sanitize floor](#the-sanitize-floor)). A `Shape` cell holds the constant's declared type. The depth bound's degrade behavior is § [Depth degrade semantics](#depth-degrade-semantics).

| Name                   | Kind  | Shape                                         | Summary                                                                                                                                                                                                                              |
| ---------------------- | ----- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HTML_WHITESPACE`      | const | `string`                                      | Lists the code points HTML treats as syntax whitespace, `' \t\n\f\r'`.                                                                                                                                                               |
| `VOID_ELEMENTS`        | const | `readonly string[]`                           | Lists the elements that cannot have children - a start tag is the whole element, and a close tag for one is discarded.                                                                                                               |
| `RAW_ELEMENTS`         | const | `readonly string[]`                           | Lists the elements whose content is raw text - everything up to the case-insensitive matching close tag becomes one verbatim text node, with no tag scanning and no character-reference decoding inside.                             |
| `LITERAL_ELEMENTS`     | const | `readonly string[]`                           | Lists the elements whose content is literal text - one text node up to the matching close tag, with character references decoded but no markup parsed.                                                                               |
| `BLOCK_ELEMENTS`       | const | `readonly string[]`                           | Lists the elements that carry document structure rather than inline content.                                                                                                                                                         |
| `IMPLIED_CLOSERS`      | const | `Readonly<Record<string, readonly string[]>>` | Holds the implied end-tag table - for each element that can be left open, the start tags whose arrival closes it.                                                                                                                    |
| `IMPLIED_BARRIERS`     | const | `Readonly<Record<string, readonly string[]>>` | Bounds each implied-close search at containers that protect matching ancestors.                                                                                                                                                      |
| `SAFE_ELEMENTS`        | const | `readonly string[]`                           | Lists the default element allowlist for `sanitize` - the document vocabulary that survives unchanged.                                                                                                                                |
| `SAFE_ATTRIBUTES`      | const | `readonly string[]`                           | Lists the default attribute allowlist for `sanitize` - the attributes that describe content rather than fetch, script, or style it.                                                                                                  |
| `TABLE_ALIGNMENTS`     | const | `readonly string[]`                           | Lists the closed values a sanitized table-cell `align` attribute may carry.                                                                                                                                                          |
| `TABLE_CELL_ELEMENTS`  | const | `readonly string[]`                           | Lists the elements on which a sanitized `align` attribute is honored, whatever a caller's attribute allowlist names.                                                                                                                 |
| `SAFE_URL_SCHEMES`     | const | `readonly string[]`                           | Lists the URL schemes a sanitized document may name.                                                                                                                                                                                 |
| `URL_ATTRIBUTES`       | const | `readonly string[]`                           | Lists the attributes whose value is a URL - the values `sanitize` decodes, strips of ASCII whitespace and control characters, and scheme-checks before keeping, and the values `distill` resolves against `HTMLDistillOptions.base`. |
| `UNSAFE_ELEMENTS`      | const | `readonly string[]`                           | Names the hard floor of `sanitize` - elements whose entire subtree is removed, never unwrapped, no matter what `HTMLSanitizeOptions` allows.                                                                                         |
| `CONTENT_ELEMENTS`     | const | `readonly string[]`                           | Lists the default element set `distill` keeps as content - prose, headings, lists, tables, code, and the inline marks that carry meaning.                                                                                            |
| `BOILERPLATE_ELEMENTS` | const | `readonly string[]`                           | Lists the default regions `distill` removes whole - the navigation, banner, and margin furniture that surrounds an article rather than belonging to it.                                                                              |
| `REGION_ELEMENTS`      | const | `readonly string[]`                           | Lists the content regions `distill` tries in priority order when re-rooting a document. A region qualifies only when it occurs exactly once.                                                                                         |
| `NAMED_ENTITIES`       | const | `Readonly<Record<string, string>>`            | Holds the semicolon-terminated named character references from the WHATWG HTML set, keyed by name without the leading `&` or trailing `;`.                                                                                           |
| `MAX_DEPTH`            | const | `number`                                      | Names the recursion depth the parser, the guards, the traversals, the renderers, and the sanitize and distill engines honor before they stop descending, `64`.                                                                       |

### Validators

The from-unknown guards, from [`validators.ts`](../src/core/validators.ts). A guard validates an entire untrusted value from scratch — a deserialized AST, a value crossing a process boundary — and is total: a cycle, a hostile prototype, a revoked proxy, or 10,000 levels of nesting returns `false` rather than throwing. The name, element, and URL predicates the engines consult narrow nothing, so they are not guards: they sit with the other pure leaves in [`helpers.ts`](../src/core/helpers.ts) (§ [Helpers](#helpers)).

In a guard table a `Shape` cell holds the type the guard narrows to.

| Name              | Kind     | Shape           | Summary                                                                                                                                                                                                       |
| ----------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isHTMLAttribute` | const    | `HTMLAttribute` | Determines whether an arbitrary value is a structurally valid HTML attribute - exactly a string name, optionally a string value, and nothing else.                                                            |
| `isHTMLCodePoint` | function | `number`        | Determines whether a code point may appear in an unambiguous HTML source token.                                                                                                                               |
| `isTextNode`      | const    | `TextNode`      | Determines whether an arbitrary value is a structurally valid text node - a closed `{ category: 'text', value: string }` record.                                                                              |
| `isCommentNode`   | const    | `CommentNode`   | Determines whether an arbitrary value is a structurally valid comment node - a closed `{ category: 'comment', value: string }` record.                                                                        |
| `isDoctypeNode`   | const    | `DoctypeNode`   | Determines whether an arbitrary value is a structurally valid doctype node - a declared name plus optional public and system identifiers, closed.                                                             |
| `isHTMLNode`      | function | `HTMLNode`      | Determines whether an arbitrary value is a valid HTML node - the value and every descendant, walked iteratively, cycle-checked, capped at `MAX_DEPTH`, and held to the void-element empty-children invariant. |
| `isHTMLDocument`  | function | `HTMLDocument`  | Determines whether an arbitrary value is a valid HTML document - the whole-node check narrowed to the root category, and the gate to run before adopting an untrusted document.                               |
| `isElementNode`   | function | `ElementNode`   | Determines whether an arbitrary value is a valid element node - the whole-node check narrowed to an element, and the natural predicate to pass to `find` or `filter`.                                         |

### Parsers

The document coercers, from [`parsers.ts`](../src/core/parsers.ts). `parseProvenance` owns the single walk that turns source into an AST and its regions; `parseDocument` projects the bare document for callers that need no provenance. Every lexical piece the walk composes is a pure leaf in [`helpers.ts`](../src/core/helpers.ts) (§ [Helpers](#helpers)), exported and independently testable, because a scanner nobody can call is a scanner nobody can prove. All of them are index-based, with no backtracking regex over untrusted input. Recovery from malformed markup follows the table in § [The parse pipeline](#the-parse-pipeline).

| Name              | Kind     | Signature                           | Summary                                                                                                         |
| ----------------- | -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `parseDocument`   | function | `(html: string) => HTMLDocument`    | Parses an HTML string into a total, depth-bounded document AST - a page and a bare fragment are the same shape. |
| `parseProvenance` | function | `(html: string) => HTMLParseResult` | Parses an HTML string with original-input node regions.                                                         |

### Helpers

Pure leaves from [`helpers.ts`](../src/core/helpers.ts) — the lexical scanners the document walk composes, the name, element, and URL predicates every engine consults, and the functional core `HTML`'s engines compose and callers reach for directly on a bare node. Every one of them is independently testable, and a hostile value degrades to `''`, to an empty list, or to the input unchanged, contained by `attempt` from `@orkestrel/contract` rather than by a second boundary of this package's own (§ [Relationship with `@orkestrel/contract`](#relationship-with-orkestrelcontract)). `foldNode` is the exception: it runs the handler table you supply and lets a handler's error propagate, exactly as `fold` does (§ [The sanitize floor](#the-sanitize-floor)). The canonical form the renderers write and the constructs they refuse are § [Roundtrip laws](#roundtrip-laws), and what the text projection drops is § [Text is the lossy projection](#text-is-the-lossy-projection).

| Name                 | Kind     | Signature                                                                                                                                                  | Summary                                                                                                                                                                  |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `normalizeSource`    | function | `(html: string) => HTMLSource`                                                                                                                             | Normalizes an HTML input - CRLF and a lone carriage return to one newline, `U+0000` to `U+FFFD` - and maps each normalized boundary to its original UTF-16 offset.       |
| `projectSpan`        | function | `(offsets: readonly number[], start: number, end: number) => HTMLSpan \| undefined`                                                                        | Projects a normalized half-open region through an original-input boundary map.                                                                                           |
| `findOpenPosition`   | function | `(represented: ReadonlyMap<string, readonly number[]>, overflow: ReadonlyMap<string, readonly number[]>, name: string) => HTMLOpenPosition \| undefined`   | Finds the deepest open occurrence of an element name across the parser's represented and depth-overflow stacks.                                                          |
| `projectDepth`       | function | `(overflow: boolean, position: number, height: number) => number`                                                                                          | Projects one stack position onto the single depth scale the represented and depth-overflow stacks compare on, so an overflow position ranks below every represented one. |
| `lowercaseASCII`     | function | `(value: string) => string`                                                                                                                                | Lowercases only ASCII uppercase characters, preserving every other code point exactly.                                                                                   |
| `isVoidElement`      | function | `(name: string) => boolean`                                                                                                                                | Determines whether an element name is void, matching `VOID_ELEMENTS` without case sensitivity.                                                                           |
| `isRawElement`       | function | `(name: string) => boolean`                                                                                                                                | Determines whether an element name contains verbatim raw text - `script` or `style`, the parser's no-scanning boundary and the renderer's refusal boundary.              |
| `isLiteralElement`   | function | `(name: string) => boolean`                                                                                                                                | Determines whether an element name contains decoded literal text - `title` or `textarea`, whose body is one text node with character references resolved.                |
| `isBlockElement`     | function | `(name: string) => boolean`                                                                                                                                | Determines whether an element name is a block boundary, matching `BLOCK_ELEMENTS`.                                                                                       |
| `isEmptyElement`     | function | `(element: ElementNode) => boolean`                                                                                                                        | Checks whether an element has no child nodes - the predicate the distill pass consults before dropping an empty non-void element.                                        |
| `decodeEntities`     | function | `(value: string) => string`                                                                                                                                | Decodes numeric and semicolon-terminated WHATWG named character references in a string.                                                                                  |
| `scanAttributes`     | function | `(source: string) => readonly HTMLAttribute[]`                                                                                                             | Scans an attribute source segment into ordered, ASCII-lowercased, first-wins attributes with decoded values.                                                             |
| `parseStartTag`      | function | `(html: string, offset: number) => HTMLStartTag \| undefined`                                                                                              | Parses one unambiguous start tag without recovery under the package's ASCII tag-name grammar.                                                                            |
| `scanTag`            | function | `(html: string, offset: number) => HTMLTag \| undefined`                                                                                                   | Scans one complete start or close tag.                                                                                                                                   |
| `scanComment`        | function | `(html: string, offset: number) => HTMLScan<CommentNode> \| undefined`                                                                                     | Scans a standard or bogus HTML comment.                                                                                                                                  |
| `scanDoctype`        | function | `(html: string, offset: number) => HTMLScan<DoctypeNode> \| undefined`                                                                                     | Scans an HTML doctype with optional public and system identifiers.                                                                                                       |
| `scanRawText`        | function | `(html: string, offset: number, name: string, entities?: boolean) => HTMLRawText`                                                                          | Scans text through the case-insensitive matching close tag of a raw or literal element.                                                                                  |
| `encodeText`         | function | `(value: string) => string`                                                                                                                                | Encodes the characters that have markup meaning in HTML text - `&`, `<`, and `>`, and nothing else.                                                                      |
| `encodeAttribute`    | function | `(value: string) => string`                                                                                                                                | Encodes the characters that have markup meaning in a double-quoted HTML attribute - `&` and `"`, and nothing else.                                                       |
| `sanitizeURL`        | function | `(value: string, schemes: ReadonlySet<string> \| readonly string[]) => string`                                                                             | Decodes and inspects a URL against an explicit scheme allowlist and a fixed dangerous floor.                                                                             |
| `isSafeURL`          | function | `(value: string, schemes?: ReadonlySet<string> \| readonly string[]) => boolean`                                                                           | Determines whether a URL is relative or uses an allowed non-dangerous scheme.                                                                                            |
| `resolveURL`         | function | `(value: string, base: string) => string`                                                                                                                  | Resolves a URL through the platform WHATWG URL implementation.                                                                                                           |
| `attributeOf`        | function | `(node: ElementNode, name: string) => string \| undefined`                                                                                                 | Finds an element attribute without case sensitivity.                                                                                                                     |
| `sanitizeAttributes` | function | `(node: ElementNode, attributes: ReadonlySet<string> \| readonly string[], schemes: ReadonlySet<string> \| readonly string[]) => readonly HTMLAttribute[]` | Filters an element's attributes down to the ones a sanitized document may carry.                                                                                         |
| `resolveAttributes`  | function | `(node: ElementNode, base: string) => readonly HTMLAttribute[]`                                                                                            | Resolves an element's URL attributes against a base URL.                                                                                                                 |
| `collapseSpace`      | function | `(value: string) => string`                                                                                                                                | Collapses a run of whitespace to one inter-word space and removes edge whitespace.                                                                                       |
| `renderHTML`         | function | `(node: HTMLNode) => string`                                                                                                                               | Serializes an HTML node to canonical, safety-bounded HTML.                                                                                                               |
| `renderText`         | function | `(node: HTMLNode) => string`                                                                                                                               | Projects an HTML node to structural plain text.                                                                                                                          |
| `walkNodes`          | function | `(node: HTMLNode) => Generator<HTMLNode>`                                                                                                                  | Walks an HTML node depth-first in pre-order, lazily and depth-bounded, including the supplied root.                                                                      |
| `foldNode`           | function | `<T>(node: HTMLNode, handlers: HTMLHandlerMap<T>) => T`                                                                                                    | Folds an HTML node bottom-up through a total handler table - each node's children fold first, then its own handler runs with those already-folded results.               |
| `rewriteDocument`    | function | `(document: HTMLDocument, rewrite: HTMLRewriteHandler) => HTMLDerivation<HTMLDocument>`                                                                    | Rewrites a document bottom-up with copy-on-write identity preservation.                                                                                                  |
| `mergeText`          | function | `(children: readonly HTMLNode[]) => readonly HTMLNode[]`                                                                                                   | Restores the no-adjacent-text invariant in a rebuilt list of siblings.                                                                                                   |
| `collapseText`       | function | `(children: readonly HTMLNode[]) => HTMLDerivation<readonly HTMLNode[]>`                                                                                   | Collapses the whitespace runs inside each direct text child of a sibling list.                                                                                           |
| `extractRegion`      | function | `(document: HTMLDocument, names: readonly string[]) => HTMLDerivation<HTMLDocument>`                                                                       | Re-roots a document at the sole occurrence of one of the named region elements.                                                                                          |
| `pruneDocument`      | function | `(document: HTMLDocument, prune: HTMLPruneHandler) => HTMLDerivation<HTMLDocument>`                                                                        | Rebuilds a document bottom-up, letting each node become any number of nodes - the one-to-many spine the sanitize and distill engines share.                              |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`) in [`shapers.ts`](../src/core/shapers.ts) — `createContract` compiles one shape into a JSON Schema, a guard, a coercing parser, and a seeded generator that can never drift apart. A shape tree has no lazy or self-referential node, so only the leaves of this AST shape here; `ElementNode` and `HTMLDocument` recurse into `HTMLNode` and therefore stay hand-written, cycle- and depth-capped guards in `validators.ts`.

A `Shape` cell holds the constant's declared type.

| Name             | Kind  | Shape                                               | Summary                                                                                                                                                                                                                  |
| ---------------- | ----- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attributeShape` | const | `ObjectShape<{ name, value? }>`                     | Describes the shape of an `HTMLAttribute` - an element attribute's name and, when the source wrote one, its value. `value` is optional: its absence is what distinguishes `<input disabled>` from `<input disabled="">`. |
| `textShape`      | const | `ObjectShape<{ category, value }>`                  | Describes the shape of a `TextNode` - the decoded character-data leaf.                                                                                                                                                   |
| `commentShape`   | const | `ObjectShape<{ category, value }>`                  | Describes the shape of a `CommentNode` - the verbatim, never-decoded comment leaf a bogus comment also recovers to.                                                                                                      |
| `doctypeShape`   | const | `ObjectShape<{ category, name, public?, system? }>` | Describes the shape of a `DoctypeNode` - the declared root name plus the optional public and system identifiers of a legacy declaration.                                                                                 |

### Factories

From [`factories.ts`](../src/core/factories.ts).

| Name         | Kind     | Signature                                          | Summary                                                                                                                                                                                  |
| ------------ | -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createHTML` | function | `(input: string \| HTMLDocument) => HTMLInterface` | Creates an HTML handle from an HTML string or an already-parsed `HTMLDocument` - the typed AST plus the query, rewrite, fold, streaming, and shaping operations `HTMLInterface` exposes. |

### Classes

The implementing class, from [`HTML.ts`](../src/core/HTML.ts) — documented in full under its own
heading following this table.

| Name   | Kind  | Summary                                                                                                                                                                                                                                  |
| ------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTML` | class | Represents a parsed document - the typed `HTMLDocument` AST plus the query (`walk` / `find` / `filter` / `reduce`), rewrite (`map`), fold, streaming, and document-shaping (`sanitize` / `distill`) operations `HTMLInterface` declares. |

### `HTML`

The implementing class of `HTMLInterface`, from [`HTML.ts`](../src/core/HTML.ts). A parsed document handle: constructed from an HTML `string` (runs `parseProvenance`, which is total, so there is nothing to catch) or from an already-parsed `HTMLDocument` (adopted as-is and not re-validated — gate an untrusted value with `isHTMLDocument` first). It exposes its AST through the `readonly document` member, documented here in Surface prose rather than in the [`## Methods`](#methods) table that follows, which lists exactly `HTMLInterface`'s call-signature members. Immutable: nothing mutates the stored AST, and `map`, `sanitize`, and `distill` each return a new handle whose root invariant (`category: 'document'`) always holds. `walk` is the deep traversal — lazy, depth-first, pre-order, root-inclusive — and `find` / `filter` / `reduce` all iterate it, so one ordering law covers the whole query surface; `stream` is the deliberate contrast, shallow and backpressured. The sanitize and distill engines are private methods composing the pure leaves in `helpers.ts` over one shared bottom-up spine, `pruneDocument`.

## Methods

The public methods of each behavioral interface — one table per type, keyed by its backticked name. The `readonly document` member is Surface-documented earlier, not listed here. The shaping methods are worked through in § [The sanitize floor](#the-sanitize-floor) and § [The distill pass](#the-distill-pass).

#### `HTMLInterface`

| Method     | Returns                               | Summary                                                                                                                                                                                                                                |
| ---------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `span`     | `HTMLSpan \| undefined`               | Returns the original-input region that produced a node in this handle's tree.                                                                                                                                                          |
| `walk`     | `Generator<HTMLNode>`                 | Provides the deep traversal - a lazy, depth-first, pre-order, root-inclusive `Generator` over every `HTMLNode` in the document.                                                                                                        |
| `find`     | `T \| HTMLNode \| undefined`          | Finds the first node (depth-first, pre-order) narrowed by a type guard.                                                                                                                                                                |
| `filter`   | `readonly T[] \| readonly HTMLNode[]` | Collects every node (depth-first, pre-order) narrowed by a type guard.                                                                                                                                                                 |
| `map`      | `HTMLInterface`                       | Rewrites the AST bottom-up (copy-on-write) and returns a new `HTMLInterface`. A rewrite that returns its node unchanged shares that subtree instead of copying it.                                                                     |
| `reduce`   | `T`                                   | Reduces the AST depth-first, pre-order into one accumulated value.                                                                                                                                                                     |
| `fold`     | `T`                                   | Runs a total catamorphism over the document using an `HTMLHandlerMap` table - one handler per category and no node skipped, so a structure-aware projection needs no traversal of its own.                                             |
| `stream`   | `ReadableStream<HTMLNode>`            | Returns a web-standard `ReadableStream` over the root's direct children (shallow, source order) - a lazy, pull-based, backpressure-respecting source. A fresh, independently replayable stream every call; never mutates the document. |
| `sanitize` | `HTMLInterface`                       | Removes every unsafe element, attribute, and URL and returns a new `HTMLInterface`. The floor documented on `HTMLSanitizeOptions` holds whatever the options say.                                                                      |
| `distill`  | `HTMLInterface`                       | Extracts the page's content - pruning boilerplate regions and hidden chrome, then sanitizing with the defaults, then re-rooting and reducing to the content vocabulary per `HTMLDistillOptions` - and returns a new `HTMLInterface`.   |

## The AST model

Every node is plain, readonly data with no behavior — a discriminated union keyed by `category`, the axis that varies, never `kind` or `type`. The categories, one root, no second family:

- **`document`** is the root and the only container the parser ever creates for the whole input. There is exactly one, and `HTMLInterface` types it that way: a page and a fragment are the same shape, because nothing is implied or inserted.
- **`element`** carries a lowercased `name`, `attributes` in source order, and `children`. Voidness, raw-textness, and block-ness are all derived from the name against `VOID_ELEMENTS` / `RAW_ELEMENTS` / `BLOCK_ELEMENTS` — there is no `void` or `selfClosing` flag on a node to disagree with its own tag.
- **`text`** carries decoded character data. The parser resolves references on the way in; the renderers re-encode minimally on the way out.
- **`comment`** carries verbatim, never-decoded inner text. A bogus comment (`<?…>`, a non-doctype `<!…>`, a CDATA section) recovers to this same node, which is why the AST needs no processing-instruction or CDATA category. The tokenizer builds only values it can write back: a produced `value` never begins with `>` or `->` and never contains `-->` or `--!>`, because an abrupt `<!-->` / `<!--->` closes as an empty comment and an incorrect `--!>` close ends the comment exactly where a `-->` would, leaving what follows as ordinary text. The invariant lives in the tokenizer rather than the renderer because a comment decodes nothing — escaping inside one would change its text, not protect it — so a hand-built value that breaks it is dropped at render time instead (§ [Roundtrip laws](#roundtrip-laws)).
- **`doctype`** carries the declared root `name` plus the optional `public` / `system` identifiers of a legacy declaration. It is an ordinary child in source order and it survives sanitizing: it carries structure, not risk.

Attribute absence is a real distinction, not a sentinel: `value` is `undefined` for a valueless attribute (`<input disabled>`) and `''` for an explicitly empty one (`<input disabled="">`). There is no separate "minimized" flag, so a malformed or unterminated attribute recovers to an absent value rather than to invented text. A duplicate attribute name keeps its first occurrence, matched case-insensitively.

The parser also holds one invariant the whole system leans on: **no two adjacent `TextNode` siblings**. A final coalescing pass joins them, which is what makes an AST comparable to its own reparse — and why every pass that unwraps an element (the sanitize and distill engines do) rejoins the text it splices together through `mergeText`.

Provenance stays beside the tree on its `HTML` handle; nodes gain no field. `span(node)` returns a half-open region in UTF-16 code units of the original constructor string. The coordinates precede the parser's rewrite of CRLF to one newline, a bare carriage return to one newline, and `U+0000` to `U+FFFD`. A parsed node covers the region its scanner consumed. An element runs from its start tag through its explicit close, or through the boundary that implicitly closed it; an element still open at end of input ends there. A one-source rebuild keeps that source region through `map`, `sanitize`, and `distill`. A join or a node with no single source has no provenance, and an adopted `HTMLDocument` starts with none.

## The parse pipeline

`parseProvenance(html)` normalizes line endings and `U+0000`, then walks the source once with an explicit open-element stack — no tree-construction insertion modes, no adoption agency, no foster parenting. Text runs to the next `<`; a `<` that cannot start markup is literal text; a start tag pushes, a close tag pops the nearest match, and `IMPLIED_CLOSERS` closes what the author left open. The implied-close search crosses intervening elements and rules every candidate by its own `IMPLIED_BARRIERS` row: a candidate a barrier protects is skipped rather than ending the search, so the shallowest unblocked candidate still closes. Raw- and literal-text elements swallow their body to the matching close tag. Past `MAX_DEPTH` the parser stops nesting and appends to the deepest allowed element, so parsing stays total and no text is lost. `parseDocument(html)` returns the document from that same walk.

`parseStartTag(html, offset)` is deliberately outside that recovery pipeline for a caller that must know where one start tag really ends. It consumes only HTML ASCII whitespace, retains the package's `[A-Za-z][A-Za-z0-9:-]*` tag-name grammar, ASCII-lowercases names without Unicode case folding, refuses duplicate names and malformed or incomplete attribute syntax, does not normalize the source, and returns the exact exclusive UTF-16 `next` offset after the matching `>` — including when a quoted value contains an earlier `>`. Its `slashed` fact reports only a trailing solidus that was not absorbed into an attribute value: `<html disabled/>` and `<html lang=en />` set it, while the slash in `<html lang=en/>` remains part of the unquoted value. Element semantics remain the caller's concern. It owns no element-name, attribute-allowlist, CSP, or application policy. `scanTag` composes the same successful path, then retains its established recovery path for the document walk.

Recovery is specified behavior, not accident. Every row here has a test in [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts):

| Input                                                                                                                    | Behavior                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Void element start tag                                                                                                   | Element with empty children; a stray close tag for it is discarded                                                                |
| `script` / `style`                                                                                                       | One verbatim text child up to the case-insensitive close tag; no tag scan inside                                                  |
| `title` / `textarea`                                                                                                     | One text child up to the close tag, character references decoded                                                                  |
| New `li` / `dt` / `dd` / `option` / `optgroup` / `rt` / `rp`, a block start while `p` is open, a table row/cell sequence | Implied close per `IMPLIED_CLOSERS`, bounded by `IMPLIED_BARRIERS`                                                                |
| Mis-nested close tag                                                                                                     | Closes the nearest matching open element, implicitly closing everything it spanned                                                |
| Stray close tag with no match                                                                                            | Discarded                                                                                                                         |
| Unknown or custom element                                                                                                | An ordinary element with children                                                                                                 |
| Duplicate attribute                                                                                                      | Lowercased; the first occurrence wins                                                                                             |
| Malformed attribute or unterminated quote                                                                                | Tokenizer recovery at the next `>`; never consumes the rest of the document as trusted markup, and a minimized value stays ABSENT |
| `<` not followed by a letter, `/`, `!`, or `?`                                                                           | Literal text                                                                                                                      |
| `<?…>`, a non-doctype `<!…>`, `<![CDATA[…]]>`                                                                            | A `CommentNode` (the bogus-comment recovery)                                                                                      |
| Unterminated comment                                                                                                     | A comment running to the end of input                                                                                             |
| Abrupt `<!-->` / `<!--->`, or an incorrect `--!>` close                                                                  | An EMPTY comment for the abrupt forms and a normal close for `--!>`; whatever follows stays ordinary text                         |
| Incomplete tag at EOF                                                                                                    | Dropped, without losing the text before it                                                                                        |
| Depth beyond `MAX_DEPTH`                                                                                                 | Content appends to the deepest allowed element; total, with no text loss                                                          |
| `\r\n` / lone `\r`, `U+0000`                                                                                             | Normalized to `\n`; replaced with `U+FFFD`                                                                                        |

For example, `<p><b>x<div>y` closes `b` and `p` at the `div` start. In `<p><button>x<div>y`, the `button` barrier keeps `p` open and the `div` stays inside `button`.

**Entities.** Numeric references decode fully (an invalid scalar becomes `U+FFFD`); named references decode against `NAMED_ENTITIES`, and an unknown name stays literal rather than becoming an invented character.

**Not goals, stated plainly.** This is a pragmatic, total, bounded parser, not a conformant HTML5 tree constructor. It does not implement HTML5 insertion modes, the adoption agency algorithm, or foster parenting; it has no SVG/MathML namespace handling (foreign content is removed whole by `sanitize` instead); named references require their semicolon rather than applying the browser tokenizer's legacy no-semicolon longest-match behavior; the total document parser reports no diagnostics or issues; it ships no CSS selector engine and no streaming tokenizer; and `distill`'s hidden-content rule reads the `hidden` / `aria-hidden` attributes, never computed style. Each of those is a deliberate exclusion with a cheaper, testable substitute, not an unfinished edge.

### Depth degrade semantics

`MAX_DEPTH` (`64`) bounds every recursion in the package, and each one degrades to a fixed, cheap fallback instead of descending further:

- **Parsing** — past the cap, a start tag opens no new element: its content appends to the deepest allowed element, and a later matching close tag is accounted for without unbalancing the stack. No text is lost.
- **Guards** — `isHTMLNode` (and `isHTMLDocument` / `isElementNode` through it) tracks ancestors and refuses past the cap, so a cycle or an adversarially deep value returns `false` instead of exhausting the stack.
- **`walkNodes`** — the node at the cap is still yielded; its children are not visited.
- **`foldNode`** — the node at the cap is folded with an empty child list.
- **`renderHTML` / `renderText`** — descent stops at the cap; deeper content is not serialized.
- **`rewriteDocument`** — the subtree at the cap passes through unchanged, by reference.
- **`pruneDocument`** — the node at the cap is handed no children, so a keep-list policy can never retain content it was unable to inspect. Safety over fidelity, deliberately the opposite trade from `rewriteDocument`'s pass-through.

Every traversal and renderer is also iterative rather than recursive, so the cap bounds output size and work, not stack survival.

## Roundtrip laws

What roundtrips is the AST, not the input bytes. The roundtrip laws hold on parser-produced roots; the AST fixpoint and canonical idempotence laws are substantiated over a representative parser-produced corpus rather than by a universal proof, in [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) and [`tests/src/core/HTML.test.ts`](../tests/src/core/HTML.test.ts):

1. **AST fixpoint.** For a parser-produced document `d`, `parseDocument(renderHTML(d))` deep-equals `d`. Rendering then reparsing is the identity on parser output.
2. **Canonical idempotence.** For that same `d`, `renderHTML(parseDocument(renderHTML(d))) === renderHTML(d)`. The serialization is canonical: writing it twice writes the same bytes.
3. **Sanitize fixpoint.** `sanitize(sanitize(x))` deep-equals `sanitize(x)` — and sanitizing a reparse of sanitized output reaches the same AST too, which is the law that matters when the output travels as a string and comes back.

The differences between the input bytes and the canonical output are enumerated, not incidental:

| Construct                      | Canonical form                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag and attribute names        | ASCII-lowercased — `<P CLASS=a>` writes as `<p class="a">`                                                                                         |
| Attribute values               | Always double-quoted, with `&` and `"` re-encoded and nothing else                                                                                 |
| Valueless attribute            | Stays valueless — never normalized to `=""`                                                                                                        |
| Duplicate attribute            | Only the first occurrence survives                                                                                                                 |
| Void element                   | `<br>` — never `<br/>`, never a close tag                                                                                                          |
| Text                           | `&`, `<`, `>` re-encoded minimally; a decoded named reference writes as its character (`&copy;` → `©`)                                             |
| Character references           | Numeric references decode to their character; an unknown named reference stays literal                                                             |
| `\r\n` / lone `\r`, `U+0000`   | `\n`; `U+FFFD`                                                                                                                                     |
| Implied closes and mis-nesting | The recovered tree's shape, not the source's tag order                                                                                             |
| Dropped constructs             | Stay dropped — an incomplete tag at EOF, a stray close tag, an unterminated declaration                                                            |
| Comment close variants         | An abrupt `<!-->` / `<!--->` writes as the empty `<!---->`, an incorrect `--!>` close writes as `-->`, and an unterminated comment gains its close |
| Doctype                        | `<!DOCTYPE html>` — uppercase keyword, lowercased name, quoted legacy identifiers                                                                  |

**A hand-built AST gets safety, not fidelity.** `renderHTML` accepts any node, including one no parser produced, and refuses rather than emits a construct that would reopen the document:

| Hand-built violation                                          | Rendered as                                     |
| ------------------------------------------------------------- | ----------------------------------------------- |
| A void element carrying children                              | `<br>` — the children are ignored               |
| A raw body containing its own close-tag sequence              | `<script></script>` — the body is dropped whole |
| An invalid element name                                       | Its children, with no tag at all                |
| An unwritable attribute name                                  | Omitted                                         |
| An invalid doctype name                                       | Nothing                                         |
| A comment body carrying `-->` / `--!>`, or opening `>` / `->` | Nothing — the comment is dropped WHOLE          |

## The sanitize floor

`sanitize` is a security boundary, and its options are allowed to narrow it, redirect it, or widen the _vocabulary_ — never to open a hole. Each of `elements`, `attributes`, and `schemes` replaces its default allowlist rather than extending it, and each accepts either shape of allowlist — a `ReadonlySet<string>` the caller builds, or a `readonly string[]`, so an exported frozen constant such as `SAFE_ELEMENTS` passes straight through without being copied into a `Set` first (`HTMLDistillOptions.elements` and `boilerplate` take both shapes too). Underneath every one of them sits a floor the options cannot lower:

- **`UNSAFE_ELEMENTS` subtrees are removed whole**, never unwrapped, even when the element allowlist names them. Unwrapping is precisely what makes them dangerous: the body of a `script`, `style`, `template`, or `noscript` becomes live markup the moment its wrapper disappears. Foreign content (`svg`, `math`) is here because this AST has no namespaces to police, and the form and metadata elements are here because they act rather than describe.
- **Handler, styling, and namespaced attributes always go**: every case-insensitive `on*` name, `style`, `srcdoc`, `xmlns`, and any name the sanitizer will not write — which is what removes a namespaced `xlink:href`, whose colon is not a writable attribute-name character here — even when the attribute allowlist names them. `sanitize({ attributes: new Set(['href', 'onclick']) })` keeps `href` and still strips `onclick`; an allowlist is not a permission slip.
- **Table-cell alignment is closed and unwidenable.** `align` survives only on `td` and `th`, only with `center`, `left`, or `right`, and is emitted in trimmed lowercase form. Every other element or value loses the attribute even when `HTMLSanitizeOptions.attributes` names it. The accepted tradeoff is obsolete presentational HTML: this exact membership rule follows the same allowlisted-then-narrowed pattern as URL attributes without adding value-grammar or CSS parsing. There is deliberately no general `style` or CSS policy axis, because that would add a new parsing surface to the sanitizer.
- **A `URL_ATTRIBUTES` value is decoded before it is judged.** `sanitizeURL` decodes character references to a bounded fixpoint, strips ASCII whitespace and control characters, and only then checks the scheme — so `java&#115;cript:` is not a clever spelling of anything. `javascript:`, `data:`, `vbscript:`, `file:`, and the protocol-relative forms (`//`, `\\`, `/\`, `\/`) are refused whatever `schemes` says. A value that fails is removed, not emptied, so nothing is left for a later pass to reinterpret. A value that still changes after the decode bound fails closed.
- **A safe element merely outside the allowlist is unwrapped to its children.** Wrapper soup melts while its content survives, and `mergeText` rejoins the text the splice put side by side — which is exactly why the sanitize fixpoint also holds through a reparse.
- **Comments are dropped** unless `comments: true`, and a comment that is kept is normalized through the renderer and reparsed, so a hand-built body carrying a close sequence is dropped here as well rather than travelling on. **A doctype survives untouched**, through the same normalization.

Consequences worth stating out loud. `SAFE_ATTRIBUTES` deliberately omits every resource `src`, so a sanitized `img` keeps its `alt` text and loses its download — sanitizing a page removes its ability to phone home, not only its ability to run code. `class` is kept because it is inert after `style`, `link`, `svg`, and `script` are gone, and because it is where a code block declares its language. And the output only ever leaves through `renderHTML`'s escaping grammar; the sanitizer never assembles markup itself.

The floor is enforced from immutable state. The hard-banned schemes (`javascript:`, `data:`, `vbscript:`, `file:`) and the always-stripped attribute names (`on*`, `style`, `srcdoc`, `xmlns`) are fixed comparisons in the code, and every behavior-bearing collection — `UNSAFE_ELEMENTS` first among them — is a frozen array or a frozen record: `Object.freeze` on an array refuses `push`, `splice`, and index assignment, and the keyed tables (`IMPLIED_CLOSERS`, `IMPLIED_BARRIERS`, `NAMED_ENTITIES`) are read as own properties only, so no entry can arrive through a prototype. Mutating an exported binding therefore cannot change what parsing, sanitizing, or rendering does. Every pass fails closed: a thrown value anywhere in `sanitize` or `distill` yields safe output, never the untrusted original — and that includes the options themselves, because each allowlist is read and normalized inside the boundary, so a hostile iterator or accessor on a collection you pass produces an empty document rather than an escaping error. Your own callbacks are the deliberate exception: `find`, `filter`, `reduce`, and `fold` let a handler's error propagate, because there is no honest generic value to substitute for behavior you authored, while `map` stays contained and preserves the document it started from. This is safety within this package's own serialization grammar — a property of what `renderHTML` re-emits — not a browser-native `TrustedHTML` substitute for a live DOM.

One more thing worth stating out loud: a URL sanitizer belongs to the output context it defends, and this one defends an AST that is about to be re-serialized. Its rules follow from that position rather than from the lower floor every URL sanitizer shares (strip every codepoint ≤ `U+0020` and `U+007F`–`U+009F`, refuse any two-character protocol-relative prefix drawn from `/` and `\`, extract an ASCII scheme, enforce an allowlist, keep relative / anchor / scheme-less values). First, `schemes` comes from the caller and replaces the default, so `javascript:` / `data:` / `vbscript:` / `file:` cannot be left to the allowlist and instead need the unwidenable refusal stated earlier, which no option can argue past. Second, the sanitized value is re-serialized and can be reparsed — and a hand-built AST can defer decoding to that later parse — so character references are decoded to a bounded fixpoint before the scheme is read: an obfuscated `https&colon;&sol;&sol;host` survives decoded while an obfuscated `javascript` does not. Third, `sanitizeURL` returns the raw survivor and lets `renderHTML` encode it later, which is why a kept `"` is not a hole: escaping is the serializer's job, one pass downstream, and doing it twice would corrupt the value.

The floor is enumerated as data rather than asserted case by case. `buildURLSafetyCorpus` in [`tests/setup.ts`](../tests/setup.ts) carries every vector with its disposition — control and whitespace splices, case variance, every protocol-relative form, kept relative / anchor / query URLs, refused schemes, entity obfuscation, unescaped survivors — and [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) sweeps the whole list, checks that no group has silently disappeared from it, and then pins each of the preceding rules with a named test instead of an absent assertion.

## The distill pass

`distill` is content extraction — a mechanism for reducing a page to its prose, with the policy in its option sets rather than baked in. It returns a pruned `HTMLInterface`, never a string: rendering stays a separate, downstream choice, which is what lets the same distilled document become HTML for a reader, plain text for a diff, or any projection a caller writes over the AST itself.

The passes run in this order:

1. **Region and chrome prune.** Every `boilerplate` region is removed with its children (a navigation menu's link text is noise in every reading of the page), as is every element marked `hidden` or `aria-hidden="true"`.
2. **Sanitize with the defaults.** Distilling narrows content; it never widens the security floor, and it is not a second security surface with its own opinions.
3. **Re-root at the sole content region.** `REGION_ELEMENTS` is tried in order — `main`, then `article` — and a name qualifies only when it occurs exactly once. Zero occurrences or several is ambiguous evidence, so the document is left whole rather than guessed at.
4. **Reduce to the content vocabulary.** Everything outside `elements` unwraps to its children; an attribute-free element whose only child is another element of the same name collapses into that child (`<ul><ul>…</ul></ul>` is one list); whitespace collapses to single spaces everywhere except inside `pre` and `code`, whose bodies stay exactly as written; an empty non-void element is dropped; comments and doctypes end here, being structure rather than content; and when `base` is given, every surviving URL attribute is resolved against it.

The hidden-content pass runs before the sanitize pass by necessity: `hidden` and `aria-hidden` are outside `SAFE_ATTRIBUTES`, so sanitizing first would consume the evidence the region and chrome prune reads. Pruning more before the floor is applied can never admit anything the floor would have refused, which is why the order is safe as well as necessary.

`base` resolves what survives the sanitize pass — in practice `href` and `cite`, because a resource `src` has already been removed by the sanitize floor — and an unresolvable value is left exactly as written rather than dropped. `resolveAttributes` is exported for the caller who wants base resolution over an AST that never went through the floor.

Distilling is idempotent on its own output, and like every other operation here it returns a new handle and never touches the original.

## Text is the lossy projection

`renderHTML` and `renderText` are not equivalent. `renderHTML` is the structure-preserving one: canonical, reparsable, and — on a distilled document — the smallest form that still says which line was a heading and where a link pointed. `renderText` is the flat one. Blocks and `br` provide line boundaries, direct cells within a row use tabs, rows within a table use newlines, and text beneath `pre` keeps its source whitespace; other text whitespace collapses. What it still drops is worth naming instead of discovering:

| Structure                    | In `renderText`'s output                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `h1` … `h6`                  | A bare line, at no level — indistinguishable from a paragraph or a list item                                                                                             |
| `ul` / `ol` / `li`           | One line per block inside each item, with no marker, no ordinal, no nesting depth                                                                                        |
| `a`                          | The link TEXT only; the destination `base` resolved is gone                                                                                                              |
| `img`                        | Nothing — `alt` text is an attribute, and attributes do not project                                                                                                      |
| `table` / `tr` / `th` / `td` | Tabs preserve direct cell positions, including empty cells, and newlines preserve rows; a `th` is indistinguishable from a `td`, and spans and attributes do not survive |
| `pre` / `code`               | Whitespace beneath `pre` stays verbatim; standalone `code` collapses normally; neither gains a fence or language marker                                                  |
| `blockquote`, `hr`           | Unmarked lines; an `hr` is a bare line boundary with no rule                                                                                                             |
| `strong` / `b`, `em` / `i`   | Their text, unmarked                                                                                                                                                     |

That table is the whole reason `distill` returns a handle. For a reader, a diff, or a summarizer that only needs prose, `renderText` is exactly right and cheaper than anything else here. For a consumer that reasons about structure — a language model asked which heading a passage sits under, or where a link goes — read the distilled AST directly, or serialize it with `renderHTML` and keep the structure the distiller worked to find. Choosing `renderText` there is choosing to throw that structure away.

## Relationship with `@orkestrel/contract`

The validation surface is a thin, purpose-built layer over `@orkestrel/contract`, the package's single runtime dependency (its own guide is mirrored at [`contract.md`](contract.md)):

- **Primitives, not copies.** `validators.ts` composes `recordOf` / `literalOf` / `arrayOf` and the primitive guards for the leaf shapes. Nothing here reimplements a declared primitive.
- **One exception boundary.** `attempt` is the declared safe-exception boundary and `holds` its predicate form, and every total surface in this package runs on one of them: the recursive guard in `validators.ts` on `holds`, the sanitize and distill engines in `HTML.ts` and every containing leaf in `helpers.ts` on `attempt`, so a hostile getter, a revoked proxy, or a thrown value becomes `false`, an empty document, or the leaf's documented fallback instead of a throw. `walkNodes` is the one remaining `try`, because a generator yields from inside its own body and `attempt` returns a value rather than resuming a suspended frame; the comment beside it says so.
- **Leaf shapes and compiled contracts, in lockstep.** `shapers.ts` declares a `ContractShape` per non-recursive node, and a consumer compiles one with `createContract(attributeShape)` — the supported call — into a `ContractInterface<T>` whose `schema`, `is`, `parse`, and `generate` all derive from that one declaration and therefore cannot drift. This package publishes no door of its own around that call.
- **Why the recursive nodes are guard-only.** A shape tree has no lazy or self-referential node — it is a finite, developer-authored tree a compiler can walk exhaustively. `ElementNode` and `HTMLDocument` recurse into `HTMLNode`, so they stay hand-written total guards with explicit ancestor tracking and a `MAX_DEPTH` bound: the recursion lives where it can be capped.

## Patterns

Every feature that follows has a compact, runnable example. Together they cover every `HTMLInterface` method and every standalone scanner, helper, and guard.

### Parse, then query

Parses a page, then queries it by guard, walk order, and span:

```ts
import { createHTML, isElementNode } from '@orkestrel/html'

const page = createHTML('<h1>Title</h1><p>A <b>bold</b> word.</p>')

page.document.children[0] // { category: 'element', name: 'h1', attributes: [], children: [...] }
page.span(page.document) // { start: 0, end: 40 } - half-open offsets in the original input
page.find(isElementNode)?.name // 'h1' - narrowed to ElementNode by the guard overload
page.filter(isElementNode).map((element) => element.name) // ['h1', 'p', 'b']

const categories: string[] = []
for (const node of page.walk()) categories.push(node.category)
// ['document', 'element', 'text', 'element', 'text', 'element', 'text', 'text']
```

### Adopt a document that came from somewhere else

Adopts a foreign document through the total guard and refuses a bogus one:

```ts
import { HTML, isHTMLDocument, isHTMLNode } from '@orkestrel/html'

function adopt(candidate: unknown): HTML | undefined {
	if (!isHTMLDocument(candidate)) return undefined // total guard - never throws
	return new HTML(candidate) // adopted as-is, not re-validated
}

adopt({ category: 'document', children: [] }) // an HTML handle
adopt({ category: 'bogus' }) // undefined - rejected before any handle exists
isHTMLNode({ category: 'text', value: 'a & b' }) // true - one leaf, validated from unknown
```

### Rewrite with `map`, count with `reduce`, project with `fold`

Rewrites with `map`, counts with `reduce`, and projects with `fold`:

```ts
import { createHTML, isTextNode, renderHTML } from '@orkestrel/html'
import type { HTMLHandlerMap } from '@orkestrel/html'

const page = createHTML('<h1>Title</h1><p>A <b>bold</b> word.</p>')

const shouted = page.map((node) =>
	node.category === 'text' ? { category: 'text', value: node.value.toUpperCase() } : node,
)
renderHTML(shouted.document) // '<h1>TITLE</h1><p>A <b>BOLD</b> WORD.</p>'
renderHTML(page.document) // '<h1>Title</h1><p>A <b>bold</b> word.</p>' - never mutated

page.reduce((total, node) => (isTextNode(node) ? total + node.value.length : total), 0) // 17

const elements: HTMLHandlerMap<number> = {
	document: (_, children) => children.reduce((total, value) => total + value, 0),
	element: (_, children) => 1 + children.reduce((total, value) => total + value, 0),
	text: () => 0,
	comment: () => 0,
	doctype: () => 0,
}
page.fold(elements) // 3
```

### Stream the top level, shallow and backpressured

Streams the root's direct children through a reader and an async iteration:

```ts
import { createHTML } from '@orkestrel/html'

const page = createHTML('<h1>Title</h1><p>First.</p><p>Second.</p>')

// universal - a reader loop works in every ReadableStream-supporting environment
const reader = page.stream().getReader()
for (let result = await reader.read(); !result.done; result = await reader.read()) {
	result.value.category // 'element' - the root's direct children only
}

// Node / Deno / Firefox iterate a ReadableStream natively
for await (const node of page.stream()) node.category
```

### Sanitize, and watch the floor hold

Sanitizes to the floor whatever the element and attribute allowlists say:

```ts
import { createHTML, renderHTML, SAFE_ELEMENTS } from '@orkestrel/html'

const page = createHTML(
	'<div id="wrap"><p onclick="steal()">Hi <script>steal()</script>' +
		'<a href="javascript:alert(1)">bad</a></p><!-- note --></div>',
)

renderHTML(page.sanitize().document)
// '<div><p>Hi <a>bad</a></p></div>' - script gone whole, handler gone, dangerous href removed

renderHTML(page.sanitize({ comments: true }).document)
// '<div><p>Hi <a>bad</a></p><!-- note --></div>'

renderHTML(page.sanitize({ elements: new Set(['p']) }).document)
// '<p>Hi bad</p>' - div and a are safe but unlisted, so they unwrap to their content

// An allowlist is a Set or an array, so a frozen export needs no copy to be named explicitly.
renderHTML(page.sanitize({ elements: ['p'] }).document) // '<p>Hi bad</p>' - same as the preceding Set
renderHTML(page.sanitize({ elements: SAFE_ELEMENTS, comments: true }).document)
// '<div><p>Hi <a>bad</a></p><!-- note --></div>' - the default vocabulary, spelled out

const link = createHTML('<a href="/guide" onclick="steal()" title="Guide">g</a>')
renderHTML(link.sanitize({ attributes: new Set(['href', 'onclick']) }).document)
// '<a href="/guide">g</a>' - href kept, onclick still stripped: the floor is not an allowlist

renderHTML(createHTML('<img src="/x.png" alt="x">').sanitize().document)
// '<img alt="x">' - alt kept, resource src removed by the default attributes

renderHTML(createHTML('<a href="java&#115;cript:alert(1)">bad</a>').sanitize().document)
// '<a>bad</a>' - the entity-obfuscated scheme is decoded and refused

renderHTML(
	createHTML('<table><tr><td align=" Center ">c</td></tr></table><p align="center">p</p>').sanitize(
		{ attributes: ['align'] },
	).document,
)
// '<table><tr><td align="center">c</td></tr></table><p>p</p>' - only a cell keeps trimmed lowercase align
```

### Distill a page down to its content

Distills a page to its content and keeps the handle a projection choice:

```ts
import { createHTML, renderHTML, renderText } from '@orkestrel/html'

// The string boundary: a scrape, a fetch, a fixture. `@orkestrel/browser` hands over
// page content the same way - a plain string plus the URL it came from.
const content = {
	html: '<nav>Menu</nav><main><h1>Title</h1><p>Read the <a href="/b">guide</a>.</p></main>',
	url: 'https://x.dev/docs/page',
}

const page = createHTML(content.html)

// Two shapes of output from one parse: the whole page made safe, or its content extracted.
const safe = page.sanitize()
const article = page.distill({ base: content.url }) // distill sanitizes internally, with the defaults

// Structure survives serialization: the heading is still a heading, the link still points.
renderHTML(article.document) // '<h1>Title</h1><p>Read the <a href="https://x.dev/b">guide</a>.</p>'

// Text does not: levels, markers, and destinations are gone, deliberately.
renderText(article.document) // 'Title\nRead the guide.'
renderText(safe.document) // 'Menu\nTitle\nRead the guide.'

// Policy is data: name the regions to drop and the vocabulary to keep, as a Set or an array.
const narrow = page.distill({ boilerplate: ['footer'], elements: new Set(['h1', 'p', 'a']) })
narrow.document.category // 'document' - always a handle, never a string
```

### Work on a bare node, with no handle at all

Drives the standalone leaves on a bare node with no handle at all:

```ts
import {
	collapseText,
	extractRegion,
	foldNode,
	mergeText,
	parseProvenance,
	pruneDocument,
	REGION_ELEMENTS,
	renderHTML,
	renderText,
	rewriteDocument,
	walkNodes,
} from '@orkestrel/html'
import type { HTMLHandlerMap } from '@orkestrel/html'

const [document, spans] = parseProvenance('<nav>x</nav><main><p>Keep<!-- drop --></p></main>')
spans.get(document) // { start: 0, end: 49 }

const [region] = extractRegion(document, REGION_ELEMENTS) // re-rooted at the sole <main>
const [pruned] = pruneDocument(region, (node) => (node.category === 'comment' ? [] : [node]))
renderHTML(pruned)
// '<p>Keep</p>' - [] drops, node.children unwraps, [node] keeps

const [lowered] = rewriteDocument(document, (node) =>
	node.category === 'text' ? { category: 'text', value: node.value.toLowerCase() } : node,
)
renderText(lowered) // 'x\nkeep'

const categories = [...walkNodes(region)].map((node) => node.category)
// ['document', 'element', 'text', 'comment'] - depth-first, pre-order, root included

const leaves: HTMLHandlerMap<number> = {
	document: (_, children) => children.reduce((total, value) => total + value, 0),
	element: (_, children) => children.reduce((total, value) => total + value, 0),
	text: () => 1,
	comment: () => 1,
	doctype: () => 1,
}
foldNode(region, leaves) // 2

mergeText([
	{ category: 'text', value: 'a ' },
	{ category: 'text', value: 'b' },
]) // [{ category: 'text', value: 'a b' }] - the invariant an unwrap must restore
collapseText([{ category: 'text', value: ' a \n b ' }])[0]
// [{ category: 'text', value: ' a b ' }]
```

### Scan by hand, one piece at a time

Scans one construct at a time and reports each exact end offset:

```ts
import {
	decodeEntities,
	isHTMLCodePoint,
	lowercaseASCII,
	normalizeSource,
	parseStartTag,
	projectSpan,
	scanAttributes,
	scanComment,
	scanDoctype,
	scanRawText,
	scanTag,
} from '@orkestrel/html'

const [normalized, offsets] = normalizeSource('A\r\n𝕏')
normalized // 'A\n𝕏'
projectSpan(offsets, 2, 4) // { start: 3, end: 5 }
projectSpan([0, 1], 1, 2) // undefined - boundary 2 is uncovered

parseStartTag('<html lang="en" data-bs-theme="light">', 0)
// { name: 'html', attributes: [{ name: 'lang', value: 'en' }, { name: 'data-bs-theme', value: 'light' }], slashed: false, next: 38 }

parseStartTag('<html data-note="unterminated>', 0) // undefined — no recovery

scanTag('<IMG SRC="x.png" alt=hi />', 0)
// { name: 'img', attributes: [{ name: 'src', value: 'x.png' }, { name: 'alt', value: 'hi' }], closing: false, next: 26 }

scanAttributes(' HREF="/a" disabled href="/b"')
// [{ name: 'href', value: '/a' }, { name: 'disabled' }] - lowercased, first wins, valueless stays valueless

scanComment('<![CDATA[x]]>', 0) // { node: { category: 'comment', value: '[CDATA[x]]' }, next: 13 }
scanDoctype('<!DOCTYPE html>', 0) // { node: { category: 'doctype', name: 'html' }, next: 15 }
scanRawText('a < b</SCRIPT>tail', 0, 'script')
// { node: { category: 'text', value: 'a < b' }, span: { start: 0, end: 5 }, next: 14, closed: true }

decodeEntities('a &amp; b &#169; c &bogus;') // 'a & b © c &bogus;' - unknown names stay literal
lowercaseASCII('HTML-Ω') // 'html-Ω' - Unicode is preserved
isHTMLCodePoint(0x1f600) // true
isHTMLCodePoint(0xd800) // false - surrogate
```

### Escape, resolve, and inspect

Escapes, resolves, and inspects one attribute at a time:

```ts
import {
	attributeOf,
	collapseSpace,
	encodeAttribute,
	encodeText,
	parseDocument,
	resolveAttributes,
	resolveURL,
	SAFE_ATTRIBUTES,
	SAFE_URL_SCHEMES,
	sanitizeAttributes,
	sanitizeURL,
} from '@orkestrel/html'

encodeText('a & b < c') // 'a &amp; b &lt; c'
encodeAttribute('a "b" & c') // 'a &quot;b&quot; &amp; c'
collapseSpace('  a \n\t b  ') // 'a b'

sanitizeURL('java&#115;cript:alert(1)', SAFE_URL_SCHEMES) // '' - decoded first, then refused
sanitizeURL('/docs/page', SAFE_URL_SCHEMES) // '/docs/page' - relative is always allowed
resolveURL('../a', 'https://x.dev/docs/page') // 'https://x.dev/a'

const anchor = parseDocument('<a href="javascript:alert(1)" title="Home" onclick="x()">t</a>')
	.children[0]
if (anchor?.category === 'element') {
	attributeOf(anchor, 'TITLE') // 'Home' - case-insensitive; '' would mean present-but-valueless
	sanitizeAttributes(anchor, SAFE_ATTRIBUTES, SAFE_URL_SCHEMES) // [{ name: 'title', value: 'Home' }]
	resolveAttributes(anchor, 'https://x.dev/docs/') // href resolved, other names lowercased
}
```

### Ask a name or an element a question

Answers a name predicate, a URL predicate, and an emptiness predicate:

```ts
import {
	isBlockElement,
	isEmptyElement,
	isLiteralElement,
	isRawElement,
	isSafeURL,
	isVoidElement,
	parseDocument,
} from '@orkestrel/html'

isVoidElement('BR') // true - case-insensitive, derived from the name, never stored
isRawElement('script') // true
isLiteralElement('title') // true
isBlockElement('p') // true

isSafeURL('/a') // true - relative
isSafeURL('javascript:x') // false - refused whatever the scheme set says
isSafeURL('ftp://x.dev', new Set(['ftp'])) // true - a caller may widen the safe schemes

const image = parseDocument('<img src="a.png" alt="A">').children[0]
if (image?.category === 'element') isEmptyElement(image) // true
```

### Prove the roundtrip laws

Holds the AST fixpoint, canonical idempotence, and sanitize fixpoint laws:

```ts
import { createHTML, parseDocument, renderHTML } from '@orkestrel/html'

const page = createHTML('<P CLASS=a>x<BR/></P>')

renderHTML(page.document) // '<p class="a">x<br></p>' - canonical, not byte-identical to the input

// 1. AST fixpoint: reparsing what the renderer wrote returns the same AST.
parseDocument(renderHTML(page.document)) // deep-equals page.document

// 2. Canonical idempotence: rendering that reparse returns the same string.
renderHTML(parseDocument(renderHTML(page.document))) === renderHTML(page.document) // true

// 3. Sanitize fixpoint - directly, and through a reparse of its own output.
const clean = page.sanitize().document
renderHTML(createHTML(clean).sanitize().document) === renderHTML(clean) // true
renderHTML(createHTML(renderHTML(clean)).sanitize().document) === renderHTML(clean) // true
```

## Tests

- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) — returned provenance, the whole recovery table row by row, entity decoding, and a hostile corpus proving totality, the no-adjacent-text invariant, and guard soundness under hostile floods.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — the from-unknown leaf and recursive guards (cycles, hostile getters, revoked proxies, excessive depth, the void-element invariant).
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — source normalization and span projection; ASCII case folding, entity decoding, the escaping, URL, attribute, and text leaves; the element-name, empty-element, and URL predicates; every exported recovering scanner and the strict start-tag source boundaries with their hostile refusals; `mergeText` / `collapseText` / `extractRegion` / `pruneDocument`; `renderHTML` and `renderText` including the hand-built-AST refusals; and the AST fixpoint and canonical idempotence laws.
- [`tests/src/core/HTML.test.ts`](../tests/src/core/HTML.test.ts) — construction and adoption, `walk` / `find` / `filter` / `map` / `reduce` / `fold` / `stream`, the sanitize floor and its laws against an adversarial corpus, and every pass of the distill pipeline including its idempotence.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — per-shape guard exactness, closed JSON Schemas, seeded generation, parse rebuilds, `Infer` ↔ interface parity in each direction, and the doctype shape against what the parser produces.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — `createHTML` against the class it constructs.
- [`tests/policy.test.ts`](../tests/policy.test.ts) — repository coding law: source placement, exports, readonly contracts, and syntax.
- [`tests/guides.test.ts`](../tests/guides.test.ts) — this guide against the real surface in each direction, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Parse, then query` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.

## See also

- [`AGENTS.md`](../AGENTS.md) — the repository rules this package is written to.
- [`contract.md`](contract.md) — the mirrored guide for `@orkestrel/contract`, the sole runtime dependency behind the guards, shapes, and compiled contracts.
- [`guide.md`](guide.md) — the mirrored guide for `@orkestrel/guide`, the devDependency powering the guides-parity suite.
- [`README.md`](README.md) — the guides index.
