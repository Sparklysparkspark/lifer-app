// Spelled-out sequential defaults ("Album One", "Trip Two") for when a user doesn't type a name.
// Names are required at the DB layer, so creation always needs a real value.
const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function numberToWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10].toLowerCase() : "");
  // Past this point plain digits read better than a spelled-out "One Hundred Four".
  return String(n);
}

export function nextDefaultName(prefix: string, existingCount: number): string {
  if (existingCount === 0) return `Untitled ${prefix}`;
  return `Untitled ${prefix} ${numberToWords(existingCount + 1)}`;
}
