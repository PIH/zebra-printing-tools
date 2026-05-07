# Install zpl2pdf into utils\bin\win-x64\ for use by browser-print-shim.py.
# Pinned to a specific release for reproducibility. Idempotent.

$ErrorActionPreference = 'Stop'
$Version = 'v3.1.1'
$Repo = 'brunoleocam/ZPL2PDF'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$Platform = 'win-x64'  # only supported Windows arch in zpl2pdf releases
$Dest = Join-Path $Here "bin\$Platform"
$Exe = Join-Path $Dest 'zpl2pdf.exe'

if (Test-Path $Exe) {
    Write-Host "zpl2pdf already installed at $Exe"
    & $Exe --version 2>$null
    exit 0
}

$Asset = "ZPL2PDF-$Version-$Platform.zip"
$Url = "https://github.com/$Repo/releases/download/$Version/$Asset"
$ChecksumsUrl = "https://github.com/$Repo/releases/download/$Version/SHA256SUMS.txt"

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
    $AssetPath = Join-Path $Tmp $Asset
    Write-Host "Downloading $Asset..."
    Invoke-WebRequest -Uri $Url -OutFile $AssetPath -UseBasicParsing

    Write-Host "Fetching SHA256SUMS.txt..."
    $ChecksumsPath = Join-Path $Tmp 'SHA256SUMS.txt'
    try {
        Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $ChecksumsPath -UseBasicParsing
        $Line = Get-Content $ChecksumsPath | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" }
        if ($Line) {
            $Expected = ($Line -split '\s+')[0]
            $Actual = (Get-FileHash -Algorithm SHA256 $AssetPath).Hash.ToLower()
            if ($Expected.ToLower() -ne $Actual) {
                throw "SHA256 mismatch! expected=$Expected actual=$Actual"
            }
            Write-Host "  SHA256 OK"
        } else {
            Write-Warning "$Asset not listed in SHA256SUMS.txt - skipping verification."
        }
    } catch [Exception] {
        Write-Warning 'SHA256SUMS.txt not available - skipping verification.'
    }

    Write-Host "Extracting to $Dest\..."
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Expand-Archive -Path $AssetPath -DestinationPath $Dest -Force

    # If the zip wraps everything in a top-level dir, flatten it.
    $TopDirs = Get-ChildItem $Dest -Directory
    if ($TopDirs.Count -eq 1 -and -not (Test-Path $Exe)) {
        Get-ChildItem $TopDirs[0].FullName -Force | Move-Item -Destination $Dest -Force
        Remove-Item $TopDirs[0].FullName -Recurse -Force
    }

    # Rename to lowercase if uppercase executable exists (consistency with Linux script).
    $UpperExe = Join-Path $Dest 'ZPL2PDF.exe'
    if ((Test-Path $UpperExe) -and -not (Test-Path $Exe)) {
        Rename-Item -Path $UpperExe -NewName 'zpl2pdf.exe'
    }

    if (-not (Test-Path $Exe)) {
        throw "Extraction succeeded but zpl2pdf.exe not found at $Exe - archive may be corrupted or missing the binary."
    }

    Write-Host 'Installed:'
    & $Exe --version
} finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
