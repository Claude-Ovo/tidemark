# Tidemark P0-09 production deploy (idempotent create-or-update).
# Prereqs: aws cli configured (region us-east-1); repo-root .env with COCKROACH_DATABASE_URL.
# Creates/updates: Secrets Manager secret, IAM role, two Lambda functions (mcp + nightly),
# API Gateway HTTP API ($default -> mcp fn), EventBridge nightly rule (cron 19:00 UTC = 03:00 CST).
# Credentials NEVER enter argv or function config: secret JSON goes through a BOM-less temp
# file (deleted in finally); functions only receive the secret ARN.
# NOTE: ASCII-only comments (PS5.1 reads BOM-less scripts as ANSI). Existence probes do NOT
# redirect stderr: under ErrorActionPreference=Stop, redirected native stderr becomes
# terminating NativeCommandError in PS5.1. Expect aws NotFound noise on first run; harmless.
param([switch]$RotateSecrets, [switch]$SkipMigrate, [switch]$SkipPackage, [switch]$Rollback)
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

. (Join-Path $PSScriptRoot 'cutover-lib.ps1')   # verified gate/rule/state/rollback primitives (round-4)

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo
$envFile = Join-Path $repo '.env'
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

# ---- rollback mode (round-4: phase-aware, physically safe only BEFORE backfill) ----
if ($Rollback) {
  $acctR = & $aws sts get-caller-identity --query Account --output text
  Assert-NativeSuccess "get account"
  $bucketR = "tidemark-artifacts-$acctR"
  $stateR = Get-CutoverState $bucketR
  $target = Resolve-RollbackTarget $stateR    # throws at post-backfill/complete or without last_good
  Write-Host ("rolling back to last_good artifact " + $target.artifact_key + " (identity " + $target.identity + ")")
  foreach ($fn in @($mcpFn, $nightlyFn)) {
    & $aws lambda update-function-code --function-name $fn --s3-bucket $bucketR --s3-key $target.artifact_key --query LastUpdateStatus --output text | Out-Null
    Assert-NativeSuccess "rollback code $fn"
    & $aws lambda wait function-updated-v2 --function-name $fn
    Assert-NativeSuccess "rollback wait $fn"
  }
  Remove-MaintenanceGate @($mcpFn, $nightlyFn)          # verified; partial failure keeps maintenance
  Set-RuleState $ruleName "ENABLED"
  $stateR.phase = "complete"                             # last_good unchanged: it IS what we restored
  Set-CutoverState $bucketR $stateR
  Write-Host "rollback complete (verified ungate, rule enabled, state persisted)"
  exit 0
}

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

# ---- 3. maintenance cutover phase A (local-onnx round-2 P0): apply THROUGH 034 only ----
# The 034 -> backfill -> 035 sequence is executable, not documentation: 035 validates
# existing rows, so identity-stamping writers must be live and the backfill must reach
# residual 0 BEFORE 035 applies. Phase B (rest of migrations + verify) runs after the
# functions are deployed and the backfill has swept legacy rows. PREFLIGHT 035 plus the
# CHECK itself keep every failure mode fail-closed if this ordering is ever violated.
if (-not $SkipMigrate) {
  node --env-file=$envFile migrations/apply.mjs --database $prodDb --create-database --through 034
  Assert-NativeSuccess "migrate $prodDb through 034"
}

