$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'output/installer-qa'))
$install = Join-Path $testRoot 'installed'
if (!$testRoot.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe installer test path' }
$key = 'HKCU:\Software\89035d73-f384-5e6c-bda4-e2c88d3f133f'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\89035d73-f384-5e6c-bda4-e2c88d3f133f'
foreach ($entry in @($key,$uninstallKey,$key.Replace('HKCU:','HKLM:'),$uninstallKey.Replace('HKCU:','HKLM:'))) {
  if (Test-Path -LiteralPath $entry) { throw "Existing installation registry found; installer QA will not change it: $entry" }
}
$version = (Get-Content -Raw -LiteralPath (Join-Path $workspace 'package.json') | ConvertFrom-Json).version
$setup = Join-Path $workspace "release/Arknights-Training-Room-$version-Setup-x64.exe"
if (Test-Path -LiteralPath $install) { throw 'Installer test directory already exists' }
New-Item -ItemType Directory -Path (Join-Path $install 'resources/training-room-resource'),(Join-Path $install 'locales') -Force | Out-Null
# Model the existing install layout and identity without executing or replacing a user installation.
foreach ($file in @('resources/app.asar','resources/app-update.yml','chrome_100_percent.pak','locales/zh-CN.pak','resources/training-room-resource/old.json','user-notes.txt')) {
  Set-Content -LiteralPath (Join-Path $install $file) -Value 'legacy fixture'
}
New-Item -Path $key,$uninstallKey -Force | Out-Null
New-ItemProperty -LiteralPath $key -Name InstallLocation -Value $install -Force | Out-Null
New-ItemProperty -LiteralPath $uninstallKey -Name DisplayVersion -Value '0.0.20-beta.15' -Force | Out-Null
try {
  $process = Start-Process -FilePath $setup -ArgumentList @('/S','/NS','/CURRENTUSER',"/D=$install") -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  $exe = Join-Path $install '训练室.exe'
  if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $version) { throw 'Installed version mismatch' }
  # Tauri patches only this three-byte bundle marker while packing NSIS, then restores the standalone EXE.
  $installedBytes = [IO.File]::ReadAllBytes($exe)
  $markerOffset = [Text.Encoding]::ASCII.GetString($installedBytes).IndexOf('__TAURI_BUNDLE_TYPE_VAR_NSS', [StringComparison]::Ordinal)
  if ($markerOffset -lt 0) { throw 'NSIS bundle marker missing' }
  [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_UNK').CopyTo($installedBytes, $markerOffset)
  $normalizedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($installedBytes))
  if ($normalizedHash -ne (Get-FileHash -LiteralPath (Join-Path $workspace 'release/win-unpacked/训练室.exe')).Hash) { throw 'Installed executable differs beyond the bundle marker' }
  foreach ($old in @('resources/app.asar','chrome_100_percent.pak','locales','resources/training-room-resource')) {
    if (Test-Path -LiteralPath (Join-Path $install $old)) { throw "Old runtime remains: $old" }
  }
  if (!(Test-Path -LiteralPath (Join-Path $install 'user-notes.txt'))) { throw 'Unknown local files were removed' }
  if ((Get-ItemPropertyValue -LiteralPath $key -Name InstallLocation) -ne $install) { throw 'Install location changed' }
  # Existing automatic updater flags must complete without opening the setup wizard.
  $update = Start-Process -FilePath $setup -ArgumentList @('--updated','/NS','/CURRENTUSER') -WindowStyle Hidden -Wait -PassThru
  if ($update.ExitCode -ne 0) { throw "In-place update failed: $($update.ExitCode)" }
  $remove = Start-Process -FilePath (Join-Path $install 'uninstall.exe') -ArgumentList @('/S','/CURRENTUSER') -WindowStyle Hidden -Wait -PassThru
  if ($remove.ExitCode -ne 0) { throw "Uninstall failed: $($remove.ExitCode)" }
  if (Test-Path -LiteralPath $exe) { throw 'Uninstall left the executable' }
  if (!(Test-Path -LiteralPath (Join-Path $install 'user-notes.txt'))) { throw 'Uninstall removed an unrelated file' }
  @{pass=$true;version=$version;legacyLayoutUpgrade=$true;installIdentityPreserved=$true;updaterArguments=$true;uninstallPreservesUnrelatedFiles=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot 'report.json')
} finally {
  # These registry keys were proved absent before the test and belong to this isolated fixture.
  foreach ($entry in @($key,$uninstallKey)) { if (Test-Path -LiteralPath $entry) { Remove-Item -LiteralPath $entry -Recurse -Force } }
  $resolved = [IO.Path]::GetFullPath($install)
  if ($resolved -ne (Join-Path $testRoot 'installed')) { throw 'Unsafe installer cleanup path' }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Get-Content -LiteralPath (Join-Path $testRoot 'report.json')
