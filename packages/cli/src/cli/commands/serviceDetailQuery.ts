export type ServiceOwner = "report" | "check" | "upgrade" | "doctor" | "app-home";
export function isServiceDetailQuery(args: string[]): boolean {
  return ((args[0] === "report" || args[0] === "check") && args[1] === "explain") || (["upgrade", "doctor", "app-home"].includes(args[0]) && args.slice(1).some((arg) => arg.split("=")[0] === "--explain"));
}
export function serviceDetailArgs(args: string[]): string[] {
  if (args[0] === "report" || args[0] === "check") return args.slice(2);
  const index = args.indexOf("--explain");
  return args.slice(1).filter((_arg, i) => i + 1 !== index);
}
