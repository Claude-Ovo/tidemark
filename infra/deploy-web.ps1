# Publishes the read-only visualization to a public demo URL (submission
# requirement: functional demo app URL). ASCII-only per project policy.
#
# Architecture (mirrors the dev vite proxy, see web/vite.config.ts):
#   CloudFront
#     - default behaviour  -> S3 bucket (static pool page + assets, OAC-signed)
#     - /viz/*             -> API Gateway origin, with an ORIGIN CUSTOM HEADER
#                             x-tidemark-auth = <viz key, scope='viz'>
# The browser therefore holds zero credentials, and the viz key can only reach
# the read-only face (toolPrincipal() nulls it out on the tool face).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File infra\deploy-web.ps1 `
#       -ApiUrl https://<api-id>.execute-api.us-east-1.amazonaws.com `
#       [-Bucket tidemark-demo-web] [-Region us-east-1] [-VizKey <key>]
#
# The viz key defaults to the value in the production secret (TIDEMARK_AGENT_KEYS
# entry whose scope is 'viz'); pass -VizKey to override.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [string]$Bucket = 'tidemark-demo-web',
  [string]$Region = 'us-east-1',
  [string]$SecretId = 'tidemark/prod',
  [string]$VizKey,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$webDir = Join-Path $repoRoot 'web'
$distDir = Join-Path $webDir 'dist'

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $Body
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "$Name failed (exit $LASTEXITCODE)" }
}

# 1. Build the static bundle (pool.html is a build input, guarded by check-dist).
if (-not $SkipBuild) {
  Invoke-Step 'build web bundle' {
    Push-Location $webDir
    try {
      node node_modules/vite/bin/vite.js build
      node check-dist.mjs
    } finally { Pop-Location }
  }
}
if (-not (Test-Path (Join-Path $distDir 'pool.html'))) { throw 'dist/pool.html missing - build did not run' }

# 2. Resolve the viz key from the production secret unless supplied.
if (-not $VizKey) {
  Invoke-Step 'resolve viz key from Secrets Manager' {
    # Resolution lives in Node (infra/add-viz-key.mjs --print-key, idempotent):
    # piping AWS CLI JSON through PowerShell adds a BOM that breaks JSON.parse.
    $resolved = node (Join-Path $PSScriptRoot 'add-viz-key.mjs') "--secret-id=$SecretId" "--region=$Region" --print-key --quiet
    if ($LASTEXITCODE -ne 0) { throw 'viz key resolution failed' }
    $script:VizKey = ($resolved | Select-Object -Last 1).Trim()
  }
}
if (-not $VizKey) { throw 'viz key unresolved' }
Write-Host "viz key resolved (scope=viz, read-only face)" -ForegroundColor DarkGray

# 3. Bucket: private, CloudFront-only (OAC). Create if absent.
Invoke-Step 'ensure S3 bucket' {
  # head-bucket writes to stderr when absent; PowerShell surfaces that as a
  # NativeCommandError even though "missing" is the expected create signal.
  try { aws s3api head-bucket --bucket $Bucket --region $Region 2>&1 | Out-Null } catch { $global:LASTEXITCODE = 1 }
  if ($LASTEXITCODE -ne 0) {
    if ($Region -eq 'us-east-1') { aws s3api create-bucket --bucket $Bucket --region $Region | Out-Null }
    else { aws s3api create-bucket --bucket $Bucket --region $Region --create-bucket-configuration "LocationConstraint=$Region" | Out-Null }
    aws s3api put-public-access-block --bucket $Bucket `
      --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' | Out-Null
  }
  $global:LASTEXITCODE = 0
}

# 4. Upload. Hashed assets get long cache; entry documents stay revalidated.
Invoke-Step 'sync static assets' {
  aws s3 sync "$distDir" "s3://$Bucket" --region $Region --delete `
    --exclude '*.html' --cache-control 'public,max-age=31536000,immutable'
  aws s3 sync "$distDir" "s3://$Bucket" --region $Region `
    --exclude '*' --include '*.html' --cache-control 'no-cache'
}

# 5. Report the live distribution (created once by the CloudFront wiring below).
$distribution = aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='tidemark-demo'].[Id,DomainName,Status]" --output text 2>$null
Write-Host ''
Write-Host 'Static bundle published to the private origin bucket.' -ForegroundColor Green
if ($distribution -and $distribution -ne 'None') {
  $parts = ($distribution -split "\s+")
  Write-Host "Distribution : $($parts[0])  status=$($parts[2])" -ForegroundColor Green
  Write-Host "Demo URL     : https://$($parts[1])/pool.html?renderer=3d" -ForegroundColor Green
  Write-Host "Invalidate after a redeploy:" -ForegroundColor Yellow
  Write-Host "  aws cloudfront create-invalidation --distribution-id $($parts[0]) --paths '/*'"
} else {
  Write-Host 'No tidemark-demo distribution yet. One-time wiring:' -ForegroundColor Yellow
  Write-Host "  default origin : s3://$Bucket via Origin Access Control (SigV4), root object pool.html"
  Write-Host "  /viz/* origin  : $ApiUrl with origin custom header x-tidemark-auth = <viz key>, CachingDisabled"
  Write-Host '  then add a bucket policy allowing cloudfront.amazonaws.com for that distribution ARN only'
}
