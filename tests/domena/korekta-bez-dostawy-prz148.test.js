// PRZ-148.03 — zwrot z kosztem dostawy przy fakturze bez pozycji „Dostawa”: reguła w domenie (domena/zwrot.js),
// jedno zdanie dla usługi korekty (przez `paryKorekty`), karty zamówienia i ekranu zwrotu. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { powodOdmowyKorektyBezDostawy, zwrotWymagaPozycjiDostawy } from '../../src/domena/zwrot.js';
import { paryKorekty } from '../../src/domena/korekta-pozycje.js';

const fakturaZ = (...nazwy) => ({
  number: 'FV 3/11/2026', invoice_date: '2026-11-02',
  services: nazwy.map((name) => ({ name, quantity: 1, gross_price: 1900, tax_symbol: '23' })),
});
const zwrotZDostawa = { id: 5, data: '2026-11-03', kwota: '0.00', kwota_dostawy: '19.00', pozycje: [] };
const SUBIEKT = { mianownik: 'Fakturownik Półcień', dopelniacz: 'Fakturownika Półcień', miejscownik: 'Fakturowniku Półcień' };

describe('powodOdmowyKorektyBezDostawy', () => {
  it('odmawia zdaniem po polsku, gdy zwrot ma dostawę, a faktura nie ma pozycji „Dostawa”', () => {
    const zdanie = powodOdmowyKorektyBezDostawy(zwrotZDostawa, fakturaZ('Lampa Półcień', 'Wysyłka'));
    expect(zdanie).toBe('Zwrot obejmuje 19.00 zł dostawy, a faktura FV 3/11/2026 nie ma pozycji „Dostawa"'
      + ' — korekty nie da się złożyć. Wystaw ją ręcznie w inFakcie.');
  });

  it('nazwa programu w zdaniu z odmiany', () => {
    expect(powodOdmowyKorektyBezDostawy(zwrotZDostawa, fakturaZ('Wysyłka'), { nazwa: SUBIEKT }))
      .toMatch(/Wystaw ją ręcznie w Fakturowniku Półcień\.$/u);
  });

  it('nie odmawia, gdy faktura ma pozycję „Dostawa”', () => {
    expect(powodOdmowyKorektyBezDostawy(zwrotZDostawa, fakturaZ('Lampa Półcień', 'Dostawa'))).toBeNull();
  });

  it('nie odmawia zwrotowi bez dostawy (puste albo zero)', () => {
    const f = fakturaZ('Lampa Półcień');
    expect(powodOdmowyKorektyBezDostawy({ ...zwrotZDostawa, kwota_dostawy: null }, f)).toBeNull();
    expect(powodOdmowyKorektyBezDostawy({ ...zwrotZDostawa, kwota_dostawy: '0.00' }, f)).toBeNull();
  });

  it('nie zgaduje, gdy pozycji faktury nie znamy (brak dokumentu albo listy pozycji)', () => {
    expect(powodOdmowyKorektyBezDostawy(zwrotZDostawa, null)).toBeNull();
    expect(powodOdmowyKorektyBezDostawy(zwrotZDostawa, { number: 'FV 3/11/2026' })).toBeNull();
  });

  it('paryKorekty oddaje TO SAMO zdanie (jedna reguła, nie dwie kopie)', () => {
    const f = fakturaZ('Lampa Półcień', 'Wysyłka');
    expect(paryKorekty(f, zwrotZDostawa, { nazwaProgramu: SUBIEKT }).blad)
      .toBe(powodOdmowyKorektyBezDostawy(zwrotZDostawa, f, { nazwa: SUBIEKT }));
  });
});

describe('zwrotWymagaPozycjiDostawy', () => {
  it('tylko zwrot z dostawą, bez korekty i bez zlecenia', () => {
    expect(zwrotWymagaPozycjiDostawy(zwrotZDostawa)).toBe(true);
    expect(zwrotWymagaPozycjiDostawy({ ...zwrotZDostawa, kwota_dostawy: null })).toBe(false);
    expect(zwrotWymagaPozycjiDostawy({ ...zwrotZDostawa, kwota_dostawy: '0.00' })).toBe(false);
    expect(zwrotWymagaPozycjiDostawy({ ...zwrotZDostawa, korekta_numer: 'KOR 1/11/2026' })).toBe(false);
    expect(zwrotWymagaPozycjiDostawy({ ...zwrotZDostawa, korekta_zlecona_at: '2026-11-03T10:00:00Z' })).toBe(false);
  });
});

describe('PRZ-148.03 odbiór: paryKorekty przy fakturze bez listy pozycji', () => {
  it("zwrot z dostawą i faktura bez services → odmowa jak przed przeniesieniem reguły", () => {

    const wynik = paryKorekty({ number: 'FV 7/11/2026' }, { kwota_dostawy: '19.00', pozycje: [] });
    expect(wynik.services).toBeNull();
    expect(wynik.blad).toBeTruthy();
  });
});

// Recenzja PRZ-148.03: zawieszony program fakturowy nie trzyma karty ani ekranu zwrotu do limitu klienta (60 s).
import { podgladFakturyZTerminem } from '../../src/domena/dokument-programu.js';
describe('podgląd faktury z terminem', () => {
  it('program nie odpowiada → null po terminie, nie czeka dalej', async () => {
    const start = Date.now();
    const wynik = await podgladFakturyZTerminem({ pobierzFakture: () => new Promise(() => {}) }, 'uuid-1', 50);
    expect(wynik).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it('błąd programu → null; odpowiedź w terminie → dokument', async () => {
    expect(await podgladFakturyZTerminem({ pobierzFakture: () => { throw new Error('401'); } }, 'x', 50)).toBeNull();
    const f = fakturaZ('Dostawa');
    expect(await podgladFakturyZTerminem({ pobierzFakture: async () => f }, 'x', 50)).toBe(f);
  });
  it('reguła nie liczy kwoty dostawy, gdy pozycji faktury nie znamy', () => {
    expect(powodOdmowyKorektyBezDostawy({ ...zwrotZDostawa, kwota_dostawy: 'abc' }, null)).toBeNull();
  });
});
