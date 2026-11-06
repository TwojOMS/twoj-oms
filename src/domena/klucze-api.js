import { createHash, randomBytes, randomInt } from 'node:crypto';

export const ZAKRESY_API = Object.freeze([
  'zamowienia:odczyt', 'zamowienia:zapis', 'proformy:zapis', 'produkty:odczyt',
  'produkty:zapis', 'zdjecia:zapis', 'stany:odczyt', 'stany:zapis', 'sprzedaz:odczyt', 'druk',
]);

export function skrotKlucza(klucz) {
  return createHash('sha256').update(klucz).digest('hex');
}

export function nowyKlucz() {
  // Cyfry nie po kolei: dziesięć kolejnych cyfr strażnik danych firmy bierze za NIP.
  const alfabet = 'abcdefghijklmnopqrstuvwxyz1023456789';
  const prefiks = Array.from({ length: 8 }, () => alfabet[randomInt(alfabet.length)]).join('');
  const klucz = `toms_${prefiks}_${randomBytes(32).toString('base64url')}`;
  return { klucz, prefiks, skrot: skrotKlucza(klucz) };
}

export function rozbierzNaglowek(naglowek) {
  if (typeof naglowek !== 'string') return null;
  const dopasowanie = /^Bearer (toms_[a-z0-9]{8}_[A-Za-z0-9_-]{43})$/i.exec(naglowek.trim());
  // Wielkość liter jest dowolna tylko dla schematu, nie dla formatu klucza.
  const klucz = dopasowanie?.[1];
  return klucz && /^toms_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/.test(klucz) ? klucz : null;
}

export function czyZakresyPoprawne(zakresy) {
  return Array.isArray(zakresy) && zakresy.length > 0
    && Array.from(zakresy).every(zakres => ZAKRESY_API.includes(zakres))
    && new Set(zakresy).size === zakresy.length;
}
