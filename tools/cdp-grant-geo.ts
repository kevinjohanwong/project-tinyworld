// One-shot: grant geolocation permission to the staging origin via CDP,
// then push a geolocation override onto the open page target.
const BROWSER_WS = process.argv[2];
const PAGE_WS = process.argv[3];
const ORIGIN = "http://127.0.0.1:3099";

function rpc(url: string, method: string, params: any) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = 1;
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id === id) {
        ws.close();
        resolve(msg);
      }
    };
    ws.onerror = (e) => reject(e);
    setTimeout(() => { try { ws.close(); } catch {} reject(new Error("timeout")); }, 5000);
  });
}

const grant = await rpc(BROWSER_WS, "Browser.grantPermissions", {
  origin: ORIGIN,
  permissions: ["geolocation"],
});
console.log("grant:", JSON.stringify(grant));

const geo = await rpc(PAGE_WS, "Emulation.setGeolocationOverride", {
  latitude: 40.7128,
  longitude: -74.006,
  accuracy: 5,
});
console.log("geoOverride:", JSON.stringify(geo));
