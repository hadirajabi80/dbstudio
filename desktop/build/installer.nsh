; Rowlit NSIS customisation (electron-builder.yml: nsis.include).
;
; Rowlit 1.2+ is the renamed DbStudio (<= 1.1.0): same appId, same nsis.guid, so the same "Software\<guid>" install key
; and the same uninstall entry. The installer therefore upgrades DbStudio in place: it runs the old uninstaller
; silently (which removes DbStudio.exe, its folder and its "DbStudio" shortcuts and keeps %APPDATA%\DbStudio), then
; installs Rowlit and creates "Rowlit" shortcuts.
;
; Without help it would reuse the old folder name, because the per-user install folder is read back from the
; InstallLocation value of the previous install (...\Programs\DbStudio, or ...\Programs\DbStudio\Rowlit after the
; directory page appends the product name). When that value points at the default ...\Programs\DbStudio folder it is
; dropped here, before any page reads it, so the default ...\Programs\Rowlit is used. The old version is still found and
; uninstalled from its own folder: uninstallOldVersion falls back to the folder of the UninstallString when
; InstallLocation is empty. A folder the user chose elsewhere (or passed with /D=) is left alone.
!macro customInit
  Push $0
  Push $1
  Push $2
  ${if} $installMode == "CurrentUser"
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $0 != ""
      ${GetFileName} $0 $1
      ${GetParent} $0 $2
      ${if} $1 == "DbStudio"
      ${andIf} $2 == "$LOCALAPPDATA\Programs"
        DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        !insertmacro setInstallModePerUser
      ${endIf}
    ${endIf}
  ${endIf}
  Pop $2
  Pop $1
  Pop $0
!macroend
