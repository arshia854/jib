export function isValidIranianPhone(phone: string): boolean {
  return /^09\d{9}$/.test(phone);
}

export function normalizePhone(phone: string): string {
  return phone.trim().replace(/[\s-]/g, "");
}
