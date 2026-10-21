import { normalizujNip } from './klient-zbiorczy.js';
import { STAWKA_VAT } from './vat.js';

// WEWNĄTRZWSPÓLNOTOWA DOSTAWA TOWARÓW (WDT) — jedyne miejsce rozstrzygające, czy dokument
// jest WDT i co z tego wynika dla payloadu inFaktu. Spec: 2026-08-26-oms-faktury-wdt-design.md.
//
// Rozpoznanie idzie po NIP-ie NABYWCY DOKUMENTU: `normalizujNip` (domain/klient-zbiorczy.js)
// zachowuje prefiks wyłącznie dla zamkniętego słownika kodów UE (a `PL` zdejmuje), więc
// „numer zaczyna się od dwóch liter" znaczy dokładnie „nabywca z innego państwa Unii".
// Śmieci archiwalne („brak", „XY123") wychodzą z normalizacji jako same cyfry i stawki 0%
// nie włączą. To ta sama własność, na której stoi dopasowanie klientów — nie dublujemy jej
// tu drugą listą kodów.
//
// ⚠️ MODUŁ JEST CZYSTY: bez bazy, bez sieci, bez zegara. Licznik serii mieszka
// w db/wdt-numery.js, weryfikacja numeru w services/vies.js.

const WZORZEC_UE = /^([A-Z]{2})([0-9A-Z]+)$/;

/** Czy nabywca o tym numerze jest podatnikiem z innego państwa UE (dokument = WDT). */
export function czyNipUe(nip) {
  return WZORZEC_UE.test(normalizujNip(nip));
}

/** Kod kraju i numer do zapytania VIES — `null` dla numeru krajowego. */
export function rozbijNipUe(nip) {
  const m = WZORZEC_UE.exec(normalizujNip(nip));
  return m ? { kraj: m[1], numer: m[2] } : null;
}

/**
 * Stawka DOKUMENTU dla tego nabywcy. Jedyne miejsce, któremu wolno oddać co innego niż
 * STAWKA_VAT — domain/vat.js zastrzega, że inna stawka ma być świadomą zmianą z testem,
 * i to jest dokładnie ta zmiana.
 *
 * ⚠️ Przy 0% kwoty zamówienia SĄ kwotami netto (netto = brutto), więc arytmetyka pozycji,
 * bariera i saldo wpłat działają bez ani jednej zmiany — regułę cenową (cena sklepowa
 * − rabat → ÷1,23) wykonuje operator przy zakładaniu zamówienia, jak dotąd w Apilo.
 */
export function stawkaDokumentu(nip) {
  return czyNipUe(nip) ? '0' : STAWKA_VAT;
}

/**
 * Cena jednostkowa WDT z ceny brutto (w groszach): zdjęcie 23% polskiego VAT-u wliczonego
 * w cenę sklepową. Reguła cenowa z wiki: cena sklepowa − rabat → ÷1,23 = kwota netto na
 * dokumencie WDT (przy 0% netto = brutto = kwota do zapłaty).
 *
 * ⚠️ TRZECIE sankcjonowane miejsce dzielenia brutta w module (po domain/vat.js
 * i domain/podsumowanie-vat.js — tam stoi cała wykładnia zakazu z przewodnika 4.5)
 * i jedyne, którego wynik JEST wartością źródłową: cena WDT nie istnieje nigdzie indziej
 * (sklep zna wyłącznie brutto z 23%), więc nie ma czego zgubić ani z czym się rozjechać.
 * Wolno jej użyć WYŁĄCZNIE przy WSTAWIANIU pozycji (magazyn → zamówienie, przeliczenie
 * rabatu) — nigdy przy wystawianiu faktury: tam kwoty zamówienia są już gotowe.
 *
 * ⚠️ DZIELIMY CENĘ ZA SZTUKĘ, a linia = cena × ilość — dokładnie jak w Apilo
 * (WDT/1/06/2026: cyfry 5cm 12,50 × 3 = 37,50, a NIE 46,14 ÷ 1,23 = 37,51). Ta sama
 * zasada, co przy rabacie (cenaPoRabacieGrosze): zaokrąglamy sztukę, mnożymy potem.
 *
 * Podłoga jeden grosz — ta sama, co przy rabacie: cena zero jest w tym panelu odmową,
 * pozycja gratis wpisuje się jawnie.
 */
//
// PRZ-105 (decyzja właściciela 21.10): dzielimy przez stawkę DOMYŚLNĄ z Ustawień (wołający czyta
// moduly/faktury/db/stawka-vat.js) — w cenie sklepowej siedzi stawka sklepu, nie stałe 23.
// Domyślny parametr STAWKA_VAT jest tu dopuszczalny: funkcja liczy tylko cenę wstawianą do
// formularza (operator widzi ją przed zapisem), a nie stawkę, która idzie na fakturę.
export function cenaWdtGrosze(cenaBruttoGr, stawka = STAWKA_VAT) {
  const DZIELNIK = 1 + Number(stawka) / 100;
  return Math.max(1, Math.round(cenaBruttoGr / DZIELNIK));
}

/**
 * Numer serii WDT — dokładnie wzorzec z Apilo (`WDT/1/06/2026`): licznik miesięczny,
 * miesiąc z zerem wiodącym, pozycja bez padu. Sam licznik siedzi w db/wdt-numery.js.
 */
export function numerWdt(rok, miesiac, kolejny) {
  return `WDT/${kolejny}/${String(miesiac).padStart(2, '0')}/${rok}`;
}

/**
 * Pola payloadu inFaktu, które dokłada WYŁĄCZNIE dokument WDT. Dla nabywcy krajowego —
 * pusty obiekt, żeby payload faktury krajowej został bajt w bajt taki, jaki był
 * (ta sama zasada, co `sposobPlatnosciFaktury`).
 *
 * Kształt zmierzony na żywym koncie 26.08.2026 (dokument próbny, skasowany):
 * `sale_type: 'merchandise'` jest przy nabywcy zagranicznym WYMAGANE („Proszę określić
 * rodzaj sprzedaży"), `sales_kind: 'sprzedaz_podstawowa'` to wartość dowiedziona tamtym
 * dokumentem. Adnotacja w `notes` niesie NIP sprzedawcy z prefiksem `PL`, bo inFakt sam
 * go nie drukuje, a art. 106e ust. 1 pkt 24 w zw. z art. 97 ust. 10 ustawy o VAT wymaga
 * go przy WDT na dokumencie.
 */
export function polaWdtInfakt(nip, { nipSprzedawcy }) {
  if (!czyNipUe(nip)) return {};
  const bezPl = String(nipSprzedawcy ?? '').trim().replace(/^PL/i, '');
  return {
    sale_type: 'merchandise',
    sales_kind: 'sprzedaz_podstawowa',
    notes: `Wewnątrzwspólnotowa dostawa towarów (WDT), stawka VAT 0%. NIP sprzedawcy: PL${bezPl}.`,
  };
}
