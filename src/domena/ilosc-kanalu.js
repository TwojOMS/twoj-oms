import { createHash } from 'node:crypto';
import { STATUSY_WOO_BEZ_ROZCHODU } from './stany-magazynowe.js';

// Szablony problemów. Konkretna decyzja uzupełnia od, cel, odczyt i ewentualny zakres.
export const PROBLEMY_ILOSCI = Object.freeze(Object.fromEntries([
  ['skok', true, 'Niewyjaśniony skok stanu karty.'],
  ['rozjazd-dol', true, 'Stan kanału poniżej wyjaśnionego zakresu.'],
  ['rozjazd-gora', true, 'Stan kanału powyżej wyjaśnionego zakresu; wysyłamy obniżkę OMS.'],
  ['zero-masowe', true, 'Wiele ofert konta jednocześnie przechodzi do zera.'],
  ['stan-rodzica', true, 'Wariant korzysta ze stanu rodzica.'],
  ['bez-stanu-w-sklepie', true, 'Sklep nie prowadzi stanu produktu.'],
  ['ujemny-stan', true, 'Sklep pokazuje ujemny stan (sprzedaż na zamówienie); ilości nie wysyłamy, póki stan nie wróci do zera lub wyżej.'],
  ['ilosc-niezmienialna', true, 'Kanał nie pozwala zmienić ilości.'],
  ['zamrozona-ilosc', true, 'Ilość oferty jest zamrożona.'],
  ['brak-karty', true, 'Oferta nie ma powiązanej karty.'],
  // Szef 14.11: kod nadaje pętla (E4.08); ekran „Problemy ofert” (E4.13) daje tylko ręczne „Wznów”.
  ['czeste-wznawianie', true, 'Oferta wznawiana przez OMS ponad 3 razy na dobę — wznów ręcznie.'],
  ['brak-stanu', false, 'Stan karty nie jest znany.'],
  ['stany-niezatwierdzone', false, 'Bieżące włączenie stanów czeka na zatwierdzenie.'],
  ['stany-wylaczone', false, 'Stany magazynowe są wyłączone.'],
  ['brak-pollera', false, 'Brak pollera konta; podwyżka czeka.'],
  ['karencja', false, 'Czekamy na stabilny odczyt, poller i migawkę po nim.'],
].map(([kod, wstrzymuje, tekst]) => [kod, Object.freeze({ kod, wstrzymuje, od: null, cel: null, odczyt: null, tekst })])));

const problem = (kod, dane) => ({ ...PROBLEMY_ILOSCI[kod], ...dane });
// Data bez strefy (zapis SQLite) jest UTC, jak dataUtc w produkty-odczyt.js.
const BEZ_STREFY = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const czas = wartosc => wartosc == null ? NaN
  : new Date(typeof wartosc === 'string' && BEZ_STREFY.test(wartosc) ? `${wartosc.replace(' ', 'T')}Z` : wartosc).getTime();

/** D47. Migawka ma kształt z §5.0; brak znanego stanu nigdy nie oznacza zera. */
export function iloscDlaKanalu({ migawka, kartaId, tryb, iloscZOms, bufor = 0, stalaIlosc }) {
  const brak = powod => ({ ilosc: null, zrodlo: null, powod });
  if (tryb !== 'zarzadzana' && !(tryb === 'obserwowana' && iloscZOms)) return brak(null);
  if (!migawka.wlaczone) {
    if (tryb === 'obserwowana') return brak('stany-wylaczone');
    return stalaIlosc == null ? brak('brak-stalej') : { ilosc: stalaIlosc, zrodlo: 'stala', powod: null };
  }
  if (migawka.przelaczenieId == null || migawka.zatwierdzenie?.przelaczenieId !== migawka.przelaczenieId) {
    return brak('stany-niezatwierdzone');
  }
  if (!migawka.znane.has(kartaId)) return brak('brak-stanu');
  const stan = migawka.stany.get(kartaId)?.stan;
  if (!Number.isFinite(stan)) return brak('brak-stanu');
  return { ilosc: Math.max(0, stan - bufor), zrodlo: 'stan', powod: null };
}

/** D53. Wyjaśnienie to suma wartości bezwzględnych pozycji i ruchów po wysyłce (E4.03). */
export function skokIlosci({ stan, stanKartyWyslany, wyjasnioneKarty = 0, prog = 5, od = null, cel = null, odczyt = null }) {
  if (stanKartyWyslany == null) return null;
  const skok = Math.abs(stan - stanKartyWyslany) - wyjasnioneKarty;
  return skok > prog ? problem('skok', { od, cel, odczyt }) : null;
}

