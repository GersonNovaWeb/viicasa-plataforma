import {id} from './lib.js';
import {key,now,searchTerms,auditDoc} from './firestore-store.js';

// Versioned fictional catalog. Never seeded automatically on a live server.
export const demoCatalogId='demo-properties-v1';
export function demoProperties(){
  const rows=[
    ['casa-brisa','Casa Brisa','Costa / Coastal',8,4,4,39000,54000,
      ['Terraza / Terrace','Vista al mar / Sea view','Wi-Fi','Cocina / Kitchen'],
      'Espacios abiertos hacia el paisaje, materiales naturales y una terraza para compartir.',
      'Open spaces facing the landscape, natural materials and a terrace for gathering.',
      ['interior.png','bedroom.png','exterior.png']],
    ['villa-oliva','Villa Oliva','Bosque / Forest',6,3,3,28000,38000,
      ['Jardín / Garden','Chimenea / Fireplace','Wi-Fi','Cocina / Kitchen'],
      'Un refugio entre naturaleza y arquitectura, con espacios para descansar sin prisa.',
      'A retreat between nature and architecture, with space to slow down.',
      ['exterior.png','life.png','bedroom.png']],
    ['casa-lumbre','Casa Lumbre','Ciudad / City',4,2,2,21000,29000,
      ['Terraza / Terrace','Área de trabajo / Workspace','Wi-Fi','Cocina / Kitchen'],
      'Luz, líneas limpias y una selección de texturas para una estancia serena.',
      'Light, clean lines and selected textures for a serene stay.',
      ['life.png','interior.png','bedroom.png']],
    ['residencia-arena','Residencia Arena','Costa / Coastal',10,5,4,53000,73000,
      ['Alberca / Pool','Jardín / Garden','Wi-Fi','Estacionamiento / Parking'],
      'Una residencia para reunirse, con interiores amplios y vida al aire libre.',
      'A residence for coming together, with generous interiors and outdoor living.',
      ['interior.png','exterior.png','bedroom.png']],
  ];
  return rows.map(([slug,name,location,capacity,bedrooms,bathrooms,usd,cad,amenities,es,en,images])=>({
    slug,name:`${name} · Demo`,location,capacity,bedrooms,bathrooms,amenities,
    description:`PROPIEDAD DE DEMOSTRACIÓN. Fotografías y tarifas ficticias; no constituye una oferta real. ${es}\n[EN]\nDEMONSTRATION PROPERTY. Fictional images and prices; not a real offer. ${en}`,
    timezone:'America/Mexico_City',currency:'USD',nightly_minor:usd,cleaning_minor:5000,
    rates:{USD:{nightly_minor:usd,cleaning_minor:5000},CAD:{nightly_minor:cad,cleaning_minor:7000}},
    min_nights:2,deposit_percent:30,published:true,is_demo:true,
    policies:'Demostración: no constituye una oferta real. No se permiten eventos. No realizar reservas ni pagos reales.\n[EN]\nDemo: not a real offer. Events are not allowed. Do not make real reservations or payments.',
    images:images.map(image=>`/assets/${image}`),
  }));
}

export async function installDemoProperties(store,actor){
  // One transaction prevents duplicates from concurrent clicks or retries.
  // The ledger also prevents re-creating properties renamed/archived by an admin.
  return store.transaction(async tx=>{
    const previous=await tx.get('system',demoCatalogId);
    const installed={...previous?.installed},created=[],skipped=[];
    for(const template of demoProperties()){
      const uniqueId=key('properties-slug',template.slug);
      const existing=await tx.get('unique_keys',uniqueId);
      if(installed[template.slug]||existing){
        installed[template.slug]??=existing.owner;
        skipped.push(template.slug);continue;
      }
      const record={...template,id:id(),archived:false,created_at:now(),updated_at:now(),
        search_terms:searchTerms(`${template.name} ${template.location}`)};
      tx.create('unique_keys',uniqueId,{owner:record.id});
      tx.create('properties',record.id,record);
      auditDoc(tx,actor,'properties.demo.create',record.id,{catalog:demoCatalogId});
      installed[template.slug]=record.id;created.push(template.slug);
    }
    if(!previous||created.length)tx.put('system',demoCatalogId,{installed,updated_at:now()});
    return{created,skipped};
  });
}
