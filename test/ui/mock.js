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

  window.__imgRequests = [];
  var api = {
    checkPin: function (pin) { return String(pin) === PIN; },
    getImagesData: function (ids) {
      var out = {};
      ids.slice(0, 6).forEach(function (id) {
        window.__imgRequests.push(id);
        out[id] = id.indexOf('missing') >= 0 ? null : svg(id);
      });
      return out;
    },
    addPhotoToJob: function (id, index, full, thumb) {
      if (!full) throw new Error('Photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      while (j.photoIds.length <= index) j.photoIds.push('');
      while (j.thumbIds.length <= index) j.thumbIds.push('');
      j.photoIds[index] = 'ph-' + id + '-' + index;
      j.thumbIds[index] = thumb ? ('th-' + id + '-' + index) : '';
      return { id: id, index: index, photoId: j.photoIds[index], thumbId: j.thumbIds[index] };
    },
    getJobs: function (tab) {
      return db.jobs
        .filter(function (j) { return j.tab === tab && j.status !== 'archived'; })
        .slice().reverse()
        .map(function (j) { return JSON.parse(JSON.stringify(j)); });
    },
    getCounts: function () {
      var c = { want: 0, delivery: 0, postage: 0, defect: 0 };
      db.jobs.forEach(function (j) { if (j.status === 'pending') c[j.tab]++; });
      return c;
    },
    addJob: function (p) {
      if (!p.photos || !p.photos.length) throw new Error('Photo required');
      if (p.clientId) {
        var dup = db.jobs.find(function (x) { return x.id === p.clientId; });
        if (dup) return JSON.parse(JSON.stringify(dup)); // idempotent retry
      }
      uid++;
      var job = {
        id: p.clientId || ('j' + uid), tab: p.tab, category: p.category || '', note: p.note || '',
        photoIds: p.photos.map(function (_, i) { return 'ph' + uid + '-' + i; }),
        thumbIds: p.photos.map(function (_, i) { return (p.thumbs && p.thumbs[i]) ? ('th' + uid + '-' + i) : ''; }),
        status: 'pending', createdAt: Date.now(), doneAt: '',
        proofPhotoId: '', proofThumbId: '',
        dueAt: p.dueAt || '', pinnedAt: '', jsCount: p.jsCount || 0,
        customer: (p.customer || '').trim() || 'Unassigned',
        folderId: 'fold-' + (uid),
        nextTab: (p.tab === 'want' && (p.nextTab === 'delivery' || p.nextTab === 'postage')) ? p.nextTab : '',
        nextCategory: p.nextCategory || '', nextDueAt: p.nextDueAt || '', nextJobId: '',
        problem: '', problemAt: '', printedAt: '', printPhotoId: '', printThumbId: ''
      };
      db.jobs.push(job);
      return JSON.parse(JSON.stringify(job));
    },
    getInitData: function (tab) {
      return { jobs: api.getJobs(tab), counts: api.getCounts() };
    },
    getAllData: function () {
      return {
        jobs: { want: api.getJobs('want'), delivery: api.getJobs('delivery'), postage: api.getJobs('postage'), defect: api.getJobs('defect') },
        counts: api.getCounts()
      };
    },
    editJob: function (id, ch, pin) {
      requireAdmin(pin);
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      ch.photos = (ch.photos || []).filter(function (p) { return p && (p.b64 || p.id); });
      if (!ch.photos.length) throw new Error('Photo required');
      j.note = ch.note || ''; j.category = ch.category || '';
      j.dueAt = ch.dueAt || '';
      j.jsCount = ch.jsCount || 0;
      if (ch.customer !== undefined) j.customer = (ch.customer || '').trim() || 'Unassigned';
      j.photoIds = ch.photos.map(function (p, i) { return p.b64 ? ('phnew-' + id + '-' + i) : p.id; });
      j.thumbIds = ch.photos.map(function (p, i) { return p.b64 ? ('thnew-' + id + '-' + i) : (p.thumbId || ''); });
      return JSON.parse(JSON.stringify(j));
    },
    searchHistory: function (q, pin, tab, category) {
      q = String(q || '').toLowerCase().trim();
      var all = db.jobs.slice().reverse().filter(function (j) {
        if (!j.proofPhotoId) return false; // evidence = has a proof photo
        if (tab && j.tab !== tab) return false;
        if (category && j.category !== category) return false;
        if (!q) return true;
        return (j.note + ' ' + (j.customer || '') + ' ' + j.category + ' ' + j.tab).toLowerCase().indexOf(q) >= 0;
      });
      return { results: JSON.parse(JSON.stringify(all.slice(0, 50))), total: all.length, driveFolderId: 'MASTERFOLD' };
    },
    undoSwipe: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.status !== 'got' && j.status !== 'notseen') throw new Error('Nothing to undo');
      j.status = 'pending'; j.doneAt = ''; j.pinnedAt = Date.now();
      var pulledBack = '';
      if (j.nextJobId) {
        var idx = db.jobs.findIndex(function (x) { return x.id === j.nextJobId && x.status === 'pending'; });
        if (idx >= 0) { db.jobs.splice(idx, 1); pulledBack = j.nextJobId; }
        j.nextJobId = '';
      }
      return { id: id, status: 'pending', pinnedAt: j.pinnedAt, pulledBack: pulledBack };
    },
    askAgain: function (id, pin) {
      requireAdmin(pin);
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = 'pending'; j.doneAt = ''; j.pinnedAt = Date.now();
      return { id: id, status: 'pending', pinnedAt: j.pinnedAt };
    },
    resetDone: function (pin) {
      requireAdmin(pin);
      var archived = 0, carried = 0, snap = {};
      db.jobs.forEach(function (j) {
        if (j.status === 'archived') return;
        if (j.status === 'done' || (j.tab === 'want' && j.status === 'got')) {
          snap[j.id] = j.status; j.status = 'archived'; archived++;
        } else carried++;
      });
      if (archived > 0) db.lastReset = snap;
      return { ok: true, archived: archived, carried: carried };
    },
    undoReset: function (pin) {
      requireAdmin(pin);
      if (!db.lastReset) throw new Error('Nothing to undo');
      var restored = 0;
      db.jobs.forEach(function (j) {
        if (db.lastReset[j.id] && j.status === 'archived') { j.status = db.lastReset[j.id]; restored++; }
      });
      db.lastReset = null;
      return { ok: true, restored: restored };
    },
    updateProof: function (id, proof, proofThumb) {
      if (!proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.proofPhotoId = 'reproof-' + id;
      j.proofThumbId = proofThumb ? ('reproofth-' + id) : '';
      return { id: id, proofPhotoId: j.proofPhotoId, proofThumbId: j.proofThumbId };
    },
    deleteProof: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = 'pending'; j.doneAt = ''; j.proofPhotoId = ''; j.proofThumbId = '';
      return { id: id, status: 'pending' };
    },
    resetAll: function (pin) {
      requireAdmin(pin);
      var n = 0, snap = {};
      db.jobs.forEach(function (j) {
        if (j.status !== 'archived') { snap[j.id] = j.status; j.status = 'archived'; n++; }
      });
      if (n > 0) db.lastReset = snap;
      return { ok: true, archived: n };
    },
    deleteJob: function (id, pin) {
      requireAdmin(pin);
      var i = db.jobs.findIndex(function (x) { return x.id === id; });
      if (i < 0) throw new Error('Job not found');
      db.jobs.splice(i, 1);
      return { ok: true, id: id };
    },
    reportProblem: function (id) {
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.tab !== 'delivery' && j.tab !== 'postage') throw new Error('Only Delivery/Postage jobs can be reported');
      if (j.problem === 'reported') return { id: id, problem: 'reported', problemAt: j.problemAt };
      j.problem = 'reported'; j.problemAt = Date.now(); j.printedAt = '';
      return { id: id, problem: 'reported', problemAt: j.problemAt };
    },
    solveProblem: function (id, photo, thumb) {
      if (!photo) throw new Error('Printing photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      var isProblem = j.problem === 'reported' || (j.tab === 'want' && j.status === 'notseen');
      if (!isProblem) throw new Error('This job is not on the Problem page');
      j.problem = 'printed'; j.printedAt = Date.now();
      j.printPhotoId = 'print-' + id;
      j.printThumbId = thumb ? ('printth-' + id) : '';
      return { id: id, problem: 'printed', printedAt: j.printedAt, printPhotoId: j.printPhotoId, printThumbId: j.printThumbId };
    },
    sentBus: function (id, proof, proofThumb) {
      if (!proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      if (j.tab !== 'postage') throw new Error('Only a postage job can be marked Sent bus');
      j.tab = 'delivery'; j.category = 'bus'; j.status = 'done'; j.doneAt = Date.now();
      j.proofPhotoId = 'proof-' + id;
      j.proofThumbId = proofThumb ? ('proofth-' + id) : '';
      return { id: id, tab: 'delivery', category: 'bus', status: 'done', doneAt: j.doneAt,
               proofPhotoId: j.proofPhotoId, proofThumbId: j.proofThumbId };
    },
    updateStatus: function (id, status, proof, proofThumb, pin) {
      if (status === 'archived') requireAdmin(pin);
      if (status === 'done' && !proof) throw new Error('Proof photo required');
      var j = db.jobs.find(function (x) { return x.id === id; });
      if (!j) throw new Error('Job not found');
      j.status = status;
      if (status !== 'archived') {
        j.doneAt = Date.now();
        if (proof) j.proofPhotoId = 'proof-' + id;
        if (proofThumb) j.proofThumbId = 'proofth-' + id;
      }
      var pushed = null;
      if (status === 'got' && j.nextTab && !j.nextJobId) {
        uid++;
        var pj = {
          id: 'j' + uid, tab: j.nextTab, category: j.nextCategory || '', note: j.note,
          photoIds: j.photoIds.slice(), thumbIds: j.thumbIds.slice(),
          status: 'pending', createdAt: Date.now(), doneAt: '', proofPhotoId: '', proofThumbId: '',
          dueAt: j.nextDueAt || '', pinnedAt: '', jsCount: 0,
          customer: j.customer, folderId: j.folderId, fromCheck: true,
          nextTab: '', nextCategory: '', nextDueAt: '', nextJobId: ''
        };
        db.jobs.push(pj);
        j.nextJobId = pj.id;
        pushed = JSON.parse(JSON.stringify(pj));
      }
      return { id: id, status: status, doneAt: j.doneAt, proofPhotoId: j.proofPhotoId || '', proofThumbId: j.proofThumbId || '', pushed: pushed };
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
        var lat = (window.__mocklat && window.__mocklat[name] != null) ? window.__mocklat[name] : LAT;
        // test hook: window.__mockfail = { addJob: 2 } fails the next 2 calls
        if (window.__mockfail && window.__mockfail[name] > 0) {
          window.__mockfail[name]--;
          setTimeout(function () { if (r._f) r._f(new Error('Network glitch')); }, lat);
          return;
        }
        setTimeout(function () {
          try {
            var res = api[name].apply(null, args);
            if (r._s) r._s(res);
          } catch (e) {
            if (r._f) r._f(e);
          }
        }, lat);
      };
    });
    return r;
  }

  window.google = { script: {} };
  Object.defineProperty(window.google.script, 'run', { get: makeRunner });
})();
