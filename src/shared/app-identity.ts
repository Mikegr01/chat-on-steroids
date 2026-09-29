/**
 * Centralized identity constants for Chat On Steroids Custom vs Official Chat On Steroids.
 */

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
  bridgeAppId: 'chat-on-steroids-custom',
  extensionName: 'Chat On Steroids Custom',
  extensionActionTitle: 'Chat On Steroids Custom',
  extensionDescription: 'Connects ChatGPT to Chat On Steroids Custom and controls browser tabs in the background with DOM, screenshots and developer tools.',
  extensionDirName: 'extension'
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
  bridgeAppId: 'chat-on-steroids',
  extensionName: 'Chat On Steroids companion',
  extensionActionTitle: 'Chat On Steroids',
  extensionDescription: 'Connects ChatGPT to Chat On Steroids and controls browser tabs in the background with DOM, screenshots and developer tools.',
  extensionDirName: 'extension'
} as const;
