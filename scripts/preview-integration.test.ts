import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('preview includes the stable storage and update baseline', async () => {
  const storage = await import('../src/utils/electronStorage.ts').catch(() => ({}))

  assert.equal(typeof storage.collectAppStorage, 'function')
  assert.equal(typeof storage.queueElectronStorageSync, 'function')

  const update = JSON.parse(
    await readFile(new URL('../public/update.json', import.meta.url), 'utf8'),
  )
  assert.equal(update.version, '0.2.8')
})
