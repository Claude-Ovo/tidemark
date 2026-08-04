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
  # round-5 P1-2: absence must be PROVEN by a successful listing, never inferred from a
  # failed read (AccessDenied/DNS/line errors are fatal, not "first deploy").
  $n = & $script:CutoverAws s3api list-objects-v2 --bucket $Bucket --prefix cutover-state.json --query 'length(Contents || `[]`)' --output text
  Assert-CutoverNative "list cutover state (absence must be verifiable)"
  if ("$n".Trim() -eq "0" -or "$n".Trim() -eq "None") { return $null }   # verified absent
  $tmp = Join-Path $env:TEMP ("cutover-state-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".json")
  & $script:CutoverAws s3 cp "s3://$Bucket/cutover-state.json" $tmp --only-show-errors | Out-Null
  Assert-CutoverNative "read cutover state (it exists but could not be fetched)"
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
  # read-back: the persisted phase must be what we wrote (round-5 P1-2)
  $rb = Get-CutoverState $Bucket
  if ($null -eq $rb -or $rb.phase -ne $State.phase) {
    throw "cutover state read-back mismatch: wrote '$($State.phase)', read '$(if ($rb) { $rb.phase } else { "<absent>" })'"
  }
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
  # all-or-nothing FOR REAL (round-4 P2): a partial failure re-gates whatever was already
  # ungated before throwing -- mixed-version half-open service is never left behind
  $ungated = @()
  try {
    foreach ($fn in $Functions) {
      & $script:CutoverAws lambda delete-function-concurrency --function-name $fn
      Assert-CutoverNative "ungate $fn (delete-function-concurrency)"
      $rb = & $script:CutoverAws lambda get-function-concurrency --function-name $fn --query ReservedConcurrentExecutions --output text
      Assert-CutoverNative "ungate read-back $fn"
      $v = "$rb".Trim()
      if ($v -ne "" -and $v -ne "None") { throw "ungate NOT verified on ${fn}: read-back '$v' (still reserved)" }
      $ungated += $fn
    }
  } catch {
    # round-6 P2: re-gate ALL functions, not just the tracked ones -- "delete succeeded but
    # read-back failed" leaves a function ungated without being in the array. Best effort:
    # a re-gate failure is printed loudly but the ORIGINAL error is what propagates.
    Write-Host ("partial ungate failure: re-gating ALL of " + ($Functions -join ', '))
    try { Set-MaintenanceGate $Functions } catch { Write-Host ("RE-GATE ALSO FAILED (network dead?): " + $_.Exception.Message) }
    throw
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
    # round-5 P1-2: absence must be PROVEN by a successful list, never assumed from failures
    if ($Target -eq "DISABLED" -and $verbExit -ne 0) {
      $cnt = & $script:CutoverAws events list-rules --name-prefix $RuleName --query "length(Rules[?Name=='$RuleName'])" --output text
      Assert-CutoverNative "list rules (absence must be verifiable)"
      if ("$cnt".Trim() -eq "0") { Write-Host "rule $RuleName verified absent (first deploy)"; return }
      throw "rule $RuleName exists but is unreadable after $verb (AccessDenied/network?)"
    }
    throw "rule $RuleName state unreadable after $verb (exit $descExit)"
  }
  if ("$state".Trim() -ne $Target) { throw "rule $RuleName is '$state' after $verb, expected $Target" }
}

# ---- phase-aware rollback decision (pure logic, unit-tested) ----
# Returns the artifact key to restore, or throws when rollback is physically unsafe.
$script:PhaseRank = @{ "gated" = 0; "code-swapped" = 1; "backfill-started" = 2; "post-backfill" = 3; "complete" = 4 }

# Where may a NEW deploy run start, given the prior persisted state? (round-5 P1-1)
# - no prior / prior complete: fresh cutover (new cutover_id, phase gated)
# - prior gated/code-swapped (died pre-backfill, functions still gated): resume same cutover at gated
# - prior backfill-started/post-backfill: the irreversible line was crossed -- resume the SAME
#   cutover at backfill-started; phase NEVER regresses to a rollback-permitting value
function Resolve-InitialPhase($Prior) {
  if ($null -eq $Prior -or $Prior.phase -eq "complete") {
    return [pscustomobject]@{ phase = "gated"; cutover_id = [guid]::NewGuid().ToString("N") }
  }
  $cid = if ($Prior.cutover_id) { $Prior.cutover_id } else { [guid]::NewGuid().ToString("N") }
  if ($Prior.phase -eq "backfill-started" -or $Prior.phase -eq "post-backfill") {
    return [pscustomobject]@{ phase = "backfill-started"; cutover_id = $cid }
  }
  return [pscustomobject]@{ phase = "gated"; cutover_id = $cid }
}

function Resolve-RollbackTarget($State) {
  if ($null -eq $State) { throw "no cutover state: nothing was ever deployed by the gated flow; nothing to roll back to" }
  if ($State.phase -eq "backfill-started" -or $State.phase -eq "post-backfill" -or $State.phase -eq "complete") {
    throw ("ROLLBACK REFUSED at phase '" + $State.phase + "': the database has been backfilled into identity '" +
      $State.identity + "'. Old code derives a different identity and would see NO rows while forking new " +
      "writes into a dead space. Past backfill the only safe direction is roll-forward: fix and rerun deploy.")
  }
  if ($null -eq $State.last_good -or [string]::IsNullOrWhiteSpace($State.last_good.artifact_key)) {
    throw "ROLLBACK REFUSED: no last_good artifact recorded (first gated deploy never completed)"
  }
  return $State.last_good
}
