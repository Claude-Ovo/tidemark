// CJK-aware token 估算（SPEC v1.2.2.1 §3，Codex 修正版）：中文按字计，不做除法低估
export const TOKEN_ESTIMATOR_VERSION = 'v1-cjk-aware'
const CJK = /[　-鿿豈-﫿＀-￯]/

export const estimateTokens = (text) => {
  let cjk = 0, other = 0
  for (const ch of text) { CJK.test(ch) ? cjk++ : other++ }
  return cjk + Math.ceil(other / 4)
}
export const ITEM_JSON_OVERHEAD = 24
