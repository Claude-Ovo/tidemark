# Tidemark P0-09 production deploy (idempotent create-or-update).
# Prereqs: aws cli configured (region us-east-1); repo-root .env with COCKROACH_DATABASE_URL.
# Creates/updates: Secrets Manager secret, IAM role, two Lambda functions (mcp + nightly),
# API Gateway HTTP API ($default -> mcp fn), EventBridge nightly rule (cron 19:00 UTC = 03:00 CST).
# Credentials NEVER enter argv or function config: secret JSON goes through a BOM-less temp
# file (deleted in finally); functions only receive the secret ARN.
# NOTE: ASCII-only comments (PS5.1 reads BOM-less scripts as ANSI). Existence probes do NOT
# redirect stderr: under ErrorActionPreference=Stop, redirected native stderr becomes
# terminating NativeCommandError in PS5.1. Expect aws NotFound noise on first run; harmless.
param([switch]$RotateSecrets, [switch]$SkipMigrate, [switch]$SkipPackage)
$ErrorActionPreference = "Stop"
$aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
$region = "us-east-1"
$secretName = "tidemark/prod"
$roleName = "tidemark-prod-role"
$mcpFn = "tidemark-mcp"
$nightlyFn = "tidemark-nightly"
$apiName = "tidemark-api"
$ruleName = "tidemark-nightly"
$prodDb = "tidemark_prod"

function Assert-NativeSuccess([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "step failed: $step (exit $LASTEXITCODE)" }
}
function Write-NoBom([string]$path, [string]$content) {
  [IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding($false)))
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo
$envFile = Join-Path $repo '.env'
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

# ---- 1. secret upsert (create once; values preserved on redeploy unless -RotateSecrets) ----
& $aws secretsmanager describe-secret --secret-id $secretName --query ARN --output text | Out-Null
$secretExists = ($LASTEXITCODE -eq 0)
if (-not $secretExists -or $RotateSecrets) {
  $secretJson = node --env-file=$envFile infra/gen-secret.mjs
  Assert-NativeSuccess "gen-secret"
  if ([string]::IsNullOrWhiteSpace($secretJson)) { throw "gen-secret produced empty output" }
  $secretFile = Join-Path $PSScriptRoot '.secret-payload.json'
  try {
    Write-NoBom $secretFile $secretJson
    $fileArg = "file://" + ($secretFile -replace '\\','/')
    if ($secretExists) {
      & $aws secretsmanager put-secret-value --secret-id $secretName --secret-string $fileArg --query VersionId --output text | Out-Null
      Assert-NativeSuccess "put-secret-value"
      Write-Host "secret rotated: $secretName"
    } else {
      & $aws secretsmanager create-secret --name $secretName --description "Tidemark prod credentials (DB URL, HMAC, admin key, agent keys)" --secret-string $fileArg --query ARN --output text | Out-Null
      Assert-NativeSuccess "create-secret"
      Write-Host "secret created: $secretName"
    }
  } finally { Remove-Item $secretFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
} else { Write-Host "secret exists, values preserved (use -RotateSecrets to regenerate)" }
$secretArn = & $aws secretsmanager describe-secret --secret-id $secretName --query ARN --output text
Assert-NativeSuccess "describe-secret"

# ---- 2. IAM role (create once) ----
& $aws iam get-role --role-name $roleName --query Role.Arn --output text | Out-Null
$roleExists = ($LASTEXITCODE -eq 0)
if (-not $roleExists) {
  $trust = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  $trustFile = Join-Path $PSScriptRoot '.trust.json'
  try {
    Write-NoBom $trustFile $trust
    & $aws iam create-role --role-name $roleName --assume-role-policy-document ("file://" + ($trustFile -replace '\\','/')) --query Role.Arn --output text | Out-Null
    Assert-NativeSuccess "create-role"
  } finally { Remove-Item $trustFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
  & $aws iam attach-role-policy --role-name $roleName --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  Assert-NativeSuccess "attach basic execution policy"
  Write-Host "role created: $roleName (waiting 10s for IAM propagation)"
  Start-Sleep -Seconds 10
}
# Inline policy is upserted every run so secret ARN changes and the bedrock grant stay current.
# bedrock:InvokeModel is scoped to the Titan embed model; harmless while EMBED_PROVIDER=stub.
$policy = @"
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"$secretArn"},
 {"Effect":"Allow","Action":"bedrock:InvokeModel","Resource":"arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0"}]}
"@
$policyFile = Join-Path $PSScriptRoot '.inline-policy.json'
try {
  Write-NoBom $policyFile $policy
  & $aws iam put-role-policy --role-name $roleName --policy-name tidemark-secrets-bedrock --policy-document ("file://" + ($policyFile -replace '\\','/'))
  Assert-NativeSuccess "put-role-policy"
} finally { Remove-Item $policyFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
$roleArn = & $aws iam get-role --role-name $roleName --query Role.Arn --output text
Assert-NativeSuccess "get-role"

# ---- 3. migrate prod database (empty-db one-shot per P0-02 acceptance) ----
if (-not $SkipMigrate) {
  node --env-file=$envFile migrations/apply.mjs --database $prodDb --create-database
  Assert-NativeSuccess "migrate $prodDb"
  node --env-file=$envFile migrations/verify.mjs --database $prodDb
  Assert-NativeSuccess "verify $prodDb"
}

# ---- 4. package (tar.exe makes zip via -a and supports excludes; Compress-Archive does not) ----
$zip = Join-Path $repo 'tidemark.zip'
if (-not $SkipPackage) {
  if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }
  # System32 bsdtar explicitly: Git's GNU tar (if first in PATH) cannot produce zip archives.
  & "$env:SystemRoot\System32\tar.exe" -a -c -f $zip --exclude "src/*.log" --exclude "src/*.err" --exclude "src/test-*.mjs" src migrations package.json node_modules
  Assert-NativeSuccess "package zip"
  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "packaged tidemark.zip ($mb MB)"
}

