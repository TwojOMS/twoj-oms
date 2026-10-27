import { celeLacznosci, ADRES_DIAGNOSTYKI_INFAKTU } from '../../domena/lacznosc.js';
import { zProgramu } from '../../integracje/program-fakturowy.ts';
import { BAZA_DOMYSLNA } from '../../oms/ksef/client.js';

/** Odczyt po zbudowaniu modułów; diagnostyka otrzymuje wyłącznie adresy i nazwy. */
export function celeDiagnostyki(usluga: <T>(modul: string, nazwa: string) => T) {
  const opcjonalna = (modul: string): any => {
    try { return usluga(modul, 'config'); }
    catch (e) {
      if (e instanceof Error && e.message === `Usługa „${modul}.config" nie istnieje albo moduł „${modul}" nie jest zbudowany przed wołającym`) return null;
      throw e;
    }
  };
  const kanaly = usluga<any>('kanaly', 'config');
  const faktury = opcjonalna('faktury');
  const koszty = opcjonalna('koszty');
  const wysylka = opcjonalna('wysylka');
  const zamowienia = opcjonalna('zamowienia');
  const dokumenty = faktury ? usluga<() => any>('faktury', 'celeLacznosci')() : {};
  const kurierzy = wysylka ? usluga<() => any>('wysylka', 'celeLacznosci')() : {};
  // PRZ-118.08: cel programu fakturowego z jego opisu (klucz = opis.id, nazwa = opis.nazwa.mianownik). Program czytamy
  // kluczem `infakt` modułu faktur (alias zostaje; szew próby podaje tam sam program) i owijamy `zProgramu`.
  // Obecność i adres: moduł faktur podaje je w `celeLacznosci()` pod id programu (dziś `infakt`: plik albo zapis
  // z Ustawień, czytany przy każdym wejściu — klucz zapisany albo odłączony bez restartu zmienia listę jak przed
  // PRZ-118). Program, o którym moduł nic nie mówi, sprawdzamy pod `opis.adres`. Bez programu przy starcie (klucz
  // zapisany w Ustawieniach po starcie) zostaje stary kształt `infakt`.
  const program = faktury ? zProgramu({ infakt: usluga<unknown>('faktury', 'infakt') }) : null;
  const zModulu = program && Object.hasOwn(dokumenty, program.opis.id) ? dokumenty[program.opis.id] : undefined;
  const celProgramu = !program ? null
    : zModulu === undefined ? { opis: program.opis, url: program.opis.adres }
    : zModulu ? { opis: program.opis, url: zModulu.baseUrl ?? ADRES_DIAGNOSTYKI_INFAKTU }
    : null;
  return celeLacznosci({ ...kanaly,
    program: celProgramu,
    infakt: program ? null : dokumenty.infakt,
    // PRZ-102.22: token KSeF z pliku albo z Ustawień → Integracje → KSeF (pytane przy każdym wejściu); adres tylko z pliku.
    ksef: koszty && usluga<{ dostepny: () => boolean }>('koszty', 'zrodloKsef').dostepny() ? { api: koszty.adresKsef ?? BAZA_DOMYSLNA } : null,
    dpd: kurierzy.dpd,
    inpost: kurierzy.inpost,
    // PRZ-102.13: ta sama reguła co przycisk „Pobierz z GUS” (plik → atrapa → klucz z Ustawień), pytana przy każdym wejściu
    // na ekran — klucz zapisany w panelu działa bez restartu. Adres: GUS_URL albo domyślny; klucza tu nie ma.
    gus: zamowienia && usluga<{ dostepny: () => boolean }>('zamowienia', 'gus').dostepny() ? { url: zamowienia.gusAdres } : null,
  } as any);
}
