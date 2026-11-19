import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskDeep, maskText } from '../../src/main/secrets/maskSecrets'

const secrets = [
  { name: 'HYPERV_PASSWORD', value: 'Dragon-test-99!' },
  { name: 'API_KEY', value: 'sk-live-abcdef123456' },
  { name: 'SHORT', value: 'abc12' }
]

test('secret values in text become [secret NAME]; short values are left alone', () => {
  assert.equal(maskText('HYPERV_PASSWORD=Dragon-test-99!\nHYPERV_USER=admin', secrets), 'HYPERV_PASSWORD=[secret HYPERV_PASSWORD]\nHYPERV_USER=admin')
  assert.equal(maskText('key sk-live-abcdef123456 twice sk-live-abcdef123456', secrets), 'key [secret API_KEY] twice [secret API_KEY]')
  assert.equal(maskText('abc12 is too short to hide', secrets), 'abc12 is too short to hide', 'short values would match ordinary text')
  assert.equal(maskText('nothing here', []), 'nothing here')
})

test('a secret inside another is replaced whole, and escaped values in JSON text are caught', () => {
  const nested = [
    { name: 'TOKEN', value: 'tok-12345678' },
    { name: 'TOKEN_FULL', value: 'Bearer tok-12345678-extra' }
  ]
  assert.equal(maskText('Authorization: Bearer tok-12345678-extra', nested), 'Authorization: [secret TOKEN_FULL]')
  const quoted = [{ name: 'PASS', value: 'pa"ss\\word99' }]
  // A tool's raw output that is itself JSON text: the value appears escaped.
  assert.equal(maskText(JSON.stringify({ out: 'pa"ss\\word99' }), quoted), '{"out":"[secret PASS]"}')
})

test('events are masked deep; one with nothing to mask comes back as it was', () => {
  const event = { type: 'delegation_activity', activity: { id: 'local-42', step: 'run', text: 'env | grep HYPERV', detail: 'HYPERV_PASSWORD=Dragon-test-99!', ok: true } }
  const masked = maskDeep(event, secrets)
  assert.notEqual(masked, event)
  assert.equal(masked.activity.detail, 'HYPERV_PASSWORD=[secret HYPERV_PASSWORD]')
  assert.equal(masked.activity.id, 'local-42')
  assert.equal(event.activity.detail, 'HYPERV_PASSWORD=Dragon-test-99!', 'the original is untouched')
  const plain = { type: 'tool_result', ok: true, summary: 'OK', raw: { list: ['a', 'b'], n: 3 } }
  assert.equal(maskDeep(plain, secrets), plain, 'no copy when there is nothing to hide')
  assert.equal(maskDeep(null, secrets), null)
})

test("a project's secrets are masked in what it shows, and a deleted one no longer is", async () => {
  const { setSecret, deleteSecret, maskProjectSecrets } = await import('../../src/main/secrets/vault')
  const id = 'mask-secrets-project'
  setSecret(id, 'HYPERV_PASSWORD', 'Dragon-vault-42!')
  const event = { type: 'tool_result', ok: true, summary: 'HYPERV_PASSWORD=Dragon-vault-42!' }
  assert.equal(maskProjectSecrets(id, event).summary, 'HYPERV_PASSWORD=[secret HYPERV_PASSWORD]')
  assert.equal(maskProjectSecrets('another-project', event), event, "only the project's own secrets")
  deleteSecret(id, 'HYPERV_PASSWORD')
  assert.equal(maskProjectSecrets(id, event), event, 'the cached values go when a secret changes')
})
