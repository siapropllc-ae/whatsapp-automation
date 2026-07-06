import type { ButtonDef, CarouselCardDef } from '@wa-engine/shared';
export type { ButtonDef, ButtonType, CarouselCardDef } from '@wa-engine/shared';

export interface OverviewResponse {
  activeSessions: number;
  messagesToday: number;
  totalSent: number;
  totalDelivered: number;
  totalRead: number;
  replyRate: number;
  hotReplies: number;
  sessionPool: SessionSummary[];
  dailyMessages: DailyBucket[];
  recentActivity: RecentMessage[];
}

export interface SessionSummary {
  id: string;
  label: string;
  phoneNumber: string | null;
  status: string;
  mode: string;
  warmupDay: number;
  dailySent: number;
  proxyId: string | null;
  fingerprint: unknown;
}

export interface DailyBucket {
  date: string;
  count: number;
}

export interface RecentMessage {
  id: string;
  phone: string;
  contactName: string | null;
  campaignName: string;
  campaignId: string;
  status: string;
  sentAt: string | null;
  mode: string;
}

export interface Session {
  id: string;
  label: string;
  mode: 'CLOUD_API' | 'BAILEYS';
  phoneNumber: string | null;
  status: 'OFFLINE' | 'CONNECTING' | 'ONLINE' | 'BANNED';
  warmupDay: number;
  dailySent: number;
  proxyId: string | null;
  fingerprint: unknown;
  cloudApi: unknown;
  createdAt: string;
}

export type MediaType = 'IMAGE' | 'DOCUMENT' | 'VIDEO';

export interface Campaign {
  id: string;
  name: string;
  mode: 'CLOUD_API' | 'BAILEYS';
  templateId: string | null;
  status: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'DONE';
  activeFrom: number;
  activeTo: number;
  mediaUrl: string | null;
  mediaType: MediaType | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  createdAt: string;
}

export interface CampaignStats {
  status: string;
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
}

export interface CampaignMessage {
  id: string;
  campaignId: string;
  contactId: string;
  sessionId: string | null;
  wamid: string | null;
  renderedText: string;
  status: string;
  sentAt: string | null;
  phone: string | null;
  contactName: string | null;
}

export type LeadTemp = 'HOT' | 'WARM' | 'COLD';

export interface Contact {
  id: string;
  phone: string;
  name: string | null;
  city: string | null;
  interest: string | null;
  notes: string | null;
  leadTemp: LeadTemp;
  vars: unknown;
  tags: string[];
  valid: boolean;
  createdAt: string;
}

export interface ContactsPage {
  data: Contact[];
  total: number;
  skip: number;
  take: number;
}

export interface Template {
  id: string;
  name: string;
  body: string;
  mediaUrl: string | null;
  category: string | null;
  buttons: ButtonDef[] | null;
  carouselCards: CarouselCardDef[] | null;
  createdAt: string;
}

export interface Reply {
  id: string;
  contactId: string;
  contactPhone: string;
  contactName: string | null;
  campaignId: string | null;
  text: string;
  sentiment: string | null;
  intent: string | null;
  score: number | null;
  handled: boolean;
  buttonId: string | null;
  buttonLabel: string | null;
  createdAt: string;
}

export interface Proxy {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string | null;
  password: string | null;
  country: string | null;
  inUse: boolean;
  lastRotat: string | null;
}

export interface SmartList {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}
