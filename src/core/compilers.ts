import type { MarkdownNode } from './types.js'
import { HTML, SAFE_ATTRIBUTES, renderHTML as renderHTMLDocument } from '@orkestrel/html'
import { markdownToHTML } from './helpers.js'

// The class-driving half of the outbound direction. `helpers.ts` owns the pure
// {@link markdownToHTML} projection, which imports no implementation class and stays a
// leaf; the sanitize-and-serialize pipeline below constructs `@orkestrel/html`'s `HTML`
// class, so it sits above the leaves and consumes them.

/**
 * Renders a {@link MarkdownNode} to sanitized canonical HTML.
 *
 * @remarks
 * Markdown widens `@orkestrel/html`'s attribute floor by exactly `src`, because image
 * syntax is meaningless without its source. `src` is still a URL attribute, so the
 * floor refuses `javascript:`, `data:`, `vbscript:`, and `file:` values. A stricter
 * consumer can compose {@link markdownToHTML} with `@orkestrel/html`'s `HTML` class
 * directly.
 *
 * @param node - The markdown document or bare node to render
 * @returns Sanitized canonical HTML
 *
 * @example
 * ```ts
 * renderHTML({ element: 'paragraph', children: [{ element: 'text', value: 'a & b' }] })
 * // '<p>a &amp; b</p>'
 * ```
 */
export function renderHTML(node: MarkdownNode): string {
	return renderHTMLDocument(
		new HTML(markdownToHTML(node)).sanitize({ attributes: [...SAFE_ATTRIBUTES, 'src'] }).document,
	)
}
