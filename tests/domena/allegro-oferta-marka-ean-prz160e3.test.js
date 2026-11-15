import { describe, expect, it } from 'vitest';
import { ofertaAllegroZKarty } from '../../src/domena/allegro-oferta-z-karty.js';

// Celowo inne identyfikatory niż w P9: rozpoznajemy nazwy opisu kategorii v2.
const MARKA = 'demo-marka';
const EAN = 'demo-ean';
const KAT = '257';
function wejscie(zmiany = {}) {
  return {
    znakInstalacji: 'DEMO', konto: { klucz: 'allegro-demo' },
    karta: { id: 1, nazwa: 'Lampa demo', marka: 'Pracownia Półcień', ean: '5901234123457', cena_gr: 5900,
      stawka_vat: '23', kategoria_glowna: 'Lampy', ...zmiany },
    katalog: { brak: true }, reguly: [],
    mapaKategorii: [{ kategoriaKarty: 'Lampy', kategoriaAllegroId: KAT }],
    opisyKategorii: { [KAT]: { wersja: 2, lisc: true, tworzenieProduktu: true,
      sciezka: [{ id: KAT, nazwa: 'Lampy' }], parametry: [
        { id: MARKA, nazwa: 'Marka', opisujeProdukt: true, wymagany: false, wymaganyDlaProduktu: true },
        { id: EAN, nazwa: 'EAN (GTIN)', opisujeProdukt: true, wymagany: false, wymaganyDlaProduktu: false },
      ] } },
    marki: [{ marka: 'Pracownia Półcień', wartoscId: 'demo-marka-1', kategorieSprawdzone: [KAT] }],
    producenciMarek: [{ marka: 'Pracownia Półcień', zrodlo: 'konto' }],
    zdjecia: [{ id: 1, adres_zrodlowy: 'https://a.allegroimg.com/original/demo/lampa', ai_reczne: 0 }],
    ustawienia: { stawkaVat: '23', narzutBp: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'dostawy-demo',
      zwrotyId: 'zwroty-demo', reklamacjeId: 'reklamacje-demo', producentId: 'producent-demo',
      bezpieczenstwoDomyslne: 'Nie zostawiaj włączonej lampy bez nadzoru.' },
  };
}
const parametry = w => w.zadanie.productSet[0].product.parameters;

describe('E3.21/22 — marka i EAN nowego produktu', () => {
  it('bez reguł bierze markę przez mapę marek i EAN z karty', () => {
    const w = ofertaAllegroZKarty(wejscie());
    expect(w.droga).toBe('nowy');
    expect(w.bledy).toEqual([]);
    expect(parametry(w)).toEqual([
      { id: MARKA, valuesIds: ['demo-marka-1'] }, { id: EAN, values: ['5901234123457'] },
    ]);
  });

  it('jawne reguły pól nadal dostarczają markę i EAN', () => {
    const dane = wejscie();
    dane.reguly = [
      { kategoriaAllegroId: KAT, parametrId: MARKA, rodzaj: 'pole', pole: 'marka' },
      { kategoriaAllegroId: KAT, parametrId: EAN, rodzaj: 'pole', pole: 'ean' },
    ];
    expect(parametry(ofertaAllegroZKarty(dane))).toEqual([
      { id: MARKA, valuesIds: ['demo-marka-1'] }, { id: EAN, values: ['5901234123457'] },
    ]);
  });

  it('stałe reguły wygrywają z polami karty', () => {
    const dane = wejscie();
    dane.reguly = [
      { kategoriaAllegroId: KAT, parametrId: MARKA, rodzaj: 'stala', wartosc: { valuesIds: ['inna-marka'] } },
      { kategoriaAllegroId: KAT, parametrId: EAN, rodzaj: 'stala', wartosc: { values: ['5900000000008'] } },
    ];
    expect(parametry(ofertaAllegroZKarty(dane))).toEqual([
      { id: MARKA, valuesIds: ['inna-marka'] }, { id: EAN, values: ['5900000000008'] },
    ]);
  });

  it('pusta jawna reguła nie uruchamia domyślnego odczytu karty', () => {
    const dane = wejscie();
    dane.reguly = [{ kategoriaAllegroId: KAT, parametrId: MARKA, rodzaj: 'na_karcie' }];
    const w = ofertaAllegroZKarty(dane);
    expect(w.zadanie).toBeNull();
    expect(w.bledy.some(b => b.tekst.includes('Marka'))).toBe(true);
  });

  it('brak wymaganej marki bez reguły blokuje zadanie i podaje kategorię oraz sposób naprawy', () => {
    const w = ofertaAllegroZKarty(wejscie({ marka: null, ean: null }));
    expect(w.zadanie).toBeNull();
    expect(w.bledy).toContainEqual(expect.objectContaining({
      tekst: 'Kategoria „Lampy” wymaga parametru „Marka” dla nowego produktu — uzupełnij markę na karcie albo przypisz regułę w Magazyn → Kategorie Allegro.',
    }));
  });

  it('marka na karcie wystarcza bez EAN, jeśli EAN nie jest wymagany', () => {
    const w = ofertaAllegroZKarty(wejscie({ ean: null }));
    expect(w.bledy).toEqual([]);
    expect(parametry(w)).toEqual([{ id: MARKA, valuesIds: ['demo-marka-1'] }]);
  });

  it('wymagany EAN bez reguły blokuje zadanie z polskim powodem', () => {
    const dane = wejscie({ ean: '  ' });
    dane.opisyKategorii[KAT].parametry[1].wymaganyDlaProduktu = true;
    const w = ofertaAllegroZKarty(dane);
    expect(w.zadanie).toBeNull();
    expect(w.bledy).toContainEqual(expect.objectContaining({ kod: 'gtin',
      tekst: expect.stringMatching(/Kategoria „Lampy”.*„EAN \(GTIN\)”.*nowego produktu.*EAN na karcie.*regułę/),
    }));
  });

  it('domyślna marka wymaga sprawdzonej mapy marek', () => {
    const dane = wejscie();
    dane.marki[0].kategorieSprawdzone = [];
    expect(ofertaAllegroZKarty(dane).bledy).toContainEqual(expect.objectContaining({ kod: 'marka-kategoria' }));
    dane.marki = [];
    expect(ofertaAllegroZKarty(dane).bledy).toContainEqual(expect.objectContaining({ kod: 'marka' }));
  });

  it('opcjonalna Marka bez reguły: marka spoza mapy nie blokuje, parametr nie idzie', () => {
    const dane = wejscie();
    dane.opisyKategorii[KAT].parametry[0].wymaganyDlaProduktu = false;
    dane.marki = [];
    const w = ofertaAllegroZKarty(dane);
    expect(w.bledy).toEqual([]);
    expect(parametry(w)).toEqual([{ id: EAN, values: ['5901234123457'] }]);
  });

  it('takie same nazwy parametrów oferty nie pobierają pól produktu', () => {
    const dane = wejscie();
    dane.opisyKategorii[KAT].parametry.forEach(p => { p.opisujeProdukt = false; p.wymaganyDlaProduktu = false; });
    const w = ofertaAllegroZKarty(dane);
    expect(w.bledy).toEqual([]);
    expect(parametry(w)).toEqual([]);
    expect(w.zadanie.parameters).toEqual([{ id: '11323', valuesIds: ['11323_1'] }]);
  });
});

