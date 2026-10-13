/** Stable product identities for the custom and official applications. */
export const CUSTOM_APP_IDENTITY = {
  packageName: 'chat-on-steroids-custom',
  productName: 'Chat On Steroids Custom',
  appId: 'com.chatonsteroids.custom',
  desktopName: 'com.chatonsteroids.custom.desktop',
  userDataDir: 'chat-on-steroids-custom',
  artifactNameStem: 'Chat-On-Steroids-Custom-Setup',
  shortcutName: 'Chat On Steroids Custom',
  uninstallDisplayName: 'Chat On Steroids Custom',
  autoUpdateEnabled: false,
  bridgeAppId: 'chat-on-steroids-custom'
} as const;

export const OFFICIAL_APP_IDENTITY = {
  packageName: 'chat-on-steroids',
  productName: 'Chat On Steroids',
  appId: 'com.chatonsteroids.app',
  desktopName: 'com.chatonsteroids.app.desktop',
  userDataDir: 'chat-on-steroids',
  artifactNameStem: 'Chat-On-Steroids-Setup',
  shortcutName: 'Chat On Steroids',
  uninstallDisplayName: 'Chat On Steroids',
  autoUpdateEnabled: true,
  bridgeAppId: 'chat-on-steroids'
} as const;
