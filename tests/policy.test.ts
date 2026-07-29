import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isBrowserVuePath } from './setup.js'
import { inspectCodingLaw, inspectCodingWorkspace } from './setupPolicy.js'

describe('repository coding law', () => {
	it('keeps Vue single-file components exclusively in browser environments', () => {
		const files = globSync('{app,src}/**/*.vue')

		expect(files.every(isBrowserVuePath)).toBe(true)
	})

	it('enforces source placement, exports, readonly contracts, and syntax law', () => {
		expect(inspectCodingWorkspace(process.cwd())).toEqual([])
	})

	it('rejects functions from declaration-only modules', () => {
		// The canon now admits shape-builder functions in shapers.ts; types.ts stays
		// declaration-only, so it proves the misplaced-function rejection path.
		expect(
			inspectCodingLaw('src/core/types.ts', 'export function textShape(): object { return {} }'),
		).toContain('src/core/types.ts places module functions in their centralized kind file')
	})
})