# ---- 4. package: staged linux/x64 build (conclusion 55 - the artifact carries the model) ----
# The repo node_modules is a WINDOWS install; onnxruntime/sharp are platform-native, so the
# Lambda artifact is assembled in a staging dir with the spike-proven recipe: ci -> force
# linux sharp -> prune -> sharp stub -> models + manifest + NOTICE -> content gates -> zip.
$zip = Join-Path $repo 'tidemark.zip'
if (-not $SkipPackage) {
  node infra/fetch-model.mjs
  Assert-NativeSuccess "model artifacts verification"
  $stage = Join-Path $repo '.lambda-build'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -Confirm:$false }
  New-Item -ItemType Directory $stage | Out-Null
  Copy-Item package.json,package-lock.json $stage/
  Push-Location $stage
  try {
    # npm stderr must NOT be redirected here (PS5.1 Stop + 2>&1 = terminating NativeCommandError)
    npm ci --omit=dev | Select-Object -Last 1
    Assert-NativeSuccess "staging npm ci"
    npm install --force --no-save "@img/sharp-linux-x64" "@img/sharp-libvips-linux-x64" | Select-Object -Last 1
    Assert-NativeSuccess "staging sharp linux (force reinstalls the tree: prune AFTER)"
    Remove-Item node_modules/onnxruntime-node/bin/napi-v6/darwin -Recurse -Force -Confirm:$false
    Remove-Item node_modules/onnxruntime-node/bin/napi-v6/win32 -Recurse -Force -Confirm:$false
    Remove-Item node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item node_modules/onnxruntime-web -Recurse -Force -Confirm:$false
    Remove-Item node_modules/@img -Recurse -Force -Confirm:$false
    Get-ChildItem node_modules/@huggingface/transformers/dist -File | Where-Object {
      $_.Name -match '^(transformers|transformers\.min|transformers\.web)\.js(\.map)?$' -or $_.Name -like 'ort-wasm*'
    } | Remove-Item -Force -Confirm:$false
    Remove-Item node_modules/sharp -Recurse -Force -Confirm:$false
    New-Item -ItemType Directory node_modules/sharp | Out-Null
    Copy-Item (Join-Path $repo 'spike\onnx\sharp-stub\package.json'),(Join-Path $repo 'spike\onnx\sharp-stub\index.js') node_modules/sharp/
    # payload: src (minus tests/logs), migrations, manifest, NOTICE, sealed models
    Copy-Item (Join-Path $repo 'src') . -Recurse
    Get-ChildItem src -Recurse -File | Where-Object { $_.Name -like 'test-*.mjs' -or $_.Name -like '*.log' -or $_.Name -like '*.err' } | Remove-Item -Force -Confirm:$false
    Copy-Item (Join-Path $repo 'migrations') . -Recurse
    Copy-Item (Join-Path $repo 'embed-manifest.json') .
    Copy-Item (Join-Path $repo 'NOTICE.md') .
    Copy-Item (Join-Path $repo 'models') . -Recurse
    # content gates: fail the build, not the cold start
    if (Test-Path node_modules/onnxruntime-node/bin/napi-v6/win32) { throw "win32 binaries survived pruning" }
    if (Test-Path node_modules/onnxruntime-node/bin/napi-v6/darwin) { throw "darwin binaries survived pruning" }
    if (Test-Path node_modules/onnxruntime-web) { throw "onnxruntime-web survived pruning" }
    if (-not (Select-String -Path node_modules/sharp/index.js -Pattern "TIDEMARK_SHARP_STUB" -Quiet)) { throw "sharp is not the stub" }
    if (-not (Test-Path 'models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx')) { throw "model missing from payload" }
    if (Test-Path $zip) { Remove-Item $zip -Force -Confirm:$false }
    & "$env:SystemRoot\System32\tar.exe" -a -c -f $zip src migrations embed-manifest.json NOTICE.md models node_modules package.json
    Assert-NativeSuccess "package zip"
  } finally { Pop-Location }
  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "packaged tidemark.zip ($mb MB, staged linux/x64 + sealed model)"
}
$zipShaHex = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$hexBytes = [byte[]]::new(32)
for ($i = 0; $i -lt 32; $i++) { $hexBytes[$i] = [Convert]::ToByte($zipShaHex.Substring($i * 2, 2), 16) }
$zipShaB64 = [Convert]::ToBase64String($hexBytes)

# ---- 4b. ship the artifact once via S3 (40MB+ direct upload dies on cross-border routes) ----
$acct = & $aws sts get-caller-identity --query Account --output text
Assert-NativeSuccess "get account"
$bucket = "tidemark-artifacts-$acct"
& $aws s3api head-bucket --bucket $bucket | Out-Null
if ($LASTEXITCODE -ne 0) {
  & $aws s3api create-bucket --bucket $bucket --query Location --output text | Out-Null
  Assert-NativeSuccess "create artifacts bucket"
}
# ---- 4b2. derive the built artifact's embedding identity (from the STAGED tree) ----
$expectedId = node -e "import(process.argv[1]).then(m => process.stdout.write(m.embedIdentity().embedding_model_id))" "file:///$((Join-Path $repo '.lambda-build\src\lib\embed-identity.mjs') -replace '\\','/')"
Assert-NativeSuccess "derive built identity"
if ([string]::IsNullOrWhiteSpace($expectedId)) { throw "derived identity is empty" }
Write-Host "built identity: $expectedId"

