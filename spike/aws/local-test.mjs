// 本地对照：同一套 server 代码不经 serverless-http，直接 express 监听
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const app = express()
app.use(express.json())
app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'local', version: '0.0.1' })
  server.tool('ping', 'echo', { msg: z.string() }, async ({ msg }) => ({ content: [{ type: 'text', text: `pong ${msg}` }] }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})
app.listen(3999, () => console.log('local up'))
