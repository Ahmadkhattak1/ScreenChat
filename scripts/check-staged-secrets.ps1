param(
    [switch]$All
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Get-Location).Path
$normalizedRepoRoot = $repoRoot -replace '\\', '/'

$publicEnvNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    'AI_PROVIDER',
    'CHAT_MODEL',
    'FIREBASE_APP_ID',
    'FIREBASE_AUTH_DOMAIN',
    'FIREBASE_MEASUREMENT_ID',
    'FIREBASE_MESSAGING_SENDER_ID',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_STORAGE_BUCKET',
    'FIREBASE_WEB_API_KEY',
    'HOST',
    'MAX_HISTORY_MESSAGES',
    'OPENAI_MODEL',
    'PORT',
    'REPLICATE_MODEL',
    'SCREENCHAT_API_BASE_URLS',
    'SCREENCHAT_BACKEND_URL'
) | ForEach-Object { [void]$publicEnvNames.Add($_) }

$explicitSecretEnvNames = @{
    ACCESS_TOKEN = 'access token'
    AUTH_TOKEN = 'auth token'
    FIREBASE_PRIVATE_KEY = 'Firebase admin private key'
    FIREBASE_SERVICE_ACCOUNT_JSON = 'Firebase service account JSON'
    GOOGLE_CLIENT_SECRET = 'Google OAuth client secret'
    JWT_SECRET = 'JWT secret'
    NPM_TOKEN = 'npm token'
    OPENAI_API_KEY = 'OpenAI API key'
    REFRESH_TOKEN = 'refresh token'
    REPLICATE_API_TOKEN = 'Replicate API token'
    SESSION_SECRET = 'session secret'
}

$directSecretPatterns = @(
    @{ Label = 'private key block'; Regex = '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    @{ Label = 'OpenAI API key'; Regex = '\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b' },
    @{ Label = 'GitHub token'; Regex = '\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b' },
    @{ Label = 'GitHub fine-grained token'; Regex = '\bgithub_pat_[A-Za-z0-9_]{20,}\b' },
    @{ Label = 'Slack token'; Regex = '\bxox[baprs]-[A-Za-z0-9-]{10,}\b' },
    @{ Label = 'AWS access key id'; Regex = '\bAKIA[0-9A-Z]{16}\b' }
)

$jsonSecretPatterns = @(
    @{ Label = 'JSON private_key field'; Regex = '"private_key"\s*:\s*"(?!\s*")(?:[^"\\]|\\.)+"' },
    @{ Label = 'JSON client_secret field'; Regex = '"client_secret"\s*:\s*"(?!\s*")(?:[^"\\]|\\.)+"' }
)

$binaryExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.ico',
    '.svg',
    '.pdf',
    '.zip',
    '.gz',
    '.7z',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.mp3',
    '.mp4',
    '.mov',
    '.avi'
) | ForEach-Object { [void]$binaryExtensions.Add($_) }

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & git -c "safe.directory=$normalizedRepoRoot" @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git command failed: git $($Arguments -join ' ')"
    }

    return @($output)
}

function Get-CandidateFiles {
    if ($All) {
        return Invoke-Git -Arguments @('ls-files') | Where-Object { $_ }
    }

    return Invoke-Git -Arguments @('diff', '--cached', '--name-only', '--diff-filter=ACMR') | Where-Object { $_ }
}

function Test-TemplateLike {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $lower = $Name.ToLowerInvariant()
    return $lower.Contains('example') -or $lower.Contains('sample') -or $lower.Contains('template')
}

function Get-SensitivePathReason {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    $name = [System.IO.Path]::GetFileName($FilePath)

    if ($name.StartsWith('.env', [System.StringComparison]::OrdinalIgnoreCase) -and -not (Test-TemplateLike -Name $name)) {
        return 'local environment file'
    }

    if ($name -in @('.envrc', '.git-credentials', '.npmrc')) {
        return 'credential-bearing local config file'
    }

    if (-not (Test-TemplateLike -Name $name) -and $name -match '(service-account|firebase-admin|credentials|secret|secrets).*\.(json|ya?ml|toml)$') {
        return 'credential file'
    }

    if (-not (Test-TemplateLike -Name $name) -and ($name -match '^(id_(rsa|dsa|ecdsa|ed25519))$' -or $name -match '\.(pem|key|p12|pfx|jks|keystore)$')) {
        return 'private key or keystore file'
    }

    return $null
}

function Normalize-AssignedValue {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$RawValue
    )

    $value = [regex]::Replace($RawValue, '\s+#.*$', '').Trim()
    if ($value.Length -ge 2) {
        $first = $value.Substring(0, 1)
        $last = $value.Substring($value.Length - 1, 1)
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2).Trim()
        }
    }

    return $value
}

