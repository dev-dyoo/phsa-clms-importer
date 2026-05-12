#Requires -Version 5.0
<#
.SYNOPSIS
    Enrich a batch list of contract folders (F1) into a per-document load
    list (F2) ready for 11-ImportContractDocuments.

.DESCRIPTION
    Input  (F1):  input\last_batch_files.csv   - requires columns:
                      ContractNumber   the contract's business number
                      Path             root folder holding that contract's documents

    Output (F2):  logs\ContractDocumentLoadList-<yyyyMMdd-HHmmss>.csv  - columns:
                      ID, ContractNumber, DocType, ContractId, Title,
                      FileName, FullPath, Done, Error, ErrorDescription

    The only column carried from F1 into F2 is ContractNumber.

    Processing
    ----------
    Pass 1 - resolve contracts
        For every distinct F1.ContractNumber, GET
            {ApiPath}?q=ContractNumber=<number>
          - 0 results          -> remembered as error  "404 Contract not found."
          - HTTP/network error -> remembered as error  "Lookup failed: HTTP <n> - ..."
          - >= 1 result        -> ContractId = items[0].ContractId  (a >1 match is logged)

    Pass 2 - discover files (walks F1 again, using each row's Path)
            <Path>\ContractDoc\*     -> one F2 row each, DocType = "ContractDoc"
            <Path>\SupportingDoc\*   -> one F2 row each, DocType = "Excel" when the
                                        file matches *.xls*  else "SupportingDoc"
            FALLBACK: when neither sub-folder yields any file, scan the top
            level of <Path> for documents whose name starts with PO* or SOW*
            (case-insensitive) and emit them as DocType = "ContractDoc".
        Each discovered file row:
            ID               sequential (1, 2, 3, ...)
            ContractNumber   from F1
            ContractId       resolved in pass 1
            Title            file name - whitespace-trimmed and transliterated to ASCII
            FileName         same as Title (extension preserved); this is what
                             11-ImportContractDocuments sends to Oracle as
                             UploadedFileName and uses to derive the MIME type
            FullPath         absolute path of the file on disk (original, un-cleaned)
            Done             "READY"
            Error            "False"
            ErrorDescription ""

        A contract-lookup failure, a missing ContractNumber or Path, a Path that
        does not exist, or a Path with no matching documents each yields a single
        F2 row with Error = "True" and a descriptive ErrorDescription
        (Done blank, no file).

    How 11-ImportContractDocuments consumes F2
    ------------------------------------------
        ContractId  -> contracts/<ContractId>/child/<ContractDocuments|SupportingDocuments>
        DocType     -> child resource (ContractDoc -> ContractDocuments, else SupportingDocuments)
                       and CategoryName (ContractDoc -> OKC_DOCUMENTS_CONTRACT,
                       SupportingDoc -> OKC_DOCUMENTS_SUPPORTING_DOC, Excel -> PHSA_ITEM_SPREADSHEETS)
        Title       -> payload Title
        FileName    -> payload UploadedFileName / FileName and MIME-type lookup
        FullPath    -> file bytes (base64)
        Done        -> "READY" = upload it; rewritten to "TRUE"/"FALSE" after the attempt
        Error       -> rows with "True" are skipped (there is no file to send)
        ID          -> row identifier in the progress file

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
$CommonDir  = Join-Path (Split-Path -Parent $ScriptDir) '_common'
$ModulePath = Join-Path $CommonDir 'OracleFusionCommon.psm1'

if (-not (Test-Path $ModulePath)) {
    Write-Error "Cannot find shared module at: $ModulePath"
    exit 1
}

Import-Module $ModulePath -Force

$SettingsPath = Join-Path $ScriptDir '.settings'
$LogDir       = Join-Path $ScriptDir 'logs'
$InputDir     = Join-Path $ScriptDir 'input'

New-Item -ItemType Directory -Force -Path $LogDir   | Out-Null
New-Item -ItemType Directory -Force -Path $InputDir | Out-Null

# ---------------------------------------------------------------------------
# Log file
# ---------------------------------------------------------------------------

$LogPath = New-TimestampedLogPath -LogDirectory $LogDir -BaseName 'EnrichDocumentFilesList'
New-Item -ItemType File -Force -Path $LogPath | Out-Null

Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message ' EnrichDocumentFilesList  -  STARTED'      -Level 'INFO'
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
$maxRetries       = [int]$settings.MaxRetries
$retryBaseline    = [int]$settings.RetryBaselineSeconds

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
# Input CSV (F1)
# ---------------------------------------------------------------------------

$defaultF1 = $null
foreach ($cand in @(
        (Join-Path $InputDir 'last_batch_files.csv'),
        (Join-Path (Join-Path $RepoRoot 'scripts') 'input\last_batch_files.csv'))) {
    if (Test-Path $cand) { $defaultF1 = (Resolve-Path $cand).Path; break }
}

Write-Host ''
if ($defaultF1) {
    $answer = Read-Host "Input CSV (F1) [ENTER for: $defaultF1]"
    $f1Path = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultF1 } else { $answer }
}
else {
    $f1Path = Read-Host 'Input CSV (F1) path'
}

