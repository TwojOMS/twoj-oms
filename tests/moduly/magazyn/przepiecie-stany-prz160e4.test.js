// PRZ-160 E4.14 (D59) — przepięcie oferty z karty na kartę: rejestr `oferty_kanalow` idzie razem z lustrem, przy
// włączonych stanach podgląd „stan karty A: 7 → 4, B: 2 → 5” przed zapisem i ślad w `stany_przepiecia` widoczny
// w historii obu kart; odpięcie oferty z flagą ilości z OMS zdejmuje flagę i zgłasza `brak-karty`; przy wyłączonych
// stanach — bez podglądu i bez śladu, ale rejestr i tak przeniesiony. Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  zapiszProduktSklepowy, utworzKarte, powiazProdukt, powiazOfertyHurtem, odepnijOferte, podgladPrzepiec,
} from '../../../src/oms/db/magazyn.js';
import { przelaczStany, dodajRuch, stanKarty, historiaKarty } from '../../../src/oms/db/stany-magazynowe.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wstawOferte } from '../../../src/oms/db/oferty-kanalow.ts';

const ALLEGRO = 'allegro_polcien';
const WOO = 'sklep_polcien';
const WLACZONE_AT = '2026-11-14T08:00:00.000Z';
const PO = '2026-11-14T09:00:00.000Z';
const konto = { id: 1, login: 'operator' };

let db;
let kartaA;
let kartaB;
let numer = 0;
let kl = 0;

beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  numer = 0;
  kartaA = utworzKarte(db, { nazwa: 'Lampa Półcień A', sku: 'LMP-PA-01' });
  kartaB = utworzKarte(db, { nazwa: 'Lampa Półcień B', sku: 'LMP-PB-02' });
});

const lustro = (kanal, produktId, wariantId, kartaId) => {
  const id = zapiszProduktSklepowy(db, { kanal, produkt_id: produktId, wariant_id: wariantId, nazwa: `Oferta ${produktId}`,
    odczytane_at: WLACZONE_AT });
  if (kartaId) powiazProdukt(db, id, kartaId);
  return id;
};
const rejestr = (kanal, idZewnetrzne, kartaId, pochodzenie = 'przejeta') =>
  wstawOferte(db, { kartaId, kanal, idZewnetrzne, pochodzenie }, { teraz: WLACZONE_AT });
const kartaWRejestrze = (kanal, idZewnetrzne) => Number(db.prepare(
  'SELECT karta_id FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?').get(kanal, idZewnetrzne).karta_id);
const wierszRejestru = (kanal, idZewnetrzne) => db.prepare(
  'SELECT karta_id, ilosc_z_oms, ilosc_problem_json FROM oferty_kanalow WHERE kanal = ? AND id_zewnetrzne = ?').get(kanal, idZewnetrzne);
const slady = () => db.prepare('SELECT * FROM stany_przepiecia ORDER BY id').all();
const wlacz = () => przelaczStany(db, { wlacz: true, konto, at: WLACZONE_AT });
const przyjmij = (kartaId, ilosc) => dodajRuch(db, { kartaId, rodzaj: 'przyjecie', ilosc, klucz: `e414-klucz-${++kl}-xxxxxx`, at: PO });
const sprzedaj = (sklep, ofertaId, ilosc) => {
  numer += 1;
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: String(numer), numer: `PC-${numer}`, klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00', status_woo: null,
    oplacone_at: null, anulowane: 0, utworzone_at: PO,
    pozycje: [{ nazwa: 'Lampa', sku: null, cena_brutto: '50.00', vat: '23', zdjecie_url: null, zrodlo_id: 1000 + numer,
      produkt_id: null, oferta_id: ofertaId, wariant_id: null, ilosc }],
  }, {});
};
const stan = (id) => stanKarty(db, id)?.stan;

