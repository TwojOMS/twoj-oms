import { describe, it, expect } from 'vitest';
import { dokumentZXml } from '../../src/domena/koszt-xml.js';

// ⚠️ KSZTAŁTY PONIŻEJ SĄ PRZEPISANE ZE STRUKTURY PRAWDZIWYCH DOKUMENTÓW z archiwum kosztów
// na NAS-ie (`FAKTURY/Kosztowe 2026/**`, przeczytane 2026-09-03) — DPD, PayU, OVH, Apilo,
// A-Z BIURO, ELMAS, Allegro w EUR. Dane firm wystawców są publiczne (NIP i adres z faktury),
// nabywcą jest nasza własna firma. To NIE są zgadywanki z dokumentacji: każdy węzeł użyty
// w teście stoi w co najmniej jednym pliku, który naprawdę przyszedł z KSeF.
//
// Rzeczy zmierzone na tych plikach, a NIE wynikające z lektury schemy:
//  • przedrostek przestrzeni nazw bywa `tns:` (Subiekt GT) i `ns1:` (TERG) — nie tylko brak,
//  • `P_6` (data sprzedaży) POTRAFI NIE ISTNIEĆ, a zamiast niej stoi `OkresFa/P_6_Od..P_6_Do`
//    (OVH, P4, Allegro) albo `P_6A` przy pozycji,
//  • pozycja potrafi nie mieć NETTO w ogóle: ELMAS niesie sam `P_9B` (cena brutto)
//    i `P_11A` (wartość brutto) — wizualizacja licząca tylko na `P_11` pokazywała pustkę,
//  • `P_13_2`/`P_13_3` bywają obecne z wartością `0` (HURTEL),
//  • `P_14_1W` (VAT w PLN) pojawia się na fakturach w obcej walucie (Allegro EUR/CZK),
//  • `Podmiot2` bywa z `AdresKoresp` obok `Adres` (P4) — czytanie samego `AdresL1`
//    z całego podmiotu trafiłoby w adres korespondencyjny.
const XML_PELNY = `<?xml version="1.0" encoding="utf-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Naglowek>
    <KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>
    <WariantFormularza>3</WariantFormularza>
    <DataWytworzeniaFa>2026-08-04T09:20:10</DataWytworzeniaFa>
    <SystemInfo>DPDAx</SystemInfo>
  </Naglowek>
  <Podmiot1>
    <PrefiksPodatnika>PL</PrefiksPodatnika>
    <DaneIdentyfikacyjne>
      <NIP>1000001069</NIP>
      <Nazwa>DPD Polska Sp. z o.o.</Nazwa>
    </DaneIdentyfikacyjne>
    <Adres>
      <KodKraju>PL</KodKraju>
      <AdresL1>ul. Spokojna 5</AdresL1>
      <AdresL2>02-274 Warszawa</AdresL2>
    </Adres>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne>
      <NIP>1234563218</NIP>
      <Nazwa>Lumina Marek Zywiecki</Nazwa>
    </DaneIdentyfikacyjne>
    <Adres>
      <KodKraju>PL</KodKraju>
      <AdresL1>1 Maja 5</AdresL1>
      <AdresL2>00-650 Pęki</AdresL2>
    </Adres>
    <AdresKoresp>
      <KodKraju>PL</KodKraju>
      <AdresL1>UL. KRAKOWSKA 91</AdresL1>
      <AdresL2>00-650 PĘKI</AdresL2>
    </AdresKoresp>
    <NrKlienta>278216</NrKlienta>
    <JST>2</JST>
    <GV>2</GV>
  </Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-08-04</P_1>
    <P_1M>Warszawa</P_1M>
    <P_2>BC11206615</P_2>
    <P_6>2026-07-31</P_6>
    <P_13_1>544.45</P_13_1>
    <P_14_1>125.23</P_14_1>
    <P_13_2>10.00</P_13_2>
    <P_14_2>0.80</P_14_2>
    <P_13_7>29.00</P_13_7>
    <P_15>709.48</P_15>
    <Adnotacje>
      <P_16>2</P_16>
      <P_17>2</P_17>
      <P_18>2</P_18>
      <P_18A>1</P_18A>
      <Zwolnienie>
        <P_19N>1</P_19N>
      </Zwolnienie>
      <NoweSrodkiTransportu>
        <P_22N>1</P_22N>
      </NoweSrodkiTransportu>
      <P_23>2</P_23>
      <PMarzy>
        <P_PMarzyN>1</P_PMarzyN>
      </PMarzy>
    </Adnotacje>
    <RodzajFaktury>VAT</RodzajFaktury>
    <FaWiersz>
      <NrWierszaFa>1</NrWierszaFa>
      <P_7>Usługi dodatkowe dla paczek abonamentowych</P_7>
      <P_8A>szt.</P_8A>
      <P_8B>1.0000</P_8B>
      <P_9A>16.20</P_9A>
      <P_11>16.20</P_11>
      <P_11A>19.93</P_11A>
      <P_11Vat>3.73</P_11Vat>
      <P_12>23</P_12>
    </FaWiersz>
    <FaWiersz>
      <NrWierszaFa>2</NrWierszaFa>
      <P_6A>2026-07-15</P_6A>
      <P_7>Abonament</P_7>
      <P_8A>szt.</P_8A>
      <P_8B>2</P_8B>
      <P_9A>127.50</P_9A>
      <P_10>5.00</P_10>
      <P_11>250.00</P_11>
      <P_11Vat>57.50</P_11Vat>
      <P_12>23</P_12>
    </FaWiersz>
    <FaWiersz>
      <NrWierszaFa>3</NrWierszaFa>
      <P_7>Usługa kurierska krajowa</P_7>
      <P_8A>szt.</P_8A>
      <P_8B>1</P_8B>
      <P_9A>100.00</P_9A>
      <P_11>100.00</P_11>
      <P_12>23</P_12>
    </FaWiersz>
    <Platnosc>
      <Zaplacono>1</Zaplacono>
      <DataZaplaty>2026-08-06</DataZaplaty>
      <TerminPlatnosci>
        <Termin>2026-08-14</Termin>
      </TerminPlatnosci>
      <FormaPlatnosci>6</FormaPlatnosci>
      <RachunekBankowy>
        <NrRB>77109010140000000000000002</NrRB>
        <SWIFT>INGBPLPW</SWIFT>
      </RachunekBankowy>
    </Platnosc>
  </Fa>
</Faktura>`;

