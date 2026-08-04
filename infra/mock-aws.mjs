// mocked AWS CLI（round-4 红门用）：行为由 TIDEMARK_MOCK_STATE 指向的 JSON 驱动，
// s3 对象落在 TIDEMARK_MOCK_S3DIR 本地目录。只实现 cutover-lib 触到的子命令。
// state 形状：{ concurrency: {fn: 0|null}, rule: 'ENABLED'|'DISABLED'|null,
//   fail: {"lambda delete-function-concurrency": true, ...},
//   lie_on_delete_concurrency: true   // 关键红门：delete 返回 0 但状态不变 }
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const statePath = process.env.TIDEMARK_MOCK_STATE
const s3dir = process.env.TIDEMARK_MOCK_S3DIR
const st = JSON.parse(readFileSync(statePath, 'utf8'))
const save = () => writeFileSync(statePath, JSON.stringify(st))
const args = process.argv.slice(2)
const cmd = args.slice(0, 2).join(' ')
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const fail = (code = 254, msg = 'mock failure') => { console.error(`mock: ${msg} (${cmd})`); process.exit(code) }

if (st.fail?.[cmd]) fail(254, 'scripted failure')
if (st.fail_after?.[cmd] !== undefined) {
  st.fail_after[cmd] -= 1; save()
  if (st.fail_after[cmd] < 0) fail(254, 'scripted failure (after N successes)')
}

const localOf = (s3uri) => join(s3dir, s3uri.replace(/^s3:\/\/[^/]+\//, '').replace(/\//g, '_'))

switch (cmd) {
  case 'lambda put-function-concurrency': {
    st.concurrency[argOf('--function-name')] = 0; save(); console.log('0'); break
  }
  case 'lambda get-function-concurrency': {
    const v = st.concurrency[argOf('--function-name')]
    if (v === 0) console.log('0')
    else console.log('None')      // aws --output text prints None for absent value
    break
  }
  case 'lambda delete-function-concurrency': {
    if (!st.lie_on_delete_concurrency) { st.concurrency[argOf('--function-name')] = null; save() }
    break                          // exit 0 either way -- the LIE the read-back must catch
  }
  case 'lambda update-function-code': { st.code = argOf('--s3-key'); save(); console.log('InProgress'); break }
  case 'lambda wait': break
  case 'lambda get-function': { console.log('arn:mock:' + argOf('--function-name')); break }
  case 'events enable-rule': { if (st.rule === null) fail(254, 'rule not found'); st.rule = st.stick_rule ?? 'ENABLED'; save(); break }
  case 'events disable-rule': { if (st.rule === null) fail(254, 'rule not found'); st.rule = st.stick_rule ?? 'DISABLED'; save(); break }
  case 'events describe-rule': { if (st.rule === null) fail(254, 'rule not found'); console.log(st.rule); break }
  case 'sts get-caller-identity': { console.log('123456789012'); break }
  case 's3api list-objects-v2': {
    const prefix = argOf('--prefix') ?? ''
    console.log(existsSync(localOf('s3://b/' + prefix)) ? '1' : '0')
    break
  }
  case 'events list-rules': { console.log(st.rule === null ? '0' : '1'); break }
  case 's3api head-object': { existsSync(localOf('s3://b/' + argOf('--key'))) ? console.log('{}') : fail(254, 'not found'); break }
  case 's3 cp': {
    const [src, dst] = [args[2], args[3]]
    const from = src.startsWith('s3://') ? localOf(src) : src
    const to = dst.startsWith('s3://') ? localOf(dst) : dst
    if (!existsSync(from)) fail(1, `source missing ${from}`)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    break
  }
  default: fail(252, 'unmocked command')
}