describe('przepięcie przenosi kartę w rejestrze (D59)', () => {
  it('przejęta oferta Allegro A→B przez odpięcie i powiązanie z ekranu → wiersz rejestru ma B', () => {
    const oferta = lustro(ALLEGRO, '7700000001', '', kartaA);
    rejestr(ALLEGRO, '7700000001', kartaA);
    rejestr(ALLEGRO, '7700000002', kartaA);

    expect(odepnijOferte(db, oferta, [ALLEGRO])).toBe(true);
    expect(powiazOfertyHurtem(db, [{ produktId: oferta, kartaId: kartaB }], [ALLEGRO]).powiazane).toEqual([oferta]);

    expect(kartaWRejestrze(ALLEGRO, '7700000001')).toBe(kartaB);
    expect(kartaWRejestrze(ALLEGRO, '7700000002')).toBe(kartaA);
  });

  it('przepięcie wprost (powiazProdukt) przenosi tylko ofertę przejętą, nie wystawioną z OMS', () => {
    const oferta = lustro(ALLEGRO, '7700000003', '', kartaA);
    rejestr(ALLEGRO, '7700000003', kartaA);
    const zOms = lustro(ALLEGRO, '7700000004', '', kartaA);
    rejestr(ALLEGRO, '7700000004', kartaA, 'oms');

    powiazProdukt(db, oferta, kartaB);
    powiazProdukt(db, zOms, kartaB);

    expect(kartaWRejestrze(ALLEGRO, '7700000003')).toBe(kartaB);
    expect(kartaWRejestrze(ALLEGRO, '7700000004')).toBe(kartaA);
  });

  it('odpięcie, potem powiązanie z B: flaga ilości z OMS wraca, problem brak-karty znika', () => {
    const oferta = lustro(ALLEGRO, '7700000005', '', kartaA);
    rejestr(ALLEGRO, '7700000005', kartaA);
    db.prepare('UPDATE oferty_kanalow SET ilosc_z_oms = 1 WHERE id_zewnetrzne = ?').run('7700000005');

    odepnijOferte(db, oferta, [ALLEGRO]);
    expect(JSON.parse(wierszRejestru(ALLEGRO, '7700000005').ilosc_problem_json).kod).toBe('brak-karty');
    powiazOfertyHurtem(db, [{ produktId: oferta, kartaId: kartaB }], [ALLEGRO]);

    expect(wierszRejestru(ALLEGRO, '7700000005')).toMatchObject({ karta_id: kartaB, ilosc_z_oms: 1, ilosc_problem_json: null });
  });

  it('wariant Woo 12/34 → B; inny wariant i rodzic zostają na A', () => {
    const wariant = lustro(WOO, '12', '34', kartaA);
    lustro(WOO, '12', '35', kartaA);
    rejestr(WOO, '12/34', kartaA);
    rejestr(WOO, '12/35', kartaA);
    rejestr(WOO, '12', kartaA);

    powiazProdukt(db, wariant, kartaB);

    expect(kartaWRejestrze(WOO, '12/34')).toBe(kartaB);
    expect(kartaWRejestrze(WOO, '12/35')).toBe(kartaA);
    expect(kartaWRejestrze(WOO, '12')).toBe(kartaA);
  });

  it('odpięcie oferty z flagą ilości z OMS → flaga 0 i problem brak-karty; bez flagi bez problemu', () => {
    const zFlaga = lustro(ALLEGRO, '7700000004', '', kartaA);
    const bezFlagi = lustro(ALLEGRO, '7700000005', '', kartaA);
    rejestr(ALLEGRO, '7700000004', kartaA);
    rejestr(ALLEGRO, '7700000005', kartaA);
    db.prepare("UPDATE oferty_kanalow SET ilosc_z_oms = 1 WHERE id_zewnetrzne = '7700000004'").run();

    expect(odepnijOferte(db, zFlaga, [ALLEGRO])).toBe(true);
    expect(odepnijOferte(db, bezFlagi, [ALLEGRO])).toBe(true);

    const w = wierszRejestru(ALLEGRO, '7700000004');
    expect(w.ilosc_z_oms).toBe(0);
    expect(JSON.parse(w.ilosc_problem_json)).toMatchObject({ kod: 'brak-karty', wstrzymuje: true });
    expect(wierszRejestru(ALLEGRO, '7700000005').ilosc_problem_json).toBe(null);
    // NOT NULL w rejestrze: karta zostaje, ale bez flagi pętle nie wyślą jej stanu.
    expect(w.karta_id).toBe(kartaA);
  });
});

