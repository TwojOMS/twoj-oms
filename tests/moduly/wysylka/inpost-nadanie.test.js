import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zbudujOms } from '../../pomoc/bootstrap-parytetu.ts';
import { stanPrzesylki, sprawyPrzesylki, mozliwaKolejnaPaczka } from '../../../src/domena/przesylka-stan.js';
import { powodBrakuGotowosciNadania } from '../../../src/domena/gotowosc-nadania.js';

// ⚠️ ANI JEDNO WYWOLANIE NIE IDZIE DO PRAWDZIWEGO INPOSTU ANI DPD. Utworzenie przesylki
// jest nieodwracalne i platne, wiec caly ten plik rozmawia wylacznie z atrapami: albo
// z atrapa KLIENTA (kontrakt kurierzy/*), albo z prawdziwym klientem ShipX podpietym do
// atrapy `fetch`. Token i identyfikatory sa wymyslone.

const TOKEN = 'eyJTESTOWY.TOKEN-INPOST.NIE-MA-PRAWA-WYCIEC';
const ORGANIZACJA = 13235;
const URL_API = 'https://shipx.test/v1';
const NADAWCA = { nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '338451234', email: 'sklep@szkicownia.pl' };

// Prawdziwy numer paczkomatowy ma 24 cyfry; identyfikator przesylki w ShipX to liczba.
const NUMER = '520000123456789012345678';
const SHIPMENT_ID = 9993331;
const PDF = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n';
const ZPL = '^XA^FO50,50^FDInPost^FS^XZ';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 28045, numer: '28045', klient: { email: 'j@k.pl', phone: '+48500900008' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'inpost_paczkomat', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  punkt_odbioru: 'SLN06M', punkt_odbioru_opis: 'Przy myjni bezdotykowej',
  status_woo: 'processing', oplacone_at: '2026-08-01T10:00:00', anulowane: 0,
  utworzone_at: '2026-08-01T09:00:00', pozycje: [], ...nad,
});

const paczka = { waga: 1.2, gabaryt: 'A' };
const logi = (db, akcja) => db.prepare('SELECT * FROM log WHERE akcja = ?').all(akcja).map((w) => w.wynik);
const wiersz = (db, id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);

// Wynik, jaki klient InPostu oddaje po UDANYM nadaniu (kontrakt kurierzy/inpost.js).
const wynikGotowy = (nad = {}) => ({
  shipmentId: SHIPMENT_ID,
  numerListu: NUMER,
  wTrakcieTworzenia: false,
  etykietaPdf: Buffer.from(PDF),
  etykietaZpl: Buffer.from(ZPL),
  zplBladOpis: null,
  surowa: '{"id":9993331}',
  ...nad,
});

// Wynik „przesylka istnieje, numeru jeszcze nie ma" — wyczerpane okno odpytywania.
const wynikWTrakcie = () => ({
  shipmentId: SHIPMENT_ID,
  numerListu: null,
  wTrakcieTworzenia: true,
  etykietaPdf: null,
  etykietaZpl: null,
  zplBladOpis: null,
  surowa: '{"id":9993331,"tracking_number":null}',
});

// Blad z doklejonym `shipmentId` — klient dokleja go do KAZDEGO wyjatku po udanym POST.
function bladPoUtworzeniu(komunikat, { numerListu = null } = {}) {
  const e = new Error(komunikat);
  e.dlaOperatora = true;
  e.shipmentId = SHIPMENT_ID;
  if (numerListu) e.numerListu = numerListu;
  e.surowa = '{"id":9993331}';
  return e;
}

function zestaw({ inpostKlient, katalogEtykiet } = {}) {
  const db = openOmsDb(':memory:');
  const inpost = inpostKlient ?? {
    nadaj: vi.fn().mockResolvedValue(wynikGotowy()),
    sprawdzPrzesylke: vi.fn().mockResolvedValue(wynikGotowy()),
  };
  const dpd = { nadaj: vi.fn() };
  const woo = { dodajNotatke: vi.fn().mockResolvedValue({}), ustawStatus: vi.fn().mockResolvedValue({}) };
  const katalog = katalogEtykiet ?? mkdtempSync(join(tmpdir(), 'oms-inpost-'));
  const nadanie = createNadanie({ db, kurierzy: { dpd, inpost }, klienci: { pro: woo }, katalogEtykiet: katalog });
  return { db, inpost, dpd, woo, nadanie, katalogEtykiet: katalog };
}

