import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zapiszSciezki } from '../../../oms/db/koszty.js';
import { dokumentZXml } from '../../../domena/koszt-xml.js';
import { MIESIACE_KATALOGOW, doNazwyPliku, doDnia } from '../../../domena/nazwa-pliku-archiwum.js';
import { zbudujKosztPdf } from '../pdf/koszt-pdf.js';
import { zCzekaniemNa429 } from '../../../oms/ksef/limit.js';

// Archiwum ORYGINALNYCH dokumentow kosztowych na NAS-ie — XML z KSeF plus PDF wizualizacji
// rysowany przez nas (Zadanie 12), obok, pod ta sama nazwa i z innym rozszerzeniem.
//
// ⚠️⚠️ BAZA JEST LUSTREM, NIE PLIK NA DYSKU. Tabela `koszty` ma juz KOMPLET danych z KSeF
// (netto/vat/brutto/sprzedawca — zapisane przez czuwacz-kosztow.js, zanim ten modul w ogole
// wystartuje). Plik na NAS-ie jest DODATKIEM — oryginalem dokumentu do wgladu, nie zrodlem
// prawdy panelu. Dlatego awaria NAS-a nie ma prawa przerwac niczego wazniejszego: patrz
// `zarchiwizuj` nizej i uzasadnienie przy proba/catch.

export function sciezkaArchiwum({
  dataWystawienia, sprzedawcaNazwa, sprzedawcaNip, numerDokumentu, rozszerzenie,
}) {
  const dzien = doDnia(dataWystawienia);
  const [rok, miesiac] = dzien.split('-');
  const kto = doNazwyPliku(sprzedawcaNazwa || sprzedawcaNip || 'NIEZNANY').toUpperCase();
  const numer = doNazwyPliku(numerDokumentu);
  return `Kosztowe ${rok}/${MIESIACE_KATALOGOW[Number(miesiac) - 1]}/${dzien}_${kto}_${numer}.${rozszerzenie}`;
}

/**
 * Pobiera oryginalny XML z KSeF i archiwizuje go na NAS-ie w istniejacej konwencji katalogow.
 *
 * `wiersz` jest SUROWYM WIERSZEM z tabeli `koszty` (kolumny snake_case: `ksef_number`,
 * `sprzedawca_nazwa`, `sciezka_xml`, ...) — dokladnie takim, jaki oddaje `kosztyMiesiaca`
 * (db/koszty.js) i czyta `domain/lista-kosztow.js`. Drugiego mapowania na camelCase tutaj nie ma.
 *
 * ⚠️⚠️ POMIJAMY POBIERANIE, GDY `sciezka_xml` JUZ JEST ZAPISANA. XML raz pobrany z KSeF nie
 * zmienia sie nigdy (to trwaly, wystawiony dokument) — bez tej bramki KAZDY przebieg archiwizacji
 * sciagalby CALE archiwum od nowa, dokument po dokumencie, miesiac po miesiacu.
 *
 * ⚠️⚠️ AWARIA NAS-A NIE MOZE PRZERWAC NICZEGO. XML mamy juz w pamieci (pobrany z KSeF ponizej) —
 * plik na dysku jest DODATKIEM do lustra w bazie, ktora ma juz KOMPLET danych o tym koszcie,
 * a nie odwrotnie. Proba zapisu na dysk stoi wiec w OSOBNYM try/catch, ktory NIE RZUCA dalej —
 * ten sam wzorzec, co etykiety kuriera w services/nadanie.js (numer listu jest juz przydzielony,
 * plik PDF jest dodatkiem, ktory da sie odtworzyc). Sciezka NIE trafia do bazy, gdy zapis sie nie
 * udal: dzieki temu bramka wyzej sama, bez dodatkowej ksiegowosci stanu „do ponowienia", sprobuje
 * ten sam dokument ponownie przy kolejnym przebiegu — az NAS wroci.
 *
 * `log` jest wstrzykiwalny wylacznie po to, zeby dalo sie sprawdzic testem to, co inaczej ladowaloby
 * w `console.error` kontenera — ten sam wzorzec, co `log` w services/wysylka-ksef.js i bootstrap.js.
 *
 * ⚠️⚠️ PONOWIENIE PO 429 OBEJMUJE WYLACZNIE POBRANIE XML-a — NIE CALA TE FUNKCJE (recenzja
 * Task 16). `sesja.accessToken()` robi PELNE logowanie do KSeF najwyzej RAZ w zyciu sesji, bo
 * `/auth/token/redeem` jest JEDNORAZOWY: drugie podejscie z tym samym challenge odbija sie od MF.
 * A klient KSeF taguje `status: 429` KAZDA odmowe z limitu — takze ta z sekwencji uwierzytelniania.
 * Gdyby wiec `zCzekaniemNa429` owijalo cale `zarchiwizuj` (tak stalo w pierwszej wersji, po stronie
 * czuwacza), 429 z LOGOWANIA kazalby powtorzyc caly ciag logowania do czterech razy — za kazdym
 * razem odbijajac sie od zuzytego redeem, i za kazdym razem po dlugim czekaniu. Dlatego token
 * bierzemy RAZ, przed petla ponowien, a w srodku siedzi samo `klient.pobierzXml`.
 *
 * `limit` to opcje dla `zCzekaniemNa429` (ksef/limit.js): `{ spij, teraz, doKiedy, log }`. Puste
 * znaczy „ponawiaj na prawdziwym zegarze, bez sufitu czasu" — wolajacy z budzetem (czuwacz
 * kosztow) podaje `doKiedy`, a odmowa spoza budzetu wraca stad z `powod: 'limit'`.
 */
