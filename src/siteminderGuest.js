// Reveal a reservation's real guest email from SiteMinder.
//
// getCmReservationDetail returns emails masked ("d****@*****.*******.***") unless the session
// first proves it runs on a TRUSTED DEVICE — the same check the app does when you click
// "Reveal":
//   generateTrustedDeviceChallenge(deviceId) → sign the nonce with the device's private key →
//   verifyTrustedDeviceChallenge(...) → the NEXT getCmReservationDetail returns real emails.
// One verify unlocks one detail call, so this runs once per reservation.
//
// The private key is a non-extractable ECDSA P-256 CryptoKey that the app stored in the
// browser's IndexedDB when the device was trusted. So this only works inside the persistent
// browser profile (SM_PROFILE_DIR) that was trusted once with SM_DEVICE_TRUST=manual.
const PROPERTY_URL = "https://platform.siteminder.com/api/property-beef/graphql";
const RES_URL = "https://platform.siteminder.com/api/reservations-beef/graphql";

const GENERATE = `mutation generateTrustedDeviceChallenge($deviceId: ID!) {
  generateTrustedDeviceChallenge(deviceId: $deviceId) { challengeId nonce expiresAt deviceId }
}`;
const VERIFY = `mutation verifyTrustedDeviceChallenge($deviceId: ID!, $challengeId: ID!, $signedChallenge: String!) {
  verifyTrustedDeviceChallenge(deviceId: $deviceId, challengeId: $challengeId, signedChallenge: $signedChallenge)
}`;
// Subset of the app's getCmReservationDetail: names + emails only (no payment card).
const DETAIL = `query getCmReservationDetail($spid: ID!, $smPlatformReservationId: String!) {
  hotel(spid: $spid) {
    reservation(platformReservationId: $smPlatformReservationId) {
      detail {
        mainGuest { firstName lastName email }
        booker { firstName lastName email }
      }
    }
  }
}`;

// In the page: the trusted device's id (the key itself never leaves the browser).
const readDeviceId = () => new Promise((resolve, reject) => {
  const open = indexedDB.open("platform-property-trusted-devices");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains("device-keys")) return resolve(null);
    const req = db.transaction("device-keys").objectStore("device-keys").getAll();
    req.onsuccess = () => resolve(req.result[0] ? req.result[0].deviceId : null);
    req.onerror = () => reject(req.error);
  };
});

// In the page, mirroring the app's signChallenge(): ECDSA P-256/SHA-256 over the
// base64url-decoded nonce, result base64url.
const signInPage = (nonce) => new Promise((resolve, reject) => {
  const open = indexedDB.open("platform-property-trusted-devices");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const req = open.result.transaction("device-keys").objectStore("device-keys").getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = async () => {
      try {
        const b = nonce.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
        const data = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, req.result[0].privateKey, data);
        resolve(btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
      } catch (e) { reject(e); }
    };
  };
});

// `run`/`page` come from withGraphqlAuth. Returns { email, firstName, lastName }; throws if the
// device isn't trusted, the check fails, or the email is still masked.
async function revealGuestEmail(run, page, spid, smPlatformReservationId) {
  const deviceId = await page.evaluate(readDeviceId);
  if (!deviceId) throw new Error("this browser profile isn't a trusted device (run auth.js with SM_DEVICE_TRUST=manual)");

  const gen = await run("generateTrustedDeviceChallenge", GENERATE, { deviceId }, PROPERTY_URL);
  const ch = gen.generateTrustedDeviceChallenge;
  const signedChallenge = await page.evaluate(signInPage, ch.nonce);
  const ok = await run("verifyTrustedDeviceChallenge", VERIFY, { deviceId, challengeId: ch.challengeId, signedChallenge }, PROPERTY_URL);
  if (ok.verifyTrustedDeviceChallenge !== true) throw new Error("trusted-device check was rejected");

  const data = await run("getCmReservationDetail", DETAIL, { spid, smPlatformReservationId }, RES_URL);
  const d = data.hotel.reservation && data.hotel.reservation.detail;
  const who = d && ((d.mainGuest && d.mainGuest.email) ? d.mainGuest : d.booker);
  if (!who || !who.email) throw new Error("reservation has no guest email");
  if (who.email.includes("*")) throw new Error("email still masked");
  return { email: who.email, firstName: who.firstName || "", lastName: who.lastName || "" };
}

module.exports = { revealGuestEmail };
