import { PrismaClient } from '@prisma/client';

/** Shared Prisma client for the worker process. */
export const prisma = new PrismaClient();
