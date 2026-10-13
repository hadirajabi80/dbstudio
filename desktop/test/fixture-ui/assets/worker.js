// Module worker served from dbstudio://app (Monaco's editor worker is loaded the same way).
self.onmessage = (e) => self.postMessage(e.data * 2);