export async function zarchiwizuj({
  db, klient, sesja, wiersz, katalogBazowy, log = console.error, pdf = zbudujKosztPdf,
  limit = {},
}) {
  if (wiersz.sciezka_xml) return { pominiete: true, powod: 'XML już zarchiwizowany' };

  const accessToken = await sesja.accessToken();
  const xmlTresc = await zCzekaniemNa429(
    () => klient.pobierzXml({ accessToken, ksefNumber: wiersz.ksef_number }),
    limit,
  );

  const wzgledna = sciezkaArchiwum({
    dataWystawienia: wiersz.data_wystawienia,
    sprzedawcaNazwa: wiersz.sprzedawca_nazwa,
    sprzedawcaNip: wiersz.sprzedawca_nip,
    numerDokumentu: wiersz.numer_dokumentu,
    rozszerzenie: 'xml',
  });
  const pelna = join(katalogBazowy, wzgledna);

  try {
    mkdirSync(dirname(pelna), { recursive: true });
    writeFileSync(pelna, xmlTresc);
  } catch (e) {
    log(
      `Archiwum kosztow: zapis XML dokumentu ${wiersz.ksef_number} na NAS ("${wzgledna}") `
      + `sie nie udal (${e.message}) — dokument zostanie sprobowany ponownie przy kolejnym `
      + 'przebiegu. Dane w bazie sa kompletne niezaleznie od tego pliku.',
    );
    return { xml: null };
  }

  // ⚠️⚠️ PDF JEST DODATKIEM DO DODATKU — i dlatego stoi PO zapisie XML-a, w osobnym try/catch,
  // ktory nie rzuca dalej. XML to ORYGINAL dokumentu i pobiera sie go z KSeF RAZ (bramka po
  // `sciezka_xml` na gorze); gdyby wywrocone rysowanie przewracalo cala funkcje, sciezka XML-a
  // nie trafilaby do bazy i ten sam dokument sciagalby sie co noc od nowa — za kazdym razem
  // za cene zadania do KSeF, i za kazdym razem z tym samym skutkiem.
  //
  // ⚠️ NIEUDANY PDF NIE JEST PONAWIANY i to jest swiadome: bramka na gorze patrzy WYLACZNIE
  // na `sciezka_xml`, wiec przy nastepnym przebiegu dokument zostanie pominiety. Wizualizacja
  // jest odtwarzalna w kazdej chwili z zakladki KOSZTY (trasa GET /koszty/:ksefNumber/pdf
  // pobiera XML na zadanie), wiec brak pliku na NAS-ie niczego nie traci bezpowrotnie —
  // w przeciwienstwie do nieponowionego pobrania oryginalu.
  let wzglednaPdf = null;
  try {
    const sciezkaPdf = sciezkaArchiwum({
      dataWystawienia: wiersz.data_wystawienia,
      sprzedawcaNazwa: wiersz.sprzedawca_nazwa,
      sprzedawcaNip: wiersz.sprzedawca_nip,
      numerDokumentu: wiersz.numer_dokumentu,
      rozszerzenie: 'pdf',
    });
    writeFileSync(join(katalogBazowy, sciezkaPdf), await pdf({ wiersz, dokument: dokumentZXml(xmlTresc) }));
    wzglednaPdf = sciezkaPdf;
  } catch (e) {
    log(
      `Archiwum kosztow: wizualizacja PDF dokumentu ${wiersz.ksef_number} sie nie udala `
      + `(${e.message}) — oryginalny XML jest zarchiwizowany, a PDF da sie pobrac z zakladki `
      + 'KOSZTY na zadanie.',
    );
  }

  zapiszSciezki(db, wiersz.ksef_number, { xml: wzgledna, pdf: wzglednaPdf });
  return { xml: wzgledna, pdf: wzglednaPdf };
}