describe('nadanie paczkomatowe — podpięcie klienta InPostu', () => {
  it('zamówienie paczkomatowe idzie do kuriera „inpost", nie do DPD', async () => {
    const { db, inpost, dpd, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, paczka);
    expect(dpd.nadaj).not.toHaveBeenCalled();
    expect(inpost.nadaj).toHaveBeenCalledTimes(1);
    expect(wiersz(db, id).kurier).toBe('inpost');
  });

  // Kontrakt klienta (Zadanie 5) sprawdzony NA PRAWDZIWYM kliencie z atrapa `fetch`:
  // gdyby usluga nadania czytala inne pola, niz klient oddaje, atrapy nigdy by tego
  // nie wykryly — obie strony klamalyby zgodnie.
  it('prawdziwy klient ShipX (atrapa fetch) domyka nadanie: numer, identyfikator i etykiety', async () => {
    const odp = {
      post: { status: 201, ok: true, text: async () => JSON.stringify({ id: SHIPMENT_ID, tracking_number: NUMER }) },
      pdf: { status: 200, ok: true, arrayBuffer: async () => Buffer.from(PDF, 'latin1') },
      zpl: { status: 200, ok: true, arrayBuffer: async () => Buffer.from(ZPL, 'latin1') },
    };
    const fetchImpl = vi.fn(async (adres) => {
      if (String(adres).includes('format=pdf')) return odp.pdf;
      if (String(adres).includes('format=zpl')) return odp.zpl;
      return odp.post;
    });
    const inpostKlient = createInpostClient({
      url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca: NADAWCA, fetchImpl,
    });
    const { db, nadanie } = zestaw({ inpostKlient });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});

    expect(await nadanie.nadaj(id, paczka)).toEqual({ numerListu: NUMER });
    const p = wiersz(db, id);
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBe(NUMER);
    expect(p.id_przesylki_kuriera).toBe(String(SHIPMENT_ID));
    expect(readFileSync(p.etykieta_sciezka).subarray(0, 4).toString()).toBe('%PDF');
    expect(readFileSync(p.etykieta_zpl_sciezka).subarray(0, 3).toString()).toBe('^XA');
    // ⚠️ Token to sekret — nie ma prawa wyladowac w bazie razem z surowa odpowiedzia.
    expect(p.odpowiedz_surowa ?? '').not.toContain(TOKEN);
  });

  it('identyfikator przesyłki u kuriera zapisuje się także przy zwykłym, udanym nadaniu', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, paczka);
    expect(wiersz(db, id).id_przesylki_kuriera).toBe(String(SHIPMENT_ID));
  });
});

// ---------------------------------------------------------------------------------
// ODMOWA BEZ KODU PACZKOMATU
// ---------------------------------------------------------------------------------
// ⚠️⚠️ „DOKAD TA PACZKA NAPRAWDE POJECHALA" — przy paczkomacie odpowiedzia jest KOD AUTOMATU,
// nie ulica odbiorcy (ta jest jego adresem DOMOWYM i z miejscem odbioru nie ma nic wspolnego).
// Kolumna `przesylki.adres_uzyty` istnieje wylacznie po to pytanie; kod poprawiony na ekranie
// nadania idzie do InPostu, wiec bez zapisania go tutaj paczka jechalaby do automatu X,
// a panel do konca zycia twierdzilby, ze do Y.
describe('adres użyty przy paczkomacie niesie kod automatu', () => {
  it('kod z zamówienia zapisuje się przy przesyłce', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, paczka);
    expect(JSON.parse(wiersz(db, id).adres_uzyty).punkt_odbioru).toBe('SLN06M');
  });

  // Sedno: operator poprawil kod na ekranie nadania, bo klient podal go w uwagach.
  // Paczka jedzie do POPRAWIONEGO automatu — i to on ma zostac w historii przesylki.
  it('kod POPRAWIONY na ekranie nadania wygrywa z kodem z zamówienia', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, paczka, { punktOdbioru: 'WRO10B' });
    expect(JSON.parse(wiersz(db, id).adres_uzyty).punkt_odbioru).toBe('WRO10B');
  });

  // Przesylka DPD nie ma punktu odbioru i nie ma go dostac — pusty klucz w JSON-ie
  // wygladalby jak „paczkomat, ktoremu ktos skasowal kod".
  it('przesyłka DPD nie dostaje klucza punktu odbioru', async () => {
    const { db, dpd, nadanie } = zestaw();
    // Atrapa DPD w `zestaw()` nie oddaje wyniku — tutaj nadajemy naprawde, wiec musi.
    dpd.nadaj.mockResolvedValue({
      numerListu: '1048171723296U', etykietaPdf: Buffer.from(PDF), etykietaZpl: Buffer.from(ZPL),
      zplBladOpis: null, surowa: '<xml/>',
    });
    const id = zapiszZamowienie(db, 'pro', zmapowane({
      metoda_wysylki: 'dpd', punkt_odbioru: null, punkt_odbioru_opis: null,
    }), {});
    await nadanie.nadaj(id, { waga: 1.2, dlugosc: 30, szerokosc: 20, wysokosc: 10 });
    expect(JSON.parse(wiersz(db, id).adres_uzyty)).not.toHaveProperty('punkt_odbioru');
  });
});

describe('paczkomat bez kodu nie idzie do nadania', () => {
  it('domena nazywa brak kodu, a przy kompletnym zamówieniu milczy', () => {
    expect(powodBrakuGotowosciNadania({ metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: null }))
      .toMatch(/kodu paczkomatu/i);
    expect(powodBrakuGotowosciNadania({ metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: '   ' }))
      .toMatch(/kodu paczkomatu/i);
    expect(powodBrakuGotowosciNadania({ metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'WRO10B' })).toBeNull();
    expect(powodBrakuGotowosciNadania({ metoda_wysylki: 'dpd', punkt_odbioru: null })).toBeNull();
  });

  // ⚠️ MUTACJA (b): dopuszczenie nadania paczkomatu bez `punkt_odbioru` MUSI zlamac ten test.
  // Odmowa stoi PRZED kurierem i PRZED wierszem w bazie — nieudana proba nie ma prawa
  // zostawic po sobie niczego do odblokowywania.
  it('usługa odmawia, nie woła kuriera i nie zostawia wiersza przesyłki', async () => {
    const { db, inpost, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ punkt_odbioru: null, punkt_odbioru_opis: null }), {});
    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow(/kodu paczkomatu/i);
    expect(inpost.nadaj).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(0);
  });

  it('ręczna korekta kodu odblokowuje nadanie (brak kodu ma WYJŚCIE)', async () => {
    const { db, inpost, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane({ punkt_odbioru: null }), {});
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?')
      .run(JSON.stringify({ metoda: 'inpost_paczkomat', pobranie: 0, punkt_odbioru: 'WRO10B' }), id);
    await nadanie.nadaj(id, paczka);
    expect(inpost.nadaj).toHaveBeenCalledTimes(1);
    expect(inpost.nadaj.mock.calls[0][0].zamowienie.punkt_odbioru).toBe('WRO10B');
  });
});

