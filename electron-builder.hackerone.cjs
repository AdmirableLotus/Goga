module.exports = {
  appId: 'com.goga.hackerone.preview',
  productName: 'Goga HackerOne Preview',
  executableName: 'Goga-HackerOne-Preview',
  extraMetadata: { main: 'dist/main/main/preview.js' },
  directories: { output: 'artifacts/hackerone-preview-20261025-final' },
  artifactName: 'Goga-HackerOne-Preview-${version}-${arch}-Setup.${ext}',
  win: { target: ['nsis'], icon: 'assets/icon.ico' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: false, createStartMenuShortcut: false, shortcutName: 'Goga HackerOne Preview', runAfterFinish: false },
  files: ['dist/**/*', 'assets/**/*', 'package.json', '!**/.env*', '!**/*credentials*', '!**/*.log'],
  npmRebuild: false,
  publish: null,
}