it('E3.21 — rzeczywisty podgląd pokazuje powód braku marki jako odmowę', async () => {
  const { openOmsDb } = await import('../../src/oms/db/db.ts');
  const { buildOmsServer } = await import('../pomoc/serwer-parytetu.ts');
  const { definicjeKanalowHistoryczne } = await import('../pomoc/kanaly-historyczne-fixture.js');
  const { utworzKarte } = await import('../../src/oms/db/magazyn.js');
  const { zapiszUstawieniaOfertKonta, ofertyKarty } = await import('../../src/oms/db/oferty-kanalow.ts');
  const db = openOmsDb(':memory:');
  const konto = 'allegro_swietlik'; // klucz historycznej atrapy testowej
  const dane = wejscie({ marka: null, ean: null });
  const app = buildOmsServer({ db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': { [konto]: {} }, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => typ === 'allegro' ? [{ klucz: konto, nazwa: 'Demo', autoryzacja: 'polaczone', srodowisko: 'produkcja' }] : [],
      zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  try {
    await app.ready();
    const scope = ['allegro:api:orders:read', 'allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
    const token = `e30.${Buffer.from(JSON.stringify({ scope })).toString('base64url')}.atrapa`;
    db.prepare(`INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
      VALUES (?, ?, 'ATRAPA', '2099-01-01', '2099-01-01', '2026-11-14')`).run(konto, token);
    const { narzutBp, ...ustawienia } = dane.ustawienia;
    zapiszUstawieniaOfertKonta(db, konto, { ...ustawienia, narzutProcent: narzutBp / 100 });
    db.prepare(`INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id)
      VALUES ('Lampy', 'produkcja', ?)`).run(KAT);
    const opis = dane.opisyKategorii[KAT];
    db.prepare(`INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at)
      VALUES (?, ?, ?, ?, '2026-11-14')`).run(konto, KAT, JSON.stringify(opis.sciezka), JSON.stringify(opis));
    const id = utworzKarte(db, dane.karta);
    const r = await app.inject({ method: 'POST', url: '/magazyn/oferty/podglad',
      payload: { konto, zaznaczone: [id] }, headers: { origin: 'http://localhost',
        authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Odmowa:');
    expect(r.body).toContain('Kategoria „Lampy” wymaga parametru „Marka” dla nowego produktu');
    expect(r.body).toContain('uzupełnij markę na karcie albo przypisz regułę w Magazyn → Kategorie Allegro.');
    expect(ofertyKarty(db, id)).toEqual([]);
  } finally {
    await app.close();
    db.close();
  }
});
