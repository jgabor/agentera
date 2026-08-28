export type Env = Record<string, string | undefined>;

export interface PrimeOpts {
  projectRoot?: string | null;
  home?: string | null;
  installRoot?: string | null;
  expectedVersion?: string | null;
  env?: Env;
}

export interface PrimeArgs {
  projectRoot?: string | null;
  command?: string;
  guidance?: boolean;
  context?: string | null;
  dashboard?: boolean;
  orientation?: boolean;
  format?: string;
  fields?: string | null;
  input?: string | null;
  termInput?: string | null;
  home?: string | null;
  installRoot?: string | null;
  expectedVersion?: string | null;
}

export type Io = { out?: (t: string) => void; err?: (t: string) => void; stdin?: () => string | Buffer };
