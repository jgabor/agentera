export type Env = Record<string, string | undefined>;

export interface PrimeOpts {
  home?: string | null;
  installRoot?: string | null;
  expectedVersion?: string | null;
  env?: Env;
}

export interface PrimeArgs {
  command?: string;
  guidance?: boolean;
  context?: string | null;
  dashboard?: boolean;
  orientation?: boolean;
  format?: string;
  fields?: string | null;
  home?: string | null;
  installRoot?: string | null;
  expectedVersion?: string | null;
}

export type Io = { out?: (t: string) => void; err?: (t: string) => void };
