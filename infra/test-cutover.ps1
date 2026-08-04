# Cutover state-machine red gates (round-4 P1-2): the primitives must REFUSE to lie.
# Runs cutover-lib.ps1 against the mocked AWS CLI (mock-aws.mjs). No real AWS is touched.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File infra\test-cutover.ps1
# NOTE: ASCII-only comments.
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$tmp = Join-Path $env:TEMP ("cutover-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory $tmp | Out-Null
$statePath = Join-Path $tmp "mock-state.json"
$env:TIDEMARK_MOCK_STATE = $statePath
$env:TIDEMARK_MOCK_S3DIR = Join-Path $tmp "s3"
New-Item -ItemType Directory $env:TIDEMARK_MOCK_S3DIR | Out-Null

# shim: cutover-lib invokes "& $aws <args>" -- point it at a cmd that runs the node mock
$shim = Join-Path $tmp "mock-aws.cmd"
Set-Content -Path $shim -Value ("@echo off`r`nnode `"" + (Join-Path $here "mock-aws.mjs") + "`" %*") -Encoding ascii
$env:TIDEMARK_AWS_CLI = $shim
. (Join-Path $here "cutover-lib.ps1")

$passes = 0
function Set-MockState([hashtable]$h) { [IO.File]::WriteAllText($statePath, ($h | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false))) }
function Expect-Throw([scriptblock]$sb, [string]$pattern, [string]$label) {
  $threw = $false
  try { & $sb } catch { $threw = $true; if ($_.Exception.Message -notmatch $pattern) { throw "T-FAIL ${label}: wrong error '$($_.Exception.Message)'" } }
  if (-not $threw) { throw "T-FAIL ${label}: expected throw, got success" }
  Write-Host "PASS $label"; $script:passes++
}

# T1 THE LIE DETECTOR: delete-concurrency exits 0 but state stays reserved=0 -> ungate must throw
Set-MockState @{ concurrency = @{ "fn-a" = 0 }; rule = "DISABLED"; lie_on_delete_concurrency = $true }
Expect-Throw { Remove-MaintenanceGate @("fn-a") } "NOT verified" "T1 lying delete-concurrency is caught by read-back"

# T2 delete fails outright (AccessDenied/network) -> must throw, never "no concurrency setting"
Set-MockState @{ concurrency = @{ "fn-a" = 0 }; rule = "DISABLED"; fail = @{ "lambda delete-function-concurrency" = $true } }
Expect-Throw { Remove-MaintenanceGate @("fn-a") } "cutover step failed" "T2 delete failure is fatal, not tolerated"

# T3 honest ungate passes; gate read-back mismatch throws
Set-MockState @{ concurrency = @{ "fn-a" = 0 }; rule = "DISABLED" }
Remove-MaintenanceGate @("fn-a"); Write-Host "PASS T3a honest ungate verifies clean"; $passes++
Set-MockState @{ concurrency = @{ "fn-a" = $null }; rule = "DISABLED"; fail = @{ "lambda put-function-concurrency" = $true } }
Expect-Throw { Set-MaintenanceGate @("fn-a") } "cutover step failed" "T3b gate put failure is fatal"

# T4 rule transitions are read back; sticking state is caught
Set-MockState @{ concurrency = @{}; rule = "ENABLED"; stick_rule = "ENABLED" }
Expect-Throw { Set-RuleState "r" "DISABLED" } "expected DISABLED" "T4a rule stuck ENABLED after disable is caught"
Set-MockState @{ concurrency = @{}; rule = "ENABLED" }
Set-RuleState "r" "DISABLED"; Write-Host "PASS T4b honest disable verifies"; $passes++
Set-MockState @{ concurrency = @{}; rule = $null }
Set-RuleState "r" "DISABLED"; Write-Host "PASS T4c rule absent on first deploy tolerated for DISABLE only"; $passes++
Expect-Throw { Set-RuleState "r" "ENABLED" } "unreadable|state" "T4d rule absent on ENABLE is fatal"

# T5 phase-aware rollback decisions
$mk = { param($phase, $lastGood) [pscustomobject]@{ phase = $phase; artifact_key = "artifacts/x.zip"; identity = "id-new"; last_good = $lastGood } }
Expect-Throw { Resolve-RollbackTarget (& $mk "post-backfill" ([pscustomobject]@{ artifact_key = "artifacts/prev.zip"; identity = "id-old" })) } "ROLLBACK REFUSED.*backfilled" "T5a post-backfill rollback refused"
Expect-Throw { Resolve-RollbackTarget (& $mk "complete" ([pscustomobject]@{ artifact_key = "artifacts/prev.zip"; identity = "id-old" })) } "ROLLBACK REFUSED" "T5b complete-phase rollback refused"
Expect-Throw { Resolve-RollbackTarget (& $mk "gated" $null) } "no last_good" "T5c no last_good refused"
Expect-Throw { Resolve-RollbackTarget $null } "no cutover state" "T5d missing state refused"
$t = Resolve-RollbackTarget (& $mk "code-swapped" ([pscustomobject]@{ artifact_key = "artifacts/prev.zip"; identity = "id-old" }))
if ($t.artifact_key -ne "artifacts/prev.zip") { throw "T5e wrong target" }
Write-Host "PASS T5e pre-backfill rollback resolves last_good"; $passes++

# T6 state round-trip through mock s3 (content survives, phase readable)
Set-MockState @{ concurrency = @{}; rule = "DISABLED" }
Set-CutoverState "b" ([pscustomobject]@{ phase = "gated"; artifact_key = "artifacts/a.zip"; artifact_sha256 = "s"; identity = "i"; last_good = $null; updated_at = "" })
$got = Get-CutoverState "b"
if ($got.phase -ne "gated" -or $got.artifact_key -ne "artifacts/a.zip") { throw "T6 state round-trip mismatch" }
Write-Host "PASS T6 cutover state persists and reads back"; $passes++

Remove-Item $tmp -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
Write-Host ("ALL CUTOVER STATE-MACHINE RED GATES PASSED (" + $passes + " checks)")
