export type ContinueCommandInput = {
  issueNumber: number | string;
  repo?: string;
  attempt?: number;
};

export function formatContinueCommand(input: ContinueCommandInput): string {
  const args = ["bun", "run", "roark-coding-agent.ts", "continue", String(input.issueNumber)];
  if (input.repo) args.push("--repo", input.repo);
  if (input.attempt !== undefined) args.push("--attempt", String(input.attempt));
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
