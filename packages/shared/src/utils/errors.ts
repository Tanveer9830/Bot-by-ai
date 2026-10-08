/** Shared error taxonomy. Every user-visible failure carries a safe message. */

export class AppError extends Error {
  public readonly code: string;
  public readonly userMessage: string;
  public readonly meta: Record<string, unknown>;
  public readonly expected: boolean;

  constructor(
    code: string,
    userMessage: string,
    options: { cause?: unknown; meta?: Record<string, unknown>; expected?: boolean } = {},
  ) {
    super(`${code}: ${userMessage}`, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.meta = options.meta ?? {};
    this.expected = options.expected ?? true;
  }
}

/** A failure that is safe (and useful) to show to a Discord user / dashboard user. */
export class UserFacingError extends AppError {
  constructor(userMessage: string, code = 'USER_ERROR', meta: Record<string, unknown> = {}) {
    super(code, userMessage, { meta, expected: true });
    this.name = 'UserFacingError';
  }
}

export class ValidationError extends AppError {
  constructor(userMessage: string, meta: Record<string, unknown> = {}) {
    super('VALIDATION_ERROR', userMessage, { meta, expected: true });
    this.name = 'ValidationError';
  }
}

export class PermissionError extends AppError {
  constructor(userMessage = 'You do not have permission to use this command.', meta: Record<string, unknown> = {}) {
    super('PERMISSION_DENIED', userMessage, { meta, expected: true });
    this.name = 'PermissionError';
  }
}

export class NotBotOwnerError extends PermissionError {
  constructor(userId: string) {
    super(
      'Only the bot owners configured in `BOT_OWNER_IDS` can use this command. Server administrator permissions do not grant access.',
      { userId, requiredRole: 'bot_owner' },
    );
    this.name = 'NotBotOwnerError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, meta: Record<string, unknown> = {}) {
    super('NOT_FOUND', `${what} was not found.`, { meta, expected: true });
    this.name = 'NotFoundError';
  }
}

export class CooldownError extends AppError {
  constructor(public readonly retryAfterMs: number, meta: Record<string, unknown> = {}) {
    super('COOLDOWN', `Please wait ${(retryAfterMs / 1000).toFixed(1)}s before using this again.`, {
      meta: { ...meta, retryAfterMs },
      expected: true,
    });
    this.name = 'CooldownError';
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfterMs: number) {
    super('RATE_LIMITED', 'Too many requests. Please slow down.', {
      meta: { retryAfterMs },
      expected: true,
    });
    this.name = 'RateLimitError';
  }
}

/** Insufficient funds etc. — expected business failures. */
export class BusinessError extends AppError {
  constructor(code: string, userMessage: string, meta: Record<string, unknown> = {}) {
    super(code, userMessage, { meta, expected: true });
    this.name = 'BusinessError';
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.userMessage;
  return 'Something went wrong while running that action. The error has been logged.';
}

export function isExpectedError(error: unknown): boolean {
  return error instanceof AppError && error.expected;
}

/** Never let an unexpected error message leak secrets or internals to users. */
export function errorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as AppError).code,
      stack: error.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }
  return { name: 'UnknownError', message: String(error) };
}
