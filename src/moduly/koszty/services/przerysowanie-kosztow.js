import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { zapiszSciezki } from '../../../oms/db/koszty.js';
import { dokumentZXml } from '../../../domena/koszt-xml.js';
import { zbudujKosztPdf } from '../pdf/koszt-pdf.js';
import { sciezkaArchiwum } from './archiwum-kosztow.js';

// PRZERYSOWANIE wizualizacji PDF dla dokumentow, ktore JUZ SA w archiwum na NAS-ie.
//
// Powstalo 2026-09-03 razem z przebudowa wizualizacji (komplet elementow art. 106e). Archiwum
// mialo wtedy ponad sto PDF-ow wyrysowanych STARYM ukladem — bez nabywcy, bez adresow, bez
// rozbicia VAT i bez adnotacji. Kartki, ktore wlasnie przestaly sie do czegokolwiek nadawac.
//
// ⚠️⚠️ ZERO WYWOLAN DO KSeF. XML-e sa juz na dysku (kolumna `sciezka_xml`) i to one sa
// zrodlem. To nie jest oszczednosc — to warunek, zeby te operacje dalo sie w ogole puscic na
// produkcji: KSeF ma limit 64 pobran na godzine (zmierzony 02.09.2026), wiec przerysowanie
// stu dokumentow „przy okazji pobierajac oryginaly" trwaloby dwie godziny i spalilo limit,
// z ktorego korzysta nocny czuwacz.
//
// ⚠️ ZAPIS JEST ATOMOWY (`.tmp` → `rename`) i to nie jest ostroznosc na wyrost. Przerysowanie
// NADPISUJE plik, ktory juz stoi w archiwum ksiegowym; przerwane w polowie (padniety NAS,
// ubity kontener) zostawiloby na dysku PDF UCIETY W POLOWIE — plik, ktory otwiera sie, wyglada
// jak dokument i nie ma na sobie ani jednego sladu awarii. `rename` w obrebie jednego wolumenu
// jest niepodzielny, wiec w kazdej chwili na dysku stoi albo stara kartka, albo nowa.
//
// ⚠️ BLAD JEDNEGO DOKUMENTU NIE PRZERYWA PRZEBIEGU. Kolejka jest liczona ze stanu tabeli,
// dokument bez pliku XML na dysku (archiwum niekompletne albo NAS niezamontowany) jest
// LICZONY i RAPORTOWANY, a nie przemilczany — inaczej „przerysowano 3 z 120" wygladaloby
// z zewnatrz jak sukces.

/**
 * Przerysowuje PDF-y wizualizacji dla wszystkich kosztow z zapisanym `sciezka_xml`.
 *
 * @param {object}   deps
 * @param {object}   deps.db      baza panelu
 * @param {string}   deps.katalog katalog bazowy archiwum (ten sam, co `KSEF_ARCHIWUM`)
 * @param {Function} [deps.log]   wstrzykiwalny wylacznie po to, zeby dalo sie sprawdzic testem
 *                                to, co inaczej ladowaloby w `console.log` kontenera
 * @param {Function} [deps.pdf]   generator PDF-a (podmieniany w testach)
 * @returns {Promise<{wszystkie:number, przerysowane:number, brakXml:number, bledy:number}>}
 */
export async function przerysujKoszty({
  db, katalog, log = console.log, pdf = zbudujKosztPdf,
}) {
  if (!katalog) throw new Error('Przerysowanie kosztow: nie podano katalogu archiwum.');

  const wiersze = db.prepare(
    "SELECT * FROM koszty WHERE sciezka_xml IS NOT NULL AND sciezka_xml <> ''"
    + ' ORDER BY data_wystawienia',
  ).all();

  let przerysowane = 0;
  let brakXml = 0;
  let bledy = 0;

  for (const wiersz of wiersze) {
    const pelnaXml = join(katalog, wiersz.sciezka_xml);
    if (!existsSync(pelnaXml)) {
      brakXml += 1;
      log(`POMINIETY ${wiersz.ksef_number}: brak pliku XML "${wiersz.sciezka_xml}" na dysku.`);
      continue;
    }
    // ⚠️ NAZWA PLIKU TYMCZASOWEGO ZYJE PONAD `try`, i to nie jest porzadkowanie kodu. Sciezka
    // `.tmp` powstaje ze sciezki DOCELOWEJ, a ta bywa WYLICZONA (`sciezkaArchiwum`), gdy w bazie
    // jeszcze jej nie ma. Sprzatanie sklejalo ja z `wiersz.sciezka_pdf`, wiec przy pustej
    // kolumnie celowalo w „<katalog>/.tmp" — a prawdziwy plik tymczasowy zostawal w archiwum
    // ksiegowym, obok dokumentow, ktore ktos potem pakuje dla biura.
    let tymczasowa = null;
    try {
      const xml = readFileSync(pelnaXml, 'utf8');
      // Sciezka PDF-a z bazy, a gdy jej nie ma (stary dokument albo nieudane rysowanie przy
      // archiwizacji) — wyliczona z tej samej funkcji, co przy archiwizacji. Dwie konwencje
      // nazw w jednym katalogu znaczylyby dwa pliki na jeden dokument.
      const wzgledna = wiersz.sciezka_pdf || sciezkaArchiwum({
        dataWystawienia: wiersz.data_wystawienia,
        sprzedawcaNazwa: wiersz.sprzedawca_nazwa,
        sprzedawcaNip: wiersz.sprzedawca_nip,
        numerDokumentu: wiersz.numer_dokumentu,
        rozszerzenie: 'pdf',
      });
      const pelna = join(katalog, wzgledna);
      tymczasowa = `${pelna}.tmp`;

      const bajty = await pdf({ wiersz, dokument: dokumentZXml(xml) });
      mkdirSync(dirname(pelna), { recursive: true });
      writeFileSync(tymczasowa, bajty);
      renameSync(tymczasowa, pelna);

      // Sciezke dopisujemy do bazy TYLKO wtedy, gdy jej tam nie bylo — `zapiszSciezki` robi
      // `COALESCE`, wiec przepisanie tej samej wartosci jest niegroznym zapisem bez zmiany,
      // ale i tak nie ma powodu ruszac wiersza, ktory jest juz kompletny.
      if (!wiersz.sciezka_pdf) zapiszSciezki(db, wiersz.ksef_number, { pdf: wzgledna });
      przerysowane += 1;
    } catch (e) {
      bledy += 1;
      // ⚠️ Plik tymczasowy sprzatamy PO bledzie, ale jego brak nie jest bledem samym w sobie
      // (wywrocic sie moglo jeszcze przed jego powstaniem — i wtedy `tymczasowa` jest `null`).
      if (tymczasowa) {
        try { rmSync(tymczasowa, { force: true }); } catch { /* nic */ }
      }
      log(`BLAD ${wiersz.ksef_number} (${wiersz.numer_dokumentu}): ${e.message}`);
    }
  }

  log(
    `Przerysowanie wizualizacji: dokumentow ${wiersze.length}, przerysowanych ${przerysowane}, `
    + `bez pliku XML ${brakXml}, bledow ${bledy}.`,
  );
  return {
    wszystkie: wiersze.length, przerysowane, brakXml, bledy,
  };
}
