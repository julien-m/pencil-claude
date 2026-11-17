// Localized messages for explicit lifecycle controls; existing prototype copy is unchanged.
const catalogs = {
  en: { sessionClosed: 'Session closed' },
  fr: { sessionClosed: 'Session fermée' },
};
/** Resolve the configured document language with an English fallback. */
export function viewMessage(key, language = 'en') {
  const locale = language.split('-')[0];
  return (Object.hasOwn(catalogs, locale) ? catalogs[locale] : catalogs.en)[key];
}
