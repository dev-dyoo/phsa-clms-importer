#Requires -Version 5.0
<#
.SYNOPSIS
    Import contract documents into Oracle Fusion REST API, driven by the F2
    load list produced by 10-EnrichDocumentFilesList.

.DESCRIPTION
    Input (F2):  ContractDocumentLoadList-<ts>.csv  with columns
        ID, ContractNumber, DocType, ContractId, Title, FileName, FullPath,
        Done, Error, ErrorDescription

    Row selection (the Done column is the authority - this is what lets a
    re-run touch ONLY the files that did not load)
    -------------------------------------------------------------------------
        Done = "TRUE"            -> skipped (loaded this run or a prior one,
                                    or detected as already existing in Oracle)
        Done = "READY"           -> never attempted; uploaded
        Done = "FALSE"           -> attempted before and failed; retried
        Done = blank / anything  -> not a real file row (10-side error rows have
                                    Done="" with Error="True"); skipped
        The Error / ErrorDescription columns are informational only and do NOT
        drive the skip decision.

    Phases
    ------
    1. Sanity check (single GET against the contracts root).

    2. Existence-check phase (optional, default-on):
           For each distinct ContractId among the candidate rows, GET
               contracts/<ContractId>/child/ContractDocuments   (paginated, limit=200)
               contracts/<ContractId>/child/SupportingDocuments (paginated, limit=200)
           and collect every existing UploadedFileName / FileName into a
           case-insensitive HashSet per contract.  (Note: ?fields=UploadedFileName
           is NOT used - that projection returns null on this resource; the full
           item carries the populated value.)

           Any candidate row whose FileName already lives in that contract's
           HashSet is marked:
               Done             = "TRUE"
               Error            = "False"
               ErrorDescription = "Already exists in Oracle (UploadedFileName matched)"
           and is NOT uploaded.

    3. Parallel upload phase (5 workers via RunspacePool).
           For each remaining candidate row, POST
               contracts/<ContractId>/child/<ContractDocuments|SupportingDocuments>
           with the same payload the legacy ImportContractDocuments used:
                DatatypeCode, Title, UploadedFileContentType, UploadedFileName,
                FileContents (base64), Description, FileName, CategoryName

           Title is trimmed to <= 80 chars (keeping the extension) because
           Oracle's Title field is length-limited; UploadedFileName / FileName
           are sent at full length.  The trimmed Title is written back to the
           result CSV.

           DocType -> child resource:
               ContractDoc -> ContractDocuments
               else        -> SupportingDocuments
           DocType -> CategoryName:
               ContractDoc   -> OKC_DOCUMENTS_CONTRACT
               SupportingDoc -> OKC_DOCUMENTS_SUPPORTING_DOC
               Excel         -> PHSA_ITEM_SPREADSHEETS

           On success: Done="TRUE",  Error="False", ErrorDescription=""
           On failure: Done="FALSE", Error="True",  ErrorDescription=<reason>
                       (these are re-attempted on the next run)

    Progress
    --------
    A lightweight progress CSV is appended after every result so the run is
    reconcilable mid-flight: ID, Done, Error, ErrorDescription.  At the end
    a full output CSV is written with the F2 columns, updated.

    Usage
    -----
        .\run.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Bootstrap paths
# ---------------------------------------------------------------------------

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$CommonDir  = Join-Path $ScriptDir '_common'   # shared library lives in 11-ImportContractDocuments/_common
$ModulePath = Join-Path $CommonDir 'OracleFusionCommon.psm1'

if (-not (Test-Path $ModulePath)) {
    Write-Error "Cannot find shared module at: $ModulePath"
    exit 1
}
Import-Module $ModulePath -Force

$SettingsPath  = Join-Path $ScriptDir '.settings'
$LogDir        = Join-Path $ScriptDir 'logs'
$InputDir      = Join-Path $ScriptDir 'input'
$EnrichLogsDir = Join-Path (Split-Path -Parent $ScriptDir) '10-EnrichDocumentFilesList\logs'

New-Item -ItemType Directory -Force -Path $LogDir   | Out-Null
New-Item -ItemType Directory -Force -Path $InputDir | Out-Null

# ---------------------------------------------------------------------------
# Log file
# ---------------------------------------------------------------------------

$LogPath = New-TimestampedLogPath -LogDirectory $LogDir -BaseName 'ImportContractDocuments'
New-Item -ItemType File -Force -Path $LogPath | Out-Null

Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message ' ImportContractDocuments  -  STARTED'    -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'

# ---------------------------------------------------------------------------
# Load settings
# ---------------------------------------------------------------------------

try {
    $settings = Read-ScriptSettings -SettingsPath $SettingsPath
    Write-ScriptLog -LogPath $LogPath -Message "Settings loaded. BaseUrl: $($settings.BaseUrl)" -Level 'INFO'
}
catch {
    Write-ScriptLog -LogPath $LogPath -Message "FATAL: Could not load settings - $($_.Exception.Message)" -Level 'ERROR'
    exit 1
}

