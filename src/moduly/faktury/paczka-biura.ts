type PaczkaBiura = {
  zbuduj: (...args: any[]) => Promise<any>;
  zbudujZestawieniePrzychodow: (...args: any[]) => Promise<any>;
  /** PRZ-122.B13d1: zestawienie zaznaczonych faktur z listy FAKTURY. */
  zbudujZaznaczone: (...args: any[]) => Promise<any>;
};

/** Usługa PRZ-025 korzysta z faktury.infakt; lookup po budowie wszystkich modułów unika cyklu. */
export function paczkaBiuraDlaTras(uslugaKosztow: () => PaczkaBiura): PaczkaBiura {
  return {
    zbuduj: (...args) => uslugaKosztow().zbuduj(...args),
    zbudujZestawieniePrzychodow: (...args) => uslugaKosztow().zbudujZestawieniePrzychodow(...args),
    zbudujZaznaczone: (...args) => uslugaKosztow().zbudujZaznaczone(...args),
  };
}
