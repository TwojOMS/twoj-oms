// PRZ-123 C06 — strazniki adresow MF w testach.
// 1. tests/pomoc/bez-ksef-mf.ts (setupFiles w vitest.config.ts): kazde zadanie na *.mf.gov.pl z testu
//    (fetch, net.connect, tls.connect, https) konczy sie wyjatkiem „ZABRONIONE: KSeF w teście”.
// 2. Skan tests/ i deploy/proba/: zaden plik nie zawiera adresu MF (poza xmlns UPO i jawnymi wyjatkami).
//
// ⚠️ Sprawdzenia strażnika nie dotykaja sieci nawet wtedy, gdy strażnika nie ma (czerwony przebieg, mutacja):
// fetch dostaje juz przerwany sygnal, a gniazda — `lookup`, ktory zawsze konczy sie bledem (bez DNS).
// Adresy MF skladamy tu z czesci, zeby ten plik sam nie wpadal w skan.
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { szewTwojeFaktury } from '../../src/moduly/faktury/wczytaj-szew.ts';

const KORZEN = fileURLToPath(new URL('../..', import.meta.url));
const MF = ['mf', 'gov', 'pl'].join('.');
const HOST_MF = `api.ksef.${MF}`;
const ZABRONIONE = /ZABRONIONE: KSeF w teście/;

const bezDns = (_host, _opcje, cb) => { process.nextTick(() => cb(new Error('BEZ DNS (test strażnika)'))); };

/** Pierwszy blad z proby polaczenia — synchroniczny wyjatek albo zdarzenie 'error'. */
function bladPolaczenia(otworz) {
  return new Promise((resolve) => {
    const limit = setTimeout(() => resolve(new Error('BRAK BLEDU w 5 s')), 5000);
    const koniec = (e) => { clearTimeout(limit); resolve(e); };
    try {
      const gniazdo = otworz();
      gniazdo.on('error', koniec);
      gniazdo.on('connect', () => { gniazdo.destroy(); koniec(new Error('POLACZONO')); });
      gniazdo.on('secureConnect', () => { gniazdo.destroy(); koniec(new Error('POLACZONO')); });
    } catch (e) {
      koniec(e);
    }
  });
}

async function bladFetch(cel) {
  try {
    await fetch(cel, { signal: AbortSignal.abort() });
    return new Error('BRAK BLEDU');
  } catch (e) {
    return e;
  }
}

describe('PRZ-123 C06: strażnik bez-ksef-mf (setupFiles)', () => {
  it.each([
    ['napis', `https://${HOST_MF}/v2/sessions/online`],
    ['URL', new URL(`https://ksef-test.${MF}/api/v2`)],
    ['Request', new Request(`https://${MF}/`)],
    ['wielkie litery', `https://API.KSEF.${MF.toUpperCase()}/v2`],
  ])('fetch na adres MF (%s) → wyjatek strażnika', async (_opis, cel) => {
    expect(String((await bladFetch(cel))?.message)).toMatch(ZABRONIONE);
  });

  it('fetch na inny adres przechodzi przez strażnika (tu: przerwany sygnal, nie strażnik)', async () => {
    for (const cel of ['https://ksef.atrapa.invalid/v2', `https://nie${MF}.invalid/`, `https://${MF}.atrapa.invalid/`]) {
      const e = await bladFetch(cel);
      expect(String(e?.message), cel).not.toMatch(ZABRONIONE);
      expect(e?.name, cel).toBe('AbortError');
    }
  });

  it('net.connect na adres MF → wyjatek strażnika', async () => {
    const e = await bladPolaczenia(() => net.connect({ host: HOST_MF, port: 443, lookup: bezDns }));
    expect(String(e?.message)).toMatch(ZABRONIONE);
  });

  it('net.createConnection na adres MF → wyjatek strażnika', async () => {
    const e = await bladPolaczenia(() => net.createConnection({ host: `ksef-test.${MF}`, port: 443, lookup: bezDns }));
    expect(String(e?.message)).toMatch(ZABRONIONE);
  });

  it('tls.connect na adres MF → wyjatek strażnika', async () => {
    const e = await bladPolaczenia(() => tls.connect({ host: HOST_MF, port: 443, servername: HOST_MF, lookup: bezDns }));
    expect(String(e?.message)).toMatch(ZABRONIONE);
  });

  it('https.get na adres MF → wyjatek strażnika', async () => {
    const e = await bladPolaczenia(() => https.get({ hostname: HOST_MF, path: '/v2', lookup: bezDns, agent: false }));
    expect(String(e?.message)).toMatch(ZABRONIONE);
  });

  it('net.connect na inny adres nie jest blokowany (dochodzi do lookup)', async () => {
    const e = await bladPolaczenia(() => net.connect({ host: 'ksef.atrapa.invalid', port: 443, lookup: bezDns }));
    expect(String(e?.message)).toMatch(/BEZ DNS/);
  });
});

