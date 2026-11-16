import type { ExecutionServices } from './services.js';
export async function acknowledgeVerification(services: ExecutionServices) {
  const receipt = services.context.verificationReceipt;
  if (!receipt) return;
  const result = await services.command('verification', {
    action: 'receipt',
    body: receipt,
  });
  if (result.challengeId !== receipt.challengeId || result.state !== 'applied')
    throw new Error('客户验证接收回执尚未确认');
  if (services.context.challenge) services.context.challenge.completed = true;
  delete services.context.verificationReceipt;
  await services.checkpoint('verification_acknowledged');
}
