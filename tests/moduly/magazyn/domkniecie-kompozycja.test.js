import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt, zapiszKarte } from '../../../src/oms/db/magazyn.js';

const definicjeKanalow = [{"klucz":"polnoc","typ":"woo","prefiks":"POLNOC","etykieta":"polnoc"},{"klucz":"poludnie","typ":"woo","prefiks":"POLUDNIE","etykieta":"poludnie"},{"klucz":"wschod","typ":"allegro","prefiks":"WSCHOD","etykieta":"wschod"},{"klucz":"zachod","typ":"allegro","prefiks":"ZACHOD","etykieta":"zachod"}];

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'), origin: 'http://localhost' };
async function sklad(sklepy = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć jest zabroniona w tym pomiarze'); }));
  return zbudujOms({ env: { ...env, OMS_KANALY: JSON.stringify(definicjeKanalow) }, nadpisania: {
    'kanaly.config': { definicje: definicjeKanalow, sklepy: { polnoc: {}, poludnie: {} }, kanaly: { wschod: {}, zachod: {} } },
    'kanaly.klienciSklepow': { polnoc: { pobierzWszystkieProdukty: async () => [] }, ...sklepy },
    'kanaly.klienciKanalow': {},
  } });
}
function produkt(db, kartaId, kanal, produkt_id = '701') {
  const id = zapiszProduktSklepowy(db, { kanal, produkt_id, wariant_id: '', nazwa: `Lustro ${kanal}`,
    sku_sklepu: null, odczytane_at: '2026-10-01T10:00:00.000Z' });
  if (kartaId) powiazProdukt(db, id, kartaId);
  return id;
}
const trasy = [['GET','/magazyn'],['POST','/magazyn/odswiez'],['GET','/magazyn/pominiete'],
  ['POST','/magazyn/utworz-karty'],['POST','/magazyn/hurt'],['POST','/magazyn/hurt/zatwierdz'],
  ['POST','/magazyn/sku-podglad'],['POST','/magazyn/sku-zapisz'],['POST','/magazyn/przejmij-podglad'],
  ['POST','/magazyn/przejmij-zapisz'],['POST','/magazyn/podglad-zapisu'],['POST','/magazyn/zapisz-do-sklepow'],
  ['GET','/magazyn/powiazania'],['POST','/magazyn/powiazania'],['POST','/magazyn/powiazania/odepnij'],
  ['POST','/magazyn/1'],['POST','/magazyn/1/powiaz'],['POST','/magazyn/1/odepnij']];
