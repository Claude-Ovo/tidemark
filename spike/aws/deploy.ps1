# Tidemark spike deploy script (idempotent-ish; documents the exact infra)
# Prereqs: aws cli configured; .env two levels up with COCKROACH_DATABASE_URL
# Infra facts: runtime nodejs22.x, 512MB, timeout 30s, API Gateway HTTP API (payload v2, $default -> Lambda)
$ErrorActionPreference = "Stop"
$aws = "C:\Program Files\Amazon\AWSCLIv2\aws.exe"
$fn = "tidemark-spike"

npm install --omit=dev | Out-Null
Compress-Archive -Path handler.mjs,package.json,node_modules -DestinationPath spike.zip -Force

$dburl = (Get-Content ..\..\.env | Where-Object { $_ -match '^COCKROACH_DATABASE_URL=' }) -replace '^COCKROACH_DATABASE_URL=',''
& $aws lambda update-function-configuration --function-name $fn --environment "Variables={COCKROACH_DATABASE_URL=$dburl}" --query LastUpdateStatus --output text
Start-Sleep 8
& $aws lambda update-function-code --function-name $fn --zip-file fileb://spike.zip --query LastUpdateStatus --output text
Write-Host "deployed. First-time setup (already done once, for reproducers):"
Write-Host "  1. aws iam create-role tidemark-spike-lambda (trust lambda.amazonaws.com) + attach AWSLambdaBasicExecutionRole + bedrock InvokeModel policy"
Write-Host "  2. aws lambda create-function --runtime nodejs22.x --handler handler.handler --timeout 30 --memory-size 512"
Write-Host "  3. aws apigatewayv2 create-api --protocol-type HTTP --target <fn-arn>  (then lambda add-permission for apigateway principal)"