$headers          = Get-BasicAuthHeader -Username $settings.Username -Password $settings.Password
$baseContractsUrl = "$($settings.BaseUrl)/$($settings.ApiPath.TrimStart('/'))"
$maxR             = [int]$settings.MaxRetries
$retB             = [int]$settings.RetryBaselineSeconds
Write-ScriptLog -LogPath $LogPath -Message "Contracts base URL: $baseContractsUrl" -Level 'INFO'

# ---------------------------------------------------------------------------
# Sanity check
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Performing sanity check...' -ForegroundColor Yellow
if (-not (Test-ApiSanityCheck -Headers $headers -Url $baseContractsUrl -LogPath $LogPath)) {
    Write-Host 'Sanity check failed. Review the log and correct your .settings file.' -ForegroundColor Red
    Write-Host "Log: $LogPath" -ForegroundColor Red
    exit 1
}
Write-Host 'Sanity check passed.' -ForegroundColor Green

# ---------------------------------------------------------------------------
# User prompts
# ---------------------------------------------------------------------------

function Read-PathPrompt {
    param([string]$Label, [string]$Default)
    $a = Read-Host "$Label [ENTER for: $Default]"
    if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
    return $a
}

# Default F2 = newest ContractDocumentLoadList-*.csv in the 10- step's logs/.
$defaultF2 = $null
if (Test-Path $EnrichLogsDir) {
    $newest = Get-ChildItem -Path $EnrichLogsDir -Filter 'ContractDocumentLoadList-*.csv' -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $defaultF2 = $newest.FullName }
}
# Or any *.csv in our own input/ directory.
if (-not $defaultF2 -and (Test-Path $InputDir)) {
    $newest = Get-ChildItem -Path $InputDir -Filter '*.csv' -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { $defaultF2 = $newest.FullName }
}

Write-Host ''
if ($defaultF2) {
    $inputPath = Read-PathPrompt -Label 'Input CSV (F2)' -Default $defaultF2
}
else {
    $inputPath = Read-Host 'Input CSV (F2) path'
}
$inputPath = $inputPath.Trim().Trim('"')
if ([string]::IsNullOrWhiteSpace($inputPath) -or -not (Test-Path -LiteralPath $inputPath)) {
    Write-ScriptLog -LogPath $LogPath -Message "FATAL: Input file not found: $inputPath" -Level 'ERROR'
    exit 1
}
Write-ScriptLog -LogPath $LogPath -Message "F2 (input): $inputPath" -Level 'INFO'

Write-Host ''
$importLimitInput = Read-Host 'How many documents to import? [ENTER for all]'
if ([string]::IsNullOrWhiteSpace($importLimitInput)) {
    $importLimit = 0
}
else {
    $importLimit = [int]$importLimitInput
    if ($importLimit -le 0) {
        Write-Host 'Invalid number. Exiting.' -ForegroundColor Red
        exit 1
    }
}
$importLimitDisplay = if ($importLimit -eq 0) { 'all' } else { $importLimit }
Write-ScriptLog -LogPath $LogPath -Message "Import limit: $importLimitDisplay" -Level 'INFO'

Write-Host ''
$checkChoice = Read-Host 'Run existence-check phase to skip already-loaded docs? (Y/n) [default: Y]'
$runExistenceCheck = [string]::IsNullOrWhiteSpace($checkChoice) -or ($checkChoice -match '^[Yy]')
Write-ScriptLog -LogPath $LogPath -Message "Existence-check phase: $(if ($runExistenceCheck) { 'YES' } else { 'NO' })" -Level 'INFO'

# ---------------------------------------------------------------------------
# MIME type + category maps
# ---------------------------------------------------------------------------

$mimeMap = @{
    '.docm' = 'application/vnd.ms-word.document.macroEnabled.12'
    '.pdf'  = 'application/pdf'
    '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    '.docx' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    '.eml'  = 'message/rfc822'
    '.msg'  = 'application/vnd.ms-outlook'
    '.doc'  = 'application/msword'
    '.xls'  = 'application/vnd.ms-excel'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.zip'  = 'application/zip'
    '.xlsm' = 'application/vnd.ms-excel.sheet.macroEnabled.12'
    '.pptx' = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    '.gif'  = 'image/gif'
    '.ppt'  = 'application/vnd.ms-powerpoint'
    '.tif'  = 'image/tiff'
    '.tiff' = 'image/tiff'
    '.xps'  = 'application/vnd.ms-xpsdocument'
    '.bmp'  = 'image/bmp'
    '.txt'  = 'text/plain'
    '.rtf'  = 'application/rtf'
    '.htm'  = 'text/html'
    '.html' = 'text/html'
    '.xlsb' = 'application/vnd.ms-excel.sheet.binary.macroEnabled.12'
    '.url'  = 'text/uri-list'
    '.mht'  = 'message/rfc822'
    '.csv'  = 'text/csv'
    '.prn'  = 'text/plain'
}

function Get-MimeType {
    param([string]$FileName)
    $ext = [System.IO.Path]::GetExtension($FileName).ToLowerInvariant()
    if ($mimeMap.ContainsKey($ext)) { return $mimeMap[$ext] }
    Write-ScriptLog -LogPath $script:LogPath -Message "WARN: Unknown extension '$ext' for '$FileName'. Defaulting to application/octet-stream." -Level 'WARN'
    return 'application/octet-stream'
}

