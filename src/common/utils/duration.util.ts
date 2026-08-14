export function parseDurationToSeconds(duration: string): number {
  if (/^\d+$/.test(duration)) {
    return Number(duration);
  }

  const parts = duration.split(':').map((part) => Number(part));

  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}
