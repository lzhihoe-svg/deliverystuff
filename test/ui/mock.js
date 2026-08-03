// Simulates the Google Apps Script backend (google.script.run) with realistic latency.
(function () {
  var LAT = 150; // ms simulated server latency
  var PIN = '1234';
  var db = { jobs: [] };
  var uid = 0;

  function requireAdmin(pin) {
    if (String(pin) !== PIN) throw new Error('Admin only — wrong PIN');
  }
  function svg(id) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="400" height="300" fill="#64748b"/>' +
      '<text x="200" y="150" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">' + id + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
  }

  var api = {
    checkPin: function (pin) { return String(pin) === PIN; },
    getImagesData: function (ids) {
      var out = {};
      ids.slice(0, 6).forEach(function (id) { out[id] = id.indexOf('missing') >= 0 ? null : svg(id); });
      return out;
    },
    getJobs: function (tab) {
      return db.jobs
        .filter(function (j) { return j.tab === tab && j.status !== 'archived'; })
        .slice().reverse()
        .map(function (j) { return JSON.parse(JSON.stringify(j)); });
    },
    getCounts: function () {
      var c = { want: 0, delivery: 0, postage: 0 };
      db.jobs.forEach(function (j) { if (j.status === 'pending') c[j.tab]++; });
      return c;
    },
    addJob: function (p) {
      if (!p.photos || !p.photos.length) throw new Error('Photo required');
      uid++;
      var job = {
        id: 'j' + uid, tab: p.tab, category: p.category || '', note: p.note || '',
        photoIds: p.photos.map(function (_, i) { return 'ph' + uid + '-' + i; }),
        status: 'pending', createdAt: Date.now(), doneAt: '', proofPhotoId: ''
      };
      db.jobs.push(job);
      return JSON.parse(JSON.stringify(job));
    },
    editJob: function (id, ch, pin) {
      requireAdmin(pin);
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (!ch.photos || !ch.photos.length) throw new Error('Photo required');
      j.note = ch.note || ''; j.category = ch.category || '';
      j.photoIds = ch.photos.map(function (p, i) { return p.b64 ? ('phnew-' + id + '-' + i) : p.id; });
      return JSON.parse(JSON.stringify(j));
    },
    resetAll: function (pin) {
      requireAdmin(pin);
      var n = 0;
      db.jobs.forEach(function (j) { if (j.status !== 'archived') { j.status = 'archived'; n++; } });
      return { ok: true, archived: n };
    },
    deleteJob: function (id, pin) {
      requireAdmin(pin);
      var i = db.jobs.findIndex(function (x) { return x.id === id; });
      if (i < 0) throw new Error('Job not found');
      db.jobs.splice(i, 1);
      return { ok: true, id: id };
    },
    updateStatus: function (id, status, proof, pin) {
      if (status === 'archived') requireAdmin(pin);
      if (status === 'done' && !proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = status;
      if (status !== 'archived') {
        j.doneAt = Date.now();
        if (proof) j.proofPhotoId = 'proof-' + id;
      }
      return { id: id, status: status, doneAt: j.doneAt, proofPhotoId: j.proofPhotoId || '' };
    }
  };

  window.__mockdb = db;
  window.__mockapi = api;
  window.__mockcalls = [];

  function makeRunner() {
    var r = { _s: null, _f: null };
    r.withSuccessHandler = function (fn) { r._s = fn; return r; };
    r.withFailureHandler = function (fn) { r._f = fn; return r; };
    Object.keys(api).forEach(function (name) {
      r[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        window.__mockcalls.push({ name: name, at: Date.now() });
        setTimeout(function () {
          try {
            var res = api[name].apply(null, args);
            if (r._s) r._s(res);
          } catch (e) {
            if (r._f) r._f(e);
          }
        }, LAT);
      };
    });
    return r;
  }

  window.google = { script: {} };
  Object.defineProperty(window.google.script, 'run', { get: makeRunner });
})();
