// P0-09：生成 tidemark/prod secret 的 JSON 到 stdout（只在 deploy.ps1 首建/轮换时调用）。
// 凭据从不进 argv：DB URL 从 --env-file 环境读入，其余键即席随机生成。
// agent key 拓扑镜像 dev 表（三 agent、pin 能力位对照），使线上 smoke 能复验双门授权语义。
import { randomBytes } from 'node:crypto'

const dburl = process.env.COCKROACH_DATABASE_URL
if (!dburl) throw new Error('COCKROACH_DATABASE_URL missing (run via node --env-file=.env)')
const key = (n) => randomBytes(n).toString('base64url')

const agentKeys = {
  [`tk_demo_${key(24)}`]:   { tenant_id: 'demo-tenant', agent_id: 'demo-agent', capabilities: ['memory:pin'] },
  [`tk_second_${key(24)}`]: { tenant_id: 'demo-tenant', agent_id: 'second-agent', capabilities: [] },
  [`tk_third_${key(24)}`]:  { tenant_id: 'demo-tenant', agent_id: 'third-agent', capabilities: ['memory:pin'] },
}

process.stdout.write(JSON.stringify({
  COCKROACH_DATABASE_URL: dburl,
  TIDEMARK_HMAC_KEY: key(32),
  TIDEMARK_ADMIN_KEY: `tkadm_${key(24)}`,
  TIDEMARK_AGENT_KEYS: JSON.stringify(agentKeys),
}))