describe('podgląd i ślad przy włączonych stanach (D59)', () => {
  // A: 7 przyjęte. B: 5 przyjęte, oferta na B sprzedała 3 → B = 2. Oferta przechodzi z B na A.
  function przygotuj() {
    wlacz();
    przyjmij(kartaA, 7);
    przyjmij(kartaB, 5);
    const oferta = lustro(ALLEGRO, '7700000010', '', kartaB);
    rejestr(ALLEGRO, '7700000010', kartaB);
    sprzedaj(ALLEGRO, '7700000010', 3);
    expect([stan(kartaA), stan(kartaB)]).toEqual([7, 2]);
    return oferta;
  }

  it('podgląd: A 7 → 4, B 2 → 5, granica w odpowiedzi — i niczego nie zapisuje', () => {
    const oferta = przygotuj();
    const p = podgladPrzepiec(db, [{ produktSklepowyId: oferta, naKarte: kartaA }]);

    expect(p.granica).toBe(WLACZONE_AT);
    expect(p.karty.map(({ kartaId, przed, po }) => ({ kartaId, przed, po })).sort((x, y) => x.kartaId - y.kartaId))
      .toEqual([{ kartaId: kartaA, przed: 7, po: 4 }, { kartaId: kartaB, przed: 2, po: 5 }].sort((x, y) => x.kartaId - y.kartaId));
    expect(p.karty.find((k) => k.kartaId === kartaA).nazwa).toBe('Lampa Półcień A');
    expect([stan(kartaA), stan(kartaB)]).toEqual([7, 2]);
    expect(kartaWRejestrze(ALLEGRO, '7700000010')).toBe(kartaB);
    expect(slady()).toEqual([]);
  });

  it('zapis: stany jak w podglądzie, ślad z ilością wstecz i kontem, wpis w historii obu kart', () => {
    const oferta = przygotuj();
    powiazProdukt(db, oferta, kartaA, { konto });

    expect([stan(kartaA), stan(kartaB)]).toEqual([4, 5]);
    expect(kartaWRejestrze(ALLEGRO, '7700000010')).toBe(kartaA);
    expect(slady()).toEqual([expect.objectContaining({ kanal: ALLEGRO, produkt_id: '7700000010', wariant_id: null,
      z_karty: kartaB, na_karte: kartaA, ilosc_wstecz: 3, konto_login: 'operator' })]);
    for (const id of [kartaA, kartaB]) {
      const wpis = historiaKarty(db, id).find((w) => w.typ === 'przepiecie');
      expect(wpis).toMatchObject({ ilosc: 0, ilosc_wstecz: 3, konto_login: 'operator', kanal: ALLEGRO, produkt_id: '7700000010' });
      expect(wpis.powod).toContain('3 szt.');
    }
    // Historia dalej sumuje się do stanu: wpis przepięcia jest opisem, nie drugim rozchodem.
    for (const [id, s] of [[kartaA, 4], [kartaB, 5]]) {
      expect(historiaKarty(db, id).reduce((suma, w) => suma + w.ilosc, 0)).toBe(s);
    }
  });

  it('przepięcie z ekranu (odepnij, potem powiąż) zostawia dwa ślady: B → brak i brak → A', () => {
    const oferta = przygotuj();
    odepnijOferte(db, oferta, [ALLEGRO], { konto });
    powiazOfertyHurtem(db, [{ produktId: oferta, kartaId: kartaA }], [ALLEGRO], { konto });

    expect(slady().map(({ z_karty, na_karte, ilosc_wstecz }) => ({ z_karty, na_karte, ilosc_wstecz })))
      .toEqual([{ z_karty: kartaB, na_karte: null, ilosc_wstecz: 3 }, { z_karty: null, na_karte: kartaA, ilosc_wstecz: 3 }]);
    expect([stan(kartaA), stan(kartaB)]).toEqual([4, 5]);
  });

  it('powiązanie oferty bez sprzedaży od granicy nie zostawia śladu', () => {
    wlacz();
    const oferta = lustro(ALLEGRO, '7700000011', '', null);
    powiazOfertyHurtem(db, [{ produktId: oferta, kartaId: kartaA }], [ALLEGRO]);
    expect(slady()).toEqual([]);
  });
});

