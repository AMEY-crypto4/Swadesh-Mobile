import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const badRequest = (msg: string) => new HttpError(400, msg, 'bad_request');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'forbidden');

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: { code: 'validation_failed', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  if ((err as { code?: string }).code === 'ER_DUP_ENTRY') return res.status(409).json({ error: { code: 'conflict', message: 'Already exists' } });
  if ((err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
}
