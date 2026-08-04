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

# T7 state absence must be PROVEN: read AccessDenied is fatal, verified-absent returns null
Set-MockState @{ concurrency = @{}; rule = "DISABLED"; fail = @{ "s3api list-objects-v2" = $true } }
Expect-Throw { Get-CutoverState "b" } "absence must be verifiable" "T7a state list AccessDenied is fatal, not first-deploy"
Set-MockState @{ concurrency = @{}; rule = "DISABLED" }
Remove-Item (Join-Path $env:TIDEMARK_MOCK_S3DIR "cutover-state.json") -Force -Confirm:$false -ErrorAction SilentlyContinue
if ($null -ne (Get-CutoverState "b")) { throw "T7b expected null for verified-absent state" }
Write-Host "PASS T7b verified-absent state returns null"; $passes++
Set-MockState @{ concurrency = @{}; rule = "DISABLED"; fail = @{ "s3 cp" = $true } }
[IO.File]::WriteAllText((Join-Path $env:TIDEMARK_MOCK_S3DIR "cutover-state.json"), '{"phase":"gated"}', (New-Object Text.UTF8Encoding($false)))
Expect-Throw { Get-CutoverState "b" } "could not be fetched" "T7c state exists but unreadable is fatal"

# T8 rule double-failure must NOT be mistaken for first deploy
Set-MockState @{ concurrency = @{}; rule = "ENABLED"; fail = @{ "events disable-rule" = $true; "events describe-rule" = $true } }
Expect-Throw { Set-RuleState "r" "DISABLED" } "unreadable" "T8a rule disable+describe double-failure is fatal (list proves it exists)"
Set-MockState @{ concurrency = @{}; rule = "ENABLED"; fail = @{ "events disable-rule" = $true; "events describe-rule" = $true; "events list-rules" = $true } }
Expect-Throw { Set-RuleState "r" "DISABLED" } "absence must be verifiable" "T8b triple network failure is fatal, never first-deploy"

# T9 backfill-started refuses rollback (the irreversible line moved EARLIER, round-5 P1-1)
Expect-Throw { Resolve-RollbackTarget ([pscustomobject]@{ phase = "backfill-started"; identity = "id-new"; last_good = [pscustomobject]@{ artifact_key = "artifacts/prev.zip"; identity = "id-old" } }) } "ROLLBACK REFUSED" "T9 backfill-started (partial backfill) refuses rollback"

# T10 phase resume is monotonic: no regression past the irreversible line
$r1 = Resolve-InitialPhase ([pscustomobject]@{ phase = "backfill-started"; cutover_id = "abc" })
if ($r1.phase -ne "backfill-started" -or $r1.cutover_id -ne "abc") { throw "T10a regression: got $($r1.phase)" }
Write-Host "PASS T10a rerun after partial backfill resumes at backfill-started (same cutover)"; $passes++
$r2 = Resolve-InitialPhase ([pscustomobject]@{ phase = "post-backfill"; cutover_id = "abc" })
if ($r2.phase -ne "backfill-started" -or $r2.cutover_id -ne "abc") { throw "T10b regression" }
Write-Host "PASS T10b rerun after post-backfill stays roll-forward-only"; $passes++
$r3 = Resolve-InitialPhase ([pscustomobject]@{ phase = "complete"; cutover_id = "abc" })
if ($r3.phase -ne "gated" -or $r3.cutover_id -eq "abc") { throw "T10c completed cutover must start FRESH" }
Write-Host "PASS T10c completed prior starts a fresh cutover (new id, gated)"; $passes++
$r4 = Resolve-InitialPhase ([pscustomobject]@{ phase = "code-swapped"; cutover_id = "abc" })
if ($r4.phase -ne "gated" -or $r4.cutover_id -ne "abc") { throw "T10d pre-backfill resume wrong" }
Write-Host "PASS T10d pre-backfill death resumes same cutover at gated (rollback still legal)"; $passes++

# T11 partial ungate re-gates what it already opened (round-4 P2 honesty)
Set-MockState @{ concurrency = @{ "fn-a" = 0; "fn-b" = 0 }; rule = "DISABLED"; fail_after = @{ "lambda delete-function-concurrency" = 1 } }
Expect-Throw { Remove-MaintenanceGate @("fn-a", "fn-b") } "cutover step failed" "T11a partial ungate throws"
$after = (Get-Content $statePath -Raw | ConvertFrom-Json).concurrency."fn-a"
if ($after -ne 0) { throw "T11b fn-a was left ungated after partial failure (got '$after')" }
Write-Host "PASS T11b partial ungate re-gated the opened function (no half-open service)"; $passes++

# T12 state write is read back (phase reconciliation)
Set-MockState @{ concurrency = @{}; rule = "DISABLED" }
Set-CutoverState "b" ([pscustomobject]@{ phase = "backfill-started"; cutover_id = "x"; artifact_key = "artifacts/a.zip"; artifact_sha256 = "s"; identity = "i"; last_good = $null; updated_at = "" })
$got2 = Get-CutoverState "b"
if ($got2.phase -ne "backfill-started") { throw "T12 read-back mismatch" }
Write-Host "PASS T12 state write verified by read-back"; $passes++

# T13 ordering contract (round-6 P1): deploy.ps1 persists backfill-started UNCONDITIONALLY
# before the real backfill invocation -- no dry-run conditional may guard it. Textual gate:
# brittle by nature, but the ordering is a script-order property and this catches regressions.
$deploySrc = Get-Content (Join-Path $here "deploy.ps1") -Raw
$phaseIdx = $deploySrc.IndexOf('$state.phase = "backfill-started"')
$runIdx = $deploySrc.IndexOf('node --env-file=$envFile migrations/backfill-embeddings.mjs --database $prodDb')
if ($phaseIdx -lt 0 -or $runIdx -lt 0) { throw "T13 anchors missing in deploy.ps1" }
if ($phaseIdx -gt $runIdx) { throw "T13 backfill-started is persisted AFTER the real backfill invocation" }
if ($deploySrc -match 'dry-run[\s\S]{0,400}\$state\.phase = "backfill-started"') { throw "T13 phase write appears to be guarded by a dry-run conditional again" }
Write-Host "PASS T13 irreversible phase is unconditional and precedes the real backfill"; $passes++

# T14 'delete succeeded but read-back failed' re-gates ALL functions (round-6 P2)
Set-MockState @{ concurrency = @{ "fn-a" = 0; "fn-b" = 0 }; rule = "DISABLED"; fail_after = @{ "lambda get-function-concurrency" = 0 } }
Expect-Throw { Remove-MaintenanceGate @("fn-a", "fn-b") } "cutover step failed" "T14a readback failure during ungate throws"
$st14 = Get-Content $statePath -Raw | ConvertFrom-Json
if ($st14.concurrency."fn-a" -ne 0 -or $st14.concurrency."fn-b" -ne 0) { throw "T14b not all functions re-gated (a=$($st14.concurrency.'fn-a') b=$($st14.concurrency.'fn-b'))" }
Write-Host "PASS T14b readback failure re-gated ALL functions (no untracked half-open)"; $passes++

Remove-Item $tmp -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
Write-Host ("ALL CUTOVER STATE-MACHINE RED GATES PASSED (" + $passes + " checks)")
