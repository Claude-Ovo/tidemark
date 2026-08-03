// 写入卫生闸门（SPEC §5 + §12.6）：同步确定性检查，热路径零 LLM
// 返回 { admission: 'accepted'|'quarantined'|'rejected', reasons: [] }

const MAX_CONTENT_CHARS = 8000
const MIN_CONTENT_CHARS = 1

// 粗筛敏感模式：命中即 quarantined（不注入不 embedding，留审计短 TTL）
export const SENSITIVE_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'aws_access_key_id'],
  [/postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/, 'connection_string_with_credentials'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private_key_block'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'api_secret_key'],          // 容纳 sk-proj-XXX 等分段形态
  [/\b(?:password|passwd|secret)\s*[:=]\s*\S{6,}/i, 'inline_password_assignment'],
]

// 规范化 + 闸门：长度检查针对【原始】payload（防空白填充绕过）；
// 返回的 canonical 是唯一下游内容——HMAC/敏感筛/embedding/落库全部用它，杜绝"查一个存另一个"
export const runAdmissionGate = ({ content, kind, importance }) => {
  const reasons = []
  if (typeof content !== 'string') return { admission: 'rejected', reasons: ['content_not_string'], canonical: null }
  if (content.length > MAX_CONTENT_CHARS) return { admission: 'rejected', reasons: ['content_too_large_raw'], canonical: null }
  const canonical = content.trim()
  if (canonical.length < MIN_CONTENT_CHARS) return { admission: 'rejected', reasons: ['content_empty'], canonical: null }
  if (kind != null && (typeof kind !== 'string' || kind.length > 64)) return { admission: 'rejected', reasons: ['kind_invalid'], canonical: null }
  if (importance != null && (typeof importance !== 'number' || importance < 0 || importance > 1)) {
    return { admission: 'rejected', reasons: ['importance_out_of_range'], canonical: null }
  }
  for (const [pattern, label] of SENSITIVE_PATTERNS) {
    if (pattern.test(canonical)) reasons.push(`sensitive:${label}`)
  }
  if (reasons.length > 0) return { admission: 'quarantined', reasons, canonical }
  return { admission: 'accepted', reasons: [], canonical }
}

export const QUARANTINE_TTL_HOURS = 72