// ---------------------------------------------------------------------------------
// AWARIA PO UTWORZENIU PRZESYLKI
// ---------------------------------------------------------------------------------
describe('awaria po utworzeniu przesyłki zostawia identyfikator', () => {
  // ⚠️ MUTACJA (a): usuniecie zapisu `shipmentId` na sciezce awaryjnej MUSI zlamac ten test.
  // Przesylka u kuriera ISTNIEJE — bez identyfikatora panel nigdy jej nie dokonczy
  // ani nie odnajdzie, a paczka zostanie oplacona i niewidoczna.
  it('błąd bez numeru listu, ale z identyfikatorem → wiersz żyje i niesie identyfikator', async () => {
    const inpostKlient = { nadaj: vi.fn().mockRejectedValue(bladPoUtworzeniu('InPost: nie udało się sprawdzić przesyłki: timeout')) };
    const { db, nadanie } = zestaw({ inpostKlient });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});

    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow(/timeout/);
    const p = wiersz(db, id);
    expect(p.id_przesylki_kuriera).toBe(String(SHIPMENT_ID));
    // ⚠️ NIE 'blad': ten status zwalnia indeks czesciowy, czyli otwiera droge do DRUGIEJ
    // prawdziwej paczki — a InPost nie odsieje jej po referencji.
    expect(p.status).toBe('w_trakcie');
    expect(p.blad_opis).toMatch(/timeout/);
    expect(stanPrzesylki(p)).toBe('tworzona_u_kuriera');
    expect(logi(db, 'nadanie')[0]).toMatch(/UTWORZONA U KURIERA/);
  });

  it('po takiej awarii ponowne nadanie odbija się od bazy — zero drugich paczek', async () => {
    const inpostKlient = { nadaj: vi.fn().mockRejectedValue(bladPoUtworzeniu('padło odpytywanie')) };
    const { db, nadanie } = zestaw({ inpostKlient });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow();

    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow(/JUŻ ISTNIEJE u kuriera/);
    expect(inpostKlient.nadaj).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
    // Także paczka nr 2 (dosyłka) jest zablokowana, dopóki tamta nie ma numeru.
    await expect(nadanie.nadaj(id, paczka, { kolejnosc: 2 })).rejects.toThrow(/JUŻ ISTNIEJE u kuriera/);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
  });

  // ⚠️ MUTACJA (d): przerwanie zapisu numeru przy awarii etykiety MUSI zlamac ten test.
  it('awaria etykiety NIE gubi numeru listu ani identyfikatora', async () => {
    const inpostKlient = {
      nadaj: vi.fn().mockRejectedValue(bladPoUtworzeniu('InPost nie oddał etykiety PDF (HTTP 500)', { numerListu: NUMER })),
    };
    const { db, nadanie } = zestaw({ inpostKlient });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow(/etykiety PDF/);
    const p = wiersz(db, id);
    expect(p.status).toBe('do_wyjasnienia');
    expect(p.numer_listu).toBe(NUMER);
    expect(p.id_przesylki_kuriera).toBe(String(SHIPMENT_ID));
  });

  // ⚠️ MUTACJA (d), druga polowa: awaria ZAPISU PLIKU etykiety tez nie ma prawa przerwac
  // zapisu numeru. Katalog o nazwie pliku etykiety wywala writeFileSync (EISDIR) —
  // bez zaslaniania modulu `fs`.
  it('awaria zapisu pliku etykiety NIE przerywa zapisu numeru listu', async () => {
    const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    mkdirSync(join(katalogEtykiet, `28045-${NUMER}.pdf`));
    const { db, nadanie } = zestaw({ katalogEtykiet });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});

    expect(await nadanie.nadaj(id, paczka)).toEqual({ numerListu: NUMER });
    const p = wiersz(db, id);
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBe(NUMER);
    expect(p.etykieta_sciezka).toBeNull();
    expect(logi(db, 'etykieta')[0]).toMatch(/BŁĄD zapisu/);
  });
});

