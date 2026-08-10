export interface SkipSignal {
  pass: number;
  reason: string;
}

// Matches a line like "SKIP:3:No changes required."
const SKIP_REGEX = /^SKIP:(\d+):(.+)$/m;

export function parseSkipSignal(output: string): SkipSignal | undefined {
  const match = output.match(SKIP_REGEX);
  if (!match?.[1]) return undefined;
  return { pass: Number(match[1]), reason: (match[2] ?? '').trim() };
}
