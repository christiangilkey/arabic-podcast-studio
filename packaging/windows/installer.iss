; Inno Setup script for Tamkeen (first released as "Arabic Podcast Studio").
; The AppId, install folder and executable name are unchanged from that first name, so this
; installer upgrades an existing installation in place.
;   iscc /DAppVersion=0.1.0 packaging\windows\installer.iss
; Installs per-user (no admin prompt) into %LOCALAPPDATA%\Programs. User data lives in
; %APPDATA%\ArabicPodcastStudio and is never touched by install, upgrade or uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Tamkeen"
#define OldAppName "Arabic Podcast Studio"
#define AppExe "ArabicPodcastStudio.exe"

[Setup]
AppId={{6B0E3C1A-5D4F-4A9B-9E1F-2C7A8D3B4E51}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Tamkeen contributors
DefaultDirName={localappdata}\Programs\ArabicPodcastStudio
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Use the new Start-menu folder name even when upgrading an install made under the old name.
UsePreviousGroup=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\dist
OutputBaseFilename=Tamkeen-{#AppVersion}-Windows-Setup
SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\..\LICENSE
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\dist\ArabicPodcastStudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Shortcuts left by versions that used the old name.
[InstallDelete]
Type: files; Name: "{autoprograms}\{#OldAppName}\{#OldAppName}.lnk"
Type: files; Name: "{autodesktop}\{#OldAppName}.lnk"
Type: dirifempty; Name: "{autoprograms}\{#OldAppName}"

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
