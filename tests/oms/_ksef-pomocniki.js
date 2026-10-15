import { readFileSync } from 'node:fs';

// Node nie ma API do WYSTAWIANIA certyfikatow, wiec w repo lezy gotowy, staly certyfikat
// testowy (`_ksef-cert.txt`, wygenerowany raz openssl-em). ⚠️ Klucza prywatnego do niego
// NIE MA i miec nie bedzie — ten plik sluzy WYLACZNIE sprawdzeniu, ze klient parsuje
// certyfikat i wyciaga z niego klucz publiczny. Odszyfrowania ladunku ten test nie robi
// i robic nie moze; sprawdza je test Zadania 1 na wlasnej parze kluczy.
let cache = null;
export function certyfikatTestowy() {
  if (!cache) cache = readFileSync(new URL('./_ksef-cert.txt', import.meta.url), 'utf8').trim();
  return cache;
}
