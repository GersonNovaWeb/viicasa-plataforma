export function preferredLanguage(storage=globalThis.localStorage,languages=globalThis.navigator?.languages||['en']){
  try{for(const key of ['vii-language','viicasa-prototype-language','viicasa-phase2-language']){const value=storage.getItem(key);if(['en','es'].includes(value))return value;}}catch{}
  return String(languages[0]||'en').toLowerCase().startsWith('es')?'es':'en';
}
export function saveLanguage(value,storage=globalThis.localStorage){if(!['en','es'].includes(value))return;try{for(const key of ['vii-language','viicasa-prototype-language','viicasa-phase2-language'])storage.setItem(key,value);}catch{}}