// D64 (2) i (3), również dla karencji D54. Kursor nie jest dowodem pracy pollera.
function poPulsie({ poller, od, policzonoAt, pollerMs }) {
  return !!poller && (poller.ostatniBlad == null || poller.ostatniBladRodzaj === 'pominiecie')
    && czas(poller.ostatniPrzebiegAt) >= czas(od) + pollerMs
    && czas(policzonoAt) > czas(poller.ostatniPrzebiegAt);
}

/** D64. poprzedniOdczyt: {ilosc, odczytanoAt} sprzed przebiegu; czas migawki i puls z §5.0.
 * pollerMs przekazuje wywołujący z konfiguracji, bez odczytu środowiska w domenie. */
export function wolnoPodniesc({ cel, odczyt, poprzedniOdczyt, poller, policzonoAt, pollerMs }) {
  if (!Number.isFinite(odczyt)) return { wolno: false, powod: 'karencja' };
  if (cel <= odczyt) return { wolno: true, powod: null };
  if (!poller) return { wolno: false, powod: 'brak-pollera' };
  const stabilny = poprzedniOdczyt?.ilosc === odczyt;
  const wolno = stabilny && poPulsie({ poller, od: poprzedniOdczyt.odczytanoAt, policzonoAt, pollerMs });
  return { wolno, powod: wolno ? null : 'karencja' };
}

/** D54. Wyjaśnienia liczy E4.03 według reguły kanału (Woo po zmienione_at).
 * alarmOd to zachowana chwila pierwszego odczytu poza dolnym zakresem, wToku: {cel,at}
 * albo komenda Allegro {wartosc}. baza jest propozycją aktualizacji W/T, bez efektów ubocznych.
 * wolnoWyslac dotyczy wyłącznie rozjazdu; skok, D64 i inne bramki sprawdza wywołujący. */
export function ocenRozjazdu({ wyslanaIlosc, odczyt, cel, wyjasnienie = {}, wToku,
  odczytanoAt, alarmOd, poller, policzonoAt, pollerMs }) {
  if (!Number.isFinite(odczyt)) {
    return { zgodny: false, wolnoWyslac: false, problem: problem('karencja', { od: alarmOd ?? odczytanoAt, cel }), baza: null };
  }
  const zgodny = baza => ({ zgodny: true, wolnoWyslac: true, problem: null, baza });
  const baza = { wyslanaIlosc: odczyt, iloscWyslanaAt: odczytanoAt };
  if (odczyt === (wToku?.cel ?? wToku?.wartosc) || odczyt === cel) return zgodny(baza);
  if (wyslanaIlosc == null) return zgodny(null);
  const zakres = { min: wyslanaIlosc - (wyjasnienie.sprzedaneOd ?? 0),
    max: wyslanaIlosc + (wyjasnienie.anulowaneOd ?? 0) };
  if (odczyt >= zakres.min && odczyt <= zakres.max) return zgodny(null);
  const od = alarmOd ?? odczytanoAt;
  let kod;
  if (odczyt > zakres.max) kod = 'rozjazd-gora';
  else kod = poPulsie({ poller, od, policzonoAt, pollerMs }) ? 'rozjazd-dol' : 'karencja';
  return { zgodny: false, wolnoWyslac: kod !== 'rozjazd-dol' && cel <= odczyt,
    problem: problem(kod, { od, cel, odczyt, zakres }), baza: null };
}

/** D52. Wejście zawiera wszystkie oferty konta objęte ilością z OMS, także bez celu/odczytu. */
export function zeroMasowe(oferty) {
  const zerowane = oferty.filter(o => o.cel === 0 && o.odczyt > 0).length;
  return zerowane >= 3 && zerowane * 2 >= oferty.length;
}

/**
 * E4.30p (B1 recenzji). Potwierdzenie zer jest ważne tylko w przełączeniu stanów, w którym je kliknięto
 * (`zeraPotwierdzone.przelaczenieId` = `migawka.przelaczenieId`). Wyłączenie i ponowne włączenie stanów
 * (nowe przełączenie) albo flaga bez `przelaczenieId` = potwierdzenie nieważne.
 */
export function potwierdzenieZerWazne(oferta, migawka) {
  const id = oferta?.wyslanePola?.zeraPotwierdzone?.przelaczenieId;
  return id != null && id === migawka?.przelaczenieId;
}

