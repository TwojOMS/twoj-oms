import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { cenyReczneKarty } from '../../../src/oms/db/ceny-kanalow.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zapiszUstawieniaOfertKonta, zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { jako } from '../../pomoc/panel-konta-testowe.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const ERLI = 'erli-polcien';
const ALLEGRO = 'aukcje_polcien';
const PODGLAD = '/magazyn/ceny-kanalow/podglad';
const ZATWIERDZ = '/magazyn/ceny-kanalow/zatwierdz';
const definicje = [
  { klucz: ERLI, typ: 'erli', etykieta: 'ERLI Półcień' },
  { klucz: ALLEGRO, typ: 'allegro', etykieta: 'Allegro Półcień' },
];

let db, app, karta, erli, allegro, blokadaErli;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 10000 });
  zalozKonto(db, { login: 'opiekun', imie: 'Opiekun', haslo: 'atrapa', rola: 'administrator', admin: true });
  erli = {
    pobierzProdukt: vi.fn(async () => ({ price: 10500, name: 'Lampa zarządzana w ERLI' })),
    zmienProdukty: vi.fn(),
  };
  allegro = {
    pobierzOferte: vi.fn(async () => ({ sellingMode: { price: { amount: '105.00', currency: 'PLN' } } })),
    komendaCeny: vi.fn(),
    wynikKomendy: vi.fn(),
  };
  blokadaErli = false;
  app = buildOmsServer({
    db,
    config: { auth: { user: 'serwis-testowy', pass: 'atrapa' }, definicje, sklepy: {}, kanaly: {} },
    nadpisania: {
      'kanaly.klienciKanalow': { [ERLI]: erli, [ALLEGRO]: allegro },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => definicje.filter((d) => d.typ === typ).map((d) => ({ ...d, autoryzacja: 'polaczone' })),
        zapisyZablokowane: (kanal) => kanal === ERLI && blokadaErli,
      },
    },
  });
  await app.ready();
  for (const kanal of [ERLI, ALLEGRO]) {
    zapiszUstawieniaOfertKonta(db, kanal, { czynne: true, narzutProcent: 10 });
  }
});

afterEach(async () => {
  await app?.close();
  db?.close();
});

function oferta(kanal, idZewnetrzne, pochodzenie = 'oms') {
  return wstawOferte(db, { kartaId: karta, kanal, idZewnetrzne, pochodzenie, stan: 'aktywna' });
}

function post(url, pola) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      ...jako(db, 'opiekun'),
      origin: 'http://localhost',
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams(pola).toString(),
  });
}

async function okienkoErli() {
  const r = await app.inject({ url: `/magazyn/${karta}`, headers: jako(db, 'opiekun') });
  expect(r.statusCode).toBe(200);
  const okienko = [...r.body.matchAll(/<article class="sprzedaz-kanalow-okienko">[\s\S]*?<\/article>/gu)].find(
    ([html]) => html.includes('ERLI Półcień'),
  )?.[0];
  expect(okienko).toBeDefined();
  return okienko;
}

async function podglad() {
  const r = await post(PODGLAD, { karty: karta });
  expect(r.statusCode).toBe(200);
  return r;
}

async function sprawdzBlokade(r, kanal, klucz) {
  const wiersz = [...r.body.matchAll(/<tr>[\s\S]*?<\/tr>/gu)].find(([html]) => html.includes(kanal))?.[0];
  expect(wiersz).toContain('klucz tylko do odczytu');
  expect(wiersz).not.toContain('type="checkbox"');
  const podpis = /name="podpis" value="([^"]+)"/u.exec(r.body)?.[1];
  expect(podpis).toBeTruthy();
  expect((await post(ZATWIERDZ, { podpis, [klucz]: '1' })).statusCode).toBe(400);
}

it('podgląd z trasy odczytuje zarządzaną ofertę ERLI i pozwala wybrać jej cenę', async () => {
  oferta(ERLI, 'E-1');
  const r = await podglad();
  expect(r.body).toContain('Lampa zarządzana w ERLI');
  expect(r.body).toMatch(/110,00\s+zł/u);
  expect(r.body).toContain(`name="${ERLI}|oferta:E-1"`);
  expect(erli.pobierzProdukt).toHaveBeenCalledWith('E-1');
});

it('blokuje wybór i wysłanie ceny w Allegro bez zgody na oferty', async () => {
  const o = oferta(ALLEGRO, '123456', 'przejeta');
  zmienOferte(db, o.id, { cenaZOms: true });
  await sprawdzBlokade(await podglad(), 'Allegro Półcień', `${ALLEGRO}|oferta:123456`);
  expect(allegro.komendaCeny).not.toHaveBeenCalled();
});

it('blokuje wybór i wysłanie ceny na koncie ERLI tylko do odczytu', async () => {
  oferta(ERLI, 'E-1');
  blokadaErli = true;
  await sprawdzBlokade(await podglad(), 'ERLI Półcień', `${ERLI}|oferta:E-1`);
  expect(erli.zmienProdukty).not.toHaveBeenCalled();
});

it('w okienku zarządzanej oferty ERLI pokazuje narzut i przyjmuje ręczną cenę', async () => {
  oferta(ERLI, 'E-1');
  const przed = await okienkoErli();
  expect(przed).toContain('z karty + 10% (110,00 zł)');
  expect(przed).not.toContain('bez ceny');
  const url = `/magazyn/${karta}/cena-kanalu`;
  expect((await post(url, { kanal: ERLI, cena_zl: '106,00' })).statusCode).toBe(303);
  expect(cenyReczneKarty(db, karta).get(ERLI)).toBe(10600);
  const html = await okienkoErli();
  expect(html).toContain('ręczna 106,00 zł');
  expect(html).toContain(`action="${url}"`);
  expect(html).toContain(`name="kanal" value="${ERLI}"`);
  expect(html).toMatch(/name="cena_zl"[^>]*value="106,00"/u);
  expect(erli.zmienProdukty).not.toHaveBeenCalled();
});

it('dla niezarządzanej oferty ERLI ukrywa cenę docelową i odmawia zapisu ręcznej', async () => {
  const o = oferta(ERLI, 'E-1', 'przejeta');
  zmienOferte(db, o.id, { cenaZOms: true });
  const html = await okienkoErli();
  expect(html).not.toContain('Cena w kanale:');
  expect(html).not.toContain('name="cena_zl"');
  expect((await post(`/magazyn/${karta}/cena-kanalu`, { kanal: ERLI, cena_zl: '106' })).statusCode).toBe(404);
  expect(cenyReczneKarty(db, karta).size).toBe(0);
});
