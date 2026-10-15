import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { ustawGranice } from '../../../src/oms/db/historia-sprzedazy.js';
import { kanalOms } from '../../../src/domena/kanaly-raportowe.js';
import { KANALY, klasyfikacjaHistorycznaFixture } from '../../pomoc/raporty-historyczne-fixture.js';
import { sprzedazWOkresie } from '../../pomoc/raporty-parytetu.js';

// KANAL B2B PO GRANICY Z APILO (21.08.2026).
//
// Do tego dnia kanal `B2B` istnial na liscie i byl PUSTY: w Apilo rozstrzygal tag, ktorego
// panel nie nadaje. Znacznik `zamowienia.b2b` podstawia sie z bazy stalych klientow przy
// zakladaniu i od tej chwili rozstrzyga ZAMOWIENIE.

let db;
let licznik = 0;

beforeEach(() => {
  db = openOmsDb(':memory:');
  for (const k of KANALY) ustawGranice(db, k, '2026-07-02', 'test', null);
});

const zamowienie = ({ b2b = 0, sklep = 'reczne', okres = null, kwota = '1000.00' } = {}) => {
  licznik += 1;
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, indywidualne,'
    + ' b2b, okres_rozliczeniowy_id) VALUES (?,?,?,?,?,0,?,?)',
  ).run(sklep, licznik, `B${licznik}`, kwota, '2026-08-21T09:00:00.000Z', b2b, okres);
};

const kanaly = () => sprzedazWOkresie(db, { od: '2026-08-01', do: '2026-08-31' })
  .map((w) => w.kanal);

describe('reguła kanału', () => {
  it('zamówienie ręczne z B2B liczy się jako B2B', () => {
    expect(kanalOms({ sklep: 'reczne', b2b: 1 }, klasyfikacjaHistorycznaFixture)).toBe('B2B');
  });

  it('zamówienie ręczne bez B2B dalej jest RECZNE', () => {
    expect(kanalOms({ sklep: 'reczne', b2b: 0 }, klasyfikacjaHistorycznaFixture)).toBe('RECZNE');
  });

  // ⚠️⚠️ KOLEJNOSC JEST O PIENIADZE — dokladnie tak samo, jak w epoce Apilo, gdzie tag `drop`
  // wygrywal z tagiem `b2b`. Klient rozliczany zbiorczo zamawia W DWOCH ROLACH: zbiorczo do
  // klienta koncowego i hurtowo do wlasnej siedziby. Gdyby B2B wygrywalo, zamowienia zbiorcze
  // wypadlyby z DROPSHIPPINGU i saldo okresu przestaloby sie zgadzac z raportem.
  it('okres rozliczeniowy WYGRYWA z B2B', () => {
    expect(kanalOms({ sklep: 'reczne', b2b: 1, okres_rozliczeniowy_id: 7 }, klasyfikacjaHistorycznaFixture)).toBe('DROPSHIPPING');
  });

  // ⚠️ Sprzedaz przez pro.szkicownia.pl ma WLASNY kanal i to on mowi, SKAD przyszly pieniadze.
  // `B2B` w tym slowniku znaczy „sprzedaz hurtowa poza sklepem". Sklejenie ich dawaloby dwa
  // kanaly opisujace ten sam pieniadz.
  it('zamówienie ze sklepu NIGDY nie zmienia kanału przez ten znacznik', () => {
    expect(kanalOms({ sklep: 'pro', b2b: 1 }, klasyfikacjaHistorycznaFixture)).toBe('SZKICOWNIA_PRO');
    expect(kanalOms({ sklep: 'szkicownia', b2b: 1 }, klasyfikacjaHistorycznaFixture)).toBe('SZKICOWNIA_PL');
  });

  it('zamówienie indywidualne wygrywa ze wszystkim', () => {
    expect(kanalOms({ sklep: 'reczne', b2b: 1, indywidualne: 1 }, klasyfikacjaHistorycznaFixture)).toBe('INDYWIDUALNE');
  });
});

describe('kanał w PRAWDZIWYM raporcie, nie tylko w regule', () => {
  // ⚠️⚠️ TEN TEST ISTNIEJE PO TO, ZEBY ZLAPAC ZAPOMNIANY SELECT. `sprzedazWOkresie` czyta
  // zamowienia JAWNIE WYPISANA lista kolumn i wola na tym wierszu `kanalOms`. Kolumna
  // dolozona do tabeli i do reguly, ale POMINIETA w tamtym zapytaniu, przychodzi jako
  // `undefined` — regula cicho wpada do galezi zapasowej i zamowienie oznaczone jako B2B
  // liczy sie jako RECZNE. Bez ani jednego bledu, wygladajac na „raport nie widzi nowych
  // zamowien". Test reguly samej w sobie tego NIE ZOBACZY.
  it('zamówienie oznaczone jako B2B trafia do kanału B2B w raporcie', () => {
    zamowienie({ b2b: 1 });
    expect(kanaly()).toEqual(['B2B']);
  });

  it('a nieoznaczone dalej do RECZNE', () => {
    zamowienie({ b2b: 0 });
    expect(kanaly()).toEqual(['RECZNE']);
  });

  it('oba naraz rozchodzą się do dwóch kanałów', () => {
    zamowienie({ b2b: 1 });
    zamowienie({ b2b: 0 });
    expect(kanaly().sort()).toEqual(['B2B', 'RECZNE']);
  });

  // ⚠️ SUMA SPRZEDAZY SIE NIE ZMIENIA — to jest poprawienie PODZIALU, nie zmiana pieniedzy.
  // Gdyby oznaczenie B2B cokolwiek dodawalo albo gubilo, zobaczylby to dopiero raport
  // miesieczny, po fakcie.
  it('oznaczenie NIE ZMIENIA kwoty sprzedaży', () => {
    zamowienie({ b2b: 1, kwota: '1230.00' });
    const [w] = sprzedazWOkresie(db, { od: '2026-08-01', do: '2026-08-31' });
    expect(w.bruttoGrosze).toBe(123000);
    expect(w.nettoGrosze).toBe(100000);
  });
});
