import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Kontrola wersji Node na samym początku każdego skryptu instalacji. Na Node 20 (apt w Debianie 13
// i Ubuntu 24.04) instalacja kończyła się samym INSTALACJA_DEMO_PROBA_ODMOWA — etap próby nie mógł wczytać
// node:sqlite ani plików .ts. Ten plik importuje wyłącznie moduły obecne w każdym Node z obsługą ESM, a skrypty
// instalacji importują go statycznie PRZED czymkolwiek nowszym (resztę doczytują dynamicznie), więc komunikat
// pada, zanim cokolwiek się wywróci. Liczba = package.json "engines" (pilnuje test).
export const WYMAGANY_NODE = 24;

export function sprawdzWersjeNode(obecna = process.versions.node) {
  const wersja = String(obecna).replace(/^v/, '');
  const glowna = Number.parseInt(wersja.split('.')[0], 10);
  if (Number.isInteger(glowna) && glowna >= WYMAGANY_NODE) return null;
  return (
    `INSTALACJA_NODE_ZA_STARY: Wymagany Node.js ${WYMAGANY_NODE} lub nowszy, masz ${wersja}. ` +
    `Zainstaluj Node.js ${WYMAGANY_NODE} LTS z https://nodejs.org/ (pakiet nodejs z apt w Debianie 13 i Ubuntu 24.04 to 20.x — za stary), ` +
    'sprawdź „node --version”, wykonaj ponownie npm ci i powtórz polecenie. ' +
    'Szczegóły: docs/instalacja-klienta.md, sekcja „Próba lokalna”.'
  );
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
  klucz: 'klucz.env',
});

// Klucz poświadczeń integracji (zmienna OMS_KLUCZ_SEKRETOW) żyje w osobnym pliku klucz.env — nigdy
// w proba.env/oms.env. Ścieżkę pliku podaje OMS_KLUCZ_SEKRETOW_PLIK (Docker: /opt/oms/config/klucz.env, poza
// katalogiem danych), a bez niej plik leży w katalogu instalacji obok bazy (próba na własnym komputerze).
// Instalator przekazuje etapom potomnym wyłącznie tę jedną zmienną; każdy etap czyta klucz z pliku.
export const ZMIENNA_PLIKU_KLUCZA = 'OMS_KLUCZ_SEKRETOW_PLIK';
const ZMIENNA_KLUCZA = 'OMS_KLUCZ_SEKRETOW';

export function sciezkaKlucza(katalog, env = process.env) {
  const wskazany = env[ZMIENNA_PLIKU_KLUCZA];
  return wskazany ? path.resolve(wskazany) : path.join(katalog, PLIKI_INSTALACJI.klucz);
}

function bladDostepu(plik, e) {
  return new Error(
    `INSTALACJA_KLUCZ_ODMOWA: brak dostępu do pliku klucza ${plik} (${e.code}). ` +
      'W Dockerze właścicielem musi być UID 10001: sudo chown 10001:10001 PLIK; sudo chmod 600 PLIK.',
  );
}

/** Klucz z pliku klucz.env: { tekst, id }. Brak pliku = INSTALACJA_BRAK_KLUCZA; pusty, ucięty, zły = odmowa. */
export async function kluczZPlikuInstalacji(plik) {
  // Dynamicznie, PO kontroli wersji Node (sekrety.mjs importuje node:sqlite i pliki .ts).
  const { kluczZPliku } = await import('./sekrety.mjs');
  const { idKlucza } = await import('../src/core/bezpieczenstwo/sejf-sekretow.js');
  let bajty;
  try {
    bajty = kluczZPliku(plik);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error(
        `INSTALACJA_BRAK_KLUCZA: brak pliku klucza poświadczeń ${plik}. Powstaje przy przygotowaniu instalacji; ` +
          'gdy masz klucz w menedżerze haseł, wpisz go do tego pliku (linia OMS_KLUCZ_SEKRETOW=…).',
      );
    }
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw bladDostepu(plik, e);
    throw e;
  }
  if (!bajty) {
    throw new Error(
      `INSTALACJA_KLUCZ_ODMOWA: plik klucza ${plik} nie ma poprawnej linii OMS_KLUCZ_SEKRETOW= (pusty, ucięty albo zły). ` +
        'Nie nadpisuję go: wstaw klucz z menedżera haseł. Szczegóły: docs/instalacja-docker.md, rozdział „Klucz poświadczeń”.',
    );
  }
  return { tekst: bajty.toString('base64url'), id: idKlucza(bajty) };
}

