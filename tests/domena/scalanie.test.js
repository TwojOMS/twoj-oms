import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import {
  zapiszZamowienie, pobierzZamowienie, zamowieniaPoId, dodajPozycjeReczna, zapiszNadpisaniaPozycji, zapiszNadpisaniaWysylki,
} from '../../src/oms/db/zamowienia.js';
import {
  powodyOdmowyScalenia, ostrzezeniaScalenia, roznicaKupujacego, wysylkaGrupyGrosze, kwotaGrupyGrosze,
  zamowienieGrupy, sprawdzCzlonkowGrupy, domyslneGlowne, decyzjaScalenia, idsDolaczonych,
  powodOdmowyPobraniaGrupy, wysylkiGrupy,
} from '../../src/domena/scalanie.js';
import { saldoWplat } from '../../src/domena/platnosci.js';
import { migracjaScalen } from '../../src/moduly/zamowienia/migracje/0003-scalenia.ts';
import { wolnoPrzypisac } from '../../src/domena/zmiana-okresu.js';
import { ustawKanalyAllegro } from '../../src/domena/wysylka.js';
import { powodBrakuGotowosciNadania } from '../../src/domena/gotowosc-nadania.js';
import { doZrobienia, uwagaDolaczonychAnulowanych } from '../../src/domena/status.js';
import { pozycjeDokumentu, sprawdzSumeDokumentu } from '../../src/domena/pozycje-faktury.js';
import { kwotaOczekiwanaGrosze } from '../../src/domena/suma-pozycji.js';

