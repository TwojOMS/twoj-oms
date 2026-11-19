// Kolumna Status na karcie i przełączanie statusu w kanale. Woo idzie przez prawdziwego klienta na nagranym
// `fetchImpl` (adres spoza nagrania rzuca), Allegro przez prawdziwego klienta na atrapie ofert — żadne żądanie
// nie wychodzi poza test. Status w lustrze ma pochodzić z odczytu po zapisie, nie z wysłanej wartości.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { kartaPoId, powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import {
  ofertaPoIdZewnetrznym,
  ustawieniaOfertKonta,
  wstawOferte,
  zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { createWooClient } from '../../../src/oms/woo/client.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { createSerwerOfertAllegro } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { bramkaZapisu } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const WOO = 'swietlik';
const WOO_ODCZYT = 'pro';
const ALLEGRO = 'allegro_swietlik';
const WSTRZYMANE = 'allegro_polcien2';
const T0 = '2026-11-18T08:00:00.000Z';
const BAZA_WOO = 'https://sklep.polcien.invalid';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};

function odpowiedz(status, dane) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => dane };
}

/** Sklep Woo w pamięci: PUT zmienia produkt (chyba że sklep „odmawia” po cichu), GET oddaje stan. */
function sklepWoo({ uprawnienia = 'zapis' } = {}) {
  const produkty = new Map([
    [7000, { id: 7000, sku: 'PLC-7000', status: 'publish' }],
    [7100, { id: 7100, sku: '', status: 'publish', type: 'variable' }],
    [7200, { id: 7200, sku: 'PLC-7200', status: 'draft' }],
  ]);
  const zadania = [];
  const sklep = { produkty, zadania, odmawia: false };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin !== BAZA_WOO || !u.pathname.startsWith('/wp-json/wc/v3/')) throw new Error(`Nieznany adres ${url}`);
    const metoda = init.method ?? 'GET';
    const sciezka = u.pathname.slice('/wp-json/wc/v3'.length);
    const cialo = init.body === undefined ? undefined : JSON.parse(init.body);
    zadania.push({ metoda, sciezka, cialo });
    const m = /^\/products\/(\d+)$/.exec(sciezka);
    const p = m && produkty.get(Number(m[1]));
    if (!p || !['GET', 'PUT'].includes(metoda)) throw new Error(`Nieznany adres ${metoda} ${url}`);
    if (metoda === 'PUT' && !sklep.odmawia) Object.assign(p, cialo);
    return odpowiedz(200, { ...p });
  };
  sklep.klient = createWooClient({ baseUrl: BAZA_WOO, ck: 'test', cs: 'test', fetchImpl, uprawnienia });
  return sklep;
}

let db, app, woo, wooOdczyt, allegro, zadaniaAllegro, karta;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const ekran = async (headers = auth) => (await app.inject({ method: 'GET', url: `/magazyn/${karta}`, headers })).body;
const wiersz = (html, pid) =>
  (html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []).find((tr) => tr.includes(`data-produkt="${pid}"`)) ?? '';
const dziennik = () =>
  db.prepare('SELECT kanal, karta_id, cel, pole, stara, nowa, wynik, blad FROM zmiany_w_kanalach ORDER BY id').all();
const lustro = (pid) => db.prepare('SELECT status_publikacji FROM produkty_sklepowe WHERE id = ?').get(pid);
const zapisyAllegro = () => zadaniaAllegro.filter((z) => z.metoda !== 'GET');
const zapisyWoo = (s) => s.zadania.filter((z) => z.metoda !== 'GET');

function wLustrze(kanal, produktId, status, wariantId = '') {
  const pid = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produktId,
    wariant_id: wariantId,
    nazwa: `Lampa Półcień ${produktId}${wariantId ? ` / ${wariantId}` : ''}`,
    status_publikacji: status,
    odczytane_at: T0,
  });
  powiazProdukt(db, pid, karta);
  return pid;
}

