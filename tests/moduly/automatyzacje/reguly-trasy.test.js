// PRZ-108.07 (zmiana B planu automatyzacji, właściciel 21.10): ekran reguł — lista, kreator (krok 1 i 2), zapis, włącz /
// wyłącz, zaległe, dziennik reguły. Prawdziwy serwer i moduły. Dwa światy:
//  • rejestr zdarzeń PUSTY (tak wychodzi B na produkcję) — kreator istnieje, ale nie da się utworzyć reguły; lista
//    wygląda jak po zmianie A;
//  • rejestr z SZTUCZNYM zdarzeniem i akcją wstrzykniętymi przez `nadpisania` — pełna ścieżka ekranu.
import { describe, it, expect, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';
import { nowyPanel, jako, get, post, POLLER, CONFIG } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzRegule, wlaczRegule, wczytajRegule } from '../../../src/moduly/automatyzacje/db/reguly.js';

const EKRAN = '/ustawienia/automatyzacje';
const NOWA = `${EKRAN}/nowa`;

const ZDARZENIE = {
  klucz: 'test_zdarzenie', etykieta: 'Zdarzenie testowe', grupa: 'zamowienie', opis: 'Tylko w testach.',
  kandydaci: () => [],
  symulacja: (db, od) => db.prepare(`SELECT id AS zamowienie_id, sklep, wyslane_at AS zdarzenie_at FROM zamowienia
    WHERE wyslane_at >= ? ORDER BY id`).all(od),
};
const AKCJA = { klucz: 'test_akcja', etykieta: 'Akcja testowa', wymagaPoczty: true, szablon: true, wykonaj: async () => ({}) };

const otwarte = [];
afterEach(async () => { for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); } });

function panel({ rejestr = true, poczta = false, demo = null } = {}) {
  // PRZ-108.08: od C1 moduł ma prawdziwe zdarzenia i akcję — świat „rejestr pusty” podaje puste listy jawnie.
  const nadpisania = rejestr ? { 'automatyzacje.zdarzenia': [ZDARZENIE], 'automatyzacje.akcje': [AKCJA],
    'automatyzacje.pocztaGotowa': () => poczta } : { 'automatyzacje.zdarzenia': [], 'automatyzacje.akcje': [] };
  const p = demo
    ? (() => { const db = openOmsDb(':memory:'); return { db, app: buildOmsServer({ poller: POLLER, db, nadpisania, config: { auth: { ...CONFIG.auth }, demo } }) }; })()
    : nowyPanel({ nadpisania });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'ustawienia']);
  const wynik = { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
  otwarte.push(wynik);
  return wynik;
}
const FORMULARZ = { nazwa: 'Reguła z ekranu', zdarzenie: 'test_zdarzenie', kanaly: ['pro', 'reczne'], opoznienie: '30',
  limit: '20', akcja: 'test_akcja', szablon: 'wlasny-1' };
function zSzablonemWlasnym(db) {
  db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('szablony.wiadomosci', ?, '2026-10-21')")
    .run(JSON.stringify({ wbudowane: {}, wlasne: [{ id: 'wlasny-1', nazwa: 'Paczka w drodze', temat: 'Paczka', tresc: 'Jedzie.' }], licznik: 1 }));
}
const reguly = (db) => db.prepare('SELECT * FROM automatyzacje_reguly ORDER BY id').all();
const teraz = () => new Date();
const zapiszWprost = (db, o = {}) => utworzRegule(db, { nazwa: 'Reguła wprost', zdarzenie: 'test_zdarzenie', zdarzenie_json: {},
  warunki: { kanaly: ['pro', 'szkicownia'], kanalyZnane: ['pro', 'szkicownia', 'allegro_szkicownia', 'reczne', 'indywidualne'] },
  akcja: 'test_akcja', akcja_json: { szablon: 'wlasny-1' }, opoznienie_min: 0, limit_na_godzine: 20, ...o }, { login: 'adam', teraz });

