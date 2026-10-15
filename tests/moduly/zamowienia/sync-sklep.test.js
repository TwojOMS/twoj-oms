import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createSyncSklep } from '../../../src/moduly/zamowienia/services/sync-sklep.js';
import { statusDlaSklepu } from '../../../src/domena/sync-sklep.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '123.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-31T09:00:00',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00', vat: null }],
  ...nad,
});

// ---------------------------------------------------------------------------------
// A. REGULA (domena) — decyzja CO wyslac, bez sklepu i bez bazy.
// ---------------------------------------------------------------------------------
describe('statusDlaSklepu — kiedy panel ma przestawic zamowienie w sklepie', () => {
  const z = (nad) => ({ zrodlo_id: 900, status_woo: 'processing', przesylki: [], ...nad });

  it('„Wyslane" w panelu → „completed" w sklepie', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00' }))).toBe('completed');
  });

  it('zamowienie w realizacji NIE rusza sklepu', () => {
    expect(statusDlaSklepu(z({ w_realizacji_at: '2026-07-31T10:00:00' }))).toBeNull();
  });

  it('nowe zamowienie NIE rusza sklepu', () => {
    expect(statusDlaSklepu(z({}))).toBeNull();
  });

  // ⚠️ Sedno calej sprawy: Woo wysyla klientowi maila przy PRZEJSCIU na 'completed'.
  // Powtorne wyslanie tej samej wartosci to drugi mail przy kazdym kliknieciu.
  it('sklep juz jest „completed" — nie wysylamy niczego drugi raz', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', status_woo: 'completed' }))).toBeNull();
  });

  it('zamowienie zwrocone w sklepie zostaje nietkniete', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', status_woo: 'refunded' }))).toBeNull();
  });

  it('zamowienie w koszu sklepu zostaje nietkniete', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', status_woo: 'trash' }))).toBeNull();
  });

  it('zwrot w panelu NIE jest odsylany do sklepu (osobna decyzja, nie ma go w mapie)', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', zwrot_at: '2026-08-01T10:00:00' }))).toBeNull();
  });

  it('zamowienie spoza sklepu nie ma czego przestawiac', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', zrodlo_id: null }))).toBeNull();
  });

  // UWAGA: Zamowienie reczne MA `zrodlo_id` (to numer w naszej wlasnej serii R/RRRR/NNN),
  // wiec straznik oparty na jego BRAKU tego przypadku nie lapie. Liczy sie POCHODZENIE.
  it('zamówienie ręczne NIE jedzie do sklepu, mimo że ma zrodlo_id', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', sklep: 'reczne' }))).toBeNull();
  });

  it('zamówienie ze sklepu dalej jedzie', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-07-31T10:00:00', sklep: 'pro' }))).toBe('completed');
  });

  // ⚠️ KANAL NIE JEST SKLEPEM (Etap 4, 2026-08-04). Zamowienie z Allegro ma i `sklep`,
  // i `zrodlo_id`, wiec oba dotychczasowe straznik i go przepuszczaly — a mapa nizej mowi
  // `wyslane → completed`, czyli status WooCommerce, ktorego Allegro w ogole nie zna.
  // Skutkiem bylo szukanie klienta Woo pod kluczem kanalu, brak trafienia i `sync_woo_blad`
  // = „panel nie ma polaczenia ze sklepem" — sprawa NIE DO ZALATWIENIA na pasku karty.
  it('zamówienie z Allegro NIE generuje statusu do sklepu (Plan A nie pisze do Allegro)', () => {
    expect(statusDlaSklepu(z({
      wyslane_at: '2026-08-03T10:00:00', sklep: 'allegro_szkicownia', status_woo: 'READY_FOR_PROCESSING',
    }))).toBeNull();
  });

  // Straznik ma lapac KANAL po prefiksie, a nie jeden konkretny klucz — drugie konto
  // (AmarkaPL) jest dokladnie tak samo nie-sklepem.
  it('drugi kanał Allegro tak samo nie generuje statusu', () => {
    expect(statusDlaSklepu(z({
      wyslane_at: '2026-08-03T10:00:00', sklep: 'allegro_amarka', status_woo: 'SENT',
    }))).toBeNull();
  });

  // ⚠️ Straznik NIE MA PRAWA UCISZYC SKLEPOW. szkicownia.pl i pro.szkicownia.pl to zywe sklepy,
  // a `completed` jest tym, co wysyla klientowi maila „zamowienie zrealizowane".
  it('sklep szkicownia.pl DALEJ generuje status', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-08-03T10:00:00', sklep: 'szkicownia' }))).toBe('completed');
  });

  // Straznik oparty na BIALEJ LISCIE sklepow („tylko pro i szkicownia") przechodzilby oba
  // testy wyzej i uciszal KAZDY nowy sklep dopiety do panelu. Ma odrzucac kanaly, a nie
  // przepuszczac znajomych.
  it('nowy sklep, o którym strażnik nie wie, dalej generuje status', () => {
    expect(statusDlaSklepu(z({ wyslane_at: '2026-08-03T10:00:00', sklep: 'szkicownia_b2c' }))).toBe('completed');
  });
});

