"use strict";
const $=id=>document.getElementById(id),device=Keybridge.device;
let busy=false,initialized=false,lastError="";
function status(message,kind=""){$("status").textContent=message;$("status").className=`result ${kind}`}
function connectionMessage(board){
  if([201,212].includes(board.wifi_reason))return "The network was not found. Check its exact name and that 2.4 GHz Wi-Fi is enabled.";
  if([15,202,204].includes(board.wifi_reason))return "Wi-Fi authentication did not complete. Check the password and router security settings.";
  if([210,211].includes(board.wifi_reason))return "The board could not find this network with compatible security settings.";
  return "Joining Wi-Fi...";
}
function render(){
  if(device.connected&&!initialized){$("layout").value=device.layout;initialized=true}
  if(!device.connected)initialized=false;
  $("connect").disabled=busy||!device.connected;
  $("trigger-link").hidden=!device.link;
  if(device.link)$("trigger-link").href=device.link;
  $("connect").firstChild.textContent=device.status?.wifi?"Update Wi-Fi settings ":"Connect to Wi-Fi ";
  if(busy)return;
  if(lastError)status(lastError,"error");
  else if(device.connected&&device.status.wifi)status(`Connected over Wi-Fi / ${device.status.ip}`,"success");
  else if(device.connected)status(device.status.wifi_configured?connectionMessage(device.status):"USB connected. Enter your Wi-Fi details.");
  else status("Connect USB to configure Wi-Fi.");
}
$("setup-form").addEventListener("submit",async event=>{
  event.preventDefault();if($("connect").disabled)return;
  busy=true;lastError="";render();status("Saving Wi-Fi settings directly over USB...");
  try{
    await device.configureWifi($("ssid").value,$("password").value,$("layout").value);
    $("password").value="";
  }catch(error){lastError=error.message}
  finally{busy=false;render()}
});
Keybridge.setupUsbUi(render);
