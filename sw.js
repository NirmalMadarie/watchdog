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
/* server-push (RC11): de server stuurt een versleutelde melding; tik = de exacte Watch-context */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(x){}
  if(!d.title)return;
  const body=d.title+((d.body||d.message)?'\n'+(d.body||d.message):'');
  e.waitUntil(self.registration.showNotification('🐶 WATCHDOG',{body:body,icon:d.icon,badge:d.icon,tag:d.tag,renotify:true,data:{url:d.url||'./'},actions:[{action:'open',title:'Bekijk'}]}));
});
