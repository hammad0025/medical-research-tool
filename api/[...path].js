import { createVercelApiHandler } from '../server/vercelApi.mjs'

const handler = createVercelApiHandler(process.env)

export default handler
