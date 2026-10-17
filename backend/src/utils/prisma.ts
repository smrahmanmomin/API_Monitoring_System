import { PrismaClient } from '@prisma/client';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
  });
}

export type { PrismaClient };