/** `sekrety klucz-zapewnij`: istniejący plik — walidacja bez zmian; brak — nowy klucz (odmowa przy szyfrogramach w bazie). */
export async function zapewnijKlucz(plik, baza) {
  const { uruchom } = await import('./sekrety.mjs');
  const linie = [];
  let kod;
  try {
    kod = uruchom(['klucz-zapewnij', '--plik', plik, ...(baza ? ['--baza', baza] : [])], {}, (linia) =>
      linie.push(String(linia)),
    );
  } catch (e) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') throw bladDostepu(plik, e);
    throw e;
  }
  if (kod !== 0) throw new Error(`INSTALACJA_KLUCZ_ODMOWA: ${linie.join(' ').replace(/^ODMOWA: /, '')}`);
  return kluczZPlikuInstalacji(plik);
}

/** Środowisko etapu: proba.env + klucz z pliku klucza. Klucz z env procesu wywołującego się nie liczy. */
export async function envEtapu(katalog) {
  const env = odczytajEnv(path.join(katalog, PLIKI_INSTALACJI.proba));
  const { tekst } = await kluczZPlikuInstalacji(sciezkaKlucza(katalog));
  return { ...env, [ZMIENNA_KLUCZA]: tekst };
}

/**
 * Kontrola pustego katalogu PRZED utworzeniem klucza. „Pusty” = nie istnieje, nie ma wpisów albo ma WYŁĄCZNIE
 * prawidłowy plik klucza tej instalacji (ślad przerwanego przygotowania) — jedyny wyjątek. Zły plik klucza =
 * odmowa z powodem; plik klucza obok czegokolwiek innego = odmowa nadpisania.
 */
export async function wymagajPustegoKatalogu(katalog, plikKlucza = sciezkaKlucza(katalog)) {
  if (!fs.existsSync(katalog)) return;
  const wpisy = fs.readdirSync(katalog);
  if (!wpisy.length) return;
  const jedyny = wpisy.length === 1 ? path.join(katalog, wpisy[0]) : null;
  if (jedyny && path.resolve(jedyny) === path.resolve(plikKlucza)) {
    const stat = fs.lstatSync(jedyny);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      await kluczZPlikuInstalacji(jedyny);
      return;
    }
  }
  throw new Error('INSTALACJA_ODMOWA_NADPISANIA');
}

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
  // Prefiks INSTALACJA_ przepuszcza powód przez catch każdego instalatora (przy względnej ścieżce
  // człowiek widział samo INSTALACJA_DEMO_ODMOWA). Treść bez sekretów — tylko to, co człowiek sam wpisał.
  if (!wynik['--katalog'] || !wynik['--port'])
    throw new Error('INSTALACJA_OPCJE_ODMOWA: Użycie: --katalog ABS --port PORT');
  if (!path.isAbsolute(wynik['--katalog'])) {
    throw new Error(
      `INSTALACJA_OPCJE_ODMOWA: Katalog musi być ścieżką bezwzględną (podano: ${wynik['--katalog']}, np. ${path.resolve(wynik['--katalog'])})`,
    );
  }
  const port = Number(wynik['--port']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('INSTALACJA_OPCJE_ODMOWA: Port musi być liczbą 1024–65535');
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

// Powód porażki dla człowieka. Sekretów nie wolno przenieść na ekran: linia z sekretem znika
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
  const linie = String(wynik.stderr ?? '')
    .split(/\r?\n/)
    .map((linia) => linia.trim())
    .filter((linia) => linia && !/^at\s/.test(linia) && !/ExperimentalWarning|--trace-warnings/.test(linia))
    .filter((linia) => !LINIA_Z_HASLEM.test(linia) && !sekrety.some((sekret) => sekret && linia.includes(sekret)));
  const ostatnie = linie.slice(-3).join(' | ');
  if (ostatnie) return oczyscPowod(ostatnie, sekrety);
  return wynik.signal ? `etap przerwany sygnałem ${wynik.signal}` : `kod wyjścia ${wynik.status}, bez komunikatu`;
}

