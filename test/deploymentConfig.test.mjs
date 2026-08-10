import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Vercel uses the release gate and bundles the server-side IPF reference', async () => {
  const configUrl = new URL('../vercel.json', import.meta.url)
  const apiRouteUrl = new URL('../api/[...path].js', import.meta.url)
  const config = JSON.parse(await readFile(configUrl, 'utf8'))
  const apiRoute = await readFile(apiRouteUrl, 'utf8')
  const apiFunction = config.functions?.['api/**']

  assert.equal(config.buildCommand, 'npm run build')
  assert.equal(apiFunction?.maxDuration, 300)
  assert.equal(apiFunction?.includeFiles, 'ipf-reference.json')
  assert.match(apiRoute, /createVercelApiHandler/)
})
