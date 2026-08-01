export class ExactReplacementConflictError extends Error {
  constructor(message: string, readonly retainedPaths: string[] = []) {
    super(message);
    this.name = "ExactReplacementConflictError";
  }
}

export class FileReplacementError extends Error {
  readonly code?: string;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "FileReplacementError";
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string") this.code = code;
  }
}