$f1Path = $f1Path.Trim().Trim('"')
if ([string]::IsNullOrWhiteSpace($f1Path) -or -not (Test-Path -LiteralPath $f1Path)) {
    Write-ScriptLog -LogPath $LogPath -Message "FATAL: F1 not found: $f1Path" -Level 'ERROR'
    exit 1
}
Write-ScriptLog -LogPath $LogPath -Message "F1 (input): $f1Path" -Level 'INFO'

# ---------------------------------------------------------------------------
# Output CSV (F2)
# ---------------------------------------------------------------------------

$ts        = Get-Date -Format 'yyyyMMdd-HHmmss'
$f2Path    = Join-Path $LogDir "ContractDocumentLoadList-$ts.csv"
$f2Columns = @('ID','ContractNumber','DocType','ContractId','Title','FileName','FullPath','Done','Error','ErrorDescription')
Write-ScriptLog -LogPath $LogPath -Message "F2 (output): $f2Path" -Level 'INFO'

# ---------------------------------------------------------------------------
# ASCII transliteration helper
# ---------------------------------------------------------------------------

function ConvertTo-AsciiName {
    <#
        Whitespace-trim a file name and transliterate it to ASCII.
        Accented Latin letters are de-accented (e.g. e-acute -> e); common
        "smart" punctuation is mapped to a plain ASCII equivalent; anything
        still non-ASCII becomes '_'.  Runs of spaces/underscores are collapsed.
        The extension comes along unchanged (extensions are virtually always
        ASCII already).

        Regex patterns below use \uXXXX escapes so this source file stays
        pure ASCII regardless of how it is saved or read by PowerShell.
        Single-quoted strings pass the backslash through verbatim; .NET's
        regex engine interprets \uXXXX as the actual character.
    #>
    param([string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) { return '_' }

    $s = $Name
    # single quotes / prime / acute / grave
    $s = $s -replace '[‘’‚‛′´`]', "'"
    # double quotes (these are illegal in Windows filenames but cheap to map)
    $s = $s -replace '[“”„‟″]', "'"
    # hyphens / dashes / minus
    $s = $s -replace '[‐‑‒–—―−]', '-'
    # bullets / middle dot
    $s = $s -replace '[•·‧∙]', '-'
    # ellipsis
    $s = $s -replace '…', '...'
    # exotic spaces (NBSP, narrow NBSP, ideographic space, etc.)
    $s = $s -replace '[            　]', ' '

    # De-accent: decompose, then drop the combining marks.
    $decomposed = $s.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($ch in $decomposed.ToCharArray()) {
        if ([System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -eq [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            continue
        }
        if ([int]$ch -lt 128) { [void]$sb.Append($ch) } else { [void]$sb.Append('_') }
    }

    $out = $sb.ToString()
    $out = [regex]::Replace($out, ' {2,}', ' ')
    $out = [regex]::Replace($out, '_{2,}', '_')
    $out = $out.Trim()
    if ([string]::IsNullOrWhiteSpace($out)) { $out = '_' }
    return $out
}

# ---------------------------------------------------------------------------
# F2 row factory
# ---------------------------------------------------------------------------

function New-F2Row {
    param(
        [int]    $Id,
        [string] $ContractNumber,
        [string] $DocType,
        [string] $ContractId,
        [string] $Title,
        [string] $FileName,
        [string] $FullPath,
        [string] $Done,
        [bool]   $IsError,
        [string] $ErrorDescription
    )
    return [pscustomobject][ordered]@{
        ID               = $Id
        ContractNumber   = $ContractNumber
        DocType          = $DocType
        ContractId       = $ContractId
        Title            = $Title
        FileName         = $FileName
        FullPath         = $FullPath
        Done             = $Done
        Error            = if ($IsError) { 'True' } else { 'False' }
        ErrorDescription = $ErrorDescription
    }
}

# ---------------------------------------------------------------------------
# Read F1
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Loading F1...' -ForegroundColor Yellow

$f1Rows = @(Import-Csv -Path $f1Path -ErrorAction Stop)
if ($f1Rows.Count -eq 0) {
    Write-ScriptLog -LogPath $LogPath -Message 'F1 is empty. Nothing to do.' -Level 'WARN'
    exit 0
}

$f1HeaderProps = @($f1Rows[0].PSObject.Properties.Name)

function Resolve-F1Column {
    # Match aliases case-insensitively while ignoring spaces/underscores/hyphens.
    # Lets CONTRACT_NUMBER, Contract Number, contractnumber, etc. all bind to "ContractNumber".
    param([string[]]$AvailableHeaders, [string[]]$Aliases)
    foreach ($alias in $Aliases) {
        $needle = ($alias -replace '[\s_\-]','').ToLowerInvariant()
        foreach ($h in $AvailableHeaders) {
            if ((($h -replace '[\s_\-]','').ToLowerInvariant()) -eq $needle) { return $h }
        }
    }
    return $null
}

$colContractNumber = Resolve-F1Column -AvailableHeaders $f1HeaderProps -Aliases @('ContractNumber','ContractNo','ContractNum')
$colPath           = Resolve-F1Column -AvailableHeaders $f1HeaderProps -Aliases @('Path','FullPath','FolderPath','BasePath','Folder','Directory','Dir')

if (-not $colContractNumber) {
    Write-ScriptLog -LogPath $LogPath -Message "FATAL: F1 is missing a contract-number column (looked for ContractNumber and common variants). Columns present: $($f1HeaderProps -join ', ')" -Level 'ERROR'
    exit 1
}
if (-not $colPath) {
    Write-ScriptLog -LogPath $LogPath -Message "FATAL: F1 is missing a path column (looked for Path/FullPath/Folder/etc.). Columns present: $($f1HeaderProps -join ', ')" -Level 'ERROR'
    exit 1
}

Write-ScriptLog -LogPath $LogPath -Message "F1 column mapping: ContractNumber <- '$colContractNumber'  |  Path <- '$colPath'" -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message "F1 loaded: $($f1Rows.Count) row(s)." -Level 'INFO'
Write-Host "  $($f1Rows.Count) row(s)." -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Pass 1 - resolve ContractNumber -> ContractId
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Pass 1: resolving contract numbers...' -ForegroundColor Yellow
Write-ScriptLog -LogPath $LogPath -Message 'Pass 1: resolving contract numbers.' -Level 'INFO'

$contractCache = @{}    # ContractNumber -> @{ ContractId; Error; ErrorDescription }
$distinctOrder = [System.Collections.Generic.List[string]]::new()

foreach ($row in $f1Rows) {
    $cn = if ($null -ne $row.$colContractNumber) { ([string]$row.$colContractNumber).Trim() } else { '' }
    if ([string]::IsNullOrWhiteSpace($cn))   { continue }
    if ($contractCache.ContainsKey($cn))     { continue }
    $distinctOrder.Add($cn)

    $url = "$baseContractsUrl" + '?q=ContractNumber=' + [uri]::EscapeDataString($cn)
    Write-ScriptLog -LogPath $LogPath -Message "Lookup ContractNumber='$cn'" -Level 'INFO'

    $res = Invoke-ApiWithRetry -Headers $headers -Url $url -Method 'GET' `
              -MaxRetries $maxRetries -RetryBaselineSeconds $retryBaseline `
              -LogPath $LogPath -DebugMode $false

    if (-not $res.Success) {
        $sc  = if ($res.StatusCode) { $res.StatusCode } else { 0 }
        $msg = if ($res.ErrorDetail) { $res.ErrorDetail } else { 'unknown error' }
        $contractCache[$cn] = @{ ContractId = ''; Error = $true; ErrorDescription = "Lookup failed: HTTP $sc - $msg" }
        Write-ScriptLog -LogPath $LogPath -Message "  -> lookup FAILED (HTTP $sc): $msg" -Level 'ERROR'
        continue
    }

    $items = @()
    if ($res.Data -and ($res.Data.PSObject.Properties['items']) -and $null -ne $res.Data.items) {
        $items = @($res.Data.items)
    }

    if ($items.Count -eq 0) {
        $contractCache[$cn] = @{ ContractId = ''; Error = $true; ErrorDescription = '404 Contract not found.' }
        Write-ScriptLog -LogPath $LogPath -Message '  -> not found' -Level 'WARN'
        continue
    }

    if ($items.Count -gt 1) {
        Write-ScriptLog -LogPath $LogPath -Message "  -> $($items.Count) matches; using the first." -Level 'WARN'
    }

    $first = $items[0]
    $cid   = if ($first.PSObject.Properties['ContractId'] -and $null -ne $first.ContractId) { "$($first.ContractId)" } else { '' }

    if ([string]::IsNullOrWhiteSpace($cid)) {
        $contractCache[$cn] = @{ ContractId = ''; Error = $true; ErrorDescription = 'Contract found but response had no ContractId.' }
        Write-ScriptLog -LogPath $LogPath -Message '  -> match had no ContractId attribute' -Level 'ERROR'
        continue
    }

    $contractCache[$cn] = @{ ContractId = $cid; Error = $false; ErrorDescription = '' }
    Write-ScriptLog -LogPath $LogPath -Message "  -> ContractId = $cid" -Level 'INFO'
}

$resolvedCount = @($contractCache.Values | Where-Object { -not $_.Error }).Count
$failedCount   = @($contractCache.Values | Where-Object { $_.Error }).Count
Write-ScriptLog -LogPath $LogPath -Message "Pass 1 done. Distinct numbers: $($distinctOrder.Count)  Resolved: $resolvedCount  Not found / errored: $failedCount" -Level 'INFO'
Write-Host "  Distinct contract numbers: $($distinctOrder.Count)" -ForegroundColor Cyan
Write-Host "  Resolved: $resolvedCount   Not found / errored: $failedCount" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Pass 2 - discover files
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Pass 2: discovering document files...' -ForegroundColor Yellow
Write-ScriptLog -LogPath $LogPath -Message 'Pass 2: discovering document files.' -Level 'INFO'

$f2Rows      = [System.Collections.Generic.List[object]]::new()
$nextId      = 1
$emittedErr  = @{}      # ContractNumber -> $true once an error row has been written for it
$skipNames   = @('Thumbs.db','desktop.ini','.DS_Store')

$fileCount   = 0
$errRowCount = 0

# Sub-folders to scan, in order.  ExcelSplit = $true means *.xls* files in
# that folder get DocType "Excel" instead of "SupportingDoc".
$folderSpecs = @(
    [pscustomobject]@{ Name = 'ContractDoc';   ExcelSplit = $false }
    [pscustomobject]@{ Name = 'SupportingDoc'; ExcelSplit = $true  }
)

foreach ($row in $f1Rows) {
    $cn      = if ($null -ne $row.$colContractNumber) { ([string]$row.$colContractNumber).Trim() } else { '' }
    $rawPath = if ($null -ne $row.$colPath)           { ([string]$row.$colPath).Trim().Trim('"') } else { '' }

    # ---- missing ContractNumber ----
    if ([string]::IsNullOrWhiteSpace($cn)) {
        $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber '' -DocType '' -ContractId '' `
            -Title '' -FileName '' -FullPath $rawPath -Done '' -IsError $true `
            -ErrorDescription 'Missing ContractNumber in F1 row.') )
        $nextId++; $errRowCount++
        Write-ScriptLog -LogPath $LogPath -Message "F1 row has no ContractNumber (Path='$rawPath')." -Level 'WARN'
        continue
    }

    $info = $contractCache[$cn]
    if ($null -eq $info) {
        # Should not happen (pass 1 walked the same rows) - be defensive.
        $info = @{ ContractId = ''; Error = $true; ErrorDescription = 'Contract number was not resolved in pass 1.' }
    }

    # ---- contract lookup error ----
    if ($info.Error) {
        if (-not $emittedErr.ContainsKey($cn)) {
            $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber $cn -DocType '' -ContractId '' `
                -Title '' -FileName '' -FullPath '' -Done '' -IsError $true `
                -ErrorDescription $info.ErrorDescription) )
            $nextId++; $errRowCount++
            $emittedErr[$cn] = $true
        }
        continue
    }

    $contractId = $info.ContractId

    # ---- missing Path ----
    if ([string]::IsNullOrWhiteSpace($rawPath)) {
        $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber $cn -DocType '' -ContractId $contractId `
            -Title '' -FileName '' -FullPath '' -Done '' -IsError $true `
            -ErrorDescription 'Missing Path in F1 row.') )
        $nextId++; $errRowCount++
        Write-ScriptLog -LogPath $LogPath -Message "ContractNumber='$cn' has no Path." -Level 'WARN'
        continue
    }

    # ---- non-existent Path ----
    if (-not (Test-Path -LiteralPath $rawPath)) {
        $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber $cn -DocType '' -ContractId $contractId `
            -Title '' -FileName '' -FullPath $rawPath -Done '' -IsError $true `
            -ErrorDescription "Path not found: $rawPath") )
        $nextId++; $errRowCount++
        Write-ScriptLog -LogPath $LogPath -Message "ContractNumber='$cn' Path not found: $rawPath" -Level 'WARN'
        continue
    }

    # ---- scan the known sub-folders ----
    $rowFileCount = 0
    foreach ($spec in $folderSpecs) {
        $subFolder = Join-Path $rawPath $spec.Name
        if (-not (Test-Path -LiteralPath $subFolder)) { continue }

        $files = @(Get-ChildItem -LiteralPath $subFolder -File -ErrorAction SilentlyContinue)
        foreach ($f in $files) {
            if ($skipNames -contains $f.Name) { continue }
            if ($f.Name -like '~$*')          { continue }   # Office lock files

            if ($spec.ExcelSplit -and ($f.Name -like '*.xls*')) { $docType = 'Excel' }
            elseif ($spec.ExcelSplit)                           { $docType = 'SupportingDoc' }
            else                                                { $docType = 'ContractDoc' }

            $clean = ConvertTo-AsciiName -Name $f.Name

            $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber $cn -DocType $docType -ContractId $contractId `
                -Title $clean -FileName $clean -FullPath $f.FullName -Done 'READY' -IsError $false `
                -ErrorDescription '') )
            $nextId++; $fileCount++; $rowFileCount++
        }
    }

    # ---- Fallback: PO*/SOW* files at the top of the Path ----
    # If neither sub-folder yielded a file (folder missing OR empty), look
    # for top-level documents whose name starts with PO or SOW (case-
    # insensitive) and treat them as ContractDoc.
    $usedFallback = $false
    if ($rowFileCount -eq 0) {
        $fallbackFiles = @(Get-ChildItem -LiteralPath $rawPath -File -ErrorAction SilentlyContinue |
                           Where-Object { $_.Name -like 'PO*' -or $_.Name -like 'SOW*' })
        foreach ($f in $fallbackFiles) {
            if ($skipNames -contains $f.Name) { continue }
            if ($f.Name -like '~$*')          { continue }   # Office lock files

            $clean = ConvertTo-AsciiName -Name $f.Name

            $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber $cn -DocType 'ContractDoc' -ContractId $contractId `
                -Title $clean -FileName $clean -FullPath $f.FullName -Done 'READY' -IsError $false `
                -ErrorDescription '') )
            $nextId++; $fileCount++; $rowFileCount++
            $usedFallback = $true
        }
    }

    if ($rowFileCount -eq 0) {
        $f2Rows.Add( (New-F2Row -Id $nextId -ContractNumber $cn -DocType '' -ContractId $contractId `
            -Title '' -FileName '' -FullPath $rawPath -Done '' -IsError $true `
            -ErrorDescription "No ContractDoc, SupportingDoc, or fallback PO*/SOW* files found under: $rawPath") )
        $nextId++; $errRowCount++
        Write-ScriptLog -LogPath $LogPath -Message "ContractNumber='$cn' yielded no files under: $rawPath" -Level 'WARN'
    }
    else {
        $tag = if ($usedFallback) { ' (fallback PO*/SOW*)' } else { '' }
        Write-ScriptLog -LogPath $LogPath -Message "ContractNumber='$cn' -> $rowFileCount file row(s)$tag." -Level 'INFO'
    }
}

