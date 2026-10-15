import { describe, it, expect } from 'vitest';
import { kanalHistoryczny, kanalOms } from '../../src/domena/kanaly-raportowe.js';
import { klasyfikacjaHistorycznaFixture, envRaportowHistorycznyFixture } from '../pomoc/raporty-historyczne-fixture.js';

import { wczytajKlasyfikacje } from '../../src/moduly/kanaly/klasyfikacja.ts';
import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
const h = (w) => kanalHistoryczny({ tagi_json: '[]', pozycje: [], ...w }, klasyfikacjaHistorycznaFixture);

describe('kanaly historyczne (Apilo)', () => {
  it('dropshipping rozstrzyga TAG, nie konto — ten sam klient zamawia w dwoch rolach', () => {
    expect(h({ platform_account_id: 21, tagi_json: '[6]' })).toBe('DROPSHIPPING');
    expect(h({ platform_account_id: 12, tagi_json: '[6,3]' })).toBe('DROPSHIPPING');
  });

  it('GDD stoi przed B2B i przed regulami kontowymi — fundacja zamawia z konta 21', () => {
    expect(h({ platform_account_id: 21, tagi_json: '[9]' })).toBe('GDD');
    expect(h({ platform_account_id: 21, tagi_json: '[9,3]' })).toBe('GDD');
  });

  it('B2B to konto 12 ALBO tag 3 — historia B2B siedzi na koncie 21', () => {
    expect(h({ platform_account_id: 12 })).toBe('B2B');
    expect(h({ platform_account_id: 21, tagi_json: '[3]' })).toBe('B2B');
  });

  it('⚠️ KONTO 21 BEZ TAGU TO `RECZNE`, NIE `INDYWIDUALNE` — pomiar 13.08.2026', () => {
    // Konto 21 (602 zam., 196 654 zl, 54% obrotu) migruje w OMS-ie do `sklep='reczne'`,
    // a NIE do `indywidualne=1`. Pierwotna mapa sklejala je z zamowieniami z panelu ofert
    // i przez to ten sam pieniadz zmienial kanal na granicy: dziura 10 440,14 zl albo
    // zakladka 3 175,80 zl, zaleznie od wybranej daty. Zadna nie byla poprawna.
    expect(h({ platform_account_id: 21 })).toBe('RECZNE');
  });

  it('zamowienie z panelu ofert poznaje sie po pozycji 28040, nie po koncie', () => {
    expect(h({ platform_account_id: 9, pozycje: [{ original_code: '28040|1' }] }))
      .toBe('INDYWIDUALNE');
    expect(h({ platform_account_id: 9, pozycje: [{ original_code: '123|1' }] }))
      .toBe('SZKICOWNIA_PL');
  });

  it('konta sklepowe, allegrowe i archiwalne', () => {
    expect(h({ platform_account_id: 3 })).toBe('ALLEGRO_SZKICOWNIA');
    expect(h({ platform_account_id: 27 })).toBe('ALLEGRO_AMARKA');
    expect(h({ platform_account_id: 24 })).toBe('PRESTASHOP_ARCHIWUM');
    expect(h({ platform_account_id: 15 })).toBe('WOO_AMARKA');
    expect(h({ platform_account_id: 6 })).toBe('ETSY_ARCHIWUM');
  });

  it('NIEZNANE konto PRZERYWA, a nie wpada do worka', () => {
    expect(() => h({ platform_account_id: 99 })).toThrow(/nieznane konto Apilo: 99/);
  });
});

describe('kanaly OMS', () => {
  it('znacznik indywidualnego wygrywa ze sklepem — oba maja sklep=szkicownia', () => {
    expect(kanalOms({ sklep: 'szkicownia', indywidualne: 1 }, klasyfikacjaHistorycznaFixture)).toBe('INDYWIDUALNE');
    expect(kanalOms({ sklep: 'szkicownia', indywidualne: 0 }, klasyfikacjaHistorycznaFixture)).toBe('SZKICOWNIA_PL');
  });

  it('reczne dzieli okres rozliczeniowy — bez okresu to RECZNE, nie B2B', () => {
    expect(kanalOms({ sklep: 'reczne', okres_rozliczeniowy_id: 7 }, klasyfikacjaHistorycznaFixture)).toBe('DROPSHIPPING');
    // ⚠️ Odpowiednik konta 21 z historii. OMS nie ma dzis czym oznaczyc hurtu, wiec kanal
    // B2B po granicy jest PUSTY — i to jest prawda o danych, a nie usterka do zalatania.
    expect(kanalOms({ sklep: 'reczne', okres_rozliczeniowy_id: null }, klasyfikacjaHistorycznaFixture)).toBe('RECZNE');
  });

  it('sklepy kanalowe', () => {
    expect(kanalOms({ sklep: 'pro' }, klasyfikacjaHistorycznaFixture)).toBe('SZKICOWNIA_PRO');
    expect(kanalOms({ sklep: 'allegro_szkicownia' }, klasyfikacjaHistorycznaFixture)).toBe('ALLEGRO_SZKICOWNIA');
    expect(kanalOms({ sklep: 'allegro_amarka' }, klasyfikacjaHistorycznaFixture)).toBe('ALLEGRO_AMARKA');
  });

  it('NIEZNANY sklep PRZERYWA', () => {
    expect(() => kanalOms({ sklep: 'etsy' }, klasyfikacjaHistorycznaFixture)).toThrow(/nieznany sklep OMS: etsy/);
  });

  it('kazdy zwracany kanal jest na liscie KANALY', () => {
    const kanalyProduktu = [...wczytajKlasyfikacje(envRaportowHistorycznyFixture, definicjeKanalowHistoryczne).raporty];
    expect(kanalyProduktu).toContain(kanalOms({ sklep: 'pro' }, klasyfikacjaHistorycznaFixture));
    expect(kanalyProduktu).toContain(h({ platform_account_id: 24 }));
  });
});
