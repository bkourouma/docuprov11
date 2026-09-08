import pino from 'pino';

export const logger = pino({
  name: 'scan-agent',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
});

export type Logger = pino.Logger;
