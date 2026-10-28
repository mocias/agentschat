$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$rows = [System.Collections.Generic.List[object]]::new()
$product = 'codex|deepseek|\bdsh\b|qoder|workbuddy|claude|zcode'
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  Get-ItemProperty $key | Where-Object { $_.DisplayName -match $product } | ForEach-Object {
    $icon = [string]$_.DisplayIcon
    if ($icon -match '^"([^"]+)"') { $icon = $Matches[1] } else { $icon = $icon -replace ',[-\d]+$','' }
    $rows.Add(@{name=$_.DisplayName;location=$_.InstallLocation;exe=$icon;source='系统安装记录'})
  }
}
Get-CimInstance Win32_Process | Where-Object { $_.Name -match $product -or ($_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -match 'OpenAI.Codex') } | ForEach-Object {
  $rows.Add(@{name=$_.Name;exe=$_.ExecutablePath;source='运行中的进程'})
}
Get-AppxPackage | Where-Object { $_.Name -match $product } | ForEach-Object {
  $rows.Add(@{name=$_.Name;location=$_.InstallLocation;source='Windows 应用包'})
}
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))) {
  if (-not $folder) { continue }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse | Where-Object { $_.BaseName -match $product } | Select-Object -First 60 | ForEach-Object {
    $shortcut = $shortcutShell.CreateShortcut($_.FullName)
    $rows.Add(@{name=$_.BaseName;exe=$shortcut.TargetPath;source='系统快捷方式'})
  }
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress -Depth 3