function ofertaWAtrapie(kanal, id, status, sztuk) {
  db.prepare('INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?, ?, ?)').run(
    kanal,
    id,
    JSON.stringify({
      id,
      name: `Lampa Półcień ${id}`,
      sellingMode: { price: { amount: '59.00', currency: 'PLN' } },
      stock: { available: sztuk, unit: 'UNIT' },
      publication: { status },
    }),
  );
}
const statusWAtrapie = (id) =>
  JSON.parse(db.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE id = ?').get(id).dane_json).publication
    .status;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  woo = sklepWoo();
  wooOdczyt = sklepWoo({ uprawnienia: 'odczyt' });
  zadaniaAllegro = [];
  const atrapa = createSerwerOfertAllegro({ db, kanal: ALLEGRO, env: ENV_DEMO });
  const fetchAllegro = async (url, init = {}) => {
    const u = new URL(url);
    zadaniaAllegro.push({
      metoda: init.method ?? 'GET',
      sciezka: u.pathname,
      cialo: init.body ? JSON.parse(init.body) : undefined,
    });
    return atrapa.fetchImpl(url, init);
  };
  const klientAllegro = (fetchImpl) =>
    createAllegroClient({
      ustawienia: { api: atrapa.api, userAgent: 'atrapa/1 (+https://atrapa.example.invalid)' },
      tokeny: { waznyToken: async () => 'atrapa' },
      fetchImpl,
    });
  allegro = klientAllegro(fetchAllegro);
  const kontaAllegro = [
    { klucz: ALLEGRO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
    { klucz: WSTRZYMANE, nazwa: 'Półcień Druga', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
  ];
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    sklepy: { [WOO]: woo.klient, [WOO_ODCZYT]: wooOdczyt.klient },
    nadpisania: {
      'kanaly.klienciKanalow': { [ALLEGRO]: allegro, [WSTRZYMANE]: klientAllegro(fetchAllegro) },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'allegro' ? kontaAllegro : []),
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  zapiszUstawieniaOfertKonta(db, ALLEGRO, { czynne: true, narzutProcent: 0, stalaIlosc: 5 }, { teraz: T0 });
  zapiszUstawieniaOfertKonta(db, WSTRZYMANE, { czynne: false, narzutProcent: 0, stalaIlosc: 5 }, { teraz: T0 });
  karta = utworzKarte(
    db,
    { nazwa: 'Lampa Półcień 40', sku: 'PLC-40', cena_gr: 5900, stawka_vat: '23', marka: 'Półcień' },
    { at: T0 },
  );
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('T-E1 kolumna Status na karcie', () => {
  it('stoi między Cena a Zdjęcia; plakietki Woo z mapy, pasek potwierdzenia jako formularz bez JS', async () => {
    const opublikowany = wLustrze(WOO, '7000', 'publish');
    const szkic = wLustrze(WOO, '7200', 'draft');
    const html = await ekran();
    expect(html).toMatch(/<th>Cena<\/th>\s*<th>Status<\/th>\s*<th>Zdjęcia<\/th>/);
    const w1 = wiersz(html, opublikowany);
    expect(w1).toContain('znacznik--ok');
    expect(w1).toContain('Opublikowany');
    expect(w1).toContain('<details');
    expect(w1).toContain('Ukryj (szkic)');
    expect(w1).toContain('Ukryć produkt w sklepie? Zmieni się tylko status — klienci przestaną go widzieć.');
    expect(w1).toContain(`action="/magazyn/${karta}/status-kanalu"`);
    expect(w1).toContain(`name="produktId" value="${opublikowany}"`);
    expect(w1).toContain('name="akcja" value="ukryj"');
    expect(w1).not.toContain('confirm(');
    const w2 = wiersz(html, szkic);
    expect(w2).toContain('znacznik--cichy');
    expect(w2).toContain('Szkic');
    expect(w2).toContain('name="akcja" value="opublikuj"');
  });

  it('Woo ukryj: PUT tylko statusu rodzica, lustro z odczytu, dziennik pole=status', async () => {
    const pid = wLustrze(WOO, '7000', 'publish');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'ukryj' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/${karta}#produkty-karty`);
    expect(zapisyWoo(woo)).toEqual([{ metoda: 'PUT', sciezka: '/products/7000', cialo: { status: 'draft' } }]);
    expect(woo.zadania.at(-1)).toMatchObject({ metoda: 'GET', sciezka: '/products/7000' });
    expect(lustro(pid).status_publikacji).toBe('draft');
    expect(dziennik()).toEqual([
      {
        kanal: WOO,
        karta_id: karta,
        cel: 'produkt:7000',
        pole: 'status',
        stara: 'publish',
        nowa: 'draft',
        wynik: 'ok',
        blad: null,
      },
    ]);
    expect(wiersz(await ekran(), pid)).toContain('Szkic');
  });

  it('sklep po cichu nie zmienia statusu: lustro zostaje z odczytu (draft), wiersz mówi o odmowie', async () => {
    const pid = wLustrze(WOO, '7200', 'draft');
    woo.odmawia = true;
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'opublikuj' });
    expect(r.statusCode).toBe(409);
    expect(lustro(pid).status_publikacji).toBe('draft');
    expect(wiersz(r.body, pid)).toContain('Sklep nie zmienił statusu');
    expect(dziennik()).toMatchObject([{ pole: 'status', stara: 'draft', nowa: 'publish', wynik: 'blad' }]);
  });

  it('wariant przełącza status rodzica; pasek mówi o liczbie wariantów; wszystkie wiersze rodzica z odczytu', async () => {
    const w1 = wLustrze(WOO, '7100', 'publish', '7101');
    const w2 = wLustrze(WOO, '7100', 'publish', '7102');
    const html = await ekran();
    expect(wiersz(html, w1)).toContain('Zmieni się cały produkt z 2 wariantami.');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(w1), akcja: 'ukryj' });
    expect(r.statusCode).toBe(303);
    expect(zapisyWoo(woo)).toEqual([{ metoda: 'PUT', sciezka: '/products/7100', cialo: { status: 'draft' } }]);
    expect(lustro(w1).status_publikacji).toBe('draft');
    expect(lustro(w2).status_publikacji).toBe('draft');
  });

  it('klucz Woo tylko do odczytu: przycisk disabled z powodem, POST odmawia bez żądania', async () => {
    const pid = wLustrze(WOO_ODCZYT, '7000', 'publish');
    const w = wiersz(await ekran(), pid);
    expect(w).toMatch(/<button[^>]*disabled[^>]*>\s*Ukryj \(szkic\)/);
    expect(w).toContain('klucz sklepu tylko do odczytu');
    expect(w).not.toContain('<details');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'ukryj' });
    expect(r.statusCode).toBe(409);
    expect(wooOdczyt.zadania).toEqual([]);
    expect(lustro(pid).status_publikacji).toBe('publish');
    expect(dziennik()).toEqual([]);
  });

  it('Allegro obserwowana: zakończ przez komendę publikacji, rejestr dostaje status_z_oms, lustro z odczytu', async () => {
    ofertaWAtrapie(ALLEGRO, '17000000000901', 'ACTIVE', 3);
    const pid = wLustrze(ALLEGRO, '17000000000901', 'ACTIVE');
    const w = wiersz(await ekran(), pid);
    expect(w).toContain('Aktywna');
    expect(w).toContain('Zakończyć ofertę w Allegro? Zmieni się tylko status.');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'zakoncz' });
    expect(r.statusCode).toBe(303);
    expect(statusWAtrapie('17000000000901')).toBe('ENDED');
    expect(lustro(pid).status_publikacji).toBe('ENDED');
    const o = ofertaPoIdZewnetrznym(db, ALLEGRO, '17000000000901');
    expect(o).toMatchObject({ kartaId: karta, tryb: 'obserwowana', pochodzenie: 'przejeta', statusZOms: true });
    expect(o.cenaZOms).toBe(false);
    expect(o.iloscZOms).toBe(false);
    expect(dziennik()).toMatchObject([
      { kanal: ALLEGRO, cel: 'oferta:17000000000901', pole: 'status', stara: 'ACTIVE', nowa: 'ENDED', wynik: 'ok' },
    ]);
    const po = wiersz(await ekran(), pid);
    expect(po).toContain('Zakończona');
    expect(po).toContain('Wznowić ofertę? Allegro wystawi ją z ilością, jaką ma teraz w Allegro.');
  });

  it('Allegro odmawia wznowienia (0 sztuk): treść odmowy w wierszu, lustro zostaje ENDED', async () => {
    ofertaWAtrapie(ALLEGRO, '17000000000902', 'ENDED', 0);
    const pid = wLustrze(ALLEGRO, '17000000000902', 'ENDED');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'wznow' });
    expect(r.statusCode).toBe(409);
    expect(wiersz(r.body, pid)).toContain('Brak dostępnych sztuk.');
    expect(statusWAtrapie('17000000000902')).toBe('ENDED');
    expect(lustro(pid).status_publikacji).toBe('ENDED');
    expect(dziennik()).toMatchObject([{ pole: 'status', stara: 'ENDED', nowa: 'ACTIVE', wynik: 'blad' }]);
  });

  it('konto z wstrzymanymi ofertami: disabled z powodem, POST nic nie zapisuje (ani rejestru, ani Allegro)', async () => {
    const pid = wLustrze(WSTRZYMANE, '17000000000903', 'ACTIVE');
    const w = wiersz(await ekran(), pid);
    expect(w).toMatch(/<button[^>]*disabled/);
    expect(w).toContain('oferty wstrzymane na koncie — włącz je w ustawieniach Allegro');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'zakoncz' });
    expect(r.statusCode).toBe(409);
    expect(ofertaPoIdZewnetrznym(db, WSTRZYMANE, '17000000000903')).toBeNull();
    expect(zapisyAllegro()).toEqual([]);
    expect(ustawieniaOfertKonta(db, WSTRZYMANE).czynne).toBe(false);
  });

  it('oferta zarządzana: przycisk prowadzi do istniejącego „zdejmij”, nowa trasa odmawia', async () => {
    const pid = wLustrze(ALLEGRO, '17000000000904', 'ACTIVE');
    const o = wstawOferte(db, {
      kartaId: karta,
      kanal: ALLEGRO,
      idZewnetrzne: '17000000000904',
      pochodzenie: 'oms',
      tryb: 'zarzadzana',
      stan: 'aktywna',
    });
    const w = wiersz(await ekran(), pid);
    expect(w).toContain(`action="/magazyn/${karta}/oferty/${o.id}/zdejmij"`);
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'zakoncz' });
    expect(r.statusCode).toBe(409);
    expect(zapisyAllegro()).toEqual([]);
  });

  it('wiersz cudzej karty i akcja spoza mapy odmawiają', async () => {
    const pid = wLustrze(WOO, '7000', 'publish');
    const inna = utworzKarte(
      db,
      { nazwa: 'Lampa Półcień 60', sku: 'PLC-60', cena_gr: 6900, stawka_vat: '23' },
      { at: T0 },
    );
    expect((await post(`/magazyn/${inna}/status-kanalu`, { produktId: String(pid), akcja: 'ukryj' })).statusCode).toBe(
      404,
    );
    expect((await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'usun' })).statusCode).toBe(
      400,
    );
    expect(zapisyWoo(woo)).toEqual([]);
  });

  it('produkt, który zniknął z kanału: POST odmawia bez żadnego zapisu (Woo i Allegro)', async () => {
    const pw = wLustrze(WOO, '7000', 'publish');
    ofertaWAtrapie(ALLEGRO, '17000000000906', 'ACTIVE', 3);
    const pa = wLustrze(ALLEGRO, '17000000000906', 'ACTIVE');
    db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id IN (?, ?)').run(T0, pw, pa);
    const rw = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pw), akcja: 'ukryj' });
    const ra = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pa), akcja: 'zakoncz' });
    expect(rw.statusCode).toBe(409);
    expect(ra.statusCode).toBe(409);
    expect(zapisyWoo(woo)).toEqual([]);
    expect(zapisyAllegro()).toEqual([]);
    expect(statusWAtrapie('17000000000906')).toBe('ACTIVE');
    expect(dziennik()).toEqual([]);
  });

  it('nie-admin widzi samą plakietkę i dostaje 403 na POST', async () => {
    const pid = wLustrze(WOO, '7000', 'publish');
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, user, ['magazyn']);
    const headers = {
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
    };
    const w = wiersz(await ekran(headers), pid);
    expect(w).toContain('Opublikowany');
    expect(w).not.toContain('Ukryj (szkic)');
    const r = await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pid), akcja: 'ukryj' }, headers);
    expect(r.statusCode).toBe(403);
    expect(zapisyWoo(woo)).toEqual([]);
    expect(dziennik()).toEqual([]);
  });
});

