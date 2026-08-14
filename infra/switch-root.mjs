// Cutover: point the public distribution's root at the Evidence console and
// open POST on /viz/* (the judge proof is a POST /viz/judge-run; the original
// behaviour only allowed GET/HEAD, which would 405 the button in production).
// Idempotent: safe to rerun; prints the resulting config either way.
// Usage: node infra/switch-root.mjs [--root=evidence.html]
import {
  CloudFrontClient, ListDistributionsCommand,
  GetDistributionConfigCommand, UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront'

const REGION = 'us-east-1'
const COMMENT = 'tidemark-demo'
const root = (process.argv.find((a) => a.startsWith('--root=')) ?? '--root=evidence.html').slice(7)

const cf = new CloudFrontClient({ region: REGION })
const list = await cf.send(new ListDistributionsCommand({}))
const summary = (list.DistributionList?.Items ?? []).find((d) => d.Comment === COMMENT)
if (!summary) { console.error(`no distribution with comment ${COMMENT}`); process.exit(1) }

const { DistributionConfig: config, ETag } = await cf.send(
  new GetDistributionConfigCommand({ Id: summary.Id }))

const before = {
  root: config.DefaultRootObject,
  vizMethods: config.CacheBehaviors?.Items?.[0]?.AllowedMethods?.Quantity ?? 0,
}

config.DefaultRootObject = root
const viz = (config.CacheBehaviors?.Items ?? []).find((b) => b.PathPattern === '/viz/*')
if (!viz) { console.error('no /viz/* behaviour found'); process.exit(1) }
// CloudFront method sets are fixed: 2, 3, or all 7. The judge run needs POST.
viz.AllowedMethods = {
  Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
  CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
}

await cf.send(new UpdateDistributionCommand({
  Id: summary.Id, IfMatch: ETag, DistributionConfig: config,
}))
console.log(JSON.stringify({
  id: summary.Id, domain: summary.DomainName,
  before, after: { root, vizMethods: 7 },
}, null, 2))
