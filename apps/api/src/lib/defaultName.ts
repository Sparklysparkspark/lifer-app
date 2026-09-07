// Spelled-out sequential defaults ("Album One", "Trip Two") for when a user creates one of
// these without typing a name — names are NOT NULL/required at the DB layer, so creation always
// needs a real value, not just a UI nicety.
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
  // Nobody's realistically creating hundreds of these by hand without ever naming one — plain
  // digits past this point are more useful than a fully spelled-out "One Hundred Four" anyway.
  return String(n);
}

export function nextDefaultName(prefix: string, existingCount: number): string {
  if (existingCount === 0) return `Untitled ${prefix}`;
  return `Untitled ${prefix} ${numberToWords(existingCount + 1)}`;
}
