/* WATCHDOG service worker — alleen voor meldingen (geen caching, geen achtergrondcontrole). */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
/* tik op een melding: open WATCHDOG precies bij de context van die melding */
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil((async()=>{
    const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of all){if(c.url.split('#')[0]===url.split('#')[0]){await c.focus();c.postMessage({type:'wd-open',url:url});return}}
    if(self.clients.openWindow)await self.clients.openWindow(url);
  })());
});
/* voorbereid op echte server-push (volgende fase): toon de melding die de server stuurt */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(x){}
  if(!d.title)return;
  e.waitUntil(self.registration.showNotification('🐶 WATCHDOG',{body:d.title+(d.message?'\n'+d.message:''),icon:d.icon,tag:d.tag,data:{url:d.url||'./'}}));
});
