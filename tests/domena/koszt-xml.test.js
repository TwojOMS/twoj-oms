import { describe, it, expect } from 'vitest';
import { pozycjeZXml } from '../../src/domena/koszt-xml.js';

// ⚠️ KSZTAŁT XML-a ZMIERZONY NA ŻYWYM API (Zadanie 0, 12.08.2026): `FA (3)`, schema `1-0E`,
// przestrzeń `http://crd.gov.pl/wzor/2025/06/25/13775/`. Pozycje to `FaWiersz`:
// `NrWierszaFa`, `P_7` (nazwa), `P_8A` (jednostka), `P_8B` (ilość), `P_9A` (cena netto),
// `P_11` (wartość netto), `P_12` (stawka VAT). To nie są zgadywanki — tak wygląda dokument
// pobrany z produkcji.
const XML_FA3 = `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Naglowek>
    <KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>
    <WariantFormularza>3</WariantFormularza>
    <DataWytworzeniaFa>2026-06-05T08:12:31Z</DataWytworzeniaFa>
  </Naglowek>
  <Podmiot1>
    <DaneIdentyfikacyjne>
      <NIP>5252674798</NIP>
      <Nazwa>Księgarnia Świąteczna sp. z o.o.</Nazwa>
    </DaneIdentyfikacyjne>
    <Adres>
      <KodKraju>PL</KodKraju>
      <AdresL1>ul. Różana 7/3</AdresL1>
      <AdresL2>00-001 Warszawa</AdresL2>
    </Adres>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne>
      <NIP>5492443929</NIP>
      <Nazwa>Skąpańde Marek Zywiecki</Nazwa>
    </DaneIdentyfikacyjne>
  </Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-06-05</P_1>
    <P_2>FV/2026/06/12</P_2>
    <P_13_1>100.00</P_13_1>
    <P_14_1>23.00</P_14_1>
    <P_15>123.00</P_15>
    <Adnotacje>
      <P_16>2</P_16>
      <P_17>2</P_17>
    </Adnotacje>
    <RodzajFaktury>VAT</RodzajFaktury>
    <FaWiersz>
      <NrWierszaFa>1</NrWierszaFa>
      <P_7>Papier ksero A4 80g „Śnieżka" &amp; spółka</P_7>
      <P_8A>ryza</P_8A>
      <P_8B>2.0000</P_8B>
      <P_9A>18.50</P_9A>
      <P_11>37.00</P_11>
      <P_12>23</P_12>
    </FaWiersz>
    <FaWiersz>
      <NrWierszaFa>2</NrWierszaFa>
      <P_7>Usługa hostingu — czerwiec 2026</P_7>
      <P_8A>szt</P_8A>
      <P_8B>1.5000</P_8B>
      <P_9A>42.00</P_9A>
      <P_11>63.00</P_11>
      <P_12>zw</P_12>
    </FaWiersz>
  </Fa>
</Faktura>`;

describe('pozycje faktury kosztowej z XML-a FA(3)', () => {
  it('czyta wszystkie wiersze FaWiersz w kolejności dokumentu', () => {
    const pozycje = pozycjeZXml(XML_FA3);
    expect(pozycje).toHaveLength(2);
    expect(pozycje.map((p) => p.lp)).toEqual(['1', '2']);
    expect(pozycje[1].nazwa).toBe('Usługa hostingu — czerwiec 2026');
  });

  it('mapuje pola FA(3) na nazwy panelu i rozpakowuje encje XML-a', () => {
    const [pierwsza] = pozycjeZXml(XML_FA3);
    expect(pierwsza).toEqual({
      lp: '1',
      nazwa: 'Papier ksero A4 80g „Śnieżka" & spółka',
      jednostka: 'ryza',
      ilosc: '2',
      cenaNetto: '18.50',
      wartoscNetto: '37.00',
      stawkaVat: '23%',
    });
  });

  it('⚠️ ilość gubi zera nieznaczące — „2.0000 ryzy" to nie jest zapis z faktury', () => {
    const [pierwsza, druga] = pozycjeZXml(XML_FA3);
    expect(pierwsza.ilosc).toBe('2');
    expect(druga.ilosc).toBe('1.5');
  });

  it('⚠️ stawka nieliczbowa („zw", „np") zostaje jaka jest — procent by ją zmyślił', () => {
    expect(pozycjeZXml(XML_FA3)[1].stawkaVat).toBe('zw');
  });

  it('radzi sobie z przedrostkiem przestrzeni nazw', () => {
    const zPrzedrostkiem = XML_FA3
      .replace(/<(\/?)(FaWiersz|P_7|P_8A|P_8B|P_9A|P_11|P_12|NrWierszaFa)>/g, '<$1tns:$2>');
    const pozycje = pozycjeZXml(zPrzedrostkiem);
    expect(pozycje).toHaveLength(2);
    expect(pozycje[0].nazwa).toBe('Papier ksero A4 80g „Śnieżka" & spółka');
  });

  it('brakujące pole daje pusty napis, a nie „undefined" na dokumencie', () => {
    const chudy = `<Faktura><Fa><FaWiersz><P_7>Opłata</P_7><P_11>10.00</P_11></FaWiersz></Fa></Faktura>`;
    expect(pozycjeZXml(chudy)).toEqual([{
      lp: '1', nazwa: 'Opłata', jednostka: '', ilosc: '', cenaNetto: '', wartoscNetto: '10.00', stawkaVat: '',
    }]);
  });

  it('⚠️ dokument BEZ pozycji oddaje pustą listę, a nie wyjątek — PDF ma i tak powstać', () => {
    expect(pozycjeZXml('<Faktura><Fa><P_15>123.00</P_15></Fa></Faktura>')).toEqual([]);
    expect(pozycjeZXml('')).toEqual([]);
    expect(pozycjeZXml(null)).toEqual([]);
  });

  it('pusty znacznik samozamykający się nie wywraca odczytu', () => {
    const zPustym = '<Faktura><Fa><FaWiersz><NrWierszaFa>7</NrWierszaFa>'
      + '<P_7>Rabat</P_7><P_8A/><P_11>-5.00</P_11></FaWiersz></Fa></Faktura>';
    const [p] = pozycjeZXml(zPustym);
    expect(p.lp).toBe('7');
    expect(p.jednostka).toBe('');
    expect(p.wartoscNetto).toBe('-5.00');
  });
});
