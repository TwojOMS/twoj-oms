// Konfiguracja piaskownicy oms-proba (PRZ-072), liczona na laptopie przez proba.ps1 zaloz.
// Pisze do <katalog>: proba.env (ENV_DEMO + losowy OMS_PASS konta serwisowego, które gaśnie po
// pierwszym koncie) i konto.json (login + hash scrypt). Hasło logowania zostaje WYŁĄCZNIE
// w C:/Users/uzytkownik/.oms/proba.json (istniejące jest używane ponownie) — nigdy na ekranie.
// Użycie: node deploy/proba/konfiguracja.mjs <katalog-wyjściowy> [adres-piaskownicy]
// Adres trafia tylko do NOWEGO proba.json (domyślnie localhost); istniejący plik zostaje bez zmian.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';
import { zahaszuj } from '../../src/domena/hasla.js';

const wyjscie = process.argv[2];
if (!wyjscie || !path.isAbsolute(wyjscie)) throw new Error('Użycie: konfiguracja.mjs <katalog-bezwzględny>');
const plikHasla = path.join(os.homedir(), '.oms', 'proba.json');
let dane;
if (fs.existsSync(plikHasla)) dane = JSON.parse(fs.readFileSync(plikHasla, 'utf8'));
else {
  dane = { adres: process.argv[3] || 'http://localhost:3005', login: 'adam', haslo: randomBytes(18).toString('base64url') };
  fs.mkdirSync(path.dirname(plikHasla), { recursive: true });
  fs.writeFileSync(plikHasla, JSON.stringify(dane, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
fs.mkdirSync(wyjscie, { recursive: true });
// Kanały i dane sprzedawcy NIE tutaj — start.mjs bierze je z ENV_DEMO generatora (jedno źródło).
const env = { OMS_TRYB: ENV_DEMO.OMS_TRYB, OMS_USER: 'serwis-proby', OMS_PASS: randomBytes(24).toString('base64url') };
fs.writeFileSync(path.join(wyjscie, 'proba.env'),
  '# Piaskownica oms-proba — bez kluczy integracji (OMS_TRYB=proba odmawia startu z kluczem).\n'
  + '# Kanały, sprzedawca i podłoga raportu: ENV_DEMO w scripts/demo-dane.mjs (start.mjs je nakłada).\n'
  + Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(wyjscie, 'konto.json'),
  JSON.stringify({ login: dane.login, imie: 'Adam (piaskownica)', hash: zahaszuj(dane.haslo) }) + '\n', { mode: 0o600 });
console.log(`konfiguracja gotowa; hasło w ${plikHasla}`);
