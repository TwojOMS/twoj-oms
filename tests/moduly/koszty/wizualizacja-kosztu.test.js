import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKoszt, zapiszRecznyKoszt } from '../../../src/oms/db/koszty.js';
import { naWierszReczny } from '../../../src/domena/koszt-reczny.js';
import { createWizualizacjaKosztu } from '../../../src/moduly/koszty/services/wizualizacja-kosztu.js';

const XML = '<Faktura><Fa><FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Papier ksero</P_7>'
  + '<P_8A>ryza</P_8A><P_8B>2.0000</P_8B><P_9A>18.50</P_9A><P_11>37.00</P_11>'
  + '<P_12>23</P_12></FaWiersz></Fa></Faktura>';

const wiersz = (n = {}) => ({
  ksefNumber: 'K-1', numerDokumentu: 'FV/2026/06/12', sprzedawcaNip: '5252674798',
  sprzedawcaNazwa: 'Księgarnia Świąteczna', dataWystawienia: '2026-06-05',
  dataTrwalegoZapisu: '2026-06-05T14:00:00Z', netto: '100.00', vat: '23.00', brutto: '123.00',
  waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...n,
});

describe('wizualizacja kosztu na żądanie', () => {
  // ⚠️⚠️ TO JEST CALY POWOD ISTNIENIA TEJ USLUGI. Archiwum na NAS-ie jest na produkcji
  // WYLACZONE (`KSEF_ARCHIWUM` nieustawione), wiec `sciezka_xml`/`sciezka_pdf` sa puste —
  // a przycisk „PDF" ma dzialac mimo to.
  it('pobiera XML z KSeF NA ZADANIE, także gdy archiwum nic nie zapisało', async () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    let widziany = null;
    const usluga = createWizualizacjaKosztu({
      db,
      klient: {
        pobierzXml: async ({ accessToken, ksefNumber }) => {
          widziany = { accessToken, ksefNumber };
          return XML;
        },
      },
      sesja: { accessToken: async () => 'ACC-Z-BAZY' },
    });

    const { wiersz: w, bajty } = await usluga.pdf('K-1');

    expect(widziany).toEqual({ accessToken: 'ACC-Z-BAZY', ksefNumber: 'K-1' });
    expect(w.numer_dokumentu).toBe('FV/2026/06/12');
    expect(bajty.subarray(0, 5).toString()).toBe('%PDF-');
    expect(db.prepare('SELECT sciezka_xml FROM koszty WHERE ksef_number = ?').get('K-1').sciezka_xml).toBeNull();
  });

  // ⚠️ PUSTY DOKUMENT WYGLADA JAK DOKUMENT, KTORY SIE UDAL. Nieznany numer KSeF ma wiec
  // ODMOWIC zdaniem dla operatora (trasa zamienia je na 400), a nie narysowac kartki
  // z samymi pustymi polami.
  it('⚠️ nieznany numer KSeF odmawia, zamiast narysować pusty dokument', async () => {
    const usluga = createWizualizacjaKosztu({
      db: openOmsDb(),
      klient: { pobierzXml: async () => { throw new Error('nie wolno bylo tego wolac'); } },
      sesja: { accessToken: async () => { throw new Error('nie wolno bylo tego wolac'); } },
    });

    await expect(usluga.pdf('NIE-MA-TAKIEGO')).rejects.toMatchObject({
      dlaOperatora: true,
      message: expect.stringContaining('NIE-MA-TAKIEGO'),
    });
  });

  // XML bez ani jednej pozycji (albo o ksztalcie, ktorego parser nie rozpozna) NIE MA PRAWA
  // zabrac operatorowi podgladu: kwoty i sprzedawca ida z metadanych KSeF, ktore sa w bazie.
  it('dokument bez pozycji w XML-u i tak daje PDF', async () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-2' }));
    const usluga = createWizualizacjaKosztu({
      db,
      klient: { pobierzXml: async () => '<Faktura><Fa><P_15>123.00</P_15></Fa></Faktura>' },
      sesja: { accessToken: async () => 'ACC' },
    });

    const { bajty } = await usluga.pdf('K-2');
    expect(bajty.length).toBeGreaterThan(1000);
  });

  // ⚠️⚠️ DOKUMENT WPISANY RĘCZNIE NIE MA ORYGINAŁU W KSeF. Ekran nie pokazuje przy nim
  // przycisku „PDF", ale adres da się wpisać z ręki — a bez tej bramki poszłoby stąd pytanie
  // do KSeF o numer „RECZNY-…" i operator dostałby odmowę MF przetłumaczoną na „nie udało się
  // przygotować dokumentu": zdanie prawdziwe i mylące.
  it('⚠️ koszt wpisany ręcznie odmawia BEZ pytania KSeF', async () => {
    const db = openOmsDb();
    const klucz = zapiszRecznyKoszt(db, naWierszReczny(
      { dataWystawienia: '2026-06-05', kwota: '100.00' },
      { nazwa: 'Anthropic', sprzedawca: 'Anthropic PBC', kategoria: 'Oprogramowanie', typ: 'staly' },
    ));
    const usluga = createWizualizacjaKosztu({
      db,
      klient: { pobierzXml: async () => { throw new Error('nie wolno bylo tego wolac'); } },
      sesja: { accessToken: async () => { throw new Error('nie wolno bylo tego wolac'); } },
    });

    await expect(usluga.pdf(klucz)).rejects.toMatchObject({
      dlaOperatora: true,
      message: expect.stringContaining('ręcznie'),
    });
  });
});