// ---------------------------------------------------------------------------------
// STAN „PRZESYLKA TWORZONA U KURIERA"
// ---------------------------------------------------------------------------------
describe('stan „przesyłka tworzona u kuriera"', () => {
  const wTrakcie = { status: 'w_trakcie', id_przesylki_kuriera: '9993331', numer_listu: null, utworzona_at: '2026-08-01T10:00:00.000Z' };

  it('identyfikator bez numeru listu daje własny stan, nie „w_trakcie"', () => {
    expect(stanPrzesylki(wTrakcie, Date.parse('2026-08-01T10:00:01Z'))).toBe('tworzona_u_kuriera');
  });

  // ⚠️ Prog zawieszenia (5 min) NIE MA prawa przemianowac tego stanu na 'zawieszona':
  // tamten stan znaczy „nie wiadomo, czy paczka powstala", a jego wyjscie zwalnia indeks.
  // Tutaj wiadomo, ze powstala — zwolnienie indeksu daloby druga prawdziwa paczke.
  it('nie zmienia się w „zawieszoną" nawet po progu', () => {
    expect(stanPrzesylki(wTrakcie, Date.parse('2026-08-01T12:00:00Z'))).toBe('tworzona_u_kuriera');
  });

  it('jest sprawą do załatwienia i blokuje kolejną paczkę', () => {
    expect(sprawyPrzesylki(wTrakcie)).toContain('przesyłka tworzona u kuriera');
    expect(mozliwaKolejnaPaczka([wTrakcie])).toBe(false);
  });

  it('nadanie bez numeru zostawia wiersz żywy z identyfikatorem i mówi to wprost', async () => {
    const inpostKlient = { nadaj: vi.fn().mockResolvedValue(wynikWTrakcie()) };
    const { db, nadanie } = zestaw({ inpostKlient });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});

    const wynik = await nadanie.nadaj(id, paczka);
    expect(wynik).toMatchObject({ numerListu: null, wTrakcieTworzenia: true });
    const p = wiersz(db, id);
    expect(p.status).toBe('w_trakcie');
    expect(p.numer_listu).toBeNull();
    expect(p.id_przesylki_kuriera).toBe(String(SHIPMENT_ID));
    // To NIE jest awaria — przy spokojnym czekaniu nie ma czego opisywać jako błąd.
    expect(p.blad_opis).toBeNull();
    expect(logi(db, 'nadanie')[0]).toMatch(/TWORZONA U KURIERA/);
  });
});

// ---------------------------------------------------------------------------------
// „SPRAWDZ PONOWNIE"
// ---------------------------------------------------------------------------------
describe('„Sprawdź ponownie"', () => {
  // Zamowienie z przesylka czekajaca na numer — dokladnie taka, jaka zostawia nadanie.
  async function wStanieTworzenia(nad = {}) {
    const sprawdzPrzesylke = nad.sprawdzPrzesylke ?? vi.fn().mockResolvedValue(wynikGotowy());
    const inpostKlient = { nadaj: vi.fn().mockResolvedValue(wynikWTrakcie()), sprawdzPrzesylke };
    const zest = zestaw({ inpostKlient, katalogEtykiet: nad.katalogEtykiet });
    const id = zapiszZamowienie(zest.db, 'pro', zmapowane(), {});
    await zest.nadanie.nadaj(id, paczka);
    return { ...zest, id, przesylkaId: wiersz(zest.db, id).id, sprawdzPrzesylke, inpostKlient };
  }

  it('dobiera numer listu i etykiety, przesyłka staje się nadana', async () => {
    const { db, nadanie, id, przesylkaId, sprawdzPrzesylke, woo } = await wStanieTworzenia();
    expect(await nadanie.sprawdzPonownie(przesylkaId)).toEqual({ numerListu: NUMER });
    // ⚠️ DRUGIM ARGUMENTEM idzie ZAMOWIENIE (11.08.2026). InPost i DPD je ignoruja, ale
    // `allegro_wza` bez niego nie wie, KTOREGO KONTA Allegro pytac — kanaly to osobne konta.
    expect(sprawdzPrzesylke).toHaveBeenCalledWith(String(SHIPMENT_ID), expect.objectContaining({ id }));
    const p = wiersz(db, id);
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBe(NUMER);
    expect(existsSync(p.etykieta_sciezka)).toBe(true);
    expect(existsSync(p.etykieta_zpl_sciezka)).toBe(true);
    // Notatka do sklepu leci dokładnie tak, jak przy zwykłym nadaniu — klient ma dostać
    // numer listu niezależnie od tego, którą drogą panel go zdobył.
    expect(woo.dodajNotatke).toHaveBeenCalledWith(28045, expect.stringContaining(NUMER));
  });

  // ⚠️ MUTACJA (c): gdyby „Sprawdz ponownie" wolalo `klient.nadaj()`, ten test MUSI paps.
  // U InPostu nie ma zadnej drugiej siatki — referencja duplikatu nie odsiewa.
  it('NIE tworzy przesyłki — nawet klikane dwa razy', async () => {
    const { db, nadanie, przesylkaId, sprawdzPrzesylke, inpostKlient } = await wStanieTworzenia();
    expect(inpostKlient.nadaj).toHaveBeenCalledTimes(1); // wyłącznie pierwotne nadanie

    await nadanie.sprawdzPonownie(przesylkaId);
    // Drugie kliknięcie: przesyłka jest już nadana, więc odmowa — i nadal zero nadań.
    await expect(nadanie.sprawdzPonownie(przesylkaId)).rejects.toThrow(/nie czeka na numer/i);
    expect(inpostKlient.nadaj).toHaveBeenCalledTimes(1);
    expect(sprawdzPrzesylke).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
  });

  it('dwa kliknięcia, gdy numeru wciąż nie ma → dwa zapytania, zero nowych paczek', async () => {
    const sprawdzPrzesylke = vi.fn().mockResolvedValue(wynikWTrakcie());
    const { db, nadanie, przesylkaId, inpostKlient } = await wStanieTworzenia({ sprawdzPrzesylke });

    expect(await nadanie.sprawdzPonownie(przesylkaId)).toMatchObject({ wTrakcieTworzenia: true });
    expect(await nadanie.sprawdzPonownie(przesylkaId)).toMatchObject({ wTrakcieTworzenia: true });
    expect(sprawdzPrzesylke).toHaveBeenCalledTimes(2);
    expect(inpostKlient.nadaj).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
    expect(wiersz(db, 1).status).toBe('w_trakcie');
  });

  it('nieudane sprawdzenie NIE zwalnia miejsca w indeksie', async () => {
    const sprawdzPrzesylke = vi.fn().mockRejectedValue(new Error('InPost nieosiągalny'));
    const { db, nadanie, id, przesylkaId } = await wStanieTworzenia({ sprawdzPrzesylke });

    await expect(nadanie.sprawdzPonownie(przesylkaId)).rejects.toThrow(/nieosiągalny/);
    const p = wiersz(db, id);
    expect(p.status).toBe('w_trakcie');
    expect(p.id_przesylki_kuriera).toBe(String(SHIPMENT_ID));
    expect(p.blad_opis).toMatch(/nieosiągalny/);
    // Nadal nie wolno nadać drugiej paczki.
    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow(/JUŻ ISTNIEJE u kuriera/);
  });

  it('awaria etykiety przy sprawdzaniu zapisuje numer listu, a nie gubi go', async () => {
    const e = bladPoUtworzeniu('InPost nie oddał etykiety PDF (HTTP 500)', { numerListu: NUMER });
    const { db, nadanie, id, przesylkaId } = await wStanieTworzenia({ sprawdzPrzesylke: vi.fn().mockRejectedValue(e) });

    await expect(nadanie.sprawdzPonownie(przesylkaId)).rejects.toThrow(/etykiety PDF/);
    const p = wiersz(db, id);
    expect(p.numer_listu).toBe(NUMER);
    expect(p.status).toBe('do_wyjasnienia');
  });

  it('przy przesyłce nadanej odmawia zamiast cokolwiek robić', async () => {
    const { db, nadanie } = zestaw();
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, paczka);
    await expect(nadanie.sprawdzPonownie(wiersz(db, id).id)).rejects.toThrow(/nie czeka na numer/i);
  });
});

