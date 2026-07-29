# Tidemark spike deploy (reproduces the stub-green state)
# Prereqs: aws cli configured; ../../.env with COCKROACH_DATABASE_URL
# Infra facts: nodejs22.x, 512MB, timeout 30s, API Gateway HTTP API payload v2 ($default -> Lambda)
# NOTE: first-time infra creation (role/function/api) is documented in SPIKE-MCP.md, not automated here.
$ErrorActionPreference = "Stop"
$aws = "C:\Program Files\Amazon\AWSCLIv2\aws.exe"
$fn = "tidemark-spike"

npm ci --omit=dev | Out-Null
node migrate.mjs
Compress-Archive -Path handler.mjs,package.json,node_modules -DestinationPath spike.zip -Force

# 凭据不进命令行：env 配置经 --cli-input-json 临时文件下发，用后即删
# TODO(P0-09): 切 Secrets Manager ARN + Lambda 内取值，函数配置不再持明文
$dburl = (Get-Content ..\..\.env | Where-Object { $_ -match '^COCKROACH_DATABASE_URL=' }) -replace '^COCKROACH_DATABASE_URL=',''
$cfg = @{ FunctionName = $fn; Environment = @{ Variables = @{ COCKROACH_DATABASE_URL = $dburl; EMBED_PROVIDER = "stub" } } } | ConvertTo-Json -Depth 5
$tmp = New-TemporaryFile
try {
  # PS5.1 的 -Encoding utf8 带 BOM 会呛 aws cli，用无 BOM 写入
  [IO.File]::WriteAllText($tmp.FullName, $cfg, (New-Object Text.UTF8Encoding($false)))
  & $aws lambda update-function-configuration --cli-input-json ("file://" + ($tmp.FullName -replace '\\','/')) --query LastUpdateStatus --output text
} finally { Remove-Item $tmp -Force -Confirm:$false }

& $aws lambda wait function-updated-v2 --function-name $fn
& $aws lambda update-function-code --function-name $fn --zip-file fileb://spike.zip --query LastUpdateStatus --output text
& $aws lambda wait function-updated-v2 --function-name $fn
Write-Host "deployed (EMBED_PROVIDER=stub). Switch to bedrock by editing Variables after allowlisting approval."
