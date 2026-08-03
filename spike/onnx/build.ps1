# Tidemark ONNX spike build (round-2: reproducible from the commit, manifest-verified).
# Produces .build/spike-onnx.zip for Lambda linux/x64 plus .build/artifact-manifest.json,
# verifies package contents (no win32/darwin/onnxruntime-web, sharp IS the stub), and with
# -Deploy uploads via S3 and cold-start-verifies the deployed artifact.
# NOTE: ASCII-only comments (PS5.1 reads BOM-less scripts as ANSI).
# Usage: powershell -File build.ps1 [-Deploy] [-Bucket <s3-bucket>] [-FunctionName <name>]
param(
  [switch]$Deploy,
  [string]$Bucket = "tidemark-artifacts-875699231234",
  [string]$FunctionName = "tidemark-embed-spike",
  [int]$MemorySize = 1024
)
$ErrorActionPreference = "Stop"
$aws = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
function Assert-NativeSuccess([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "step failed: $step (exit $LASTEXITCODE)" }
}
Set-Location $PSScriptRoot
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# 0. sealed model artifacts must verify before anything else
node fetch-model.mjs
Assert-NativeSuccess "fetch-model verification"

# 1. clean staging with lockfile-pinned deps
if (Test-Path .build) { Remove-Item .build -Recurse -Force -Confirm:$false }
New-Item -ItemType Directory .build | Out-Null
Copy-Item package.json,package-lock.json .build/
Set-Location .build
# npm writes warnings to stderr: do NOT redirect (2>&1 under Stop turns them into
# terminating NativeCommandError in PS5.1 -- the exact trap documented in infra/deploy.ps1)
npm ci --omit=dev | Select-Object -Last 1
Assert-NativeSuccess "npm ci"
# linux sharp platform packages: EBADPLATFORM on win requires --force, which reinstalls the
# whole tree -- therefore force FIRST, prune AFTER (learned the hard way, see SPIKE-ONNX.md)
npm install --force --no-save "@img/sharp-linux-x64" "@img/sharp-libvips-linux-x64" | Select-Object -Last 1
Assert-NativeSuccess "sharp linux install"

# 2. prune to linux/x64 text-only runtime
Remove-Item node_modules/onnxruntime-node/bin/napi-v6/darwin -Recurse -Force -Confirm:$false
Remove-Item node_modules/onnxruntime-node/bin/napi-v6/win32 -Recurse -Force -Confirm:$false
Remove-Item node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item node_modules/onnxruntime-web -Recurse -Force -Confirm:$false
Remove-Item node_modules/@img -Recurse -Force -Confirm:$false
Get-ChildItem node_modules/@huggingface/transformers/dist -File | Where-Object {
  $_.Name -match '^(transformers|transformers\.min|transformers\.web)\.js(\.map)?$' -or $_.Name -like 'ort-wasm*'
} | Remove-Item -Force -Confirm:$false
# sharp: replace the real package with the committed loud-failure stub
Remove-Item node_modules/sharp -Recurse -Force -Confirm:$false
New-Item -ItemType Directory node_modules/sharp | Out-Null
Copy-Item ..\sharp-stub\package.json,..\sharp-stub\index.js node_modules/sharp/

# 3. payload: handler + identity + REAL canonical implementation + manifest + NOTICE + models
Copy-Item ..\handler.mjs .
Copy-Item ..\identity.mjs .
Copy-Item (Join-Path $repo 'src\lib\vector-canonical.mjs') .\vector-canonical.mjs
Copy-Item ..\manifest.json .
Copy-Item ..\NOTICE.md .
Copy-Item ..\models . -Recurse

# 4. content verification gates (fail the build, not the reviewer)
if (Test-Path node_modules/onnxruntime-node/bin/napi-v6/darwin) { throw "darwin binaries survived pruning" }
if (Test-Path node_modules/onnxruntime-node/bin/napi-v6/win32) { throw "win32 binaries survived pruning" }
if (Test-Path node_modules/onnxruntime-web) { throw "onnxruntime-web survived pruning" }
if (-not (Select-String -Path node_modules/sharp/index.js -Pattern "TIDEMARK_SHARP_STUB" -Quiet)) { throw "sharp is not the stub" }
if (-not (Select-String -Path .\vector-canonical.mjs -Pattern "canonicalDigest" -Quiet)) { throw "canonical implementation missing" }
if (-not (Test-Path .\identity.mjs)) { throw "identity module missing from payload" }
if (-not (Test-Path .\NOTICE.md)) { throw "NOTICE missing from payload" }
# derived identity must be computable against the STAGED tree (also reconciles lockfile
# transformers/ORT versions with the manifest -- drift throws here, not in prod)
$idJson = node ..\identity.mjs --print .
Assert-NativeSuccess "identity derivation against staging"
$expectedId = ($idJson | ConvertFrom-Json).embedding_model_id
Write-Host "derived embedding_model_id: $expectedId"