// PRZ-101.04 — reguły scalania jako czyste funkcje. Zamówienia odczytane tak, jak czyta je karta
// (`pobierzZamowienie`), bo reguły czytają wartości EFEKTYWNE (nakładki ręczne, wysyłka).
const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: `S-${id}`,
  klient: { first_name: 'Anna', last_name: 'Przykładowa', email: 'anna@example.invalid', phone: '600100200' },
  dostawa: { first_name: 'Anna', last_name: 'Przykładowa', address_1: 'Lipowa 3', postcode: '00-950', city: 'Testowo', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1111111111',
  kwota_brutto: '115.00', koszt_dostawy_brutto: '15.00', status_woo: 'processing', oplacone_at: '2026-10-10T10:00:00Z',
  anulowane: 0, utworzone_at: `2026-10-${String(10 + (id % 10)).padStart(2, '0')}T09:00:00Z`,
  pozycje: [{ nazwa: `Lampa ${id}`, sku: `L-${id}`, ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00', vat: null }],
  ...nad,
});

let db;
const zam = (id, nad = {}, sklep = 'sklep_a') => pobierzZamowienie(db, zapiszZamowienie(db, sklep, zmapowane(id, nad), {}));
const jakoGlowne = (g, dolaczone, wysylka) => ({ ...g, scalenie_json: JSON.stringify({ wysylka, dolaczone: dolaczone.map((d) => d.id) }) });

beforeEach(() => { db = openOmsDb(':memory:'); });

describe('powodyOdmowyScalenia', () => {
  it('dwa zamówienia sklepu tego samego kupującego — wolno', () => {
    const a = zam(1); const b = zam(2);
    expect(powodyOdmowyScalenia([a, b], { glowneId: a.id })).toEqual([]);
  });

  it('mniej niż dwa — odmowa', () => {
    const a = zam(1);
    expect(powodyOdmowyScalenia([a], { glowneId: a.id })[0]).toMatch(/co najmniej dwa/);
  });

  it('główne spoza zaznaczonych — odmowa', () => {
    const a = zam(1); const b = zam(2);
    expect(powodyOdmowyScalenia([a, b], { glowneId: 999 }).join()).toMatch(/główne musi być jednym z zaznaczonych/);
  });

  it('Allegro po prefiksie klucza kanału — odmowa', () => {
    const a = zam(1); const b = zam(2, {}, 'allegro_x');
    expect(powodyOdmowyScalenia([a, b], { glowneId: a.id }).join()).toMatch(/S-2 jest z Allegro/);
  });

  // PRZ-101.08: jedna reguła w repo — `czyKanalAllegro` z rejestrem kanałów `typ: 'allegro'`
  // (w aplikacji ustawia go moduł kanałów z OMS_KANALY; tu wprost, jak w kanaly-allegro-prz101-08).
  it('Allegro po typie kanału z konfiguracji (klucz `allegro` bez prefiksu) — odmowa', () => {
    try {
      ustawKanalyAllegro(['allegro']);
      const a = zam(1); const b = zam(2, {}, 'allegro');
      expect(powodyOdmowyScalenia([a, b], { glowneId: a.id }).join()).toMatch(/S-2 jest z Allegro/);
      expect(powodyOdmowyScalenia([a, zam(3)], { glowneId: a.id })).toEqual([]);
    } finally {
      ustawKanalyAllegro([]);
    }
  });

  it('sklep + ręczne tego samego nabywcy — wolno', () => {
    const a = zam(1); const r = zam(2, {}, 'reczne');
    expect(powodyOdmowyScalenia([a, r], { glowneId: a.id })).toEqual([]);
  });

  it.each([
    ['anulowane', (z) => ({ ...z, anulowane: 1 }), /jest anulowane/],
    ['zwrot', (z) => ({ ...z, zwrot_at: '2026-10-12T00:00:00Z' }), /ma zwrot/],
    ['wysłane', (z) => ({ ...z, wyslane_at: '2026-10-12T00:00:00Z' }), /już wysłane/],
    ['żywa przesyłka', (z) => ({ ...z, przesylki: [{ id: 1, status: 'nadana' }] }), /nadaną przesyłkę/],
    ['już dołączone', (z) => ({ ...z, scalone_do: 77 }), /już dołączone/],
    ['główne innej grupy', (z) => ({ ...z, scalenie_json: '{"wysylka":"suma","dolaczone":[5]}' }), /głównym innej grupy/],
    ['okres rozliczeniowy', (z) => ({ ...z, okres_rozliczeniowy_id: 3 }), /okresu rozliczeniowego/],
    ['pobranie w dołączanym', (z) => ({ ...z, pobranie: 1 }), /za pobraniem/],
    ['faktura w dołączanym', (z) => ({ ...z, faktura: { numer: 'FV/9/2026' } }), /ma już fakturę FV\/9\/2026 — po scaleniu byłyby dwie faktury/],
  ])('%s w dołączanym — odmowa z numerem zamówienia', (_n, zmien, wzor) => {
    const a = zam(1); const b = zmien(zam(2));
    const powody = powodyOdmowyScalenia([a, b], { glowneId: a.id });
    expect(powody.join('\n')).toMatch(wzor);
    expect(powody.join('\n')).toMatch(/S-2/);
  });

  it('faktura w GŁÓWNYM nie blokuje (to ostrzeżenie), proforma — ostrzeżenie', () => {
    const a = { ...zam(1), faktura: { numer: 'FV/1/2026' } }; const b = zam(2);
    expect(powodyOdmowyScalenia([a, b], { glowneId: a.id })).toEqual([]);
    const ostrz = ostrzezeniaScalenia([a, b], { glowneId: a.id, proformy: new Set([b.id]) });
    expect(ostrz.join('\n')).toMatch(/faktura NIE obejmuje dołączonych pozycji/);
    expect(ostrz.join('\n')).toMatch(/S-2 ma proformę/);
  });

  // Decyzja kierownika 18.10 (ryzyko 5 z raportu): pobranie także w GŁÓWNYM — odmowa.
  it('pobranie w GŁÓWNYM — odmowa „Zamówień za pobraniem nie scalamy”', () => {
    const a = { ...zam(1), pobranie: 1 }; const b = zam(2);
    const powody = powodyOdmowyScalenia([a, b], { glowneId: a.id });
    expect(powody).toEqual(['Zamówienie S-1: zamówień za pobraniem nie scalamy — kwota pobrania obejmowałaby tylko jedno zamówienie.']);
  });

  it('różny NIP — odmowa; ten sam NIP z etykietą „NIP:” i myślnikami — wolno', () => {
    const a = zam(1); const b = zam(2, { nip: 'NIP: 111-111-11-11' }); const c = zam(3, { nip: '2222222222' });
    expect(powodyOdmowyScalenia([a, b], { glowneId: a.id })).toEqual([]);
    expect(powodyOdmowyScalenia([a, c], { glowneId: a.id }).join()).toMatch(/różne NIP-y/);
  });

  it('NIP poprawiony ręcznie na karcie wygrywa ze sklepem', () => {
    const a = zam(1); const c = { ...zam(3, { nip: '2222222222' }), klient_reczny_json: JSON.stringify({ nip: '1111111111' }) };
    expect(powodyOdmowyScalenia([a, c], { glowneId: a.id })).toEqual([]);
  });
});

describe('roznicaKupujacego — tylko informacja, na wartościach znormalizowanych', () => {
  it('e-mail różniący się wielkością liter i telefon ze spacjami/+48 — bez różnic', () => {
    const a = zam(1);
    const b = zam(2, { klient: { first_name: 'Anna', last_name: 'Przykładowa', email: 'ANNA@Example.invalid ', phone: '+48 600 100 200' } });
    expect(roznicaKupujacego([a, b])).toEqual([]);
  });

  it('inny adres — różnica z wartościami obu zamówień', () => {
    const a = zam(1);
    const b = zam(2, { dostawa: { first_name: 'Anna', last_name: 'Przykładowa', address_1: 'Brzozowa 9', postcode: '00-950', city: 'Testowo', country: 'PL' } });
    const r = roznicaKupujacego([a, b]);
    expect(r.map((x) => x.pole)).toEqual(['adres']);
    expect(r[0].wartosci.map((w) => w.numer)).toEqual(['S-1', 'S-2']);
    expect(r[0].wartosci[1].wartosc).toMatch(/Brzozowa 9/);
  });

  it('nakładka ręczna wygrywa ze sklepem (różnica znika po poprawce na karcie)', () => {
    const a = zam(1);
    const idB = zapiszZamowienie(db, 'sklep_a', zmapowane(2, { dostawa: { first_name: 'Ania', last_name: 'P', address_1: 'Lipowa 3', postcode: '00-950', city: 'Testowo' } }), {});
    expect(roznicaKupujacego([a, pobierzZamowienie(db, idB)]).map((x) => x.pole)).toContain('nazwa');
    zapiszNadpisaniaWysylki(db, idB, { nazwa: 'Anna Przykładowa' });
    expect(roznicaKupujacego([a, pobierzZamowienie(db, idB)])).toEqual([]);
  });
});

describe('domyślne główne, decyzja', () => {
  it('najstarsze jest domyślnym głównym', () => {
    const a = zam(5); const b = zam(2); const c = zam(7);
    expect(domyslneGlowne([a, b, c])).toBe(b.id);
  });
  it('uszkodzony scalenie_json = nie jest głównym (nie rzuca)', () => {
    expect(decyzjaScalenia({ scalenie_json: '{zly' })).toBeNull();
    expect(idsDolaczonych({ scalenie_json: '{"dolaczone":[3,"4"],"wysylka":"x"}' })).toEqual([3, 4]);
    expect(decyzjaScalenia({ scalenie_json: '{"dolaczone":[3],"wysylka":"x"}' }).wysylka).toBe('glowne');
  });
});

describe('wysyłka i kwota grupy', () => {
  // PRZ-101.11: dołączone NIEOPŁACONE — przy opłaconym jego wysyłka wchodzi zawsze (testy niżej).
  it('„z zamówienia głównego” — wysyłka głównego; „suma” — suma wysyłek', () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00', oplacone_at: null });
    expect(wysylkaGrupyGrosze(a, [b], 'glowne')).toBe(1500);
    expect(wysylkaGrupyGrosze(a, [b], 'suma')).toBe(3500);
    expect(kwotaGrupyGrosze(a, [b], 'glowne')).toBe(21500);
    expect(kwotaGrupyGrosze(a, [b], 'suma')).toBe(23500);
  });

  it('wysyłka poprawiona ręcznie na głównym liczy się wartością efektywną', () => {
    const idA = zapiszZamowienie(db, 'sklep_a', zmapowane(1), {});
    zapiszNadpisaniaPozycji(db, idA, { wysylka: { ilosc: 2 } });
    const a = pobierzZamowienie(db, idA); const b = zam(2, { oplacone_at: null });
    expect(wysylkaGrupyGrosze(a, [b], 'glowne')).toBe(3000);
    expect(wysylkaGrupyGrosze(a, [b], 'suma')).toBe(4500);
  });
});

