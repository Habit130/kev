export class WorkbenchError extends Error {
  constructor(
    message: string,
    readonly category: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected workbench error";
}
