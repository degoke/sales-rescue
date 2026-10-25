export const naira = (kobo: bigint | number) => `₦${(Number(kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

export const nairaToKobo = (amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive');
  return BigInt(Math.round(amount * 100));
};