// PayU: faktura ZWOLNIONA (`P_13_7`, stawka pozycji `zw`), z podstawą zwolnienia w `P_19A`
// i zapłatą opisową (`PlatnoscInna/OpisPlatnosci`) zamiast formy z listy.
const XML_ZWOLNIONY = `<?xml version="1.0" encoding="utf-8"?><Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Naglowek><DataWytworzeniaFa>2026-08-08T01:18:07</DataWytworzeniaFa></Naglowek><Podmiot1><DaneIdentyfikacyjne><NIP>1000001075</NIP><Nazwa>PayU S.A.</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>Grunwaldzka 186 ; 60-166 Poznań</AdresL1></Adres></Podmiot1><Podmiot2><DaneIdentyfikacyjne><NIP>1234563218</NIP><Nazwa>Lumina Marek Zywiecki</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>Pęki, ul. 1 Maja 5; 00650 Pęki</AdresL1></Adres></Podmiot2><Fa><KodWaluty>PLN</KodWaluty><P_1>2026-08-08</P_1><P_2>2027/1400138343</P_2><P_6>2026-08-07</P_6><P_13_7>29</P_13_7><P_15>29</P_15><Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19>1</P_19><P_19A>ZWOLNIENIE NA PODSTAWIE ART. 43, UST. 1, PKT 40 USTAWY O VAT</P_19A></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje><RodzajFaktury>VAT</RodzajFaktury><FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Opłata aktywacyjna w serwisie PayU.pl</P_7><P_8A>ST</P_8A><P_8B>1</P_8B><P_9A>29</P_9A><P_11>29</P_11><P_12>zw</P_12></FaWiersz><Platnosc><Zaplacono>1</Zaplacono><DataZaplaty>2026-08-07</DataZaplaty><PlatnoscInna>1</PlatnoscInna><OpisPlatnosci>Pobrano z wpływów. Faktura nie wymaga zapłaty</OpisPlatnosci></Platnosc></Fa></Faktura>`;

