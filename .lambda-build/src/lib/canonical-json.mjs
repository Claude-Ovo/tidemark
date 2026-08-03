// canonical JSON 序列化：递归键排序——JSONB roundtrip 会重排对象键序，
// checksum 两侧（写入前 / 读回后）必须用同一确定性序列化
export const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(v).sort().map(k => v[k] === undefined ? null : JSON.stringify(k) + ':' + canonicalJson(v[k])).filter(Boolean).join(',') + '}'
}
