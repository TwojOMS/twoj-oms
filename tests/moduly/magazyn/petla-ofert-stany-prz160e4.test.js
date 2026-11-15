import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { przelaczStany, przelacznikStanow, zapiszOtwarcie, migawkaStanow, wyjasnieniaOfert, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';
import { wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta, zapiszZatwierdzenieStanow } from '../../../src/oms/db/oferty-kanalow.ts';
import { trescOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';
import { createPetlaOfert, skrotTresci } from '../../../src/moduly/magazyn/services/petla-ofert.js';
import { readFileSync } from 'node:fs';
import { przygotujErli } from '../../pomoc/e4-blizniak.js';

vi.mock('../../../src/oms/db/stany-magazynowe.js', async original => {
  const m = await original();
  return { ...m, migawkaStanow: vi.fn(m.migawkaStanow), wyjasnieniaOfert: vi.fn(m.wyjasnieniaOfert) };
});
const prawdziwe = await vi.importActual('../../../src/oms/db/stany-magazynowe.js');

const T0 = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:00:00.000Z';
const KLUCZ = 'erli-polcien';
let db, produkty, paczki, ustawienia, petla, czekaj, czas, przedBatchem, odpowiedzBatcha, przyOdczycie, logi, tylkoOdczyt, wystawienia;
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  vi.mocked(migawkaStanow).mockClear();
  vi.mocked(wyjasnieniaOfert).mockReset().mockImplementation(prawdziwe.wyjasnieniaOfert);
  produkty = new Map(); paczki = []; czas = Date.parse('2026-11-14T12:00:00Z');
  przedBatchem = () => {}; odpowiedzBatcha = null; przyOdczycie = () => {};
  logi = []; tylkoOdczyt = false;
  wystawienia = [];
  ustawienia = zapiszUstawieniaOfertKonta(db, KLUCZ, { czynne: true, stalaIlosc: 8, narzutProcent: 0,
    progPotwierdzeniaProcent: 100, czasWysylkiDni: 2, cennikDostaw: 'Lampy', stawkaVat: '23' });
  czekaj = vi.fn(async () => {});
  petla = createPetlaOfert({ db, teraz: () => new Date(czas), pollerMs: 120000, czekaj, log: tekst => logi.push(tekst),
    konta: () => [{ klucz: KLUCZ, tylkoOdczyt: () => tylkoOdczyt, katalog: {
      odczytOfert: async ({ pagination }) => (przyOdczycie(), { ok: true, dane: [...produkty.values()].filter(p => !pagination.after || p.externalId > pagination.after).sort((a,b) => a.externalId.localeCompare(b.externalId)).slice(0,100) }),
      zmienOferte: vi.fn(async () => ({ ok: true, dane: {} })),
      wystawOferte: async (externalId, cialo) => { wystawienia.push(cialo); return { ok: true, dane: { externalId } }; },
      zmienIloscCene: async lista => {
        przedBatchem(lista);
        paczki.push(lista);
        if (odpowiedzBatcha) return odpowiedzBatcha(lista);
        for (const p of lista) produkty.set(p.externalId, { ...produkty.get(p.externalId), ...p });
        return { ok: true, dane: lista.map(p => ({ externalId: p.externalId })) };
      },
    } }] });
});
afterEach(() => db.close());
function wlacz(zatwierdz = true) {
  przelaczStany(db, { wlacz: true, at: T0 });
  if (zatwierdz) zapiszZatwierdzenieStanow(db, { przelaczenieId: 1, zatwierdzil: 'operator', ofert: 1, skrot: 'test' }, { teraz: T1 });
}
function oferta({ stan = 5, odczyt = 8, obserwowana = false, poprzednia = null } = {}) {
  const kartaId = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: `LMP-${produkty.size}`, cena_gr: 10000, stawka_vat: '23' });
  db.prepare("INSERT INTO zdjecia_kart (karta_id,kolejnosc,zrodlo,adres_zrodlowy,utworzono_at) VALUES (?,0,'woo','https://polcien.example/lampa.png',?)").run(kartaId,T0);
  if (stan !== null) zapiszOtwarcie(db, { kartaId, ilosc: stan, zrodlo: 'reczne', at: T1 });
  const externalId = `LMP-${String(kartaId).padStart(4,'0')}`;
  const o = wstawOferte(db, { kartaId, kanal: KLUCZ, idZewnetrzne: externalId, stan: 'aktywna', tryb: obserwowana ? 'obserwowana' : 'zarzadzana' });
  const { cialo } = trescOferty(db,kartaId,ustawienia);
  produkty.set(externalId,{ ...cialo, externalId, stock: odczyt, status: 'active' });
  zmienOferte(db,o.id,{ wyslanySkrot: skrotTresci(cialo), iloscZOms: obserwowana,
    ...(poprzednia ?? {}) });
  return o;
}
const wiersz = o => ofertaPoId(db,o.id);
function puls(at = '2026-11-14T11:59:00Z') {
  db.prepare('INSERT OR REPLACE INTO stan_pollera (sklep,ostatni_przebieg_at) VALUES (?,?)').run(KLUCZ,at);
}

