# Tidemark spike deploy (reproduces the stub-green state)
# Prereqs: aws cli configured; repo-root .env with COCKROACH_DATABASE_URL
# Infra facts: nodejs22.x, 512MB, timeout 30s, API Gateway HTTP API payload v2 ($default -> Lambda)
# First-time infra creation (role/function/api) is documented in SPIKE-MCP.md, not automated here.
# NOTE: ASCII-only comments. PS5.1 reads BOM-less scripts as ANSI; non-ASCII bytes corrupt the parser.
param([switch]$ResetSpikeTable)
$ErrorActionPreference = "Stop"
$aws = "C:\Program Files\Amazon\AWSCLIv2\aws.exe"
$fn = "tidemark-spike"

# PS5.1 does NOT turn native non-zero exits into terminating errors; assert after EVERY native step.
function Assert-NativeSuccess([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "step failed: $step (exit $LASTEXITCODE)" }
}

Set-Location $PSScriptRoot
$envFile = (Resolve-Path (Join-Path $PSScriptRoot '..\..\.env')).Path
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

# Extract credential BEFORE any npm.cmd call: after npm runs, PS5.1 native stdout capture misbehaves.
# Read via node --env-file (same parser as runtime).
$dburl = node --env-file=$envFile -e "process.stdout.write(process.env.COCKROACH_DATABASE_URL||'')"
Assert-NativeSuccess "env extraction"
if ([string]::IsNullOrWhiteSpace($dburl)) { throw "COCKROACH_DATABASE_URL empty at script start" }

npm ci --omit=dev | Out-Null
Assert-NativeSuccess "npm ci"
if ($ResetSpikeTable) { node --env-file=$envFile migrate.mjs --reset } else { node --env-file=$envFile migrate.mjs }
Assert-NativeSuccess "migrate (schema mismatch? try -ResetSpikeTable)"
Compress-Archive -Path handler.mjs,vector-canonical.mjs,package.json,node_modules -DestinationPath spike.zip -Force

# Credential never enters argv: env config goes through a BOM-less JSON file, deleted afterwards.
# TODO(P0-09): switch to Secrets Manager ARN so function config no longer holds plaintext.
$cfg = @{ FunctionName = $fn; Environment = @{ Variables = @{ COCKROACH_DATABASE_URL = $dburl; EMBED_PROVIDER = "stub" } } } | ConvertTo-Json -Depth 5
$cfgFile = Join-Path $PSScriptRoot '.lambda-env.json'
try {
  [IO.File]::WriteAllText($cfgFile, $cfg, (New-Object Text.UTF8Encoding($false)))
  & $aws lambda update-function-configuration --cli-input-json ("file://" + ($cfgFile -replace '\\','/')) --query LastUpdateStatus --output text
  Assert-NativeSuccess "update-function-configuration"
} finally { Remove-Item $cfgFile -Force -Confirm:$false -ErrorAction SilentlyContinue }

& $aws lambda wait function-updated-v2 --function-name $fn
Assert-NativeSuccess "wait after configuration"
& $aws lambda update-function-code --function-name $fn --zip-file fileb://spike.zip --query LastUpdateStatus --output text
Assert-NativeSuccess "update-function-code"
& $aws lambda wait function-updated-v2 --function-name $fn
Assert-NativeSuccess "wait after code update"
# Downstream connection bound: this NEW account has total Lambda concurrency limit = 10 and
# reserving any slice would drop unreserved below the minimum (10), so per-function reserved
# concurrency is NOT configurable here. The effective bound is account-level:
#   account_concurrency(10) x pool.max(1) = at most 10 business conns (+admin/migration).
# Revisit reserved concurrency after an account limit increase (tracked in SPIKE-MCP.md).
Write-Host "deployed (EMBED_PROVIDER=stub). Conn bound = account concurrency 10 x pool 1. Switch to bedrock after allowlisting."
