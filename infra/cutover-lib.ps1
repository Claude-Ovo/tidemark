# Tidemark cutover primitives (round-4: phase-aware recovery + verified state transitions).
# Dot-sourced by deploy.ps1; unit-tested against a mocked AWS CLI by infra/test-cutover.ps1.
# Every state change here tolerates ONLY a verified target state: exit codes are checked,
# then the state is READ BACK. Lying "gate lifted" while a function is still throttled is
# structurally impossible -- the read-back would throw.
# NOTE: ASCII-only comments (PS5.1 reads BOM-less scripts as ANSI).

$script:CutoverAws = if ($env:TIDEMARK_AWS_CLI) { $env:TIDEMARK_AWS_CLI } else { "C:\Program Files\Amazon\AWSCLIV2\aws.exe" }

function Assert-CutoverNative([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "cutover step failed: $step (exit $LASTEXITCODE)" }
}

# ---- persisted cutover state (S3 JSON, single source of truth for phase + artifacts) ----
# shape: { phase, artifact_key, artifact_sha256, identity, last_good: { artifact_key, identity }, updated_at }
# phases: gated -> code-swapped -> post-backfill -> complete. last_good moves ONLY at complete.
function Get-CutoverState([string]$Bucket) {
  $tmp = Join-Path $env:TEMP ("cutover-state-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".json")
  & $script:CutoverAws s3 cp "s3://$Bucket/cutover-state.json" $tmp --only-show-errors | Out-Null
  if ($LASTEXITCODE -ne 0) { return $null }   # first deploy: no state yet
  try { return (Get-Content $tmp -Raw | ConvertFrom-Json) } finally { Remove-Item $tmp -Force -Confirm:$false -ErrorAction SilentlyContinue }
}

function Set-CutoverState([string]$Bucket, $State) {
  $State.updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $tmp = Join-Path $env:TEMP ("cutover-state-w-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".json")
  try {
    [IO.File]::WriteAllText($tmp, ($State | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    & $script:CutoverAws s3 cp $tmp "s3://$Bucket/cutover-state.json" --only-show-errors | Out-Null
    Assert-CutoverNative "persist cutover state ($($State.phase))"
  } finally { Remove-Item $tmp -Force -Confirm:$false -ErrorAction SilentlyContinue }
}

# ---- verified gate primitives ----
function Set-MaintenanceGate([string[]]$Functions) {
  foreach ($fn in $Functions) {
    & $script:CutoverAws lambda put-function-concurrency --function-name $fn --reserved-concurrent-executions 0 --output text | Out-Null
    Assert-CutoverNative "gate $fn"
    $rb = & $script:CutoverAws lambda get-function-concurrency --function-name $fn --query ReservedConcurrentExecutions --output text
    Assert-CutoverNative "gate read-back $fn"
    if ("$rb".Trim() -ne "0") { throw "gate NOT verified on ${fn}: read-back '$rb' (expected 0)" }
  }
}

function Remove-MaintenanceGate([string[]]$Functions) {
  # all-or-nothing: verify every function ungated; any failure leaves maintenance in place
  foreach ($fn in $Functions) {
    & $script:CutoverAws lambda delete-function-concurrency --function-name $fn
    Assert-CutoverNative "ungate $fn (delete-function-concurrency)"
    $rb = & $script:CutoverAws lambda get-function-concurrency --function-name $fn --query ReservedConcurrentExecutions --output text
    Assert-CutoverNative "ungate read-back $fn"
    $v = "$rb".Trim()
    if ($v -ne "" -and $v -ne "None") { throw "ungate NOT verified on ${fn}: read-back '$v' (still reserved)" }
  }
}

# ---- verified rule state ----
function Set-RuleState([string]$RuleName, [string]$Target) {
  if ($Target -ne "ENABLED" -and $Target -ne "DISABLED") { throw "invalid rule target $Target" }
  $verb = if ($Target -eq "ENABLED") { "enable-rule" } else { "disable-rule" }
  & $script:CutoverAws events $verb --name $RuleName
  $verbExit = $LASTEXITCODE
  $state = & $script:CutoverAws events describe-rule --name $RuleName --query State --output text
  $descExit = $LASTEXITCODE
  if ($descExit -ne 0) {
    # NotFound is legitimate ONLY on first deploy while disabling (nothing to disable yet)
    if ($Target -eq "DISABLED" -and $verbExit -ne 0) { Write-Host "rule $RuleName absent (first deploy)"; return }
    throw "rule $RuleName state unreadable after $verb (exit $descExit)"
  }
  if ("$state".Trim() -ne $Target) { throw "rule $RuleName is '$state' after $verb, expected $Target" }
}

# ---- phase-aware rollback decision (pure logic, unit-tested) ----
# Returns the artifact key to restore, or throws when rollback is physically unsafe.
function Resolve-RollbackTarget($State) {
  if ($null -eq $State) { throw "no cutover state: nothing was ever deployed by the gated flow; nothing to roll back to" }
  if ($State.phase -eq "post-backfill" -or $State.phase -eq "complete") {
    throw ("ROLLBACK REFUSED at phase '" + $State.phase + "': the database has been backfilled into identity '" +
      $State.identity + "'. Old code derives a different identity and would see NO rows while forking new " +
      "writes into a dead space. Past backfill the only safe direction is roll-forward: fix and rerun deploy.")
  }
  if ($null -eq $State.last_good -or [string]::IsNullOrWhiteSpace($State.last_good.artifact_key)) {
    throw "ROLLBACK REFUSED: no last_good artifact recorded (first gated deploy never completed)"
  }
  return $State.last_good
}
