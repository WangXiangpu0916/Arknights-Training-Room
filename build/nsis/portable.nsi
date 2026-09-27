Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"
ManifestDPIAware true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor /SOLID lzma
Name "训练室"
OutFile "${OUTPUT}"
Icon "${ICON}"
VIProductVersion "${NUMERIC_VERSION}"
VIAddVersionKey "ProductName" "训练室"
VIAddVersionKey "FileDescription" "训练室"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Arknights Training Room contributors"
Section
  InitPluginsDir
  ${If} ${RunningX64}
    SetRegView 64
    ReadRegStr $1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${Else}
    ReadRegStr $1 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $1 == ""
    ReadRegStr $1 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $1 == ""
    NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\WebView2Setup.exe"
    Pop $0
    ${If} $0 != "success"
      MessageBox MB_ICONSTOP "无法下载 WebView2，请检查网络后重试。"
      SetErrorLevel 1
      Quit
    ${EndIf}
    ExecWait '"$PLUGINSDIR\WebView2Setup.exe" /silent /install' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP "WebView2 安装失败，请安装 Microsoft Edge WebView2 Runtime 后重试。"
      SetErrorLevel $0
      Quit
    ${EndIf}
  ${EndIf}
  SetOutPath "$PLUGINSDIR\app"
  File /r "${PAYLOAD}\*"
  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH")'
  ExecWait '"$PLUGINSDIR\app\训练室.exe"' $0
  SetErrorLevel $0
SectionEnd