// Hasła, które etapy zapisują w katalogu instalacji, i klucz poświadczeń — do odfiltrowania z tego,
// co trafia na ekran. Klucz czytany bez walidacji: wycinamy każdą wartość, jaka stoi w pliku.
export function sekretyKatalogu(katalog, plikKlucza = sciezkaKlucza(katalog)) {
  const sekrety = [];
  for (const [plik, klucz] of [
    [path.join(katalog, PLIKI_INSTALACJI.proba), 'OMS_PASS'],
    [path.join(katalog, PLIKI_INSTALACJI.daneAdmina), 'haslo'],
    [plikKlucza, ZMIENNA_KLUCZA],
  ]) {
    try {
      const wartosc = odczytajEnv(plik)[klucz]?.trim();
      if (wartosc) sekrety.push(wartosc);
    } catch {
      /* brak pliku albo nieczytelny */
    }
  }
  return sekrety;
}

// „Co dalej” po sukcesie: ścieżka pliku z hasłem, nigdy samo hasło. Linie idą PRZED wierszem JSON —
// ten zostaje ostatni (instrukcja Dockera: „Kończy się wierszem z "status":…”).
export const ZAPISZ_KLUCZ =
  'Zapisz zawartość tego pliku w menedżerze haseł. Bez niego kopia bazy nie odda podłączonych integracji.';

export function coDalejLokalnie({ katalog, port, klucz = sciezkaKlucza(katalog) }) {
  const otworz = path
    .relative(process.cwd(), fileURLToPath(new URL('./instalacja-otworz.mjs', import.meta.url)))
    .split(path.sep)
    .join('/');
  return [
    'Instalacja gotowa. Co dalej:',
    `  1. Uruchom panel:  node ${otworz} --katalog "${katalog}" --port ${port}`,
    `  2. Otwórz w przeglądarce:  http://127.0.0.1:${port}/login`,
    `  3. Login i hasło administratora są w pliku:  ${path.join(katalog, PLIKI_INSTALACJI.daneAdmina)}`,
    '  4. Panel zatrzymasz klawiszami Ctrl+C w oknie z punktu 1.',
    `  5. Klucz poświadczeń integracji:  ${klucz}`,
    `     ${ZAPISZ_KLUCZ}`,
  ];
}

export function coDalejKontener({
  konfiguracja,
  port,
  klucz = path.join(konfiguracja, PLIKI_INSTALACJI.klucz),
  idKlucza = null,
}) {
  return [
    'Instalacja gotowa. Co dalej (w katalogu deploy/klient paczki):',
    '  1. Uruchom panel:  sudo docker compose up -d   (po minucie „sudo docker compose ps” pokaże healthy)',
    `  2. Otwórz w przeglądarce:  http://ADRES-SERWERA:${port}/login   (ADRES-SERWERA poda „hostname -I”)`,
    `  3. Login i hasło administratora:  sudo cat ${path.join(konfiguracja, PLIKI_INSTALACJI.daneAdmina)}`,
    '  4. Zatrzymanie (dane zostają):  sudo docker compose down',
    `  5. Klucz poświadczeń integracji${idKlucza ? ` (id ${idKlucza})` : ''}:  sudo cat ${klucz}`,
    `     ${ZAPISZ_KLUCZ}`,
  ];
}

// Odstęp między zamówieniami demo (domyślnie godzina). Granica raportu przy starcie to „wczoraj” w UTC, a raport
// liczy dzień zamówienia po Warszawie — trzy zamówienia muszą zmieścić się w dzisiejszym dniu Warszawy, inaczej
// demo zainstalowane po północy kończy RAPORTY odmową „granica założona za wcześnie”.
const dzienWarszawy = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(ms);
export function krokDemoMs(teraz) {
  const dzis = dzienWarszawy(teraz);
  let krok = 3600_000;
  while (krok > 1 && dzienWarszawy(teraz - 3 * krok) !== dzis) krok = Math.floor(krok / 2);
  return dzienWarszawy(teraz - 3 * krok) === dzis ? krok : 0;
}
