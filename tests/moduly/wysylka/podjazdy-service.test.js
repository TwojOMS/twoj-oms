import { expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createPodjazdy } from '../../../src/moduly/wysylka/services/podjazdy.js';

const adres = { name: 'Test', street: 'Testowa 1', postalCode: '32-600', city: 'Oświęcim', countryCode: 'PL', email: 'test@example.com', phone: '500600700' };
const termin = { date: '2026-09-23', minTime: '09:00', maxTime: '13:00' };
// Zamrożony zegar: terminy w testach są z 23.09.2026, a data podjazdu nie może być przeszła.
const zegar = () => new Date('2026-09-22T12:00:00Z');
const DPD_WZA = '03f26351-f683-4db2-8895-f2c599280e3c';

function dane() {
  const db = openOmsDb();
  db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('allegro_szkicownia',1,'A1','2026-09-22T08:00:00Z','0')`).run();
  const z = db.prepare('SELECT id FROM zamowienia WHERE numer=?').get('A1');
  const dodaj = db.prepare(`INSERT INTO przesylki
    (zamowienie_id,kurier,status,numer_listu,id_przesylki_kuriera,etykieta_sciezka,utworzona_at,kolejnosc)
    VALUES (?,'allegro_wza','nadana',?,?,'etykieta.pdf','2026-09-22T08:00:00Z',?)`);
  dodaj.run(z.id,'AD-1','shipment-1',1);
  dodaj.run(z.id,'AD-2','shipment-2',2);
  const ids = db.prepare('SELECT id FROM przesylki ORDER BY id').all().map((w) => w.id);
  return { db, ids };
}

function klient() {
  return {
    pobierzPrzesylkeWza: vi.fn(async (id) => ({ id, deliveryMethodId: DPD_WZA, transport: ['DPD'], pickupAvailable: true,
      packages: [{ waybill: id === 'shipment-1' ? 'AD-1' : 'AD-2' }] })),
    pobierzPropozycjePodjazdu: vi.fn(async ({ shipmentIds }) => [{
      proposals: shipmentIds.map((shipmentId) => ({ shipmentId, pickupTimes: [termin] })),
      address: adres,
    }]),
    zlecPodjazd: vi.fn(async () => ({ status: 'IN_PROGRESS' })),
    stanZleceniaPodjazdu: vi.fn(async () => ({ status: 'IN_PROGRESS' })),
  };
}

it('podgląd pobiera wspólną ofertę i zleca pełny zestaw tylko raz', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let nr = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++nr}`, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres, kto: 'test' });
  expect(podglad.grupy).toHaveLength(1);
  expect(podglad.grupy[0].terminy).toEqual([termin]);
  const first = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin, kto: 'test' });
  const again = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin, kto: 'test' });
  expect(first.command_id).toBe(again.command_id);
  expect(allegro.zlecPodjazd).toHaveBeenCalledTimes(1);
  expect(allegro.zlecPodjazd.mock.calls[0][0].input.shipmentIds).toEqual(['shipment-1','shipment-2']);
});

it('zniknięcie terminu przed zatwierdzeniem nie wysyła zlecenia', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => crypto.randomUUID(), moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres, kto: 'test' });
  allegro.pobierzPropozycjePodjazdu.mockResolvedValueOnce([{ proposals: [{ shipmentId: 'shipment-1', pickupTimes: [] }] }]);
  await expect(usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin, kto: 'test' }))
    .rejects.toThrow(/termin|propozycj/i);
  expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
});

it('dwie równoległe akceptacje tego samego podglądu wysyłają jeden POST', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: (() => { let i = 0; return () => `uuid-${++i}`; })(), moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres, kto: 'test' });
  await Promise.all([1, 2].map(() => usluga.zlec({ podgladId: podglad.id,
    grupaId: podglad.grupy[0].id, termin, kto: 'test' })));
  expect(allegro.zlecPodjazd).toHaveBeenCalledTimes(1);
});