# ---- 4b3. content-addressed immutable artifact upload (round-4 P1-1) ----
# key carries the zip sha: reruns after a failed cutover can never clobber a good artifact,
# and last_good in cutover-state always points at bytes that still exist.
$artifactKey = "artifacts/tidemark-" + $zipShaHex.Substring(0, 16) + ".zip"
& $aws s3api head-object --bucket $bucket --key $artifactKey | Out-Null
if ($LASTEXITCODE -ne 0) {
  & $aws s3 cp $zip "s3://$bucket/$artifactKey" --only-show-errors
  Assert-NativeSuccess "s3 upload artifact"
} else { Write-Host "artifact already uploaded (content-addressed): $artifactKey" }

# ---- 4c. maintenance gate (round-3 P1-1, round-4 verified): no traffic reaches mixed state ----
# reserved-concurrency 0 throttles BOTH the API path and EventBridge invokes; every transition
# is READ BACK (cutover-lib). Mid-cutover death = explicit maintenance, recovery = rerun deploy
# (roll-forward) or -Rollback (allowed only pre-backfill, enforced by Resolve-RollbackTarget).
$priorState = Get-CutoverState $bucket
$init = Resolve-InitialPhase $priorState   # round-5 P1-1: phase NEVER regresses past the irreversible line
if ($init.phase -eq "backfill-started") {
  Write-Host "resuming an interrupted cutover PAST the irreversible line: roll-forward only (cutover $($init.cutover_id))"
}
Set-RuleState $ruleName "DISABLED"
$gated = @()
foreach ($fn in @($mcpFn, $nightlyFn)) {
  & $aws lambda get-function --function-name $fn --query Configuration.FunctionArn --output text | Out-Null
  if ($LASTEXITCODE -eq 0) { $gated += $fn }
}
if ($gated.Count -gt 0) {
  Set-MaintenanceGate $gated
  # runtime proof beyond read-back: an invoke MUST be throttled before we touch the code
  $probeOut = Join-Path $env:TEMP 'gate-probe.json'
  & $aws lambda invoke --function-name $gated[0] --cli-binary-format raw-in-base64-out --payload '{}' $probeOut --output text | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "maintenance gate FAILED: $($gated[0]) still invocable with reserved-concurrency 0" }
  Remove-Item $probeOut -Force -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host ("maintenance gate up + proven (invoke throttled): " + ($gated -join ', '))
}
$state = [pscustomobject]@{
  phase = $init.phase; cutover_id = $init.cutover_id
  artifact_key = $artifactKey; artifact_sha256 = $zipShaHex; identity = $expectedId
  last_good = if ($priorState -and $priorState.last_good) { $priorState.last_good } else { $null }
  updated_at = ""
}
Set-CutoverState $bucket $state

# ---- 5. Lambda functions (create-or-update) ----
function Deploy-Function([string]$name, [string]$handler, [int]$timeout, [hashtable]$envVars) {
  & $aws lambda get-function --function-name $name --query Configuration.FunctionArn --output text | Out-Null
  $exists = ($LASTEXITCODE -eq 0)
  $cfgFile = Join-Path $PSScriptRoot ".fn-cfg.json"
  $cfg = @{ FunctionName = $name; Handler = $handler; Timeout = $timeout; MemorySize = 1024; Environment = @{ Variables = $envVars } }
  if (-not $exists) { $cfg.Runtime = "nodejs22.x"; $cfg.Role = $roleArn }
  try {
    Write-NoBom $cfgFile ($cfg | ConvertTo-Json -Depth 5)
    $fileArg = "file://" + ($cfgFile -replace '\\','/')
    if ($exists) {
      & $aws lambda update-function-configuration --cli-input-json $fileArg --query LastUpdateStatus --output text | Out-Null
      Assert-NativeSuccess "update-function-configuration $name"
      & $aws lambda wait function-updated-v2 --function-name $name
      Assert-NativeSuccess "wait config $name"
      & $aws lambda update-function-code --function-name $name --s3-bucket $bucket --s3-key $artifactKey --query LastUpdateStatus --output text | Out-Null
      Assert-NativeSuccess "update-function-code $name"
    } else {
      $cfg.Code = @{ S3Bucket = $bucket; S3Key = $artifactKey }
      Write-NoBom $cfgFile ($cfg | ConvertTo-Json -Depth 5)
      & $aws lambda create-function --cli-input-json $fileArg --query FunctionArn --output text | Out-Null
      Assert-NativeSuccess "create-function $name"
    }
  } finally { Remove-Item $cfgFile -Force -Confirm:$false -ErrorAction SilentlyContinue }
  & $aws lambda wait function-active-v2 --function-name $name
  Assert-NativeSuccess "wait active $name"
  & $aws lambda wait function-updated-v2 --function-name $name
  Assert-NativeSuccess "wait updated $name"
  # deployed-artifact identity proof: the function must run THIS zip (round-4 contract)
  $deployedSha = & $aws lambda get-function --function-name $name --query Configuration.CodeSha256 --output text
  Assert-NativeSuccess "get CodeSha256 $name"
  if ($deployedSha -ne $zipShaB64) { throw "$name CodeSha256 $deployedSha != local zip sha256(b64) $zipShaB64" }
  Write-Host "function ready: $name (CodeSha256 verified)"
}

