// Konta Allegro i ERLI z pobranymi listami cenników dostaw — jedno źródło dla ekranu Cenników, karty, podglądu
// „Wystaw na ERLI” i edycji hurtowej. Allegro przyjmuje w ofercie identyfikator cennika, ERLI jego nazwę, więc
// wartość wyboru to id (Allegro) albo nazwa (ERLI). `cenniki: null` znaczy „lista niepobrana” — to co innego niż
// pobrana pusta lista i od tego zależy napis odmowy.
import { ustawieniaOfertKonta } from '../../../oms/db/oferty-kanalow.ts';
import { adresKanalu } from '../../../domena/kanaly.js';

export const TEKST_LISTA_NIEPOBRANA =
  'Lista cenników konta niepobrana — pobierz ją w Magazyn → Cenniki, potem wybierz cennik dla tego konta na karcie.';

const tekst = (w) => (typeof w === 'string' ? w : '');

/** Ustawienia jawne konta ERLI (bez sekretów) — lista cenników i data ich pobrania. */
function listaErli(db, klucz) {
  try {
    const w = db
      .prepare('SELECT ustawienia_json FROM konfiguracja_integracji WHERE integracja = ?')
      .get(`erli:${klucz}`);
    const u = JSON.parse(w?.ustawienia_json ?? '{}') ?? {};
    return {
      lista: Array.isArray(u.cennikiDostaw) ? u.cennikiDostaw.filter((n) => typeof n === 'string') : null,
      pobranoAt: typeof u.cennikiPobranoAt === 'string' ? u.cennikiPobranoAt : null,
    };
  } catch {
    return { lista: null, pobranoAt: null };
  }
}

/**
 * Bieżące konta Allegro i ERLI z pobranymi cennikami, w kolejności: Allegro, potem ERLI.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ kontaAllegro: readonly { klucz: string }[], kontaErli: readonly { klucz: string }[],
 *   definicje: readonly { klucz: string, etykieta?: string }[] }} o
 * @returns {{ klucz: string, rodzaj: 'allegro' | 'erli', nazwaKanalu: string, etykieta: string,
 *   cenniki: { wartosc: string, nazwa: string }[] | null, pobranoAt: string | null }[]}
 */
export function kontaZCennikami(db, { kontaAllegro, kontaErli, definicje }) {
  const allegro = kontaAllegro.map((k) => {
    const slowniki = /** @type {any} */ (ustawieniaOfertKonta(db, k.klucz)?.slowniki ?? null);
    const pobrana = Array.isArray(slowniki?.cenniki);
    return {
      klucz: k.klucz,
      rodzaj: /** @type {const} */ ('allegro'),
      nazwaKanalu: 'Allegro',
      etykieta: `Allegro · ${adresKanalu(k.klucz, definicje)}`,
      cenniki: pobrana
        ? slowniki.cenniki
            .filter((p) => p && typeof p.id === 'string' && p.id.trim())
            .map((p) => ({ wartosc: p.id, nazwa: tekst(p.nazwa) || p.id }))
        : null,
      pobranoAt: pobrana && typeof slowniki.pobranoAt === 'string' ? slowniki.pobranoAt : null,
    };
  });
  const erli = kontaErli.map((k) => {
    const { lista, pobranoAt } = listaErli(db, k.klucz);
    return {
      klucz: k.klucz,
      rodzaj: /** @type {const} */ ('erli'),
      nazwaKanalu: 'ERLI',
      etykieta: `ERLI · ${adresKanalu(k.klucz, definicje)}`,
      cenniki: lista ? lista.map((n) => ({ wartosc: n, nazwa: n })) : null,
      pobranoAt,
    };
  });
  return [...allegro, ...erli];
}

/** Nazwa cennika o tej wartości z listy konta; `null`, gdy go na liście nie ma albo lista jest niepobrana. */
export function nazwaCennikaKonta(konto, wartosc) {
  return konto?.cenniki?.find((p) => p.wartosc === wartosc)?.nazwa ?? null;
}

/**
 * Czy wybór cennika dla konta można zapisać. Nowy wybór musi być z pobranej listy; zapisany wcześniej (`dawna`)
 * zostaje, nawet gdy zniknął z listy — sprzedawca nie traci go przy zapisie innego pola.
 * @returns {'ok' | 'spoza-listy' | 'lista-niepobrana'}
 */
export function stanWyboruCennika(konto, wartosc, dawna) {
  if (!wartosc || wartosc === dawna) return 'ok';
  if (!konto.cenniki) return 'lista-niepobrana';
  return konto.cenniki.some((p) => p.wartosc === wartosc) ? 'ok' : 'spoza-listy';
}

/** Komunikat odmowy zapisu wyboru albo `null`, gdy wybór jest dozwolony. */
export function bladWyboruCennika(konto, wartosc, dawna) {
  return stanWyboruCennika(konto, wartosc, dawna) === 'ok' ? null : `Wybierz cennik z listy konta ${konto.etykieta}.`;
}

/**
 * Wynik doboru (`dobierzCennik`) z napisem dla tego konta. Domena nie zna list kont, więc „konto bez cennika”
 * przy niepobranej liście zamienia się tu na wskazówkę, by listę pobrać — inaczej sprzedawca szukałby powiązania,
 * którego bez listy nie ustawi. Pozostałe odmowy i dobrany cennik przechodzą bez zmian.
 */
export function odmowaDlaKonta(konto, wynikDoboru) {
  if (wynikDoboru?.odmowa?.kod === 'brak-cennika' && konto && konto.cenniki === null)
    return { odmowa: { kod: 'lista-niepobrana', tekst: TEKST_LISTA_NIEPOBRANA } };
  return wynikDoboru;
}