it('po zleceniu DPD podgląd zachowuje niezleconą grupę drugiego kuriera', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPrzesylkeWza.mockImplementation(async (id) => ({
    id, deliveryMethodId: id === 'shipment-1' ? 'method-dpd' : 'method-one',
    transport: [id === 'shipment-1' ? 'DPD' : 'ALLEGRO_ONE_KURIER'], pickupAvailable: true,
    packages: [{ waybill: id === 'shipment-1' ? 'AD-1' : 'AD-2' }],
  }));
  let nr = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++nr}`, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(podglad.grupy).toHaveLength(2);
  const zlecony = await usluga.zlec({ podgladId: podglad.id,
    grupaId: podglad.grupy[0].id, termin });
  const odswiezony = usluga.pobierzPodglad({ id: podglad.id });
  expect(odswiezony.grupy).toHaveLength(2);
  expect(odswiezony.grupy[0].wynik.id).toBe(zlecony.id);
  expect(odswiezony.grupy[0].moznaZlecac).toBe(false);
  expect(odswiezony.grupy[1].wynik).toBeNull();
  expect(odswiezony.grupy[1].moznaZlecac).toBe(true);
});

it('SUCCESS bez zgodnych szczegółów nie potwierdza podjazdu', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}`, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres, kto: 'test' });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  allegro.stanZleceniaPodjazdu.mockResolvedValue({ id: zlecenie.command_id, status: 'SUCCESS', pickupId: 'pickup-1' });
  allegro.pobierzPodjazd = vi.fn(async () => ({ id: 'pickup-1', pickupCarrier: 'DPD', shipmentIds: ['shipment-1'] }));
  expect((await usluga.sprawdz({ id: zlecenie.id })).stan).toBe('nieznany');
  allegro.pobierzPodjazd.mockResolvedValue({ id: 'pickup-1', pickupCarrier: 'DPD', shipmentIds: ['shipment-1', 'shipment-2'] });
  const potwierdzony = await usluga.sprawdz({ id: zlecenie.id });
  expect(potwierdzony.stan).toBe('potwierdzony');
  expect(potwierdzony.pickup_carrier).toBe('DPD');
});

it('sprzeczny identyfikator komendy nie zwalnia paczek', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}`, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  allegro.stanZleceniaPodjazdu.mockResolvedValue({ id: 'obca-komenda', status: 'ERROR' });
  expect((await usluga.sprawdz({ id: zlecenie.id })).stan).toBe('nieznany');
  expect(db.prepare('SELECT COUNT(*) n FROM podjazdy_przesylki WHERE aktywna_rezerwacja=1').get().n).toBe(2);
});

it('spreparowane dodatkowe pola terminu nie trafiają do Allegro', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}`, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id,
    termin: { ...termin, pickupDateProposalId: 'stary-kontrakt', proposalItems: ['x'] } });
  expect(allegro.zlecPodjazd.mock.calls[0][0].input.pickupTime).toEqual(termin);
});

it('429 ustawia najbliższy odczyt według Retry-After', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, allegroDla: () => allegro, moznaZlecac: true,
    teraz: () => new Date('2026-09-22T12:00:00Z'), uuid: () => `uuid-${++i}` });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  allegro.stanZleceniaPodjazdu.mockRejectedValue(Object.assign(new Error('limit'), { status: 429, retryAfterS: 1200 }));
  const wynik = await usluga.sprawdz({ id: zlecenie.id });
  expect(wynik.nastepne_sprawdzenie_at).toBe('2026-09-22T12:20:00.000Z');
});

it('potwierdzony DPD jest dostępny w produkcyjnym podglądzie', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}` });
  const przed = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(przed.grupy[0].moznaZlecac).toBe(false);
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('podjazdy.allegro.dpd.aktywne','1','2026-09-22T12:00:00Z')").run();
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(podglad.grupy[0].moznaZlecac).toBe(true);
  expect(podglad.grupy[0].kurierOdbierajacy).toBe('DPD');
  db.prepare("UPDATE ustawienia SET wartosc='0' WHERE klucz='podjazdy.allegro.dpd.aktywne'").run();
  await expect(usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin }))
    .rejects.toThrow(/wstrzymane/);
  expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
});

// Od 01.10.2026: Automaty Paczkowe DPD i Kurier DPD pobranie — zasób WzA obu podaje
// transport ['DPD'] i ten sam termin co Kurier DPD (zmierzone na #1376 i #1377).
it.each([
  ['Automaty Paczkowe DPD', '09bcdcdb-c62a-41c4-ba42-f2c599280e3c'],
  ['Kurier DPD pobranie', '13f26351-26fb-48d4-b5dd-f2c599280e3c'],
])('%s z transportem DPD dostaje przycisk podjazdu', async (_nazwa, metoda) => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPrzesylkeWza.mockImplementation(async (id) => ({
    id, deliveryMethodId: metoda, transport: ['DPD'], pickupAvailable: true,
    packages: [{ waybill: id === 'shipment-1' ? 'AD-1' : 'AD-2' }],
  }));
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('podjazdy.allegro.dpd.aktywne','1','2026-09-22T12:00:00Z')").run();
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}` });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(podglad.grupy[0].kurierOdbierajacy).toBe('DPD');
  expect(podglad.grupy[0].moznaZlecac).toBe(true);
});

it('Automaty DPD z innym transportem niż DPD pozostają bez przycisku', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPrzesylkeWza.mockImplementation(async (id) => ({
    id, deliveryMethodId: '09bcdcdb-c62a-41c4-ba42-f2c599280e3c', transport: ['ALLEGRO_ONE_KURIER'],
    pickupAvailable: true, packages: [{ waybill: id === 'shipment-1' ? 'AD-1' : 'AD-2' }],
  }));
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('podjazdy.allegro.dpd.aktywne','1','2026-09-22T12:00:00Z')").run();
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(podglad.grupy[0].moznaZlecac).toBe(false);
});

