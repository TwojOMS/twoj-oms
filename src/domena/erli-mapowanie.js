// PRZ-157.04 — zamówienie ERLI (Shop API, `Order`) → model panelu (te same klucze, co `mapujZamowienieAllegro`).
//
// Kwoty w ERLI są w GROSZACH, liczbami całkowitymi (12345 = 123,45 zł). Rynek i waluta (D3): zamówienie spoza
// rynku PL albo w walucie innej niż PLN dostaje sprawę do ręcznej obsługi — kursów NIE przeliczamy.
// Termin wysyłki (D6) liczy `terminWysylkiErli` z `dispatchTime`; adapter dokłada w `surowe._oms` czasy
// z kart produktów ERLI i domyślny czas kanału, bo mapowanie nie ma prawa pytać sieci.

import { bladOperatora } from './bledy.js';
import { bezEtykietyNip } from './dane-faktury.js';
import { dzienTerminu } from './termin-wysylki.js';
import { dzienWarszawa } from './format-daty.js';

const zGroszy = (g) => (g / 100).toFixed(2);
const nettoZBruttaGr = (bruttoGr, stawka) => Math.round((bruttoGr * 100) / (100 + stawka));

// ERLI `taxRate` → stawka panelu. Zwolnienie i „nie podlega" liczą netto jak 0%.
const STAWKI = {
  TAX_23: '23', TAX_8: '8', TAX_5: '5', TAX_0: '0', TAX_7: '7', TAX_19: '19', TAX_ZW: 'zw', TAX_NP: 'np',
};
const STAWKA_DOMYSLNA = '23';
const stawkaPozycji = (p) => STAWKI[p?.taxRate] ?? STAWKA_DOMYSLNA;
const procent = (stawka) => (/^\d+$/.test(stawka) ? Number(stawka) : 0);

const tekstAlboNull = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

// ⚠️ Kwota, która nie jest całkowitą liczbą groszy, to odmowa TEGO zamówienia (poller zapisze powód),
// a nie zgadywanie, czy „108,46" to złotówki, czy grosze.
function groszeErli(v, co) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw bladOperatora(`ERLI: ${co} nie jest kwotą w groszach (${JSON.stringify(v ?? null)}).`);
}
const groszeLubZero = (v, co) => (v == null ? 0 : groszeErli(v, co));

function ulica(a) {
  if (tekstAlboNull(a?.address)) return tekstAlboNull(a.address);
  const dom = [a?.buildingNumber, a?.flatNumber].map(tekstAlboNull).filter(Boolean).join('/');
  return tekstAlboNull([a?.street, dom].map(tekstAlboNull).filter(Boolean).join(' '));
}

function adresPanelu(a) {
  if (!a) return null;
  const blok = {
    first_name: tekstAlboNull(a.firstName),
    last_name: tekstAlboNull(a.lastName),
    company: tekstAlboNull(a.companyName),
    address_1: ulica(a),
    address_2: null,
    postcode: tekstAlboNull(a.zip),
    city: tekstAlboNull(a.city),
    country: (tekstAlboNull(a.country) ?? 'pl').toUpperCase(),
  };
  const { country, ...reszta } = blok;
  if (Object.values(reszta).every((pole) => pole === null)) return null;
  return blok;
}

function dostawaErli(surowe) {
  const a = surowe?.user?.deliveryAddress ?? null;
  const blok = adresPanelu(a);
  return blok ? { ...blok, phone: tekstAlboNull(a.phone) } : null;
}

const firmowa = (surowe) => surowe?.user?.invoiceAddress?.type === 'company' ? surowe.user.invoiceAddress : null;

function klientErli(surowe) {
  const dost = surowe?.user?.deliveryAddress ?? null;
  const firma = firmowa(surowe);
  const podstawa = firma ? adresPanelu(firma) : adresPanelu(surowe?.user?.invoiceAddress ?? dost);
  if (!podstawa) return null;
  return { ...podstawa, email: tekstAlboNull(surowe?.user?.email), phone: tekstAlboNull(dost?.phone) };
}

function opisPunktu(p) {
  if (!p) return null;
  const czesci = [p.name, p.address, [p.zip, p.city].map(tekstAlboNull).filter(Boolean).join(' '), p.provider]
    .map(tekstAlboNull).filter(Boolean);
  return czesci.length ? czesci.join(', ') : null;
}

