// LiteSpeed loads this entry with require(); keep top-level await out of this file.
// Dynamic import lets the ESM application and its dependencies initialize asynchronously.
import('./viicasa-frontend-prototype/server.mjs').catch((error) => {
  console.error('No se pudo iniciar VIICASA:', error);
  process.exit(1);
});