// Pierwszy podjazd z OMS-u dla nowo odblokowanej usługi JEST pomiarem przewoźnika:
// inny `pickupCarrier` niż oczekiwany nie może dać zielonego „potwierdzony".
it('SUCCESS z innym przewoźnikiem niż oczekiwany DPD nie potwierdza podjazdu', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('podjazdy.allegro.dpd.aktywne','1','2026-09-22T12:00:00Z')").run();
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}` });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  allegro.stanZleceniaPodjazdu.mockResolvedValue({ id: zlecenie.command_id, status: 'SUCCESS', pickupId: 'pickup-1' });
  allegro.pobierzPodjazd = vi.fn(async () => ({ id: 'pickup-1', pickupCarrier: 'ALLEGRO', shipmentIds: ['shipment-1', 'shipment-2'] }));
  const wynik = await usluga.sprawdz({ id: zlecenie.id });
  expect(wynik.stan).toBe('nieznany');
  expect(wynik.blad_opis).toMatch(/ALLEGRO.*DPD/);
});

it('nieznana metoda lub sprzeczny transport pozostają bez przycisku i bez POST', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPrzesylkeWza.mockImplementation(async (id) => ({
    id, deliveryMethodId: 'niepotwierdzona-metoda', transport: ['DHL'], pickupAvailable: true,
    packages: [{ waybill: id === 'shipment-1' ? 'AD-1' : 'AD-2' }],
  }));
  let i = 0;
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, uuid: () => `uuid-${++i}` });
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('podjazdy.allegro.dpd.aktywne','1','2026-09-22T12:00:00Z')").run();
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(podglad.grupy[0].moznaZlecac).toBe(false);
  await expect(usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin }))
    .rejects.toThrow(/wstrzymane|przewoźnik/i);
  expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
});

it('brak pola transport nie wywraca podglądu i nie odblokowuje zlecenia', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPrzesylkeWza.mockImplementation(async (id) => ({
    id, deliveryMethodId: DPD_WZA, pickupAvailable: true,
    packages: [{ waybill: id === 'shipment-1' ? 'AD-1' : 'AD-2' }],
  }));
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('podjazdy.allegro.dpd.aktywne','1','2026-09-22T12:00:00Z')").run();
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  expect(podglad.grupy[0].moznaZlecac).toBe(false);
});

it('429 przy szczegółach podjazdu także respektuje Retry-After', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, allegroDla: () => allegro, moznaZlecac: true,
    teraz: () => new Date('2026-09-22T12:00:00Z'), uuid: () => `uuid-${++i}` });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  allegro.stanZleceniaPodjazdu.mockResolvedValue({ id: zlecenie.command_id, status: 'SUCCESS', pickupId: 'pickup-1' });
  allegro.pobierzPodjazd = vi.fn().mockRejectedValue(Object.assign(new Error('limit'), { retryAfterS: 1800 }));
  const wynik = await usluga.sprawdz({ id: zlecenie.id });
  expect(wynik.nastepne_sprawdzenie_at).toBe('2026-09-22T12:30:00.000Z');
});

it('IN_PROGRESS respektuje Retry-After ze statusu komendy', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  const usluga = createPodjazdy({ db, allegroDla: () => allegro, moznaZlecac: true,
    teraz: () => new Date('2026-09-22T12:00:00Z'), uuid: () => `uuid-${++i}` });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  allegro.stanZleceniaPodjazdu.mockResolvedValue({ id: zlecenie.command_id, status: 'IN_PROGRESS', retryAfterS: 2400 });
  expect((await usluga.sprawdz({ id: zlecenie.id })).nastepne_sprawdzenie_at)
    .toBe('2026-09-22T12:40:00.000Z');
});

it('równoczesne sprawdzenie z widoku i czuwacza wykonuje tylko jeden GET Allegro', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  let i = 0;
  let czas = new Date('2026-09-22T12:00:00Z');
  const usluga = createPodjazdy({ db, allegroDla: () => allegro, moznaZlecac: true,
    teraz: () => czas, uuid: () => `uuid-${++i}` });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres });
  const zlecenie = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  let zwolnij;
  allegro.stanZleceniaPodjazdu.mockImplementation(() => new Promise((resolve) => { zwolnij = resolve; }));
  const pierwszy = usluga.sprawdz({ id: zlecenie.id });
  // Dwa sekwencyjne timeouty klienta po 30 s mogą trwać >60 s z narzutem.
  czas = new Date('2026-09-22T12:01:01Z');
  const drugi = await usluga.sprawdz({ id: zlecenie.id });
  expect(drugi.stan).toBe('oczekuje');
  expect(allegro.stanZleceniaPodjazdu).toHaveBeenCalledTimes(1);
  zwolnij({ id: zlecenie.command_id, status: 'ERROR' });
  expect((await pierwszy).stan).toBe('odrzucony');
  expect((await usluga.sprawdz({ id: zlecenie.id })).stan).toBe('odrzucony');
  expect(allegro.stanZleceniaPodjazdu).toHaveBeenCalledTimes(1);
});

it('osobne elementy odpowiedzi z identycznym adresem pozwalają zlecić cały zestaw tylko raz', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPropozycjePodjazdu.mockResolvedValue([
    { proposals: [{ shipmentId: 'shipment-2', pickupTimes: [termin] }], address: adres },
    { proposals: [{ shipmentId: 'shipment-1', pickupTimes: [termin] }], address: { ...adres, company: null, point: null } },
  ]);
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: '2026-09-23', adres, kto: 'test' });
  expect(podglad.grupy[0].terminy).toEqual([termin]);
  expect(podglad.grupy[0].diagnoza).toBeNull();
  const wynik = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  const powtorka = await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  expect(powtorka.id).toBe(wynik.id);
  expect(allegro.pobierzPropozycjePodjazdu).toHaveBeenCalledTimes(2);
  expect(allegro.zlecPodjazd).toHaveBeenCalledTimes(1);
  expect(allegro.zlecPodjazd.mock.calls[0][0].input).toEqual({
    shipmentIds: ['shipment-1', 'shipment-2'], pickupTime: termin, address: { ...adres, phone: '+48500600700' },
  });
});

it('zmiana podziału odpowiedzi przy zatwierdzeniu nie blokuje wspólnego terminu', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: termin.date, adres });
  allegro.pobierzPropozycjePodjazdu.mockResolvedValueOnce(ids.map((_, i) => ({
    proposals: [{ shipmentId: `shipment-${i + 1}`, pickupTimes: [termin] }], address: adres,
  })));
  await usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin });
  expect(allegro.zlecPodjazd.mock.calls[0][0].input.shipmentIds).toEqual(['shipment-1', 'shipment-2']);
});

it.each(['adres', 'adres-wszystkie', 'brak-paczki', 'obca-paczka', 'duplikat', 'termin'])('ponowna kontrola odmawia po zmianie: %s', async (zmiana) => {
  const { db, ids } = dane();
  const allegro = klient();
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: termin.date, adres });
  const odpowiedz = ids.map((_, i) => ({ proposals: [{ shipmentId: `shipment-${i + 1}`, pickupTimes: [termin] }], address: adres }));
  if (zmiana === 'adres') odpowiedz[1].address = { ...adres, street: 'Inna 2' };
  if (zmiana === 'adres-wszystkie') odpowiedz.forEach(g => { g.address = { ...adres, street: 'Inna 2' }; });
  if (zmiana === 'brak-paczki') odpowiedz.pop();
  if (zmiana === 'obca-paczka') odpowiedz[1].proposals[0].shipmentId = 'obca';
  if (zmiana === 'duplikat') odpowiedz[1].proposals[0].shipmentId = 'shipment-1';
  if (zmiana === 'termin') odpowiedz[1].proposals[0].pickupTimes = [{ ...termin, maxTime: '17:00' }];
  allegro.pobierzPropozycjePodjazdu.mockResolvedValueOnce(odpowiedz);
  await expect(usluga.zlec({ podgladId: podglad.id, grupaId: podglad.grupy[0].id, termin })).rejects.toThrow(/termin|propozycj/i);
  expect(allegro.zlecPodjazd).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) n FROM podjazdy').get().n).toBe(0);
});

it('różne okna w osobnych elementach pokazują terminy paczek i trafną przyczynę', async () => {
  const { db, ids } = dane();
  const allegro = klient();
  allegro.pobierzPropozycjePodjazdu.mockResolvedValueOnce([
    { proposals: [{ shipmentId: 'shipment-2', pickupTimes: [{ ...termin, maxTime: '17:00' }] }], address: adres },
    { proposals: [{ shipmentId: 'shipment-1', pickupTimes: [termin] }], address: adres },
  ]);
  const usluga = createPodjazdy({ db, teraz: zegar, allegroDla: () => allegro, moznaZlecac: true });
  const podglad = await usluga.przygotuj({ ids, data: termin.date, adres });
  expect(podglad.grupy[0].terminy).toEqual([]);
  expect(podglad.grupy[0].diagnoza.przyczyna).toBe('rozne-okna');
  expect(podglad.grupy[0].diagnoza.paczki.map(p => p.numerListu)).toEqual(['AD-1', 'AD-2']);
});