describe('dokumentZXml — komplet elementów art. 106e z XML-a FA(3)', () => {
  it('czyta nagłówek, obie strony transakcji i metryczkę dokumentu', () => {
    const d = dokumentZXml(XML_PELNY);
    expect(d.dataWytworzenia).toBe('2026-08-04T09:20:10');
    expect(d.numer).toBe('BC11206615');
    expect(d.dataWystawienia).toBe('2026-08-04');
    expect(d.miejsceWystawienia).toBe('Warszawa');
    expect(d.dataSprzedazy).toBe('2026-07-31');
    expect(d.waluta).toBe('PLN');
    expect(d.rodzajFaktury).toBe('VAT');
    expect(d.naleznoscOgolem).toBe('709.48');

    expect(d.sprzedawca.nazwa).toBe('DPD Polska Sp. z o.o.');
    expect(d.sprzedawca.identyfikator).toBe('NIP: 1000001069');
    expect(d.sprzedawca.adres).toEqual(['ul. Spokojna 5', '02-274 Warszawa']);

    expect(d.nabywca.nazwa).toBe('Lumina Marek Zywiecki');
    expect(d.nabywca.identyfikator).toBe('NIP: 1234563218');
    // ⚠️ Adres, nie AdresKoresp — na fakturze stoi siedziba nabywcy.
    expect(d.nabywca.adres).toEqual(['1 Maja 5', '00-650 Pęki']);
  });

  it('⚠️ NABYWCA JEST NA DOKUMENCIE — bez niego wizualizacja nie nadaje się do biura', () => {
    expect(dokumentZXml(XML_PELNY).nabywca.nazwa).not.toBe('');
    expect(dokumentZXml(XML_ZWOLNIONY).nabywca.identyfikator).toBe('NIP: 1234563218');
  });

  it('składa podsumowanie VAT z tych stawek, które w dokumencie SĄ', () => {
    const { stawki } = dokumentZXml(XML_PELNY);
    expect(stawki.map((s) => s.kod)).toEqual(['P_13_1', 'P_13_2', 'P_13_7']);
    expect(stawki[0]).toMatchObject({ netto: '544.45', vat: '125.23', brutto: '669.68' });
    expect(stawki[1]).toMatchObject({ netto: '10.00', vat: '0.80', brutto: '10.80' });
    // Stawka zwolniona nie ma VAT-u — brutto równa się netto, a kolumna VAT zostaje pusta.
    expect(stawki[2]).toMatchObject({ netto: '29.00', vat: '', brutto: '29.00' });
    expect(stawki.every((s) => s.etykieta !== '')).toBe(true);
  });

  it('⚠️ brutto w rozbiciu na stawki jest WYLICZONE (FA(3) takiego pola nie ma) i tak oznaczone', () => {
    expect(dokumentZXml(XML_PELNY).stawki.every((s) => s.bruttoWyliczone === true)).toBe(true);
  });

  it('rozpisuje adnotacje na „Tak"/„Nie" — także te zapisane wariantem „N"', () => {
    const mapa = new Map(dokumentZXml(XML_PELNY).adnotacje.map((a) => [a.kod, a]));
    expect(mapa.get('P_16').wartosc).toBe('Nie');       // metoda kasowa
    expect(mapa.get('P_18A').wartosc).toBe('Tak');      // mechanizm podzielonej płatności
    expect(mapa.get('P_19').wartosc).toBe('Nie');       // P_19N = 1 znaczy „nie dotyczy"
    expect(mapa.get('P_22').wartosc).toBe('Nie');       // P_22N = 1
    expect(mapa.get('P_PMarzy').wartosc).toBe('Nie');   // P_PMarzyN = 1
    expect(mapa.get('P_16').etykieta).toContain('Metoda kasowa');
  });

  it('⚠️ podstawa zwolnienia jest OSOBNYM polem dokumentu, nie tylko tekstem w nazwie pozycji', () => {
    const { adnotacje } = dokumentZXml(XML_ZWOLNIONY);
    const zwolnienie = adnotacje.find((a) => a.kod === 'P_19');
    expect(zwolnienie.wartosc).toBe('Tak');
    expect(zwolnienie.podstawa).toBe('ZWOLNIENIE NA PODSTAWIE ART. 43, UST. 1, PKT 40 USTAWY O VAT');
  });

  it('czyta płatność: status, datę, termin, formę słownie i rachunek', () => {
    const { platnosc } = dokumentZXml(XML_PELNY);
    expect(platnosc).toMatchObject({
      zaplacono: true,
      dataZaplaty: '2026-08-06',
      termin: '2026-08-14',
      forma: 'przelew',
      rachunek: '77109010140000000000000002',
      opis: '',
    });
  });

  // ⚠️⚠️ TRZY STANY ZAPŁATY, NIE DWA (poprawka po recenzji 2026-09-03). `Zaplacono` = 2 to
  // ZDANIE WYSTAWCY „nie zapłacono"; brak węzła to BRAK ZDANIA. Do tej poprawki oba dawały
  // `false`, więc wizualizacja drukowała księgowej „Nie zapłacono" na dokumencie, który
  // o zapłacie nie mówi nic — czyli WSTAWIAŁA W CUDZY DOKUMENT fakt, którego tam nie ma.
  // Na fakturach OVH i Allegro blok `Platnosc` bywa bez `Zaplacono` w ogóle.
  it('⚠️ brak węzła `Zaplacono` daje null (brak informacji), a nie „nie zapłacono"', () => {
    const bezPlatnosci = dokumentZXml('<Faktura><Fa><P_2>X</P_2></Fa></Faktura>');
    expect(bezPlatnosci.platnosc.zaplacono).toBeNull();

    const samaForma = dokumentZXml(
      '<Faktura><Fa><Platnosc><FormaPlatnosci>6</FormaPlatnosci></Platnosc></Fa></Faktura>',
    );
    expect(samaForma.platnosc.zaplacono).toBeNull();
    expect(samaForma.platnosc.forma).toBe('przelew');
  });

  it('⚠️ `Zaplacono` = 2 daje false — to zdanie wystawcy, nie brak zdania', () => {
    const d = dokumentZXml(
      '<Faktura><Fa><Platnosc><Zaplacono>2</Zaplacono></Platnosc></Fa></Faktura>',
    );
    expect(d.platnosc.zaplacono).toBe(false);
  });

  it('`Zaplacono` = 1 daje true', () => {
    const d = dokumentZXml(
      '<Faktura><Fa><Platnosc><Zaplacono>1</Zaplacono></Platnosc></Fa></Faktura>',
    );
    expect(d.platnosc.zaplacono).toBe(true);
  });

  // FA(3) dopuszcza WIELE bloków `ZaplataCzesciowa` — faktura opłacana w ratach ma ich tyle,
  // ile wpłat. Odczyt pierwszego z brzegu gubiłby resztę, a księgowa dostawałaby kartkę
  // mówiącą o jednej racie z kilku.
  it('⚠️ czyta WSZYSTKIE zapłaty częściowe, nie pierwszą z brzegu', () => {
    const xml = '<Faktura><Fa><Platnosc>'
      + '<ZnacznikZaplatyCzesciowej>1</ZnacznikZaplatyCzesciowej>'
      + '<ZaplataCzesciowa><KwotaZaplatyCzesciowej>100.00</KwotaZaplatyCzesciowej>'
      + '<DataZaplatyCzesciowej>2026-08-01</DataZaplatyCzesciowej></ZaplataCzesciowa>'
      + '<ZaplataCzesciowa><KwotaZaplatyCzesciowej>250.50</KwotaZaplatyCzesciowej>'
      + '<DataZaplatyCzesciowej>2026-08-14</DataZaplatyCzesciowej></ZaplataCzesciowa>'
      + '</Platnosc></Fa></Faktura>';
    const { platnosc } = dokumentZXml(xml);
    expect(platnosc.czesciowa).toBe(true);
    expect(platnosc.zaplatyCzesciowe).toEqual([
      { kwota: '100.00', data: '2026-08-01' },
      { kwota: '250.50', data: '2026-08-14' },
    ]);
    // ⚠️ Zapłata częściowa jest NIEZALEŻNA od `Zaplacono` — tego węzła tu nie ma.
    expect(platnosc.zaplacono).toBeNull();
  });

  it('dokument bez zapłaty częściowej ma pustą listę, a nie brak pola', () => {
    expect(dokumentZXml(XML_PELNY).platnosc.zaplatyCzesciowe).toEqual([]);
    expect(dokumentZXml(XML_PELNY).platnosc.czesciowa).toBe(false);
  });

  it('⚠️ płatność opisowa (PlatnoscInna) niesie zdanie wystawcy, a nie formę z listy', () => {
    const { platnosc } = dokumentZXml(XML_ZWOLNIONY);
    expect(platnosc.forma).toBe('');
    expect(platnosc.opis).toBe('Pobrano z wpływów. Faktura nie wymaga zapłaty');
    expect(platnosc.zaplacono).toBe(true);
  });

  it('pozycje niosą brutto: z P_11A, a gdy go nie ma — z P_11 + P_11Vat', () => {
    const [p1, p2] = dokumentZXml(XML_PELNY).pozycje;
    expect(p1.wartoscBrutto).toBe('19.93');
    expect(p1.bruttoWyliczone).toBe(false);
    expect(p2.wartoscBrutto).toBe('307.50');
    expect(p2.bruttoWyliczone).toBe(false);
    expect(p2.rabat).toBe('5.00');
    expect(p2.dataDostawy).toBe('2026-07-15');
  });

  it('⚠️ brutto pozycji policzone ze stawki jest OZNACZONE — to wyświetlenie, nie księgowanie', () => {
    const p3 = dokumentZXml(XML_PELNY).pozycje[2];
    expect(p3.wartoscBrutto).toBe('123.00');
    expect(p3.bruttoWyliczone).toBe(true);
  });

  it('⚠️ pozycja ZWOLNIONA ma brutto równe netto — inaczej kolumna PayU jest co miesiąc pusta', () => {
    const [p] = dokumentZXml(XML_ZWOLNIONY).pozycje;
    expect(p.stawkaVat).toBe('zw');
    expect(p.wartoscBrutto).toBe('29.00');
    expect(p.bruttoWyliczone).toBe(true);
  });

  it('⚠️ pozycja BEZ netto (sam P_9B/P_11A) nie gubi kwoty — tak wystawia Comarch ERP Optima', () => {
    const xml = '<Faktura><Fa><FaWiersz><NrWierszaFa>1</NrWierszaFa>'
      + '<P_7>Piana niskoprężna</P_7><P_8A>szt</P_8A><P_8B>5.0000</P_8B>'
      + '<P_9B>19.99</P_9B><P_11A>99.95</P_11A><P_12>23</P_12></FaWiersz></Fa></Faktura>';
    const [p] = dokumentZXml(xml).pozycje;
    expect(p.wartoscNetto).toBe('');
    expect(p.cenaBrutto).toBe('19.99');
    expect(p.wartoscBrutto).toBe('99.95');
    expect(p.bruttoWyliczone).toBe(false);
    expect(p.ilosc).toBe('5');
  });

  it('data sprzedaży bierze się z okresu (OkresFa), gdy P_6 nie ma — tak wystawia OVH i P4', () => {
    const xml = '<Faktura><Fa><P_1>2026-08-01</P_1><P_2>PL7142428</P_2>'
      + '<OkresFa><P_6_Od>2026-08-01</P_6_Od><P_6_Do>2026-08-31</P_6_Do></OkresFa></Fa></Faktura>';
    const d = dokumentZXml(xml);
    expect(d.dataSprzedazy).toBe('');
    expect(d.okresOd).toBe('2026-08-01');
    expect(d.okresDo).toBe('2026-08-31');
  });

  it('czyta VAT przeliczony na złote (P_14_1W) z faktury w obcej walucie', () => {
    const xml = '<Faktura><Fa><KodWaluty>EUR</KodWaluty><P_13_1>2.24</P_13_1>'
      + '<P_14_1>0.51</P_14_1><P_14_1W>2.21</P_14_1W><P_15>2.75</P_15></Fa></Faktura>';
    const [s] = dokumentZXml(xml).stawki;
    expect(s.vatPln).toBe('2.21');
  });

  it('radzi sobie z przedrostkiem przestrzeni nazw (`tns:` w Subiekcie, `ns1:` w TERG-u)', () => {
    for (const przedrostek of ['tns', 'ns1']) {
      const zPrzedrostkiem = XML_PELNY
        .replace(/<(\/?)([A-Z][A-Za-z_0-9]*)([ >])/g, `<$1${przedrostek}:$2$3`);
      const d = dokumentZXml(zPrzedrostkiem);
      expect(d.numer).toBe('BC11206615');
      expect(d.nabywca.nazwa).toBe('Lumina Marek Zywiecki');
      expect(d.pozycje).toHaveLength(3);
      expect(d.stawki).toHaveLength(3);
      expect(d.platnosc.forma).toBe('przelew');
    }
  });

  it('faktura korygująca niesie dane dokumentu korygowanego i przyczynę', () => {
    const xml = '<Faktura><Fa><P_1>2026-08-20</P_1><P_2>KOR/1</P_2>'
      + '<RodzajFaktury>KOR</RodzajFaktury><PrzyczynaKorekty>Zwrot towaru</PrzyczynaKorekty>'
      + '<TypKorekty>2</TypKorekty><DaneFaKorygowanej>'
      + '<DataWystFaKorygowanej>2026-07-02</DataWystFaKorygowanej>'
      + '<NrFaKorygowanej>FS 1/2026</NrFaKorygowanej>'
      + '<NrKSeFFaKorygowanej>1111111111-20260702-AAAAAA-BB</NrKSeFFaKorygowanej>'
      + '</DaneFaKorygowanej></Fa></Faktura>';
    const d = dokumentZXml(xml);
    expect(d.rodzajFaktury).toBe('KOR');
    expect(d.korekta).toEqual({
      przyczyna: 'Zwrot towaru',
      typ: '2',
      typOpis: 'korekta skutkująca w dacie wystawienia faktury korygującej',
      numer: 'FS 1/2026',
      data: '2026-07-02',
      ksef: '1111111111-20260702-AAAAAA-BB',
    });
  });

  // ⚠️ `TypKorekty` ROZSTRZYGA MIESIĄC UJĘCIA korekty w księgach — to nie jest ozdobnik.
  // Sam kod („2") nic księgowej nie mówi, a wizualizacja go do 03.09.2026 w ogóle nie drukowała.
  it('⚠️ TypKorekty dostaje opis po ludzku — sam kod nie mówi, w jakiej dacie ująć korektę', () => {
    const zTypem = (typ) => dokumentZXml(
      `<Faktura><Fa><RodzajFaktury>KOR</RodzajFaktury><TypKorekty>${typ}</TypKorekty>`
      + '<PrzyczynaKorekty>X</PrzyczynaKorekty></Fa></Faktura>',
    ).korekta.typOpis;
    expect(zTypem('1')).toBe('korekta skutkująca w dacie ujęcia faktury pierwotnej');
    expect(zTypem('2')).toBe('korekta skutkująca w dacie wystawienia faktury korygującej');
    // ⚠️ BEZ DOPISKU „(np. uzgodnienia)". FA(3) nie mówi, JAKA to inna data ani skąd się
    // bierze — przykład podpowiadał księgowej powód, którego na dokumencie nie ma.
    expect(zTypem('3')).toBe('korekta skutkująca w innej dacie');
    // Kod spoza słownika idzie DOSŁOWNIE — zmyślony opis byłby zdaniem o cudzym dokumencie.
    expect(zTypem('9')).toBe('kod 9');
    expect(zTypem('')).toBe('');
  });

  // ⚠️ WARTOŚĆ Z CUDZEGO DOKUMENTU JEST KLUCZEM W NASZYM SŁOWNIKU — a zwykły odczyt
  // `slownik[klucz]` sięga po ŁAŃCUCH PROTOTYPÓW. Wystawca (albo pomyłka w generatorze
  // po jego stronie) wpisujący do `FormaPlatnosci` napis „constructor" dostawał na kartce
  // `function Object() { [native code] }` w miejscu formy zapłaty — bo `??` nie łapie
  // wartości odziedziczonej, tylko `undefined`.
  it('⚠️ wartość spoza słownika NIE bierze się z prototypu — „constructor" to nie forma płatności', () => {
    const d = dokumentZXml('<Faktura><Fa><RodzajFaktury>constructor</RodzajFaktury>'
      + '<TypKorekty>toString</TypKorekty><PrzyczynaKorekty>X</PrzyczynaKorekty>'
      + '<Platnosc><FormaPlatnosci>constructor</FormaPlatnosci></Platnosc></Fa></Faktura>');
    expect(d.platnosc.forma).toBe('kod constructor');
    expect(d.korekta.typOpis).toBe('kod toString');
    expect(d.rodzajOpis).toBe('Faktura (constructor)');
  });

  it('dokument bez korekty nie dostaje pustego pudełka „korekta"', () => {
    expect(dokumentZXml(XML_PELNY).korekta).toBeNull();
  });

  it('⚠️ brakujący węzeł daje PUSTY NAPIS, nigdy „undefined" na papierze', () => {
    const d = dokumentZXml('<Faktura><Fa><P_2>X</P_2></Fa></Faktura>');
    const napisy = [
      d.dataWytworzenia, d.dataWystawienia, d.miejsceWystawienia, d.dataSprzedazy,
      d.okresOd, d.okresDo, d.waluta, d.rodzajFaktury, d.naleznoscOgolem,
      d.sprzedawca.nazwa, d.sprzedawca.identyfikator, d.nabywca.nazwa, d.nabywca.identyfikator,
      d.platnosc.dataZaplaty, d.platnosc.termin, d.platnosc.forma, d.platnosc.opis,
      d.platnosc.rachunek,
    ];
    expect(napisy.every((s) => s === '')).toBe(true);
    expect(d.sprzedawca.adres).toEqual([]);
    expect(d.stawki).toEqual([]);
    expect(d.adnotacje).toEqual([]);
    expect(d.pozycje).toEqual([]);
    // ⚠️ NULL, nie `false` — dokument nie mówi o zapłacie NIC (patrz test trzech stanów wyżej).
    expect(d.platnosc.zaplacono).toBeNull();
  });

  it('⚠️ pusty i nieczytelny XML oddaje pusty dokument, a nie wyjątek — PDF ma i tak powstać', () => {
    for (const wejscie of ['', null, undefined, '<nie-faktura/>']) {
      const d = dokumentZXml(wejscie);
      expect(d.numer).toBe('');
      expect(d.pozycje).toEqual([]);
    }
  });

  it('podmiot bez NIP-u pokazuje identyfikator, który MA — albo mówi, że go nie ma', () => {
    const zIdWew = '<Faktura><Podmiot1><DaneIdentyfikacyjne><IDWew>ABC-1</IDWew>'
      + '<Nazwa>Firma bez NIP</Nazwa></DaneIdentyfikacyjne></Podmiot1></Faktura>';
    expect(dokumentZXml(zIdWew).sprzedawca.identyfikator).toBe('ID wewnętrzny: ABC-1');

    const zNrId = '<Faktura><Podmiot1><DaneIdentyfikacyjne><NrID>DE123456789</NrID>'
      + '<Nazwa>Auslandsfirma</Nazwa></DaneIdentyfikacyjne></Podmiot1></Faktura>';
    expect(dokumentZXml(zNrId).sprzedawca.identyfikator).toBe('Nr identyfikacyjny: DE123456789');

    const brak = '<Faktura><Podmiot1><DaneIdentyfikacyjne><BrakID>1</BrakID>'
      + '<Nazwa>Osoba prywatna</Nazwa></DaneIdentyfikacyjne></Podmiot1></Faktura>';
    expect(dokumentZXml(brak).sprzedawca.identyfikator).toBe('Brak identyfikatora podatkowego');
  });

  it('⚠️ kraj inny niż PL trafia na dokument — bez niego nie widać, że to zagranica', () => {
    const xml = '<Faktura><Podmiot1><DaneIdentyfikacyjne><NrID>DE123456789</NrID>'
      + '<Nazwa>Beispiel GmbH</Nazwa></DaneIdentyfikacyjne>'
      + '<Adres><KodKraju>DE</KodKraju><AdresL1>Hauptstr. 1</AdresL1>'
      + '<AdresL2>10115 Berlin</AdresL2></Adres></Podmiot1></Faktura>';
    expect(dokumentZXml(xml).sprzedawca.adres).toEqual(['Hauptstr. 1', '10115 Berlin', 'DE']);
  });
});