// ---------------------------------------------------------------------------------
// HTTP: karta, ekran nadania i trasa „Sprawdź ponownie"
// ---------------------------------------------------------------------------------
describe('HTTP — paczkomat na karcie zamówienia', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
  const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  const serwer = (nadanie) => buildOmsServer({ db, config, poller, nadanie });

  it('zamówienie bez kodu paczkomatu: karta pokazuje blokadę, a ekran nadania odmawia', async () => {
    const inpost = { nadaj: vi.fn() };
    const katalog = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci: {}, katalogEtykiet: katalog });
    const id = zapiszZamowienie(db, 'pro', zmapowane({ punkt_odbioru: null }), {});
    const app = serwer(nadanie);

    const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).toMatch(/nie ma kodu paczkomatu/);
    expect(karta.body).not.toContain(`href="/zamowienia/${id}/nadaj"`);

    const ekran = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(ekran.statusCode).toBe(400);
    expect(ekran.body).toMatch(/kodu paczkomatu/);
    expect(inpost.nadaj).not.toHaveBeenCalled();
  });

  it('przesyłka bez numeru: karta mówi „tworzona u kuriera" i daje przycisk, który ją domyka', async () => {
    const inpost = {
      nadaj: vi.fn().mockResolvedValue(wynikWTrakcie()),
      sprawdzPrzesylke: vi.fn().mockResolvedValue(wynikGotowy()),
    };
    const katalog = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci: {}, katalogEtykiet: katalog });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await nadanie.nadaj(id, paczka);
    const przesylkaId = wiersz(db, id).id;
    const app = serwer(nadanie);

    const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).toMatch(/tworzona u kuriera/i);
    expect(karta.body).toContain(`/zamowienia/${id}/przesylki/${przesylkaId}/sprawdz`);
    expect(karta.body).toMatch(/Sprawdź ponownie/);

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${przesylkaId}/sprawdz`, headers: naglowek,
    });
    expect(r.statusCode).toBe(302);
    expect(inpost.nadaj).toHaveBeenCalledTimes(1);
    expect(wiersz(db, id).numer_listu).toBe(NUMER);
    // Etykieta trafia do kolejki druku — dokładnie tak, jak przy udanym nadaniu.
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku').get().c).toBe(1);
  });

  it('„Sprawdź ponownie" przy cudzej przesyłce dostaje 404, a nie operację na cudzym wierszu', async () => {
    const inpost = { nadaj: vi.fn(), sprawdzPrzesylke: vi.fn() };
    const katalog = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci: {}, katalogEtykiet: katalog });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const app = serwer(nadanie);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/999/sprawdz`, headers: naglowek });
    expect(r.statusCode).toBe(404);
    expect(inpost.sprawdzPrzesylke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------
// ZADANIE 7 — ekran nadania (gabaryt zamiast wymiarów, kod paczkomatu edytowalny)
// i karta zamówienia (punkt odbioru w „Szczegółach", nazwa metody ze słownika).
// ---------------------------------------------------------------------------------
describe('Zadanie 7 — ekran nadania dla paczkomatu', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
  const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  function zestawHttp({ inpostKlient, nad = {} } = {}) {
    const inpost = inpostKlient ?? { nadaj: vi.fn().mockResolvedValue(wynikGotowy()) };
    const katalog = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci: {}, katalogEtykiet: katalog });
    const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
    const app = buildOmsServer({ db, config, poller, nadanie });
    return { app, id, inpost };
  }

  it('ma wybór gabarytu A/B/C, z domyślnie zaznaczonym A', async () => {
    const { app, id } = zestawHttp();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    // Trzy opcje, z opisem wymiarów przy literze (jak w Apilo) — operator nie pamięta liter.
    expect(r.body).toContain('name="gabaryt" value="A"');
    expect(r.body).toContain('name="gabaryt" value="B"');
    expect(r.body).toContain('name="gabaryt" value="C"');
    expect(r.body).toMatch(/Gabaryt A \(8[^)]*38[^)]*64[^)]*\)/);
    // ⚠️ MUTACJA (a): domyślny gabaryt zamieniony z A na inny musi zaczerwienić ten test.
    expect(r.body).toContain('name="gabaryt" value="A" checked');
    expect(r.body).not.toContain('name="gabaryt" value="B" checked');
    expect(r.body).not.toContain('name="gabaryt" value="C" checked');
  });

  it('NIE pokazuje pól wymiarów (długość/szerokość/wysokość) — InPost ich nie przyjmuje', async () => {
    const { app, id } = zestawHttp();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    // ⚠️ MUTACJA (b): pokazanie pól wymiarów także dla paczkomatu musi zaczerwienić ten test.
    expect(r.body).not.toContain('name="dlugosc"');
    expect(r.body).not.toContain('name="szerokosc"');
    expect(r.body).not.toContain('name="wysokosc"');
    // Waga zostaje polem liczbowym, tak jak przy DPD.
    expect(r.body).toContain('name="waga"');
  });

  it('kod paczkomatu jest widoczny, edytowalny i wstępnie wypełniony, z opisem lokalizacji obok', async () => {
    const { app, id } = zestawHttp();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="punkt_odbioru" value="SLN06M"');
    expect(r.body).toContain('Przy myjni bezdotykowej');
  });

  // Plan „ekran nadania" (Zadanie Z1), §2: adres pocztowy NIE WOLNO usunąć z formularza,
  // nawet przy paczkomacie — `parsujAdresOdbiorcy` (POST) odmawia przy pustej ulicy/
  // kodzie/mieście dla KAŻDEJ metody. Na makiecie pola schodzą do `<details>` (schowane
  // z oczu, bo do paczkomatu nie jadą), ale zostają prawdziwymi polami formularza.
  it('adres pocztowy (ulica/kod/miasto) zostaje w formularzu, schowany w <details>', async () => {
    const { app, id } = zestawHttp();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="ulica"');
    expect(r.body).toContain('name="kod"');
    expect(r.body).toContain('name="miasto"');
    expect(r.body).toContain('value="Polna 1"');
    expect(r.body).toContain('value="00-650"');
    expect(r.body).toContain('<details');
    expect(r.body).toContain('</details>');
  });

  it('POST z poprawionym gabarytem i wagą → InPost dostaje TE wartości', async () => {
    const inpost = { nadaj: vi.fn().mockResolvedValue(wynikGotowy()) };
    const { app, id } = zestawHttp({ inpostKlient: inpost });
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { waga: '2.5', gabaryt: 'B', kolejnosc: '1', nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL', punkt_odbioru: 'SLN06M' },
    });
    expect(r.statusCode).toBe(302);
    expect(inpost.nadaj).toHaveBeenCalledTimes(1);
    expect(inpost.nadaj.mock.calls[0][0].paczka).toEqual({ waga: 2.5, gabaryt: 'B' });
  });

  // Operator poprawia kod paczkomatu NA TYM EKRANIE (klient bywa, że podał go w uwagach) —
  // poprawka leci do kuriera od razu, bez wcześniejszego zapisu w „Szczegółach zamówienia".
  it('POST z POPRAWIONYM kodem paczkomatu → InPost dostaje kod z formularza, nie z zamówienia', async () => {
    const inpost = { nadaj: vi.fn().mockResolvedValue(wynikGotowy()) };
    const { app, id } = zestawHttp({ inpostKlient: inpost });
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { waga: '1', gabaryt: 'A', kolejnosc: '1', nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL', punkt_odbioru: 'wro10b' },
    });
    expect(r.statusCode).toBe(302);
    expect(inpost.nadaj.mock.calls[0][0].punktOdbioru).toBe('WRO10B');
  });

  it('POST bez wybranego gabarytu → 400, czytelny komunikat, InPost NIETKNIĘTY', async () => {
    const inpost = { nadaj: vi.fn() };
    const { app, id } = zestawHttp({ inpostKlient: inpost });
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { waga: '1', kolejnosc: '1', nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL', punkt_odbioru: 'SLN06M' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/gabaryt/i);
    expect(inpost.nadaj).not.toHaveBeenCalled();
  });

  it('POST z nieznaną literą gabarytu → 400, żadna przesyłka nie powstaje', async () => {
    const inpost = { nadaj: vi.fn() };
    const { app, id } = zestawHttp({ inpostKlient: inpost });
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { waga: '1', gabaryt: 'Z', kolejnosc: '1', nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL', punkt_odbioru: 'SLN06M' },
    });
    expect(r.statusCode).toBe(400);
    expect(inpost.nadaj).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(0);
  });
});

