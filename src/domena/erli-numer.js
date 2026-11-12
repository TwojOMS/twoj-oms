export const KONFLIKT_NUMERU_ERLI = 'ERLI ma już inny numer przesyłki — sprawdź w panelu ERLI';

export function numerWErli(z) {
  try { return String(JSON.parse(z.surowe_json ?? '{}')?.deliveryTracking?.trackingNumber ?? '').trim(); }
  catch { return ''; }
}

export function konfliktNumeruErli(z) {
  const numer = numerWErli(z);
  const przesylki = Array.isArray(z?.przesylki) ? z.przesylki : [];
  const nadane = przesylki.filter(p => p?.status === 'nadana' && p.numer_listu);
  return !!numer && nadane.length > 0 && !nadane.some(p => p.numer_listu === numer);
}
