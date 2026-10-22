let containerLoaded=false;
export async function loadApprovedTags(){
  if(/^\/(admin|vendedor|equipo|cliente|cuenta)(\/|$)/.test(location.pathname))return;
  const r=await fetch('/api/analytics/bootstrap',{credentials:'same-origin'});if(!r.ok)return;const data=await r.json();if(!data.gtm||!/^GTM-[A-Z0-9]+$/.test(data.gtm))return;
  if(containerLoaded)return;containerLoaded=true;window.dataLayer=window.dataLayer||[];window.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js'});
  const script=document.createElement('script');script.src='https://www.googletagmanager.com/gtm.js?id='+encodeURIComponent(data.gtm);script.async=true;document.head.append(script);
}
export function resetApprovedTags(){if(containerLoaded)location.reload();}
