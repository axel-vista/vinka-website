'use strict';
(() => {
  const $=id=>document.getElementById(id), pad=$('pad'), status=$('status');
  const preview=new URLSearchParams(location.search).get('preview')==='1';
  const saved='keybridge-token', hash=new URLSearchParams(location.hash.slice(1));
  let token=preview?'':hash.get('key')||hash.get('token')||sessionStorage.getItem(saved)||'';
  if(/^[a-f0-9]{32}$/.test(token)) {
    sessionStorage.setItem(saved,token);
    if(location.hash) history.replaceState(null,'',location.pathname+location.search);
  } else token='';
  let ready=false, running=false, stopping=false, composing=false, suppress=false;
  let commands=[], modifiers=new Set(), active=null;
  const sentinel='\u200b';
  if(preview) {
    document.title='Vinka | Keyboard preview';$('keyboard-label').textContent='PREVIEW';
    $('preview-note').hidden=false;$('preview-output').hidden=false;
    document.body.classList.add('preview-page');
    $('keyboard-mode').hidden=true;$('preview-navigation').hidden=false;
    $('keyboard-description').textContent='Try the controls without a receiver.';
    $('input-hint').textContent='Preview only. Your input is shown below.';
  }
  function resetPad(){pad.value=sentinel;pad.setSelectionRange(1,1);}
  function controls(){
    pad.disabled=!ready||stopping;
    document.querySelectorAll('button').forEach(button=>button.disabled=!ready||stopping);
    $('stop').disabled=!preview&&!token;
    status.classList.toggle('ready',ready);
  }
  function clearMods(){modifiers.clear();document.querySelectorAll('[data-mod]').forEach(b=>b.setAttribute('aria-pressed','false'));}
  async function api(path,data) {
    if(preview) {
      if(path==='command') {
        const symbols={ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Enter:'↵',Backspace:'⌫',Escape:'Esc',' ':'Space'};
        const label=data.type==='text'?[...data.text].slice(0,160).join(''):
          [...(data.modifiers||[]),symbols[data.key]||data.key].join(' + ');
        $('preview-output').textContent='Last input: '+label+(data.type==='text'&&[...data.text].length>160?'…':'');
      } else if(path==='release') $('preview-output').textContent='Stopped.';
      return {ok:true,usb_ready:true};
    }
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),5000);
    try {
      const response=await fetch('/api/'+path,{
        method:data===undefined?'GET':'POST',headers:{'X-Keybridge-Token':token,'Content-Type':'application/json'},
        body:data===undefined?undefined:JSON.stringify(data),signal:controller.signal,cache:'no-store'
      });
      const result=await response.json();
      if(!response.ok||!result.ok)throw Error(result.error||'Command failed.');
      return result;
    } finally{clearTimeout(timeout);}
  }
  function failed(error){
    commands=[];ready=false;status.textContent='Disconnected';controls();
    $('error').textContent=error.message+' Pending keys were discarded.';
  }
  async function pump(){
    if(running||stopping)return;
    running=true;
    try {
      while(commands.length&&!stopping) {
        active=api('command',commands.shift());
        await active;
      }
    } catch(error){failed(error);}
    finally{running=false;active=null;}
  }
  function enqueue(command) {
    if(!ready||stopping)return;
    if(commands.length>=256){failed(Error('Too many queued keys.'));return;}
    commands.push(command);$('error').textContent='';void pump();
  }
  function key(name,physical=[]) {
    const mods=[...new Set([...modifiers,...physical])];
    enqueue({type:'key',key:name,modifiers:mods});clearMods();
  }
  function text(value) {
    if(!value)return;
    const chars=[...value];
    if(chars.length===1&&modifiers.size){key(chars[0]);return;}
    clearMods();
    for(let offset=0;offset<chars.length;offset+=128)
      enqueue({type:'text',text:chars.slice(offset,offset+128).join('')});
  }
  function consume(){
    const value=pad.value.replaceAll(sentinel,'');
    resetPad();text(value);
  }
  pad.addEventListener('compositionstart',()=>{composing=true;});
  pad.addEventListener('compositionend',event=>{
    composing=false;suppress=true;text(event.data||pad.value.replaceAll(sentinel,''));resetPad();
    setTimeout(()=>{suppress=false;},0);
  });
  pad.addEventListener('beforeinput',event=>{
    if(composing||event.isComposing)return;
    if(suppress){event.preventDefault();return;}
    const named={deleteContentBackward:'Backspace',deleteContentForward:'Delete',insertLineBreak:'Enter',insertParagraph:'Enter'};
    if(named[event.inputType]){event.preventDefault();key(named[event.inputType]);resetPad();}
    else if(event.inputType==='deleteWordBackward'){event.preventDefault();key('Backspace',['Ctrl']);resetPad();}
  });
  pad.addEventListener('input',()=>{if(!composing&&!suppress)consume();});
  pad.addEventListener('paste',event=>{
    const value=event.clipboardData?.getData('text/plain');
    if(value!==undefined){event.preventDefault();text(value);resetPad();}
  });
  pad.addEventListener('keydown',event=>{
    if(event.isComposing||composing||['Control','Shift','Alt','Meta','Process','Unidentified'].includes(event.key))return;
    const physical=[];
    if(event.ctrlKey)physical.push('Ctrl');if(event.altKey)physical.push('Alt');
    if(event.shiftKey)physical.push('Shift');if(event.metaKey)physical.push('Meta');
    const named=['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'];
    if(named.includes(event.key)||/^F([1-9]|1[0-2])$/.test(event.key)||event.ctrlKey||event.altKey||event.metaKey){
      event.preventDefault();key(event.key,physical);resetPad();
    }
  });
  document.querySelectorAll('[data-key]').forEach(button=>{
    button.addEventListener('pointerdown',event=>event.preventDefault());
    button.addEventListener('click',()=>key(button.dataset.key));
  });
  document.querySelectorAll('[data-mod]').forEach(button=>{
    button.addEventListener('pointerdown',event=>event.preventDefault());
    button.addEventListener('click',()=>{
      const name=button.dataset.mod;modifiers.has(name)?modifiers.delete(name):modifiers.add(name);
      button.setAttribute('aria-pressed',String(modifiers.has(name)));
    });
  });
  $('stop').addEventListener('click',async()=>{
    if(stopping)return;
    stopping=true;commands=[];clearMods();controls();
    try{if(active)await active.catch(()=>{});await api('release',{});}
    catch(error){failed(error);}
    finally{stopping=false;controls();}
  });
  let refreshing=false;
  async function refresh(){
    if(!preview&&!token){status.textContent='Open the paired link or QR code from USB setup.';controls();return;}
    if(refreshing)return;refreshing=true;
    try{
      const result=await api('status');ready=Boolean(result.usb_ready);
      status.textContent=preview?'Preview ready':ready?'Connected':'Waiting for USB computer';controls();
    }catch(error){failed(error);}
    finally{refreshing=false;}
  }
  resetPad();controls();void refresh();if(!preview)setInterval(()=>void refresh(),2000);
})();