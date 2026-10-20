import { celeLacznosci } from '../../domena/lacznosc.js';
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
  return celeLacznosci({ ...kanaly,
    infakt: dokumenty.infakt,
    // PRZ-102.22: token KSeF z pliku albo z Ustawień → Integracje → KSeF (pytane przy każdym wejściu); adres tylko z pliku.
    ksef: koszty && usluga<{ dostepny: () => boolean }>('koszty', 'zrodloKsef').dostepny() ? { api: koszty.adresKsef ?? BAZA_DOMYSLNA } : null,
    dpd: kurierzy.dpd,
    inpost: kurierzy.inpost,
    // PRZ-102.13: ta sama reguła co przycisk „Pobierz z GUS” (plik → atrapa → klucz z Ustawień), pytana przy każdym wejściu
    // na ekran — klucz zapisany w panelu działa bez restartu. Adres: GUS_URL albo domyślny; klucza tu nie ma.
    gus: zamowienia && usluga<{ dostepny: () => boolean }>('zamowienia', 'gus').dostepny() ? { url: zamowienia.gusAdres } : null,
  } as any);
}
