export const KLUCZ_ZLECENIA_RESETU = 'reset_demo_zlecony';
export const ZACHOWANE_PRZY_RESECIE = ['program_fakturowy', 'nip_firmy'];

export function resetDemoDostepny({ proba, restart }) {
  return proba === true && restart === 'tak';
}
