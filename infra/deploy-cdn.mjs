// Creates (or reuses) the CloudFront distribution that fronts the public demo:
//   default behaviour -> private S3 origin (OAC-signed static bundle)
//   /viz/*            -> API Gateway origin, with the viz key injected as an
//                        ORIGIN CUSTOM HEADER so the browser holds no credential
//
// Usage: node infra/deploy-cdn.mjs --api=https://<id>.execute-api.<region>.amazonaws.com
//        [--bucket=tidemark-demo-web] [--region=us-east-1] [--secret-id=tidemark/prod]
import {
  CloudFrontClient, CreateDistributionCommand, ListDistributionsCommand,
  CreateOriginAccessControlCommand, ListOriginAccessControlsCommand,
} from '@aws-sdk/client-cloudfront'
import { S3Client, PutBucketPolicyCommand } from '@aws-sdk/client-s3'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'

const arg = (name, dflt) => (process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]) ?? dflt
const API = arg('api')
const BUCKET = arg('bucket', 'tidemark-demo-web')
const REGION = arg('region', 'us-east-1')
const SECRET_ID = arg('secret-id', 'tidemark/prod')
const COMMENT = 'tidemark-demo'
if (!API) { console.error('--api=<api gateway url> required'); process.exit(1) }
const apiHost = new URL(API).host

const cf = new CloudFrontClient({ region: 'us-east-1' })
const s3 = new S3Client({ region: REGION })
const sm = new SecretsManagerClient({ region: REGION })
const sts = new STSClient({ region: REGION })

// 1. viz key (read-only scope) from the production secret
const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString)
const keys = JSON.parse(secret.TIDEMARK_AGENT_KEYS ?? '{}')
const vizEntry = Object.entries(keys).find(([, v]) => v && v.scope === 'viz')
if (!vizEntry) { console.error('no viz-scope key; run: node infra/add-viz-key.mjs'); process.exit(1) }
const vizKey = vizEntry[0]

// 2. reuse an existing distribution if this script already ran
const existing = (await cf.send(new ListDistributionsCommand({}))).DistributionList?.Items
  ?.find(d => d.Comment === COMMENT)
if (existing) {
  console.log(JSON.stringify({ ok: true, action: 'exists', id: existing.Id,
    domain: existing.DomainName, url: `https://${existing.DomainName}/pool.html`,
    status: existing.Status }))
  process.exit(0)
}

// 3. Origin Access Control so the bucket can stay fully private
const oacName = `${BUCKET}-oac`
const oacs = (await cf.send(new ListOriginAccessControlsCommand({}))).OriginAccessControlList?.Items ?? []
const oacId = oacs.find(o => o.Name === oacName)?.Id
  ?? (await cf.send(new CreateOriginAccessControlCommand({
    OriginAccessControlConfig: {
      Name: oacName, Description: 'tidemark demo static origin',
      SigningProtocol: 'sigv4', SigningBehavior: 'always', OriginAccessControlOriginType: 's3',
    },
  }))).OriginAccessControl.Id

const s3Origin = { Id: 's3-static', DomainName: `${BUCKET}.s3.${REGION}.amazonaws.com`,
  OriginAccessControlId: oacId, S3OriginConfig: { OriginAccessIdentity: '' } }
const apiOrigin = { Id: 'api-viz', DomainName: apiHost,
  CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only',
    OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] } },
  // The credential lives here, not in the browser bundle.
  CustomHeaders: { Quantity: 1, Items: [{ HeaderName: 'x-tidemark-auth', HeaderValue: vizKey }] } }

const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6'
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'
const created = await cf.send(new CreateDistributionCommand({
  DistributionConfig: {
    CallerReference: `tidemark-${Date.now()}`,
    Comment: COMMENT,
    Enabled: true,
    DefaultRootObject: 'pool.html',
    Origins: { Quantity: 2, Items: [s3Origin, apiOrigin] },
    DefaultCacheBehavior: {
      TargetOriginId: 's3-static', ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'],
        CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
      CachePolicyId: CACHING_OPTIMIZED, Compress: true,
    },
    CacheBehaviors: { Quantity: 1, Items: [{
      PathPattern: '/viz/*', TargetOriginId: 'api-viz', ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: { Quantity: 2, Items: ['GET', 'HEAD'],
        CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } },
      CachePolicyId: CACHING_DISABLED, Compress: true,
    }] },
  },
}))

const dist = created.Distribution
const account = (await sts.send(new GetCallerIdentityCommand({}))).Account
await s3.send(new PutBucketPolicyCommand({
  Bucket: BUCKET,
  Policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AllowCloudFrontServicePrincipalRead',
      Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject', Resource: `arn:aws:s3:::${BUCKET}/*`,
      Condition: { StringEquals: { 'AWS:SourceArn': `arn:aws:cloudfront::${account}:distribution/${dist.Id}` } },
    }],
  }),
}))

console.log(JSON.stringify({ ok: true, action: 'created', id: dist.Id, domain: dist.DomainName,
  url: `https://${dist.DomainName}/pool.html`, status: dist.Status,
  note: 'propagation takes ~5-15 minutes; bucket policy now allows this distribution only' }))
