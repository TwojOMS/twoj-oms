// PRZ-152.G3a — stan płatności KARTY zamówienia: jedna plakietka dla panelu „Szczegóły”
// (i od G9 dla nagłówka sekcji „Płatności”). Plan: docs/plany/PRZ-152-G3-G9-platnosci.md, D1–D3.
//
// ⚠️ To NIE jest `stanPlatnosci` z blok-platnosci.js. Tamta funkcja służy mailom („pobranie wygrywa
// zawsze” — mail idzie przed doręczeniem) i zostaje bez zmian. Karta różni się w dwóch miejscach:
//   - po rozliczeniu pobrania przez kuriera (wpłata ręczna z metodą „Za pobraniem”) mówi „Opłacone”;
//   - zna zwroty z oddanymi pieniędzmi.
// `saldoWplat` (faktury, pasek spraw, nadanie) też zostaje — tu jest tylko UŻYWANA.
//
// Arytmetyka wyłącznie w groszach przez `grosze()` / `kwotaZwrotuGrosze` — żadnego Number(a)+Number(b).
// Funkcja NIGDY nie rzuca (ta sama zasada, co `saldoWplat`): zepsuta kwota daje „Błąd wyceny”.
import { kwotaOczekiwanaGrosze } from './suma-pozycji.js';
import { saldoWplat, sumaWplatGrosze, resztaDoPobrania } from './platnosci.js';
import { czyPobranie, pobranieZeSklepu } from './wysylka.js';
import { normalizujMetode } from './metody-platnosci.js';
import { kwotaZwrotuGrosze } from './zwrot.js';
import { fmtDataCzasKrotko } from './format-daty.js';

export const STAN_KARTY = Object.freeze({
  BLAD: 'blad',
  ZWROCONE_CALOSC: 'zwrocone_calosc',
  POBRANIE: 'pobranie',
  ZBIORCZE: 'zbiorcze',
  ZWROCONE_CZESCIOWO: 'zwrocone_czesciowo',
  NIEOPLACONE: 'nieoplacone',
  OPLACONE: 'oplacone',
  NADPLATA: 'nadplata',
});

/** Jedna etykieta dla G3 i G9 (D3), z wielkiej litery, bez kwot i dat. */
export const ETYKIETA_STANU = Object.freeze({
  blad: 'Błąd wyceny',
  zwrocone_calosc: 'Zwrócone w całości',
  pobranie: 'Pobranie · czeka na kuriera',
  zbiorcze: 'Rozliczenie zbiorcze',
  zwrocone_czesciowo: 'Zwrócone częściowo',
  nieoplacone: 'Nieopłacone',
  oplacone: 'Opłacone',
  nadplata: 'Nadpłata',
});

/** Ton → istniejąca klasa layoutu (layout-oms.ejs; kontrast ≥ 4,5:1 w obu motywach, plan 2.7). */
export const KLASA_TONU = Object.freeze({
  ok: 'znacznik--ok',
  zle: 'znacznik--czerwony',
  pobranie: 'znacznik--pomaranczowy',
  szary: 'znacznik--szary',
});

const TON_STANU = Object.freeze({
  blad: 'szary',
  zwrocone_calosc: 'szary',
  pobranie: 'pobranie',
  zbiorcze: 'szary',
  zwrocone_czesciowo: 'szary',
  nieoplacone: 'zle',
  oplacone: 'ok',
  nadplata: 'ok', // właściciel: „nadpłata = zielony”
});

const kluczMetody = (p) => normalizujMetode(p?.metoda).klucz;

/**
 * Wpłata, która NIE jest pieniędzmi: `date_paid` sklepu przy pobraniu (decyzja A(2) z 04.11).
 * Ta sama granica, co w `przedplatyPrzedPobraniem` (platnosci.js): wpłata `sklep` przy pobraniu
 * sprzedanym przez sklep albo wpłata `sklep` z metodą „Za pobraniem”.
 */
const wplataNieliczona = (z, p) => czyPobranie(z) && p?.zrodlo === 'sklep'
  && (pobranieZeSklepu(z) || kluczMetody(p) === 'pobranie');

