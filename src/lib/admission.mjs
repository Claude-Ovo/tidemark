// 写入卫生闸门（SPEC §5 + §12.6）：同步确定性检查，热路径零 LLM
// 返回 { admission: 'accepted'|'quarantined'|'rejected', reasons: [] }

const MAX_CONTENT_CHARS = 8000
const MIN_CONTENT_CHARS = 1

// 粗筛敏感模式：命中即 quarantined（不注入不 embedding，留审计短 TTL）
const SENSITIVE_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'aws_access_key_id'],
  [/postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/, 'connection_string_with_credentials'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private_key_block'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'api_secret_key'],
  [/\b(?:password|passwd|secret)\s*[:=]\s*\S{6,}/i, 'inline_password_assignment'],
]

export const runAdmissionGate = ({ content, kind, importance }) => {
  const reasons = []
  if (typeof content !== 'string') return { admission: 'rejected', reasons: ['content_not_string'] }
  const trimmed = content.trim()
  if (trimmed.length < MIN_CONTENT_CHARS) return { admission: 'rejected', reasons: ['content_empty'] }
  if (trimmed.length > MAX_CONTENT_CHARS) return { admission: 'rejected', reasons: ['content_too_large'] }
  if (kind != null && (typeof kind !== 'string' || kind.length > 64)) return { admission: 'rejected', reasons: ['kind_invalid'] }
  if (importance != null && (typeof importance !== 'number' || importance < 0 || importance > 1)) {
    return { admission: 'rejected', reasons: ['importance_out_of_range'] }
  }
  for (const [pattern, label] of SENSITIVE_PATTERNS) {
    if (pattern.test(trimmed)) reasons.push(`sensitive:${label}`)
  }
  if (reasons.length > 0) return { admission: 'quarantined', reasons }
  return { admission: 'accepted', reasons: [] }
}

export const QUARANTINE_TTL_HOURS = 72
