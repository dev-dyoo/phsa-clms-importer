#Requires -Version 5.0
<#
.SYNOPSIS
    Common functions for Oracle Fusion REST API PowerShell scripts.

.DESCRIPTION
    Shared module providing settings management, authentication, retry logic,
    sanity checking, logging, CSV processing, and user prompts. Import this
    module at the top of each script under scripts/<ScriptName>/run.ps1.
#>

Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

function Read-ScriptSettings {
    <#
    .SYNOPSIS
        Reads and validates the .settings JSON file for a script.
    .PARAMETER SettingsPath
        Full path to the .settings file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SettingsPath
    )

    if (-not (Test-Path $SettingsPath)) {
        throw "Settings file not found: $SettingsPath"
    }

    $raw = Get-Content -Path $SettingsPath -Raw -ErrorAction Stop
    $settings = $raw | ConvertFrom-Json

    $required = @('BaseUrl', 'Username', 'Password', 'ApiPath', 'MaxRetries', 'RetryBaselineSeconds')
    foreach ($field in $required) {
        if ([string]::IsNullOrWhiteSpace($settings.$field)) {
            throw "Settings file is missing required field: '$field'  (path: $SettingsPath)"
        }
    }

    # Normalise - ensure https:// scheme and no trailing slash
    $settings.BaseUrl = 'https://' + $settings.BaseUrl.TrimStart('htps:/').TrimEnd('/')

    return $settings
}

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

function Get-BasicAuthHeader {
    <#
    .SYNOPSIS
        Builds an HTTP Basic-auth header hashtable for Invoke-RestMethod.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$Username,
        [Parameter(Mandatory = $true)] [string]$Password
    )

    $bytes   = [System.Text.Encoding]::UTF8.GetBytes("${Username}:${Password}")
    $encoded = [System.Convert]::ToBase64String($bytes)

    return @{
        'Authorization' = "Basic $encoded"
        'Content-Type'  = 'application/json'
        'Accept'        = 'application/json'
    }
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

function Write-ScriptLog {
    <#
    .SYNOPSIS
        Writes a timestamped line to the log file and echoes it to the console.
    .PARAMETER LogPath
        Full path to the log file.
    .PARAMETER Message
        Text to log.
    .PARAMETER Level
        Severity / category label.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]  [string]$LogPath,
        [Parameter(Mandatory = $true)]  [string]$Message,
        [ValidateSet('INFO','WARN','ERROR','DEBUG','REQUEST','RESPONSE')]
        [string]$Level = 'INFO'
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line      = "[$timestamp] [$Level] $Message"

    # Append with a short retry-on-IOException loop.  Windows file watchers,
    # antivirus, and even a `tail`/`grep` from another shell can briefly hold
    # the log open in a non-shared mode and make Add-Content throw - which,
    # under $ErrorActionPreference = 'Stop', would kill the running script.
    $maxAttempts = 6
    $written     = $false
    for ($i = 1; $i -le $maxAttempts; $i++) {
        try {
            Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction Stop
            $written = $true
            break
        }
        catch [System.IO.IOException] {
            if ($i -lt $maxAttempts) { Start-Sleep -Milliseconds (50 * $i) }
        }
        catch {
            # Non-IO error - record it on the console and give up; don't crash the run.
            Write-Host "[LOG WRITE ERROR] $($_.Exception.Message) | $line" -ForegroundColor DarkRed
            break
        }
    }
    if (-not $written) {
        Write-Host "[LOG WRITE LOST after $maxAttempts attempts] $line" -ForegroundColor DarkRed
    }

    $colour = switch ($Level) {
        'ERROR'    { 'Red'     }
        'WARN'     { 'Yellow'  }
        'DEBUG'    { 'Cyan'    }
        'REQUEST'  { 'Magenta' }
        'RESPONSE' { 'DarkCyan'}
        default    { 'Gray'    }
    }
    Write-Host $line -ForegroundColor $colour
}

function New-TimestampedLogPath {
    <#
    .SYNOPSIS
        Returns a log file path of the form <LogDirectory>\<BaseName>-YYYYMMDD-HHmm.log
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$LogDirectory,
        [Parameter(Mandatory = $true)] [string]$BaseName
    )

    $ts = Get-Date -Format 'yyyyMMdd-HHmm'
    return Join-Path $LogDirectory "${BaseName}-${ts}.log"
}

function New-TimestampedCsvPath {
    <#
    .SYNOPSIS
        Returns a CSV output path of the form <LogDirectory>\<InputBaseName>-YYYYMMDD-HHmm.csv
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$LogDirectory,
        [Parameter(Mandatory = $true)] [string]$InputFilePath
    )

    $base = [System.IO.Path]::GetFileNameWithoutExtension($InputFilePath)
    $ts   = Get-Date -Format 'yyyyMMdd-HHmm'
    return Join-Path $LogDirectory "${base}-${ts}.csv"
}

