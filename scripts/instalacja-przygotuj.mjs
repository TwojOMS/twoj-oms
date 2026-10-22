#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { PLIKI_INSTALACJI, hasloLosowe, opcje } from './instalacja-wspolne.mjs';

const SZABLON_PRODUKCJI = `# Szablon przyszłego wdrożenia; paczka próbna nie uruchamia produkcji.\n# Wpisz ścieżki bezwzględne do osobnego, pustego katalogu danych produkcyjnych.\n# Nie używaj katalogu programu ani bazy/plików próby.\nOMS_TRYB=produkcja\nOMS_DB_PATH=\nOMS_PORT=3001\n# NIP (10 cyfr) i BDO (9 cyfr, jeśli firma ma). Opcjonalnie: zostaw puste i wpisz w panelu (Ustawienia → Firma,\n# tylko administrator). Wpisane tutaj wygrywają nad panelem.\nOMS_SPRZEDAWCA_NIP=\nOMS_SPRZEDAWCA_BDO=\n# Rachunek firmy (26 cyfr). Opcjonalnie: zostaw pusty i wpisz rachunek w panelu (Ustawienia → Firma,\n# tylko administrator). Wpisany tutaj wygrywa nad panelem.\nOMS_RACHUNEK=\n# Adres firmy (sprzedawca na proformie, nadawca paczek; kod w postaci 00-000). Opcjonalnie: zostaw puste\n# i wpisz adres w panelu (Ustawienia → Firma). Wpisany tutaj wygrywa nad panelem.\nDPD_NADAWCA_NAZWA=\nDPD_NADAWCA_ULICA=\nDPD_NADAWCA_KOD=\nDPD_NADAWCA_MIASTO=\nOMS_PROFORMY_KATALOG=\nOMS_ETYKIETY_KATALOG=\nOMS_USER=\nOMS_PASS=\nOMS_KANALY=[]\nOMS_RAPORTY_NAZWY_KANALOW={}\n# Integracje dopisuj pojedynczo po odbiorze; nie kopiuj wartości z próby.\n`;

function envProby(katalog, port, haslo) {
  return [
    'OMS_TRYB=proba', `OMS_DB_PATH=${path.join(katalog, PLIKI_INSTALACJI.baza)}`,
    `OMS_PORT=${port}`, 'OMS_SPRZEDAWCA_NIP=1234563218',
    'OMS_RACHUNEK=34109010140000000000000000',
    `OMS_PROFORMY_KATALOG=${path.join(katalog, 'proformy')}`,
    `OMS_ETYKIETY_KATALOG=${path.join(katalog, 'etykiety')}`,
    'OMS_USER=serwis-proby', `OMS_PASS=${haslo}`, 'OMS_KANALY=[]', 'OMS_RAPORTY_NAZWY_KANALOW={}',
  ].join('\n') + '\n';
}

function main() {
  const { katalog, port } = opcje(process.argv.slice(2));
  if (fs.existsSync(katalog) && fs.readdirSync(katalog).length) throw new Error('INSTALACJA_ODMOWA_NADPISANIA');
  fs.mkdirSync(katalog, { recursive: true });
  // Druga kontrola chroni wyścig między sprawdzeniem a utworzeniem katalogu.
  if (fs.readdirSync(katalog).length) throw new Error('INSTALACJA_ODMOWA_NADPISANIA');
  fs.mkdirSync(path.join(katalog, 'proformy'));
  fs.mkdirSync(path.join(katalog, 'etykiety'));
  fs.writeFileSync(path.join(katalog, PLIKI_INSTALACJI.proba), envProby(katalog, port, hasloLosowe()), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(katalog, PLIKI_INSTALACJI.produkcja), SZABLON_PRODUKCJI, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(katalog, PLIKI_INSTALACJI.znacznik), JSON.stringify({ wersja: 1, port }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'przygotowano', katalog, port }));
}

try { main(); } catch (e) { console.error(e instanceof Error && /^INSTALACJA_/.test(e.message) ? e.message : 'INSTALACJA_PRZYGOTOWANIE_ODMOWA'); process.exitCode = 1; }
