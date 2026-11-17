// Sejf poświadczeń zapisanych w bazie: szyfrowanie AES-256-GCM kluczem z `OMS_KLUCZ_SEKRETOW`.
//
// Zapis: `oms1.<id klucza>.<nonce>.<dane>` — nonce 12 losowych bajtów na każdy zapis, dane = szyfrogram
// + znacznik uwierzytelniający 16 bajtów, wszystko base64url. Szyfrogram jest przypięty do miejsca
// (AAD = [tabela, kolumna, id wiersza]), więc wartość przeniesiona do innego wiersza się nie odszyfruje.
// Id wiersza to klucz główny — przeżywa kopię, odtworzenie i reset; nigdy nazwa hosta ani ścieżka bazy.
//
// ⚠️ WARTOŚĆ KLUCZA NIGDY NIE WYCHODZI: ani do logu, ani do komunikatu błędu, ani na ekran. Id klucza
// (8 znaków ze skrótu) wolno pokazać — to etykieta dla człowieka; zgodność klucza rozstrzyga
// uwierzytelnione odszyfrowanie, nie id.
//
// Sejf jest przypięty do uchwytu bazy (`przypnijSejf`). Bez przypięcia `sejfBazy` odmawia — nie sięga do
// `process.env`, żeby kod z innym uchwytem bazy nie szyfrował po cichu cudzym kluczem.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BladKonfiguracji } from '../blad-konfiguracji.ts';

/** Format danych w bazie, który zna ten kod. Liczba leży w pliku danych, żeby generator paczki mógł ją
 * odczytać z pakowanego commita bez wykonywania jego kodu. */
export const FORMAT_SEKRETOW = Number(JSON.parse(readFileSync(new URL('./format-sekretow.json', import.meta.url), 'utf8')).format);

export const ZMIENNA_KLUCZA = 'OMS_KLUCZ_SEKRETOW';
export const ZMIENNA_POPRZEDNIEGO = 'OMS_KLUCZ_SEKRETOW_POPRZEDNI';
export const KLUCZ_FORMATU = 'sekrety.format';
export const KLUCZ_SPRZATANIA = 'sekrety.sprzatanie';

const WERSJA = 'oms1';
const DLUGOSC_KLUCZA = 32;
const DLUGOSC_NONCE = 12;
const DLUGOSC_ZNACZNIKA = 16;
const WSKAZOWKA = 'na klucz zapisany przy instalacji (plik klucz.env, kopia w menedżerze haseł). Opis odzyskania: docs/instalacja-docker.md, rozdział „Klucz poświadczeń”.';

export class BladSekretow extends Error {
  /** @param {'BRAK_KLUCZA'|'INNY_KLUCZ'|'USZKODZONY'|'NIEZNANA_WERSJA'|'JAWNY_WIERSZ'} kod */
  constructor(kod, opis, { tabela = null, wiersz = null } = {}) {
    super(opis);
    this.name = 'BladSekretow';
    this.kod = kod;
    this.tabela = tabela;
    this.wiersz = wiersz;
    // Treść ma tylko tabelę, wiersz i id klucza — ekran „Sprawdź połączenie” pokaże ją zamiast „błąd techniczny”.
    this.dlaOperatora = true;
  }
}

/** Kanoniczny base64url: dekodowanie i ponowne kodowanie daje to samo wejście (ostatni znak ma wolne bity). */
function kanoniczny(tekst) {
  if (typeof tekst !== 'string' || !/^[A-Za-z0-9_-]+$/.test(tekst)) return null;
  const bajty = Buffer.from(tekst, 'base64url');
  return bajty.toString('base64url') === tekst ? bajty : null;
}

/** Bajty klucza albo null, gdy tekst nie jest kanonicznym base64url 32 bajtów. */
export function bajtyKlucza(tekst) {
  const b = kanoniczny(String(tekst ?? '').trim());
  return b && b.length === DLUGOSC_KLUCZA ? b : null;
}

export function idKlucza(bajty) {
  return createHash('sha256').update('oms-klucz-id').update(bajty).digest('hex').slice(0, 8);
}

/** Nowy losowy klucz (tekst do pliku klucz.env). */
export function nowyKlucz() {
  return randomBytes(DLUGOSC_KLUCZA).toString('base64url');
}

const opisMiejsca = ({ tabela, kolumna, id }) => `${tabela}.${kolumna}, wiersz ${JSON.stringify(String(id))}`;
const aad = ({ tabela, kolumna, id }) => Buffer.from(JSON.stringify([tabela, kolumna, String(id)]), 'utf8');

