const zakresy = [...document.querySelectorAll('.klucze-api-zakresy input[name="zakresy"]')];
const wszystkie = document.querySelector('[data-zaznacz-wszystko]');
if (wszystkie) {
  const odswiez = () => {
    const ile = zakresy.filter(pole => pole.checked).length;
    wszystkie.checked = ile === zakresy.length;
    wszystkie.indeterminate = ile > 0 && ile < zakresy.length;
  };
  document.querySelector('[data-wszystkie-zakresy]').hidden = false;
  wszystkie.addEventListener('change', () => {
    zakresy.forEach(pole => { pole.checked = wszystkie.checked; });
    odswiez();
  });
  zakresy.forEach(pole => pole.addEventListener('change', odswiez));
  wszystkie.form.addEventListener('reset', () => setTimeout(odswiez, 0));
  odswiez();
}

const kopiuj = document.querySelector('[data-kopiuj-klucz]');
if (kopiuj) {
  kopiuj.hidden = false;
  kopiuj.addEventListener('click', async () => {
    const pole = document.querySelector('#klucz-api-wartosc');
    const wynik = document.querySelector('[data-kopiowanie-wynik]');
    let skopiowano = false;
    try {
      await navigator.clipboard.writeText(pole.value);
      skopiowano = true;
    } catch {
      pole.focus();
      pole.select();
      try { skopiowano = document.execCommand('copy'); } catch { /* Pole pozostaje zaznaczone. */ }
    }
    wynik.textContent = skopiowano ? 'Skopiowano' : 'Zaznaczono klucz — skopiuj go ręcznie.';
  });
}

document.querySelectorAll('[data-usun-klucz], [data-odwolaj-klucz]').forEach(formularz => {
  formularz.addEventListener('submit', zdarzenie => {
    const pytanie = formularz.hasAttribute('data-usun-klucz')
      ? 'Usunąć ten klucz API? Integracja utraci dostęp. Historia użycia pozostanie.'
      : 'Odwołać ten klucz API? Integracja utraci dostęp.';
    if (!window.confirm(pytanie)) {
      zdarzenie.preventDefault();
      return;
    }
    const potwierdzenie = document.createElement('input');
    potwierdzenie.type = 'hidden';
    potwierdzenie.name = 'potwierdzam';
    potwierdzenie.value = 'tak';
    formularz.append(potwierdzenie);
  });
});
