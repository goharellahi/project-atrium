import {
  ArgumentMetadata,
  Injectable,
  PipeTransform,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ZodType } from 'zod';

/**
 * zod 4 validation. 422 on failure, never 400 — the brief's contract is that a
 * malformed body is unprocessable, and 409 is reserved for illegal state
 * transitions so the two are never confused in a client's error handling.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Request validation failed',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
}

/** Sugar: `@Body(zodBody(LoginSchema)) body: LoginInput` */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
