// Quick worker routing test - run in browser console
var w = new Worker("/VE2/vlcjs/VLCWorker.js");
var log = [];
w.addEventListener("message", function(e) {
  var d = e.data;
  if (d && d.type && d.type !== "debug_echo") {
    log.push(d.type + ":" + (d.error || d.mediaId || d.frameMs || ""));
    console.log("[WORKER-TEST]", d.type, d.error || d.mediaId || "");
  }
});
w.onerror = function(e) { console.log("[WORKER-TEST] ERROR:", e.message); };
w.postMessage({ type: "init" });
setTimeout(function() {
  console.log("[WORKER-TEST] Sending load_file with null file...");
  w.postMessage({ type: "load_file", file: null, mediaId: "test-null" });
  setTimeout(function() {
    console.log("[WORKER-TEST] Results:", log.join(" | "));
  }, 5000);
}, 6000);
