// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.

import type {
	BlockNode,
	BlockquoteNode,
	CodeBlockNode,
	CodeSpanNode,
	EmphasisNode,
	HeadingNode,
	InlineNode,
	LinkNode,
	ListNode,
	ParagraphNode,
	TableNode,
} from '@src/core'
import {
	Markdown,
	flattenText,
	isHeadingNode,
	isListNode,
	isTableNode,
	isParagraphNode,
	isCodeBlockNode,
	isBlockquoteNode,
	isEmphasisNode,
	isCodeSpanNode,
	isLinkNode,
} from '@src/core'
import { afterEach, vi } from 'vitest'

afterEach(() => {
	vi.restoreAllMocks()
})

// ── Deterministic randomness ──────────────────────────────────────────────────
// The single house seed for tests that need generated/random input (contract
// `.generate(random)` calls, fuzz-style fixtures). Suites call
// `seededRandom(TEST_SEED)` directly to get a fresh, deterministic
// `RandomFunction` — keeping the seed centralized here means every suite that
// wants determinism uses the same starting point.
export const TEST_SEED = 42

// ── Markdown AST assertions ────────────────────────────────────────────────────
// Assert a parsed node IS a given element kind — throwing if not — and return it
// narrowed, so a test reads the typed node (`assertHeading(block).level`,
// `assertLink(node).href`) without an `as` or an `if`-guarded `expect` (both
// AGENTS-forbidden; §1 / §16). Thin assert-and-narrow wrappers over `@src/core`'s
// `is*` guards — one `assert{Element}` per guard — environment-agnostic, so they
// sit here beside the other base helpers, shared across the Markdown and
// AST-validator unit tests.

/** Parse `markdown` and narrow its FIRST block, asserting at least one exists. */
export function firstBlock(markdown: string): BlockNode {
	const block = new Markdown(markdown).document.children[0]
	if (block === undefined) throw new Error('expected at least one block')
	return block
}

export function assertHeadingNode(block: BlockNode): HeadingNode {
	if (!isHeadingNode(block)) throw new Error(`expected heading, got ${block.element}`)
	return block
}

export function assertListNode(block: BlockNode): ListNode {
	if (!isListNode(block)) throw new Error(`expected list, got ${block.element}`)
	return block
}

export function assertTableNode(block: BlockNode): TableNode {
	if (!isTableNode(block)) throw new Error(`expected table, got ${block.element}`)
	return block
}

export function assertParagraphNode(block: BlockNode | undefined): ParagraphNode {
	if (block === undefined || !isParagraphNode(block)) {
		throw new Error(`expected paragraph, got ${block?.element}`)
	}
	return block
}

export function assertCodeBlockNode(block: BlockNode): CodeBlockNode {
	if (!isCodeBlockNode(block)) throw new Error(`expected codeBlock, got ${block.element}`)
	return block
}

export function assertBlockquoteNode(block: BlockNode): BlockquoteNode {
	if (!isBlockquoteNode(block)) throw new Error(`expected blockquote, got ${block.element}`)
	return block
}

export function assertEmphasisNode(node: InlineNode | undefined): EmphasisNode {
	if (node === undefined || !isEmphasisNode(node)) {
		throw new Error(`expected emphasis, got ${node?.element}`)
	}
	return node
}

export function assertCodeSpanNode(node: InlineNode | undefined): CodeSpanNode {
	if (node === undefined || !isCodeSpanNode(node)) {
		throw new Error(`expected codeSpan, got ${node?.element}`)
	}
	return node
}

export function assertLinkNode(node: InlineNode | undefined): LinkNode {
	if (node === undefined || !isLinkNode(node))
		throw new Error(`expected link, got ${node?.element}`)
	return node
}

// Parse a single-paragraph markdown snippet, assert it yields exactly one
// paragraph, and return its first inline child narrowed to `InlineNode`.
export function assertInlineNode(markdown: string): InlineNode {
	const node = assertParagraphNode(firstBlock(markdown)).children[0]
	if (node === undefined) throw new Error(`no inline node parsed from: ${markdown}`)
	return node
}

// The flattened text content of a LIST of inline nodes (a paragraph's `children`,
// say) — the array-shaped convenience test suites call over `@src/core`'s
// `flattenText(node)` (which flattens a single node's descendants), joining each
// node's flattened text in order.
export function inlineText(nodes: readonly InlineNode[]): string {
	return nodes.map((node) => flattenText(node)).join('')
}

// ── Adversarial values for guard-totality tests ───────────────────────────────
// The `isInlineNode` / `isBlockNode` / `isMarkdownNode` / `isMarkdownDocument`
// guards must be total — return `false`, never throw — for any `unknown` input,
// including hostile shapes a real parser would never emit. These builders
// produce exactly those shapes.

/**
 * An emphasis-like record whose `children` array contains a reference cycle
 * (the array holds the record itself). Exercises guard totality against
 * cyclic input without relying on structural recursion blowing the stack.
 */