describe('zamowienieGrupy — zestaw pozycji faktury grupy', () => {
  // PRZ-101.11: „suma” to osobna pozycja wysyłki na każde zamówienie (do 19.10 — jedna zsumowana linia).
  it('„suma”: pozycje obu zamówień + wysyłka każdego osobną linią; bariera przechodzi', () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' });
    const g = zamowienieGrupy(jakoGlowne(a, [b], 'suma'), [b]);
    const services = pozycjeDokumentu(g, { stawkaDomyslna: '23' });
    expect(services.map((s) => [s.name, s.gross_price])).toEqual([
      ['Lampa 1', 10000], ['Lampa 2', 10000], ['Dostawa', 1500], ['Dostawa — zamówienie S-2', 2000],
    ]);
    expect(() => sprawdzSumeDokumentu(services, g)).not.toThrow();
    expect(kwotaOczekiwanaGrosze(g)).toBe(23500);
    expect(g.pozycje.map((p) => p.z_zamowienia)).toEqual(['S-1', 'S-2']);
  });

  // PRZ-101.11 (uwaga właściciela 19.10): dołączone OPŁACONE — kupujący zapłacił za jego wysyłkę, więc
  // wchodzi ona na fakturę także przy „z zamówienia głównego”. Do 19.10 ten test żądał jednej
  // linii Dostawa 15 zł i faktury 215 zł przy wpłatach 235 zł — zachowanie zmienione na prośbę właściciela.
  it('„z zamówienia głównego”, dołączone opłacone: jego wysyłka osobną pozycją, faktura = wpłaty', () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' });
    const g = zamowienieGrupy(jakoGlowne(a, [b], 'glowne'), [b]);
    const services = pozycjeDokumentu(g, { stawkaDomyslna: '23' });
    expect(services.map((s) => [s.name, s.gross_price])).toEqual([
      ['Lampa 1', 10000], ['Lampa 2', 10000], ['Dostawa', 1500], ['Dostawa — zamówienie S-2', 2000],
    ]);
    expect(services.reduce((s, x) => s + x.gross_price, 0)).toBe(23500);
    expect(() => sprawdzSumeDokumentu(services, g)).not.toThrow();
    expect(kwotaOczekiwanaGrosze(g)).toBe(23500);
    expect(g.platnosci.map((p) => p.kwota)).toEqual(['115.00', '120.00']);
    expect(saldoWplat(g).stan).toBe('pokryte');
  });

  // ——— PRZ-101.11 — wysyłka każdego zamówienia grupy osobną pozycją faktury ———
  const b120 = { koszt_dostawy_brutto: '20.00', kwota_brutto: '120.00' };
  const nieoplacone = { ...b120, oplacone_at: null };

  it('opłacone 115 + 120 zł → faktura grupy 235 zł, dwie pozycje wysyłki (obie decyzje)', () => {
    for (const decyzja of ['glowne', 'suma']) {
      const a = zam(1); const b = zam(2, b120);
      const g = zamowienieGrupy(jakoGlowne(a, [b], decyzja), [b]);
      const services = pozycjeDokumentu(g, { stawkaDomyslna: '23' });
      const wysylki = services.filter((s) => s.name.startsWith('Dostawa'));
      expect(wysylki, decyzja).toEqual([
        expect.objectContaining({ name: 'Dostawa', gross_price: 1500, quantity: 1 }),
        expect.objectContaining({ name: 'Dostawa — zamówienie S-2', gross_price: 2000, quantity: 1 }),
      ]);
      expect(services.reduce((s, x) => s + x.gross_price, 0), decyzja).toBe(23500);
      expect(() => sprawdzSumeDokumentu(services, g)).not.toThrow();
      expect(kwotaGrupyGrosze(a, [b], decyzja)).toBe(23500);
      db = openOmsDb(':memory:');
    }
  });

  it('nieopłacone dołączone + „z głównego” → bez jego wysyłki; „suma” → z nią', () => {
    const a = zam(1); const b = zam(2, nieoplacone);
    expect(b.platnosci).toEqual([]);
    const g = zamowienieGrupy(jakoGlowne(a, [b], 'glowne'), [b]);
    const services = pozycjeDokumentu(g, { stawkaDomyslna: '23' });
    expect(services.filter((s) => s.name.startsWith('Dostawa')).map((s) => [s.name, s.gross_price])).toEqual([['Dostawa', 1500]]);
    expect(services.reduce((s, x) => s + x.gross_price, 0)).toBe(21500);
    expect(() => sprawdzSumeDokumentu(services, g)).not.toThrow();
    expect(wysylkaGrupyGrosze(a, [b], 'glowne')).toBe(1500);
    const gs = zamowienieGrupy(jakoGlowne(a, [b], 'suma'), [b]);
    expect(pozycjeDokumentu(gs, { stawkaDomyslna: '23' }).map((s) => s.name)).toContain('Dostawa — zamówienie S-2');
    expect(kwotaOczekiwanaGrosze(gs)).toBe(23500);
  });

  it('wysylkiGrupy: lista z numerem i kwotą — ta sama, którą czyta ekran scalania', () => {
    const a = zam(1); const b = zam(2, b120); const c = zam(3, nieoplacone);
    expect(wysylkiGrupy(a, [b, c], 'glowne')).toEqual([
      { id: a.id, numer: 'S-1', glowne: true, grosze: 1500, ilosc: 1 },
      { id: b.id, numer: 'S-2', glowne: false, grosze: 2000, ilosc: 1 },
    ]);
    expect(wysylkiGrupy(a, [b, c], 'suma').map((w) => w.numer)).toEqual(['S-1', 'S-2', 'S-3']);
  });

  it('dołączone z darmową wysyłką — bez pustej linii', () => {
    const a = zam(1); const b = zam(2, { koszt_dostawy_brutto: '0.00', kwota_brutto: '100.00' });
    const g = zamowienieGrupy(jakoGlowne(a, [b], 'suma'), [b]);
    expect(pozycjeDokumentu(g, { stawkaDomyslna: '23' }).filter((s) => s.name.startsWith('Dostawa')).map((s) => s.name)).toEqual(['Dostawa']);
  });

  it('linie wysyłek grupy muszą dać kwotę wysyłki — inaczej dokument odmówiony', () => {
    const a = zam(1); const b = zam(2, b120);
    const g = zamowienieGrupy(jakoGlowne(a, [b], 'suma'), [b]);
    const zepsute = { ...g, grupa: { ...g.grupa, wysylki: g.grupa.wysylki.slice(0, 1) } };
    expect(() => pozycjeDokumentu(zepsute, { stawkaDomyslna: '23' })).toThrow(/wysyłek grupy/);
  });

  it('pozycja dopisana ręcznie w dołączonym i dane z głównego (nabywca, NIP)', () => {
    const a = zam(1);
    const idB = zapiszZamowienie(db, 'sklep_a', zmapowane(2), {});
    dodajPozycjeReczna(db, idB, { nazwa: 'Klosz dodatkowy', ilosc: 1, cena_brutto: '30.00', brutto_linii: '30.00' });
    const b = pobierzZamowienie(db, idB);
    const g = zamowienieGrupy(jakoGlowne(a, [b], 'suma'), [b]);
    expect(pozycjeDokumentu(g, { stawkaDomyslna: '23' }).map((s) => s.name)).toEqual(['Lampa 1', 'Lampa 2', 'Klosz dodatkowy', 'Dostawa', 'Dostawa — zamówienie S-2']);
    expect(() => sprawdzSumeDokumentu(pozycjeDokumentu(g, { stawkaDomyslna: '23' }), g)).not.toThrow();
    expect(kwotaOczekiwanaGrosze(g)).toBe(11500 + 14500);
    expect(g.id).toBe(a.id);
    expect(g.numer).toBe('S-1');
  });

  it('ręczne główne + sklepowe dołączone — kwota grupy spójna', () => {
    const r = zam(1, { kwota_brutto: '115.00' }, 'reczne'); const b = zam(2);
    const g = zamowienieGrupy(jakoGlowne(r, [b], 'suma'), [b]);
    expect(() => sprawdzSumeDokumentu(pozycjeDokumentu(g, { stawkaDomyslna: '23' }), g)).not.toThrow();
    expect(kwotaOczekiwanaGrosze(g)).toBe(23000);
  });

  it('sprawdzCzlonkowGrupy: dołączone anulowane po scaleniu — odmowa dokumentu', () => {
    const a = zam(1); const b = { ...zam(2), anulowane: 1 };
    expect(() => sprawdzCzlonkowGrupy(a, [b])).toThrow(/S-2 zostało anulowane/);
  });

  it('sprawdzCzlonkowGrupy: członek, którego pozycje nie sumują się do kwoty — odmowa z numerem', () => {
    const a = zam(1); const b = zam(2, { kwota_brutto: '999.00' });
    expect(() => sprawdzCzlonkowGrupy(a, [b])).toThrow(/S-2 \(w grupie\)/);
  });
});

