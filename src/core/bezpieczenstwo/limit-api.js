// Liczniki są lokalne dla instancji, a czas przekazywany jawnie pozwala sprawdzać granice okna.
export function utworzLimitApi({ limit = 120, oknoMs = 60_000, zleNaIp = 20 } = {}) {
  const klucze = new Map();
  const adresy = new Map();

  function odnotuj(mapa, klucz, teraz) {
    let wpis = mapa.get(klucz);
    if (!wpis || wpis.koniec <= teraz) {
      mapa.delete(klucz);
      wpis = { liczba: 0, koniec: teraz + oknoMs };
      mapa.set(klucz, wpis);
    }
    wpis.liczba++;
    if (mapa.size > 10_000) {
      for (const [k, w] of mapa) if (w.koniec <= teraz) mapa.delete(k);
      while (mapa.size > 10_000) mapa.delete(mapa.keys().next().value);
    }
    return wpis;
  }

  return {
    sprawdz(kluczId, teraz = Date.now()) {
      const wpis = odnotuj(klucze, kluczId, teraz);
      return wpis.liczba > limit
        ? { wolno: false, zostaloMs: wpis.koniec - teraz }
        : { wolno: true, zostaloMs: 0 };
    },
    odnotujZly(ip, teraz = Date.now()) {
      odnotuj(adresy, ip, teraz);
    },
    zablokowanyIp(ip, teraz = Date.now()) {
      const wpis = adresy.get(ip);
      return wpis && wpis.koniec > teraz && wpis.liczba >= zleNaIp
        ? { wolno: false, zostaloMs: wpis.koniec - teraz }
        : { wolno: true, zostaloMs: 0 };
    },
    _rozmiar: () => ({ klucze: klucze.size, adresy: adresy.size }),
  };
}
