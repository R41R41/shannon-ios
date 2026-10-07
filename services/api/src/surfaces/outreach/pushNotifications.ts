export { SQLitePushNotificationStore } from './store/pushNotificationStore.js';

export type APNsEnvironment = 'sandbox' | 'production';

export interface PendingPushNotification {
  kind: 'initiative' | 'agent_task' | 'testflight_failure';
  initiativeId: string;
  deviceId: string;
  deviceToken: string;
  environment: APNsEnvironment;
  threadId: string;
  content: string;
  expression: string;
  createdAt: string;
  badgeCount: number;
  taskId?: string;
  title?: string;
}

export interface PushDeliveryResult {
  delivered: boolean;
  permanentFailure: boolean;
  status: number;
  reason: string | null;
}

export interface PushNotificationSender {
  readonly enabled: boolean;
  send(notification: PendingPushNotification): Promise<PushDeliveryResult>;
}

export {
  APNsNotificationSender,
  DisabledPushNotificationSender,
  createConfiguredPushNotificationSender,
  deliverPendingPushNotifications,
} from './pushNotificationSender.js';
