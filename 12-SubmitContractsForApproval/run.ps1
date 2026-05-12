#Requires -Version 5.0
<#
.SYNOPSIS
    Looks up Fusion ContractIds by ContractNumber, submits for approval, then signs.

.DESCRIPTION
    Reads CR-SOW_Master-PROD.csv from the metadata directory.

    Phase 0: For each row, looks up the Fusion ContractId via the contracts API
             using the ContractNumber column.
    Phase 1: Submits each contract for approval (POST .../action/submitForApproval)
             in parallel batches of 5.
    Phase 2: After user confirmation, signs each contract (POST .../action/sign)
             in parallel batches of 5.

    Writes a timestamped copy of the CSV to the logs directory with columns:
        FusionContractId, LookupResult, SubmitResult, SignResult
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$CommonDir  = Join-Path (Split-Path -Parent $ScriptDir) '_common'

Import-Module (Join-Path $CommonDir 'OracleFusionCommon.psm1') -Force

$LogDir       = Join-Path $ScriptDir 'logs'
$LogPath      = New-TimestampedLogPath -LogDirectory $LogDir -BaseName 'ContractCleanup'
$SettingsPath = Join-Path $ScriptDir '.settings'

# ---------------------------------------------------------------------------
# Load settings
# ---------------------------------------------------------------------------

$settings = Read-ScriptSettings -SettingsPath $SettingsPath

$headers         = Get-BasicAuthHeader -Username $settings.Username -Password $settings.Password
$maxRetries      = [int]$settings.MaxRetries
$retryBaseline   = [int]$settings.RetryBaselineSeconds
$baseContractsUrl = $settings.BaseUrl.TrimEnd('/') + $settings.ApiPath.TrimEnd('/')

Write-ScriptLog -LogPath $LogPath -Message "ContractCleanup started." -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message "Base contracts URL: $baseContractsUrl" -Level 'INFO'

# ---------------------------------------------------------------------------
# Sanity check
# ---------------------------------------------------------------------------

$sanityUrl = "$baseContractsUrl`?limit=1"
$ok = Test-ApiSanityCheck -Headers $headers -Url $sanityUrl -LogPath $LogPath
if (-not $ok) {
    Write-ScriptLog -LogPath $LogPath -Message "Sanity check failed. Aborting." -Level 'ERROR'
    exit 1
}

# ---------------------------------------------------------------------------
# User prompts
# ---------------------------------------------------------------------------

$debugMode = Get-DebugModeChoice
Write-ScriptLog -LogPath $LogPath -Message "DebugMode: $debugMode" -Level 'INFO'

# ---------------------------------------------------------------------------
# Read CSV
# ---------------------------------------------------------------------------

$repoRoot    = $ScriptDir | Split-Path -Parent | Split-Path -Parent
$csvPath     = Join-Path $repoRoot 'metadata\CR-SOW_Master-PROD.csv'

if (-not (Test-Path $csvPath)) {
    Write-ScriptLog -LogPath $LogPath -Message "CSV not found: $csvPath" -Level 'ERROR'
    exit 1
}

$rows = Import-Csv -Path $csvPath -ErrorAction Stop
Write-ScriptLog -LogPath $LogPath -Message "Loaded $($rows.Count) rows from $csvPath" -Level 'INFO'

# ---------------------------------------------------------------------------
# Helper: Invoke parallel POST actions in batches of 5 using runspace pool
# ---------------------------------------------------------------------------

