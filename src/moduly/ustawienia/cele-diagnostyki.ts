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
  return celeLacznosci({ ...kanaly,
    infakt: faktury?.infakt ? { baseUrl: faktury.infakt.baseUrl } : null,
    ksef: koszty?.ksef ? { api: koszty.ksef.baseUrl ?? BAZA_DOMYSLNA } : null,
    dpd: wysylka?.dpd ? { url: wysylka.dpd.url } : null,
    inpost: wysylka?.inpost ? { url: wysylka.inpost.url } : null,
    gus: zamowienia?.gus ? { url: zamowienia.gus.url } : null,
  } as any);
}
