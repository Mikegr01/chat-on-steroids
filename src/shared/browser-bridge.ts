/** Ports discoverable by the custom companion extension without colliding with the ordinary app. */
export const BROWSER_BRIDGE_PORTS = [8775, 8776, 8777, 8778, 8779] as const;
/**
 * Where Auto looks when 8775-8779 are all taken. These mirror current-main's two distant fallback
 * ranges while remaining disjoint from the ordinary application's 8765/18765/38765 families.
 * Auto only: the fixed choices in Settings stay the primary range.
 */
export const BROWSER_BRIDGE_FALLBACK_PORTS = [18775, 18776, 18777, 18778, 18779, 38775, 38776, 38777, 38778, 38779] as const;
/** Auto's order, and exactly the list the extension scans (extension/background.js `PORTS`). */
export const BROWSER_BRIDGE_AUTO_PORTS = [...BROWSER_BRIDGE_PORTS, ...BROWSER_BRIDGE_FALLBACK_PORTS] as const;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];
