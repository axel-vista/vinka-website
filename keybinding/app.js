"use strict";
const $=id=>document.getElementById(id);
const device=Keybridge.device;
let connected=false,busy=false,initialized=false,rowId=0,pairedUrl="";
function updateQr(url){
  if(!url){$("phone-pairing").hidden=true;pairedUrl="";return}
  if(url!==pairedUrl){
    const qr=qrcodegen.QrCode.encodeText(url,qrcodegen.QrCode.Ecc.MEDIUM);
    const canvas=$("phone-qr"),scale=6,border=4;
    canvas.width=canvas.height=(qr.size+border*2)*scale;
    const context=canvas.getContext("2d");
    context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);
    context.fillStyle="#000";
    for(let y=0;y<qr.size;y++)for(let x=0;x<qr.size;x++)if(qr.getModule(x,y))context.fillRect((x+border)*scale,(y+border)*scale,scale,scale);
    $("qr-link").href=url;$("phone-link").href=url;pairedUrl=url;
  }
  $("phone-pairing").hidden=false;
}
function result(text,kind=""){ $("result").textContent=text; $("result").className=`result ${kind}`; }
function controls(){
  $("save").disabled=!connected||busy;
  const rows=$("mapping-rows").children.length;
  $("mapping-count").textContent=`${rows} / 64 mappings`;
  $("add-mapping").disabled=!connected||busy||rows>=64;
  $("mapping-form").querySelectorAll("input,select,.remove-mapping").forEach(input=>input.disabled=!connected||busy);
}
function addRow(from="",to=""){
  const row=document.createElement("div");row.className="mapping-row";
  const id=++rowId;
  for(const [side,value,placeholder] of [["from",from,"x"],["to",to,"y"]]){
    const input=document.createElement("input");
    input.className=side;input.value=value;input.placeholder=placeholder;
    input.setAttribute("aria-label",`${side==="from"?"Source":"Destination"} key ${id}`);
    input.setAttribute("list","special-keys");input.autocomplete="off";
    input.autocapitalize="off";input.spellcheck=false;input.maxLength=10;
    row.append(input);
  }
  const remove=document.createElement("button");remove.type="button";
  remove.className="remove-mapping";remove.textContent="x";
  remove.setAttribute("aria-label",`Remove mapping ${id}`);
  remove.addEventListener("click",()=>{row.remove();controls()});row.append(remove);
  $("mapping-rows").append(row);controls();return row;
}
function readMappings(){
  const mappings=[];
  for(const row of $("mapping-rows").children){
    const from=row.querySelector(".from").value,to=row.querySelector(".to").value;
    if(!from&&!to)continue;
    if(!from||!to)throw Error("Fill in both keys, or remove the incomplete mapping.");
    mappings.push({from,to});
  }
  return mappings;
}

function render(){
  connected=device.connected;
  $("connection").textContent=connected?"USB connected directly":"Connect USB to edit mappings";
  if(connected&&!initialized){
    $("layout").value=device.layout;$("mapping-rows").replaceChildren();
    for(const rule of device.mappings)addRow(rule.from,rule.to);
    initialized=true;
  }
  if(!connected)initialized=false;
  controls();updateQr(device.link);
}
$("add-mapping").addEventListener("click",()=>{const row=addRow();row.querySelector("input").focus()});
$("mapping-form").addEventListener("submit",async event=>{
  event.preventDefault();if($("save").disabled)return;
  try{
    const mappings=readMappings();busy=true;controls();result("Saving mappings to the board...");
    const saved=await device.saveMappings(mappings,$("layout").value);
    result(`Saved ${saved.length} mappings. Nothing was typed.`,"success");
  }catch(error){result(error.message,"error")}
  finally{busy=false;controls()}
});
Keybridge.setupUsbUi(render);