/**
 * E4.30. „Wyślij zera” (`wyslanePola.zeraPotwierdzone`) jest jednorazowe na ofertę: taka oferta nie wchodzi
 * do wejścia `zeroMasowe` i nie dostaje `zero-masowe`; jej cel 0 przechodzi przez pozostałe bezpieczniki.
 * E4.30p: tylko ważne potwierdzenie (to samo przełączenie stanów) wyłącza ofertę z zera masowego.
 */
export function liczySieDoZeraMasowego(oferta, migawka) {
  return !potwierdzenieZerWazne(oferta, migawka);
}

/** E4.30. Potwierdzenie zer jest zużyte, gdy kanał ma już 0 albo cel wzrósł ponad 0 (po zapisie 0 — przy sukcesie). */
export function potwierdzenieZerZuzyte({ cel, odczyt }) {
  return odczyt === 0 || cel > 0;
}

/** E4.30. `wyslanePola` bez potwierdzenia zer. */
export function bezPotwierdzeniaZer(wyslanePola) {
  const { zeraPotwierdzone: _, ...reszta } = wyslanePola ?? {};
  return reszta;
}

/** D57. Wejście: {konto, cel, odczyt}; grupowanie ma zachować kierunek zmiany. */
export function kluczKomendyIlosci({ cel, odczyt }) {
  return `ilosc:${cel}:${cel <= odczyt ? 'obnizka' : 'podwyzka'}`;
}

export function kolejnoscWysylek(wysylki) {
  return [...wysylki].sort((a, b) => String(a.konto).localeCompare(String(b.konto))
    || Number(a.cel > a.odczyt) - Number(b.cel > b.odczyt));
}

/** D56. Każdy element kanaly dotyczy jednej karty i jednego konta: {kanal: 'woo'|'erli'|'allegro',
 * odczyt, odczytanoAt, manage_stock?, zamowienia?: [{ilosc,zlozonoAt,status,anulowane}]}.
 * Zamówienia muszą być już ograniczone do tej karty i konta. Świeżość odczytu sprawdza trasa podglądu. */
export function propozycjaOtwarcia({ kanaly, granica }) {
  const wartosci = kanaly.filter(k => Number.isFinite(k.odczyt)
    && (k.kanal !== 'woo' || k.manage_stock === true)).map(k => {
    const sprzedane = (k.zamowienia ?? []).filter(z => czas(z.zlozonoAt) >= czas(granica)
      && czas(z.zlozonoAt) <= czas(k.odczytanoAt) && !z.anulowane
      && z.status !== 'cancelled' && (k.kanal !== 'woo'
        || (!STATUSY_WOO_BEZ_ROZCHODU.includes(z.status) && z.status !== 'pending')))
      .reduce((suma, z) => suma + z.ilosc, 0);
    return { ...k, sprzedane, wartosc: Math.max(0, k.odczyt + sprzedane) };
  });
  const ilosc = wartosci.length ? Math.min(...wartosci.map(k => k.wartosc)) : null;
  return { ilosc, kanaly: wartosci.map(k => ({ ...k, roznica: k.wartosc !== ilosc })) };
}

// Porządek zbiorów i kluczy obiektów nie ma wpływu na zatwierdzenie.
function kanonicznie(w) {
  if (Array.isArray(w)) return `[${w.map(kanonicznie).join(',')}]`;
  if (w && typeof w === 'object') return `{${Object.keys(w).sort().map(k => `${JSON.stringify(k)}:${kanonicznie(w[k])}`).join(',')}}`;
  return JSON.stringify(w);
}
const zbior = w => [...w].map(kanonicznie).sort();

/** D51. oferty: wiersze rejestru, maxRuchId: MAX(ruchy_magazynowe.id), bufory: wiersze kont.
 * Stany, zużycie, zamówienia i czas obliczenia migawki celowo nie uczestniczą w skrócie. */
export function skrotZatwierdzenia({ oferty, migawka, maxRuchId, bufory }) {
  const objete = oferty.filter(o => o.tryb === 'zarzadzana' || (o.tryb === 'obserwowana' && o.ilosc_z_oms))
    .map(o => ({ id: o.id, kanal: o.kanal, id_zewnetrzne: o.id_zewnetrzne, karta_id: o.karta_id,
      tryb: o.tryb, ilosc_z_oms: o.ilosc_z_oms }));
  const dane = { oferty: zbior(objete), znane: zbior(migawka.znane),
    otwarcia: zbior(migawka.otwarcia), maxRuchId, bufory: zbior(bufory) };
  return createHash('sha256').update(kanonicznie(dane)).digest('hex');
}