describe('rejestr zdarzeń pusty (B wydane samo)', () => {
  it('lista: bez przycisku „Dodaj automatyzację” i bez tabeli reguł', async () => {
    const p = panel({ rejestr: false });
    const r = await get(p.app, EKRAN, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Dodaj automatyzację');
    expect(r.body).not.toContain('class="tab-pozycje aut-tabela"');
  });
  it('kreator krok 1: wszystkie zdarzenia przygaszone („wkrótce”), zdanie o braku zdarzeń, bez „Dalej”', async () => {
    const p = panel({ rejestr: false });
    const r = await get(p.app, NOWA, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<h1>Nowa automatyzacja</h1>');
    expect(r.body).toContain('Kiedy ma zadziałać?');
    expect(r.body).toContain('Paczka nadana');
    expect(r.body).toContain('Status zamówienia zmienił się na');
    expect(r.body).toContain('Żadne zdarzenie nie jest jeszcze dostępne');
    expect(r.body).not.toMatch(/<input type="radio" name="zdarzenie" value=/u);
    expect(r.body).not.toContain('>Dalej<');
  });
  it('krok 2 z niedostępnym zdarzeniem → 400; zapis → 400 i nic w bazie', async () => {
    const p = panel({ rejestr: false });
    expect((await get(p.app, `${NOWA}?zdarzenie=paczka_nadana`, p.admin)).statusCode).toBe(400);
    const r = await post(p.app, NOWA, p.admin, { ...FORMULARZ, zdarzenie: 'paczka_nadana' });
    expect(r.statusCode).toBe(400);
    expect(reguly(p.db)).toEqual([]);
  });
});

describe('13. trasy — dostęp', () => {
  it('konto z „ustawienia” bez admina: 403 na każdą trasę reguł, w bazie nic', async () => {
    const p = panel();
    const id = zapiszWprost(p.db);
    for (const url of [NOWA, `${NOWA}?zdarzenie=test_zdarzenie`, `${EKRAN}/${id}`, `${EKRAN}/${id}/edytuj`]) {
      expect((await get(p.app, url, p.ewa)).statusCode, url).toBe(403);
    }
    for (const url of [NOWA, `${EKRAN}/sprawdz`, `${EKRAN}/${id}`, `${EKRAN}/${id}/wlacz`, `${EKRAN}/${id}/wylacz`,
      `${EKRAN}/${id}/usun`, `${EKRAN}/${id}/zalegle/wyslij`, `${EKRAN}/${id}/zalegle/pomin`]) {
      expect((await post(p.app, url, p.ewa, FORMULARZ)).statusCode, url).toBe(403);
    }
    expect(reguly(p.db)).toHaveLength(1);
    expect(reguly(p.db)[0]).toMatchObject({ wlaczona: 0, nazwa: 'Reguła wprost', usunieta_at: null });
  });
  it('gość demo ogląda kreator i dziennik (200), nie zapisze (403)', async () => {
    const p = panel({ demo: { login: 'demo', haslo: 'demo', reset: 'co 60 minut', resetPlanowy: null, resetGodzina: null } });
    zalozKonto(p.db, { login: 'demo', imie: 'Gość', haslo: 'demo', rola: 'sprzedaz' });
    ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'demo').id, [...ekranyRoli('sprzedaz'), 'ustawienia']);
    const gosc = jako(p.db, 'demo');
    const id = zapiszWprost(p.db);
    expect((await get(p.app, NOWA, gosc)).statusCode).toBe(200);
    expect((await get(p.app, `${EKRAN}/${id}`, gosc)).statusCode).toBe(200);
    expect((await post(p.app, `${EKRAN}/${id}/wlacz`, gosc, {})).statusCode).toBe(403);
    expect(wczytajRegule(p.db, id).wlaczona).toBe(0);
  });
  it('nieistniejąca reguła → 404', async () => {
    const p = panel();
    expect((await get(p.app, `${EKRAN}/999`, p.admin)).statusCode).toBe(404);
    expect((await get(p.app, `${EKRAN}/abc`, p.admin)).statusCode).toBe(404);
  });
});

