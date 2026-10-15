import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const auth = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64') };
const konfiguracjaKanalow = { definicje: [{"klucz":"polnoc","typ":"woo","prefiks":"POLNOC","etykieta":"polnoc"},{"klucz":"wschod","typ":"allegro","prefiks":"WSCHOD","etykieta":"wschod"},{"klucz":"zachod","typ":"allegro","prefiks":"ZACHOD","etykieta":"zachod"}], sklepy: { polnoc: {} }, kanaly: { wschod: {}, zachod: {} } };
async function sklad(nadpisania = {}) {
  return zbudujOms({ env: { ...env, OMS_KANALY: JSON.stringify(konfiguracjaKanalow.definicje) }, nadpisania: { 'kanaly.config': konfiguracjaKanalow,
    'kanaly.klienciSklepow': { polnoc: { pobierzWszystkieProdukty: async () => [] } },
    'kanaly.klienciKanalow': {}, ...nadpisania } });
}
function wzor(db) {
  db.exec("INSERT INTO wzory(id,nazwa,sku,utworzony_at,zmieniony_at) VALUES(7,'Kotwica testowa','TEST-7','x','x')");
  const id = zapiszProduktSklepowy(db, { kanal: 'polnoc', produkt_id: '1', wariant_id: '', nazwa: 'Zdjęcia sklepu',
    miniatura: 'https://przyklad.invalid/prawdziwa-mini.jpg', zdjecia_json: '["https://przyklad.invalid/obraz.jpg"]', odczytane_at: 'x' });
  db.prepare('UPDATE produkty_sklepowe SET wzor_id=7 WHERE id=?').run(id);
  for (const kanal of ['wschod', 'zachod', 'obcy', 'polnoc']) zapiszProduktSklepowy(db, { kanal, produkt_id: '9',
    wariant_id: '', nazwa: `Kotwica oferta ${kanal}`, odczytane_at: 'x' });
}
afterEach(() => vi.unstubAllGlobals());
describe('PRZ-026 — rzeczywisty skład i chroniona karta', () => {
  it('bez konfiguracji kanałów zwraca pusty stan bez sieci i historycznych kanałów', async () => {
    const fetch = vi.fn(async () => { throw Error('Test nie zezwala na sieć'); }); vi.stubGlobal('fetch', fetch);
    const a = await zbudujOms({ env });
    try {
      expect(a.usluga('magazyn', 'magazyn')).toBeNull();
      const r = await a.app.inject({ url: '/magazyn/7', headers: auth });
      expect(r.statusCode).toBe(200); expect(r.body).toContain('nie ma podpiętego żadnego sklepu');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
  it('bootstrap renderuje kartę z lustra i dwie neutralne oferty, bez zapisu i ruchu sieciowego', async () => {
    const fetch = vi.fn(async () => { throw Error('Test nie zezwala na sieć'); }); vi.stubGlobal('fetch', fetch);
    const a = await sklad();
    try {
      wzor(a.db); const przed = a.db.prepare('SELECT * FROM produkty_sklepowe ORDER BY id').all();
      const r = await a.app.inject({ url: '/magazyn/7?fraza=kotwica&edytuj=dane&wroc=%2Fmagazyn%3Ffraza%3Dx', headers: auth });
      expect(r.statusCode).toBe(200);
      for (const tekst of ['Kotwica testowa', 'prawdziwa-mini.jpg', 'obraz.jpg', 'Kotwica oferta wschod', 'Kotwica oferta zachod']) expect(r.body).toContain(tekst);
      expect(r.body).not.toContain('Kotwica oferta obcy'); expect(r.body).not.toContain('Kotwica oferta polnoc');
      expect(r.body).toContain('name="wroc" value="/magazyn?fraza=x"');
      expect(a.db.prepare('SELECT * FROM produkty_sklepowe ORDER BY id').all()).toEqual(przed);
      expect(fetch).not.toHaveBeenCalled();
      expect((await a.app.inject({ url: '/magazyn/999', headers: auth })).statusCode).toBe(404);
      expect((await a.app.inject({ url: '/magazyn/7?wroc=%2F%2Fobcy.invalid', headers: auth })).body).not.toContain('href="//obcy.invalid"');
    } finally { await a.app.close(); a.db.close(); }
  });
  it('sesja bez ptaszka oraz konto serwisowe po pierwszym adminie nie mogą czytać karty', async () => {
    const a = await sklad();
    try {
      wzor(a.db);
      expect((await a.app.inject({ url: '/magazyn/7' })).statusCode).toBe(401);
      zalozKonto(a.db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
      const id = zalozKonto(a.db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
      ustawUprawnienia(a.db, id, []);
      const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(a.db), Date.now(), 0)}`;
      expect((await a.app.inject({ url: '/magazyn/7', headers: { cookie } })).statusCode).toBe(403);
      expect((await a.app.inject({ url: '/magazyn/7', headers: auth })).statusCode).toBe(403);
      ustawUprawnienia(a.db, id, ['magazyn']);
      expect((await a.app.inject({ url: '/magazyn/7', headers: { cookie } })).statusCode).toBe(200);
      a.db.prepare('UPDATE konta SET czynne=0 WHERE id=?').run(id);
      expect((await a.app.inject({ url: '/magazyn/7', headers: { cookie } })).statusCode).toBe(401);
    } finally { await a.app.close(); a.db.close(); }
  });
  it('prawdziwy przebieg współdzieli klienta kanałów i blokuje nakładający się start', async () => {
    let zakoncz; const blokada = new Promise(resolve => { zakoncz = resolve; });
    const klient = { pobierzWszystkieProdukty: vi.fn(async () => { await blokada; return [{ id: 51, name: 'Z realnego przebiegu', price: '11.00' }]; }) };
    const a = await sklad({ 'kanaly.klienciSklepow': { polnoc: klient } });
    try {
      expect(a.usluga('kanaly', 'klienciSklepow').polnoc).toBe(klient);
      const p = a.usluga('magazyn', 'magazyn');
      expect(p.start()).toEqual({ wystartowal: true }); expect(p.stan().trwa).toBe(true);
      expect(p.start()).toEqual({ wystartowal: false }); expect(klient.pobierzWszystkieProdukty).toHaveBeenCalledOnce();
      zakoncz();
      for (let i = 0; i < 20 && p.stan().trwa; i++) await new Promise(resolve => setImmediate(resolve));
      expect(p.stan()).toMatchObject({ trwa: false, blad: null, postep: null, kanaly: [{ kanal: 'polnoc', zapisane: 1, znikniete: 0, blad: null }] });
      expect(a.db.prepare('SELECT kanal,nazwa,cena_gr FROM produkty_sklepowe').get()).toEqual({ kanal: 'polnoc', nazwa: 'Z realnego przebiegu', cena_gr: 1100 });
    } finally { zakoncz(); await a.app.close(); a.db.close(); }
  });
});
