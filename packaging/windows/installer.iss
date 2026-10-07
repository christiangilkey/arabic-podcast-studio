; Inno Setup script for Arabic Podcast Studio.
;   iscc /DAppVersion=0.1.0 packaging\windows\installer.iss
; Installs per-user (no admin prompt) into %LOCALAPPDATA%\Programs. User data lives in
; %APPDATA%\ArabicPodcastStudio and is never touched by install, upgrade or uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Arabic Podcast Studio"
#define AppExe "ArabicPodcastStudio.exe"

[Setup]
AppId={{6B0E3C1A-5D4F-4A9B-9E1F-2C7A8D3B4E51}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Arabic Podcast Studio contributors
DefaultDirName={localappdata}\Programs\ArabicPodcastStudio
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\..\dist
OutputBaseFilename=ArabicPodcastStudio-{#AppVersion}-Windows-Setup
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

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
