/**
 * The URL schemes a {@link MarkdownParserInterface} renderer permits on a link
 * `href` - anything else (notably `javascript:`, `data:`, `vbscript:`, `file:`) is
 * dropped to an empty `href` so a hostile link can never execute. Frozen, lower-case;
 * a relative / anchor / scheme-less `href` (no `scheme:` prefix) is always allowed.
 */
export const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel'])