/**
 * Klasa wartości w kolumnie z sekretem — jedna klasyfikacja dla kontroli startu, konwersji, warstwy dostępu i narzędzia.
 * @returns {'pusty'|'szyfrogram'|'nieznana-wersja'|'uszkodzony'|'jawny'}
 */
export function klasyfikuj(wartosc, { json = false } = {}) {
  if (wartosc === null || wartosc === undefined) return 'pusty';
  const t = String(wartosc);
  if (t === '' || (json && t.trim() === '{}')) return 'pusty';
  if (t.startsWith(`${WERSJA}.`)) return czesciZapisu(t) ? 'szyfrogram' : 'uszkodzony';
  if (/^oms\d+\./.test(t)) return 'nieznana-wersja';
  return 'jawny';
}

function czesciZapisu(t) {
  const czesci = t.split('.');
  if (czesci.length !== 4 || czesci[0] !== WERSJA || !/^[0-9a-f]{8}$/.test(czesci[1])) return null;
  const nonce = kanoniczny(czesci[2]);
  const dane = kanoniczny(czesci[3]);
  if (!nonce || nonce.length !== DLUGOSC_NONCE || !dane || dane.length < DLUGOSC_ZNACZNIKA + 1) return null;
  return { id: czesci[1], nonce, dane };
}

/** Id klucza, którym zaszyfrowano zapis (bez klucza — do `sekrety.mjs stan`), albo null. */
export function idKluczaZapisu(tekst) {
  return klasyfikuj(tekst) === 'szyfrogram' ? String(tekst).split('.')[1] : null;
}

function szyfrujKluczem(bajty, id, jawny, miejsce) {
  const nonce = randomBytes(DLUGOSC_NONCE);
  const c = createCipheriv('aes-256-gcm', bajty, nonce, { authTagLength: DLUGOSC_ZNACZNIKA });
  c.setAAD(aad(miejsce));
  const dane = Buffer.concat([c.update(String(jawny), 'utf8'), c.final(), c.getAuthTag()]);
  return `${WERSJA}.${id}.${nonce.toString('base64url')}.${dane.toString('base64url')}`;
}

function odszyfrujKluczem(bajty, { nonce, dane }, miejsce) {
  const d = createDecipheriv('aes-256-gcm', bajty, nonce, { authTagLength: DLUGOSC_ZNACZNIKA });
  d.setAAD(aad(miejsce));
  d.setAuthTag(dane.subarray(dane.length - DLUGOSC_ZNACZNIKA));
  const tekst = Buffer.concat([d.update(dane.subarray(0, dane.length - DLUGOSC_ZNACZNIKA)), d.final()]);
  return tekst.toString('utf8'); // dopiero po udanym final()
}

/** Sejf z bajtów kluczy (bieżący i opcjonalny poprzedni). */
export function utworzSejf(biezacy, poprzedni = null) {
  const kluczB = { bajty: biezacy, id: idKlucza(biezacy) };
  const kluczP = poprzedni && !poprzedni.equals(biezacy) ? { bajty: poprzedni, id: idKlucza(poprzedni) } : null;
  /** Odszyfrowanie z informacją, którym kluczem się udało. */
  function odszyfrujSzczegolowo(zapis, miejsce) {
    const klasa = klasyfikuj(zapis);
    const gdzie = { tabela: miejsce.tabela, wiersz: String(miejsce.id) };
    if (klasa === 'nieznana-wersja') throw new BladSekretow('NIEZNANA_WERSJA', `Sekret w ${opisMiejsca(miejsce)} ma nieznaną wersję formatu — baza z nowszego wydania.`, gdzie);
    if (klasa === 'uszkodzony') throw new BladSekretow('USZKODZONY', `Sekret w ${opisMiejsca(miejsce)} jest uszkodzony.`, gdzie);
    if (klasa !== 'szyfrogram') throw new BladSekretow('JAWNY_WIERSZ', `Sekret w ${opisMiejsca(miejsce)} nie jest zaszyfrowany.`, gdzie);
    const czesci = czesciZapisu(String(zapis));
    const kandydaci = [kluczB, kluczP].filter(k => k && k.id === czesci.id);
    if (!kandydaci.length) {
      throw new BladSekretow('INNY_KLUCZ', `Sekret w ${opisMiejsca(miejsce)} zaszyfrowano kluczem o id ${czesci.id}, a w konfiguracji jest klucz o id ${kluczB.id}${kluczP ? ` (poprzedni: ${kluczP.id})` : ''}.`, gdzie);
    }
    for (const k of kandydaci) {
      try { return { tekst: odszyfrujKluczem(k.bajty, czesci, miejsce), poprzedni: k === kluczP }; } catch { /* następny kandydat */ }
    }
    throw new BladSekretow('USZKODZONY', `Sekret w ${opisMiejsca(miejsce)} nie przechodzi uwierzytelnienia kluczem o id ${czesci.id} — uszkodzony albo przeniesiony z innego wiersza.`, gdzie);
  }
  return Object.freeze({
    idKlucza: kluczB.id,
    idPoprzedniego: kluczP?.id ?? null,
    szyfruj: (jawny, miejsce) => szyfrujKluczem(kluczB.bajty, kluczB.id, jawny, miejsce),
    odszyfruj: (zapis, miejsce) => odszyfrujSzczegolowo(zapis, miejsce).tekst,
    odszyfrujSzczegolowo,
  });
}