function Test-PlaceholderValue {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $true
    }

    $lower = $Value.ToLowerInvariant()
    return (
        $lower -eq 'changeme' -or
        $lower -eq 'replace-me' -or
        $lower -eq 'replace_me' -or
        $lower -eq 'your-value-here' -or
        $lower -eq 'your_api_key_here' -or
        $lower.StartsWith('your ') -or
        $lower.StartsWith('your-') -or
        $lower.StartsWith('your_') -or
        $lower.Contains('example') -or
        $lower.Contains('placeholder') -or
        $lower.Contains('<') -or
        $lower.Contains('>')
    )
}

function Get-SecretEnvReason {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($publicEnvNames.Contains($Name)) {
        return $null
    }

    if ($explicitSecretEnvNames.ContainsKey($Name)) {
        return $explicitSecretEnvNames[$Name]
    }

    if ($Name.EndsWith('_PRIVATE_KEY', [System.StringComparison]::OrdinalIgnoreCase)) {
        return 'private key'
    }

    if ($Name.EndsWith('_CLIENT_SECRET', [System.StringComparison]::OrdinalIgnoreCase)) {
        return 'client secret'
    }

    if ($Name -match '(^|_)(TOKEN|PASSWORD|SECRET)$') {
        return 'credential'
    }

    if ($Name.EndsWith('_API_KEY', [System.StringComparison]::OrdinalIgnoreCase)) {
        return 'API key'
    }

    return $null
}

function Test-ContentScanEligible {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    $extension = [System.IO.Path]::GetExtension($FilePath)
    if ($extension) {
        return -not $binaryExtensions.Contains($extension)
    }

    return $true
}

function Test-EnvAssignmentScanEligible {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    $name = [System.IO.Path]::GetFileName($FilePath)
    if ($name.StartsWith('.env', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $extension = [System.IO.Path]::GetExtension($FilePath)
    return $extension -in @(
        '.bash',
        '.bat',
        '.cmd',
        '.conf',
        '.env',
        '.ini',
        '.properties',
        '.sh',
        '.zsh'
    )
}

function Get-FileText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    if ($All) {
        return [System.IO.File]::ReadAllText((Join-Path $repoRoot $FilePath))
    }

    $content = & git -c "safe.directory=$normalizedRepoRoot" show ":$FilePath"
    if ($LASTEXITCODE -ne 0) {
        throw "git show failed for $FilePath"
    }

    return ($content -join "`n")
}

function Scan-FileContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text
    )

    $reasons = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($pattern in $directSecretPatterns) {
        if ($Text -match $pattern.Regex) {
            [void]$reasons.Add($pattern.Label)
        }
    }

    foreach ($pattern in $jsonSecretPatterns) {
        if ($Text -match $pattern.Regex) {
            [void]$reasons.Add($pattern.Label)
        }
    }

    if (Test-EnvAssignmentScanEligible -FilePath $FilePath) {
        foreach ($line in ($Text -split "\r?\n")) {
            if ($line -match '^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$') {
                $name = $Matches[1]
                $value = Normalize-AssignedValue -RawValue $Matches[2]
                $reason = Get-SecretEnvReason -Name $name

                if ($reason -and -not (Test-PlaceholderValue -Value $value)) {
                    [void]$reasons.Add("$reason assigned to $name")
                }
            }
        }
    }

    return @($reasons)
}

$failures = New-Object System.Collections.Generic.List[object]

foreach ($filePath in (Get-CandidateFiles)) {
    $pathReason = Get-SensitivePathReason -FilePath $filePath
    if ($pathReason) {
        $failures.Add([pscustomobject]@{
                FilePath = $filePath
                Reason = $pathReason
            })
        continue
    }

    if (-not (Test-ContentScanEligible -FilePath $filePath)) {
        continue
    }

    $text = Get-FileText -FilePath $filePath
    foreach ($reason in (Scan-FileContents -FilePath $filePath -Text $text)) {
        $failures.Add([pscustomobject]@{
                FilePath = $filePath
                Reason = $reason
            })
    }
}

if ($failures.Count -eq 0) {
    if ($All) {
        Write-Host 'Secret check passed for tracked files.'
    } else {
        Write-Host 'Secret check passed for staged files.'
    }
    exit 0
}

[Console]::Error.WriteLine('Commit blocked: possible secrets detected.')
foreach ($failure in $failures) {
    [Console]::Error.WriteLine("- $($failure.FilePath): $($failure.Reason)")
}
[Console]::Error.WriteLine('Move real credentials into ignored local files and keep only blank or placeholder values in tracked examples.')
exit 1
