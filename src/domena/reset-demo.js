export const KLUCZ_ZLECENIA_RESETU = 'reset_demo_zlecony';
export const ZACHOWANE_PRZY_RESECIE = ['program_fakturowy', 'nip_firmy'];

export function resetDemoDostepny({ proba, restart }) {
  return proba === true && restart === 'tak';
}
// PRZ-149.01: tylko piaskownica (deploy/proba/start.mjs). Ręcznie założona aplikacja rzeczywistego Allegro Sandbox
// — z poświadczeniami, bo bez nich kreator wraca do kroku 0. Konta: kanaly_sprzedazy z panelu w środowisku sandbox.
export const ZACHOWANE_SANDBOX_ALLEGRO = ['allegro_aplikacja:sandbox', 'allegro_aplikacja_device:sandbox', 'allegro_instalacja'];
// PRZ-119.11a: tylko piaskownica z plikiem profilu próby Fakturowni (deploy/proba/atrapy/fakturownia-proba.ts). Domena
// konta próbnego i token z ekranu przechodzą przez reset W CAŁOŚCI (drogą Allegro Sandbox, z sekretami) — zwykła
// lista ZACHOWANE_PRZY_RESECIE kasuje sekrety, więc Fakturownii tam nie ma. W logu tylko nazwa wiersza.
export const ZACHOWANE_PROBA_FAKTUROWNIA = ['fakturownia'];