export function buildCyclicNode(): unknown {
	const node: { element: string; children: unknown[] } = { element: 'emphasis', children: [] }
	node.children.push(node)
	return node
}

/**
 * An object shaped like a markdown node whose `element` property is a getter
 * that throws when read. Exercises guard totality against input that throws
 * mid-inspection rather than returning a plain value.
 */
export function buildHostileNode(): unknown {
	return {
		get element(): string {
			throw new Error('hostile getter')
		},
		get children(): unknown {
			throw new Error('hostile getter')
		},
	}
}

/**
 * An emphasis-like inline chain nested `levels` deep, each level's `children`
 * holding exactly the next level, with a text-like record at the innermost
 * leaf. For stack-safety tests on inline guards/traversal.
 */
export function buildDeepInlineNode(levels: number): unknown {
	let node: unknown = { element: 'text', value: 'leaf' }
	for (let depth = 0; depth < levels; depth += 1) {
		node = { element: 'emphasis', children: [node] }
	}
	return node
}

/**
 * A blockquote-like block chain nested `levels` deep, each level's `children`
 * holding exactly the next level, with a paragraph-like record at the
 * innermost leaf. For stack-safety tests on block guards/traversal.
 */
export function buildDeepBlockNode(levels: number): unknown {
	let node: unknown = { element: 'paragraph', children: [] }
	for (let depth = 0; depth < levels; depth += 1) {
		node = { element: 'blockquote', children: [node] }
	}
	return node
}

// ── Deep markdown source for parser stack-safety tests ────────────────────────
// Plain string builders producing markdown input nested `levels` deep, for
// asserting the parser degrades gracefully (never throws) past `MAX_DEPTH`.

/** Markdown source with `levels` leading `>` blockquote markers before `text`. */
export function buildDeepQuoteInput(levels: number, text = 'leaf'): string {
	return `${'> '.repeat(levels)}${text}`
}

/** Markdown source for an `levels`-deep nested list, one indent per level. */
export function buildDeepListInput(levels: number, text = 'leaf'): string {
	const lines: string[] = []
	for (let depth = 0; depth < levels; depth += 1) {
		lines.push(`${'  '.repeat(depth)}- ${depth === levels - 1 ? text : ''}`)
	}
	return lines.join('\n')
}

/** Markdown source with `levels` nested `*emphasis*`/`[link](` inline markers around `text`. */
export function buildDeepEmphasisInput(levels: number, text = 'leaf'): string {
	let source = text
	for (let depth = 0; depth < levels; depth += 1) {
		source = depth % 2 === 0 ? `*${source}*` : `[${source}](url)`
	}
	return source
}

// ── Mirrored URL-safety corpus ────────────────────────────────────────────────
// `sanitizeUrl`'s lower floor — strip every codepoint ≤ U+0020 and U+007F–U+009F,
// refuse any two-character protocol-relative prefix drawn from `/` and `\`, extract
// an ASCII scheme, enforce an allowlist, keep relative / anchor / scheme-less values —
// is re-implemented, deliberately, in `@orkestrel/html`'s `sanitizeURL`: each package
// owns the sanitizer for its own output context (guides/src/markdown.md § Sanitization
// policy explains why). There is therefore no shared function to test once, and the
// corpus below is what the two packages DO share. It is mirrored vector-for-vector, in
// this order, under the same name in `@orkestrel/html`'s `tests/setup.ts`, so a vector
// missed here is missed there too and a reader can diff the two lists by eye.
//
// The `controls` / `case` / `relative` / `kept` / `schemes` groups are the floor both
// packages agree on, vector for vector. The `entities` and `escaping` groups carry the
// SAME inputs with each package's own disposition — the two legitimate divergences,
// explained at each group below and asserted as named tests in helpers.test.ts.

/** One adversarial URL and the value this package's sanitizer may retain. */
export interface URLSafetyCase {
	/** The threat family, used to inventory corpus coverage. */
	readonly group: string
	/** The behavior-specific case name. */
	readonly name: string
	/** The raw destination handed to the sanitizer. */
	readonly source: string
	/** The retained value; absence means the destination is refused (dropped to `''`). */
	readonly value?: string
}