function pozycjeErli(surowe) {
  return (surowe?.items ?? []).map((p) => {
    const ilosc = Number(p?.quantity) || 1;
    const nazwa = tekstAlboNull(p?.name) ?? '(bez nazwy)';
    const jednostkowoGr = groszeErli(p?.unitPrice, `cena pozycji „${nazwa}" w zamówieniu ${surowe?.id ?? '(bez id)'}`);
    const liniaGr = jednostkowoGr * ilosc;
    const stawka = stawkaPozycji(p);
    const pr = procent(stawka);
    const przedRabatem = Number.isInteger(p?.unitPriceBeforeRebate) && p.unitPriceBeforeRebate > jednostkowoGr
      ? zGroszy(p.unitPriceBeforeRebate) : null;
    return {
      zrodlo_id: p?.id != null ? String(p.id) : null,
      nazwa,
      sku: tekstAlboNull(p?.sku),
      ean: tekstAlboNull(p?.ean),
      ilosc,
      cena_brutto: zGroszy(jednostkowoGr),
      cena_netto: zGroszy(nettoZBruttaGr(jednostkowoGr, pr)),
      brutto_linii: zGroszy(liniaGr),
      netto_linii: zGroszy(nettoZBruttaGr(liniaGr, pr)),
      vat: stawka,
      cena_katalogowa: przedRabatem,
      zdjecie_url: null,
      produkt_id: null,
      oferta_id: tekstAlboNull(p?.externalId),
    };
  });
}

const rynek = (surowe) => (tekstAlboNull(surowe?.market) ?? 'pl').toLowerCase();
const waluta = (surowe) => (tekstAlboNull(surowe?.currency) ?? 'PLN').toUpperCase();

// Czas wysyłki jednej pozycji wg kolejności źródeł D6: pozycja → karta produktu ERLI → domyślny kanału.
function czasPozycji(p, oms) {
  if (p?.dispatchTime) return { czas: p.dispatchTime, zrodlo: 'pozycja' };
  const zProduktu = p?.externalId != null ? oms?.czasyProduktow?.[p.externalId] : null;
  if (zProduktu) return { czas: zProduktu, zrodlo: 'produkt' };
  const domyslny = Number(oms?.domyslnyCzasWysylki);
  if (oms?.domyslnyCzasWysylki != null && Number.isInteger(domyslny) && domyslny >= 0) {
    return { czas: { period: domyslny, unit: 'day' }, zrodlo: 'domyslny' };
  }
  return null;
}

const SILA = { pozycja: 0, produkt: 1, domyslny: 2 };
const PUSTY_TERMIN = Object.freeze({ termin: null, przyblizony: false, zrodlo: null });

/**
 * Termin wysyłki ERLI (D6): dzień zakupu (Europe/Warsaw) + NAJWIĘKSZY czas wysyłki pozycji w dniach roboczych.
 * Pozycja bez żadnego czasu albo czas w innej jednostce niż dni → pusty termin (bez zgadywania).
 * `przyblizony` = któraś pozycja wzięła czas domyślny kanału; `zrodlo` = najsłabsze użyte źródło.
 */
export function terminWysylkiErli(surowe) {
  const start = surowe?.purchasedAt ?? surowe?.created ?? null;
  const pozycje = surowe?.items ?? [];
  if (!start || !pozycje.length) return { ...PUSTY_TERMIN };
  let limit = 0;
  let zrodlo = 'pozycja';
  for (const p of pozycje) {
    const c = czasPozycji(p, surowe?._oms);
    if (!c || c.czas?.unit !== 'day') return { ...PUSTY_TERMIN };
    const okres = Number(c.czas.period);
    if (!Number.isInteger(okres) || okres < 0) return { ...PUSTY_TERMIN };
    limit = Math.max(limit, okres);
    if (SILA[c.zrodlo] > SILA[zrodlo]) zrodlo = c.zrodlo;
  }
  return { termin: dzienTerminu({ dzienStartu: dzienWarszawa(start), limit }), przyblizony: zrodlo === 'domyslny', zrodlo };
}