// ——— Poprawki po recenzji (19.10) — reguły jako czyste funkcje ————————————————————————————
describe('recenzja W1–W4: reguły domeny', () => {
  it('W1: wolnoPrzypisac odmawia dołączonemu i głównemu grupy; zwykłe zamówienie — bez zmian', () => {
    const klient = { klucz: 'k' };
    const a = zam(1); const b = { ...zam(2), scalone_do: a.id, scalone_do_numer: 'S-1' };
    const glowne = jakoGlowne(a, [b], 'suma');
    expect(wolnoPrzypisac({ zamowienie: b, faktura: null, klient })).toMatchObject({ wolno: false, powod: expect.stringMatching(/scalone z zamówieniem S-1 .*rozdziel/) });
    expect(wolnoPrzypisac({ zamowienie: glowne, faktura: null, klient })).toMatchObject({ wolno: false, powod: expect.stringMatching(/najpierw je rozdziel/) });
    expect(wolnoPrzypisac({ zamowienie: a, faktura: null, klient })).toEqual({ wolno: true, powod: null });
  });

  it('W1: okres rozliczeniowy w GŁÓWNYM też blokuje scalenie', () => {
    const a = { ...zam(1), okres_rozliczeniowy_id: 3 }; const b = zam(2);
    expect(powodyOdmowyScalenia([a, b], { glowneId: a.id }).join()).toMatch(/S-1 należy do miesięcznego okresu/);
  });

  it('W2: pobranie w grupie — odmowa na głównym i dołączonym; poza grupą null', () => {
    const a = zam(1); const b = { ...zam(2), scalone_do: a.id, scalone_do_numer: 'S-1' };
    expect(powodOdmowyPobraniaGrupy(jakoGlowne(a, [b], 'suma'))).toMatch(/nie wysyłamy za pobraniem/);
    expect(powodOdmowyPobraniaGrupy(b)).toMatch(/scalone z zamówieniem S-1/);
    expect(powodOdmowyPobraniaGrupy(a)).toBeNull();
  });

  it('W2: gotowość nadania odmawia głównemu grupy z pobraniem (stan sprzed poprawki), bez pobrania — gotowe', () => {
    const a = zam(1); const b = zam(2);
    const glowne = jakoGlowne(a, [b], 'suma');
    const zPobraniem = { ...glowne, wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '115.00' }) };
    expect(powodBrakuGotowosciNadania(zPobraniem)).toMatch(/nie wysyłamy za pobraniem/);
    expect(powodBrakuGotowosciNadania(glowne)).toBeNull();
    // Zwykłe zamówienie za pobraniem — bez zmian (pobranie poza grupą jest dozwolone).
    expect(powodBrakuGotowosciNadania({ ...a, wysylka_reczna_json: zPobraniem.wysylka_reczna_json })).toBeNull();
  });

  it('W3: dołączone anulowane — główne na „Do zrobienia” z powodem, nadanie odmawia', () => {
    const a = zam(1); const b = zam(2);
    const glowne = { ...jakoGlowne(a, [b], 'suma'), wyslane_at: '2026-10-12T00:00:00Z', dolaczone_anulowane: [] };
    expect(doZrobienia(glowne)).toBe(false);
    const zAnulowanym = { ...glowne, dolaczone_anulowane: ['S-2'] };
    expect(uwagaDolaczonychAnulowanych(zAnulowanym)).toBe('dołączone zamówienie S-2 anulowane w sklepie — rozdziel albo skoryguj');
    expect(doZrobienia(zAnulowanym)).toBe(true);
    expect(powodBrakuGotowosciNadania({ ...zAnulowanym, wyslane_at: null })).toMatch(/Nie nadasz paczki: dołączone zamówienie S-2 anulowane/);
  });

  it('W3: odczyt niesie dolaczone_anulowane (karta i lista tą samą wartością)', () => {
    // Baza testów domeny to sam rdzeń — kolumny scaleń dokłada migracja modułu zamówień.
    migracjaScalen.wykonaj(db);
    const a = zam(1); const b = zam(2);
    db.prepare('UPDATE zamowienia SET scalone_do = ? WHERE id = ?').run(a.id, b.id);
    db.prepare('UPDATE zamowienia SET scalenie_json = ? WHERE id = ?').run(JSON.stringify({ wysylka: 'suma', dolaczone: [b.id] }), a.id);
    expect(pobierzZamowienie(db, a.id).dolaczone_anulowane).toEqual([]);
    db.prepare('UPDATE zamowienia SET anulowane = 1 WHERE id = ?').run(b.id);
    expect(pobierzZamowienie(db, a.id).dolaczone_anulowane).toEqual(['S-2']);
    expect(zamowieniaPoId(db, [a.id])[0].dolaczone_anulowane).toEqual(['S-2']);
    expect(pobierzZamowienie(db, b.id).dolaczone_anulowane).toBeUndefined();
  });

  it('W4: status nieodesłany do sklepu w którymkolwiek — odmowa scalenia z powodem', () => {
    const a = zam(1); const b = { ...zam(2), sync_woo_blad: 'sklep nie odpowiada' };
    for (const glowneId of [a.id, b.id]) {
      expect(powodyOdmowyScalenia([a, b], { glowneId }).join()).toMatch(/S-2 ma status nieodesłany do sklepu \(„sklep nie odpowiada”\)/);
    }
  });
});
