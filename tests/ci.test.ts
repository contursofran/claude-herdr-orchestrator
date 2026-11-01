import { expect, test } from 'claude-code/testing'
import { ciOf } from '../hooks/ci'

// The check roll-up (ci.ts).

const done = (conclusion: string) => ({ __typename: 'CheckRun', status: 'COMPLETED', conclusion })

test('ciOf rolls the checks up to one word', () => {
  expect(ciOf([])).toBe('none')
  expect(ciOf([done('SUCCESS'), done('FAILURE')])).toBe('fail')
  expect(ciOf([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('fail')
  expect(ciOf([done('SUCCESS'), { __typename: 'CheckRun', status: 'IN_PROGRESS' }])).toBe('pending')
  expect(ciOf([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending')
  expect(ciOf([done('SUCCESS'), { __typename: 'StatusContext', state: 'SUCCESS' }])).toBe('pass')
})