# ---------------------------------------------------------------------------
# Write F2
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host 'Writing F2...' -ForegroundColor Yellow

$f2Rows | Select-Object $f2Columns | Export-Csv -Path $f2Path -NoTypeInformation -Encoding UTF8
Write-ScriptLog -LogPath $LogPath -Message "F2 written: $f2Path  ($($f2Rows.Count) row(s))" -Level 'INFO'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-ScriptLog -LogPath $LogPath -Message "Summary - F1 rows: $($f1Rows.Count)  |  Distinct contracts: $($distinctOrder.Count)  |  Resolved: $resolvedCount  |  Lookup failed / not found: $failedCount  |  F2 file rows: $fileCount  |  F2 error rows: $errRowCount" -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message ' EnrichDocumentFilesList  -  COMPLETED'    -Level 'INFO'
Write-ScriptLog -LogPath $LogPath -Message '========================================' -Level 'INFO'

Write-Host ''
Write-Host 'Completed.' -ForegroundColor Green
Write-Host "  Log:         $LogPath"     -ForegroundColor Green
Write-Host "  F2 output:   $f2Path"      -ForegroundColor Green
Write-Host "  File rows:   $fileCount"   -ForegroundColor Green
Write-Host "  Error rows:  $errRowCount" -ForegroundColor $(if ($errRowCount -gt 0) { 'Yellow' } else { 'Green' })
Write-Host ''
Write-Host 'Feed F2 into 11-ImportContractDocuments.' -ForegroundColor Cyan