# ---------------------------------------------------------------------------
# Sanity Check
# ---------------------------------------------------------------------------

function Test-ApiSanityCheck {
    <#
    .SYNOPSIS
        Sends a GET request to the API endpoint to verify connectivity and
        that credentials are accepted (i.e. NOT 401 or 403).
    .OUTPUTS
        [bool] $true if the check passes, $false otherwise.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [hashtable]$Headers,
        [Parameter(Mandatory = $true)] [string]$Url,
        [Parameter(Mandatory = $true)] [string]$LogPath
    )

    Write-ScriptLog -LogPath $LogPath -Message "Sanity check: GET $Url" -Level 'INFO'

    try {
        $null = Invoke-RestMethod -Uri $Url -Method GET -Headers $Headers -ErrorAction Stop
        Write-ScriptLog -LogPath $LogPath -Message 'Sanity check PASSED (2xx response).' -Level 'INFO'
        return $true
    }
    catch [System.Net.WebException] {
        $response   = $_.Exception.Response
        $statusCode = 0

        if ($null -ne $response) {
            $statusCode = [int]$response.StatusCode
        }

        if ($statusCode -eq 401) {
            Write-ScriptLog -LogPath $LogPath -Message 'Sanity check FAILED: 401 Unauthorized. Verify Username/Password in .settings.' -Level 'ERROR'
            return $false
        }
        elseif ($statusCode -eq 403) {
            Write-ScriptLog -LogPath $LogPath -Message 'Sanity check FAILED: 403 Forbidden. Account lacks access to this resource.' -Level 'ERROR'
            return $false
        }
        else {
            # 404 / 405 / 5xx etc. - server is reachable and credentials were accepted
            Write-ScriptLog -LogPath $LogPath -Message "Sanity check PASSED (HTTP $statusCode - not an auth failure)." -Level 'INFO'
            return $true
        }
    }
    catch {
        Write-ScriptLog -LogPath $LogPath -Message "Sanity check FAILED (network/connection error): $($_.Exception.Message)" -Level 'ERROR'
        return $false
    }
}

# ---------------------------------------------------------------------------
# API Invocation with Retry
# ---------------------------------------------------------------------------

