// PRZECIĄGANIE PLIKU w sekcji „Logo” (Ustawienia → Firma, PRZ-108.03b).
//
// Strefa (`[data-logo-strefa]`) obejmuje zwykłe pole `<input type="file" name="logo">`. Upuszczony plik trafia do
// TEGO SAMEGO pola (przez DataTransfer), więc formularz wysyła go dokładnie tak jak plik wybrany z dysku — zapis
// logo na serwerze się nie zmienia. Bez tego skryptu formularz działa jak dotąd (pole pliku, klawiatura, Zapisz).
//
// Serwer i tak sprawdza typ (sygnatura PNG) i rozmiar (src/core/web/logo-instalacji.js: MAKS_LOGO). Przeglądarka
// tylko mówi o błędzie OD RAZU: wskazanie złego pliku nie wymaga wysyłki i powrotu na ekran z odmową.
// Przeglądarka widzi typ z nazwy pliku, nie z jego bajtów — to kontrola dla wygody, nie dla bezpieczeństwa.

export const MAKS_BAJTOW = 256 * 1024;

/** Komunikat po polsku albo `null`, gdy plik wygląda na dobry. */
export function sprawdzPlik(plik) {
  if (!plik) return 'Wybierz plik PNG.';
  const png = plik.type === 'image/png' || (plik.type === '' && /\.png$/i.test(plik.name ?? ''));
  if (!png) return 'Plik musi być obrazem PNG. SVG i inne formaty nie są obsługiwane.';
  if (plik.size > MAKS_BAJTOW) return `Plik jest większy niż 256 KB (${Math.ceil(plik.size / 1024)} KB).`;
  return null;
}

const rozmiarTekstem = (bajty) => (bajty < 1024 ? `${bajty} B` : `${Math.round(bajty / 1024)} KB`);
const zPlikami = (zdarzenie) => [...(zdarzenie.dataTransfer?.types ?? [])].includes('Files');

export function podlaczStrefe(strefa, srodowisko = { DataTransfer: globalThis.DataTransfer, URL: globalThis.URL }) {
  const pole = strefa.querySelector('input[type="file"]');
  const stan = strefa.querySelector('[data-logo-stan]');
  const podglad = strefa.querySelector('[data-logo-podglad]');
  if (!pole || !stan || !podglad) return;
  let adresPodgladu = null;

  const zwolnijPodglad = () => {
    if (adresPodgladu) srodowisko.URL.revokeObjectURL(adresPodgladu);
    adresPodgladu = null;
    podglad.hidden = true;
  };
  const blad = (tresc) => {
    zwolnijPodglad();
    pole.value = '';
    stan.textContent = tresc;
    strefa.dataset.stan = 'blad';
  };
  const wybrano = (plik) => {
    const problem = sprawdzPlik(plik);
    if (problem) return blad(problem);
    zwolnijPodglad();
    adresPodgladu = srodowisko.URL.createObjectURL(plik);
    podglad.src = adresPodgladu;
    podglad.hidden = false;
    stan.textContent = `Wybrany plik: ${plik.name} (${rozmiarTekstem(plik.size)})`;
    strefa.dataset.stan = 'wybrany';
  };

  const podswietl = (zdarzenie) => {
    if (!zPlikami(zdarzenie)) return;
    zdarzenie.preventDefault();
    if (zdarzenie.dataTransfer) zdarzenie.dataTransfer.dropEffect = 'copy';
    strefa.classList.add('logo-strefa--nad');
  };
  strefa.addEventListener('dragenter', podswietl);
  strefa.addEventListener('dragover', podswietl);
  strefa.addEventListener('dragleave', (zdarzenie) => {
    // Przejście nad element wewnątrz strefy (pole, napis) też wysyła `dragleave` — wtedy nie gasimy.
    if (zdarzenie.relatedTarget && strefa.contains(zdarzenie.relatedTarget)) return;
    strefa.classList.remove('logo-strefa--nad');
  });
  strefa.addEventListener('drop', (zdarzenie) => {
    // Bez tego przeglądarka otworzyłaby upuszczony plik w karcie zamiast go wybrać.
    zdarzenie.preventDefault();
    strefa.classList.remove('logo-strefa--nad');
    const pliki = [...(zdarzenie.dataTransfer?.files ?? [])];
    if (pliki.length === 0) return;
    if (pliki.length > 1) return blad('Upuszczono kilka plików. Wybierz jeden plik PNG.');
    const problem = sprawdzPlik(pliki[0]);
    if (problem) return blad(problem);
    const przeniesienie = new srodowisko.DataTransfer();
    przeniesienie.items.add(pliki[0]);
    pole.files = przeniesienie.files;
    wybrano(pliki[0]);
  });
  pole.addEventListener('change', () => {
    if (!pole.files || pole.files.length === 0) { zwolnijPodglad(); stan.textContent = ''; strefa.dataset.stan = ''; return; }
    wybrano(pole.files[0]);
  });
  podglad.addEventListener('error', () => blad('Ten plik nie wygląda na obraz PNG, którego przeglądarka może użyć. Wybierz inny.'));
}

if (typeof document !== 'undefined') {
  for (const strefa of document.querySelectorAll('[data-logo-strefa]')) podlaczStrefe(strefa);
}
