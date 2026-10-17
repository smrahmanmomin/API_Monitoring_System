import type { Alert, ApiCheck, Prisma, PrismaClient } from '@prisma/client';
import type { ListAlertsQuery } from '../schemas/alert.schema.js';

export type AlertWithCheck = Alert & { latestCheck: ApiCheck | null };

const RECENT_OCCURRENCES = 20;

export class AlertRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ListAlertsQuery): Promise<{ data: AlertWithCheck[]; total: number }> {
    const where: Prisma.AlertWhereInput = {
      ...(query.status !== 'ALL' ? { status: { in: query.status } } : {}),
      ...(query.severity ? { severity: { in: query.severity } } : {}),
      ...(query.api_name ? { apiName: { contains: query.api_name, mode: 'insensitive' } } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.alert.findMany({
        where,
        include: { latestCheck: true },
        // Postgres orders enums by declaration order (LOW < MEDIUM < HIGH < CRITICAL).
        orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.alert.count({ where }),
    ]);
    return { data, total };
  }

  findById(id: string) {
    return this.prisma.alert.findUnique({
      where: { id },
      include: {
        latestCheck: true,
        occurrences: { orderBy: { detectedAt: 'desc' }, take: RECENT_OCCURRENCES, include: { check: true } },
      },
    });
  }
}
