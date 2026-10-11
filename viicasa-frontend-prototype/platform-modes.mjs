// Hosted customer flows must not silently redirect email to the old demo inbox.
// Local emulator previews remain isolated and explicitly opt in to demo mode.
export function platformModes(env = process.env) {
  const mode = env.PLATFORM_MODE || (env.NODE_ENV === 'production' ? 'live' : 'demo');
  if (!['live', 'demo'].includes(mode)) throw Error('Invalid PLATFORM_MODE');
  const demo = mode === 'demo';
  const viilifeMode = env.VIILIFE_MODE || (demo ? 'demo' : 'live');
  if (!['live', 'demo'].includes(viilifeMode)) throw Error('Invalid VIILIFE_MODE');
  if (!demo && viilifeMode !== 'live') throw Error('La plataforma publicada requiere VIILIFE_MODE=live. La demo de ViiLife solo está disponible localmente.');
  return { demo, viilifeMode };
}
