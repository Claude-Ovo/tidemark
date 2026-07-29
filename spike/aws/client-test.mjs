// spike 验收：官方 SDK 客户端对 AWS 端点做真实 MCP 会话
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.argv[2]
const client = new Client({ name: 'tidemark-spike-client', version: '0.0.1' })
const t0 = Date.now()
await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp')))
console.log(`initialize OK (${Date.now() - t0}ms)`)
const tools = await client.listTools()
console.log('tools:', tools.tools.map(t => t.name).join(','))
const r = await client.callTool({ name: 'ping', arguments: { msg: 'tidemark rising' } })
console.log('ping ->', r.content[0].text)
await client.close()