describe('stany wyłączone (D14)', () => {
  it('bez podglądu i bez śladu, a rejestr i tak przeniesiony', () => {
    const oferta = lustro(ALLEGRO, '7700000020', '', kartaA);
    rejestr(ALLEGRO, '7700000020', kartaA);
    sprzedaj(ALLEGRO, '7700000020', 2);

    expect(podgladPrzepiec(db, [{ produktSklepowyId: oferta, naKarte: kartaB }])).toBe(null);
    powiazProdukt(db, oferta, kartaB, { konto });

    expect(kartaWRejestrze(ALLEGRO, '7700000020')).toBe(kartaB);
    expect(slady()).toEqual([]);
  });
});

describe('ekran Magazyn → Powiązania: podgląd przed zapisem', () => {
  const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
  const serwer = () => buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: { gotowy: () => true, stan: () => ({ trwa: false, kanaly: [] }) } });
  const post = (app, url, payload) => app.inject({ method: 'POST', url, headers: auth, payload });
  const karta = (id) => db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(id).karta_id;
  // Kanał Allegro z konfiguracji serwera testowego (`tests/pomoc/serwer-parytetu.ts`) — ekran rusza tylko te kanały.
  const kanalAllegro = () => 'allegro_polcien2';

  it('stany włączone: pierwszy POST pokazuje „7 → 4” i nie wiąże; potwierdzenie wiąże', async () => {
    wlacz();
    przyjmij(kartaA, 7);
    const kanal = kanalAllegro();
    const oferta = lustro(kanal, '7700000030', '', null);
    sprzedaj(kanal, '7700000030', 3);
    const app = serwer();

    const r1 = await post(app, '/magazyn/powiazania', { [`karta_${oferta}`]: String(kartaA) });
    expect(r1.statusCode).toBe(200);
    expect(r1.body).toContain('id="podglad-przepiecia"');
    expect(r1.body).toMatch(/Lampa Półcień A[\s\S]*7[\s\S]*→[\s\S]*4/u);
    expect(r1.body).toContain('name="potwierdz" value="1"');
    expect(karta(oferta)).toBe(null);

    const r2 = await post(app, '/magazyn/powiazania', { [`karta_${oferta}`]: String(kartaA), potwierdz: '1' });
    expect(r2.statusCode).toBe(200);
    expect(r2.body).not.toContain('id="podglad-przepiecia"');
    expect(karta(oferta)).toBe(kartaA);
    expect(stan(kartaA)).toBe(4);
    await app.close();
  });

  it('odpięcie przy włączonych stanach: podgląd „4 → 7”, potwierdzenie odpina, karta pokazuje ślad', async () => {
    wlacz();
    przyjmij(kartaA, 7);
    const kanal = kanalAllegro();
    const oferta = lustro(kanal, '7700000032', '', kartaA);
    sprzedaj(kanal, '7700000032', 3);
    const app = serwer();

    const r1 = await post(app, '/magazyn/powiazania/odepnij', { id: String(oferta) });
    expect(r1.body).toContain('id="podglad-przepiecia"');
    expect(r1.body).toMatch(/Lampa Półcień A[\s\S]*4[\s\S]*→[\s\S]*7/u);
    expect(karta(oferta)).toBe(kartaA);

    const r2 = await post(app, '/magazyn/powiazania/odepnij', { id: String(oferta), potwierdz: '1' });
    expect(r2.body).not.toContain('id="podglad-przepiecia"');
    expect(karta(oferta)).toBe(null);
    expect(stan(kartaA)).toBe(7);
    const k = await app.inject({ method: 'GET', url: `/magazyn/${kartaA}`, headers: auth });
    expect(k.body).toContain('przepięcie oferty');
    await app.close();
  });

  it('stany wyłączone: POST wiąże od razu, bez podglądu', async () => {
    const kanal = kanalAllegro();
    const oferta = lustro(kanal, '7700000031', '', null);
    sprzedaj(kanal, '7700000031', 3);
    const app = serwer();
    const r = await post(app, '/magazyn/powiazania', { [`karta_${oferta}`]: String(kartaA) });
    expect(r.body).not.toContain('id="podglad-przepiecia"');
    expect(karta(oferta)).toBe(kartaA);
    await app.close();
  });
});
