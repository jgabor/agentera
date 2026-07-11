import type { InvalidInputErrorBody } from "../../cli/errors.js";

export class StateWriteInputError extends Error {
  readonly body: InvalidInputErrorBody;

  constructor(body: InvalidInputErrorBody) {
    super(body.message);
    this.name = "StateWriteInputError";
    this.body = body;
  }
}

export function reject(body: InvalidInputErrorBody): never {
  throw new StateWriteInputError(body);
}
