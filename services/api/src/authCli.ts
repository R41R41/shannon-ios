import { configuredAuthPepper, SQLiteDeviceAuthStore } from './deviceAuth.js';
import { configuredDatabasePath } from './sqliteStore.js';

const command = process.argv[2];
if (process.env.SHANNON_AUTH_MODE === 'paired' && !process.env.SHANNON_DATABASE_PATH?.trim()) {
  throw new Error('SHANNON_DATABASE_PATH is required for paired authentication commands');
}
const auth = new SQLiteDeviceAuthStore({
  path: configuredDatabasePath(),
  pepper: configuredAuthPepper(),
});

try {
  if (command === 'issue-code') {
    const issued = auth.issuePairingCode(process.argv[3] || process.env.SHANNON_OWNER_SCOPE_KEY || 'owner');
    console.log(`接続コード: ${issued.code}`);
    console.log(`接続リンク: shannon://connect?code=${encodeURIComponent(issued.code)}`);
    console.log(`有効期限: ${issued.expiresAt}`);
    console.log(`所有者scope: ${issued.scopeKey}`);
  } else if (command === 'list') {
    const devices = auth.listDevices();
    if (!devices.length) console.log('接続済み端末はありません。');
    for (const device of devices) {
      console.log([
        device.deviceId,
        device.displayName,
        `scope=${device.scopeKey}`,
        `expires=${device.expiresAt}`,
        `lastUsed=${device.lastUsedAt ?? '-'}`,
        `revoked=${device.revokedAt ?? '-'}`,
      ].join('  '));
    }
  } else if (command === 'revoke' && process.argv[3]) {
    if (!auth.revoke(process.argv[3])) throw new Error('指定された有効な端末が見つかりません。');
    console.log(`失効しました: ${process.argv[3]}`);
  } else {
    throw new Error('Usage: authCli.ts issue-code [scopeKey] | list | revoke <device-id>');
  }
} finally {
  auth.close();
}
