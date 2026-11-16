// STREFA PRZECIĄGANIA PLIKÓW — wspólna dla logo (Ustawienia → Firma) i zdjęć karty produktu
// (Magazyn → karta → Zdjęcia).
//
// Strefa obejmuje zwykłe pole `<input type="file">`. Upuszczone pliki trafiają do TEGO SAMEGO pola (przez
// DataTransfer), więc formularz wysyła je dokładnie tak jak pliki wybrane z dysku. Bez skryptu formularz działa jak
// zwykły formularz z polem pliku. Serwer i tak sprawdza typ, rozmiar i liczbę — przeglądarka tylko mówi o błędzie
// OD RAZU, bez wysyłki i powrotu na ekran z odmową. Typ widzi z nazwy pliku, nie z bajtów: wygoda, nie bezpieczeństwo.
//
// Strefy z atrybutem `data-strefa-pliku` podłączają się same; parametry biorą z HTML:
//   accept pola → dozwolone typy, `multiple` pola → wiele plików, data-maks-bajtow, data-maks-plikow (wolne miejsce),
//   data-opis-typow (np. „JPEG, PNG lub WebP”). Przycisk wysyłki w tym samym formularzu: `data-strefa-przycisk`.

const ROZSZERZENIA = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'] };

export function rozmiarTekstem(bajty) {
  if (bajty < 1024) return `${bajty} B`;
  if (bajty < 1024 * 1024) return `${Math.round(bajty / 1024)} KB`;
  const mb = bajty / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace('.', ',')} MB`;
}
const odmiana = (n, jeden, kilka, wiele) => {
  if (n === 1) return jeden;
  const j = n % 10; const d = n % 100;
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? kilka : wiele;
};
const zPlikami = (zdarzenie) => [...(zdarzenie.dataTransfer?.types ?? [])].includes('Files');

/** Opcje strefy z atrybutów HTML (pole pliku i `data-*` strefy). */
export function opcjeZAtrybutow(strefa) {
  const pole = strefa.querySelector('input[type="file"]');
  const typy = String(pole?.getAttribute('accept') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const maksBajtow = Number(strefa.dataset.maksBajtow) || Infinity;
  const maksPlikow = strefa.dataset.maksPlikow === undefined ? Infinity : Number(strefa.dataset.maksPlikow);
  const opisTypow = strefa.dataset.opisTypow || typy.join(', ');
  const rozszerzenia = typy.flatMap((t) => ROZSZERZENIA[t] ?? []);
  return {
    typy,
    rozszerzenia: rozszerzenia.length ? new RegExp(`\\.(${rozszerzenia.join('|')})$`, 'i') : null,
    maksBajtow,
    maksPlikow,
    wiele: Boolean(pole?.multiple),
    komunikaty: {
      brak: 'Wybierz plik.',
      zlyTyp: (p) => `Plik „${p.name}” nie jest w formacie ${opisTypow}. Nic nie zostało dodane.`,
      zaDuzy: (p) => `Plik „${p.name}” ma ${rozmiarTekstem(p.size)} — limit to ${rozmiarTekstem(maksBajtow)} na plik. Nic nie zostało dodane.`,
      zaDuzo: (n, maks) => `Wybrano ${n} ${odmiana(n, 'plik', 'pliki', 'plików')}, a zostało miejsca na ${maks}. Nic nie zostało dodane.`,
      kilka: 'Upuszczono kilka plików. Wybierz jeden plik.',
      pelna: 'Nie ma już miejsca na kolejne pliki. Usuń któryś z zapisanych, żeby dodać nowy.',
      wybrane: (pliki) => {
        const suma = pliki.reduce((s, p) => s + p.size, 0);
        return `Wybrano ${pliki.length} ${odmiana(pliki.length, 'plik', 'pliki', 'plików')} (razem ${rozmiarTekstem(suma)}).`;
      },
    },
  };
}

/** Komunikat po polsku albo `null`, gdy plik wygląda na dobry. */
export function sprawdzPlik(plik, opcje) {
  if (!plik) return opcje.komunikaty.brak;
  const typ = opcje.typy.includes(plik.type) || (plik.type === '' && Boolean(opcje.rozszerzenia?.test(plik.name ?? '')));
  if (!typ) return opcje.komunikaty.zlyTyp(plik);
  if (plik.size > opcje.maksBajtow) return opcje.komunikaty.zaDuzy(plik);
  return null;
}

/** Cała paczka albo nic: najpierw liczba, potem każdy plik. */
export function sprawdzPliki(pliki, opcje) {
  if (!opcje.wiele && pliki.length > 1) return opcje.komunikaty.kilka;
  if (opcje.wiele && pliki.length > opcje.maksPlikow) return opcje.komunikaty.zaDuzo(pliki.length, opcje.maksPlikow);
  for (const plik of pliki) {
    const problem = sprawdzPlik(plik, opcje);
    if (problem) return problem;
  }
  return null;
}

/**
 * Podłącza strefę. Opcje (poza tymi z `sprawdzPlik`): `selStan` (domyślnie `[data-strefa-stan]`), `selPodglad`
 * (jeden obraz podglądu — tryb jednego pliku), `klasaNad` (podświetlenie), `komunikaty.nieObraz`, `komunikaty.wybrany`.
 * W trybie wielu plików: lista `[data-strefa-lista]` z miniaturami i przycisk `[data-strefa-przycisk]` z liczbą.
 */
export function podlaczStrefePliku(strefa, opcje, srodowisko = { DataTransfer: globalThis.DataTransfer, URL: globalThis.URL }) {
  const pole = strefa.querySelector('input[type="file"]');
  const stan = strefa.querySelector(opcje.selStan ?? '[data-strefa-stan]');
  const podglad = opcje.selPodglad ? strefa.querySelector(opcje.selPodglad) : null;
  const lista = opcje.wiele ? strefa.querySelector('[data-strefa-lista]') : null;
  const przycisk = strefa.closest?.('form')?.querySelector('[data-strefa-przycisk]') ?? null;
  if (!pole || !stan || (opcje.selPodglad && !podglad)) return;
  const klasaNad = opcje.klasaNad ?? 'strefa-pliku--nad';
  const napisPrzycisku = przycisk?.textContent ?? '';
  let adresy = [];

  const ustawPrzycisk = (liczba) => {
    if (przycisk) przycisk.textContent = liczba > 0 ? `${napisPrzycisku} (${liczba})` : napisPrzycisku;
  };
  const zwolnij = () => {
    for (const adres of adresy) srodowisko.URL.revokeObjectURL(adres);
    adresy = [];
    if (podglad) podglad.hidden = true;
    if (lista) { lista.replaceChildren(); lista.hidden = true; }
    ustawPrzycisk(0);
  };
  // `wyczysc` = pole trzyma złe pliki (wybór z dysku) albo tryb jednego pliku: czyścimy, żeby nie poszły formularzem.
  // Złe upuszczenie przy wielu plikach nie rusza pola: wcześniejszy dobry wybór zostaje.
  const blad = (tresc, wyczysc = true) => {
    if (wyczysc) { zwolnij(); pole.value = ''; }
    stan.textContent = tresc;
    strefa.dataset.stan = 'blad';
  };
  const pozycja = (plik) => {
    const dokument = strefa.ownerDocument;
    const li = dokument.createElement('li');
    const miniatura = dokument.createElement('img');
    const adres = srodowisko.URL.createObjectURL(plik);
    adresy.push(adres);
    miniatura.className = 'strefa-pliku-miniatura';
    miniatura.src = adres;
    miniatura.alt = '';
    miniatura.setAttribute('width', 48);
    miniatura.setAttribute('height', 48);
    const nazwa = dokument.createElement('span');
    nazwa.className = 'strefa-pliku-nazwa';
    nazwa.textContent = plik.name;
    const rozmiar = dokument.createElement('span');
    rozmiar.className = 'strefa-pliku-rozmiar';
    rozmiar.textContent = rozmiarTekstem(plik.size);
    li.append(miniatura, nazwa, rozmiar);
    return li;
  };
  const wybrano = (pliki) => {
    const problem = sprawdzPliki(pliki, opcje);
    if (problem) return blad(problem);
    zwolnij();
    if (lista) {
      lista.replaceChildren(...pliki.map(pozycja));
      lista.hidden = false;
      stan.textContent = opcje.komunikaty.wybrane(pliki);
    } else {
      const [plik] = pliki;
      if (podglad) {
        const adres = srodowisko.URL.createObjectURL(plik);
        adresy.push(adres);
        podglad.src = adres;
        podglad.hidden = false;
      }
      stan.textContent = opcje.komunikaty.wybrany?.(plik) ?? `Wybrany plik: ${plik.name} (${rozmiarTekstem(plik.size)})`;
    }
    ustawPrzycisk(pliki.length);
    strefa.dataset.stan = 'wybrany';
  };

  const podswietl = (zdarzenie) => {
    if (!zPlikami(zdarzenie)) return;
    zdarzenie.preventDefault();
    if (zdarzenie.dataTransfer) zdarzenie.dataTransfer.dropEffect = 'copy';
    strefa.classList.add(klasaNad);
  };
  strefa.addEventListener('dragenter', podswietl);
  strefa.addEventListener('dragover', podswietl);
  strefa.addEventListener('dragleave', (zdarzenie) => {
    // Przejście nad element wewnątrz strefy (pole, napis) też wysyła `dragleave` — wtedy nie gasimy.
    if (zdarzenie.relatedTarget && strefa.contains(zdarzenie.relatedTarget)) return;
    strefa.classList.remove(klasaNad);
  });
  strefa.addEventListener('drop', (zdarzenie) => {
    // Bez tego przeglądarka otworzyłaby upuszczony plik w karcie zamiast go wybrać.
    zdarzenie.preventDefault();
    strefa.classList.remove(klasaNad);
    const pliki = [...(zdarzenie.dataTransfer?.files ?? [])];
    if (pliki.length === 0) return;
    if (opcje.wiele && (opcje.maksPlikow <= 0 || pole.disabled)) return blad(opcje.komunikaty.pelna, false);
    const problem = sprawdzPliki(pliki, opcje);
    if (problem) return blad(problem, !opcje.wiele);
    const przeniesienie = new srodowisko.DataTransfer();
    for (const plik of pliki) przeniesienie.items.add(plik);
    pole.files = przeniesienie.files;
    wybrano(pliki);
  });
  pole.addEventListener('change', () => {
    if (!pole.files || pole.files.length === 0) { zwolnij(); stan.textContent = ''; strefa.dataset.stan = ''; return; }
    wybrano([...pole.files]);
  });
  if (podglad) podglad.addEventListener('error', () => blad(opcje.komunikaty.nieObraz ?? 'Tego pliku nie da się wyświetlić. Wybierz inny.'));
}

if (typeof document !== 'undefined') {
  for (const strefa of document.querySelectorAll('[data-strefa-pliku]')) podlaczStrefePliku(strefa, opcjeZAtrybutow(strefa));
}