function Invoke-ActionBatches {
    <#
    .SYNOPSIS
        Fires POST action calls in parallel batches using a runspace pool.
    .PARAMETER Items
        Array of hashtables with keys: ContractNumber, FusionContractId, Index (row index).
    .PARAMETER ActionName
        Action endpoint name (e.g. 'submitForApproval', 'sign').
    .OUTPUTS
        Hashtable keyed by row Index -> @{ Success = [bool]; Detail = [string] }
    #>
    param(
        [array]    $Items,
        [string]   $ActionName,
        [string]   $BaseUrl,
        [string]   $Username,
        [string]   $Password,
        [int]      $MaxRetries,
        [int]      $RetryBaseline,
        [int]      $PoolSize,
        [string]   $LogPath,
        [bool]     $DebugMode
    )

    $results = @{}

    # Filter to items that have a valid FusionContractId
    $validItems = @($Items | Where-Object { $_.FusionContractId -gt 0 })
    $skippedItems = @($Items | Where-Object { $_.FusionContractId -le 0 -or $null -eq $_.FusionContractId })

    foreach ($skip in $skippedItems) {
        $results[$skip.Index] = @{ Success = $false; Detail = 'SKIPPED - no FusionContractId' }
        Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] SKIP ContractNumber=$($skip.ContractNumber) - no FusionContractId." -Level 'WARN'
    }

    if ($validItems.Count -eq 0) {
        Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] No valid items to process." -Level 'WARN'
        return $results
    }

    if ($DebugMode) {
        foreach ($item in $validItems) {
            $url = "$BaseUrl/$($item.FusionContractId)/action/$ActionName"
            Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] [DEBUG] Would POST $url" -Level 'DEBUG'
            $results[$item.Index] = @{ Success = $true; Detail = 'SIMULATED' }
        }
        return $results
    }

    # Build auth header value once
    $authBytes   = [System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}")
    $authEncoded = [System.Convert]::ToBase64String($authBytes)

    # Scriptblock executed in each runspace
    $scriptBlock = {
        param($Url, $AuthEncoded, $MaxRetries, $RetryBaseline)

        $hdrs = @{
            'Authorization' = "Basic $AuthEncoded"
            'Content-Type'  = 'application/vnd.oracle.adf.action+json'
            'Accept'        = 'application/json'
        }

        $attempt   = 0
        $lastError = ''
        $lastCode  = 0

        while ($attempt -lt $MaxRetries) {
            $attempt++
            try {
                $resp = Invoke-RestMethod -Uri $Url -Method POST -Headers $hdrs -ErrorAction Stop
                return @{
                    Success  = $true
                    Detail   = 'OK'
                    Response = ($resp | ConvertTo-Json -Depth 5 -Compress)
                    Url      = $Url
                }
            }
            catch [System.Net.WebException] {
                $webResp = $_.Exception.Response
                $lastError = $_.Exception.Message
                if ($null -ne $webResp) {
                    $lastCode = [int]$webResp.StatusCode
                    try {
                        $sr = New-Object System.IO.StreamReader($webResp.GetResponseStream())
                        $body = $sr.ReadToEnd(); $sr.Close()
                        $lastError = "HTTP $lastCode - $body"
                    } catch {}
                }
                if ($lastCode -eq 401 -or $lastCode -eq 403) { break }
            }
            catch {
                $lastError = $_.Exception.Message
            }

            if ($attempt -lt $MaxRetries) {
                Start-Sleep -Seconds ([int]([Math]::Pow(2, $attempt - 1) * $RetryBaseline))
            }
        }

        return @{
            Success  = $false
            Detail   = $lastError
            Response = $null
            Url      = $Url
        }
    }

    # Process in batches using runspace pool
    $pool = [RunspaceFactory]::CreateRunspacePool(1, $PoolSize)
    $pool.Open()

    $totalBatches = [Math]::Ceiling($validItems.Count / $PoolSize)
    $batchNum = 0

    for ($i = 0; $i -lt $validItems.Count; $i += $PoolSize) {
        $batchNum++
        $batchEnd  = [Math]::Min($i + $PoolSize - 1, $validItems.Count - 1)
        $batch     = $validItems[$i..$batchEnd]

        Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] Batch $batchNum/$totalBatches ($($batch.Count) items)..." -Level 'INFO'

        $runspaces = @()

        foreach ($item in $batch) {
            $url = "$BaseUrl/$($item.FusionContractId)/action/$ActionName"
            Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] POST $url (ContractNumber=$($item.ContractNumber))" -Level 'REQUEST'

            $ps = [powershell]::Create()
            $ps.RunspacePool = $pool
            $null = $ps.AddScript($scriptBlock).
                        AddArgument($url).
                        AddArgument($authEncoded).
                        AddArgument($MaxRetries).
                        AddArgument($RetryBaseline)

            $handle = $ps.BeginInvoke()
            $runspaces += @{ PS = $ps; Handle = $handle; Item = $item; Url = $url }
        }

        # Collect results for this batch
        foreach ($rs in $runspaces) {
            $res = $rs.PS.EndInvoke($rs.Handle)

            # EndInvoke returns a collection; get the first item
            $r = $res | Select-Object -First 1

            if ($null -eq $r) {
                $r = @{ Success = $false; Detail = 'No result from runspace'; Response = $null; Url = $rs.Url }
            }

            if ($r.Success) {
                Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] OK ContractNumber=$($rs.Item.ContractNumber) FusionId=$($rs.Item.FusionContractId)" -Level 'RESPONSE'
                if ($r.Response) {
                    Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] Response: $($r.Response)" -Level 'RESPONSE'
                }
            }
            else {
                Write-ScriptLog -LogPath $LogPath -Message "[$ActionName] FAILED ContractNumber=$($rs.Item.ContractNumber) FusionId=$($rs.Item.FusionContractId) - $($r.Detail)" -Level 'ERROR'
            }

            $results[$rs.Item.Index] = @{ Success = $r.Success; Detail = $r.Detail }
            $rs.PS.Dispose()
        }
    }

    $pool.Close()
    $pool.Dispose()

    return $results
}

