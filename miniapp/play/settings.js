'use strict';
const SettingsUI=(()=>{
 const screens=['settings','settings-motion','settings-invite','settings-history','settings-language','settings-guide'];
 const text=(ru,en)=>I18n.text(ru,en);
 const locale=()=>I18n.lang==='en'?'en-GB':'ru-RU';
 const format=n=>new Intl.NumberFormat(locale()).format(n);
 const noMotion=()=>document.documentElement.dataset.motion==='off';
 let active, controller, next, loading, openings;
 const panelStatus=(id,value)=>{$(id).textContent=value;};
 function preferenceButtons(){
  for(const b of document.querySelectorAll('[data-motion-choice]'))b.setAttribute('aria-pressed',String(b.dataset.motionChoice===(noMotion()?'off':'on')));
  for(const b of document.querySelectorAll('[data-language]'))b.setAttribute('aria-pressed',String(b.dataset.language===I18n.lang));
 }
 function failure(id,error,retry){
  const b=node('button',text('Повторить','Retry'));b.type='button';b.onclick=retry;
  $(id).replaceChildren(node('span',error.message),b);
 }
 function inviteLink(raw){
  try{
   const url=new URL(raw);
   return url.origin==='https://t.me'&&/^\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)?\/?$/.test(url.pathname)&&url.searchParams.has('startapp')&&!url.username&&!url.password&&!url.hash?url.href:'';
  }catch{return '';}
 }
 async function referral(signal){
  const actions=$('referralActions');actions.hidden=true;$('referralURL').value='';$('referralCount').textContent='—';
  panelStatus('referralStatus',text('Загрузка…','Loading…'));
  try{
   const out=await api('referral',undefined,signal);
   if(signal.aborted||targetPane()!=='settings-invite')return;
   $('referralCount').textContent=format(out.count);
   const link=inviteLink(out.url);
   $('referralURL').value=link;actions.hidden=!link;
   panelStatus('referralStatus',link?'':text('Ссылка пока недоступна. Приглашения работают через Telegram после настройки ссылки на игру.','Invites are not available here yet. They require a configured Telegram Mini App link.'));
  }catch(e){if(!signal.aborted&&targetPane()==='settings-invite')failure('referralStatus',e,()=>referral(signal));}
 }
 function entry(op){
  const item=node('details',undefined,'history-entry'),summary=node('summary');
  summary.append(node('strong',`×${op.size}`));
  const label=op.at==null?node('span',text('Дата не записана','Date not recorded')):node('time',new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short'}).format(op.at*1000));
  if(op.at!=null)label.dateTime=new Date(op.at*1000).toISOString();
  summary.append(label);item.append(summary);
  const outcomes=node('ol',undefined,'history-cards');
  for(const result of op.cards){
   const id=result.id,rarity=rarities[id?.[4]],line=node('li');
   line.dataset.r=id?.[4]||'';
   line.append(node('span',rarity?.[1]||'◇','history-rarity'),node('span',cards.get(id)?.[1]||id||text('Карта неизвестна','Unknown card')));
   if(rarity)line.append(node('small',rarity[0],'history-rarity'));
   if(result.new)line.append(node('small',text('Новая','New'),'history-new'));
   outcomes.append(line);
  }
  if(outcomes.childElementCount)item.append(outcomes);
  else item.append(node('p',text('Результат не сохранился.','The result was not recorded.')));
  return item;
 }
 async function historyPage(signal){
  if(loading||next==null)return;
  loading=true;
  const more=$('historyMore'),cursor=next;
  more.disabled=true;
  panelStatus('historyStatus',text('Загрузка…','Loading…'));
  try{
   const out=await api(`spin-history?offset=${cursor}`,undefined,signal);
   if(signal.aborted||targetPane()!=='settings-history')return;
   // A draw on another device can shift every offset. Restart rather than duplicate rows.
   if(cursor&&out.openings!==openings){resetHistory();return;}
   openings=out.openings;
   $('historyTotal').textContent=format(out.total);
   $('spinHistory').append(...out.entries.map(entry));
   next=out.next;
   more.hidden=next==null;
   if(more.hidden&&document.activeElement===more)$('settings-history-title').focus({preventScroll:true});
   panelStatus('historyStatus',out.entries.length||cursor?'':text('Пока нет сохранённых круток.','No spins have been recorded yet.'));
  }catch(e){if(!signal.aborted&&targetPane()==='settings-history')failure('historyStatus',e,()=>historyPage(signal));}
  finally{if(!signal.aborted){loading=false;more.disabled=false;}}
 }
 function open(pane){
  if(active===pane)return;
  active=pane;controller?.abort();
  if(!screens.includes(pane))return;
  preferenceButtons();
  if(pane==='settings-invite'){
   controller=new AbortController();void referral(controller.signal);
  }else if(pane==='settings-history')resetHistory();
 }
 function resetHistory(){
  controller?.abort();controller=new AbortController();
  next=0;loading=false;$('spinHistory').replaceChildren();$('historyTotal').textContent='—';$('historyMore').hidden=true;
  void historyPage(controller.signal);
 }
 function drawRecorded(){
  if(active==='settings-history'&&targetPane()===active)resetHistory();
 }
 function bind(){
  $('openSettings').onclick=()=>go('settings');
  for(const b of document.querySelectorAll('[data-motion-choice]'))b.onclick=()=>{
   const v=b.dataset.motionChoice;
   document.documentElement.dataset.motion=v;
   try{localStorage.setItem('grimdeck.motion',v);}catch{}
   preferenceButtons();
  };
  for(const b of document.querySelectorAll('[data-language]'))b.onclick=()=>I18n.set(b.dataset.language);
  $('historyMore').onclick=()=>historyPage(controller.signal);
  $('copyReferral').onclick=async()=>{
   const input=$('referralURL'),value=input.value;
   if(!value)return;
   try{
    await navigator.clipboard.writeText(value);
    if(targetPane()==='settings-invite')panelStatus('referralStatus',text('Ссылка скопирована.','Link copied.'));
   }catch{
    if(targetPane()!=='settings-invite')return;
    input.focus();input.select();
    panelStatus('referralStatus',text('Ссылка выделена. Скопируй её вручную.','The link is selected. Copy it manually.'));
   }
  };
  $('shareReferral').onclick=()=>{
   const value=$('referralURL').value;
   if(!value)return;
   const share=new URL('https://t.me/share/url');share.searchParams.set('url',value);
   if(tg?.openTelegramLink)tg.openTelegramLink(share.href);
   else window.open(share.href,'_blank','noopener,noreferrer');
  };
 }
 return {screens,open,bind,noMotion,drawRecorded};
})();
