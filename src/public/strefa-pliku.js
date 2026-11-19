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

// Kosz z ikoną zamiast napisu „Usuń z wyboru” przy każdym pliku: przy kilkunastu plikach napis zajmował pół
// wiersza. Nazwę niesie aria-label, podpowiedź po najechaniu — title.
const IKONA_KOSZA =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="none" ' +
  'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ' +
  'd="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

const ROZSZERZENIA = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
};

export function rozmiarTekstem(bajty) {
  if (bajty < 1024) return `${bajty} B`;
  if (bajty < 1024 * 1024) return `${Math.round(bajty / 1024)} KB`;
  const mb = bajty / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1).replace('.', ',')} MB`;
}
const odmiana = (n, jeden, kilka, wiele) => {
  if (n === 1) return jeden;
  const j = n % 10;
  const d = n % 100;
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? kilka : wiele;
};
const zPlikami = (zdarzenie) => [...(zdarzenie.dataTransfer?.types ?? [])].includes('Files');

/** Opcje strefy z atrybutów HTML (pole pliku i `data-*` strefy). */
export function opcjeZAtrybutow(strefa) {
  const pole = strefa.querySelector('input[type="file"]');
  const typy = String(pole?.getAttribute('accept') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
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
    aiNaPlik: strefa.dataset.aiNaPlik !== undefined,
    komunikaty: {
      brak: 'Wybierz plik.',
      zlyTyp: (p) => `Plik „${p.name}” nie jest w formacie ${opisTypow}. Nic nie zostało dodane.`,
      zaDuzy: (p) =>
        `Plik „${p.name}” ma ${rozmiarTekstem(p.size)} — limit to ${rozmiarTekstem(maksBajtow)} na plik. Nic nie zostało dodane.`,
      zaDuzo: (n, maks) =>
        `Wybrano ${n} ${odmiana(n, 'plik', 'pliki', 'plików')}, a zostało miejsca na ${maks}. Nic nie zostało dodane.`,
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
  const typ =
    opcje.typy.includes(plik.type) || (plik.type === '' && Boolean(opcje.rozszerzenia?.test(plik.name ?? '')));
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
export function podlaczStrefePliku(
  strefa,
  opcje,
  srodowisko = { DataTransfer: globalThis.DataTransfer, URL: globalThis.URL },
) {
  const pole = strefa.querySelector('input[type="file"]');
  const stan = strefa.querySelector(opcje.selStan ?? '[data-strefa-stan]');
  const podglad = opcje.selPodglad ? strefa.querySelector(opcje.selPodglad) : null;
  const lista = opcje.wiele ? strefa.querySelector('[data-strefa-lista]') : null;
  const przycisk = strefa.closest?.('form')?.querySelector('[data-strefa-przycisk]') ?? null;
  if (!pole || !stan || (opcje.selPodglad && !podglad)) return;
  const klasaNad = opcje.klasaNad ?? 'strefa-pliku--nad';
  const napisPrzycisku = przycisk?.textContent ?? '';
  let adresy = [];
  let wybor = [];
  let znacznikiAi = [];
  const aiNaPlik = opcje.aiNaPlik && lista;
  const moznaPrzeniesc = typeof srodowisko.DataTransfer === 'function';
  const adresyWyboru = new Map();

  const wpiszPliki = (pliki) => {
    const przeniesienie = new srodowisko.DataTransfer();
    for (const plik of pliki) przeniesienie.items.add(plik);
    pole.files = przeniesienie.files;
  };

  const ustawPrzycisk = (liczba) => {
    if (przycisk) przycisk.textContent = liczba > 0 ? `${napisPrzycisku} (${liczba})` : napisPrzycisku;
  };
  const zwolnij = (zachowane = []) => {
    if (podglad) podglad.hidden = true;
    if (lista) {
      lista.replaceChildren();
      lista.hidden = true;
    }
    for (const adres of adresy) srodowisko.URL.revokeObjectURL(adres);
    adresy = [];
    for (const [plik, adres] of adresyWyboru) {
      if (zachowane.includes(plik)) continue;
      srodowisko.URL.revokeObjectURL(adres);
      adresyWyboru.delete(plik);
    }
    ustawPrzycisk(0);
  };
  // `wyczysc` = pole trzyma złe pliki (wybór z dysku) albo tryb jednego pliku: czyścimy, żeby nie poszły formularzem.
  // Złe upuszczenie przy wielu plikach nie rusza pola: wcześniejszy dobry wybór zostaje.
  const blad = (tresc, wyczysc = true) => {
    if (wyczysc) {
      zwolnij();
      pole.value = '';
    }
    stan.textContent = tresc;
    strefa.dataset.stan = 'blad';
  };
  const pozycja = (plik, i) => {
    const dokument = strefa.ownerDocument;
    const li = dokument.createElement('li');
    const miniatura = dokument.createElement('img');
    const adres = adresyWyboru.get(plik) ?? srodowisko.URL.createObjectURL(plik);
    if (aiNaPlik) adresyWyboru.set(plik, adres);
    else adresy.push(adres);
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
    if (aiNaPlik) {
      const etykieta = dokument.createElement('label');
      etykieta.className = 'strefa-pliku-wybor-ai';
      const ai = dokument.createElement('input');
      ai.type = 'checkbox';
      ai.name = `zdjecie_ai_${i}`;
      ai.value = '1';
      ai.checked = znacznikiAi[i] === true;
      ai.setAttribute('aria-label', `AI — ${plik.name}`);
      ai.addEventListener('change', () => {
        znacznikiAi[i] = ai.checked;
      });
      etykieta.append(ai, 'AI');
      li.append(etykieta);
      if (moznaPrzeniesc) {
        const usun = dokument.createElement('button');
        usun.type = 'button';
        usun.className = 'btn btn--maly strefa-pliku-usun';
        usun.innerHTML = IKONA_KOSZA;
        usun.setAttribute('aria-label', `Usuń z wyboru: ${plik.name}`);
        usun.setAttribute('title', 'Usuń z wyboru');
        usun.addEventListener('click', () => {
          wybor.splice(i, 1);
          znacznikiAi.splice(i, 1);
          wpiszPliki(wybor);
          wybrano(wybor);
          const nastepny = lista.children[Math.min(i, wybor.length - 1)]?.querySelector('button') ?? pole;
          nastepny.focus();
        });
        li.append(usun);
      }
    }
    return li;
  };
  const wybrano = (pliki) => {
    const problem = sprawdzPliki(pliki, opcje);
    if (problem) return blad(problem);
    zwolnij(pliki);
    if (lista) {
      lista.replaceChildren(...pliki.map(pozycja));
      lista.hidden = pliki.length === 0;
      stan.textContent = pliki.length ? opcje.komunikaty.wybrane(pliki) : 'Nie wybrano zdjęć.';
    } else {
      const [plik] = pliki;
      if (podglad) {
        const adres = srodowisko.URL.createObjectURL(plik);
        adresy.push(adres);
        podglad.src = adres;
        podglad.hidden = false;
      }
      stan.textContent =
        opcje.komunikaty.wybrany?.(plik) ?? `Wybrany plik: ${plik.name} (${rozmiarTekstem(plik.size)})`;
    }
    ustawPrzycisk(pliki.length);
    strefa.dataset.stan = pliki.length ? 'wybrany' : '';
  };

  const dodajDoWyboru = (pliki) => {
    const nastepne = [...wybor, ...pliki];
    const problem = sprawdzPliki(nastepne, opcje);
    if (problem) {
      wpiszPliki(wybor);
      return blad(problem, false);
    }
    // Tablica musi mieć wpis dla każdego pliku, również przy usuwaniu plików bez znacznika.
    znacznikiAi.push(...pliki.map(() => false));
    wybor = nastepne;
    wpiszPliki(wybor);
    wybrano(wybor);
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
    if (!moznaPrzeniesc) return;
    if (aiNaPlik) return dodajDoWyboru(pliki);
    const problem = sprawdzPliki(pliki, opcje);
    if (problem) return blad(problem, !opcje.wiele);
    wpiszPliki(pliki);
    wybrano(pliki);
  });
  pole.addEventListener('change', () => {
    if (!pole.files || pole.files.length === 0) {
      wybor = [];
      znacznikiAi = [];
      zwolnij();
      stan.textContent = '';
      strefa.dataset.stan = '';
      return;
    }
    const pliki = [...pole.files];
    if (aiNaPlik && moznaPrzeniesc) return dodajDoWyboru(pliki);
    znacznikiAi = [];
    wybrano(pliki);
  });
  if (podglad)
    podglad.addEventListener('error', () =>
      blad(opcje.komunikaty.nieObraz ?? 'Tego pliku nie da się wyświetlić. Wybierz inny.'),
    );
}

if (typeof document !== 'undefined') {
  for (const strefa of document.querySelectorAll('[data-strefa-pliku]'))
    podlaczStrefePliku(strefa, opcjeZAtrybutow(strefa));
}