it('zarządzana i obserwowana: stan minus bufor; obserwowana wysyła tylko stock', async () => {
  wlacz();
  ustawienia = zapiszUstawieniaOfertKonta(db,KLUCZ,{ buforSzt: 1 });
  oferta(); oferta({ obserwowana: true });
  await petla.przebieg();
  expect(paczki.flat()).toEqual([{ externalId:'LMP-0001',stock:4 },{ externalId:'LMP-0002',stock:4 }]);
});
it('bez zatwierdzenia cena wychodzi bez stock i bez stanu problem', async () => {
  wlacz(false); const o = oferta();
  db.prepare('UPDATE karty_produktow SET cena_gr=11000 WHERE id=?').run(o.kartaId);
  await petla.przebieg();
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,price:11000}]);
  expect(wiersz(o).stan).toBe('aktywna');
  expect(wiersz(o).iloscProblem?.kod).toBe('stany-niezatwierdzone');
});
it('brak otwarcia nie daje zera, otwarcie z zerem wysyła stock 0', async () => {
  wlacz(); const brak = oferta({stan:null}); oferta({stan:0});
  await petla.przebieg();
  expect(wiersz(brak).iloscProblem?.kod).toBe('brak-stanu');
  expect(paczki.flat()).toEqual([{externalId:'LMP-0002',stock:0}]);
});
it('skok po przepięciu blokuje tylko jedną ofertę', async () => {
  wlacz(); const o = oferta({stan:2,poprzednia:{stanKartyWyslany:10,iloscWyslanaAt:'2026-11-14T10:00:00Z'}}); oferta();
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok'); expect(paczki.flat()).toHaveLength(1);
});
it('rozjazd w górę alarmuje i obniża w tym samym przebiegu', async () => {
  wlacz(); const o = oferta({odczyt:11,poprzednia:{wyslanaIlosc:8,iloscWyslanaAt:T1}});
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('rozjazd-gora'); expect(paczki.flat()[0].stock).toBe(5);
});
it('rozjazd w dół: karencja nie podnosi, po pulsie alarm i nadal zero zapisów', async () => {
  wlacz(); const o = oferta({stan:8,odczyt:5,poprzednia:{wyslanaIlosc:8,iloscWyslanaAt:T1}});
  await petla.przebieg(); expect(wiersz(o).iloscProblem?.kod).toBe('karencja'); expect(paczki).toEqual([]);
  czas += 300000; puls('2026-11-14T12:03:00Z');
  await petla.przebieg(); expect(wiersz(o).iloscProblem?.kod).toBe('rozjazd-dol'); expect(paczki).toEqual([]);
});
it('3 z 5 do zera zatrzymuje ilość konta', async () => {
  wlacz(); const oferty = Array.from({length:5},(_,i) => oferta({stan:i<3?0:5}));
  await petla.przebieg(); expect(paczki).toEqual([]);
  for (const o of oferty.slice(0,3)) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
});
// E4.30: „Wyślij zera” jest jednorazowe na ofertę — tak samo jak trasa ekranu (problemy-ofert.js).
const potwierdzZera = lista => { for (const o of lista) zmienOferte(db, o.id, { iloscProblem: null,
  wyslanePola: { ...wiersz(o).wyslanePola, zeraPotwierdzone: { login: 'operator', at: '2026-11-14T12:00:30Z',
    przelaczenieId: przelacznikStanow(db).przelaczenieId } } }); };
