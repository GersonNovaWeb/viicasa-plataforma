// Retail catalogue from Vii_Lista_de_Servicios_v2_ES. This is not the older
// internal estimating menu: existing quote IDs and accepted agreements stay intact.
const pair=(es,en)=>({es,en});
export const catalogueFamilies=[
  ['stock','Stock del Hogar','Home Stock'],['cleaning','Limpieza y Lavandería','Cleaning & Laundry'],
  ['organisation','Organización','Organisation'],['styling','Ambientación y Estilo','Styling'],
  ['harmony','Armonía del Hogar','Home Harmony'],['special','Cuidados Especiales','Special Care'],
  ['arrival','Propiedad y Llegada','Property & Arrival']
].map(([id,es,en])=>({id,name:pair(es,en)}));
const R=['once','recurring'],Q=['once','quote'],RQ=['once','recurring','quote'];
const definitions=[
  ['cleaning-stock','stock','Stock de Productos de Limpieza','Cleaning Product Stock',RQ,'Productos de limpieza organizados y repuestos para que tu hogar siempre esté listo.','An organised cleaning supply kit, checked and replenished to keep your home ready.',['Selección del kit / Kit selection','Organización y etiquetas / Organisation & labels','Revisión y reposición / Stock checks & replenishment']],
  ['groceries','stock','Stock de Víveres','Grocery Stock',R,'Tu despensa y refrigerador abastecidos según tus preferencias.','Your pantry and refrigerator stocked to suit your preferences.',['Lista personalizada / Personalised list','Compras programadas o a solicitud / Scheduled or on-demand shopping','Almacenamiento y rotación / Storage & rotation']],
  ['home-basics','stock','Stock de Básicos del Hogar','Home Essentials Stock',R,'Los pequeños básicos, resueltos antes de que los necesites.','Everyday essentials taken care of before you need them.',['Papel, jabón y artículos básicos / Paper, soap & essentials','Focos y baterías / Bulbs & batteries','Revisión y reposición / Checks & replenishment']],
  ['home-cleaning','cleaning','Limpieza del Hogar','Home Cleaning',RQ,'Un hogar cuidado en cada visita, con atención a cocinas, baños y los detalles.','A cared-for home on every visit, with attention to kitchens, bathrooms and finishing details.',['Limpieza detallada / Detailed cleaning','Cocina y baños / Kitchen & bathrooms','Lista de revisión / Service checklist']],
  ['wash-fold','cleaning','Lavado y Doblado','Wash & Fold',R,'Ropa limpia y doblada para recuperar tu tiempo.','Freshly cleaned and folded laundry, giving you your time back.',['Recolección y entrega / Collection & delivery','Preferencias de lavado / Laundry preferences','Doblado cuidadoso / Careful folding']],
  ['linen-service','cleaning','Servicio de Blancos','Linen Service',R,'Blancos frescos y de calidad, listos para cada cama y cada estancia.','Fresh, quality linens, ready for every bed and every stay.',['Blancos y toallas / Bed linen & towels','Cambios programados / Scheduled changes','Lavado y entrega / Washing & delivery']],
  ['pantry-organisation','organisation','Organización de Despensa','Pantry Organisation',RQ,'Una despensa que entiendes de un vistazo.','A pantry you can understand at a glance.',['Agrupar por tipo / Group by type','Retirar caducados / Remove expired items','Zonas y etiquetas / Zones & labels']],
  ['kitchen-drawers','organisation','Organización de Cajones de Cocina','Kitchen Drawer Organisation',Q,'Una cocina más fácil de usar, con cada herramienta en su lugar.','An easier kitchen, with every tool in its place.',['Depuración / Decluttering','Agrupación por uso / Grouping by use','Distribución y separadores / Layout & dividers']],
  ['closet-organisation','organisation','Organización de Clóset','Closet Organisation',RQ,'Mañanas tranquilas y decisiones claras.','Calmer mornings and clearer choices.',['Clasificación de ropa / Clothing sorting','Zonas y ganchos / Zones & hangers','Preparación de donaciones / Donation preparation']],
  ['linen-closet','organisation','Organización del Clóset de Blancos','Linen Closet Organisation',Q,'Blancos ordenados y fáciles de encontrar, siempre listos para recibir.','Easy-to-find linens, neatly arranged and ready for guests.',['Clasificación por tamaño y habitación / Sort by size & room','Etiquetas / Labels','Inventario / Inventory']],
  ['fridge-freezer','organisation','Organización de Refrigerador y Congelador','Fridge & Freezer Organisation',RQ,'Comida fresca, nada olvidado.','Fresh food, nothing forgotten.',['Vaciar y limpiar / Empty & clean','Retirar caducados / Remove expired items','Zonas y recipientes / Zones & containers']],
  ['welcome-styling','styling','Ambientación de Bienvenida','Welcome Styling',RQ,'Los pequeños detalles que hacen una gran diferencia al llegar.','Small details that make a big difference on arrival.',['Entrada y superficies / Entry & surfaces','Textiles frescos / Fresh textiles','Detalles finales / Finishing touches']],
  ['room-styling','styling','Ambientación por Habitación','Room Styling',Q,'Completa tu espacio con distribución, textiles y detalles pensados para ti.','Complete your space with thoughtful layouts, textiles and details.',['Distribución / Layout','Decoración y textiles / Decor & textiles','Iluminación y acabados / Lighting & finishing']],
  ['whole-home-styling','styling','Ambientación Integral','Whole-home Styling',['quote'],'Cada espacio diseñado y terminado, con un plan a la medida.','Every space designed and finished with a tailored plan.',['Plan integral / Whole-home plan','Selección de muebles y decoración / Furniture & decor selection','Ambientación final / Final styling']],
  ['pre-listing-styling','styling','Ambientación Previa a la Publicación','Pre-listing Styling',Q,'Muestra tu casa en su mejor versión para fotografías y visitas.','Present your home at its best for photography and viewings.',['Guía de depuración / Decluttering guidance','Distribución de muebles / Furniture arrangement','Espacios clave listos / Key spaces prepared']],
  ['home-alignment','harmony','Alineación del Hogar','Home Alignment',R,'Mantenimiento del orden para que cada cosa siga en su lugar.','Regular attention to keep everything in its place.',['Orden de superficies / Surface organisation','Revisión de zonas clave / Key-area checks','Reporte de pequeños problemas / Minor issue reporting']],
  ['seasonal-refresh','harmony','Renovación Estacional','Seasonal Refresh',RQ,'Una renovación para los espacios que necesitan un nuevo comienzo.','A seasonal refresh for spaces ready for a new beginning.',['Reorganización / Reorganisation','Rotación de ropa y decoración / Clothing & decor rotation','Actualización de estilo / Styling updates']],
  ['room-transformation','harmony','Transformación de Habitación','Room Transformation',['quote'],'El espacio que has querido transformar, con una propuesta personalizada.','The space you have wanted to transform, with a personalised proposal.',['Plan de distribución / Layout plan','Selección de piezas / Piece selection','Instalación y ambientación / Installation & styling']],
  ['knife-sharpening','special','Afilado de Cuchillos','Knife Sharpening',R,'Cuchillos afilados para cocinar con mayor facilidad.','Sharper knives for easier cooking.',['Afilado profesional / Professional sharpening','Revisión de filo / Edge check','Limpieza y consejos / Cleaning & care tips']],
  ['season-change','special','Cambio de Temporada','Season Change',R,'Guarda una temporada y da la bienvenida a la siguiente.','Put one season away and welcome the next.',['Rotación de ropa / Clothing rotation','Decoración de temporada / Seasonal decor','Empaque e inventario / Packing & inventory']],
  ['moving-preparation','special','Preparación de Mudanza','Moving Preparation',Q,'Un nuevo comienzo al entrar o al salir.','A fresh start, moving in or moving out.',['Limpieza completa / Full cleaning','Organización de zonas clave / Key-area organisation','Básicos del primer día / First-day essentials']],
  ['check-in-support','arrival','Apoyo en el Check-in','Check-in Support',R,'Un comienzo tranquilo para cada huésped.','A calm beginning for every guest.',['Coordinación de llegada y llaves / Arrival & key coordination','Orientación de bienvenida / Welcome orientation','Preguntas e incidencias / Questions & issue reporting']],
  ['welcome-gifts','arrival','Regalos de Bienvenida y Detalles de Llegada','Welcome Gifts & Arrival Touches',R,'Un detalle que se recuerda.','A thoughtful touch to remember.',['Selección de regalo / Gift selection','Presentación y colocación / Presentation & placement','Nota personalizada / Personalised note']],
  ['vacant-home-checks','arrival','Revisiones de Casa Desocupada','Vacant Home Checks',R,'Tranquilidad mientras no estás, con una revisión y reporte de tu hogar.','Peace of mind while you are away, with home checks and reports.',['Recorrido de revisión / Property walkthrough','Fugas, daños y seguridad / Leaks, damage & security','Reporte con fotografías / Photo report']],
  ['season-opening-closing','arrival','Apertura y Cierre de Temporada','Seasonal Opening & Closing',Q,'Tu propiedad lista para abrir y cuidada al cerrar la temporada.','Your property ready to open and cared for when the season closes.',['Lista de apertura / Opening checklist','Revisión de sistemas y agua / Systems & water checks','Coordinación del cierre / Closing coordination']],
  ['maintenance-coordination','arrival','Coordinación de Mantenimiento','Maintenance Coordination',['quote'],'Un solo punto de contacto para coordinar lo que hay que reparar.','One point of contact to coordinate what needs fixing.',['Coordinación de técnicos / Technician coordination','Seguimiento hasta terminar / Follow-through','Fotografías y notas / Photos & notes']],
  ['listing-photo-preparation','arrival','Preparación para Fotografía del Anuncio','Listing Photography Preparation',Q,'Lista para la foto, de principio a fin.','Photo-ready, from start to finish.',['Orden y ambientación / Organisation & styling','Lista de tomas / Shot list','Coordinación del fotógrafo / Photographer coordination']]
];
const conciergeNames={
  'home-cleaning':pair('Limpieza entre Estancias','Turnover Cleaning'),
  'home-alignment':pair('Alineación de Propiedad','Property Alignment'),
  'room-transformation':pair('Transformación de Propiedad en Renta','Rental Property Transformation'),
  'moving-preparation':pair('Preparación para Estancia del Propietario','Owner-stay Preparation')
};
export const catalogueServices=definitions.map(([id,family,es,en,modes,descriptionEs,descriptionEn,includes],index)=>({
  id,family,name:pair(es,en),concierge_name:conciergeNames[id]||pair(es,en),description:pair(descriptionEs,descriptionEn),
  includes:{es:includes.map(x=>x.split(' / ')[0]),en:includes.map(x=>x.split(' / ')[1])},
  channels:id==='check-in-support'?['viiconcierge']:['viilife','viiconcierge'],modes,
  pricing:{kind:'quote',amount_minor:null,basis:'service',currency:'CAD'},images:[],published:false,archived:false,sort_order:index+1
}));
export const cataloguePackages=[
  ['guest-ready','Listo para Huéspedes','Guest Ready',['viiconcierge'],['home-cleaning','welcome-gifts','linen-service','groceries']],
  ['always-stocked','Siempre Abastecido','Always Stocked',['viilife'],['home-cleaning','cleaning-stock','groceries']],
  ['home-ready','Hogar Listo','Home Ready',['viilife'],['pantry-organisation','home-cleaning','wash-fold']],
  ['seasonal-package','Paquete de Temporada','Seasonal Package',['viilife'],['seasonal-refresh','season-change','closet-organisation']],
  ['always-open','Siempre Abierto','Always Open',['viiconcierge'],['home-alignment','vacant-home-checks','cleaning-stock']],
  ['gift-collection','Colección de Regalos','Gift Collection',['viilife','viiconcierge'],['welcome-gifts']]
].map(([id,es,en,channels,services])=>({id,name:pair(es,en),channels,services,optional:true}));
