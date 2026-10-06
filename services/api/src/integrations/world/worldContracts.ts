export type WorldSourceKind = 'rss' | 'weather' | 'hacker-news' | 'arxiv' | 'pubmed' | 'bluesky' | 'github';

export interface WorldSource {
  id: string;
  kind: WorldSourceKind;
  title: string;
  url: string;
  query: string | null;
  intervalMinutes: number;
  nextRunAt: string;
}

export interface WorldItemInput {
  externalId: string;
  title: string;
  url: string;
  summary?: string;
  publishedAt?: string;
  author?: string;
}

export interface WorldItem {
  id: string;
  sourceId: string;
  sourceTitle: string;
  title: string;
  url: string;
  summary?: string;
  author?: string;
  publishedAt?: string;
  discoveredAt: string;
}

export interface WorldReader {
  latestItems(limit?: number): readonly WorldItem[];
}

export type WorldSubscriptionApproval = 'pending' | 'approved' | 'rejected';
export type WorldSubscriptionStatus = 'trial' | 'active' | 'paused' | 'rejected';

export interface WorldSubscription {
  id: string;
  feedURL: string;
  title: string;
  status: WorldSubscriptionStatus;
  approval: WorldSubscriptionApproval;
  reason: string;
  discoveredAt: string;
  trialExpiresAt: string;
  fetchedItemCount: number;
  updatedAt: string;
}

export type WorldSourceOrigin = 'built-in' | 'approved-subscription';

export interface WorldSourceSummary {
  id: string;
  kind: WorldSourceKind;
  title: string;
  url: string;
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt?: string;
  nextRunAt: string;
  hasError: boolean;
  fetchedItemCount: number;
  origin: WorldSourceOrigin;
}

export interface WorldSubscriptionReader {
  sources(): readonly WorldSourceSummary[];
  subscriptions(): readonly WorldSubscription[];
  decideSubscription(
    id: string,
    decision: 'approve' | 'reject',
    expectedUpdatedAt: string,
    decidedAt?: string,
  ): WorldSubscription;
}
