import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Vercel uses the release gate and bundles the server-side IPF reference', async () => {
  const configUrl = new URL('../vercel.json', import.meta.url)
  const config = JSON.parse(await readFile(configUrl, 'utf8'))
  const apiFunction = config.functions?.['api/**']
  const headerValues = Object.fromEntries((config.headers?.[0]?.headers || []).map((header) => [header.key, header.value]))
  const apiRoutes = [
    '../api/access/status.js',
    '../api/access/login.js',
    '../api/access/logout.js',
    '../api/health.js',
    '../api/intake-extract.js',
    '../api/research-run.js',
  ]
  const routeContents = await Promise.all(apiRoutes.map((route) => readFile(new URL(route, import.meta.url), 'utf8')))

  assert.equal(config.buildCommand, 'npm run build')
  assert.equal(apiFunction?.maxDuration, 360)
  assert.equal(apiFunction?.includeFiles, 'ipf-reference.json')
  assert.match(headerValues['Content-Security-Policy'] || '', /frame-ancestors 'none'/)
  assert.match(headerValues['Content-Security-Policy'] || '', /connect-src 'self'/)
  assert.equal(headerValues['X-Frame-Options'], 'DENY')
  assert.equal(headerValues['X-Content-Type-Options'], 'nosniff')
  assert.match(headerValues['Permissions-Policy'] || '', /camera=\(\)/)
  assert.equal(headerValues['X-Robots-Tag'], 'noindex, nofollow')
  assert.ok(routeContents.every((route) => /createVercelApiHandler/.test(route)))
})