afterEach(() => vi.unstubAllGlobals());
describe('PRZ-026 — brakujące trasy w rzeczywistym składzie', () => {
  it('rejestruje wszystkie 18 tras i chroni je globalnym uwierzytelnieniem', async () => {
    const a = await sklad();
    try {
      utworzKarte(a.db, { nazwa: 'Kandelabr', sku: 'TEST-7' });
      for (const [method,url] of trasy) {
        const r = await a.app.inject({ method, url, headers, payload: method === 'POST' ? {} : undefined });
        expect(r.statusCode, `${method} ${url}: ${r.body}`).not.toBe(404);
        expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(500);
        const odmowa = await a.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
        expect(odmowa.statusCode, `${method} ${url}`).toBe(401);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
  it('lista pokazuje skonfigurowane neutralne kanały i zachowuje stan bazy', async () => {
    const a = await sklad();
    try {
      const id = utworzKarte(a.db, { nazwa: 'Kandelabr testowy', sku: 'TEST-7' });
      produkt(a.db,id,'polnoc'); produkt(a.db,id,'wschod');
      const przed = a.db.prepare('SELECT * FROM produkty_sklepowe ORDER BY id').all();
      const r = await a.app.inject({ url: '/magazyn?fraza=Kandelabr&kanal=polnoc', headers });
      expect(r.statusCode).toBe(200); expect(r.body).toContain('Kandelabr testowy');
      for (const kanal of ['polnoc','poludnie','wschod','zachod']) expect(r.body).toContain(kanal);
      for (const kanal of ['allegro_szkicownia','allegro_amarka']) expect(r.body).not.toContain(kanal);
      expect(a.db.prepare('SELECT * FROM produkty_sklepowe ORDER BY id').all()).toEqual(przed);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
  it('podgląd sklepu nie zapisuje; potwierdzenie przelicza SKU i izoluje błąd drugiego produktu', async () => {
    const wykonane = [];
    const klient = {
      pobierzWszystkieProdukty: async () => [],
      ustawienieSklepu: async () => 'cm',
      pobierzProdukt: async sciezka => ({ id: Number(sciezka.split('/').at(-1)), sku: '' }),
      zapiszProdukt: async (sciezka,pola) => { wykonane.push({ sciezka,pola }); if (sciezka.endsWith('/702')) throw Error('Błąd drugiego produktu'); return { id: 701, ...pola }; },
    };
    const a = await sklad({ polnoc: klient });
    try {
      const id = utworzKarte(a.db, { nazwa: 'Kandelabr', sku: 'PIERWSZE', szerokosc_mm: 700, wysokosc_mm: 1000 });
      const dobry = produkt(a.db,id,'polnoc','701'); const zly = produkt(a.db,id,'polnoc','702');
      const podglad = await a.app.inject({ method:'POST', url:'/magazyn/podglad-zapisu', headers, payload:{ zaznaczone:String(id) } });
      expect(podglad.statusCode).toBe(200); expect(podglad.body).toContain('PIERWSZE'); expect(wykonane).toEqual([]);
      zapiszKarte(a.db,id,{ sku:'DRUGIE' });
      const wynik = await a.app.inject({ method:'POST', url:'/magazyn/zapisz-do-sklepow', headers, payload:{ zaznaczone:String(id) } });
      expect(wynik.statusCode).toBe(200); expect(wynik.body).toContain('Błąd drugiego produktu');
      expect(wykonane).toHaveLength(2);
      for (const x of wykonane) expect(x.pola).toMatchObject({ sku:'DRUGIE', dimensions:{ width:'70', length:'100' } });
      expect(a.db.prepare('SELECT sku_sklepu,karta_id FROM produkty_sklepowe WHERE id=?').get(dobry)).toEqual({ sku_sklepu:'DRUGIE', karta_id:id });
      expect(a.db.prepare('SELECT sku_sklepu,karta_id FROM produkty_sklepowe WHERE id=?').get(zly)).toEqual({ sku_sklepu:null, karta_id:id });
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
  it('powiązanie i odpięcie działają dla jawnego neutralnego kanału, chroniąc produkt sklepu', async () => {
    const a = await sklad();
    try {
      const id = utworzKarte(a.db,{ nazwa:'Kandelabr' });
      const oferta = produkt(a.db,null,'wschod'); const sklep = produkt(a.db,id,'polnoc');
      const przypnij = await a.app.inject({ method:'POST',url:`/magazyn/${id}/powiaz`,headers,payload:{ produktSklepowyId:String(oferta) } });
      expect(przypnij.statusCode).toBe(303);
      expect(a.db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id=?').get(oferta).karta_id).toBe(id);
      const odmowa = await a.app.inject({ method:'POST',url:`/magazyn/${id}/odepnij`,headers,payload:{ produktSklepowyId:String(sklep) } });
      expect(odmowa.statusCode).toBe(409);
      const odepnij = await a.app.inject({ method:'POST',url:`/magazyn/${id}/odepnij`,headers,payload:{ produktSklepowyId:String(oferta) } });
      expect(odepnij.statusCode).toBe(303);
      expect(a.db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id=?').get(oferta).karta_id).toBeNull();
      expect(a.db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id=?').get(sklep).karta_id).toBe(id);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
});
