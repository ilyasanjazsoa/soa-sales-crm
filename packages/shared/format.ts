/* Display helpers shared by screens and server-written text. Money in integer cents. */

export const formatMoney = (cents: number): string => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** $1.25M, $506k, $950 */
export function formatMoneyShort(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`;
  if (dollars >= 1000) return `$${String(Math.round(dollars / 1000))}k`;
  return `$${String(Math.round(dollars))}`;
}

export const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? "" : "s"}`;
