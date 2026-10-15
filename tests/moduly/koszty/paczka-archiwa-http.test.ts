import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { zapiszKoszt, zapiszSciezki } from '../../../src/oms/db/koszty.js';
import { zapiszWiersz } from '../../../src/moduly/faktury/db/archiwum-sprzedazy.js';
import { odciskDokumentu } from '../../../src/domena/archiwum-sprzedazy.js';

const env = {OMS_USER:'operator',OMS_PASS:'fixture',OMS_SPRZEDAWCA_NIP:'1234563218',
  OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),INFAKT_API_KEY:'fixture',
  KSEF_TOKEN:'fixture'};
const headers = {authorization:`Basic ${Buffer.from('operator:fixture').toString('base64')}`};
const faktura = {uuid:'u-archiwum',id:1,number:'1/08/2026',kind:'vat',invoice_date:'2026-08-05',
  sale_date:'2026-08-05',net_price:10000,tax_price:2300,gross_price:12300,currency:'PLN',
  client_company_name:'Fixture',client_tax_code:'1',ksef_number:'KS-1'};
async function pdf(stron: number) {
  const d = await PDFDocument.create();
  for (let i=0;i<stron;i++) d.addPage([213,317]).drawText(`archive-${i}`);
  return Buffer.from(await d.save());
}
async function fixture(fn: (z: Awaited<ReturnType<typeof zbudujOms>>,kat: string,infakt: any,klient: any) => Promise<void>) {
  const kat = mkdtempSync(join(tmpdir(),'prz025-paczka-archiwa-'));
  const infakt = {listaFaktur:vi.fn().mockResolvedValue([]),listaKorekt:vi.fn().mockResolvedValue([]),
    pobierzPdf:vi.fn().mockRejectedValue(new Error('Nie wolno pobierać PDF sprzedaży')),
    pobierzPdfKorekty:vi.fn().mockRejectedValue(new Error('Nie wolno pobierać PDF korekty'))};
  const klient = {zaloguj:vi.fn().mockResolvedValue({accessToken:'fixture-access',accessDo:'2099-01-01T00:00:00Z',
    refreshToken:'fixture-refresh',refreshDo:'2099-02-01T00:00:00Z'}),odswiez:vi.fn(),
    pobierzXml:vi.fn().mockResolvedValue('<Faktura/>'),pobierzMetadane:vi.fn()};
  const transport = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
  let z: Awaited<ReturnType<typeof zbudujOms>> | undefined;
  try {
    z = await zbudujOms({env:{...env,KSEF_ARCHIWUM:kat,INFAKT_ARCHIWUM:kat},
      moduly:[modulRdzen,modulWeb,modulKanaly,modulFaktury,createModulKoszty({createKlient:(()=>klient) as any})] as any,
      nadpisania:{'faktury.infakt':infakt}});
    await fn(z,kat,infakt,klient);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    try { if (z) { try { await z.app.close(); } finally { z.db.close(); } } }
    finally {
      transport.mockRestore();
      const cel = resolve(kat);
      if (dirname(cel)!==resolve(tmpdir()) || !basename(cel).startsWith('prz025-paczka-archiwa-'))
        throw new Error('Nieprawidłowy katalog fixture');
      rmSync(cel,{recursive:true,force:true});
    }
  }
}
function koszt(z: Awaited<ReturnType<typeof zbudujOms>>) {
  zapiszKoszt(z.db,{ksefNumber:'K-ARCHIWUM',numerDokumentu:'FV/KOSZT',sprzedawcaNip:'1111111111',
    sprzedawcaNazwa:'Fixture',dataWystawienia:'2026-08-05',dataTrwalegoZapisu:'2026-08-05T12:00:00Z',
    netto:'100.00',vat:'23.00',brutto:'123.00',waluta:'PLN',rodzaj:'Vat',maZalacznik:0});
  zapiszSciezki(z.db,'K-ARCHIWUM',{pdf:'koszt.pdf'} as any);
}
describe('PRZ-025 HTTP paczki z rzeczywistymi archiwami i wizualizacją', () => {
  it('koszty czytają PDF z KSEF_ARCHIWUM przekazanego przez manifest', async () => {
    await fixture(async (z,kat,infakt,klient) => {
      koszt(z); writeFileSync(join(kat,'koszt.pdf'),await pdf(2));
      const r = await z.app.inject({method:'GET',url:'/faktury/paczka?miesiac=2026-08&czesc=koszty',headers});
      expect(r.statusCode).toBe(200);
      const d = await PDFDocument.load(r.rawPayload);
      expect(d.getPageCount()).toBe(3);
      expect(d.getPages().slice(1).map(p=>p.getSize())).toEqual([{width:213,height:317},{width:213,height:317}]);
      expect(klient.zaloguj).not.toHaveBeenCalled();
      expect(klient.pobierzXml).not.toHaveBeenCalled();
      expect(infakt.pobierzPdf).not.toHaveBeenCalled();
    });
  });
  it('koszt bez pliku przechodzi przez rzeczywistą wizualizację i trwałą sesję KSeF', async () => {
    await fixture(async (z,_kat,infakt,klient) => {
      koszt(z);
      const r = await z.app.inject({method:'GET',url:'/faktury/paczka?miesiac=2026-08&czesc=koszty',headers});
      expect(r.statusCode).toBe(200);
      expect((await PDFDocument.load(r.rawPayload)).getPageCount()).toBe(2);
      expect(klient.zaloguj).toHaveBeenCalledTimes(1);
      expect(klient.pobierzXml).toHaveBeenCalledTimes(1);
      expect(klient.pobierzXml).toHaveBeenCalledWith({accessToken:'fixture-access',ksefNumber:'K-ARCHIWUM'});
      expect(z.db.prepare('SELECT access_token FROM tokeny_ksef WHERE id=1').get()?.access_token).toBe('fixture-access');
      expect(infakt.pobierzPdf).not.toHaveBeenCalled();
    });
  });
  it('sprzedaż czyta aktualny PDF z INFAKT_ARCHIWUM i nie pobiera go od klienta', async () => {
    await fixture(async (z,kat,infakt,klient) => {
      infakt.listaFaktur.mockResolvedValue([faktura]);
      writeFileSync(join(kat,'sprzedaz.pdf'),await pdf(3));
      zapiszWiersz(z.db,{uuid:faktura.uuid,rodzaj:'vat',numer:faktura.number,invoiceDate:faktura.invoice_date,
        odcisk:odciskDokumentu(faktura),sciezkaPdf:'sprzedaz.pdf',zapisanyAt:'2026-08-05T12:00:00Z'});
      const r = await z.app.inject({method:'GET',url:'/faktury/paczka?miesiac=2026-08&czesc=sprzedaz',headers});
      expect(r.statusCode).toBe(200);
      const d = await PDFDocument.load(r.rawPayload);
      expect(d.getPageCount()).toBe(4);
      expect(d.getPages().slice(1).map(p=>p.getSize())).toEqual(Array.from({length:3},()=>({width:213,height:317})));
      expect(infakt.pobierzPdf).not.toHaveBeenCalled();
      expect(infakt.pobierzPdfKorekty).not.toHaveBeenCalled();
      expect(klient.pobierzXml).not.toHaveBeenCalled();
    });
  });
});
