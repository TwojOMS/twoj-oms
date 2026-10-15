import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { stanArchiwumSprzedazy, wierszArchiwum, zapiszWiersz } from '../../../src/moduly/faktury/db/archiwum-sprzedazy.js';
import {
  createCzuwaczArchiwumSprzedazy, POWOD_TRWA, POWOD_NIE_TA_PORA, BUDZET_ARCHIWUM_SPRZEDAZY_MS, LIMIT_KOLEJNYCH_BLEDOW,
} from '../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';

const PDF = Buffer.from('%PDF-1.4 x');
const NOC = () => new Date('2026-09-02T02:10:00Z'); // 04:10 CEST
const dok = (uuid, n = {}) => ({
  uuid, number: `${uuid}/08/2026`, invoice_date: '2026-08-05', sale_date: '2026-08-05',
  gross_price: 100, client_tax_code: '1', ksef_number: null, ...n,
});
// Atrapa inFaktu: mapa miesiac -> { faktury, korekty }; brak wpisu = puste listy.
const infaktAtrapa = (miesiace = {}, { padaj = null } = {}) => ({
  wolania: [],
  async listaFaktur(z) {
    this.wolania.push(z);
    if (padaj && z.od.startsWith(padaj)) throw new Error('inFakt 500');
    return (miesiace[z.od.slice(0, 7)]?.faktury ?? []).map((d) => ({ ...d, rodzaj: 'vat' }));
  },
  async listaKorekt(z) { return (miesiace[z.od.slice(0, 7)]?.korekty ?? []).map((d) => ({ ...d, rodzaj: 'korekta' })); },
  pobierzPdf: async () => PDF, pobierzPdfKorekty: async () => PDF,
});
const czuwacz = (db, infakt, n = {}) => createCzuwaczArchiwumSprzedazy({
  db, infakt, katalogArchiwum: mkdtempSync(join(tmpdir(), 'czuw-sprz-')), teraz: NOC, log: () => {}, ...n,
});

