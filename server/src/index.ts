import { boot } from './boot.js';
import { config } from './config.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from './db/seed.js';

const stack = await boot({ scale: process.argv.includes('--scale') });

console.log(`\n  Swadesh CC API  http://localhost:${stack.port}   (WebSocket: ws://localhost:${stack.port}/ws)`);
console.log(`  Telephony is SIMULATED: ${config.simulate ? `yes (SIM_SPEED=${config.simSpeed}x)` : 'no — dialer/inbound simulators are off'}`);
console.log(`\n  Demo logins (password: ${DEMO_PASSWORD})`);
for (const a of DEMO_ACCOUNTS) console.log(`   ${a.tenant.padEnd(26)} ${a.admin}  ${a.supervisor}  ${a.user}`);
console.log('');

const shutdown = async () => {
  console.log('\nshutting down…');
  await stack.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