/** Build the URL-safety corpus mirrored in `@orkestrel/html`, with markdown's dispositions. */
export function buildURLSafetyCorpus(): readonly URLSafetyCase[] {
	return [
		// Controls and whitespace are stripped BEFORE the scheme is read, so a splice
		// cannot hide a scheme from the allowlist check.
		{ group: 'controls', name: 'tab-spliced scheme', source: 'java\tscript:alert(1)' },
		{ group: 'controls', name: 'newline-spliced scheme', source: 'java\nscript:alert(1)' },
		{ group: 'controls', name: 'NUL-spliced scheme', source: 'java\u0000script:alert(1)' },
		{ group: 'controls', name: 'C1-spliced scheme', source: 'java\u0085script:alert(1)' },
		{ group: 'controls', name: 'slash-spliced protocol-relative', source: '/\t/evil.dev' },
		{ group: 'controls', name: 'leading-space scheme', source: '  javascript:alert(1)' },
		// The scheme comparison is case-insensitive in both directions: a dangerous
		// scheme cannot escape by case, and a safe one cannot be refused by it.
		{ group: 'case', name: 'mixed-case javascript', source: 'JaVaScRiPt:alert(1)' },
		{ group: 'case', name: 'mixed-case HTTPS', source: 'HtTpS://ok.dev', value: 'HtTpS://ok.dev' },
		// All four two-character protocol-relative prefixes inherit the embedding page's
		// scheme; a SINGLE leading `/` or `\` is same-origin relative and survives.
		{ group: 'relative', name: 'double slash', source: '//evil.dev' },
		{ group: 'relative', name: 'double backslash', source: '\\\\evil.dev' },
		{ group: 'relative', name: 'slash backslash', source: '/\\evil.dev' },
		{ group: 'relative', name: 'backslash slash', source: '\\/evil.dev' },
		{ group: 'relative', name: 'single backslash', source: '\\evil.dev', value: '\\evil.dev' },
		{ group: 'kept', name: 'absolute path', source: '/path', value: '/path' },
		{ group: 'kept', name: 'anchor', source: '#anchor', value: '#anchor' },
		{ group: 'kept', name: 'query', source: '?q=1', value: '?q=1' },
		{ group: 'kept', name: 'mailto', source: 'mailto:a@b.dev', value: 'mailto:a@b.dev' },
		{ group: 'kept', name: 'tel', source: 'tel:+15551234', value: 'tel:+15551234' },
		{ group: 'kept', name: 'https', source: 'https://ok.dev', value: 'https://ok.dev' },
		// An empty destination has nothing to refuse and nothing to keep.
		{ group: 'kept', name: 'empty', source: '', value: '' },
		{ group: 'schemes', name: 'javascript', source: 'javascript:alert(1)' },
		{ group: 'schemes', name: 'data', source: 'data:text/html,<script>' },
		{ group: 'schemes', name: 'file', source: 'file:///etc/passwd' },
		{ group: 'schemes', name: 'vbscript', source: 'vbscript:msgbox' },
		{ group: 'schemes', name: 'unlisted scheme', source: 'ftp://host' },
		// DIVERGENCE — the entity-decode pass. `@orkestrel/html` REFUSES every vector in
		// this group: it decodes character references to a bounded fixpoint before reading
		// the scheme, because its sanitized value is re-serialized (and can be reparsed)
		// downstream. markdown needs no decode pass, because it escapes here: the retained
		// value below reaches the browser as literal text whose `:` never begins a scheme,
		// so it is inert as a relative destination. Same inputs, same safety, other stage.
		{
			group: 'entities',
			name: 'decimal entity scheme',
			source: '&#106;avascript:x',
			value: '&amp;#106;avascript:x',
		},
		{
			group: 'entities',
			name: 'hex entity scheme',
			source: '&#x6a;avascript:x',
			value: '&amp;#x6a;avascript:x',
		},
		{
			group: 'entities',
			name: 'named colon',
			source: 'javascript&colon;x',
			value: 'javascript&amp;colon;x',
		},
		{
			group: 'entities',
			name: 'double-encoded colon',
			source: 'javascript&amp;colon;x',
			value: 'javascript&amp;amp;colon;x',
		},
		{
			group: 'entities',
			name: 'entity protocol-relative',
			source: '&sol;&sol;evil.dev',
			value: '&amp;sol;&amp;sol;evil.dev',
		},
		{
			group: 'entities',
			name: 'entity-obfuscated allowed scheme',
			source: 'https&colon;&sol;&sol;ok.dev',
			value: 'https&amp;colon;&amp;sol;&amp;sol;ok.dev',
		},
		// DIVERGENCE — escaping position. markdown escapes INSIDE `sanitizeUrl`, because
		// its result is a finished `href` attribute value. `@orkestrel/html` retains these
		// same values UNESCAPED and encodes them later, in `renderHTML`'s serializer.
		{
			group: 'escaping',
			name: 'ampersand in a kept URL',
			source: 'https://ok.dev/?a=1&b=2',
			value: 'https://ok.dev/?a=1&amp;b=2',
		},
		{
			group: 'escaping',
			name: 'quote in a kept URL',
			source: 'https://ok.dev/"onmouseover=x',
			value: 'https://ok.dev/&quot;onmouseover=x',
		},
	]
}

/** The mirrored corpus's threat families, in corpus order — identical in `@orkestrel/html`. */
export const URL_SAFETY_GROUPS: readonly string[] = [
	'controls',
	'case',
	'relative',
	'kept',
	'schemes',
	'entities',
	'escaping',
]

/** Whether a repository-relative Vue SFC path belongs to the private browser application. */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
}