$mcpEnv = @{ TIDEMARK_SECRET_ARN = $secretArn; TIDEMARK_DATABASE = $prodDb; TIDEMARK_POOL_MAX = "1"; EMBED_PROVIDER = "local-onnx" }
$nightlyEnv = $mcpEnv.Clone()
$nightlyEnv.TIDEMARK_NIGHTLY_TENANTS = "demo-tenant"
Deploy-Function $mcpFn "src/aws/mcp-handler.handler" 30 $mcpEnv
Deploy-Function $nightlyFn "src/aws/nightly-handler.handler" 600 $nightlyEnv
if ($state.phase -eq "gated") { $state.phase = "code-swapped"; Set-CutoverState $bucket $state }
# (a resumed backfill-started cutover stays backfill-started: monotonic, round-5 P1-1)

# ---- 5b. cutover phase B: backfill into the current space, then the remaining migrations ----
if (-not $SkipMigrate) {
  $env:EMBED_PROVIDER = "local-onnx"
  # round-6: the irreversible line is persisted UNCONDITIONALLY before any process that can
  # write. The round-5 dry-run conditional had a TOCTOU: reserved-concurrency=0 rejects NEW
  # invocations but does not kill in-flight ones (nightly can run 600s), and direct DB
  # writers bypass function gates entirely -- a row could appear between the count and the
  # real run. A spurious roll-forward-only mark on an idle DB is conservative and loses
  # nothing; a reopened rollback window loses the database.
  if ($state.phase -ne "backfill-started") {
    $state.phase = "backfill-started"                  # from THIS moment: roll-forward only
    Set-CutoverState $bucket $state
  }
  node --env-file=$envFile migrations/backfill-embeddings.mjs --database $prodDb
  Assert-NativeSuccess "backfill embeddings $prodDb (residual must be zero)"
  $state.phase = "post-backfill"
  Set-CutoverState $bucket $state
  node --env-file=$envFile migrations/apply.mjs --database $prodDb
  Assert-NativeSuccess "migrate $prodDb (035+)"
  node --env-file=$envFile migrations/verify.mjs --database $prodDb
  Assert-NativeSuccess "verify $prodDb"
} else {
  $state.phase = "post-backfill"                       # SkipMigrate implies the DB already matches
  Set-CutoverState $bucket $state
}
# NOTE: the gate stays UP here. It is lifted at the very end (section 8), after the API is
# wired, with a verified ungate followed by a live /health identity read-back.


$mcpArn = & $aws lambda get-function --function-name $mcpFn --query Configuration.FunctionArn --output text
Assert-NativeSuccess "get mcp arn"
$nightlyArn = & $aws lambda get-function --function-name $nightlyFn --query Configuration.FunctionArn --output text
Assert-NativeSuccess "get nightly arn"

