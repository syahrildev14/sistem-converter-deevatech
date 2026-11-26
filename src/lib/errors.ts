/** An error whose message is safe and meaningful to show to the end user. */
export class UserError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export function toUserMessage(err: unknown): string {
  if (err instanceof UserError) return err.message;
  return 'Terjadi kesalahan internal saat memproses media. Coba lagi atau hubungi admin.';
}