describe('czuwacz archiwum sprzedazy', () => {
  it('poza pora (3:30) nie robi nic; 4:10 jest pora', async () => {
    const db = openOmsDb();
    const c = czuwacz(db, infaktAtrapa({ '2026-09': { faktury: [dok('a')] } }), { teraz: () => new Date('2026-09-02T01:30:00Z') });
    expect((await c.przebieg()).powod).toBe(POWOD_NIE_TA_PORA);
    expect(wierszArchiwum(db, 'a')).toBeNull();
  });

  it('pierwszy przebieg idzie od stycznia 2026 i ustawia podloge', async () => {
    const db = openOmsDb();
    const inf = infaktAtrapa({ '2026-01': { faktury: [dok('a', { invoice_date: '2026-01-05' })] }, '2026-09': { faktury: [dok('b', { invoice_date: '2026-09-01' })] } });
    const w = await czuwacz(db, inf).przebieg();
    expect(inf.wolania.map((z) => z.od.slice(0, 7))).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(inf.wolania[0].pole).toBe('invoice_date');
    expect(w.pobranych).toBe(2);
    expect(stanArchiwumSprzedazy(db).podloga_zrobiona_at).toBe('2026-09-02T02:10:00.000Z');
    expect(stanArchiwumSprzedazy(db).ostatnie_udane_at).toBe('2026-09-02T02:10:00.000Z');
  });

  it('po podlodze przeglada tylko trzy miesiace', async () => {
    const db = openOmsDb(); const inf = infaktAtrapa();
    const c = czuwacz(db, inf);
    await c.przebieg(); inf.wolania.length = 0;
    await c.przebieg({ wymuszony: true });
    expect(inf.wolania.map((z) => z.od.slice(0, 7))).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('dokument znany z bazy, nieobecny na PELNEJ liscie miesiaca = skasowany', async () => {
    const db = openOmsDb();
    const inf = infaktAtrapa({ '2026-08': { faktury: [dok('a')] } });
    const c = czuwacz(db, inf);
    await c.przebieg();
    inf.listaFaktur = async () => [];
    const w = await c.przebieg({ wymuszony: true });
    expect(w.skasowanych).toBe(1);
    expect(wierszArchiwum(db, 'a').skasowana_at).not.toBeNull();
  });

  it('⚠️ blad listy miesiaca NIE oznacza niczego jako skasowane i zapisuje blad', async () => {
    const db = openOmsDb();
    zapiszWiersz(db, {
      uuid: 'a', rodzaj: 'vat', numer: '1/08/2026', invoiceDate: '2026-08-05', odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: 't',
    });
    const w = await czuwacz(db, infaktAtrapa({}, { padaj: '2026-08' })).przebieg();
    expect(w.skasowanych).toBe(0);
    expect(wierszArchiwum(db, 'a').skasowana_at).toBeNull();
    expect(stanArchiwumSprzedazy(db).ostatni_blad).toMatch(/2026-08.*inFakt 500/);
    expect(stanArchiwumSprzedazy(db).ostatnie_udane_at).toBeNull();
  });

  it('3 bledy pobrania z rzedu przerywaja przebieg; niedokonczone = true; sukces w miedzyczasie zeruje licznik', async () => {
    const db = openOmsDb();
    const inf = infaktAtrapa({ '2026-09': { faktury: ['a', 'b', 'c', 'd', 'e'].map((u) => dok(u, { invoice_date: '2026-09-01' })) } });
    let n = 0;
    const archiwizuj = async ({ dokument }) => { n += 1; if (dokument.uuid !== 'b') throw new Error('pad'); return { stan: 'pobrany', sciezka: 'x' }; };
    const w = await czuwacz(db, inf, { archiwizuj }).przebieg();
    // a(pad,1) b(ok,0) c(pad,1) d(pad,2) e(pad,3) -> stop po e
    expect(n).toBe(5);
    expect(w.niedokonczone).toBe(true);
    expect(LIMIT_KOLEJNYCH_BLEDOW).toBe(3);
    // ⚠️ Przebieg przerwany seria bledow tez NIE MA prawa udawac sukcesu.
    expect(stanArchiwumSprzedazy(db).ostatni_blad).not.toBeNull();
    expect(stanArchiwumSprzedazy(db).ostatnie_udane_at).toBeNull();
  });

  it('budzet czasu: po jego wyczerpaniu reszta zostaje na nastepna noc', async () => {
    const db = openOmsDb();
    let t = NOC().getTime();
    const teraz = () => new Date(t);
    const inf = infaktAtrapa({ '2026-09': { faktury: ['a', 'b', 'c'].map((u) => dok(u, { invoice_date: '2026-09-01' })) } });
    const archiwizuj = async () => { t += BUDZET_ARCHIWUM_SPRZEDAZY_MS; return { stan: 'pobrany', sciezka: 'x' }; };
    const w = await czuwacz(db, inf, { teraz, archiwizuj }).przebieg();
    expect(w.pobranych).toBe(1);
    expect(w.niedokonczone).toBe(true);
    expect(stanArchiwumSprzedazy(db).podloga_zrobiona_at).toBeNull(); // niedokonczony = podloga NIE zrobiona
    // ⚠️ Przebieg PRZERWANY budzetem, bez zadnego bledu dokumentu, tez nie jest sukcesem —
    // inaczej ekran pokazywalby „pobrano teraz" na przebiegu, ktory dokonczyl sie w polowie.
    expect(stanArchiwumSprzedazy(db).ostatni_blad).toMatch(/niedokończony/);
    expect(stanArchiwumSprzedazy(db).ostatnie_udane_at).toBeNull();
  });

  // ⚠️⚠️ BUDZET PILNUJE TEZ POBIERANIA LIST, NIE TYLKO POBIERAN DOKUMENTOW (recenzja calej
  // galezi). Bramka siedziala WYLACZNIE w petli po dokumentach, wiec przebieg po miesiacach
  // BEZ ANI JEDNEGO dokumentu nie sprawdzal budzetu ANI RAZU: pierwszy przebieg od podlogi
  // ciagnal listy wszystkich miesiecy (a tych przybywa z kazdym miesiacem kalendarza), kazda
  // do jedenastu rund po 60 s. Najgorszy przypadek rosl wtedy bez granicy — czyli straznik
  // czasu przebiegu w bootstrapie liczylby liczbe, ktora z rzeczywistoscia nie ma zwiazku.
  it('⚠️ wyczerpany budzet zamyka przebieg PRZED listami kolejnego miesiaca', async () => {
    const db = openOmsDb();
    let t = NOC().getTime();
    const teraz = () => new Date(t);
    // Miesiace PUSTE — celowo: przy pustych listach petla dokumentow ani razu sie nie zakreci,
    // wiec jedyna bramka, ktora moze tu zadzialac, to ta przed listami.
    const bazowy = infaktAtrapa();
    const inf = {
      wolania: bazowy.wolania,
      async listaFaktur(z) { t += BUDZET_ARCHIWUM_SPRZEDAZY_MS; return bazowy.listaFaktur.call(this, z); },
      listaKorekt: (z) => bazowy.listaKorekt(z),
      pobierzPdf: bazowy.pobierzPdf, pobierzPdfKorekty: bazowy.pobierzPdfKorekty,
    };
    const w = await czuwacz(db, inf, { teraz }).przebieg();
    // Pierwszy miesiac (styczen, bo podlogi jeszcze nie ma) przechodzi — jego listy zjadaja
    // caly budzet, wiec drugiego panel juz NIE odpytuje.
    expect(inf.wolania.map((z) => z.od.slice(0, 7))).toEqual(['2026-01']);
    expect(w.niedokonczone).toBe(true);
    expect(stanArchiwumSprzedazy(db).podloga_zrobiona_at).toBeNull();
    expect(stanArchiwumSprzedazy(db).ostatni_blad).toMatch(/niedokończony/);
  });

  it('blad_zapisu na dysk to blad przebiegu — bez odnotowania sukcesu', async () => {
    const db = openOmsDb();
    const inf = infaktAtrapa({ '2026-09': { faktury: ['a', 'b'].map((u) => dok(u, { invoice_date: '2026-09-01' })) } });
    const archiwizuj = async ({ dokument }) => (dokument.uuid === 'a'
      ? { stan: 'blad_zapisu', sciezka: 'x' }
      : { stan: 'pobrany', sciezka: 'x' });
    const w = await czuwacz(db, inf, { archiwizuj }).przebieg();
    expect(w.pobranych).toBe(1);
    expect(stanArchiwumSprzedazy(db).ostatni_blad).toMatch(/a\/08\/2026.*zapis na dysk nieudany/);
    expect(stanArchiwumSprzedazy(db).podloga_zrobiona_at).toBeNull();
    expect(stanArchiwumSprzedazy(db).ostatnie_udane_at).toBeNull();
  });

  it('oznaczenie skasowanej: blad jednego wiersza nie przerywa reszty miesiaca', async () => {
    const db = openOmsDb();
    zapiszWiersz(db, {
      uuid: 'x', rodzaj: 'vat', numer: '1/08/2026', invoiceDate: '2026-08-05', odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: 't',
    });
    zapiszWiersz(db, {
      uuid: 'y', rodzaj: 'vat', numer: '2/08/2026', invoiceDate: '2026-08-06', odcisk: '{}', sciezkaPdf: 'y', zapisanyAt: 't',
    });
    const inf = infaktAtrapa({ '2026-08': { faktury: [] } });
    const probowane = [];
    const oznaczSkasowany = async ({ wiersz }) => {
      probowane.push(wiersz.uuid);
      if (wiersz.uuid === 'x') throw new Error('SMB zajety');
    };
    const w = await czuwacz(db, inf, { oznaczSkasowany }).przebieg();
    expect(probowane).toEqual(['x', 'y']);
    expect(w.skasowanych).toBe(1);
    expect(wierszArchiwum(db, 'y').skasowana_at).toBeNull(); // atrapa nie zapisuje sama do bazy
    expect(stanArchiwumSprzedazy(db).ostatni_blad).toMatch(/1\/08\/2026.*oznaczenie skasowanej nieudane.*SMB zajety/);
  });

  it('okno miesiecy liczy dzien wg czasu Warszawy, nie UTC', async () => {
    const db = openOmsDb();
    const inf = infaktAtrapa();
    const c = czuwacz(db, inf);
    await c.przebieg(); // pierwszy przebieg ustawia podloge
    inf.wolania.length = 0;
    // 2026-08-31T22:30:00Z to 2026-09-01 00:30 czasu Warszawy (CEST, +2) — UTC widzialoby
    // to jeszcze jako 31 sierpnia i pomineloby wrzesien w oknie trzech miesiecy.
    const teraz = () => new Date('2026-08-31T22:30:00Z');
    const w = await czuwacz(db, inf, { teraz }).przebieg({ wymuszony: true });
    expect(w.pominiety).toBeUndefined();
    expect(inf.wolania.at(-1).od.slice(0, 7)).toBe('2026-09');
  });

  // ⚠️ Ta sama regula, co przy bledzie listy — tyle ze wpuszczana od srodka: po przerwaniu
  // miesiaca `widziane` zawiera TYLKO ogon tego, co panel zdazyl obejsc, wiec bez straznika
  // reszta miesiaca (i wiersze, do ktorych petla nie doszla) wygladalaby jak zniknieta
  // z inFaktu — pliki przemianowane na SKASOWANA_, mimo ze papier moze juz lezy w biurze.
  it('⚠️ miesiac PRZERWANY budzetem tez nie oznacza niczego jako skasowane', async () => {
    const db = openOmsDb();
    zapiszWiersz(db, {
      uuid: 'z', rodzaj: 'vat', numer: '9/09/2026', invoiceDate: '2026-09-01', odcisk: '{}', sciezkaPdf: 'x', zapisanyAt: 't',
    });
    let t = NOC().getTime();
    const teraz = () => new Date(t);
    const inf = infaktAtrapa({ '2026-09': { faktury: ['a', 'b'].map((u) => dok(u, { invoice_date: '2026-09-01' })) } });
    const archiwizuj = async () => { t += BUDZET_ARCHIWUM_SPRZEDAZY_MS; return { stan: 'pobrany', sciezka: 'x' }; };
    const w = await czuwacz(db, inf, { teraz, archiwizuj }).przebieg();
    expect(w.niedokonczone).toBe(true);
    expect(w.skasowanych).toBe(0);
    expect(wierszArchiwum(db, 'z').skasowana_at).toBeNull();
  });

  it('drugi przebieg w trakcie pierwszego jest pominiety', async () => {
    const db = openOmsDb();
    let zwolnij; const blokada = new Promise((r) => { zwolnij = r; });
    const inf = infaktAtrapa({ '2026-09': { faktury: [dok('a', { invoice_date: '2026-09-01' })] } });
    const c = czuwacz(db, inf, { archiwizuj: async () => { await blokada; return { stan: 'pobrany', sciezka: 'x' }; } });
    const pierwszy = c.przebieg();
    expect((await c.przebieg()).powod).toBe(POWOD_TRWA);
    zwolnij(); await pierwszy;
  });

  it('liczniki: adoptowanych/nadpisanych/bezZmian pochodza ze stanow archiwizacji', async () => {
    const db = openOmsDb();
    const inf = infaktAtrapa({ '2026-09': { faktury: ['a', 'b', 'c'].map((u) => dok(u, { invoice_date: '2026-09-01' })) } });
    const stany = { a: 'adoptowany', b: 'nadpisany', c: 'bez_zmian' };
    const w = await czuwacz(db, inf, { archiwizuj: async ({ dokument }) => ({ stan: stany[dokument.uuid], sciezka: 'x' }) }).przebieg();
    expect([w.adoptowanych, w.nadpisanych, w.bezZmian, w.pobranych]).toEqual([1, 1, 1, 0]);
  });
});
