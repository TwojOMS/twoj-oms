import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PLIKI_INSTALACJI = Object.freeze({
  znacznik: '.oms-instalacja-proba.json',
  proba: 'proba.env',
  produkcja: 'produkcja.env.example',
  baza: 'oms.sqlite',
  kopia: 'backup-proba.sqlite',
  daneAdmina: 'administrator-proby.env',
  odtworzenie: 'odtworzenie',
});

export function opcje(argv) {
  const wynik = {};
  for (let i = 0; i < argv.length; i += 2) {
    const klucz = argv[i];
    const wartosc = argv[i + 1];
    if (!['--katalog', '--port'].includes(klucz) || !wartosc || Object.hasOwn(wynik, klucz)) {
      throw new Error('Użycie: --katalog ABS --port PORT');
    }
    wynik[klucz] = wartosc;
  }
  if (!path.isAbsolute(wynik['--katalog'] ?? '')) throw new Error('Katalog musi być ścieżką bezwzględną');
  const port = Number(wynik['--port']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port musi być liczbą 1024–65535');
  return { katalog: path.resolve(wynik['--katalog']), port };
}

export function hasloLosowe() {
  return randomBytes(24).toString('base64url');
}

export function odczytajEnv(plik) {
  const wynik = {};
  for (const linia of fs.readFileSync(plik, 'utf8').split(/\r?\n/)) {
    if (!linia || linia.startsWith('#')) continue;
    const granica = linia.indexOf('=');
    if (granica < 1) throw new Error('Niepoprawny plik próby');
    wynik[linia.slice(0, granica)] = linia.slice(granica + 1);
  }
  return wynik;
}

export function istnieje(plik) {
  return fs.existsSync(plik);
}
