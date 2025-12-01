// worker.js
// A simple heartbeat worker to bypass Chrome's background throttling
let intervalId = null;
const INTERVAL_MS = 500;

self.onmessage = function (e) {
    if (e.data === 'START') {
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(() => {
            self.postMessage('TICK');
        }, INTERVAL_MS);
    } else if (e.data === 'STOP') {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
    }
};
