let currentQR = null;
let status = 'starting';

export function setQR(qr) { currentQR = qr; }
export function getQR() { return currentQR; }
export function setStatus(s) { status = s; }
export function getStatus() { return status; }