describe('Zadanie 7 — karta zamówienia pokazuje punkt odbioru', () => {
  const config = { auth: { user: 'adam', pass: 'x' } };
  const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
  const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  it('sekcja „Szczegóły zamówienia" pokazuje kod punktu odbioru i opis lokalizacji', async () => {
    const inpost = { nadaj: vi.fn() };
    const katalog = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci: {}, katalogEtykiet: katalog });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const app = buildOmsServer({ db, config, poller, nadanie });

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    const i = r.body.indexOf('<span>Punkt odbioru</span>');
    expect(i, 'karta musi mieć wiersz „Punkt odbioru”').toBeGreaterThan(-1);
    const pole = r.body.slice(i, r.body.indexOf('</div>', i));
    expect(pole).toContain('SLN06M');
    expect(pole).toContain('Przy myjni bezdotykowej');
  });

  // ⚠️ MUTACJA (c) z briefu Zadania 7: gdyby karta wypisała surową wartość kolumny metody
  // (`inpost_paczkomat`) zamiast nazwy ze słownika ETYKIETY_WYSYLKI, ten test musi paść.
  // Dokładnie ta usterka wróciła raz przy przebudowie belki (I5) — patrz komentarz
  // w domain/wysylka.js i test-bliźniak w web-zamowienie.test.js dla odbioru osobistego.
  it('nazwa metody na karcie to „InPost Paczkomat”, nie surowa wartość kolumny', async () => {
    const inpost = { nadaj: vi.fn() };
    const katalog = mkdtempSync(join(tmpdir(), 'oms-inpost-'));
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci: {}, katalogEtykiet: katalog });
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const app = buildOmsServer({ db, config, poller, nadanie });

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    const i = r.body.indexOf('<span>Metoda wysyłki</span>');
    expect(i, 'karta musi mieć wiersz „Metoda wysyłki”').toBeGreaterThan(-1);
    const pole = r.body.slice(i, r.body.indexOf('</div>', i));
    expect(pole).toContain('InPost Paczkomat');
    expect(pole).not.toContain('inpost_paczkomat');
  });
});

