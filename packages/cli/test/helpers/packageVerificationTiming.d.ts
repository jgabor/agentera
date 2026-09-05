declare module "*scripts/package-verification-timing.mjs" {
  export type PackageTimings = Record<string, number>;
  export function readPackageTimings(file: string | undefined): PackageTimings;
  export function writePackageTimings(file: string | undefined, timings: PackageTimings): void;
  export function createPackageTimingRecorder(
    file: string | undefined,
    now?: () => bigint,
  ): {
    start(phase: string): void;
    finish(complete: boolean): void;
  };
  export function completePackageTimings(file: string | undefined, wallMs: number): PackageTimings;
  export function packageTimingSummary(timings: PackageTimings): string;
}