# ---- 5. Lambda functions (create-or-update) ----
function Deploy-Function([string]$name, [string]$handler, [int]$timeout, [hashtable]$envVars) {
  & $aws lambda get-function --function-name $name --query Configuration.FunctionArn --output text | Out-Null
  $exists = ($LASTEXITCODE -eq 0)
  $cfgFile = Join-Path $PSScriptRoot ".fn-cfg.json"
  $cfg = @{ FunctionName = $name; Handler = $handler; Timeout = $timeout; MemorySize = 512; Environment = @{ Variables = $envVars } }
  if (-not $exists) { $cfg.Runtime = "nodejs22.x"; $cfg.Role = $roleArn }
  try {
    Write-NoBom $cfgFile ($cfg | ConvertTo-Json -Depth 5)
    $fileArg = "file://" + ($cfgFile -replace '\\','/')
    if ($exists) {
      & $aws lambda update-function-configuration --cli-input-json $fileArg --query LastUpdateStatus --output text | Out-Null
      Assert-NativeSuccess "update-function-configuration $name"
      & $aws lambda wait function-updated-v2 --function-name $name
      Assert-NativeSuccess "wait config $name"
      & $aws lambda update-function-code --function-name $name --zip-file fileb://tidemark.zip --query LastUpdateStatus --output text | Out-Null
      Assert-NativeSuccess "update-function-code $name"
    } else {
      & $aws lambda create-function --cli-input-json $fileArg --zip-file fileb://tidemark.zip --query FunctionArn --output text | Out-Null
      Assert-NativeSuccess "create-function $name"
    }
  } finally { Remove-Item $cfgFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
  & $aws lambda wait function-active-v2 --function-name $name
  Assert-NativeSuccess "wait active $name"
  & $aws lambda wait function-updated-v2 --function-name $name
  Assert-NativeSuccess "wait updated $name"
  Write-Host "function ready: $name"
}

$mcpEnv = @{ TIDEMARK_SECRET_ARN = $secretArn; TIDEMARK_DATABASE = $prodDb; TIDEMARK_POOL_MAX = "1"; EMBED_PROVIDER = "stub" }
$nightlyEnv = $mcpEnv.Clone()
$nightlyEnv.TIDEMARK_NIGHTLY_TENANTS = "demo-tenant"
Deploy-Function $mcpFn "src/aws/mcp-handler.handler" 30 $mcpEnv
Deploy-Function $nightlyFn "src/aws/nightly-handler.handler" 600 $nightlyEnv

$mcpArn = & $aws lambda get-function --function-name $mcpFn --query Configuration.FunctionArn --output text
Assert-NativeSuccess "get mcp arn"
$nightlyArn = & $aws lambda get-function --function-name $nightlyFn --query Configuration.FunctionArn --output text
Assert-NativeSuccess "get nightly arn"

# ---- 6. API Gateway HTTP API (quick-create: default route + auto-deploy stage) ----
$apiId = & $aws apigatewayv2 get-apis --query "Items[?Name=='$apiName'].ApiId | [0]" --output text
Assert-NativeSuccess "get-apis"
if ($apiId -eq "None" -or [string]::IsNullOrWhiteSpace($apiId)) {
  $apiId = & $aws apigatewayv2 create-api --name $apiName --protocol-type HTTP --target $mcpArn --query ApiId --output text
  Assert-NativeSuccess "create-api"
  Write-Host "api created: $apiId"
}
# add-permission is tolerated-if-exists: a rerun hits ResourceConflictException, which is fine.
$acct = & $aws sts get-caller-identity --query Account --output text
Assert-NativeSuccess "get account"
& $aws lambda add-permission --function-name $mcpFn --statement-id tidemark-apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${region}:${acct}:${apiId}/*" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "apigw permission already present" }
$apiUrl = & $aws apigatewayv2 get-api --api-id $apiId --query ApiEndpoint --output text
Assert-NativeSuccess "get api endpoint"

# ---- 7. EventBridge nightly rule (03:00 Beijing = 19:00 UTC) ----
& $aws events put-rule --name $ruleName --schedule-expression "cron(0 19 * * ? *)" --state ENABLED --query RuleArn --output text | Out-Null
Assert-NativeSuccess "put-rule"
$targetsFile = Join-Path $PSScriptRoot '.targets.json'
try {
  Write-NoBom $targetsFile (@{ Rule = $ruleName; Targets = @(@{ Id = "nightly"; Arn = $nightlyArn }) } | ConvertTo-Json -Depth 4)
  & $aws events put-targets --cli-input-json ("file://" + ($targetsFile -replace '\\','/')) --query FailedEntryCount --output text | Out-Null
  Assert-NativeSuccess "put-targets"
} finally { Remove-Item $targetsFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
$ruleArn = & $aws events describe-rule --name $ruleName --query Arn --output text
Assert-NativeSuccess "describe-rule"
& $aws lambda add-permission --function-name $nightlyFn --statement-id tidemark-events --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn $ruleArn | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "events permission already present" }

Write-Host ""
Write-Host "=== deploy complete ==="
Write-Host "api url:     $apiUrl"
Write-Host "secret arn:  $secretArn"
Write-Host "functions:   $mcpFn (30s), $nightlyFn (600s, cron 19:00 UTC)"
Write-Host "database:    $prodDb"
Write-Host "next:        node --env-file=.env infra/smoke.mjs $apiUrl"