it('E4.30: „Wyślij zera” — następny przebieg zapisuje 3 zera, potem flaga znika i nowe masowe zero znów staje', async () => {
  wlacz(); const oferty = Array.from({length:6},(_,i) => oferta({stan:i<3?0:5}));
  const [zera, inne] = [oferty.slice(0,3), oferty.slice(3)];
  await petla.przebieg(); expect(paczki).toEqual([]);
  for (const o of zera) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  potwierdzZera(zera);
  await petla.przebieg();
  expect(paczki.flat().filter(p => p.stock === 0).map(p => p.externalId).sort()).toEqual(zera.map(o => o.idZewnetrzne).sort());
  for (const o of zera) { expect(wiersz(o).iloscProblem).toBeNull(); expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined(); }
  paczki = [];
  await petla.przebieg();
  expect(paczki).toEqual([]);
  for (const o of zera) expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined();
  for (const [i,o] of inne.entries()) dodajRuch(db,{kartaId:o.kartaId,rodzaj:'korekta',ilosc:-5,klucz:`e430-erli-${i}`,at:new Date(czas).toISOString()});
  await petla.przebieg();
  expect(paczki).toEqual([]);
  for (const o of inne) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
});
// E4.30p (B1 recenzji): potwierdzenie sprzed wyłączenia stanów nie omija zera masowego po ponownym włączeniu.
it('E4.30p: „Wyślij zera”, wyłączenie stanów, ponowne włączenie → 6/6 zero-masowe, 0 zapisów 0', async () => {
  wlacz(); const oferty = Array.from({length:6},(_,i) => oferta({stan:i<3?0:5}));
  await petla.przebieg(); potwierdzZera(oferty.slice(0,3));
  const iso = () => new Date(czas).toISOString();
  czas += 60000; przelaczStany(db, { wlacz: false, at: iso() });
  await petla.przebieg(); expect(paczki).toEqual([]);
  czas += 7 * 24 * 3600_000; przelaczStany(db, { wlacz: true, at: iso() });
  const { przelaczenieId } = przelacznikStanow(db); expect(przelaczenieId).not.toBe(1);
  zapiszZatwierdzenieStanow(db, { przelaczenieId, zatwierdzil: 'operator', ofert: 6, skrot: 'test' }, { teraz: iso() });
  for (const o of oferty) zapiszOtwarcie(db, { kartaId: o.kartaId, ilosc: 0, zrodlo: 'reczne', at: iso() });
  await petla.przebieg();
  expect(paczki.flat().filter(p => p.stock === 0)).toEqual([]);
  for (const o of oferty) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  for (const o of oferty.slice(0,3)) expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined();
});
// E4.31 (N1 recenzji E4.30p): zero masowe zależy od ofert z nieważną flagą — bez nich 2 zera z 4 nie przekraczają progu.
it('E4.31: 6 ofert, 2 z nieważną flagą i 2 inne do zera → zero masowe, 0 zapisów 0', async () => {
  wlacz(); const oferty = Array.from({length:6},(_,i) => oferta({stan:i<4?0:5}));
  for (const o of oferty.slice(0,2)) zmienOferte(db, o.id, { wyslanePola: { ...wiersz(o).wyslanePola,
    zeraPotwierdzone: { login: 'operator', at: '2026-11-14T12:00:30Z', przelaczenieId: 999 } } });
  await petla.przebieg();
  expect(paczki.flat().filter(p => p.stock === 0)).toEqual([]);
  for (const o of oferty.slice(0,4)) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
});
// E4.32a (uwaga 1 recenzji odbiorczej): mianownik zera masowego tylko z ofert, które sprzedają (jak B4 w Allegro).
it('E4.32a: 4 aktywne do zera + 5 szkiców/błędów/do_wyslania → zero-masowe na czterech, 0 zapisów 0', async () => {
  wlacz(); const aktywne = Array.from({length:4},() => oferta({stan:0}));
  const reszta = ['szkic','szkic','blad','blad','do_wyslania'].map(stan => {
    const o = oferta({stan:null}); zmienOferte(db, o.id, { stan });
    if (stan === 'do_wyslania') produkty.delete(o.idZewnetrzne);
    return o;
  });
  await petla.przebieg();
  expect(paczki.flat().filter(p => p.stock === 0)).toEqual([]);
  for (const o of aktywne) expect(wiersz(o).iloscProblem?.kod).toBe('zero-masowe');
  for (const o of reszta) expect(wiersz(o).iloscProblem?.kod).not.toBe('zero-masowe');
});
it('E4.30: potwierdzenie znika bez zapisu, gdy odczyt już jest 0 albo cel wzrósł', async () => {
  wlacz(); const juzZero = oferta({stan:0,odczyt:0}); const wzrosl = oferta({stan:5,odczyt:5});
  potwierdzZera([juzZero, wzrosl]);
  await petla.przebieg();
  expect(paczki).toEqual([]);
  for (const o of [juzZero, wzrosl]) expect(wiersz(o).wyslanePola?.zeraPotwierdzone).toBeUndefined();
});
it('ujemny odczyt zachowany; pierwsza podwyżka czeka, druga po pulsie wysyła zero', async () => {
  wlacz(); const o = oferta({stan:0,odczyt:-2});
  await petla.przebieg(); expect(paczki).toEqual([]); expect(wiersz(o).odczytIloscKanalu).toBe(-2);
  czas += 300000; puls('2026-11-14T12:03:00Z');
  await petla.przebieg(); expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:0}]);
});
it('230 zmian: trzy paczki po najwyżej 100 i przerwy, obniżki pierwsze', async () => {
  wlacz(); puls();
  for (let i=0;i<230;i++) oferta({odczyt:i<30?2:8,poprzednia:{odczytIloscKanalu:i<30?2:8,odczytanoAt:T1}});
  await petla.przebieg();
  expect(paczki.map(p=>p.length)).toEqual([100,100,30]);
  expect(czekaj.mock.calls).toEqual([[1000],[1000]]);
  expect(paczki[0][0].externalId).toBe('LMP-0031');
  expect(paczki[2][0].externalId).toBe('LMP-0001');
  expect(migawkaStanow).toHaveBeenCalledTimes(1);
});
it('restart po przyjęciu batcha odtwarza W/T i czyści w toku bez alarmu', async () => {
  wlacz(); const o = oferta({stan:4,odczyt:5,poprzednia:{wyslanaIlosc:8,iloscWyslanaAt:T1,iloscWToku:{cel:5,at:T1}}});
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({wyslanaIlosc:4,iloscWToku:null,iloscProblem:null});
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:4}]);
});
it('zamrożona ilość ma osobny trwały problem', async () => {
  wlacz(); const o = oferta(); produkty.get(o.idZewnetrzne).frozen=['stock'];
  await petla.przebieg(); expect(wiersz(o).iloscProblem?.kod).toBe('zamrozona-ilosc'); expect(paczki).toEqual([]);
});
it.each(['i','ii','iii'])('bliźniak (%s): bajt w bajt baza, jeden batch na przebieg', async wariant => {
  const z = await przygotujErli({wariant:wariant==='iii'?'ii':wariant});
  try {
    if (wariant==='iii') {
      const off = z.db.prepare('SELECT * FROM magazyn_przelaczenia ORDER BY id DESC LIMIT 1').get();
      const on = z.db.prepare('SELECT * FROM magazyn_przelaczenia WHERE wlaczone=1 ORDER BY id DESC LIMIT 1').get();
      z.db.prepare('DELETE FROM magazyn_przelaczenia WHERE id=?').run(off.id);
      zapiszZatwierdzenieStanow(z.db,{przelaczenieId:Number(on.id),zatwierdzil:'operator',ofert:120,skrot:'test'},
        {teraz:new Date(Date.parse(on.utworzono_at)+60000).toISOString()});
      przelaczStany(z.db,{wlacz:false,at:off.utworzono_at});
    }
    await z.przebiegi();
    expect(z.nagr.tekst()).toBe(readFileSync(new URL('../../fixtures/e4-blizniak-erli.json',import.meta.url),'utf8'));
    for (const n of [1,2,3]) expect(z.nagr.zadania.filter(z=>z.przebieg===n && z.sciezka.endsWith('batch-update'))).toHaveLength(1);
  } finally { z.zamknij(); }
});
it('mieszany batch ceny zarządzanej i ilości obserwowanej przechodzi bramkę', async () => {
  wlacz(); const o = oferta(); oferta({obserwowana:true});
  db.prepare('UPDATE karty_produktow SET cena_gr=11000 WHERE id=?').run(o.kartaId);
  await petla.przebieg();
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:5,price:11000},{externalId:'LMP-0002',stock:5}]);
});
it('zakup Woo 2 sztuki obniża ERLI; anulowanie podnosi po stabilnym odczycie i pulsie', async () => {
  wlacz(); const o = oferta({stan:8,odczyt:8});
  powiazProdukt(db,zapiszProduktSklepowy(db,{kanal:'woo-polcien',produkt_id:'lampa-1',nazwa:'Lampa Półcień',odczytane_at:T1}),o.kartaId);
  const id = zapiszZamowienie(db,'woo-polcien',{zrodlo_id:'woo-1',numer:'W-1',klient:{},dostawa:{},
    utworzone_at:'2026-11-14T10:00:00Z',kwota_brutto:'20.00',metoda_wysylki:'odbior',chce_fakture:0,
    kwota_pobrania:null,nip:null,oplacone_at:null,
    status_woo:'processing',anulowane:0,pozycje:[{zrodlo_id:'p1',produkt_id:'lampa-1',wariant_id:null,oferta_id:null,sku:null,zdjecie_url:null,nazwa:'Lampa Półcień',ilosc:2,cena_brutto:'10.00',vat:'23'}]},{});
  db.prepare('UPDATE zamowienia SET zmienione_at=? WHERE id=?').run('2026-11-14T10:00:00Z',id);
  await petla.przebieg(); expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:6}]);
  expect(wiersz(o)).toMatchObject({wyslanaIlosc:6,stanKartyWyslany:6,iloscWToku:null});
  db.prepare("UPDATE zamowienia SET anulowane=1,status_woo='cancelled',zmienione_at=? WHERE id=?").run('2026-11-14T12:01:00Z',id);
  czas += 60000; await petla.przebieg(); expect(paczki).toHaveLength(1);
  puls('2026-11-14T12:04:00Z'); czas += 240000;
  await petla.przebieg(); expect(paczki.flat().at(-1)).toEqual({externalId:o.idZewnetrzne,stock:8});
});
it('przyspiesz pamięta zmianę podczas przebiegu i zachowuje odstęp 60 s', async () => {
  vi.useFakeTimers();
  try {
    wlacz(); oferta();
    const przebieg = petla.przebieg(); petla.przyspiesz(); await przebieg;
    expect(paczki).toHaveLength(1);
    czas += 59999; await vi.advanceTimersByTimeAsync(59999);
    expect(paczki).toHaveLength(1);
    // Cel z poprzedniego zapisu został ręcznie zmieniony, aby zobaczyć następny przebieg.
    produkty.get('LMP-0001').stock=8;
    czas++; await vi.advanceTimersByTimeAsync(1);
    expect(paczki).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});
it('przed wywołaniem batcha zapisuje cel i próbę, po sukcesie stan karty i czas', async () => {
  wlacz(); const o = oferta();
  przedBatchem = () => expect(wiersz(o)).toMatchObject({liczbaProb:1,iloscWToku:{cel:5,at:new Date(czas).toISOString()}});
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({liczbaProb:0,iloscWToku:null,stanKartyWyslany:5,iloscWyslanaAt:new Date(czas).toISOString()});
});
it('obserwowana respektuje termin ponowienia', async () => {
  wlacz(); const o = oferta({obserwowana:true,poprzednia:{liczbaProb:1,nastepnaProbaAt:'2026-11-14T12:01:00Z'}});
  await petla.przebieg(); expect(paczki).toEqual([]);
  czas += 60000; await petla.przebieg(); expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:5}]);
});
it('normalny przebieg zastępuje oczekujące przyspieszenie', async () => {
  vi.useFakeTimers();
  try {
    wlacz(); oferta(); await petla.przebieg();
    petla.przyspiesz(); czas += 30000; await vi.advanceTimersByTimeAsync(30000);
    await petla.przebieg();
    const n = vi.mocked(migawkaStanow).mock.calls.length;
    czas += 30000; await vi.advanceTimersByTimeAsync(30000);
    expect(migawkaStanow).toHaveBeenCalledTimes(n);
  } finally { vi.useRealTimers(); }
});
it('log przebiegu liczy rzeczywiste żądania, również dla pustego konta i tylko odczytu', async () => {
  await petla.przebieg();
  expect(logi).toEqual([`oferty-erli: konto ${KLUCZ}: batch 0, stock 0, cena 0`]);
  wlacz(); oferta(); tylkoOdczyt = true; logi.length = 0;
  await petla.przebieg();
  expect(logi).toEqual([`oferty-erli: konto ${KLUCZ}: batch 0, stock 0, cena 0`]);
  tylkoOdczyt = false; logi.length = 0; await petla.przebieg();
  expect(logi).toEqual([`oferty-erli: konto ${KLUCZ}: batch 1, stock 1, cena 0`]);
});
it('nowa oferta bez zatwierdzenia czeka; znane zero można wystawić po zatwierdzeniu', async () => {
  wlacz(false); const o = oferta({stan:0});
  zmienOferte(db,o.id,{stan:'do_wyslania'}); produkty.clear();
  await petla.przebieg();
  expect(wystawienia).toEqual([]); expect(wiersz(o).stan).toBe('do_wyslania'); expect(wiersz(o).blad).toBeNull();
  zapiszZatwierdzenieStanow(db,{przelaczenieId:1,zatwierdzil:'operator',ofert:1,skrot:'test'},{teraz:T1});
  await petla.przebieg(); expect(wystawienia).toHaveLength(1); expect(wystawienia[0].stock).toBe(0);
});
it('błąd migawki pomija ilość, zachowuje cenę i daje wpis w logu', async () => {
  wlacz(); const o = oferta();
  db.prepare('UPDATE karty_produktow SET cena_gr=11000 WHERE id=?').run(o.kartaId);
  vi.mocked(migawkaStanow).mockImplementationOnce(() => { throw new Error('awaria migawki'); });
  await petla.przebieg();
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,price:11000}]);
  expect(logi).toContain('oferty-erli: migawka: awaria migawki');
});

