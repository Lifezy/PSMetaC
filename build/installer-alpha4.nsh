!include nsDialogs.nsh
!include WinMessages.nsh
!include LogicLib.nsh

!define MUI_WELCOMEPAGE_TITLE "欢迎使用 PSMetaC ${VERSION}"
!define MUI_FINISHPAGE_TITLE "PSMetaC ${VERSION} 安装完成"
!define MUI_FINISHPAGE_TEXT "PaceSpace Metadata Cleaner 已安装到这台电脑。"
!define MUI_UNFINISHPAGE_TITLE "PSMetaC ${VERSION} 已卸载"
!define MUI_UNFINISHPAGE_TEXT "程序文件已移除；成品、报告和用户选择的数据目录会继续保留。"

Var PSMetaCWelcomeDialog
!ifndef BUILD_UNINSTALLER
  Var PSMetaCWelcomeDirectory
  Var PSMetaCWelcomeBrowse
  Var PSMetaCFinishDialog
  Var PSMetaCFinishLaunch
!endif
Var PSMetaCTitleFont
Var PSMetaCHeadingFont
Var PSMetaCBodyFont
Var PSMetaCSmallFont

!macro PSMetaCSetFont CONTROL FONT
  SendMessage ${CONTROL} ${WM_SETFONT} ${FONT} 0
!macroend

!macro PSMetaCLabel X Y W H TEXT FONT COLOR BACKGROUND OUT
  ${NSD_CreateLabel} ${X} ${Y} ${W} ${H} "${TEXT}"
  Pop ${OUT}
  !insertmacro PSMetaCSetFont ${OUT} ${FONT}
  SetCtlColors ${OUT} ${COLOR} ${BACKGROUND}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
  Function PSMetaCApplyWindowCopy
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:PSMetaC ${VERSION} 安装程序"
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:开始安装"
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:取消安装"
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 ${SW_HIDE}
  FunctionEnd

  Function PSMetaCWelcomeBrowseClick
    ${NSD_GetText} $PSMetaCWelcomeDirectory $0
    nsDialogs::SelectFolderDialog "选择 PSMetaC 安装位置" "$0"
    Pop $0
    ${If} $0 != "error"
      ${NSD_SetText} $PSMetaCWelcomeDirectory "$0"
    ${EndIf}
  FunctionEnd

  Function PSMetaCWelcomeShow
    Call PSMetaCApplyWindowCopy
    GetDlgItem $0 $HWNDPARENT 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:PaceSpace Metadata Cleaner"
    GetDlgItem $0 $HWNDPARENT 1038
    SendMessage $0 ${WM_SETTEXT} 0 "STR:安装程序 · v${VERSION}"
    nsDialogs::Create 1018
    Pop $PSMetaCWelcomeDialog
    ${If} $PSMetaCWelcomeDialog == error
      Abort
    ${EndIf}

    CreateFont $PSMetaCTitleFont "Microsoft YaHei UI" 18 700
    CreateFont $PSMetaCHeadingFont "Microsoft YaHei UI" 11 600
    CreateFont $PSMetaCBodyFont "Microsoft YaHei UI" 9 400
    CreateFont $PSMetaCSmallFont "Microsoft YaHei UI" 8 400
    SetCtlColors $PSMetaCWelcomeDialog 0x24262A 0xF5F6F7

    !insertmacro PSMetaCLabel 0u 2u 300u 24u "欢迎使用 PSMetaC" $PSMetaCTitleFont 0x24262A 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 29u 300u 14u "PSD / PSB 元数据清理与脱敏工具" $PSMetaCHeadingFont 0x4E535B 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 49u 300u 13u "专业清理冗余 XMP 元数据与 DocumentAncestors 溯源信息，" $PSMetaCBodyFont 0x6A7079 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 63u 300u 13u "实现文件脱敏和体积瘦身，并完整保留图层与画面内容。" $PSMetaCBodyFont 0x6A7079 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 82u 300u 13u "仅安装程序，不会读取或修改任何 PSD / PSB 文件。" $PSMetaCSmallFont 0x247558 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 102u 300u 12u "安装位置" $PSMetaCHeadingFont 0x24262A 0xF5F6F7 $0

    ${NSD_CreateDirRequest} 0u 117u 238u 20u "$INSTDIR"
    Pop $PSMetaCWelcomeDirectory
    !insertmacro PSMetaCSetFont $PSMetaCWelcomeDirectory $PSMetaCBodyFont
    ${NSD_CreateBrowseButton} 244u 117u 56u 20u "选择…"
    Pop $PSMetaCWelcomeBrowse
    !insertmacro PSMetaCSetFont $PSMetaCWelcomeBrowse $PSMetaCBodyFont
    ${NSD_OnClick} $PSMetaCWelcomeBrowse PSMetaCWelcomeBrowseClick
    nsDialogs::Show
  FunctionEnd

  Function PSMetaCWelcomeLeave
    ${NSD_GetText} $PSMetaCWelcomeDirectory $INSTDIR
    ${If} $INSTDIR == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "请选择安装位置。"
      Abort
    ${EndIf}
  FunctionEnd

  Function PSMetaCInstallFilesShow
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:正在安装 PSMetaC ${VERSION}"
    GetDlgItem $0 $HWNDPARENT 1004
    ${If} $0 <> 0
      SendMessage $0 ${PBM_SETBARCOLOR} 0 0x00D86159
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:取消安装"
  FunctionEnd

  Function PSMetaCFinishShow
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:PSMetaC ${VERSION} 安装完成"
    GetDlgItem $0 $HWNDPARENT 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:PaceSpace Metadata Cleaner"
    GetDlgItem $0 $HWNDPARENT 1038
    SendMessage $0 ${WM_SETTEXT} 0 "STR:安装已完成 · v${VERSION}"
    nsDialogs::Create 1018
    Pop $PSMetaCFinishDialog
    ${If} $PSMetaCFinishDialog == error
      Abort
    ${EndIf}

    CreateFont $PSMetaCTitleFont "Microsoft YaHei UI" 18 700
    CreateFont $PSMetaCHeadingFont "Microsoft YaHei UI" 11 600
    CreateFont $PSMetaCBodyFont "Microsoft YaHei UI" 9 400
    CreateFont $PSMetaCSmallFont "Microsoft YaHei UI" 8 400
    SetCtlColors $PSMetaCFinishDialog 0x24262A 0xF5F6F7

    !insertmacro PSMetaCLabel 0u 12u 300u 18u "安装完成" $PSMetaCSmallFont 0x247558 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 34u 300u 28u "PSMetaC 已准备好" $PSMetaCTitleFont 0x24262A 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 69u 300u 14u "已安装版本：v${VERSION}" $PSMetaCBodyFont 0x6A7079 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 84u 300u 14u "首次启动后，请先完成设置并运行环境检测。" $PSMetaCBodyFont 0x6A7079 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 108u 300u 28u "安装过程没有读取、打开或修改任何 PSD / PSB 文件。" $PSMetaCBodyFont 0x247558 0xF5F6F7 $0

    ${NSD_CreateCheckbox} 0u 145u 300u 24u "完成后启动 PSMetaC"
    Pop $PSMetaCFinishLaunch
    !insertmacro PSMetaCSetFont $PSMetaCFinishLaunch $PSMetaCBodyFont
    ${NSD_Check} $PSMetaCFinishLaunch

    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 ${SW_HIDE}
    nsDialogs::Show
  FunctionEnd

  Function PSMetaCFinishLeave
    ${NSD_GetState} $PSMetaCFinishLaunch $0
    ${If} $0 == ${BST_CHECKED}
      ExecShell "open" "$INSTDIR\psmetac.exe"
    ${EndIf}
  FunctionEnd