/** Sprawy do ręcznej obsługi zamówienia ERLI (D3 rynek/waluta, D6 jednostka czasu wysyłki). */
export function sprawyErli(surowe) {
  const sprawy = [];
  const r = rynek(surowe);
  const w = waluta(surowe);
  if (r !== 'pl' || w !== 'PLN') {
    const czesci = [r !== 'pl' ? `z rynku ${r.toUpperCase()}` : null, w !== 'PLN' ? `w ${w}` : null].filter(Boolean);
    sprawy.push({ klucz: 'erli_rynek', tekst: `ERLI: zamówienie ${czesci.join(' / ')} — obsłuż ręcznie` });
  }
  const jednostki = new Set();
  for (const p of surowe?.items ?? []) {
    const c = czasPozycji(p, surowe?._oms);
    if (c?.czas?.unit && c.czas.unit !== 'day') jednostki.add(String(c.czas.unit));
  }
  if (jednostki.size) {
    sprawy.push({ klucz: 'erli_czas_wysylki', tekst: `ERLI: czas wysyłki w jednostce „${[...jednostki].join(', ')}" — ustal termin ręcznie` });
  }
  return sprawy;
}

/**
 * Zamówienie ERLI → model panelu albo `null` dla `pending` (D2: zamówienie nieopłacone nie wchodzi).
 * `cancelled` → anulowane; `returned` niczego nie zmienia (zwrot obsługuje panel).
 */
export function mapujZamowienieErli(surowe) {
  // D7: poller zapisuje również TEN obiekt jako surowe_json. Redakcja musi objąć źródło,
  // nie tylko model panelu; działa też dla importu z pominięciem klienta HTTP.
  if (Array.isArray(surowe?.returns)) for (const zwrot of surowe.returns) if (zwrot && typeof zwrot === 'object') delete zwrot.bankAccount;
  if (surowe?.status === 'pending') return null;
  const pobranie = surowe?.delivery?.cod ? 1 : 0;
  const razem = groszeErli(surowe?.totalPrice, `kwota zamówienia ${surowe?.id ?? '(bez id)'}`);
  if (pobranie && razem <= 0) {
    throw bladOperatora(`ERLI: zamówienie za pobraniem bez kwoty do pobrania: ${surowe?.id ?? '(bez id)'}.`);
  }
  const dostawaGr = groszeLubZero(surowe?.delivery?.price, `koszt dostawy zamówienia ${surowe?.id ?? '(bez id)'}`);
  const stawkaDostawy = procent(stawkaPozycji(surowe?.items?.[0]));
  const firma = firmowa(surowe);
  const zakup = surowe?.purchasedAt ?? null;
  return {
    zrodlo_id: surowe?.id != null ? String(surowe.id) : null,
    numer: surowe?.id != null ? String(surowe.id) : null,
    klient: klientErli(surowe),
    dostawa: dostawaErli(surowe),
    // Mapowanie `delivery.typeId` → kurier panelu to osobna zmiana; do tego czasu jak Allegro bez słownika.
    metoda_wysylki: surowe?.delivery?.typeId === 'selfPickup' ? 'odbior_osobisty' : 'nieznana',
    metoda_wysylki_nazwa: tekstAlboNull(surowe?.delivery?.name),
    pobranie,
    kwota_pobrania: pobranie ? zGroszy(razem) : null,
    // Kod punktu (np. paczkomatu) jest w `externalId`; `id` ERLI to liczba wewnętrzna, nie kod punktu.
    punkt_odbioru: tekstAlboNull(surowe?.delivery?.pickupPlace?.externalId),
    punkt_odbioru_opis: opisPunktu(surowe?.delivery?.pickupPlace),
    chce_fakture: firma ? 1 : 0,
    nip: firma ? bezEtykietyNip(firma.nip) : null,
    kwota_brutto: zGroszy(razem),
    koszt_dostawy_brutto: zGroszy(dostawaGr),
    koszt_dostawy_netto: zGroszy(nettoZBruttaGr(dostawaGr, stawkaDostawy)),
    status_woo: surowe?.status ?? null,
    status_realizacji: surowe?.sellerStatus ?? null,
    metoda_platnosci: pobranie ? 'Za pobraniem' : 'ERLI',
    // Przy pobraniu pieniędzy jeszcze nie ma — inkasuje kurier.
    oplacone_at: pobranie ? null : zakup,
    anulowane: surowe?.status === 'cancelled' ? 1 : 0,
    utworzone_at: zakup ?? surowe?.created ?? null,
    uwagi: tekstAlboNull(surowe?.comment),
    indywidualne: 0,
    termin_wysylki_kanalu: terminWysylkiErli(surowe),
    sprawy: sprawyErli(surowe),
    pozycje: pozycjeErli(surowe),
  };
}
