"use strict";
(() => {
  const FIRMWARE = "USB_KEYS_WIFI_05";
  const special = Object.freeze({Enter: 0x100, Backspace: 0x101, Tab: 0x102,
    ArrowLeft: 0x103, ArrowRight: 0x104, ArrowUp: 0x105, ArrowDown: 0x106});
  const encoder = new TextEncoder();

  function keyCode(token, layout) {
    if (Object.hasOwn(special, token)) return special[token];
    if (token === "Space") return 32;
    if (typeof token === "string" && Array.from(token).length === 1) {
      const code = token.codePointAt(0);
      if (code >= 32 && code <= 126 || layout !== "us" && "åäöÅÄÖ".includes(token)) return code;
    }
    throw Error("Use one character, Space, Enter, Backspace, Tab or ArrowLeft/Right/Up/Down. Swedish output needs Swedish layout.");
  }

  function keyToken(code) {
    const named = Object.keys(special).find(name => special[name] === code);
    if (named) return named;
    if (code === 32) return "Space";
    const token = String.fromCodePoint(code);
    if (keyCode(token) !== code) throw Error("The board returned an unsupported key.");
    return token;
  }

  function encodeMappings(mappings, layout) {
    if (!["us", "sv"].includes(layout)) throw Error("Choose the receiving PC's keyboard layout.");
    if (!Array.isArray(mappings) || mappings.length > 64) throw Error("Use at most 64 mappings.");
    const seen = new Set();
    return mappings.map(rule => {
      const from = keyCode(rule.from), to = keyCode(rule.to, layout);
      if (seen.has(from)) throw Error("Each source key can have only one mapping.");
      seen.add(from);
      return `${from.toString(16)}=${to.toString(16)}\n`;
    }).join("");
  }

  function hex(text) {
    return Array.from(encoder.encode(text), byte => byte.toString(16).padStart(2, "0")).join("") || "-";
  }

  function validateWifi(ssid, password) {
    if (typeof ssid !== "string" || ssid.includes("\0") || !ssid || encoder.encode(ssid).length > 32)
      throw Error("Enter a Wi-Fi name between 1 and 32 bytes.");
    if (typeof password !== "string" || password.includes("\0")) throw Error("Enter a valid Wi-Fi password.");
    const size = encoder.encode(password).length;
    if (size && !(size >= 8 && size <= 63 || size === 64 && /^[a-f0-9]+$/i.test(password)))
      throw Error("Use an 8-63 byte Wi-Fi password, or leave it empty for an open network.");
  }

  function pairingLink(status) {
    if (!status.wifi || !/^[a-f0-9]{32}$/.test(status.wifi_key || "")) return "";
    const parts = String(status.ip).split(".");
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return "";
    const [a, b] = parts.map(Number);
    if (!(a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31)) return "";
    return `http://${parts.map(Number).join(".")}/#key=${status.wifi_key}`;
  }

  class UsbDevice extends EventTarget {
    constructor() {
      super();
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.readTask = null;
      this.closing = null;
      this.connecting = false;
      this.connected = false;
      this.status = null;
      this.link = "";
      this.error = "";
      this.lastSeen = 0;
      this.pending = new Map();
      this.waiters = new Set();
      this.nextId = 1;
      this.commandQueue = Promise.resolve();
      navigator.serial?.addEventListener("disconnect", event => {
        if (this.port && (event.target === this.port || event.port === this.port)) void this.disconnect("USB disconnected.");
      });
      this.watchdog = setInterval(() => {
        if (this.connected && Date.now() - this.lastSeen > 8000) void this.disconnect("The board stopped responding. Reconnect USB.");
      }, 1000);
    }

    get supported() { return window.isSecureContext && "serial" in navigator; }
    get mappings() {
      return (this.status?.mappings || []).map(rule => ({from: keyToken(rule.from), to: keyToken(rule.to)}));
    }
    get layout() { return this.status?.layout || "us"; }
    changed() { this.dispatchEvent(new Event("change")); }

    async connect() {
      if (this.connected || this.connecting) return;
      if (!this.supported) throw Error("Open this page in desktop Chrome or Edge over HTTPS, or open the downloaded index.html directly.");
      if (this.closing) await this.closing;
      this.connecting = true;
      this.error = "";
      this.status = null;
      this.link = "";
      this.changed();
      try {
        const port = await navigator.serial.requestPort({filters: [{usbVendorId: 0x303A}]});
        this.port = port;
        await port.open({baudRate: 115200, bufferSize: 8192});
        await port.setSignals({dataTerminalReady: true, requestToSend: false});
        this.reader = port.readable.getReader();
        this.writer = port.writable.getWriter();
        this.readTask = this.readLoop(port, this.reader);
        const ready = this.waitForStatus(() => true, 7000);
        await Promise.all([ready, this.writer.write(encoder.encode("\nPING\n"))]);
        this.connected = true;
      } catch (error) {
        const text = error.name === "NotFoundError" ? "No USB device selected." :
          error.name === "NetworkError" ? "Could not open USB. Close the old local controller, other Keybridge tabs and serial monitors, then try again." : error.message;
        await this.disconnect(text);
        throw Error(text);
      } finally {
        this.connecting = false;
        this.changed();
      }
    }

    async readLoop(port, reader) {
      const decoder = new TextDecoder();
      let buffer = "", failure = "USB disconnected.";
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream: true});
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            this.receive(message);
          }
          if (buffer.length > 16384) throw Error("The USB device sent an invalid response.");
        }
      } catch (error) { failure = error.message || failure; }
      finally {
        reader.releaseLock();
        if (this.port === port && !this.closing) {
          queueMicrotask(() => { if (this.port === port) void this.disconnect(failure); });
        }
      }
    }

    receive(message) {
      if (message?.event === "status") {
        if (message.firmware !== FIRMWARE) throw Error("This device needs the Keybridge live-keyboard firmware.");
        if (!Array.isArray(message.mappings) || !["us", "sv"].includes(message.layout)) throw Error("The board returned invalid settings.");
        const mappings = message.mappings.map(rule => ({from: keyToken(rule.from), to: keyToken(rule.to)}));
        encodeMappings(mappings, message.layout);
        this.status = message;
        this.lastSeen = Date.now();
        this.link = pairingLink(message) || this.link;
        for (const waiter of [...this.waiters]) if (waiter.predicate(message)) waiter.resolve(message);
        this.changed();
      } else if (message?.event === "reply") {
        const pending = this.pending.get(message.id);
        if (pending) message.ok ? pending.resolve(message) : pending.reject(Error(message.error || "The board rejected the request."));
      }
    }

    waitForStatus(predicate, timeout = 3000) {
      if (this.status && predicate(this.status)) return Promise.resolve(this.status);
      return new Promise((resolve, reject) => {
        const finish = callback => value => { clearTimeout(timer); this.waiters.delete(waiter); callback(value); };
        const waiter = {predicate, resolve: finish(resolve), reject: finish(reject)};
        const timer = setTimeout(() => waiter.reject(Error("The board did not respond. Check its firmware and reconnect USB.")), timeout);
        this.waiters.add(waiter);
      });
    }

    command(action, argumentsText) {
      const run = async () => {
        if (!this.connected || !this.writer) throw Error("Connect USB first.");
        if (!["MAPS", "WIFI"].includes(action)) throw Error("Unsupported USB action.");
        const id = this.nextId++;
        const frame = `${action} ${id} ${argumentsText}\n`;
        if (frame.length > 2100) throw Error("The settings are too large.");
        return new Promise((resolve, reject) => {
          const finish = callback => value => { clearTimeout(timer); this.pending.delete(id); callback(value); };
          const pending = {resolve: finish(resolve), reject: finish(reject)};
          const timer = setTimeout(() => pending.reject(Error("The board did not confirm the save. Reconnect and read its settings before retrying.")), 5000);
          this.pending.set(id, pending);
          this.writer.write(encoder.encode(frame)).catch(error => pending.reject(error));
        });
      };
      const task = this.commandQueue.then(run);
      this.commandQueue = task.catch(() => {});
      return task;
    }

    async saveMappings(mappings, layout) {
      const wire = encodeMappings(mappings, layout);
      await this.command("MAPS", `${layout} ${hex(wire)}`);
      await this.waitForStatus(status => status.layout === layout &&
        encodeMappings(status.mappings.map(rule => ({from: keyToken(rule.from), to: keyToken(rule.to)})), layout) === wire);
      return this.mappings;
    }

    async configureWifi(ssid, password, layout = this.layout) {
      validateWifi(ssid, password);
      const mappings = this.mappings;
      encodeMappings(mappings, layout);
      if (layout !== this.layout) await this.saveMappings(mappings, layout);
      await this.command("WIFI", `${hex(ssid)} ${hex(password)}`);
      this.link = pairingLink(this.status) || "";
      this.changed();
    }

    async disconnect(reason = "") {
      if (this.closing) return this.closing;
      this.connected = false;
      this.error = reason;
      const task = async () => {
        for (const pending of [...this.pending.values()]) pending.reject(Error(reason || "USB disconnected."));
        for (const waiter of [...this.waiters]) waiter.reject(Error(reason || "USB disconnected."));
        const port = this.port, reader = this.reader, writer = this.writer, readTask = this.readTask;
        this.port = this.reader = this.writer = this.readTask = null;
        if (reader) { try { await reader.cancel(); } catch {} }
        if (readTask) { try { await readTask; } catch {} }
        if (writer) {
          try { await writer.abort(); } catch {}
          try { writer.releaseLock(); } catch {}
        }
        if (port) { try { await port.close(); } catch {} }
      };
      this.closing = task();
      this.changed();
      try { await this.closing; } finally { this.closing = null; this.changed(); }
    }
  }

  const device = new UsbDevice();
  function setupUsbUi(render) {
    const connect = document.getElementById("usb-connect"), disconnect = document.getElementById("usb-disconnect"), status = document.getElementById("usb-status");
    function update() {
      connect.disabled = !device.supported || device.connecting || device.connected;
      connect.textContent = device.connecting ? "Connecting..." : device.connected ? "USB connected" : "Connect USB";
      disconnect.hidden = !device.connected;
      status.hidden = !device.supported;
      status.textContent = !device.supported ? "" :
        device.error || (device.connected ? "Connected directly to your board." : device.connecting ? "Select your Keybridge USB device." : "Plug in your board, then click Connect USB.");
      status.classList.toggle("error", !!device.error);
      render(device);
    }
    connect.addEventListener("click", async () => { try { await device.connect(); } catch {} update(); });
    disconnect.addEventListener("click", () => { void device.disconnect(); });
    device.addEventListener("change", update);
    document.querySelectorAll("a[data-usb-navigation]").forEach(link => link.addEventListener("click", async event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      await device.disconnect();
      location.href = link.href;
    }));
    window.addEventListener("pagehide", () => { void device.disconnect(); });
    update();
  }
  window.Keybridge = Object.freeze({device, setupUsbUi, keyCode, keyToken, encodeMappings, validateWifi});
})();
