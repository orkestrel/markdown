import type { MarkdownParserInterface } from './types.js'
import { MarkdownParser } from './MarkdownParser.js'

/**
 * Create a markdown parser - a stateless handle that turns a markdown string into a
 * typed {@link MarkdownDocument} AST and (separately) renders an AST to a safe HTML
 * string.
 *
 * @remarks
 * `parse(markdown)` runs a block phase (headings / paragraphs / lists / GFM tables /
 * fenced code / blockquotes / thematic breaks) then an inline phase (emphasis /
 * inline code / links) and returns a render-agnostic {@link MarkdownDocument}.
 * `render(node)` is a SEPARATE projection to HTML that HTML-escapes all text +
 * attributes and sanitizes link `href`s (an unsafe scheme - `javascript:` / `data:`
 * / … - is dropped), so even hostile content cannot inject markup or script.
 * `parseInline(text)` exposes the inline phase alone. Pure + total (malformed
 * markdown degrades to text, never throws) and zero-dependency - a hand-written
 * scanner, no regex-only structural parse, linear-time (no ReDoS). Stateless and
 * event-free (unlike the streaming NDJSON / SSE parsers), so a handle is freely
 * reused.
 *
 * @returns A working {@link MarkdownParserInterface}
 *
 * @example
 * ```ts
 * import { createMarkdownParser } from '@src/core'
 *
 * const parser = createMarkdownParser()
 * const ast = parser.parse('# Hi\n\nRead the [guide](./guide.md).')
 * parser.render(ast) // '<h1>Hi</h1>\n<p>Read the <a href="./guide.md">guide</a>.</p>'
 * ```
 */
export function createMarkdownParser(): MarkdownParserInterface {
	return new MarkdownParser()
}