function Invoke-ApiWithRetry {
    <#
    .SYNOPSIS
        Calls a REST endpoint with exponential back-off retry.

    .DESCRIPTION
        Logs the outgoing payload and every response (or simulated response
        when DebugMode is $true).  On failure, retries up to MaxRetries times
        using exponential back-off starting at RetryBaselineSeconds.

        Auth errors (401 / 403) abort the retry loop immediately.

    .OUTPUTS
        Hashtable with keys:
            IsSimulated [bool]
            Success     [bool]
            Data        [object]   (on success)
            StatusCode  [int]      (on failure)
            ErrorDetail [string]   (on failure)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]  [hashtable]$Headers,
        [Parameter(Mandatory = $true)]  [string]$Url,
        [Parameter(Mandatory = $true)]  [ValidateSet('GET','POST','PUT','PATCH','DELETE')] [string]$Method,
        [string]  $Body                 = $null,
        [int]     $MaxRetries           = 3,
        [int]     $RetryBaselineSeconds = 1,
        [Parameter(Mandatory = $true)]  [string]$LogPath,
        [bool]    $DebugMode            = $false,
        [switch]  $SkipBodyLog
    )

    # --- Log outbound payload (always, including debug mode) ---
    Write-ScriptLog -LogPath $LogPath -Message "REQUEST  $Method $Url" -Level 'REQUEST'
    if (-not [string]::IsNullOrWhiteSpace($Body) -and -not $SkipBodyLog) {
        Write-ScriptLog -LogPath $LogPath -Message "PAYLOAD  $Body" -Level 'REQUEST'
    }

    # --- Debug-mode simulation ---
    if ($DebugMode) {
        $simulated = '{"simulated":true,"message":"Debug mode active - no HTTP request was sent."}'
        Write-ScriptLog -LogPath $LogPath -Message "RESPONSE [SIMULATED] $simulated" -Level 'RESPONSE'
        return @{ IsSimulated = $true; Success = $true; Data = ($simulated | ConvertFrom-Json) }
    }

    # --- Live call with retry ---
    $attempt          = 0
    $lastStatus       = 0
    $lastError        = ''
    $lastResponseBody = ''

    while ($attempt -lt $MaxRetries) {
        $attempt++

        try {
            $invokeParams = @{
                Uri         = $Url
                Method      = $Method
                Headers     = $Headers
                ErrorAction = 'Stop'
            }
            if (-not [string]::IsNullOrWhiteSpace($Body)) {
                $invokeParams['Body'] = $Body
            }

            $response     = Invoke-RestMethod @invokeParams
            $responseJson = $response | ConvertTo-Json -Depth 20 -Compress

            Write-ScriptLog -LogPath $LogPath -Message "RESPONSE (attempt $attempt) $responseJson" -Level 'RESPONSE'

            return @{ IsSimulated = $false; Success = $true; Data = $response }
        }
        catch [System.Net.WebException] {
            $webResponse = $_.Exception.Response
            $lastStatus  = 0
            $lastError   = $_.Exception.Message
            $responseBody = ''

            # Try PowerShell's ErrorDetails first (often contains the response body)
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $responseBody = $_.ErrorDetails.Message
            }

            if ($null -ne $webResponse) {
                $lastStatus = [int]$webResponse.StatusCode

                # Fallback: read from response stream if ErrorDetails was empty
                if (-not $responseBody) {
                    try {
                        $stream       = $webResponse.GetResponseStream()
                        $reader       = New-Object System.IO.StreamReader($stream)
                        $responseBody = $reader.ReadToEnd()
                        $reader.Close()
                        $stream.Close()
                    } catch {}
                }
            }

            Write-ScriptLog -LogPath $LogPath -Message "Attempt $attempt/$MaxRetries FAILED. HTTP $lastStatus - $lastError" -Level 'WARN'
            if ($responseBody) {
                Write-ScriptLog -LogPath $LogPath -Message "Error body: $responseBody" -Level 'WARN'
                $lastResponseBody = $responseBody
            }

            # 4xx client errors are deterministic - retrying the exact same
            # request won't change the outcome.  Exceptions: 408 Request Timeout
            # and 429 Too Many Requests are worth a retry.  401/403 are auth
            # failures and get an explicit note.
            if ($lastStatus -ge 400 -and $lastStatus -lt 500 -and $lastStatus -ne 408 -and $lastStatus -ne 429) {
                if ($lastStatus -eq 401 -or $lastStatus -eq 403) {
                    Write-ScriptLog -LogPath $LogPath -Message "Auth failure (HTTP $lastStatus). Aborting retries." -Level 'ERROR'
                }
                else {
                    Write-ScriptLog -LogPath $LogPath -Message "Client error (HTTP $lastStatus) - not retryable. Aborting retries." -Level 'WARN'
                }
                break
            }
        }
        catch {
            $lastError = $_.Exception.Message
            $responseBody = ''
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $responseBody = $_.ErrorDetails.Message
            }
            Write-ScriptLog -LogPath $LogPath -Message "Attempt $attempt/$MaxRetries FAILED (non-HTTP): $lastError" -Level 'WARN'
            if ($responseBody) {
                Write-ScriptLog -LogPath $LogPath -Message "Error body: $responseBody" -Level 'WARN'
                $lastResponseBody = $responseBody
            }
        }

        # Exponential back-off before next attempt
        if ($attempt -lt $MaxRetries) {
            $waitSec = $RetryBaselineSeconds * [Math]::Pow(2, $attempt - 1)
            Write-ScriptLog -LogPath $LogPath -Message "Waiting $waitSec second(s) before retry..." -Level 'INFO'
            Start-Sleep -Seconds ([int]$waitSec)
        }
    }

    Write-ScriptLog -LogPath $LogPath -Message "All $MaxRetries attempt(s) exhausted. Last error: $lastError" -Level 'ERROR'
    if ($lastResponseBody) {
        Write-ScriptLog -LogPath $LogPath -Message "Last error body: $lastResponseBody" -Level 'ERROR'
    }
    return @{ IsSimulated = $false; Success = $false; StatusCode = $lastStatus; ErrorDetail = $lastError; ErrorBody = $lastResponseBody }
}

# ---------------------------------------------------------------------------
# User Prompts
# ---------------------------------------------------------------------------

function Get-InputFilePath {
    <#
    .SYNOPSIS
        Prompts the user to confirm or override the input CSV file path.
        Defaults to the most-recently-modified .csv in InputDirectory.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string]$InputDirectory
    )

    $newest = Get-ChildItem -Path $InputDirectory -Filter '*.csv' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending |
              Select-Object -First 1

    if ($newest) {
        $defaultDisplay = $newest.FullName
        $prompt = "Input file [ENTER for: $defaultDisplay]"
    }
    else {
        $defaultDisplay = $null
        $prompt = "Input file path (no .csv found in $InputDirectory)"
    }

    $userInput = Read-Host $prompt

    if ([string]::IsNullOrWhiteSpace($userInput)) {
        if ($null -ne $defaultDisplay) {
            return $defaultDisplay
        }
        throw "No input file specified and no .csv files found in: $InputDirectory"
    }

    if (-not (Test-Path $userInput)) {
        throw "Input file not found: $userInput"
    }

    return $userInput
}