describe('13. kreator i zapis', () => {
  it('krok 1 z rejestrem: zdarzenie testowe do wyboru i „Dalej”; krok 2: kanały niezaznaczone, szablony pasujące do zdarzenia', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    const k1 = await get(p.app, NOWA, p.admin);
    expect(k1.body).toMatch(/<input type="radio" name="zdarzenie" value="test_zdarzenie"/u);
    expect(k1.body).toContain('>Dalej<');
    const k2 = await get(p.app, `${NOWA}?zdarzenie=test_zdarzenie`, p.admin);
    expect(k2.statusCode).toBe(200);
    expect(k2.body).toContain('Zdarzenie testowe');
    expect(k2.body).toContain('name="opoznienie"');
    expect(k2.body).toContain('max="10080"');
    expect(k2.body).toMatch(/name="kanaly" value="pro"/u);
    expect(k2.body).not.toMatch(/name="kanaly" value="[^"]+" checked/u);
    expect(k2.body).toContain('value="wlasny-1"');
    expect(k2.body).not.toContain('value="proforma"');
    expect(k2.body).toContain('Sprawdź na ostatnich 30 dniach');
  });
  it('zapis tworzy regułę WYŁĄCZONĄ i przekierowuje na jej dziennik', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    const r = await post(p.app, NOWA, p.admin, FORMULARZ);
    expect(r.statusCode).toBe(303);
    const [regula] = reguly(p.db);
    expect(r.headers.location).toBe(`${EKRAN}/${regula.id}?zapisano=1`);
    expect(regula).toMatchObject({ nazwa: 'Reguła z ekranu', wlaczona: 0, granica_at: null, opoznienie_min: 30,
      limit_na_godzine: 20, akcja: 'test_akcja', zmienil_login: 'adam' });
    expect(JSON.parse(regula.warunki_json).kanaly).toEqual(['pro', 'reczne']);
  });
  it('0 kanałów → 400 „Zaznacz co najmniej jeden kanał”; formularz zachowuje wpisane wartości', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    const { kanaly: _k, ...bez } = FORMULARZ;
    const r = await post(p.app, NOWA, p.admin, bez);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Zaznacz co najmniej jeden kanał');
    expect(r.body).toContain('value="Reguła z ekranu"');
    expect(reguly(p.db)).toEqual([]);
  });
  it('szablon niezgodny ze zdarzeniem → 400', async () => {
    const p = panel();
    const r = await post(p.app, NOWA, p.admin, { ...FORMULARZ, szablon: 'proforma' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('nie pasuje');
    expect(reguly(p.db)).toEqual([]);
  });
  it('18. opóźnienie 10 081 → 400; 10 080 → zapis', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    expect((await post(p.app, NOWA, p.admin, { ...FORMULARZ, opoznienie: '10081' })).statusCode).toBe(400);
    expect(reguly(p.db)).toEqual([]);
    expect((await post(p.app, NOWA, p.admin, { ...FORMULARZ, opoznienie: '10080' })).statusCode).toBe(303);
    expect(reguly(p.db)[0].opoznienie_min).toBe(10080);
  });
  it('„Sprawdź na ostatnich 30 dniach” nic nie zapisuje i pokazuje liczby', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    const wstaw = p.db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, wyslane_at)
      VALUES (?,?,?,?,?,?)`);
    const wczoraj = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    wstaw.run('pro', 1, 'S-1', '10.00', '2026-10-01T10:00:00', wczoraj);
    wstaw.run('pro', 2, 'S-2', '10.00', '2026-10-01T10:00:00', wczoraj);
    wstaw.run('allegro_szkicownia', 3, 'S-3', '10.00', '2026-10-01T10:00:00', wczoraj);
    const r = await post(p.app, `${EKRAN}/sprawdz`, p.admin, FORMULARZ);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Sprawdzenie na ostatnich 30 dniach');
    expect(r.body).toContain('Nic nie zostało wysłane ani zapisane');
    expect(r.body).toMatch(/zadziałałaby dla <strong>2 zamówień<\/strong>/u);
    expect(r.body).toContain('Allegro szkicownia_pl (1)');
    expect(reguly(p.db)).toEqual([]);
    expect(p.db.prepare('SELECT COUNT(*) AS n FROM automatyzacje_wykonania').get().n).toBe(0);
  });
});

describe('13. włączanie, wyłączanie, usuwanie, zaległe', () => {
  it('włączenie bez poczty → 409, reguła zostaje wyłączona', async () => {
    const p = panel({ poczta: false });
    const id = zapiszWprost(p.db);
    const r = await post(p.app, `${EKRAN}/${id}/wlacz`, p.admin, {});
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Poczta wychodząca nie jest podłączona');
    expect(wczytajRegule(p.db, id).wlaczona).toBe(0);
  });
  it('włączenie z pocztą → granica i historia; wyłączenie → historia; dziennik pokazuje obie zmiany', async () => {
    const p = panel({ poczta: true });
    zSzablonemWlasnym(p.db); // PRZ-108.08: reguła z usuniętym szablonem nie da się włączyć (409)
    const id = zapiszWprost(p.db);
    const r = await post(p.app, `${EKRAN}/${id}/wlacz`, p.admin, {});
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${EKRAN}/${id}?zapisano=wlaczona`);
    const po = wczytajRegule(p.db, id);
    expect(po.wlaczona).toBe(1);
    expect(po.granica_at).toBeTruthy();
    expect(JSON.parse(po.granica_json)).toHaveProperty('zamowienia');
    expect((await post(p.app, `${EKRAN}/${id}/wylacz`, p.admin, {})).statusCode).toBe(303);
    expect(wczytajRegule(p.db, id).wlaczona).toBe(0);
    const d = await get(p.app, `${EKRAN}/${id}`, p.admin);
    expect(d.statusCode).toBe(200);
    expect(d.body).toContain('<h1>Reguła wprost</h1>');
    expect(d.body).toContain('Historia włączania');
    expect(d.body).toContain('włączenie');
    expect(d.body).toContain('wyłączenie');
    expect(d.body).toContain('Dziennik wykonań');
  });
  it('lista z rejestrem: tabela reguł, przycisk „Dodaj automatyzację”, wstrzymana reguła z ostrzeżeniem', async () => {
    const p = panel({ poczta: true });
    const id = zapiszWprost(p.db);
    wlaczRegule(p.db, id, { login: 'adam', teraz });
    p.db.prepare("UPDATE automatyzacje_reguly SET wstrzymana_powod = '51 zamówień naraz (więcej niż 50)' WHERE id = ?").run(id);
    const r = await get(p.app, EKRAN, p.admin);
    expect(r.body).toContain('Dodaj automatyzację');
    expect(r.body).toContain(`href="${NOWA}"`);
    expect(r.body).toContain('class="tab-pozycje aut-tabela"');
    expect(r.body).toContain('Reguła wprost');
    expect(r.body).toContain('wstrzymana');
    expect(r.body).toContain('51 zamówień naraz');
    const d = await get(p.app, `${EKRAN}/${id}`, p.admin);
    expect(d.body).toContain('Wyślij zaległe (0)');
    expect(d.body).toContain('Pomiń zaległe');
    expect((await post(p.app, `${EKRAN}/${id}/zalegle/wyslij`, p.admin, {})).statusCode).toBe(303);
    expect(wczytajRegule(p.db, id).wstrzymana_powod).toBeNull();
  });
  it('usunięcie miękkie: reguła znika z listy, dziennik 404, wiersz zostaje', async () => {
    const p = panel({ poczta: true });
    const id = zapiszWprost(p.db);
    expect((await post(p.app, `${EKRAN}/${id}/usun`, p.admin, {})).statusCode).toBe(303);
    expect((await get(p.app, `${EKRAN}/${id}`, p.admin)).statusCode).toBe(404);
    expect((await get(p.app, EKRAN, p.admin)).body).not.toContain('Reguła wprost');
    expect(reguly(p.db)[0].usunieta_at).toBeTruthy();
  });
});