// ---------------------------------------------------------------------------------
// OKABLOWANIE
// ---------------------------------------------------------------------------------
describe('zbudujOms — InPost w mapie kurierów', () => {
  const katalogEtykiet = () => mkdtempSync(join(tmpdir(), 'oms-boot-'));
  const PELNE = {
    OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x', OMS_DB_PATH: ':memory:',
    SHOP_PRO_URL: 'https://pro.szkicownia.test', SHOP_PRO_CK: 'ck', SHOP_PRO_CS: 'cs',
    DPD_URL: 'https://dpd/api', DPD_LOGIN: '99999999', DPD_PASSWORD: 'tajne', DPD_FID: '278216',
    DPD_NADAWCA_NAZWA: 'Lumina Marek Zywiecki', DPD_NADAWCA_ULICA: 'ul. 1 Maja 5',
    DPD_NADAWCA_KOD: '00-650', DPD_NADAWCA_MIASTO: 'Pęki',
    DPD_INFO_URL: 'https://dpd/info', DPD_INFO_CHANNEL: '278216',
  };
  const env = (nad = {}) => ({ ...PELNE, OMS_ETYKIETY_DIR: katalogEtykiet(), ...nad });
  const atrapaDpd = () => vi.fn(() => ({ nadaj: vi.fn() }));

  it('z sekcją INPOST_* klient powstaje i dostaje adres nadawcy z konfiguracji', () => {
    const createInpost = vi.fn(() => ({ nadaj: vi.fn(), sprawdzPrzesylke: vi.fn() }));
    const { inpost, nadanie, config } = zbudujOms({
      env: env({ INPOST_TOKEN: TOKEN, INPOST_ORGANIZACJA: '13235' }), createDpd: atrapaDpd(), createInpost,
    });
    expect(inpost).not.toBeNull();
    expect(nadanie).not.toBeNull();
    expect(createInpost).toHaveBeenCalledWith(expect.objectContaining({
      token: TOKEN, organizacja: 13235, nadawca: config.nadawca,
    }));
    // ⚠️ TEN SAM obiekt nadawcy, co u DPD — nie kopia, ktora rozjedzie sie po pierwszej poprawce.
    expect(config.nadawca).toBe(config.dpd.nadawca);
  });

  it('bez sekcji INPOST_* panel wstaje normalnie, a paczkomat jest metodą nieobsługiwaną', async () => {
    const createInpost = vi.fn();
    const { app, inpost, nadanie, db } = zbudujOms({ env: env(), createDpd: atrapaDpd(), createInpost });
    expect(inpost).toBeNull();
    expect(createInpost).not.toHaveBeenCalled();
    expect(nadanie).not.toBeNull();
    expect(app).toBeTruthy();

    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    await expect(nadanie.nadaj(id, paczka)).rejects.toThrow(/inpost.*nie jest skonfigurowany/i);
  });

  // ⚠️ Nadanie do paczkomatu trwa nawet ~150 s (odpytywanie o numer + limity zadan).
  // Limit czasu zadania w serwerze MUSI to zniesc: przerwane w polowie zostawiloby paczke
  // utworzona u kuriera i operatora przekonanego, ze nic sie nie stalo.
  it('serwer nie ma limitu czasu żądania — najdłuższe nadanie musi się zmieścić', () => {
    const { app } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(app.initialConfig.requestTimeout).toBe(0);
  });
});