function Get-DebugModeChoice {
    <#
    .SYNOPSIS
        Prompts the user for Debug Mode. Defaults to YES.
    .OUTPUTS
        [bool] $true = debug/simulate, $false = live.
    #>
    [CmdletBinding()]
    param()

    $choice = Read-Host 'Debug Mode - simulate all API calls? (Y/n) [default: Y]'

    if ([string]::IsNullOrWhiteSpace($choice) -or $choice -match '^[Yy]') {
        return $true
    }
    return $false
}

# ---------------------------------------------------------------------------
# CSV Processing
# ---------------------------------------------------------------------------

function Invoke-CsvProcessing {
    <#
    .SYNOPSIS
        Iterates a CSV file, skips rows where DONE=TRUE, processes others
        via a caller-supplied script block, then writes a timestamped output
        CSV to the log directory.

    .DESCRIPTION
        The ProcessRow script block must accept exactly these named parameters:
            -Row       [PSCustomObject]  - the current CSV row
            -LogPath   [string]          - path to the active log file
            -DebugMode [bool]
            -Context   [hashtable]       - caller-supplied context (headers, URL, etc.)

        It must return [bool] $true on success, $false on failure.

        Rows where DONE=FALSE (from a previous run) are retried.
        On completion a copy of the CSV with updated DONE values is written to
        the log directory.

    .PARAMETER InputFilePath
        Path to the source CSV.
    .PARAMETER OutputCsvPath
        Destination path for the result CSV (typically in the logs folder).
    .PARAMETER ProcessRow
        Script block that processes a single row.
    .PARAMETER Context
        Hashtable of caller-defined values forwarded verbatim to ProcessRow.
    .PARAMETER LogPath
        Active log file path.
    .PARAMETER DebugMode
        When $true rows are processed in simulation mode.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]  [string]$InputFilePath,
        [Parameter(Mandatory = $true)]  [string]$OutputCsvPath,
        [Parameter(Mandatory = $true)]  [scriptblock]$ProcessRow,
        [Parameter(Mandatory = $true)]  [hashtable]$Context,
        [Parameter(Mandatory = $true)]  [string]$LogPath,
        [bool]$DebugMode = $false
    )

    Write-ScriptLog -LogPath $LogPath -Message "Reading CSV: $InputFilePath" -Level 'INFO'
    $rows = Import-Csv -Path $InputFilePath -ErrorAction Stop

    if ($rows.Count -eq 0) {
        Write-ScriptLog -LogPath $LogPath -Message 'Input CSV is empty. Nothing to process.' -Level 'WARN'
        return
    }

    # Detect DONE column
    $hasDoneCol = [bool]($rows[0].PSObject.Properties['DONE'])

    $countProcessed = 0
    $countSkipped   = 0
    $countFailed    = 0
    $results        = [System.Collections.Generic.List[object]]::new()

    foreach ($row in $rows) {
        # Skip rows already marked done
        if ($hasDoneCol -and $row.DONE -eq 'TRUE') {
            $countSkipped++
            $results.Add($row)
            continue
        }

        Write-ScriptLog -LogPath $LogPath -Message "Processing row: $(($row | ConvertTo-Json -Compress -Depth 5))" -Level 'INFO'

        $success = & $ProcessRow -Row $row -LogPath $LogPath -DebugMode $DebugMode -Context $Context

        if ($hasDoneCol) {
            $row.DONE = if ($success) { 'TRUE' } else { 'FALSE' }
        }
        else {
            $row | Add-Member -NotePropertyName 'DONE' -NotePropertyValue $(if ($success) { 'TRUE' } else { 'FALSE' }) -Force
        }

        if ($success) { $countProcessed++ } else { $countFailed++ }

        $results.Add($row)
    }

    # Write output CSV
    $results | Export-Csv -Path $OutputCsvPath -NoTypeInformation -Encoding UTF8
    Write-ScriptLog -LogPath $LogPath -Message "Output CSV written: $OutputCsvPath" -Level 'INFO'
    Write-ScriptLog -LogPath $LogPath -Message "Summary - Processed: $countProcessed  |  Skipped (DONE): $countSkipped  |  Failed: $countFailed" -Level 'INFO'
}

# ---------------------------------------------------------------------------
# Module exports
# ---------------------------------------------------------------------------

Export-ModuleMember -Function @(
    'Read-ScriptSettings'
    'Get-BasicAuthHeader'
    'Write-ScriptLog'
    'New-TimestampedLogPath'
    'New-TimestampedCsvPath'
    'Test-ApiSanityCheck'
    'Invoke-ApiWithRetry'
    'Get-InputFilePath'
    'Get-DebugModeChoice'
    'Invoke-CsvProcessing'
)