// ---------------------------------------------------------------------------------
// B. USLUGA — wykonanie, slad po bledzie, log.
// ---------------------------------------------------------------------------------
describe('createSyncSklep — odeslanie statusu do sklepu', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  const wyslane = (id) => {
    const wewn = zapiszZamowienie(db, 'pro', zmapowane(id), {});
    db.prepare("UPDATE zamowienia SET wyslane_at = '2026-07-31T10:00:00' WHERE id = ?").run(wewn);
    return wewn;
  };
  const log = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);

  it('strzela w sklep numerem ZE SKLEPU (zrodlo_id), nie wewnetrznym id panelu', async () => {
    const id = wyslane(4501);
    const woo = { ustawStatus: vi.fn().mockResolvedValue({}) };
    await createSyncSklep({ db, klienci: { pro: woo } }).odeslijStatus(id);
    expect(woo.ustawStatus).toHaveBeenCalledWith(4501, 'completed');
  });

  it('udane odeslanie NIE dopisuje statusu sklepu do bazy — prawde przyniesie poller', async () => {
    const id = wyslane(4502);
    const woo = { ustawStatus: vi.fn().mockResolvedValue({}) };
    await createSyncSklep({ db, klienci: { pro: woo } }).odeslijStatus(id);
    // Bez tej asercji test przechodzilby TAKZE wtedy, gdyby odeslanie w ogole sie nie
    // odbylo (status_woo zostaje 'processing' rowniez przy braku klienta sklepu).
    expect(woo.ustawStatus).toHaveBeenCalledWith(4502, 'completed');
    expect(pobierzZamowienie(db, id).status_woo).toBe('processing');
  });

  it('awaria sklepu NIE przerywa zapisu w panelu — nie rzuca, zostawia slad i wpis w logu', async () => {
    const id = wyslane(4503);
    const woo = { ustawStatus: vi.fn().mockRejectedValue(new Error('sklep padł')) };
    const wynik = await createSyncSklep({ db, klienci: { pro: woo } }).odeslijStatus(id);
    expect(wynik.blad).toContain('sklep padł');
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('sklep padł');
    expect(log(id).some((w) => w.wynik.includes('sklep padł'))).toBe(true);
  });

  it('udane ponowienie CZYSCI slad po wczesniejszym bledzie', async () => {
    const id = wyslane(4504);
    const sync = createSyncSklep({ db, klienci: { pro: { ustawStatus: vi.fn().mockRejectedValue(new Error('padło')) } } });
    await sync.odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeTruthy();

    await createSyncSklep({ db, klienci: { pro: { ustawStatus: vi.fn().mockResolvedValue({}) } } }).odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  // Gdyby brak roboty czyscil slad, cofniecie statusu po nieudanej wysylce zdejmowaloby
  // uwage z karty — a sklep dalej staloby na starym stanie.
  it('brak czego wysylac NIE czysci sladu po wczesniejszym bledzie', async () => {
    const id = wyslane(4505);
    await createSyncSklep({ db, klienci: { pro: { ustawStatus: vi.fn().mockRejectedValue(new Error('padło')) } } }).odeslijStatus(id);
    db.prepare('UPDATE zamowienia SET wyslane_at = NULL WHERE id = ?').run(id);

    const woo = { ustawStatus: vi.fn() };
    await createSyncSklep({ db, klienci: { pro: woo } }).odeslijStatus(id);
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeTruthy();
  });

  it('brak klienta sklepu zapisuje slad zamiast cicho niczego nie robic', async () => {
    const id = wyslane(4506);
    await createSyncSklep({ db, klienci: {} }).odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('brak konfiguracji');
  });
});

