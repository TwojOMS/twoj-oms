const WZOR_KLUCZA = /^oms:pozycja-listy:v1:[a-f0-9]{64}$/;

function bezpiecznyKlucz(klucz) {
  return typeof klucz === 'string' && WZOR_KLUCZA.test(klucz) ? klucz : null;
}

export function zapiszPozycjePodKluczem({ storage, klucz, y }) {
  const cel = bezpiecznyKlucz(klucz);
  if (!cel || !Number.isFinite(y) || y < 0) return false;
  try {
    storage.setItem(cel, String(y));
    return true;
  } catch {
    return false;
  }
}

export function zapiszPozycje({ storage, klucz, y }) {
  return zapiszPozycjePodKluczem({ storage, klucz, y });
}

export function odczytajPozycje({ storage, klucz }) {
  const cel = bezpiecznyKlucz(klucz);
  if (!cel) return null;
  try {
    const wartosc = storage.getItem(cel);
    if (wartosc === null || wartosc.trim() === '') return null;
    const y = Number(wartosc);
    return Number.isFinite(y) && y >= 0 ? y : null;
  } catch {
    return null;
  }
}

function usunPozycje(storage, klucz) {
  const cel = bezpiecznyKlucz(klucz);
  if (!cel) return;
  try {
    storage.removeItem(cel);
  } catch {
    // Kotwica jest pełnym mechanizmem awaryjnym, więc błąd storage pozostaje cichy.
  }
}

export function odtworzPozycje({ storage, klucz, hash, znajdzCel, przewin }) {
  if (typeof hash !== 'string' || !/^#zamowienie-[A-Za-z0-9_%.-]+$/.test(hash)) return false;
  const cel = znajdzCel(hash.slice(1));
  if (!cel) {
    usunPozycje(storage, klucz);
    return false;
  }
  const y = odczytajPozycje({ storage, klucz });
  if (y === null) return false;
  przewin(0, y);
  return true;
}

export async function uruchomPozycjeListy({ okno = window, dokument = document } = {}) {
  // PRZ-100: adres ma wersję (`?v=…`), więc dopasowanie po początku, nie po całości.
  const znacznik = dokument.querySelector('script[data-klucz-listy][src^="/public/pozycja-listy.js"]');
  const klucz = bezpiecznyKlucz(znacznik?.dataset?.kluczListy);
  if (!klucz) return;

  let storage;
  try {
    storage = okno.sessionStorage;
  } catch {
    return;
  }
  let zaplanowany = false;
  const zapisz = () => {
    zaplanowany = false;
    zapiszPozycjePodKluczem({ storage, klucz, y: okno.scrollY });
  };
  okno.addEventListener('scroll', () => {
    if (zaplanowany) return;
    zaplanowany = true;
    okno.requestAnimationFrame(zapisz);
  }, { passive: true });
  okno.addEventListener('pagehide', zapisz);

  odtworzPozycje({
    storage,
    klucz,
    hash: okno.location.hash,
    znajdzCel: (id) => dokument.getElementById(id),
    przewin: (x, y) => okno.scrollTo(x, y),
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') uruchomPozycjeListy();