# 5. zip + artifact manifest
if (Test-Path spike-onnx.zip) { Remove-Item spike-onnx.zip -Force -Confirm:$false }
& "$env:SystemRoot\System32\tar.exe" -a -c -f spike-onnx.zip handler.mjs identity.mjs vector-canonical.mjs manifest.json NOTICE.md models node_modules package.json
Assert-NativeSuccess "zip"
$zipInfo = Get-Item spike-onnx.zip
$zipSha = (Get-FileHash spike-onnx.zip -Algorithm SHA256).Hash.ToLower()
$unpacked = [long]((Get-ChildItem handler.mjs,identity.mjs,vector-canonical.mjs,manifest.json,NOTICE.md,models,node_modules,package.json -Recurse -File | Measure-Object Length -Sum).Sum)
$lockSha = (Get-FileHash ..\package-lock.json -Algorithm SHA256).Hash.ToLower()
$modelManifest = Get-Content ..\manifest.json -Raw | ConvertFrom-Json
$artifact = [ordered]@{
  embedding_model_id = $expectedId
  model_files = $modelManifest.files
  npm_lock_sha256 = $lockSha
  target = "nodejs22.x linux x64"
  prune_rules = @("onnxruntime-node: keep napi-v6/linux/x64 only", "remove onnxruntime-web", "remove transformers browser dist + ort-wasm*", "sharp replaced by committed loud-failure stub", "remove @img")
  zip_sha256 = $zipSha
  zip_bytes = $zipInfo.Length
  unpacked_bytes = $unpacked
  built_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$artifact | ConvertTo-Json -Depth 4 | Out-File artifact-manifest.json -Encoding utf8
Write-Host ("built: zip {0:N1}MB sha256={1}  unpacked {2:N1}MB" -f ($zipInfo.Length/1MB), $zipSha.Substring(0,16), ($unpacked/1MB))

if (-not $Deploy) { Write-Host "build-only done (use -Deploy to ship + cold-start-verify)"; exit 0 }

# 6. deploy the SAME zip via S3 (cross-border direct upload of 40MB+ is flaky) and verify
& $aws s3 cp spike-onnx.zip "s3://$Bucket/spike-onnx.zip" --only-show-errors
Assert-NativeSuccess "s3 upload"
& $aws lambda get-function --function-name $FunctionName --query Configuration.FunctionArn --output text | Out-Null
if ($LASTEXITCODE -ne 0) {
  $roleArn = & $aws iam get-role --role-name tidemark-prod-role --query Role.Arn --output text
  Assert-NativeSuccess "get role"
  & $aws lambda create-function --function-name $FunctionName --runtime nodejs22.x --role $roleArn --handler handler.handler --timeout 60 --memory-size $MemorySize --code "S3Bucket=$Bucket,S3Key=spike-onnx.zip" --query State --output text
  Assert-NativeSuccess "create-function"
} else {
  & $aws lambda update-function-code --function-name $FunctionName --s3-bucket $Bucket --s3-key spike-onnx.zip --query LastUpdateStatus --output text | Out-Null
  Assert-NativeSuccess "update-function-code"
}
& $aws lambda wait function-active-v2 --function-name $FunctionName
Assert-NativeSuccess "wait active"
& $aws lambda wait function-updated-v2 --function-name $FunctionName
Assert-NativeSuccess "wait updated"

# deployed-artifact identity proof (round-3 P2): CodeSha256 must equal our zip's sha256
# in base64 -- proves the function runs THIS zip, not merely "some zip that answers"
$hexBytes = [byte[]]::new(32)
for ($i = 0; $i -lt 32; $i++) { $hexBytes[$i] = [Convert]::ToByte($zipSha.Substring($i * 2, 2), 16) }
$zipShaB64 = [Convert]::ToBase64String($hexBytes)
$deployedSha = & $aws lambda get-function --function-name $FunctionName --query Configuration.CodeSha256 --output text
Assert-NativeSuccess "get CodeSha256"
if ($deployedSha -ne $zipShaB64) { throw "deployed CodeSha256 $deployedSha != local zip sha256 (b64) $zipShaB64" }

# cold-start verification: dims + EXACT derived identity + digest RECOMPUTED from the
# returned vector (round-4 P2: the probe does not trust self-reported digests either)
$pf = Join-Path $env:TEMP 'spike-verify-payload.json'
[IO.File]::WriteAllText($pf, '{"texts":["cold start verification probe"],"return_vectors":true}', (New-Object Text.UTF8Encoding($false)))
$out = Join-Path $env:TEMP 'spike-verify-out.json'
& $aws lambda invoke --function-name $FunctionName --cli-binary-format raw-in-base64-out --payload ("file://" + ($pf -replace '\\','/')) $out --query "[StatusCode,FunctionError]" --output text
Assert-NativeSuccess "verify invoke"
$resp = Get-Content $out -Raw | ConvertFrom-Json
if ($resp.dims -ne 512) { throw "deployed artifact failed cold-start verification: $(Get-Content $out -Raw)" }
if ($resp.embedding_model_id -ne $expectedId) { throw "deployed identity '$($resp.embedding_model_id)' != derived '$expectedId'" }
node ..\probe-check.mjs $out .
Assert-NativeSuccess "probe digest recompute"
Write-Host ("deployed + verified: CodeSha256 match, dims={0} load_ms={1}" -f $resp.dims, $resp.load_ms)
Write-Host ("identity: {0}" -f $resp.embedding_model_id)