// ---------------------------------------------------------------------------------
// C. KARTA — rozjazd ze sklepem musi byc WIDOCZNY (zaden widok nie renderuje `log`).
// ---------------------------------------------------------------------------------
describe('sprawyKarty — rozjazd ze sklepem', () => {
  it('nieodeslany status trafia na pasek „Do zalatwienia" jako blokada', () => {
    const sprawy = sprawyKarty({ sync_woo_blad: 'status „completed" nie dojechał: sklep padł', przesylki: [] });
    const s = sprawy.find((x) => x.klucz === 'sync-sklep');
    expect(s.waga).toBe('blokada');
    expect(s.tekst).toContain('sklep padł');
    expect(s.kotwica).toBe('#status');
  });

  it('bez bledu nie ma sprawy', () => {
    expect(sprawyKarty({ przesylki: [] }).some((x) => x.klucz === 'sync-sklep')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// D. TRASY — ktore klikniecia jada do sklepu, a ktore NIE.
// ---------------------------------------------------------------------------------
describe('trasy karty — odeslanie statusu do sklepu', () => {
  let db, app, woo;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    woo = { ustawStatus: vi.fn().mockResolvedValue({}), dodajNotatke: vi.fn().mockResolvedValue({}) };
    app = buildOmsServer({ db, config, poller, syncSklep: createSyncSklep({ db, klienci: { pro: woo } }) });
    await app.ready();
  });
  const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

  it('zmiana statusu na „Wyslane" przestawia zamowienie w sklepie na „completed"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(4601), {});
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    expect(r.statusCode).toBe(302);
    expect(woo.ustawStatus).toHaveBeenCalledWith(4601, 'completed');
  });

  it('zmiana na „W realizacji" sklepu NIE dotyka', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(4602), {});
    await wyslij(`/zamowienia/${id}/status`, { status: 'w_realizacji' });
    expect(woo.ustawStatus).not.toHaveBeenCalled();
  });

  it('rejestracja paczki nadanej POZA panelem tez przestawia sklep (ustawia wyslane_at)', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(4603), {});
    await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000123456789A' });
    expect(woo.ustawStatus).toHaveBeenCalledWith(4603, 'completed');
  });

  it('awaria sklepu NIE psuje zmiany statusu w panelu — a karta pokazuje rozjazd', async () => {
    const db2 = openOmsDb(':memory:');
    const wooZly = { ustawStatus: vi.fn().mockRejectedValue(new Error('sklep padł')) };
    const app2 = buildOmsServer({ db: db2, config, poller, syncSklep: createSyncSklep({ db: db2, woo: wooZly }) });
    await app2.ready();
    const id = zapiszZamowienie(db2, 'pro', zmapowane(4604), {});

    const r = await app2.inject({ method: 'POST', url: `/zamowienia/${id}/status`, headers: naglowek, payload: { status: 'wyslane' } });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db2, id).wyslane_at).toBeTruthy();

    const karta = await app2.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).toContain('Sklep nie przyjął statusu');
    expect(karta.body).toContain('Wyślij ponownie');
  });

  it('„Wyslij ponownie" strzela do sklepu bez zmiany czegokolwiek w panelu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(4605), {});
    db.prepare("UPDATE zamowienia SET wyslane_at = '2026-07-31T10:00:00', sync_woo_blad = 'padło' WHERE id = ?").run(id);

    const r = await wyslij(`/zamowienia/${id}/sync-sklep`, {});
    expect(r.statusCode).toBe(302);
    expect(woo.ustawStatus).toHaveBeenCalledWith(4605, 'completed');
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  it('bez podpietego sklepu zmiana statusu dalej dziala', async () => {
    const dbBez = openOmsDb(':memory:');
    const appBez = buildOmsServer({ db: dbBez, config, poller });
    await appBez.ready();
    const id = zapiszZamowienie(dbBez, 'pro', zmapowane(4606), {});
    const r = await appBez.inject({ method: 'POST', url: `/zamowienia/${id}/status`, headers: naglowek, payload: { status: 'wyslane' } });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(dbBez, id).wyslane_at).toBeTruthy();
  });
});

