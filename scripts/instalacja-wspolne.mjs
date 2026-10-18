import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PRZ-093.03: kontrola wersji Node na samym początku każdego skryptu instalacji. Na Node 20 (apt w Debianie 13
// i Ubuntu 24.04) instalacja kończyła się samym INSTALACJA_DEMO_PROBA_ODMOWA — etap próby nie mógł wczytać
// node:sqlite ani plików .ts. Ten plik importuje wyłącznie moduły obecne w każdym Node z obsługą ESM, a skrypty
// instalacji importują go statycznie PRZED czymkolwiek nowszym (resztę doczytują dynamicznie), więc komunikat
// pada, zanim cokolwiek się wywróci. Liczba = package.json "engines" (pilnuje test).
export const WYMAGANY_NODE = 24;

export function sprawdzWersjeNode(obecna = process.versions.node) {
  const wersja = String(obecna).replace(/^v/, '');
  const glowna = Number.parseInt(wersja.split('.')[0], 10);
  if (Number.isInteger(glowna) && glowna >= WYMAGANY_NODE) return null;
  return `INSTALACJA_NODE_ZA_STARY: Wymagany Node.js ${WYMAGANY_NODE} lub nowszy, masz ${wersja}. `
    + `Zainstaluj Node.js ${WYMAGANY_NODE} LTS z https://nodejs.org/ (pakiet nodejs z apt w Debianie 13 i Ubuntu 24.04 to 20.x — za stary), `
    + 'sprawdź „node --version”, wykonaj ponownie npm ci i powtórz polecenie. '
    + 'Szczegóły: docs/instalacja-klienta.md, sekcja „Próba lokalna”.';
}

function wymagajNode() {
  const komunikat = sprawdzWersjeNode();
  if (!komunikat) return;
  console.error(komunikat);
  process.exit(1);
}
wymagajNode();

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
      throw new Error('INSTALACJA_OPCJE_ODMOWA: Użycie: --katalog ABS --port PORT');
    }
    wynik[klucz] = wartosc;
  }
  // Prefiks INSTALACJA_ przepuszcza powód przez catch każdego instalatora (PRZ-089: przy względnej ścieżce
  // człowiek widział samo INSTALACJA_DEMO_ODMOWA). Treść bez sekretów — tylko to, co człowiek sam wpisał.
  if (!wynik['--katalog'] || !wynik['--port']) throw new Error('INSTALACJA_OPCJE_ODMOWA: Użycie: --katalog ABS --port PORT');
  if (!path.isAbsolute(wynik['--katalog'])) {
    throw new Error(`INSTALACJA_OPCJE_ODMOWA: Katalog musi być ścieżką bezwzględną (podano: ${wynik['--katalog']}, np. ${path.resolve(wynik['--katalog'])})`);
  }
  const port = Number(wynik['--port']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('INSTALACJA_OPCJE_ODMOWA: Port musi być liczbą 1024–65535');
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

// Powód porażki dla człowieka (PRZ-093.03). Sekretów nie wolno przenieść na ekran: linia z sekretem znika
// w całości, a reszta przechodzi przez maskowanie na wypadek sekretu w środku cudzego komunikatu.
const LIMIT_POWODU = 400;
const LINIA_Z_HASLEM = /(haslo|hasło|pass(word)?|secret|token)\s*[=:]/i;

export function oczyscPowod(tekst, sekrety = []) {
  let wynik = String(tekst ?? '');
  for (const sekret of sekrety) if (sekret && sekret.length >= 6) wynik = wynik.split(sekret).join('***');
  return wynik.replace(/\s+/g, ' ').trim().slice(0, LIMIT_POWODU);
}

export function powodPotomka(wynik, { limitMs, sekrety = [] } = {}) {
  if (wynik.error?.code === 'ETIMEDOUT') return `przekroczono ${Math.round(limitMs / 1000)} s — etap przerwany`;
  if (wynik.error) return oczyscPowod(`nie uruchomiono etapu: ${wynik.error.message}`, sekrety);
  const linie = String(wynik.stderr ?? '').split(/\r?\n/).map(linia => linia.trim())
    .filter(linia => linia && !/^at\s/.test(linia) && !/ExperimentalWarning|--trace-warnings/.test(linia))
    .filter(linia => !LINIA_Z_HASLEM.test(linia) && !sekrety.some(sekret => sekret && linia.includes(sekret)));
  const ostatnie = linie.slice(-3).join(' | ');
  if (ostatnie) return oczyscPowod(ostatnie, sekrety);
  return wynik.signal ? `etap przerwany sygnałem ${wynik.signal}` : `kod wyjścia ${wynik.status}, bez komunikatu`;
}

// Hasła, które etapy zapisują w katalogu instalacji — do odfiltrowania z tego, co trafia na ekran.
export function sekretyKatalogu(katalog) {
  const sekrety = [];
  for (const [plik, klucz] of [[PLIKI_INSTALACJI.proba, 'OMS_PASS'], [PLIKI_INSTALACJI.daneAdmina, 'haslo']]) {
    try { const wartosc = odczytajEnv(path.join(katalog, plik))[klucz]; if (wartosc) sekrety.push(wartosc); } catch { /* brak pliku */ }
  }
  return sekrety;
}

// „Co dalej” po sukcesie (PRZ-093.03): ścieżka pliku z hasłem, nigdy samo hasło. Linie idą PRZED wierszem JSON —
// ten zostaje ostatni (instrukcja Dockera: „Kończy się wierszem z "status":…”).
export function coDalejLokalnie({ katalog, port }) {
  const otworz = path.relative(process.cwd(), fileURLToPath(new URL('./instalacja-otworz.mjs', import.meta.url))).split(path.sep).join('/');
  return [
    'Instalacja gotowa. Co dalej:',
    `  1. Uruchom panel:  node ${otworz} --katalog "${katalog}" --port ${port}`,
    `  2. Otwórz w przeglądarce:  http://127.0.0.1:${port}/login`,
    `  3. Login i hasło administratora są w pliku:  ${path.join(katalog, PLIKI_INSTALACJI.daneAdmina)}`,
    '  4. Panel zatrzymasz klawiszami Ctrl+C w oknie z punktu 1.',
  ];
}

export function coDalejKontener({ konfiguracja, port }) {
  return [
    'Instalacja gotowa. Co dalej (w katalogu deploy/klient paczki):',
    '  1. Uruchom panel:  sudo docker compose up -d   (po minucie „sudo docker compose ps” pokaże healthy)',
    `  2. Otwórz w przeglądarce:  http://ADRES-SERWERA:${port}/login   (ADRES-SERWERA poda „hostname -I”)`,
    `  3. Login i hasło administratora:  sudo cat ${path.join(konfiguracja, PLIKI_INSTALACJI.daneAdmina)}`,
    '  4. Zatrzymanie (dane zostają):  sudo docker compose down',
  ];
}
