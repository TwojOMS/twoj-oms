// PRZ-160.P3b.01 — słowniki kart (kategorie, marki): czyste funkcje bez bazy.

const NAZWANE = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const ENCJA = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi;

function jednaRunda(napis) {
  return napis.replace(ENCJA, (cala, kod) => {
    if (kod[0] === '#') {
      const liczba = kod[1] === 'x' || kod[1] === 'X' ? parseInt(kod.slice(2), 16) : parseInt(kod.slice(1), 10);
      return Number.isFinite(liczba) && liczba > 0 && liczba <= 0x10ffff ? String.fromCodePoint(liczba) : cala;
    }
    return NAZWANE[kod.toLowerCase()] ?? cala;
  });
}

// Zdejmuje encje HTML aż do stałej wartości (sklep potrafi zakodować `&` kilka razy: `&amp;amp;`).
// Nieznane encje zostają bez zmian; nie-napis wraca bez zmian.
export function dekodujEncje(napis) {
  if (typeof napis !== 'string') return napis;
  let biezacy = napis;
  for (let i = 0; i < 10; i++) {
    const nastepny = jednaRunda(biezacy);
    if (nastepny === biezacy) break;
    biezacy = nastepny;
  }
  return biezacy;
}

// Marka z parametrów oferty Allegro (`daneKanalu.parametry` = {produkt:[…], oferta:[…]}):
// pierwsza niepusta wartość parametru o nazwie „Marka” (bez względu na wielkość liter i spacje).
export function markaZParametrow(parametry) {
  if (!parametry || typeof parametry !== 'object') return null;
  for (const grupa of [parametry.produkt, parametry.oferta]) {
    for (const p of Array.isArray(grupa) ? grupa : []) {
      if (String(p?.nazwa ?? '').trim().toLowerCase() !== 'marka') continue;
      const wartosc = (Array.isArray(p.wartosci) ? p.wartosci : [])
        .map(w => (typeof w === 'string' ? w.trim() : '')).find(Boolean);
      if (wartosc) return wartosc;
    }
  }
  return null;
}
