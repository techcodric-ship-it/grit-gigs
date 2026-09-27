export const WITHDRAW_FEE_PCT = Number(process.env.WITHDRAW_FEE_PCT || 5);

export function calcWithdrawFee(amount: number): { feePct: number; commission: number; netAmount: number } {
  const commission = Math.round((amount * WITHDRAW_FEE_PCT) / 100);
  return { feePct: WITHDRAW_FEE_PCT, commission, netAmount: Math.round(amount) - commission };
}
