import { expect, test } from 'claude-code/testing'
import { PROFILES, parsePipeline } from '../hooks/config'
import type { Profile } from '../types'

// The `pipeline` settings (parsePipeline in config.ts): off by default, clamped, and
// a profile that does not exist falls back with a warning.

const KNOWN: Record<string, Profile> = { ...PROFILES, opus: { kind: 'claude', args: [] } }

test('pipeline is off unless enabled is true', () => {
  expect(parsePipeline(undefined, KNOWN)).toBeUndefined()
  expect(parsePipeline({}, KNOWN)).toBeUndefined()
  expect(parsePipeline({ enabled: false }, KNOWN)).toBeUndefined()
})

test('enabled alone gives the defaults', () => {
  expect(parsePipeline({ enabled: true }, KNOWN)).toEqual({
    enabled: true,
    merge: 'ready',
    rounds: 3,
    rescueAfter: 2,
    profiles: { build: 'builder', review: 'reviewer', rescue: 'debugger' },
    cap: null,
    ciEveryMinutes: 2,
    ciMaxMinutes: 60,
    noCiMinutes: 10,
    pauseMinutes: 30,
    maxSpawns: 8,
    ownerTest: [],
  })
})

test('merge auto, ownerTest, cap and a rescue profile are read', () => {
  const cfg = parsePipeline(
    { enabled: true, merge: 'auto', cap: 2, ownerTest: ['view/**', '', 7 as never], profiles: { rescue: 'opus' } },
    KNOWN,
  )
  expect(cfg).toMatchObject({ merge: 'auto', cap: 2, ownerTest: ['view/**'], profiles: { rescue: 'opus', build: 'builder' } })
  expect(cfg?.warning).toBeUndefined()
})

test('numbers are clamped, and a merge other than auto is ready', () => {
  const cfg = parsePipeline(
    {
      enabled: true,
      merge: 'yes' as never,
      rounds: 99,
      rescueAfter: 50,
      ciEveryMinutes: 0,
      maxSpawns: -3,
      cap: 0,
      pauseMinutes: 'x' as never,
    },
    KNOWN,
  )
  expect(cfg).toMatchObject({ merge: 'ready', rounds: 10, rescueAfter: 10, ciEveryMinutes: 1, maxSpawns: 1, cap: 1, pauseMinutes: 30 })
})

test('an unknown profile name falls back to the default and leaves a warning', () => {
  const cfg = parsePipeline({ enabled: true, profiles: { rescue: 'nope', review: 'reviewer' } }, KNOWN)
  expect(cfg?.profiles.rescue).toBe('debugger')
  expect(cfg?.warning).toMatch(/pipeline\.profiles\.rescue "nope" is not a profile; using debugger/)
})

test('a profile that is turned off is not known', () => {
  const { reviewer: _, ...without } = KNOWN
  const cfg = parsePipeline({ enabled: true, profiles: { review: 'reviewer' } }, without)
  expect(cfg?.warning).toMatch(/pipeline\.profiles\.review "reviewer" is not a profile/)
})
