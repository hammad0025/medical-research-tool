import { createResearchApiHandlers } from './researchApi.mjs'

const sendNotFound = (response) => {
  response.statusCode = 404
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify({ error: 'API route not found.' }))
}

const routePathFor = (request) => new URL(String(request.url || '/'), 'http://local.invalid').pathname

export const createVercelApiHandler = (env = {}) => {
  const handlers = createResearchApiHandlers(env)

  return async (request, response) => {
    const requestPath = routePathFor(request)
    const handler = handlers.get(requestPath) || handlers.get(`/api${requestPath}`)
    if (!handler) return sendNotFound(response)
    return handler(request, response)
  }
}
