!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /IM cutline-sidecar.exe /T'
  Sleep 400
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /IM cutline-sidecar.exe /T'
  Sleep 400
!macroend