// --- E4.07p: poprawki po recenzji (B1–B3, N5) ---
const awariaMigawki = () => vi.mocked(migawkaStanow).mockImplementationOnce(() => { throw new Error('awaria migawki'); });
function sprzedazErli(o, n, at) {
  const id = zapiszZamowienie(db,KLUCZ,{zrodlo_id:`erli-${n}`,numer:`E-${n}`,klient:{},dostawa:{},
    utworzone_at:at,kwota_brutto:'100.00',metoda_wysylki:'kurier',chce_fakture:0,kwota_pobrania:null,nip:null,oplacone_at:null,
    status_woo:'processing',anulowane:0,pozycje:[{zrodlo_id:`e${n}`,produkt_id:null,wariant_id:null,oferta_id:o.idZewnetrzne,
      sku:null,zdjecie_url:null,nazwa:'Lampa Półcień',ilosc:1,cena_brutto:'100.00',vat:'23'}]},{});
  db.prepare('UPDATE zamowienia SET zmienione_at=? WHERE id=?').run(at,id);
  produkty.get(o.idZewnetrzne).stock--;
}
it('B1: siedem sprzedaży tylko w ERLI z pulsem nie daje skoku — T i stan karty przesuwają się razem', async () => {
  wlacz(); const o = oferta({stan:10,odczyt:10,poprzednia:{wyslanaIlosc:10,iloscWyslanaAt:T1,stanKartyWyslany:10}});
  for (let n = 1; n <= 7; n++) {
    czas += 300000;
    sprzedazErli(o, n, new Date(czas - 120000).toISOString());
    puls(new Date(czas - 60000).toISOString());
    await petla.przebieg();
    expect(wiersz(o).iloscProblem?.kod ?? null).not.toBe('skok');
  }
  expect(wiersz(o)).toMatchObject({wyslanaIlosc:3,stanKartyWyslany:3,iloscProblem:null});
  expect(paczki).toEqual([]);
});
it('B1: pierwsza wysyłka po zatwierdzeniu nadal bez stanu karty, gdy odczyt zgodny z celem', async () => {
  wlacz(); const o = oferta({stan:8,odczyt:8});
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({wyslanaIlosc:8,stanKartyWyslany:null});
});
// Warunek skoku już nie zachodzi (stan karty bez bazy) — alarm trzyma tylko decyzja człowieka.
async function alarmSkok() {
  const o = oferta({stan:2,poprzednia:{stanKartyWyslany:10,iloscWyslanaAt:'2026-11-14T10:00:00Z'}});
  await petla.przebieg(); expect(wiersz(o).iloscProblem?.kod).toBe('skok');
  zmienOferte(db,o.id,{stanKartyWyslany:null});
  return o;
}
it('B2: alarm skok przeżywa przebieg z błędem migawki', async () => {
  wlacz(); const o = await alarmSkok();
  awariaMigawki(); czas += 300000; await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok');
  czas += 300000; await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok'); expect(paczki).toEqual([]);
});
it('B2: alarm skok przeżywa odczyt bez całkowitego stock', async () => {
  wlacz(); const o = await alarmSkok();
  produkty.get(o.idZewnetrzne).stock = null; czas += 300000; await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok');
  produkty.get(o.idZewnetrzne).stock = 8; czas += 300000; await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok'); expect(paczki).toEqual([]);
});
it('B2: błąd migawki przy odczycie innym niż stała ilość — bez stock, problem bez zmian', async () => {
  wlacz(); const o = oferta({stan:2,odczyt:3});
  db.prepare('UPDATE karty_produktow SET cena_gr=11000 WHERE id=?').run(o.kartaId);
  awariaMigawki(); await petla.przebieg();
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,price:11000}]);
  expect(wiersz(o).iloscProblem).toBeNull();
});
it('B3: błąd wyjaśnień przy włączonych stanach pomija tylko ilość', async () => {
  wlacz(); const o = oferta({stan:2,odczyt:3});
  db.prepare('UPDATE karty_produktow SET cena_gr=11000 WHERE id=?').run(o.kartaId);
  vi.mocked(wyjasnieniaOfert).mockImplementationOnce(() => { throw new Error('awaria wyjaśnień'); });
  await petla.przebieg();
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,price:11000}]);
  expect(logi).toContain('oferty-erli: migawka: awaria wyjaśnień');
});
// r2 (decyzja Szefa 14.11): horyzont ogranicza tylko okno zapytania — stare T zostaje bazą, wyjaśnienia zerowe → alarm.
it('B2 r2: T starsze niż horyzont — okno bez tej oferty, ale skok dalej działa', async () => {
  wlacz(); const o = oferta({stan:2,poprzednia:{stanKartyWyslany:10,iloscWyslanaAt:'2026-11-06T12:00:00Z'}});
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('skok');
  expect(paczki).toEqual([]);
  const [[, wiersze]] = vi.mocked(wyjasnieniaOfert).mock.calls;
  expect(wiersze).toEqual([expect.objectContaining({id:o.id,od:null})]);
});
it('B2 r2: stare T, odczyt poniżej wysłanej ilości, po pulsie — rozjazd-dol bez wysyłki', async () => {
  wlacz(); const o = oferta({stan:10,odczyt:2,poprzednia:{wyslanaIlosc:10,stanKartyWyslany:10,iloscWyslanaAt:'2026-11-06T12:00:00Z'}});
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('karencja');
  czas += 300000; puls(new Date(czas - 60000).toISOString());
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod).toBe('rozjazd-dol');
  expect(paczki).toEqual([]);
});
// B1 r2: ruch zapisany między migawką a odczytem oferty należy do okna następnego przebiegu (T = chwila migawki).
it('B1 r2: przyjęcie +20 w trakcie odczytu — następny przebieg bez skoku, podwyżka po pulsie', async () => {
  wlacz(); const o = oferta({stan:10,odczyt:10,poprzednia:{wyslanaIlosc:10,iloscWyslanaAt:T1,stanKartyWyslany:10}});
  let raz = true;
  przyOdczycie = () => {
    if (!raz) return; raz = false;
    czas += 1000;
    dodajRuch(db,{kartaId:o.kartaId,rodzaj:'przyjecie',ilosc:20,klucz:'przyjecie-polcien-1',at:new Date(czas).toISOString()});
    czas += 3000;
  };
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({wyslanaIlosc:10,stanKartyWyslany:10,iloscProblem:null});
  czas += 300000; puls(new Date(czas - 60000).toISOString());
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod ?? null).not.toBe('skok');
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:30}]);
});
it('B1 r2: przyjęcie +20 w trakcie wysyłki batcha — następny przebieg bez skoku, podwyżka po pulsie', async () => {
  wlacz(); const o = oferta({stan:5,odczyt:8});
  let raz = true;
  przedBatchem = () => {
    if (!raz) return; raz = false;
    czas += 1000;
    dodajRuch(db,{kartaId:o.kartaId,rodzaj:'przyjecie',ilosc:20,klucz:'przyjecie-polcien-2',at:new Date(czas).toISOString()});
    czas += 3000;
  };
  await petla.przebieg();
  expect(wiersz(o)).toMatchObject({wyslanaIlosc:5,stanKartyWyslany:5});
  // Dwa przebiegi z pulsem: pierwszy utrwala odczyt po batchu, drugi widzi go stabilnym (D64) i podnosi.
  for (let n = 0; n < 2; n++) {
    czas += 300000; puls(new Date(czas - 60000).toISOString());
    await petla.przebieg();
    expect(wiersz(o).iloscProblem?.kod ?? null).not.toBe('skok');
  }
  expect(paczki.flat()).toEqual([{externalId:o.idZewnetrzne,stock:5},{externalId:o.idZewnetrzne,stock:25}]);
});
it('N3: nowa oferta przy błędzie migawki — bez wysyłki i bez nowego problemu ilości', async () => {
  wlacz(); const o = oferta();
  zmienOferte(db,o.id,{stan:'do_wyslania'});
  awariaMigawki(); await petla.przebieg();
  expect(wystawienia).toEqual([]);
  expect(wiersz(o)).toMatchObject({stan:'do_wyslania',iloscProblem:null});
});
it('N5: oferta objęta po zapytaniu o wyjaśnienia — stary stan karty zerowany, bez fałszywego skoku', async () => {
  wlacz(); const o = oferta({stan:2,odczyt:2,poprzednia:{stanKartyWyslany:10,iloscWyslanaAt:'2026-11-14T10:00:00Z'}});
  vi.mocked(wyjasnieniaOfert).mockImplementationOnce(dbx => prawdziwe.wyjasnieniaOfert(dbx, []));
  await petla.przebieg();
  expect(wiersz(o).iloscProblem?.kod ?? null).not.toBe('skok');
  expect(wiersz(o).stanKartyWyslany).toBeNull();
});
it('N2: okno wyjaśnień pomija szkice i oferty z błędem', async () => {
  wlacz(); const o = oferta(); const szkic = oferta(); const blad = oferta();
  zmienOferte(db,szkic.id,{stan:'szkic',iloscWyslanaAt:'2026-11-13T00:00:00Z'});
  zmienOferte(db,blad.id,{stan:'blad',iloscWyslanaAt:'2026-11-13T00:00:00Z'});
  await petla.przebieg();
  const [[, wiersze]] = vi.mocked(wyjasnieniaOfert).mock.calls;
  expect(wiersze.map(w => w.id)).toEqual([o.id]);
});
it.each(['i','ii'])('B3 bliźniak (%s): wyłączone stany nie liczą wyjaśnień ani migawki, ich awaria niczego nie zmienia', async wariant => {
  const z = await przygotujErli({wariant});
  try {
    vi.mocked(wyjasnieniaOfert).mockClear().mockImplementation(() => { throw new Error('awaria wyjaśnień'); });
    vi.mocked(migawkaStanow).mockClear();
    await z.przebiegi();
    expect(z.nagr.tekst()).toBe(readFileSync(new URL('../../fixtures/e4-blizniak-erli.json',import.meta.url),'utf8'));
    expect(wyjasnieniaOfert).not.toHaveBeenCalled();
    expect(migawkaStanow).not.toHaveBeenCalled();
  } finally { z.zamknij(); }
});
const bladErli = (status, chwilowy) => Object.assign(new Error(`ERLI: HTTP ${status}`), { status, chwilowy });
it.each([
  ['odmowa pozycji (400)', () => { odpowiedzBatcha = lista => ({ ok:true, dane: lista.map(p => ({ externalId:p.externalId, blad:bladErli(400,false) })) }); }],
  ['odmowa całego batcha (422)', () => { przedBatchem = () => { throw bladErli(422,false); }; }],
  ['limit zapytań (429)', () => { przedBatchem = () => { throw bladErli(429,true); }; }],
  ['kanał odmówił', () => { odpowiedzBatcha = () => ({ ok:false, powod:'brak metody' }); }],
])('N5: %s — ERLI nie przyjęło zmiany, cel w toku znika', async (_, odpowiedz) => {
  wlacz(); const o = oferta();
  odpowiedz();
  await petla.przebieg();
  expect(wiersz(o).iloscWToku).toBeNull();
});
it.each([
  ['limit czasu', Object.assign(new Error('ERLI: przekroczono limit czasu 30 s.'), { chwilowy:true })],
  ['błąd serwera (503)', bladErli(503,true)],
])('N5: %s — wynik nieznany, cel w toku zostaje', async (_, blad) => {
  wlacz(); const o = oferta();
  przedBatchem = () => { throw blad; };
  await petla.przebieg();
  expect(wiersz(o).iloscWToku).toMatchObject({ cel:5 });
});