// ⚠️ ETAP 2 (2026-08-01): panel obsluguje DWA sklepy naraz. Numery zamowien w obu sklepach
// sa NIEZALEZNE, wiec `zrodlo_id` 4700 istnieje w kazdym z nich i oznacza CO INNEGO.
// Wyslanie statusu do niewlasciwego sklepu domknelo by cudze zamowienie — i wyslalo maila
// „zamowienie zrealizowane" do klienta, ktory na nic nie czeka.
describe('createSyncSklep — dwa sklepy naraz', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  const zamowienie = (sklep, zrodloId) => {
    const id = zapiszZamowienie(db, sklep, {
      zrodlo_id: zrodloId, numer: String(zrodloId), klient: {}, dostawa: {},
      metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
      kwota_brutto: '10.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-08-01T09:00:00', pozycje: [],
    }, {});
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-08-01T10:00:00', id);
    return id;
  };

  it('status zamówienia ze szkicownia.pl idzie do szkicownia.pl, a nie do PRO', async () => {
    const pro = { ustawStatus: vi.fn().mockResolvedValue({}) };
    const szkicownia = { ustawStatus: vi.fn().mockResolvedValue({}) };
    const sync = createSyncSklep({ db, klienci: { pro, szkicownia } });

    await sync.odeslijStatus(zamowienie('szkicownia', 4700));

    expect(szkicownia.ustawStatus).toHaveBeenCalledWith(4700, 'completed');
    expect(pro.ustawStatus).not.toHaveBeenCalled();
  });

  it('i odwrotnie — status z PRO nie zahacza o szkicownia.pl', async () => {
    const pro = { ustawStatus: vi.fn().mockResolvedValue({}) };
    const szkicownia = { ustawStatus: vi.fn().mockResolvedValue({}) };
    const sync = createSyncSklep({ db, klienci: { pro, szkicownia } });

    await sync.odeslijStatus(zamowienie('pro', 4701));

    expect(pro.ustawStatus).toHaveBeenCalledWith(4701, 'completed');
    expect(szkicownia.ustawStatus).not.toHaveBeenCalled();
  });

  // Sklep nieskonfigurowany to NIE jest awaria panelu: status zostaje zapisany, a slad
  // mowi wprost, KTOREGO sklepu brakuje — inaczej komunikat „brak konfiguracji" przy
  // dwoch sklepach nie mowilby nic.
  it('brak konfiguracji nazywa sklep po imieniu', async () => {
    const id = zamowienie('szkicownia', 4702);
    await createSyncSklep({ db, klienci: { pro: { ustawStatus: vi.fn() } } }).odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('szkicownia');
  });
});

