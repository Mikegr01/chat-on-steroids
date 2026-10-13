/** Ports discoverable by the companion extension without additional host permissions. */
export const BROWSER_BRIDGE_PORTS = [8775, 8776, 8777, 8778, 8779] as const;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];
