import type { ApiCheck, PrismaClient, Severity } from '@prisma/client';
import { severityRank } from '../services/monitoring/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_APIS_LISTED = 100;

export interface AffectedApi {
  apiName: string;
  openAlerts: number;
  highestSeverity: Severity;
}

export interface DashboardStats {
  totalChecks: number;
  checksLast24h: number;
  anomalousChecks: number;
  activeAlerts: number;
  acknowledgedAlerts: number;
  resolvedAlerts: number;
  criticalOrHighActive: number;
  monitoredApis: number;
  affectedApis: AffectedApi[];
  apiHealth: ApiCheck[];
}

export class StatsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async dashboard(now: Date = new Date()): Promise<DashboardStats> {
    const [totalChecks, checksLast24h, anomalousChecks, statusCounts, criticalOrHighActive, openBySeverity, latestPerApi] = await Promise.all([
      this.prisma.apiCheck.count(),
      this.prisma.apiCheck.count({ where: { checkedAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
      this.prisma.apiCheck.count({ where: { anomalyCount: { gt: 0 } } }),
      this.prisma.alert.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.alert.count({ where: { status: 'ACTIVE', severity: { in: ['HIGH', 'CRITICAL'] } } }),
      this.prisma.alert.groupBy({ by: ['apiName', 'severity'], where: { status: { not: 'RESOLVED' } }, _count: { _all: true } }),
      // Latest check per API (DISTINCT ON via Prisma).
      this.prisma.apiCheck.findMany({
        distinct: ['apiName'],
        orderBy: [{ apiName: 'asc' }, { checkedAt: 'desc' }],
        take: MAX_APIS_LISTED,
      }),
    ]);

    const countFor = (status: string) => statusCounts.find((s) => s.status === status)?._count._all ?? 0;

    const affected = new Map<string, AffectedApi>();
    for (const row of openBySeverity) {
      const entry = affected.get(row.apiName) ?? { apiName: row.apiName, openAlerts: 0, highestSeverity: row.severity };
      entry.openAlerts += row._count._all;
      if (severityRank(row.severity) > severityRank(entry.highestSeverity)) entry.highestSeverity = row.severity;
      affected.set(row.apiName, entry);
    }

    return {
      totalChecks,
      checksLast24h,
      anomalousChecks,
      activeAlerts: countFor('ACTIVE'),
      acknowledgedAlerts: countFor('ACKNOWLEDGED'),
      resolvedAlerts: countFor('RESOLVED'),
      criticalOrHighActive,
      monitoredApis: latestPerApi.length,
      affectedApis: [...affected.values()].sort((a, b) => severityRank(b.highestSeverity) - severityRank(a.highestSeverity) || b.openAlerts - a.openAlerts),
      apiHealth: latestPerApi,
    };
  }

  recentChecks(limit: number, apiName?: string) {
    return this.prisma.apiCheck.findMany({
      where: apiName ? { apiName } : {},
      orderBy: [{ checkedAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }
}