// ── Skan plikow ─────────────────────────────────────────────────────────────────────────────────────────
// Decyzja kierownika (PRZ-123 C06, po recenzji): w tests/ i deploy/proba/ KAZDY adres *.mf.gov.pl to
// naruszenie, nie tylko taki obok wywolania. setupFiles nie chroni procesow potomnych (spawn, fork, Worker),
// a adres w stalej, w `env` albo w `baseUrl` moze tam trafic. Dozwolone sa wylacznie: atrybut xmlns
// przestrzeni nazw UPO (wycinany tylko w tej postaci) i pliki z listy WYJATKI, kazdy z powodem.

const ESC_MF = MF.replace(/\./g, '\\.');
const ADRES_MF = new RegExp(`(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*${ESC_MF}(?![a-z0-9-]|\\.[a-z0-9])`, 'i');
const XMLNS_UPO = new RegExp(`\\bxmlns(?::[\\w.-]+)?=(["'])http://upo\\.schematy\\.${ESC_MF}/[^"'\\s]*\\1`, 'g');
const WYWOLANIE = /(?:\b(?:fetch|fetchImpl|transport|request|get|post|connect|createConnection|axios|got|undici|spawn|exec|execFile|fork)\s*\(|\b(?:curl|wget)\s)/;
const WYJATKI = {
  'tests/pomoc/bez-ksef-mf.ts': 'strażnik rozpoznaje host MF, żeby zablokować połączenie',
  'tests/pomoc/bootstrap-synchroniczny.ts': 'domyślne KSEF_API, na którym polega tests/oms/bootstrap.test.js („klient KSeF powstaje RAZ…”)',
  'tests/oms/bootstrap.test.js': 'sprawdza domyślny adres KSeF przekazany fabryce klienta, która jest szpiegiem',
  'tests/oms/lacznosc.test.js': 'sprawdza wyliczenie hosta KSeF do Diagnostyki z konfiguracji, bez połączenia',
  'tests/moduly/ustawienia/lacznosc-produkcja.test.ts': 'sprawdza domyślne adresy API produkcji; test sam szpieguje gniazda, fetch i DNS',
  'tests/moduly/koszty/ksef-ustawienia-prz102.test.js': 'sprawdza, że ekran NIE pokazuje adresu MF',
  'tests/moduly/koszty/konfiguracja.test.ts': 'sprawdza odczyt KSEF_API z env (ucinanie ukośników), bez połączenia',
  'tests/core/url-puste-po-zgodzie.test.ts': 'sprawdza domyślne prefiksy adresów zebrane przez szpiega transportu',
  'deploy/proba/atrapy/lacznosc.mjs': 'adres tylko wyświetlany na ekranie Diagnostyki atrapy, bez połączenia',
  // Te testy wycina lista TF; w pełnym drzewie nadal wymagamy każdego wyjątku i jego uzasadnienia.
  ...(szewTwojeFaktury ? {
  'tests/moduly/faktury/ksef-sprzedazy-prz123.test.ts': 'C04b: sprawdza, że adresMf rozpoznaje MF i że próba odmawia atrapie pod adresem MF, bez wołania fabryki',
  'tests/domena/twojefaktury/kod-qr-prz122.test.js': 'B09: rozpoznanie środowiska z adresu KSEF_API i przykład adresu KOD I MF — same napisy, bez połączenia',
  'tests/moduly/faktury/faktura-pdf-qr-prz122.test.js': 'B09: adres KOD I odczytany z kodu QR na PDF — porównanie napisu, bez połączenia',
  } : {}),
};

/** Naruszenia w jednym pliku: `{ plik, linia, tekst }` — kazda linia z adresem MF poza atrybutem xmlns UPO. */
function naruszenia(plik, tresc) {
  const wynik = [];
  tresc.split(/\r?\n/).forEach((surowa, i) => {
    const linia = surowa.replace(XMLNS_UPO, '');
    if (ADRES_MF.test(linia)) wynik.push({ plik, linia: i + 1, tekst: surowa.trim() });
  });
  return wynik;
}

function pliki(katalog) {
  const wynik = [];
  for (const wpis of readdirSync(katalog, { withFileTypes: true })) {
    if (wpis.name === 'node_modules' || wpis.name === '.git') continue;
    const sciezka = join(katalog, wpis.name);
    if (wpis.isDirectory()) wynik.push(...pliki(sciezka));
    else if (wpis.isFile()) wynik.push(sciezka);
  }
  return wynik;
}

const wzgledna = (p) => relative(KORZEN, p).split(sep).join('/');
/** Tresc pliku tekstowego albo null dla binarnego (bajt 0). */
function tekst(p) {
  const bajty = readFileSync(p);
  return bajty.includes(0) ? null : bajty.toString('utf8');
}

describe('PRZ-123 C06: skan tests/ i deploy/proba/ — zadnych adresow MF', () => {
  it('przyneta: stala z adresem MF i pozniejszy fetch(stala) → naruszenie', () => {
    const przyneta = [
      `const API = 'https://api-test.ksef.${MF}';`,
      'export async function pobierz() {',
      '  return fetch(`${API}/v2/sessions`);',
      '}',
    ].join('\n');
    expect(naruszenia('przyneta.js', przyneta)).toMatchObject([{ plik: 'przyneta.js', linia: 1 }]);
  });

  it('kontrola ujemna: adres MF w kazdej postaci jest wykrywany', () => {
    for (const tresc of [
      `await fetch('https://${HOST_MF}/v2/sessions')`,
      `const r = await fetch(\n  'https://ksef-test.${MF}/api/v2',\n  {})`,
      `const klient = createKsefWysylka({ baseUrl: 'https://${HOST_MF}/v2' });`,
      `spawn('node', ['skrypt.mjs'], { env: { KSEF_API: 'https://${HOST_MF}/v2' } });`,
      `URL=https://${HOST_MF}/v2\ncurl -s "$URL"`,
      `await fetch('https://upo.schematy.${MF}/x')`,
      `<Potwierdzenie xmlns="http://upo.schematy.${MF}/KSeF/v4-3"><a href="https://${HOST_MF}/"/>`,
      `const ns = 'http://upo.schematy.${MF}/KSeF/v4-3';`,
    ]) {
      expect(naruszenia('a.js', tresc).length, tresc).toBeGreaterThan(0);
    }
  });

  it('kontrola dodatnia: atrybut xmlns UPO i adres atrapy przechodza', () => {
    expect(naruszenia('a.xml', `<Potwierdzenie xmlns="http://upo.schematy.${MF}/KSeF/v4-3">`)).toEqual([]);
    expect(naruszenia('a.xml', `<upo:P xmlns:upo='http://upo.schematy.${MF}/KSeF/v4-3'/>`)).toEqual([]);
    expect(naruszenia('a.js', "await fetch('https://ksef.atrapa.invalid/v2')")).toEqual([]);
    expect(naruszenia('a.js', `const x = 'https://${MF}.atrapa.invalid/';`)).toEqual([]);
  });

  it('tests/ i deploy/proba/ nie zawieraja adresow MF (poza wyjatkami z powodem)', () => {
    const lista = [...pliki(join(KORZEN, 'tests')), ...pliki(join(KORZEN, 'deploy', 'proba'))]
      .filter((p) => !(wzgledna(p) in WYJATKI))
      .flatMap((p) => {
        const t = tekst(p);
        return t === null ? [] : naruszenia(wzgledna(p), t);
      });
    expect(lista).toEqual([]);
  });

  it('lista wyjatkow jest aktualna, a w wyjatkach adres MF nie stoi obok wywolania', () => {
    for (const [plik, powod] of Object.entries(WYJATKI)) {
      expect(powod.length, plik).toBeGreaterThan(10);
      const znalezione = naruszenia(plik, readFileSync(join(KORZEN, plik), 'utf8'));
      // Plik bez adresu MF nie potrzebuje wyjatku — wtedy usun go z listy.
      expect(znalezione.length, `${plik}: brak adresu MF, usuń z WYJATKI`).toBeGreaterThan(0);
      expect(znalezione.filter((n) => WYWOLANIE.test(n.tekst)), plik).toEqual([]);
    }
  });
});
