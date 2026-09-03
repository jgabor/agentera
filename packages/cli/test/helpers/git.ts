export function gitCommitArgs(...args: string[]): string[] {
  return ["-c", "user.name=Agentera Test", "-c", "user.email=agentera-test@example.invalid", "-c", "commit.gpgsign=false", "commit", ...args];
}