// ---------------------------------------------------------------------------------
// E. KANALY (Allegro, Etap 4) — zamowienie z kanalu NIE MA prawa wyprodukowac sprawy
// „Do zalatwienia", ktorej nie da sie zalatwic.
// ---------------------------------------------------------------------------------
describe('createSyncSklep — kanal Allegro nie jest sklepem', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  const zamowienieKanalu = (sklep, zrodloId) => {
    const id = zapiszZamowienie(db, sklep, zmapowane(zrodloId, {
      zrodlo_id: String(zrodloId), metoda_wysylki: 'allegro_dpd', status_woo: 'READY_FOR_PROCESSING',
    }), {});
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-08-03T10:00:00', id);
    return id;
  };

  // TO JEST SEDNO USTERKI: brak klienta pod kluczem kanalu zapisywal `sync_woo_blad`
  // („panel nie ma polaczenia ze sklepem"), czyli wieszal na pasku karty sprawe, ktorej
  // operator nie ma jak zamknac — przy zamowieniu, ktore jest calkowicie w porzadku.
  it('wysłane zamówienie z Allegro NIE zostawia śladu błędu synchronizacji', async () => {
    const id = zamowienieKanalu('allegro_szkicownia', 100200300);
    const wynik = await createSyncSklep({ db, klienci: { szkicownia: { ustawStatus: vi.fn() } } }).odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
    expect(wynik.blad).toBeUndefined();
  });

  it('nie strzela statusem do ŻADNEGO ze sklepów — numer z Allegro nie oznacza tam niczego', async () => {
    const szkicownia = { ustawStatus: vi.fn().mockResolvedValue({}) };
    const pro = { ustawStatus: vi.fn().mockResolvedValue({}) };
    await createSyncSklep({ db, klienci: { szkicownia, pro } })
      .odeslijStatus(zamowienieKanalu('allegro_amarka', 100200301));
    expect(szkicownia.ustawStatus).not.toHaveBeenCalled();
    expect(pro.ustawStatus).not.toHaveBeenCalled();
  });

  // ⚠️ Straznik siedzi w DOMENIE (decyzja „czy w ogole cokolwiek wysylac"), a nie w braku
  // klienta w mapie. Gdyby siedzial w braku klienta, dopiecie kanalow do tej samej mapy
  // (bootstrap trzyma pollery sklepow i kanalow razem) cicho odblokowaloby zapis do Allegro
  // — a Plan A nie wysyla do Allegro NICZEGO.
  it('nie wysyła statusu nawet wtedy, gdy klient kanału JEST w mapie', async () => {
    const kanal = { ustawStatus: vi.fn().mockResolvedValue({}) };
    const id = zamowienieKanalu('allegro_szkicownia', 100200302);
    await createSyncSklep({ db, klienci: { allegro_szkicownia: kanal } }).odeslijStatus(id);
    expect(kanal.ustawStatus).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// F. TRASY — kazde klikniecie, ktore konczy sie `odeslijStatus`, ma dla kanalu skonczyc
// sie CISZA. Tras jest kilka (zmiana pojedyncza, zmiana MASOWA, przesylka reczna,
// „Wyslij ponownie") i kazda musi byc przypieta osobno: bramka w domenie bywala martwa
// wlasnie dlatego, ze druga droga jej nie wolala.
// ---------------------------------------------------------------------------------
describe('trasy — zamówienie z Allegro nie wiesza sprawy nie do załatwienia', () => {
  let db, app, woo;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    woo = { ustawStatus: vi.fn().mockResolvedValue({}), dodajNotatke: vi.fn().mockResolvedValue({}) };
    app = buildOmsServer({ db, config, poller, syncSklep: createSyncSklep({ db, klienci: { szkicownia: woo } }) });
    await app.ready();
  });
  const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
  const zKanalu = (zrodloId) => zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(zrodloId, {
    zrodlo_id: String(zrodloId), metoda_wysylki: 'allegro_dpd', status_woo: 'READY_FOR_PROCESSING',
  }), {});

  it('zmiana statusu na „Wysłane" zapisuje fakt, ale sklepu nie dotyka i nie zostawia błędu', async () => {
    const id = zKanalu(100300400);
    const r = await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).wyslane_at).toBeTruthy();
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  it('karta zamówienia z Allegro nie pokazuje paska „Sklep nie przyjął statusu"', async () => {
    const id = zKanalu(100300401);
    await wyslij(`/zamowienia/${id}/status`, { status: 'wyslane' });
    const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).not.toContain('Sklep nie przyjął statusu');
  });

  // ⚠️ DRUGA DROGA. Akcja masowa wola te sama `odeslijStatus` w petli — bez tego testu
  // bramka moglaby byc martwa dokladnie tam, gdzie jednym kliknieciem zamyka sie
  // kilkanascie zamowien naraz. Ten sam test pilnuje, ze SKLEP obok dalej dostaje status.
  it('masowa zmiana statusu: Allegro milczy, a szkicownia.pl DALEJ dostaje „completed"', async () => {
    const kanal = zKanalu(100300402);
    const sklep = zapiszZamowienie(db, 'szkicownia', zmapowane(4801), {});

    const r = await wyslij('/zamowienia/masowe/status', { id: [String(kanal), String(sklep)], status: 'wyslane' });

    expect(r.statusCode).toBe(302);
    expect(woo.ustawStatus).toHaveBeenCalledTimes(1);
    expect(woo.ustawStatus).toHaveBeenCalledWith(4801, 'completed');
    expect(pobierzZamowienie(db, kanal).wyslane_at).toBeTruthy();
    expect(pobierzZamowienie(db, kanal).sync_woo_blad).toBeNull();
  });

  // Rejestracja paczki nadanej poza panelem USTAWIA `wyslane_at`, wiec dla sklepu jedzie
  // status — a dla kanalu ta sama droga musi zamilknac.
  it('paczka nadana poza panelem: dla Allegro nie rusza sklepu i nie zostawia błędu', async () => {
    const id = zKanalu(100300403);
    const r = await wyslij(`/zamowienia/${id}/przesylki/reczna`, { numer_listu: '0000123456789A' });
    expect(r.statusCode).toBe(302);
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  it('„Wyślij ponownie" na zamówieniu z Allegro też niczego nie wysyła', async () => {
    const id = zKanalu(100300404);
    db.prepare("UPDATE zamowienia SET wyslane_at = '2026-08-03T10:00:00' WHERE id = ?").run(id);
    const r = await wyslij(`/zamowienia/${id}/sync-sklep`, {});
    expect(r.statusCode).toBe(302);
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// D1 (recenzja Partii 1 Planu B): NAPISY DLA CZLOWIEKA.
//
// Regresja z Planu B: log i slad bledu sklejaly zdanie szablonem `w ${gdzie}` / `do ${gdzie}`,
// a `gdzie` bylo golym rzeczownikiem w mianowniku ('sklep'). Dla Allegro wychodzilo dobrze
// („w Allegro"), dla sklepu — „status w sklep ustawiony na „completed"" i „nie dojechal do
// sklep". Przed Planem B napis brzmial „status w sklepie ustawiony na …".
//
// ⚠️ Zadnego testu na te napisy NIE BYLO — dlatego regresja przeszla przez cala Partie 1.
// Ten opis jest tym testem: OBA brzmienia, w obu galeziach, dla logu I dla sladu bledu
// (ten drugi laduje na pasku „Do zalatwienia" na karcie, wiec czyta go operator).
// ---------------------------------------------------------------------------------
describe('opis miejsca w logu i w śladzie błędu', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  const logi = (id) => db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ?').all(id)
    .map((w) => w.wynik).join('\n');

  const zeSklepu = (id) => {
    const wewn = zapiszZamowienie(db, 'pro', zmapowane(id), {});
    db.prepare("UPDATE zamowienia SET wyslane_at = '2026-07-31T10:00:00' WHERE id = ?").run(wewn);
    return wewn;
  };
  const zKanalu = (zrodloId) => {
    const wewn = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(zrodloId, {
      zrodlo_id: String(zrodloId), metoda_wysylki: 'allegro_dpd', status_woo: 'READY_FOR_PROCESSING',
    }), {});
    db.prepare("UPDATE zamowienia SET wyslane_at = '2026-08-05T12:00:00' WHERE id = ?").run(wewn);
    return wewn;
  };
  const kanal = (nad = {}) => ({
    pobierzStanRealizacji: vi.fn(async () => 'PROCESSING'),
    ustawStatusRealizacji: vi.fn(async () => {}),
    ...nad,
  });

  it('SKLEP: log mówi „status w sklepie ustawiony na …" (miejscownik, nie mianownik)', async () => {
    const id = zeSklepu(4901);
    await createSyncSklep({ db, klienci: { pro: { ustawStatus: vi.fn().mockResolvedValue({}) } } })
      .odeslijStatus(id);
    expect(logi(id)).toContain('status w sklepie ustawiony na „completed"');
    expect(logi(id)).not.toContain('w sklep ');
  });

  it('ALLEGRO: log mówi „status w Allegro ustawiony na …"', async () => {
    const id = zKanalu('CF-901');
    await createSyncSklep({ db, klienci: {}, klienciKanalow: { allegro_szkicownia: kanal() } })
      .odeslijStatus(id);
    expect(logi(id)).toContain('status w Allegro ustawiony na „SENT"');
  });

  // ⚠️ TEN NAPIS CZYTA OPERATOR NA PASKU KARTY, wiec boli bardziej niz log.
  it('SKLEP: ślad błędu mówi „nie dojechał do sklepu"', async () => {
    const id = zeSklepu(4902);
    await createSyncSklep({ db, klienci: { pro: { ustawStatus: vi.fn().mockRejectedValue(new Error('HTTP 503')) } } })
      .odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('nie dojechał do sklepu');
  });

  it('ALLEGRO: ślad błędu mówi „nie dojechał do Allegro"', async () => {
    const id = zKanalu('CF-902');
    const zly = kanal({ ustawStatusRealizacji: vi.fn(async () => { throw new Error('HTTP 503'); }) });
    await createSyncSklep({ db, klienci: {}, klienciKanalow: { allegro_szkicownia: zly } }).odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('nie dojechał do Allegro');
  });
});