describe('14. nowy kanał od zapisu', () => {
  it('edycja: kanał dodany do konfiguracji po zapisie jest niezaznaczony, ekran o nim mówi', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    const id = zapiszWprost(p.db);
    const e = await get(p.app, `${EKRAN}/${id}/edytuj`, p.admin);
    expect(e.statusCode).toBe(200);
    expect(e.body).toMatch(/name="kanaly" value="pro" checked/u);
    expect(e.body).toMatch(/name="kanaly" value="allegro_amarka">/u);
    expect(e.body).toContain('Nowe kanały od czasu zapisu: Allegro AmarkaPL — niezaznaczone');
    const d = await get(p.app, `${EKRAN}/${id}`, p.admin);
    expect(d.body).toContain('Nowe kanały od czasu zapisu: Allegro AmarkaPL — niezaznaczone');
  });
  it('edycja zapisuje zmiany (303) i nie włącza reguły', async () => {
    const p = panel();
    zSzablonemWlasnym(p.db);
    const id = zapiszWprost(p.db);
    const r = await post(p.app, `${EKRAN}/${id}`, p.admin, { ...FORMULARZ, nazwa: 'Po edycji' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${EKRAN}/${id}?zapisano=1`);
    expect(wczytajRegule(p.db, id)).toMatchObject({ nazwa: 'Po edycji', wlaczona: 0 });
    const d = await get(p.app, r.headers.location, p.admin);
    expect(d.statusCode).toBe(200);
    expect(d.body).toContain('Zapisano regułę. Jest wyłączona — włączysz ją przyciskiem niżej.');
  });
  it('edycja WŁĄCZONEJ reguły: komunikat mówi, że reguła jest włączona', async () => {
    const p = panel({ poczta: true });
    zSzablonemWlasnym(p.db);
    const id = zapiszWprost(p.db);
    expect((await post(p.app, `${EKRAN}/${id}/wlacz`, p.admin, {})).statusCode).toBe(303);
    const r = await post(p.app, `${EKRAN}/${id}`, p.admin, { ...FORMULARZ, nazwa: 'Po edycji' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${EKRAN}/${id}?zapisano=zmieniona_wlaczona`);
    expect(wczytajRegule(p.db, id)).toMatchObject({ nazwa: 'Po edycji', wlaczona: 1 });
    const d = await get(p.app, r.headers.location, p.admin);
    expect(d.statusCode).toBe(200);
    expect(d.body).toContain('Zapisano zmiany. Reguła jest włączona i działa dalej.');
    expect(d.body).not.toContain('Jest wyłączona');
  });
});