# ---------------------------------------------------------------------------
# Phase 0: Look up FusionContractId for each ContractNumber
# ---------------------------------------------------------------------------

Write-ScriptLog -LogPath $LogPath -Message "=== Phase 0: Looking up Fusion ContractIds ===" -Level 'INFO'

# Prepare tracking array
$tracker = [System.Collections.Generic.List[hashtable]]::new()

for ($idx = 0; $idx -lt $rows.Count; $idx++) {
    $row            = $rows[$idx]
    $contractNumber = $row.ContractNumber

    if ([string]::IsNullOrWhiteSpace($contractNumber)) {
        Write-ScriptLog -LogPath $LogPath -Message "Row $idx - empty ContractNumber, skipping." -Level 'WARN'
        $tracker.Add(@{
            Index            = $idx
            ContractNumber   = ''
            FusionContractId = 0
            LookupResult     = 'SKIP - empty ContractNumber'
            SubmitResult     = ''
            SignResult        = ''
        })
        continue
    }

    $lookupUrl = "$baseContractsUrl`?q=ContractNumber='$contractNumber'&fields=ContractId&onlyData=true"

    $result = Invoke-ApiWithRetry `
        -Headers              $headers `
        -Url                  $lookupUrl `
        -Method               'GET' `
        -MaxRetries           $maxRetries `
        -RetryBaselineSeconds $retryBaseline `
        -LogPath              $LogPath `
        -DebugMode            $false

    $fusionId     = 0
    $lookupDetail = ''

    if (-not $result.Success) {
        $lookupDetail = "FAIL - HTTP $($result.StatusCode) - $($result.ErrorDetail)"
        Write-ScriptLog -LogPath $LogPath -Message "Row $idx ContractNumber=$contractNumber - Lookup FAILED: $lookupDetail" -Level 'ERROR'
    }
    else {
        $items = $result.Data.items
        if ($null -eq $items -or $items.Count -eq 0) {
            $lookupDetail = 'FAIL - not found in Fusion'
            Write-ScriptLog -LogPath $LogPath -Message "Row $idx ContractNumber=$contractNumber - not found in Fusion." -Level 'WARN'
        }
        elseif ($items.Count -gt 1) {
            $lookupDetail = "FAIL - multiple matches ($($items.Count))"
            Write-ScriptLog -LogPath $LogPath -Message "Row $idx ContractNumber=$contractNumber - multiple matches ($($items.Count)), skipping." -Level 'WARN'
        }
        else {
            $fusionId     = $items[0].ContractId
            $lookupDetail = 'OK'
            Write-ScriptLog -LogPath $LogPath -Message "Row $idx ContractNumber=$contractNumber -> FusionContractId=$fusionId" -Level 'INFO'
        }
    }

    $tracker.Add(@{
        Index            = $idx
        ContractNumber   = $contractNumber
        FusionContractId = $fusionId
        LookupResult     = $lookupDetail
        SubmitResult     = ''
        SignResult       = ''
    })
}

$foundCount   = @($tracker | Where-Object { $_.FusionContractId -gt 0 }).Count
$missingCount = $tracker.Count - $foundCount
Write-ScriptLog -LogPath $LogPath -Message "Lookup complete. Found: $foundCount  |  Missing/Failed: $missingCount" -Level 'INFO'

# ---------------------------------------------------------------------------
# Phase 1: Submit for Approval (batches of 5 in parallel)
# ---------------------------------------------------------------------------

Write-ScriptLog -LogPath $LogPath -Message "=== Phase 1: Submit for Approval ===" -Level 'INFO'

$submitResults = Invoke-ActionBatches `
    -Items         $tracker.ToArray() `
    -ActionName    'submitForApproval' `
    -BaseUrl       $baseContractsUrl `
    -Username      $settings.Username `
    -Password      $settings.Password `
    -MaxRetries    $maxRetries `
    -RetryBaseline $retryBaseline `
    -PoolSize      5 `
    -LogPath       $LogPath `
    -DebugMode     $debugMode

# Record results
$submitOk   = 0
$submitFail = 0
foreach ($t in $tracker) {
    if ($submitResults.ContainsKey($t.Index)) {
        $r = $submitResults[$t.Index]
        $t.SubmitResult = if ($r.Success) { 'OK' } else { "FAIL - $($r.Detail)" }
        if ($r.Success) { $submitOk++ } else { $submitFail++ }
    }
    else {
        $t.SubmitResult = 'NOT PROCESSED'
    }
}

Write-ScriptLog -LogPath $LogPath -Message "Submit complete. OK: $submitOk  |  Failed: $submitFail" -Level 'INFO'

# ---------------------------------------------------------------------------
# Pause: Wait for user to press spacebar
# ---------------------------------------------------------------------------

Write-ScriptLog -LogPath $LogPath -Message "Phase 1 complete. Waiting for user to continue..." -Level 'INFO'
Write-Host ''
Write-Host '====================================================' -ForegroundColor Yellow
Write-Host '  Phase 1 (Submit for Approval) complete.'           -ForegroundColor Yellow
Write-Host '  Press SPACEBAR to continue to Phase 2 (Sign)...'   -ForegroundColor Yellow
Write-Host '====================================================' -ForegroundColor Yellow
Write-Host ''

do {
    $key = [System.Console]::ReadKey($true)
} while ($key.Key -ne [System.ConsoleKey]::Spacebar)

Write-ScriptLog -LogPath $LogPath -Message "User confirmed. Proceeding to Phase 2." -Level 'INFO'

# ---------------------------------------------------------------------------
# Phase 2: Sign (batches of 5 in parallel)
# ---------------------------------------------------------------------------

Write-ScriptLog -LogPath $LogPath -Message "=== Phase 2: Sign ===" -Level 'INFO'

$signResults = Invoke-ActionBatches `
    -Items         $tracker.ToArray() `
    -ActionName    'sign' `
    -BaseUrl       $baseContractsUrl `
    -Username      $settings.Username `
    -Password      $settings.Password `
    -MaxRetries    $maxRetries `
    -RetryBaseline $retryBaseline `
    -PoolSize      5 `
    -LogPath       $LogPath `
    -DebugMode     $debugMode

# Record results
$signOk   = 0
$signFail = 0
foreach ($t in $tracker) {
    if ($signResults.ContainsKey($t.Index)) {
        $r = $signResults[$t.Index]
        $t.SignResult = if ($r.Success) { 'OK' } else { "FAIL - $($r.Detail)" }
        if ($r.Success) { $signOk++ } else { $signFail++ }
    }
    else {
        $t.SignResult = 'NOT PROCESSED'
    }
}

Write-ScriptLog -LogPath $LogPath -Message "Sign complete. OK: $signOk  |  Failed: $signFail" -Level 'INFO'

# ---------------------------------------------------------------------------
# Write output CSV
# ---------------------------------------------------------------------------

$outputCsvPath = New-TimestampedCsvPath -LogDirectory $LogDir -InputFilePath $csvPath

# Add result columns to original rows
for ($idx = 0; $idx -lt $rows.Count; $idx++) {
    $t = $tracker[$idx]
    $rows[$idx] | Add-Member -NotePropertyName 'FusionContractId' -NotePropertyValue $t.FusionContractId -Force
    $rows[$idx] | Add-Member -NotePropertyName 'LookupResult'     -NotePropertyValue $t.LookupResult     -Force
    $rows[$idx] | Add-Member -NotePropertyName 'SubmitResult'     -NotePropertyValue $t.SubmitResult     -Force
    $rows[$idx] | Add-Member -NotePropertyName 'SignResult'       -NotePropertyValue $t.SignResult       -Force
}

$rows | Export-Csv -Path $outputCsvPath -NoTypeInformation -Encoding UTF8
Write-ScriptLog -LogPath $LogPath -Message "Output CSV written: $outputCsvPath" -Level 'INFO'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if ($debugMode) {
    Write-ScriptLog -LogPath $LogPath -Message "DebugMode: no POST calls were issued." -Level 'INFO'
}

Write-ScriptLog -LogPath $LogPath -Message "Done. Lookup: $foundCount found / $missingCount missing  |  Submit: $submitOk ok / $submitFail fail  |  Sign: $signOk ok / $signFail fail" -Level 'INFO'
