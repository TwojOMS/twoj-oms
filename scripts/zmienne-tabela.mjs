// Czytelna tabela z manifestu: node scripts/zmienne-tabela.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZMIENNE_PANEL } from './zmienne-panel.mjs';

const ROOT = new URL('../', import.meta.url);
const porownaj = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const komorka = tekst => String(tekst).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/\r?\n/g, '<br>');
const sekret = z => z.sekret === true || /(?:PASS(?:WORD)?|HASLO|TOKEN|SECRET|KLUCZ)$/.test(z.nazwa)
  || z.nazwa === 'DPD_INFO_CHANNEL';
const sciezkaPanelu = ekran => ekran.startsWith('Analizy i finanse → ') ? ekran : `Ustawienia → ${ekran}`;

function domyslna(wartosc) {
  if (wartosc === null || wartosc === undefined) return 'brak';
  if (wartosc === '') return 'pusty tekst';
  if (Array.isArray(wartosc) && wartosc.some(w => w && Object.hasOwn(w, 'kontekst'))) {
    return wartosc.map(w => `${w.kontekst}: ${domyslna(w.wartosc)}`).join('; ');
  }
  return typeof wartosc === 'object' ? JSON.stringify(wartosc) : String(wartosc);
}

export function generujTabele(manifest) {
  const wiersze = [
    '# Zmienne konfiguracji OMS', '',
    'W instalacji Docker konfiguracja leży w pliku `/opt/oms/config/oms.env` (zobacz [instalację](instalacja-docker.md)).',
    'Część ustawień wprowadzisz w panelu: Ustawienia → Firma (także logo), Ustawienia → Integracje oraz Analizy i finanse → Finanse → Kompletność danych.',
    '**Plik wygrywa** — ustawiona w nim sekcja integracji lub adres firmy blokuje zapis tej części w panelu.',
    'Daty kompletności danych zapisuje tylko administrator, bez restartu; data z pliku blokuje zapis swojego pola. Logo i jego opis administrator zmienia bez restartu, o ile plik nie ustala logo.',
    'Połączenia dodawane w Ustawienia → Integracje → Reklamy są osobne: nie zmieniają plikowych META_TOKEN, META_KONTA i GA4_KLUCZ używanych przez karty kampanii. W panelu wgrywasz też obraz logo, zamiast ustawiać ścieżkę OMS_LOGO_PLIK na serwerze.',
    'Szczegóły walidacji i aktywacji znajdziesz w [manifeście konfiguracji w repozytorium](https://github.com/TwojOMS/twoj-oms/blob/main/docs/konfiguracja.md).', '',
    'Tabela jest generowana z manifestu JSON; nie edytuj jej ręcznie.',
    '„brak” oznacza brak wartości domyślnej (null); pusty tekst jest pokazany osobno.',
    'Nazwy z `<P>` to rodziny zmiennych: prefiks pochodzi z definicji kanału w OMS_KANALY.',
    'Sekcja środowiska narzędzi i testów nie jest listą wymaganych ustawień instalacji.', '',
  ];
  // Kolejność sekcji jak w źródle; nazwy wewnątrz sekcji sortowane niezależnie od systemu.
  const grupy = [...new Set(manifest.zmienne.map(z => z.sekcja))];
  for (const grupa of grupy) {
    wiersze.push(`## ${komorka(grupa)}`, '',
      '| Zmienna | Wymagana? | Domyślnie | Do czego | Co się stanie bez niej | Można w panelu? |',
      '|---|---|---|---|---|---|');
    for (const z of manifest.zmienne.filter(z => z.sekcja === grupa).sort((a, b) => porownaj(a.nazwa, b.nazwa))) {
      // „Wymagana?” i „Domyślnie” = wersja po ludzku, jeśli jest; wymagalnosc i domyslna zostają techniczną dokumentacją.
      const pola = [z.wymagalnoscPoLudzku || z.wymagalnosc,
        sekret(z) ? 'sekret — nie wklejaj do czatu ani do repo' : z.domyslnaPoLudzku || domyslna(z.domyslna),
        // „Do czego” = opis po ludzku; „Moduł:” to awaryjny zapas, który test w tests/instalacja wyłapuje.
        // „Co się stanie” = wersja po ludzku, jeśli jest; skutekBraku zostaje techniczną dokumentacją manifestu.
        z.opis || `Moduł: ${z.wlasciciel}`, z.skutekBrakuPoLudzku || z.skutekBraku,
        ZMIENNE_PANEL[z.nazwa] ? `Tak — ${sciezkaPanelu(ZMIENNE_PANEL[z.nazwa])}` : 'Nie'];
      wiersze.push(`| <code>${komorka(z.nazwa)}</code> | ${pola.map(komorka).join(' | ')} |`);
    }
    wiersze.push('');
  }
  return wiersze.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(new URL('docs/konfiguracja.json', ROOT), 'utf8'));
  fs.writeFileSync(new URL('docs/zmienne.md', ROOT), generujTabele(manifest));
  console.log(`Zapisano docs/zmienne.md: ${manifest.zmienne.length} zmiennych, ${new Set(manifest.zmienne.map(z => z.sekcja)).size} grup; bez opisu: ${manifest.zmienne.filter(z => !z.opis).length}.`);
}