function Get-CategoryName {
    param([string]$DocType)
    switch ($DocType) {
        'ContractDoc'   { return 'OKC_DOCUMENTS_CONTRACT' }
        'SupportingDoc' { return 'OKC_DOCUMENTS_SUPPORTING_DOC' }
        'Excel'         { return 'PHSA_ITEM_SPREADSHEETS' }
        default {
            Write-ScriptLog -LogPath $script:LogPath -Message "WARN: Unknown DocType '$DocType'. Defaulting to OKC_DOCUMENTS_SUPPORTING_DOC." -Level 'WARN'
            return 'OKC_DOCUMENTS_SUPPORTING_DOC'
        }
    }
}

function Get-ChildResource {
    param([string]$DocType)
    if ($DocType -eq 'ContractDoc') { return 'ContractDocuments' }
    return 'SupportingDocuments'
}

# Oracle's ContractDocuments.Title field is limited (HTTP 400 "Title exceeds
# the maximum length allowed" was seen at ~83 chars, so the DB column is
# almost certainly VARCHAR2(80)).  UploadedFileName / FileName were accepted at
# full length, so only Title needs trimming - keep the extension if it fits.
$script:MaxTitleLength = 80

function Get-SafeTitle {
    param([string]$Name, [int]$MaxLen = 80)
    if ([string]::IsNullOrEmpty($Name) -or $Name.Length -le $MaxLen) { return $Name }
    $ext = [System.IO.Path]::GetExtension($Name)
    if ($ext.Length -gt 0 -and $ext.Length -le 8 -and ($MaxLen - $ext.Length) -ge 1) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($Name)
        return $base.Substring(0, $MaxLen - $ext.Length) + $ext
    }
    return $Name.Substring(0, $MaxLen)
}

# ---------------------------------------------------------------------------
# Load F2
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Loading F2...' -ForegroundColor Yellow

$detailRows = @(Import-Csv -Path $inputPath -ErrorAction Stop)
if ($detailRows.Count -eq 0) {
    Write-ScriptLog -LogPath $LogPath -Message 'F2 is empty. Nothing to do.' -Level 'WARN'
    exit 0
}

$f2Required = @('ID','ContractNumber','DocType','ContractId','Title','FileName','FullPath','Done','Error','ErrorDescription')
$f2Have     = @($detailRows[0].PSObject.Properties.Name)
foreach ($col in $f2Required) {
    if ($f2Have -notcontains $col) {
        Write-ScriptLog -LogPath $LogPath -Message "FATAL: F2 missing required column '$col'. Columns present: $($f2Have -join ', ')" -Level 'ERROR'
        exit 1
    }
}

Write-ScriptLog -LogPath $LogPath -Message "F2 loaded: $($detailRows.Count) row(s)." -Level 'INFO'
Write-Host "  $($detailRows.Count) row(s) loaded." -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Classify rows
# ---------------------------------------------------------------------------
#
# The Done column is the authority on what to (re-)attempt - this is what makes
# a re-run touch ONLY the files that didn't load:
#
#     Done = "TRUE"            -> already loaded (this run or a prior one); skip.
#     Done = "READY"           -> never attempted; upload.
#     Done = "FALSE"           -> attempted before and failed; retry.
#     Done = blank / anything  -> not a real file row (10-side error rows have
#                                 Done="" with Error="True"); skip.
#
# The Error/ErrorDescription columns are informational only and do NOT drive the
# skip decision - a failed upload row (Done="FALSE", Error="True") must still be
# retried.  We deliberately do NOT Test-Path the FullPath here; over a UNC share
# that takes minutes for thousands of rows.  Workers catch missing files via
# their ReadAllBytes try/catch.

$countTotal           = $detailRows.Count
$countSkipAlreadyDone = 0
$countSkipNotFileRow  = 0
$countSkipMissingInfo = 0
$countRetry           = 0
$candidateIndexes     = [System.Collections.Generic.List[int]]::new()

for ($i = 0; $i -lt $detailRows.Count; $i++) {
    $row = $detailRows[$i]
    $d   = "$($row.Done)".Trim()

    if ($d -eq 'TRUE') { $countSkipAlreadyDone++; continue }     # already loaded

    if ($d -ne 'READY' -and $d -ne 'FALSE') {                    # 10-side error row / not a file row
        $countSkipNotFileRow++
        continue
    }

    # READY (fresh) or FALSE (retry) - it's meant to be uploaded.
    if ([string]::IsNullOrWhiteSpace($row.ContractId) -or [string]::IsNullOrWhiteSpace($row.FullPath)) {
        $row.Done             = 'FALSE'
        $row.Error            = 'True'
        $row.ErrorDescription = if ([string]::IsNullOrWhiteSpace($row.ContractId)) { 'Missing ContractId.' } else { 'Missing FullPath.' }
        $countSkipMissingInfo++
        continue
    }

    if ($d -eq 'FALSE') { $countRetry++ }
    $candidateIndexes.Add($i)
}