/** Rozliczenie kuriera = wpłata z metodą „Za pobraniem”, której nie dopisał sklep. */
const rozliczeniePobrania = (p) => kluczMetody(p) === 'pobranie' && p?.zrodlo !== 'sklep';

function wynik(stan, { opis = null, kwotaGr = null, wplaconoGr = null, zwroconoGr = null, doPobraniaGr = null, pominieteWplaty = [] } = {}) {
  const ton = TON_STANU[stan];
  return {
    stan, etykieta: ETYKIETA_STANU[stan], ton, klasa: KLASA_TONU[ton], opis,
    kwotaGr, wplaconoGr, zwroconoGr,
    saldoGr: kwotaGr === null || wplaconoGr === null ? null : wplaconoGr - kwotaGr,
    doPobraniaGr, pominieteWplaty,
  };
}

/**
 * Stan płatności karty (D2 — pierwsza pasująca reguła wygrywa):
 *   1 błąd wyceny · 2 zwrócone w całości · 3 pobranie bez rozliczenia kuriera · 4 rozliczenie
 *   zbiorcze · 5 zwrócone częściowo · 6 nieopłacone · 7 opłacone · 8 nadpłata.
 * `z` to zamówienie (przy scaleniu — grupa z `platnosciKarty`), `zwroty` — zwroty zamówienia,
 * `wOkresie` — czy zamówienie należy do okresu rozliczeniowego.
 */
export function stanPlatnosciKarty(z, { zwroty = [], wOkresie = false } = {}) {
  try {
    const saldo = saldoWplat(z);
    if (saldo.stan === 'blad') return wynik(STAN_KARTY.BLAD, { opis: saldo.blad || 'Nie da się policzyć kwoty zamówienia' });

    const wplaty = z?.platnosci ?? [];
    const pominiete = wplaty.filter((p) => wplataNieliczona(z, p));
    const K = kwotaOczekiwanaGrosze(z);
    const W = sumaWplatGrosze(wplaty.filter((p) => !pominiete.includes(p)));
    // Zwrot liczy się dopiero, gdy pieniądze naprawdę oddano (wzór z twojefaktury/saldo.js).
    const O = (zwroty ?? []).filter((w) => w?.pieniadze_oddane_at)
      .reduce((s, w) => s + kwotaZwrotuGrosze(w), 0);
    const liczby = { kwotaGr: K, wplaconoGr: W, zwroconoGr: O, pominieteWplaty: pominiete.map((p) => p.id) };

    if (O > 0 && O >= W) return wynik(STAN_KARTY.ZWROCONE_CALOSC, liczby);
    if (czyPobranie(z) && !wplaty.some(rozliczeniePobrania)) {
      let doPobraniaGr = null;
      try { doPobraniaGr = resztaDoPobrania(z); } catch { doPobraniaGr = null; }
      return wynik(STAN_KARTY.POBRANIE, { ...liczby, doPobraniaGr });
    }
    if (wOkresie && W < K) return wynik(STAN_KARTY.ZBIORCZE, liczby);
    if (O > 0) return wynik(STAN_KARTY.ZWROCONE_CZESCIOWO, liczby);
    if (W < K) return wynik(STAN_KARTY.NIEOPLACONE, liczby);
    if (W === K) return wynik(STAN_KARTY.OPLACONE, liczby);
    return wynik(STAN_KARTY.NADPLATA, liczby);
  } catch (e) {
    return wynik(STAN_KARTY.BLAD, { opis: (e instanceof Error && e.message) || 'Nie da się policzyć płatności' });
  }
}

// ── PRZ-152.G9a1 — lista ruchów (D4, D5): wpłaty i zwroty w jednej tablicy dla widoku ──────────

const SAMA_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Data ruchu dla listy (decyzja właściciela 05.11: „4.11”): zawsze `D.M GG:MM` w Europe/Warsaw, bez zer
 * z przodu i bez „dziś”/„wczoraj”; inny rok niż `teraz` → `D.M.RRRR GG:MM`. Wartość z SAMĄ datą
 * dostaje sam dzień — bez fałszywego „00:00” (data zapłaty ze sklepu często nie ma godziny).
 * Pusta / nieparsowalna → ''.
 */
