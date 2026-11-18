import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployRefusal, recordDeployResult, resetDeployTries } from '../../src/main/deploy/deployTries'

const fail = { ok: false, failedStep: 'Build, upload and restart WebNotes on the Alpine box' }

test('a failing Deploy gets one more try after a fix, then is not run a third time in the request (WebNotes ran it 9 times)', () => {
  resetDeployTries('webnotes')
  assert.equal(deployRefusal('webnotes'), null)
  assert.match(recordDeployResult('webnotes', fail), /one more try/)
  assert.equal(deployRefusal('webnotes'), null, 'second try allowed')
  assert.match(recordDeployResult('webnotes', fail), /won't run it again/)
  const refusal = deployRefusal('webnotes')
  assert.match(refusal ?? '', /failed 2 times in a row.*Build, upload and restart/)
  assert.match(refusal ?? '', /ask how they want to go on/)
  assert.ok(deployRefusal('other-project') === null, 'per project')
})

test("the user's next message starts over, and so does a deploy that works", () => {
  resetDeployTries('p')
  recordDeployResult('p', fail)
  recordDeployResult('p', fail)
  assert.ok(deployRefusal('p'))
  resetDeployTries('p')
  assert.equal(deployRefusal('p'), null)
  recordDeployResult('p', fail)
  assert.equal(recordDeployResult('p', { ok: true }), '')
  recordDeployResult('p', fail)
  assert.equal(deployRefusal('p'), null, 'a success in between: counting starts again')
})

test('a deploy the user stopped is not run again in the request', () => {
  resetDeployTries('s')
  assert.match(recordDeployResult('s', { ok: false, stopped: true }), /unless the user asks/)
  assert.ok(deployRefusal('s'))
})