// ——— TARYFA I PACZKOMAT NADAWCZY (2026-08-07) ————————————————————————————————————————
//
// ⚠️⚠️ TEN BLOK POWSTAL Z PRAWDZIWEJ POMYLKI, KTORA KOSZTOWALA PIENIADZE. Panel wysylal
// `service: 'inpost_locker_standard'` NA SZTYWNO — poprawnie, dopoki nadawal wylacznie
// paczkomaty ZE SKLEPU. Pierwszy paczkomat z ALLEGRO pojechal przez to na taryfie
// standardowej zamiast allegrowej (przesylka 6000000001, zam. 1126, 07.08 o 12:25)
// i wlasciciel musial ja anulowac.
//
// Sprawdzane NA PRAWDZIWYM KLIENCIE z atrapa `fetch`, a nie na atrapie klienta: cala rzecz
// polega na tym, CO NAPRAWDE LADUJE W CIELE ZADANIA do ShipX. Atrapa klienta nie wykrylaby
// tego nigdy — obie strony klamalyby zgodnie (ta sama lekcja, co przy KSeF tego samego dnia).
describe('usługa ShipX i paczkomat nadawczy w ciele żądania', () => {
  // ⚠️ SUROWA ODPOWIEDZ ALLEGRO IDZIE CZWARTYM ARGUMENTEM `zapiszZamowienie`, a nie w srodku
  // zmapowanego zamowienia — pierwsza wersja tego testu wkladala ja do `nad` i test byl
  // ZIELONY dla wariantu „bez Smart", bo `surowe_json` zostawalo puste. Czyli mierzylby
  // domyslke, nie regule.
  const zPrawdziwymKlientem = ({ paczkomatNadawczy, sklep = 'szkicownia', nad = {}, surowe: raw = {} } = {}) => {
    const cialaZadan = [];
    const fetchImpl = vi.fn(async (adres, opcje) => {
      if (String(adres).includes('format=pdf')) return { status: 200, ok: true, arrayBuffer: async () => Buffer.from(PDF, 'latin1') };
      if (String(adres).includes('format=zpl')) return { status: 200, ok: true, arrayBuffer: async () => Buffer.from(ZPL, 'latin1') };
      if (opcje?.body) cialaZadan.push(JSON.parse(opcje.body));
      return { status: 201, ok: true, text: async () => JSON.stringify({ id: SHIPMENT_ID, tracking_number: NUMER }) };
    });
    const inpostKlient = createInpostClient({
      url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca: NADAWCA, paczkomatNadawczy, fetchImpl,
    });
    const { db, nadanie } = zestaw({ inpostKlient });
    const id = zapiszZamowienie(db, sklep, zmapowane(nad), raw);
    return { db, nadanie, id, cialaZadan };
  };

  const dostawa = (smart) => ({ delivery: { smart } });

  it('zamówienie ze sklepu jedzie na taryfie standardowej — bez zmiany', async () => {
    const { nadanie, id, cialaZadan } = zPrawdziwymKlientem();
    await nadanie.nadaj(id, paczka);
    expect(cialaZadan[0].service).toBe('inpost_locker_standard');
  });

  // ⚠️ SEDNO ZGLOSZENIA: „Paczka paczkomat allegro nadawana ma byc przez OMS […] ma nadawac
  // SMART paczki". Zmierzone dwustronnie — zamowienie z `delivery.smart: true` i paczkomatem
  // TYCS01M ma po stronie InPostu przesylke `inpost_locker_allegro_smart` z tym samym punktem.
  it('paczkomat z Allegro ze Smart! jedzie na taryfie allegro_smart', async () => {
    const { nadanie, id, cialaZadan } = zPrawdziwymKlientem({
      sklep: 'allegro_szkicownia',
      nad: { metoda_wysylki: 'allegro_paczkomat' }, surowe: dostawa(true),
    });
    await nadanie.nadaj(id, paczka);
    expect(cialaZadan[0].service).toBe('inpost_locker_allegro_smart');
  });

  it('paczkomat z Allegro bez Smart! jedzie na taryfie allegro zwykłej', async () => {
    const { nadanie, id, cialaZadan } = zPrawdziwymKlientem({
      sklep: 'allegro_szkicownia',
      nad: { metoda_wysylki: 'allegro_paczkomat' }, surowe: dostawa(false),
    });
    await nadanie.nadaj(id, paczka);
    expect(cialaZadan[0].service).toBe('inpost_locker_allegro');
  });

  // ⚠️ Paczkomat NADAWCZY (gdzie zostawiamy paczke) to co innego niz paczkomat ODBIORCZY
  // (dokad jedzie). Pomylenie ich znaczyloby paczke wyslana do naszego wlasnego automatu.
  it('paczkomat nadawczy jedzie jako dropoff_point, obok target_point odbiorcy', async () => {
    const { nadanie, id, cialaZadan } = zPrawdziwymKlientem({ paczkomatNadawczy: 'KTY01M' });
    await nadanie.nadaj(id, paczka);
    expect(cialaZadan[0].custom_attributes.dropoff_point).toBe('KTY01M');
    expect(cialaZadan[0].custom_attributes.target_point).toBe('SLN06M');
  });

  // ⚠️ NIEOBOWIAZKOWY I TAKI MA ZOSTAC: brak konfiguracji znaczy „nie wysylamy pola", czyli
  // DOKLADNIE dawne zachowanie. Zamowienie nie ma prawa nie dac sie nadac dlatego, ze ktos
  // nie dopisal zmiennej srodowiskowej — to informacja o wygodzie nadania, nie o taryfie.
  it('bez skonfigurowanego paczkomatu nadawczego pola NIE MA w ogóle', async () => {
    const { nadanie, id, cialaZadan } = zPrawdziwymKlientem();
    await nadanie.nadaj(id, paczka);
    expect(Object.hasOwn(cialaZadan[0].custom_attributes, 'dropoff_point')).toBe(false);
  });
});