export function kiedyRuchu(data, teraz = new Date()) {
  const pelna = fmtDataCzasKrotko(data);
  if (!pelna) return '';
  const [rok, miesiac, dzien] = pelna.slice(0, 10).split('-');
  const rokTeraz = fmtDataCzasKrotko(teraz.toISOString()).slice(0, 4);
  const dzienMiesiac = `${Number(dzien)}.${Number(miesiac)}${rok === rokTeraz ? '' : `.${rok}`}`;
  return SAMA_DATA.test(String(data).trim()) ? dzienMiesiac : `${dzienMiesiac} ${pelna.slice(11, 16)}`;
}

const grosze = (f) => { try { return f(); } catch { return null; } };

function opisWplaty(p, liczona) {
  if (!liczona) return 'Data zapłaty ze sklepu przy pobraniu — nie jest wpłatą';
  const metoda = normalizujMetode(p?.metoda);
  // Dopisek w nawiasie (np. „Allegro (płatność online)”) jest dla statystyk; w ruchu łamał opis na 2 linie.
  const nazwa = metoda.klucz === 'nieokreslona' && p?.metoda ? String(p.metoda) : metoda.etykieta.replace(/\s*\(.*\)$/, '');
  return `Wpłata · ${nazwa}${p?.zrodlo === 'sklep' ? ' · ze sklepu' : ''}`;
}

/**
 * Wpłaty i zwroty w jednej tablicy, rosnąco po dacie (zwrot: `pieniadze_oddane_at ?? data`);
 * przy równej dacie wpłata przed zwrotem, potem `id`. Kwoty w groszach (`kwotaGr`, `null` gdy
 * nie do odczytania), bez znaku — znak w `znak` ('+' / '−'). Nigdy nie rzuca.
 *   wpłata: { rodzaj:'wplata', znak:'+', kwotaGr, kiedy, opis, zrodlo, zZamowienia, zamowienieId,
 *             uwaga, id, usuwalna, liczona }
 *   zwrot:  { rodzaj:'zwrot', znak:'−', kwotaGr, kiedy, opis, id, oddany }
 */
export function ruchyPlatnosci({ wplaty = [], zwroty = [], pominieteWplaty = [], teraz = new Date() } = {}) {
  const pominiete = new Set(pominieteWplaty ?? []);
  const lista = [];
  for (const p of wplaty ?? []) {
    const liczona = !pominiete.has(p?.id);
    lista.push({
      rodzaj: 'wplata', znak: '+', kwotaGr: grosze(() => sumaWplatGrosze([p])),
      data: p?.data, kiedy: kiedyRuchu(p?.data, teraz), opis: opisWplaty(p, liczona),
      zrodlo: p?.zrodlo ?? null, zZamowienia: p?.zZamowienia ?? null, zamowienieId: p?.zamowienie_id ?? null,
      uwaga: p?.uwaga ?? null, id: p?.id, usuwalna: p?.zrodlo === 'reczna', liczona,
    });
  }
  for (const w of zwroty ?? []) {
    const oddany = Boolean(w?.pieniadze_oddane_at);
    const data = w?.pieniadze_oddane_at ?? w?.data;
    lista.push({
      rodzaj: 'zwrot', znak: '−', kwotaGr: grosze(() => kwotaZwrotuGrosze(w)),
      data, kiedy: kiedyRuchu(data, teraz), opis: oddany ? 'Zwrot' : 'Zwrot · pieniądze do oddania',
      id: w?.id, oddany,
    });
  }
  const klucz = (r) => fmtDataCzasKrotko(r.data) || '';
  const waga = (r) => (r.rodzaj === 'wplata' ? 0 : 1);
  return lista.sort((a, b) => klucz(a).localeCompare(klucz(b)) || waga(a) - waga(b) || (a.id ?? 0) - (b.id ?? 0));
}