describe('T-E2 ścieżka statusu niesie wyłącznie status', () => {
  it('Woo i Allegro: jedyne zapisy to {status} i komenda publikacji; karta bez zmian; rejestr nie otwiera innych zakresów', async () => {
    const przed = kartaPoId(db, karta);
    const pw = wLustrze(WOO, '7000', 'publish');
    ofertaWAtrapie(ALLEGRO, '17000000000905', 'ACTIVE', 2);
    const pa = wLustrze(ALLEGRO, '17000000000905', 'ACTIVE');
    expect((await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pw), akcja: 'ukryj' })).statusCode).toBe(
      303,
    );
    expect(
      (await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pw), akcja: 'opublikuj' })).statusCode,
    ).toBe(303);
    expect(
      (await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pa), akcja: 'zakoncz' })).statusCode,
    ).toBe(303);
    expect((await post(`/magazyn/${karta}/status-kanalu`, { produktId: String(pa), akcja: 'wznow' })).statusCode).toBe(
      303,
    );

    for (const z of zapisyWoo(woo)) {
      expect(z.metoda).toBe('PUT');
      expect(Object.keys(z.cialo)).toEqual(['status']);
    }
    expect(zapisyWoo(woo)).toHaveLength(2);
    const zapisy = zapisyAllegro();
    expect(zapisy).toHaveLength(2);
    for (const z of zapisy) {
      expect(z.metoda).toBe('PUT');
      expect(z.sciezka).toMatch(/^\/sale\/offer-publication-commands\/[^/]+$/);
      expect(Object.keys(z.cialo).sort()).toEqual(['offerCriteria', 'publication']);
      expect(Object.keys(z.cialo.publication)).toEqual(['action']);
    }
    expect(zapisy.map((z) => z.cialo.publication.action)).toEqual(['END', 'ACTIVATE']);

    const po = kartaPoId(db, karta);
    expect(po.cena_gr).toBe(przed.cena_gr);
    expect(po.marka).toBe(przed.marka);

    // Flaga statusu na ofercie obserwowanej nie otwiera PATCH treści, ceny ani ilości.
    const o = ofertaPoIdZewnetrznym(db, ALLEGRO, '17000000000905');
    const oferta = {
      ...o,
      status_z_oms: o.statusZOms ? 1 : 0,
      cena_z_oms: o.cenaZOms ? 1 : 0,
      ilosc_z_oms: o.iloscZOms ? 1 : 0,
    };
    const wspolne = {
      konto: { klucz: ALLEGRO, tylkoOdczyt: () => false },
      ustawienia: ustawieniaOfertKonta(db, ALLEGRO),
      oferta,
      klucze: [ALLEGRO],
      kanal: 'Allegro',
    };
    expect(bramkaZapisu({ ...wspolne, zakres: 'status' }).wolno).toBe(true);
    for (const zakres of [null, 'cena', 'ilosc']) expect(bramkaZapisu({ ...wspolne, zakres }).wolno).toBe(false);
  });
});
