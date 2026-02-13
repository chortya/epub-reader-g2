export function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

export function appendEventLog(text: string): void {
  const el = document.getElementById('event-log');
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${text}\n` + (el.textContent ?? '');
  // Keep log manageable
  const lines = el.textContent.split('\n');
  if (lines.length > 200) {
    el.textContent = lines.slice(0, 200).join('\n');
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutHandle: number | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutHandle = window.setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle != null) window.clearTimeout(timeoutHandle);
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function truncateForList(s: string, maxChars = 40): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars - 1) + '\u2026';
}
