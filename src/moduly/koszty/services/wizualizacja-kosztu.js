import { bladOperatora } from '../../../domena/bledy.js';
import { kosztPoNumerze } from '../../../oms/db/koszty.js';
import { dokumentZXml } from '../../../domena/koszt-xml.js';
import { zbudujKosztPdf } from '../pdf/koszt-pdf.js';

// Wizualizacja faktury kosztowej NA ZADANIE — przycisk „PDF" na zakladce KOSZTY.
//
// ⚠️⚠️ XML POBIERA SIE Z KSeF TU I TERAZ, A NIE Z ARCHIWUM NA NAS-IE. Archiwum jest dzis
// na produkcji WYLACZONE (`KSEF_ARCHIWUM` nieustawione — patrz bootstrap.js), wiec droga
// „pobierz z zakladki" oparta o plik na dysku bylaby martwa dokladnie tam, gdzie ma dzialac.
// Ta sama zasada, co w calej zakladce: baza jest lustrem, plik na NAS-ie jest DODATKIEM.
//
// ⚠️ CENA JEST ZNANA I ZAAKCEPTOWANA: jedno zadanie do KSeF na jedno klikniecie (plus
// odswiezenie tokenu, gdy trzeba). To jest ruch na zadanie CZLOWIEKA, a nie w petli — inaczej
// niz przy nocnym przebiegu czuwacza, ktory ma wlasny budzet czasu i wlasna bramke.

/**
 * @param {object} deps
 * @param {object} deps.db      baza panelu (lustro kosztow)
 * @param {object} deps.klient  klient KSeF (`pobierzXml`)
 * @param {object} deps.sesja   sesja KSeF (`accessToken`) — TA SAMA, co u czuwacza kosztow:
 *                              druga instancja to druga para tokenow i drugie odswiezanie
 *                              jednorazowego refresh tokenu.
 */
export function createWizualizacjaKosztu({ db, klient, sesja }) {
  /**
   * Bajty PDF-a wizualizacji plus wiersz kosztu (trasa nazywa nim plik do pobrania).
   *
   * ⚠️ NIEZNANY NUMER KSeF ODMAWIA ZDANIEM, nie oddaje pustego dokumentu: PDF narysowany
   * z pustego wiersza wyglada jak dokument, ktory sie udal, i niesie same puste pola.
   */
  async function pdf(ksefNumber) {
    const wiersz = kosztPoNumerze(db, ksefNumber);
    if (!wiersz) {
      throw bladOperatora(
        `Panel nie zna faktury kosztowej o numerze KSeF „${ksefNumber ?? ''}" — `
        + 'nie ma z czego zrobić wizualizacji.',
      );
    }
    // ⚠️⚠️ DOKUMENT WPISANY RECZNIE NIE MA ORYGINALU W KSeF — i nie ma go czym zastapic.
    // Ekran nie pokazuje przy takim wierszu przycisku „PDF", ale adres da sie wpisac z reki,
    // a bez tej bramki poszloby stad zapytanie do KSeF o numer „RECZNY-…": jedna odmowa
    // z MF przetlumaczona operatorowi na „nie udalo sie przygotowac dokumentu", czyli zdanie
    // prawdziwe i mylace. Powod jest tutaj, a nie w tresci bledu KSeF-u.
    if (wiersz.zrodlo === 'reczne') {
      throw bladOperatora(
        `Koszt „${wiersz.numer_dokumentu}" został wpisany ręcznie — nie ma go w KSeF, `
        + 'więc nie ma z czego zrobić wizualizacji. Oryginałem jest dokument od sprzedawcy.',
      );
    }
    const accessToken = await sesja.accessToken();
    const xmlTresc = await klient.pobierzXml({ accessToken, ksefNumber: wiersz.ksef_number });
    return { wiersz, bajty: await zbudujKosztPdf({ wiersz, dokument: dokumentZXml(xmlTresc) }) };
  }

  return { pdf };
}