$countCandidate = $candidateIndexes.Count
Write-ScriptLog -LogPath $LogPath -Message "Classified - Candidates: $countCandidate (of which retries: $countRetry)  Already-loaded: $countSkipAlreadyDone  Not-a-file-row: $countSkipNotFileRow  Missing ContractId/Path: $countSkipMissingInfo" -Level 'INFO'
Write-Host "  Candidates (to upload) : $countCandidate"        -ForegroundColor Cyan
Write-Host "    of which retries     : $countRetry"            -ForegroundColor Cyan
Write-Host "  Already loaded (skip)  : $countSkipAlreadyDone"  -ForegroundColor Cyan
Write-Host "  Not a file row (skip)  : $countSkipNotFileRow"   -ForegroundColor Cyan
Write-Host "  Missing ContractId/Path: $countSkipMissingInfo"  -ForegroundColor $(if ($countSkipMissingInfo -gt 0) { 'Yellow' } else { 'Cyan' })

# ---------------------------------------------------------------------------
# Existence-check phase
# ---------------------------------------------------------------------------

$existsCache             = @{}      # ContractId -> HashSet[UploadedFileName] (case-insensitive)
$countSkipAlreadyExists  = 0

if ($runExistenceCheck -and $candidateIndexes.Count -gt 0) {
    Write-Host ''
    Write-Host 'Existence-check phase: building per-contract document lists from Oracle...' -ForegroundColor Yellow

    # Distinct ContractIds among current candidates, preserving stable order.
    $cidSeen   = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
    $cidList   = [System.Collections.Generic.List[string]]::new()
    foreach ($idx in $candidateIndexes) {
        $c = "$($detailRows[$idx].ContractId)"
        if ($cidSeen.Add($c)) { $cidList.Add($c) }
    }

    Write-ScriptLog -LogPath $LogPath -Message "Existence check: $($cidList.Count) distinct ContractIds to query." -Level 'INFO'
    Write-Host "  Distinct ContractIds : $($cidList.Count)" -ForegroundColor Cyan

    $existBatchSize = 10

    # Per-worker log files for the existence-check phase.
    $existWorkerLogs = @()
    for ($w = 1; $w -le $existBatchSize; $w++) {
        $wlog = $LogPath -replace '\.log$', "-exist-worker${w}.log"
        New-Item -ItemType File -Force -Path $wlog | Out-Null
        $existWorkerLogs += $wlog
    }

    $existWorkerScript = {
        param(
            [string]   $ContractId,
            [string]   $BaseContractsUrl,
            [hashtable]$Headers,
            [int]      $MaxRetries,
            [int]      $RetryBaseline,
            [string]   $LogPath,
            [string]   $ModulePath
        )
        Import-Module $ModulePath -Force
        $names = [System.Collections.Generic.List[string]]::new()
        foreach ($child in @('ContractDocuments','SupportingDocuments')) {
            # NOTE: do NOT use ?fields=UploadedFileName - on this child resource
            # that projection returns UploadedFileName=null for every item.  Pull
            # the full item (UploadedFileName / FileName are populated there) and
            # use a larger page size to cut down on round trips.
            $pageUrl = "$BaseContractsUrl/$ContractId/child/${child}?limit=200"
            do {
                $res = Invoke-ApiWithRetry -Headers $Headers -Url $pageUrl -Method 'GET' `
                       -MaxRetries $MaxRetries -RetryBaselineSeconds $RetryBaseline `
                       -LogPath $LogPath -DebugMode $false
                if (-not $res.Success) {
                    Write-ScriptLog -LogPath $LogPath -Message "GET failed for $pageUrl - skipping." -Level 'WARN'
                    break
                }
                $data  = $res.Data
                $items = @()
                if ($data -and $data.PSObject.Properties['items'] -and $null -ne $data.items) {
                    $items = @($data.items)
                }
                if ($items.Count -eq 0) { break }
                foreach ($it in $items) {
                    foreach ($attr in @('UploadedFileName','FileName')) {
                        if ($it.PSObject.Properties[$attr]) {
                            $v = "$($it.$attr)"
                            if (-not [string]::IsNullOrWhiteSpace($v)) { $names.Add($v) }
                        }
                    }
                }
                $nextUrl = $null
                $hasMore = $false
                if ($data.PSObject.Properties['hasMore']) { $hasMore = [bool]$data.hasMore }
                if ($hasMore -and $data.PSObject.Properties['links'] -and $null -ne $data.links) {
                    $nl = $data.links | Where-Object { $_.rel -eq 'next' } | Select-Object -First 1
                    if ($nl -and $nl.PSObject.Properties['href'] -and -not [string]::IsNullOrWhiteSpace($nl.href)) {
                        $nextUrl = $nl.href
                    }
                }
                $pageUrl = $nextUrl
            } while ($null -ne $pageUrl)
        }
        return @{ ContractId = $ContractId; FileNames = $names.ToArray() }
    }

    $iss  = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $pool = [runspacefactory]::CreateRunspacePool(1, $existBatchSize, $iss, $Host)
    $pool.Open()

    $idArr             = @($cidList.ToArray())
    $totalExistBatches = [Math]::Ceiling($idArr.Count / $existBatchSize)

    for ($b = 0; $b -lt $idArr.Count; $b += $existBatchSize) {
        $bn  = [Math]::Floor($b / $existBatchSize) + 1
        $be  = [Math]::Min($b + $existBatchSize - 1, $idArr.Count - 1)
        $btc = @($idArr[$b..$be])

        $handles = [System.Collections.Generic.List[hashtable]]::new()
        for ($j = 0; $j -lt $btc.Count; $j++) {
            $cid  = $btc[$j]
            $wlog = $existWorkerLogs[$j]
            $ps   = [PowerShell]::Create()
            $ps.RunspacePool = $pool
            [void]$ps.AddScript($existWorkerScript)
            [void]$ps.AddParameter('ContractId',       $cid)
            [void]$ps.AddParameter('BaseContractsUrl', $baseContractsUrl)
            [void]$ps.AddParameter('Headers',          $headers)
            [void]$ps.AddParameter('MaxRetries',       $maxR)
            [void]$ps.AddParameter('RetryBaseline',    $retB)
            [void]$ps.AddParameter('LogPath',          $wlog)
            [void]$ps.AddParameter('ModulePath',       $ModulePath)
            $handles.Add(@{ PS = $ps; Handle = $ps.BeginInvoke(); ContractId = $cid })
        }
        foreach ($h in $handles) {
            $wr = $null
            try {
                $out = $h.PS.EndInvoke($h.Handle)
                if ($out -and $out.Count -gt 0) { $wr = $out[$out.Count - 1] }
            }
            catch {
                Write-ScriptLog -LogPath $LogPath -Message "Existence-check worker exception for $($h.ContractId): $($_.Exception.Message)" -Level 'ERROR'
            }
            if ($h.PS.HadErrors) {
                foreach ($e in $h.PS.Streams.Error) {
                    Write-ScriptLog -LogPath $LogPath -Message "Worker stream error ($($h.ContractId)): $($e.Exception.Message)" -Level 'ERROR'
                }
            }
            $h.PS.Dispose()
            $set = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
            if ($wr -and $wr.FileNames) {
                foreach ($n in $wr.FileNames) { [void]$set.Add($n) }
            }
            $existsCache[$h.ContractId] = $set
        }
        Write-Host "  Existence-check batch $bn/$totalExistBatches done." -ForegroundColor Cyan
        Write-ScriptLog -LogPath $LogPath -Message "Existence-check batch $bn/$totalExistBatches done." -Level 'INFO'
    }
    $pool.Close(); $pool.Dispose()

    $totalExistingNames = 0
    foreach ($v in $existsCache.Values) { $totalExistingNames += $v.Count }
    Write-ScriptLog -LogPath $LogPath -Message "Existence-check done. Cached $totalExistingNames existing UploadedFileName(s) across $($existsCache.Count) ContractIds." -Level 'INFO'

    # Apply: mark already-existing candidates.
    $remaining = [System.Collections.Generic.List[int]]::new()
    foreach ($idx in $candidateIndexes) {
        $row = $detailRows[$idx]
        $cid = "$($row.ContractId)"
        $fn  = "$($row.FileName)"
        if ([string]::IsNullOrWhiteSpace($fn)) {
            $remaining.Add($idx)                # let the worker fail it informatively
            continue
        }
        if ($existsCache.ContainsKey($cid) -and $existsCache[$cid].Contains($fn)) {
            $row.Done             = 'TRUE'
            $row.Error            = 'False'
            $row.ErrorDescription = 'Already exists in Oracle (UploadedFileName matched)'
            $countSkipAlreadyExists++
        }
        else {
            $remaining.Add($idx)
        }
    }
    $candidateIndexes = $remaining

    Write-ScriptLog -LogPath $LogPath -Message "Skipping $countSkipAlreadyExists already-existing document(s). Remaining to upload: $($candidateIndexes.Count)" -Level 'INFO'
    Write-Host "  Already in Oracle    : $countSkipAlreadyExists" -ForegroundColor Cyan
    Write-Host "  Remaining to upload  : $($candidateIndexes.Count)" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# Apply import limit
# ---------------------------------------------------------------------------

$workIndexes = [System.Collections.Generic.List[int]]::new()
$rowsSent    = 0
foreach ($idx in $candidateIndexes) {
    if ($importLimit -gt 0 -and $rowsSent -ge $importLimit) { break }
    $workIndexes.Add($idx)
    $rowsSent++
}
$countDeferred = $candidateIndexes.Count - $workIndexes.Count
if ($countDeferred -gt 0) {
    Write-ScriptLog -LogPath $LogPath -Message "Import limit of $importLimit reached. $countDeferred row(s) deferred." -Level 'INFO'
}

# Build work items
$titleTrimmedCount = 0
$workItems = [System.Collections.Generic.List[hashtable]]::new()
foreach ($idx in $workIndexes) {
    $row = $detailRows[$idx]
    $childResource = Get-ChildResource -DocType $row.DocType

    # Oracle's Title field is length-limited; trim it (keep the extension) and
    # write the trimmed value back so the result CSV records what was sent.
    $origTitle = "$($row.Title)"
    $safeTitle = Get-SafeTitle -Name $origTitle -MaxLen $script:MaxTitleLength
    if ($safeTitle -ne $origTitle) {
        $row.Title = $safeTitle
        $titleTrimmedCount++
        Write-ScriptLog -LogPath $LogPath -Message "Row ${idx}: Title trimmed to $($safeTitle.Length) chars to fit Oracle limit (was $($origTitle.Length))." -Level 'INFO'
    }

    $workItems.Add(@{
        RowIndex     = $idx
        ContractId   = "$($row.ContractId)"
        Url          = "$baseContractsUrl/$($row.ContractId)/child/$childResource"
        FileName     = "$($row.FileName)"
        FullPath     = "$($row.FullPath)"
        Title        = $safeTitle
        MimeType     = Get-MimeType -FileName "$($row.FileName)"
        CategoryName = Get-CategoryName -DocType $row.DocType
    })
}
if ($titleTrimmedCount -gt 0) {
    Write-ScriptLog -LogPath $LogPath -Message "$titleTrimmedCount Title(s) trimmed to <= $($script:MaxTitleLength) chars." -Level 'INFO'
    Write-Host "  Titles trimmed (>$($script:MaxTitleLength) chars) : $titleTrimmedCount" -ForegroundColor Cyan
}

Write-Host ''
Write-Host "  Work items to upload : $($workItems.Count)" -ForegroundColor Cyan
Write-ScriptLog -LogPath $LogPath -Message "Work items to upload: $($workItems.Count)" -Level 'INFO'

# ---------------------------------------------------------------------------
# Output CSV path + progress file
# ---------------------------------------------------------------------------

$outputCsvPath   = New-TimestampedCsvPath -LogDirectory $LogDir -InputFilePath $inputPath
$progressCsvPath = $outputCsvPath -replace '\.csv$', '-progress.csv'
Set-Content -Path $progressCsvPath -Value '"ID","Done","Error","ErrorDescription"' -Encoding UTF8
Write-ScriptLog -LogPath $LogPath -Message "Output CSV:   $outputCsvPath"   -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message "Progress CSV: $progressCsvPath" -Level 'INFO'

$csvColumns = @('ID','ContractNumber','DocType','ContractId','Title','FileName','FullPath','Done','Error','ErrorDescription')

function Add-ProgressRow {
    # $ErrorFlag rather than $Error - $Error is an automatic variable.
    param([string]$Id, [string]$Done, [string]$ErrorFlag, [string]$ErrorDescription)
    $esc  = '"' + ($ErrorDescription -replace '"', '""') + '"'
    $line = '"' + $Id + '","' + $Done + '","' + $ErrorFlag + '",' + $esc
    for ($i = 1; $i -le 6; $i++) {
        try {
            Add-Content -Path $progressCsvPath -Value $line -Encoding UTF8 -ErrorAction Stop
            return
        }
        catch [System.IO.IOException] {
            if ($i -lt 6) { Start-Sleep -Milliseconds (50 * $i) }
        }
        catch {
            Write-Host "[PROGRESS WRITE ERROR] $($_.Exception.Message) | $line" -ForegroundColor DarkRed
            return
        }
    }
    Write-Host "[PROGRESS WRITE LOST] $line" -ForegroundColor DarkRed
}

# Pre-write progress for every row that will NOT go through the upload phase
# (already-done, error-true, already-exists, missing-cid, deferred).
$workIndexSet = New-Object System.Collections.Generic.HashSet[int]
foreach ($i in $workIndexes) { [void]$workIndexSet.Add($i) }
for ($i = 0; $i -lt $detailRows.Count; $i++) {
    if ($workIndexSet.Contains($i)) { continue }
    $row = $detailRows[$i]
    Add-ProgressRow -Id "$($row.ID)" -Done "$($row.Done)" -ErrorFlag "$($row.Error)" -ErrorDescription "$($row.ErrorDescription)"
}

# ---------------------------------------------------------------------------
# Exit early if nothing to upload
# ---------------------------------------------------------------------------

if ($workItems.Count -eq 0) {
    $detailRows | Select-Object $csvColumns | Export-Csv -Path $outputCsvPath -NoTypeInformation -Encoding UTF8
    Write-ScriptLog -LogPath $LogPath -Message 'No work items to upload. Done.' -Level 'INFO'
    Write-Host ''
    Write-Host 'Nothing to upload.' -ForegroundColor Green
    Write-Host "  Log:           $LogPath"        -ForegroundColor Green
    Write-Host "  Progress CSV:  $progressCsvPath" -ForegroundColor Green
    Write-Host "  Result CSV:    $outputCsvPath"  -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# Worker log files (upload phase)
# ---------------------------------------------------------------------------

$batchSize      = 5
$workerLogPaths = @()
for ($w = 1; $w -le $batchSize; $w++) {
    $wpath = $LogPath -replace '\.log$', "-upload-worker${w}.log"
    New-Item -ItemType File -Force -Path $wpath | Out-Null
    $workerLogPaths += $wpath
}

Write-ScriptLog -LogPath $LogPath -Message "Upload worker log files created ($batchSize workers)." -Level 'INFO'

# ---------------------------------------------------------------------------
# Upload worker scriptblock
# ---------------------------------------------------------------------------

$workerScript = {
    param(
        [hashtable] $WorkItem,
        [hashtable] $Headers,
        [int]       $MaxRetries,
        [int]       $RetryBaselineSeconds,
        [string]    $LogPath,
        [string]    $ModulePath
    )
    Import-Module $ModulePath -Force

    $fileName = $WorkItem.FileName
    $fullPath = $WorkItem.FullPath

    Write-ScriptLog -LogPath $LogPath -Message "--- Row $($WorkItem.RowIndex): ContractId=$($WorkItem.ContractId) File=$fileName" -Level 'INFO'

    try {
        $fileBytes  = [System.IO.File]::ReadAllBytes($fullPath)
        $fileBase64 = [System.Convert]::ToBase64String($fileBytes)
    }
    catch {
        Write-ScriptLog -LogPath $LogPath -Message "ERROR: Cannot read file '$fullPath' - $($_.Exception.Message)" -Level 'ERROR'
        return @{ RowIndex = $WorkItem.RowIndex; Success = $false; Error = "Cannot read file: $($_.Exception.Message)" }
    }

    $payload = [ordered]@{
        DatatypeCode            = 'FILE'
        Title                   = $WorkItem.Title
        UploadedFileContentType = $WorkItem.MimeType
        UploadedFileName        = $fileName
        FileContents            = $fileBase64
        Description             = ''
        FileName                = $fileName
        CategoryName            = $WorkItem.CategoryName
    }
    $payloadJson = $payload | ConvertTo-Json -Depth 5 -Compress

    $payloadForLog = [ordered]@{
        DatatypeCode            = 'FILE'
        Title                   = $WorkItem.Title
        UploadedFileContentType = $WorkItem.MimeType
        UploadedFileName        = $fileName
        FileContents            = '[BASE64 REDACTED]'
        Description             = ''
        FileName                = $fileName
        CategoryName            = $WorkItem.CategoryName
    }
    Write-ScriptLog -LogPath $LogPath -Message "REQUEST  POST $($WorkItem.Url)" -Level 'REQUEST'
    Write-ScriptLog -LogPath $LogPath -Message "PAYLOAD  $($payloadForLog | ConvertTo-Json -Depth 5 -Compress)" -Level 'REQUEST'

    $result = Invoke-ApiWithRetry `
        -Headers              $Headers `
        -Url                  $WorkItem.Url `
        -Method               'POST' `
        -Body                 $payloadJson `
        -MaxRetries           $MaxRetries `
        -RetryBaselineSeconds $RetryBaselineSeconds `
        -LogPath              $LogPath `
        -DebugMode            $false `
        -SkipBodyLog

    if ($result.Success) {
        return @{ RowIndex = $WorkItem.RowIndex; Success = $true; Error = '' }
    }

    $sc = if ($result.StatusCode) { $result.StatusCode } else { 0 }
    $ed = if ($result.ErrorDetail) { $result.ErrorDetail } else { 'Unknown error' }
    $eb = if ($result.ErrorBody)   { $result.ErrorBody }   else { '' }

    if ($sc -eq 404) {
        $msg = "HTTP 404: Contract endpoint not found ($($WorkItem.Url))"
    }
    elseif ($sc -ge 400) {
        $msg = "HTTP ${sc}: ${ed}"
        if ($eb) {
            $t = if ($eb.Length -gt 500) { $eb.Substring(0,500) + '...' } else { $eb }
            $msg = "$msg | $t"
        }
    }
    else {
        $msg = $ed
        if ($eb) {
            $t = if ($eb.Length -gt 500) { $eb.Substring(0,500) + '...' } else { $eb }
            $msg = "$msg | $t"
        }
    }

    return @{ RowIndex = $WorkItem.RowIndex; Success = $false; Error = $msg }
}

# ---------------------------------------------------------------------------
# Parallel upload
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host "Starting parallel upload ($($workItems.Count) items, batch size $batchSize)..." -ForegroundColor Yellow
Write-ScriptLog -LogPath $LogPath -Message "Starting parallel upload. $($workItems.Count) items in batches of $batchSize." -Level 'INFO'

$iss  = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
$pool = [runspacefactory]::CreateRunspacePool(1, $batchSize, $iss, $Host)
$pool.Open()

$countProcessed = 0
$countFailed    = 0
$totalBatches   = [Math]::Ceiling($workItems.Count / $batchSize)

for ($b = 0; $b -lt $workItems.Count; $b += $batchSize) {
    $bn  = [Math]::Floor($b / $batchSize) + 1
    $be  = [Math]::Min($b + $batchSize - 1, $workItems.Count - 1)
    $btc = @($workItems[$b..$be])

    Write-ScriptLog -LogPath $LogPath -Message "Batch ${bn}/${totalBatches}: submitting $($btc.Count) items..." -Level 'INFO'

    $handles = [System.Collections.Generic.List[hashtable]]::new()
    for ($j = 0; $j -lt $btc.Count; $j++) {
        $item = $btc[$j]
        $wlog = $workerLogPaths[$j]
        $ps   = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($workerScript)
        [void]$ps.AddParameter('WorkItem',             $item)
        [void]$ps.AddParameter('Headers',              $headers)
        [void]$ps.AddParameter('MaxRetries',           $maxR)
        [void]$ps.AddParameter('RetryBaselineSeconds', $retB)
        [void]$ps.AddParameter('LogPath',              $wlog)
        [void]$ps.AddParameter('ModulePath',           $ModulePath)
        $handles.Add(@{ PS = $ps; Handle = $ps.BeginInvoke(); Item = $item })
    }

    foreach ($h in $handles) {
        $wr = $null
        try {
            $out = $h.PS.EndInvoke($h.Handle)
            if ($out -and $out.Count -gt 0) { $wr = $out[$out.Count - 1] }
        }
        catch {
            Write-ScriptLog -LogPath $LogPath -Message "Worker exception (row $($h.Item.RowIndex)): $($_.Exception.Message)" -Level 'ERROR'
        }
        if ($h.PS.HadErrors) {
            foreach ($e in $h.PS.Streams.Error) {
                Write-ScriptLog -LogPath $LogPath -Message "Worker stream error (row $($h.Item.RowIndex)): $($e.Exception.Message)" -Level 'ERROR'
            }
        }
        $h.PS.Dispose()

        $idx     = $h.Item.RowIndex
        $row     = $detailRows[$idx]
        $success = if ($wr) { [bool]$wr.Success } else { $false }

        if ($success) {
            $row.Done             = 'TRUE'
            $row.Error            = 'False'
            $row.ErrorDescription = ''
            $countProcessed++
        }
        else {
            $msg = if ($wr -and $wr.Error) { $wr.Error } else { 'Unknown error (worker returned no result)' }
            $row.Done             = 'FALSE'
            $row.Error            = 'True'
            $row.ErrorDescription = $msg
            $countFailed++
            Write-ScriptLog -LogPath $LogPath -Message "FAILED row $idx ($($h.Item.FileName)): $msg" -Level 'ERROR'
        }

        Add-ProgressRow -Id "$($row.ID)" -Done "$($row.Done)" -ErrorFlag "$($row.Error)" -ErrorDescription "$($row.ErrorDescription)"
    }

    Write-ScriptLog -LogPath $LogPath -Message "Batch $bn/$totalBatches done. Running totals - Processed: $countProcessed  Failed: $countFailed" -Level 'INFO'
    Write-Host "  Batch $bn/$totalBatches done. Processed: $countProcessed  Failed: $countFailed" -ForegroundColor Cyan
}

$pool.Close(); $pool.Dispose()

# ---------------------------------------------------------------------------
# Write F3
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Writing output CSV...' -ForegroundColor Yellow
$detailRows | Select-Object $csvColumns | Export-Csv -Path $outputCsvPath -NoTypeInformation -Encoding UTF8
Write-ScriptLog -LogPath $LogPath -Message "Output CSV written: $outputCsvPath" -Level 'INFO'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-ScriptLog -LogPath $LogPath -Message ("Summary - Total: $countTotal | Already-loaded: $countSkipAlreadyDone | Not-a-file-row: $countSkipNotFileRow | Missing ContractId/Path: $countSkipMissingInfo | Retries among candidates: $countRetry | Already in Oracle (existence check): $countSkipAlreadyExists | Deferred (limit): $countDeferred | Processed: $countProcessed | Failed: $countFailed") -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message ' ImportContractDocuments  -  COMPLETED'  -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'

Write-Host ''
Write-Host 'Completed.' -ForegroundColor Green
Write-Host "  Log:                  $LogPath"                  -ForegroundColor Green
Write-Host "  Upload worker logs:   $($LogPath -replace '\.log$', '-upload-worker*.log')" -ForegroundColor Green
Write-Host "  Progress CSV:         $progressCsvPath"          -ForegroundColor Green
Write-Host "  Result CSV:           $outputCsvPath"            -ForegroundColor Green
Write-Host ''
Write-Host "  Total rows:           $countTotal"               -ForegroundColor Green
Write-Host "  Already loaded:       $countSkipAlreadyDone"     -ForegroundColor Green
Write-Host "  Not a file row:       $countSkipNotFileRow"      -ForegroundColor Green
Write-Host "  Missing ContractId/Path: $countSkipMissingInfo"  -ForegroundColor $(if ($countSkipMissingInfo -gt 0) { 'Yellow' } else { 'Green' })
Write-Host "  Already in Oracle:    $countSkipAlreadyExists"   -ForegroundColor Green
Write-Host "  Deferred (limit):     $countDeferred"            -ForegroundColor Green
Write-Host "  Processed (uploaded): $countProcessed"           -ForegroundColor Green
Write-Host "    of which retries:   $countRetry"               -ForegroundColor Green
Write-Host "  Failed:               $countFailed"              -ForegroundColor $(if ($countFailed -gt 0) { 'Red' } else { 'Green' })