# ---- 6. API Gateway HTTP API (quick-create: default route + auto-deploy stage) ----
$apiCount = & $aws apigatewayv2 get-apis --query "length(Items[?Name=='$apiName'])" --output text
Assert-NativeSuccess "get-apis count"
if ([int]$apiCount -gt 1) { throw "found $apiCount APIs named '$apiName' - resolve the duplicates before deploying" }
$apiId = & $aws apigatewayv2 get-apis --query "Items[?Name=='$apiName'].ApiId | [0]" --output text
Assert-NativeSuccess "get-apis"
if ($apiId -eq "None" -or [string]::IsNullOrWhiteSpace($apiId)) {
  $apiId = & $aws apigatewayv2 create-api --name $apiName --protocol-type HTTP --target $mcpArn --query ApiId --output text
  Assert-NativeSuccess "create-api"
  Write-Host "api created: $apiId"
}
# account already resolved in section 4b
# Existing API by name is NOT trusted blindly (round-2 P1-4, tightened round-3 P1-3):
# follow the $default ROUTE to its integration id, then compare that integration's URI.
# Items[0] of get-integrations could be an unused leftover while the route points elsewhere.
$routeTarget = & $aws apigatewayv2 get-routes --api-id $apiId --query "Items[?RouteKey=='`$default'].Target | [0]" --output text
Assert-NativeSuccess "get-routes"
if ($routeTarget -eq "None" -or [string]::IsNullOrWhiteSpace($routeTarget)) { throw "api $apiId has no `$default route" }
if ($routeTarget -notmatch '^integrations/') { throw "api $apiId `$default route target '$routeTarget' is not an integration" }
$integId = $routeTarget -replace '^integrations/', ''
$integTarget = & $aws apigatewayv2 get-integration --api-id $apiId --integration-id $integId --query IntegrationUri --output text
Assert-NativeSuccess "get-integration $integId"
if ($integTarget -ne $mcpArn) { throw "api $apiId `$default integration points at '$integTarget', expected $mcpFn ($mcpArn)" }
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
# put-rule above re-enabled the rule while functions are still gated: hold it DISABLED until
# the final verified ungate (section 8). Fires during this window would only meet throttles,
# but a disabled rule is the honest state.
Set-RuleState $ruleName "DISABLED"

# Async execution failures: 2 retries, 6h max age, then DLQ. Idempotent upsert by nature.
$eicFile = Join-Path $PSScriptRoot '.event-invoke.json'
try {
  Write-NoBom $eicFile (@{ FunctionName = $nightlyFn; MaximumRetryAttempts = 2; MaximumEventAgeInSeconds = 21600
    DestinationConfig = @{ OnFailure = @{ Destination = $dlqArn } } } | ConvertTo-Json -Depth 4)
  & $aws lambda put-function-event-invoke-config --cli-input-json ("file://" + ($eicFile -replace '\\','/')) --query LastModified --output text | Out-Null
  Assert-NativeSuccess "put-function-event-invoke-config"
} finally { Remove-Item $eicFile -Force -Confirm:$false -ErrorAction SilentlyContinue }

# ---- 8. verified ungate + live identity read-back, then the cutover is COMPLETE ----
Remove-MaintenanceGate @($mcpFn, $nightlyFn)
Set-RuleState $ruleName "ENABLED"
# live proof: the API must answer with the EXACT built identity; mismatch = re-gate + fail
$healthOk = $false
for ($i = 1; $i -le 5; $i++) {
  try {
    $h = Invoke-RestMethod -Uri ($apiUrl + "/health") -TimeoutSec 20
    if ($h.embedding_model_id -eq $expectedId) { $healthOk = $true; break }
    throw "live identity '$($h.embedding_model_id)' != built '$expectedId'"
  } catch {
    if ($_.Exception.Message -like "*!= built*") { Set-MaintenanceGate @($mcpFn, $nightlyFn); throw $_ }
    Write-Host "health probe $i/5 failed (route flake); retrying in 5s"
    Start-Sleep -Seconds 5
  }
}
if (-not $healthOk) { Set-MaintenanceGate @($mcpFn, $nightlyFn); throw "health identity read-back never succeeded; service RE-GATED" }
$state.phase = "complete"
$state.last_good = [pscustomobject]@{ artifact_key = $artifactKey; identity = $expectedId }
Set-CutoverState $bucket $state
Write-Host "cutover complete: verified ungate + live identity match, last_good advanced"

Write-Host ""
Write-Host "=== deploy complete ==="
Write-Host "api url:     $apiUrl"
Write-Host "secret arn:  $secretArn"
Write-Host "functions:   $mcpFn (30s), $nightlyFn (600s, cron 19:00 UTC)"
Write-Host "dlq:         $dlqName (EventBridge delivery + Lambda async OnFailure, retries 2/2)"
Write-Host "database:    $prodDb"
Write-Host "next:        node --env-file=.env infra/smoke.mjs $apiUrl"
