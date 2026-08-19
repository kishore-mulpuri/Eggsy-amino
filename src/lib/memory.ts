// Device memory diagnostics — the face engine is the biggest RAM consumer in
// the app, and on a 2GB phone it is the main thing that can get the process
// killed. These reads are best-effort (Chrome/Android WebView only) and are
// shown in Settings so a memory problem is visible on the phone itself
// instead of only traceable from a force-quit.

export interface MemoryInfo {
  /** navigator.deviceMemory — total device RAM in GB (Chrome/WebView only). */
  deviceMemoryGB: number | null;
  /** performance.memory.usedJSHeapSize in MB. */
  usedJSHeapMB: number | null;
  /** performance.memory.jsHeapSizeLimit in MB — the JS heap ceiling. */
  jsHeapLimitMB: number | null;
}

export function getMemoryInfo(): MemoryInfo {
  const nav = navigator as any;
  const perf = performance as any;
  return {
    deviceMemoryGB: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    usedJSHeapMB:
      perf.memory && typeof perf.memory.usedJSHeapSize === "number"
        ? Math.round(perf.memory.usedJSHeapSize / 1_048_576)
        : null,
    jsHeapLimitMB:
      perf.memory && typeof perf.memory.jsHeapSizeLimit === "number"
        ? Math.round(perf.memory.jsHeapSizeLimit / 1_048_576)
        : null,
  };
}

/** Human-readable one-liner for Settings diagnostics. */
export function describeMemory(info: MemoryInfo): string {
  const parts: string[] = [];
  if (info.deviceMemoryGB != null) parts.push(`${info.deviceMemoryGB} GB device`);
  if (info.usedJSHeapMB != null && info.jsHeapLimitMB != null) {
    parts.push(`JS heap ${info.usedJSHeapMB}/${info.jsHeapLimitMB} MB`);
  } else if (info.usedJSHeapMB != null) {
    parts.push(`JS heap ${info.usedJSHeapMB} MB`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Memory info unavailable";
}
