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
# Tolerate add-permission failure ONLY when a matching statement verifiably exists (round-2 P1-4:
# blanket "already present" swallowed AccessDenied and bad-parameter failures).
function Grant-InvokePermission([string]$fn, [string]$sid, [string]$principal, [string]$sourceArn) {
  & $aws lambda add-permission --function-name $fn --statement-id $sid --action lambda:InvokeFunction --principal $principal --source-arn $sourceArn | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "permission granted: $fn/$sid"; return }
  $policyText = & $aws lambda get-policy --function-name $fn --query Policy --output text
  Assert-NativeSuccess "get-policy $fn (add-permission failed and the policy is unreadable)"
  $pol = $policyText | ConvertFrom-Json
  $match = $pol.Statement | Where-Object { $_.Sid -eq $sid -and $_.Principal.Service -eq $principal -and $_.Condition.ArnLike.'AWS:SourceArn' -eq $sourceArn }
  if (-not $match) { throw "add-permission $fn/$sid failed and no matching statement exists (drift or AccessDenied)" }
  Write-Host "permission already present, verified by Sid/principal/sourceArn: $fn/$sid"
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
# ---- 2b. nightly failure DLQ (round-2 P0-3): created before the inline policy needs its ARN ----
$dlqName = "tidemark-nightly-dlq"
$dlqUrl = & $aws sqs get-queue-url --queue-name $dlqName --query QueueUrl --output text
if ($LASTEXITCODE -ne 0) {
  $dlqUrl = & $aws sqs create-queue --queue-name $dlqName --query QueueUrl --output text
  Assert-NativeSuccess "create dlq"
  Write-Host "dlq created: $dlqName"
}
$dlqArn = & $aws sqs get-queue-attributes --queue-url $dlqUrl --attribute-names QueueArn --query Attributes.QueueArn --output text
Assert-NativeSuccess "get dlq arn"

# Inline policy is upserted every run so secret ARN changes and the grants stay current.
# bedrock:InvokeModel is scoped to the Titan embed model; harmless while EMBED_PROVIDER=stub.
# sqs:SendMessage lets the nightly function's async OnFailure destination deliver to the DLQ.
$policy = @"
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"$secretArn"},
 {"Effect":"Allow","Action":"bedrock:InvokeModel","Resource":"arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0"},
 {"Effect":"Allow","Action":"sqs:SendMessage","Resource":"$dlqArn"}]}
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
# Existing API by name is NOT trusted blindly (round-2 P1-4): verify $default integration target.
$integTarget = & $aws apigatewayv2 get-integrations --api-id $apiId --query "Items[0].IntegrationUri" --output text
Assert-NativeSuccess "get-integrations"
if ($integTarget -ne $mcpArn) { throw "api $apiId integration points at '$integTarget', expected $mcpFn ($mcpArn)" }
$acct = & $aws sts get-caller-identity --query Account --output text
Assert-NativeSuccess "get account"
Grant-InvokePermission $mcpFn "tidemark-apigw" "apigateway.amazonaws.com" "arn:aws:execute-api:${region}:${acct}:${apiId}/*"
$apiUrl = & $aws apigatewayv2 get-api --api-id $apiId --query ApiEndpoint --output text
Assert-NativeSuccess "get api endpoint"

# ---- 7. EventBridge nightly rule (03:00 Beijing = 19:00 UTC) + two-layer failure wiring ----
# Layer 1 (delivery): EventBridge target RetryPolicy + DeadLetterConfig covers failed DELIVERY to Lambda.
# Layer 2 (execution): Lambda async event-invoke-config covers function-code failures -- explicit
# retries then OnFailure -> the same DLQ. The nightly handler intentionally throws on nonterminal
# job states, so these retries ARE the same-schedule takeover path; exhausted retries land in DLQ.
& $aws events put-rule --name $ruleName --schedule-expression "cron(0 19 * * ? *)" --state ENABLED --query RuleArn --output text | Out-Null
Assert-NativeSuccess "put-rule"
$ruleArn = & $aws events describe-rule --name $ruleName --query Arn --output text
Assert-NativeSuccess "describe-rule"

# DLQ policy: only this rule may SendMessage via the EventBridge service principal.
$dlqPolicy = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"events.amazonaws.com"},"Action":"sqs:SendMessage","Resource":"' + $dlqArn + '","Condition":{"ArnEquals":{"aws:SourceArn":"' + $ruleArn + '"}}}]}'
$attrFile = Join-Path $PSScriptRoot '.dlq-attrs.json'
try {
  Write-NoBom $attrFile (@{ Policy = $dlqPolicy } | ConvertTo-Json -Compress)
  & $aws sqs set-queue-attributes --queue-url $dlqUrl --attributes ("file://" + ($attrFile -replace '\\','/'))
  Assert-NativeSuccess "set dlq policy"
} finally { Remove-Item $attrFile -Force -Confirm:$false -ErrorAction SilentlyContinue }

$targetsFile = Join-Path $PSScriptRoot '.targets.json'
try {
  Write-NoBom $targetsFile (@{ Rule = $ruleName; Targets = @(@{ Id = "nightly"; Arn = $nightlyArn
    DeadLetterConfig = @{ Arn = $dlqArn }
    RetryPolicy = @{ MaximumRetryAttempts = 2; MaximumEventAgeInSeconds = 3600 } }) } | ConvertTo-Json -Depth 5)
  $failedCount = & $aws events put-targets --cli-input-json ("file://" + ($targetsFile -replace '\\','/')) --query FailedEntryCount --output text
  Assert-NativeSuccess "put-targets"
  if ($failedCount -ne "0") { throw "put-targets reported FailedEntryCount=$failedCount (exit 0 does not mean success)" }
} finally { Remove-Item $targetsFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
Grant-InvokePermission $nightlyFn "tidemark-events" "events.amazonaws.com" $ruleArn

# Async execution failures: 2 retries, 6h max age, then DLQ. Idempotent upsert by nature.
$eicFile = Join-Path $PSScriptRoot '.event-invoke.json'
try {
  Write-NoBom $eicFile (@{ FunctionName = $nightlyFn; MaximumRetryAttempts = 2; MaximumEventAgeInSeconds = 21600
    DestinationConfig = @{ OnFailure = @{ Destination = $dlqArn } } } | ConvertTo-Json -Depth 4)
  & $aws lambda put-function-event-invoke-config --cli-input-json ("file://" + ($eicFile -replace '\\','/')) --query LastModified --output text | Out-Null
  Assert-NativeSuccess "put-function-event-invoke-config"
} finally { Remove-Item $eicFile -Force -Confirm:$false -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "=== deploy complete ==="
Write-Host "api url:     $apiUrl"
Write-Host "secret arn:  $secretArn"
Write-Host "functions:   $mcpFn (30s), $nightlyFn (600s, cron 19:00 UTC)"
Write-Host "dlq:         $dlqName (EventBridge delivery + Lambda async OnFailure, retries 2/2)"
Write-Host "database:    $prodDb"
Write-Host "next:        node --env-file=.env infra/smoke.mjs $apiUrl"