function bladKlucza(zmienna, opis) {
  return new BladKonfiguracji(zmienna, opis, WSKAZOWKA);
}

/** Sejf ze środowiska. Brak albo zła postać klucza = BladKonfiguracji (odmowa startu), nigdy klucz zastępczy. */
export function sejfZEnv(env) {
  const tekst = env?.[ZMIENNA_KLUCZA];
  if (tekst === undefined || String(tekst).trim() === '') {
    throw bladKlucza(ZMIENNA_KLUCZA, `Brak klucza poświadczeń ${ZMIENNA_KLUCZA} — bez niego OMS nie odczyta poświadczeń integracji zapisanych w bazie.`);
  }
  const biezacy = bajtyKlucza(tekst);
  if (!biezacy) throw bladKlucza(ZMIENNA_KLUCZA, `${ZMIENNA_KLUCZA}: zła postać klucza — oczekiwane 43 znaki base64url (32 bajty).`);
  const tekstP = env?.[ZMIENNA_POPRZEDNIEGO];
  let poprzedni = null;
  if (tekstP !== undefined && String(tekstP).trim() !== '') {
    poprzedni = bajtyKlucza(tekstP);
    if (!poprzedni) throw bladKlucza(ZMIENNA_POPRZEDNIEGO, `${ZMIENNA_POPRZEDNIEGO}: zła postać klucza — oczekiwane 43 znaki base64url (32 bajty).`);
  }
  return utworzSejf(biezacy, poprzedni);
}

const przypiete = new WeakMap();
let sejfDomyslny = null;

export function przypnijSejf(db, sejf) {
  if (!sejf || typeof sejf.szyfruj !== 'function') throw new TypeError('przypnijSejf: brak sejfu');
  przypiete.set(db, sejf);
  return db;
}

/** Sejf przypięty do uchwytu bazy. Bez przypięcia — odmowa (BRAK_KLUCZA). */
export function sejfBazy(db) {
  const s = przypiete.get(db) ?? sejfDomyslny;
  if (!s) throw new BladSekretow('BRAK_KLUCZA', 'Uchwyt bazy nie ma przypiętego klucza poświadczeń — ścieżka startu pominęła sejf.');
  return s;
}

export function maPrzypietySejf(db) {
  return przypiete.has(db);
}

/**
 * Sejf dla ścieżki startu: z env (brak albo zła postać klucza = BladKonfiguracji). Jedyny wyjątek — proces testów
 * z sejfem domyślnym i env bez klucza; w programie sejfu domyślnego nie ma, więc zawsze decyduje env.
 */
export function sejfDlaStartu(env) {
  if (sejfDomyslny && !env?.[ZMIENNA_KLUCZA]) return sejfDomyslny;
  return sejfZEnv(env);
}

/** ⛔ Wyłącznie plik przygotowawczy testów (tests/pomoc/sejf-testowy.ts) — strażnik zabrania tego w src/, scripts/, deploy/. */
export function ustawSejfDomyslny(sejf) {
  sejfDomyslny = sejf ?? null;
}

// --- odczyt i zapis w warstwach dostępu ---

/** Wartość do zapisu w kolumnie: NULL zostaje NULL, pusty tekst pustym (klasa „pusty”), reszta szyfrogram. */
export function doZapisu(db, miejsce, jawny) {
  if (jawny === null || jawny === undefined) return null;
  // Zaszyfrowany pusty tekst ma 16 bajtów (sam znacznik) — parser uznałby go za uszkodzony i start by odmówił.
  if (String(jawny) === '') return '';
  return sejfBazy(db).szyfruj(String(jawny), miejsce);
}

/** Odczyt twardy: pusty → bez zmian, szyfrogram → tekst jawny, wszystko inne → BladSekretow (nigdy pusta wartość). */
export function zOdczytu(db, miejsce, zapis, { json = false } = {}) {
  const klasa = klasyfikuj(zapis, { json });
  if (klasa === 'pusty') return zapis;
  return sejfBazy(db).odszyfruj(zapis, miejsce);
}