!else
  Function un.PSMetaCUninstallWelcomeShow
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:PSMetaC ${VERSION} 卸载程序"
    GetDlgItem $0 $HWNDPARENT 1037
    SendMessage $0 ${WM_SETTEXT} 0 "STR:PaceSpace Metadata Cleaner"
    GetDlgItem $0 $HWNDPARENT 1038
    SendMessage $0 ${WM_SETTEXT} 0 "STR:卸载程序 · v${VERSION}"
    nsDialogs::Create 1018
    Pop $PSMetaCWelcomeDialog
    ${If} $PSMetaCWelcomeDialog == error
      Abort
    ${EndIf}

    CreateFont $PSMetaCTitleFont "Microsoft YaHei UI" 18 700
    CreateFont $PSMetaCHeadingFont "Microsoft YaHei UI" 11 600
    CreateFont $PSMetaCBodyFont "Microsoft YaHei UI" 9 400
    CreateFont $PSMetaCSmallFont "Microsoft YaHei UI" 8 400
    SetCtlColors $PSMetaCWelcomeDialog 0x24262A 0xF5F6F7

    !insertmacro PSMetaCLabel 0u 12u 300u 15u "PACE SPACE METADATA CLEANER" $PSMetaCSmallFont 0x5961D8 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 34u 300u 28u "卸载 PSMetaC" $PSMetaCTitleFont 0x24262A 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 72u 300u 16u "将移除 PSMetaC ${VERSION} 的程序文件和快捷方式。" $PSMetaCBodyFont 0x6A7079 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 90u 300u 16u "成品、报告及用户选择的软件数据目录不会自动删除。" $PSMetaCBodyFont 0x6A7079 0xF5F6F7 $0
    !insertmacro PSMetaCLabel 0u 128u 300u 28u "继续前请先退出 PSMetaC；正在处理的任务不会被强制中断。" $PSMetaCBodyFont 0x9A5A32 0xF5F6F7 $0

    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:开始卸载"
    GetDlgItem $0 $HWNDPARENT 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:取消"
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 ${SW_HIDE}
    nsDialogs::Show
  FunctionEnd

  Function un.PSMetaCUninstallWelcomeLeave
  FunctionEnd
!endif

!macro customWelcomePage
  Page custom PSMetaCWelcomeShow PSMetaCWelcomeLeave
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "正在安装 PSMetaC ${VERSION}"
  !define MUI_PAGE_HEADER_SUBTEXT "正在复制程序文件并创建当前用户的快捷方式。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PSMetaCInstallFilesShow
!macroend

!macro customFinishPage
  Page custom PSMetaCFinishShow PSMetaCFinishLeave
!macroend

!macro customUnWelcomePage
  UninstPage custom un.PSMetaCUninstallWelcomeShow un.PSMetaCUninstallWelcomeLeave
!macroend
